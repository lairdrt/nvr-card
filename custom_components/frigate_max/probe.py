"""Pure validation and timing calculations for FrigateMax."""

from __future__ import annotations

import math
import re
import time
from collections.abc import Iterator, Mapping, Sequence
from datetime import datetime, timezone
from typing import Any

ALLOWED_CAMERAS = frozenset({"drive_up", "drive_down"})
MAX_RANGE_SECONDS = 300.0
MAX_REVIEW_RANGE_SECONDS = 7 * 24 * 60 * 60.0
MAX_AVAILABILITY_RANGE_SECONDS = 2 * 60 * 60.0
MAX_PRESENTATION_BOUNDS_SECONDS = MAX_REVIEW_RANGE_SECONDS
RECORDING_MERGE_TOLERANCE_SECONDS = 1.5
PRESENTATION_MAX_SECONDS = 2 * 60 * 60.0
MAX_PRESENTATION_QUERY_SECONDS = 2 * PRESENTATION_MAX_SECONDS + 60.0
PRESENTATION_PREROLL_SECONDS = 15.0
MAPPING_LOOKAROUND_SECONDS = 30.0
LAB_MAX_PROBE_SECONDS = 5 * 60 * 60.0  # Temporary provider-limit experiment only.
LAB_FINALIZATION_MARGIN_SECONDS = 60 * 60.0
ISOLATION_EPSILON_SECONDS = 0.001
PREPARED_TIMING_FIELDS = (
    "camera",
    "requested_start",
    "requested_end",
    "recording_start",
    "requested_clip_from_ms",
    "adjusted_clip_from_ms",
    "effective_absolute_origin",
    "calculated_target_seek",
)
MIN_CLIP_SECONDS = 0.101
FRIGATE_CAMERA_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
FRIGATE_RECORDING_PATH = re.compile(
    r"/(\d{4}-\d{2}-\d{2})/(\d{2})/[^/]+/(\d{2})\.(\d{2})\.mp4$"
)
REVIEW_EVENT_FIELDS = ("camera_id", "start_time", "end_time", "type", "labels")
PRESENTATION_FIELDS = (
    "schema",
    "camera",
    "selected_epoch",
    "resolved_selected_epoch",
    "requested_wall_start",
    "requested_wall_end",
    "effective_wall_start",
    "logical_wall_start",
    "logical_wall_end",
    "effective_absolute_origin",
    "media_start_position",
    "selected_media_position",
    "logical_media_end_position",
    "coverage_run",
    "time_map",
)


class ProbeDataError(ValueError):
    """Raised when probe input or Frigate data cannot be associated safely."""


def validate_review_request(cameras: Any, from_epoch: Any, to_epoch: Any) -> tuple[list[str], float, float]:
    """Validate a bounded, safe multi-camera Review metadata request."""
    if not isinstance(cameras, list) or not cameras or len(cameras) > 16:
        raise ProbeDataError("cameras must contain 1 to 16 identifiers.")
    normalized = []
    for camera in cameras:
        if not isinstance(camera, str) or not FRIGATE_CAMERA_ID.fullmatch(camera):
            raise ProbeDataError("cameras must contain safe Frigate identifiers.")
        if camera not in normalized:
            normalized.append(camera)
    start = _finite_number(from_epoch, "from")
    end = _finite_number(to_epoch, "to")
    if end <= start:
        raise ProbeDataError("to must be after from.")
    if end - start > MAX_REVIEW_RANGE_SECONDS:
        raise ProbeDataError("Review range is too large.")
    return normalized, start, end


def normalize_review_event(item: Any, expected_camera: str) -> dict[str, Any]:
    """Allowlist the event fields needed by the Review Timeline."""
    if not isinstance(item, Mapping):
        raise ProbeDataError("Frigate returned a malformed event.")
    camera = item.get("camera", expected_camera)
    if camera != expected_camera:
        raise ProbeDataError("Frigate event camera did not match the request.")
    start = _finite_number(item.get("start_time"), "event start_time")
    raw_end = item.get("end_time")
    end = None if raw_end is None else _finite_number(raw_end, "event end_time")
    if end is not None and end < start:
        raise ProbeDataError("Frigate event end_time preceded start_time.")
    label = item.get("label")
    sub_label = item.get("sub_label")
    labels = [value for value in (label, sub_label) if isinstance(value, str) and value]
    result: dict[str, Any] = {
        "camera_id": expected_camera,
        "start_time": start,
        "type": label if isinstance(label, str) and label else "event",
        "labels": labels,
    }
    if end is not None:
        result["end_time"] = end
    return result


def normalize_review_events(items: Any, expected_camera: str) -> list[dict[str, Any]]:
    """Normalize a Frigate event list without exposing raw payload fields."""
    if not isinstance(items, list):
        raise ProbeDataError("Frigate events response must be a list.")
    return [normalize_review_event(item, expected_camera) for item in items]


def normalize_prepare_result(result: Any, expected_camera: str) -> dict[str, Any]:
    """Return only the safe, versioned VOD preparation response fields."""
    if not isinstance(result, Mapping) or result.get("camera") != expected_camera:
        raise ProbeDataError("Prepared VOD timing did not match the requested camera.")

    normalized: dict[str, Any] = {"camera": expected_camera}
    for field in PREPARED_TIMING_FIELDS[1:]:
        value = result.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ProbeDataError("Prepared VOD timing was incomplete.")
        numeric = float(value)
        if not math.isfinite(numeric):
            raise ProbeDataError("Prepared VOD timing was invalid.")
        normalized[field] = numeric
    return normalized


def _normalized_integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 9_000_000_000_000_000:
        raise ProbeDataError(f"{field} was invalid.")
    return value


def normalize_presentation_result(result: Any, expected_camera: str) -> dict[str, Any]:
    """Strictly allowlist and validate the v2 browser-facing response."""
    if not isinstance(result, Mapping) or result.get("schema") != 2 or result.get("camera") != expected_camera:
        raise ProbeDataError("Prepared presentation response was invalid.")
    numeric_fields = (
        "selected_epoch", "resolved_selected_epoch", "requested_wall_start",
        "requested_wall_end", "effective_wall_start", "logical_wall_start",
        "logical_wall_end", "effective_absolute_origin", "media_start_position",
        "selected_media_position", "logical_media_end_position",
    )
    output: dict[str, Any] = {"schema": 2, "camera": expected_camera}
    for field in numeric_fields:
        value = result.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ProbeDataError(f"Prepared presentation field {field} was invalid.")
        output[field] = float(value)
    coverage = result.get("coverage_run")
    if not isinstance(coverage, Mapping):
        raise ProbeDataError("Prepared presentation coverage was invalid.")
    normalized_coverage = {}
    for field in ("known_start", "known_end"):
        value = coverage.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ProbeDataError("Prepared presentation coverage was invalid.")
        normalized_coverage[field] = float(value)
    for field in ("continues_before", "continues_after"):
        if not isinstance(coverage.get(field), bool):
            raise ProbeDataError("Prepared presentation continuation was invalid.")
        normalized_coverage[field] = coverage[field]
    output["coverage_run"] = normalized_coverage
    time_map = result.get("time_map")
    if not isinstance(time_map, Mapping) or time_map.get("unit") != "microseconds":
        raise ProbeDataError("Prepared presentation time map was invalid.")
    origin = time_map.get("epoch_origin")
    if isinstance(origin, bool) or not isinstance(origin, (int, float)) or not math.isfinite(float(origin)):
        raise ProbeDataError("Prepared presentation time-map origin was invalid.")
    raw_spans = time_map.get("spans")
    if not isinstance(raw_spans, list) or not raw_spans:
        raise ProbeDataError("Prepared presentation time map was empty.")
    spans = []
    previous_media_end = -1
    for raw in raw_spans:
        if not isinstance(raw, list) or len(raw) != 4:
            raise ProbeDataError("Prepared presentation time-map span was invalid.")
        values = [_normalized_integer(value, "time-map span") for value in raw]
        if values[0] >= values[1] or values[2] >= values[3] or values[2] < previous_media_end:
            raise ProbeDataError("Prepared presentation time-map spans were invalid.")
        previous_media_end = values[3]
        spans.append(values)
    output["time_map"] = {"epoch_origin": float(origin), "unit": "microseconds", "spans": spans}
    if output["logical_wall_start"] >= output["logical_wall_end"]:
        raise ProbeDataError("Prepared presentation logical bounds were invalid.")
    if output["resolved_selected_epoch"] < output["logical_wall_start"] or output["resolved_selected_epoch"] >= output["logical_wall_end"]:
        raise ProbeDataError("Prepared presentation selected epoch was invalid.")
    return output


def normalize_lab_presentation_result(result: Any, expected_camera: str) -> dict[str, Any]:
    """Allowlist temporary Lab counts beside the unchanged V2 contract."""
    output = normalize_presentation_result(result, expected_camera)
    output["candidate_recording_row_count"] = _normalized_integer(
        result.get("candidate_recording_row_count"), "candidate recording row count"
    )
    output["mapping_clip_count"] = _normalized_integer(
        result.get("mapping_clip_count"), "mapping clip count"
    )
    latency = result.get("vod_mapping_latency_ms")
    if isinstance(latency, bool) or not isinstance(latency, (int, float)) or not math.isfinite(latency) or latency < 0:
        raise ProbeDataError("Lab VOD mapping latency was invalid.")
    output["vod_mapping_latency_ms"] = float(latency)
    return output


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise ProbeDataError(f"{field} must be a finite number.")
    try:
        number = float(value)
    except (TypeError, ValueError) as err:
        raise ProbeDataError(f"{field} must be a finite number.") from err
    if not math.isfinite(number):
        raise ProbeDataError(f"{field} must be a finite number.")
    return number


def validate_probe_request(
    camera: Any, requested_start: Any, requested_end: Any, target: Any
) -> tuple[str, float, float, float]:
    """Validate and normalize the deliberately bounded probe request."""
    if not isinstance(camera, str) or camera not in ALLOWED_CAMERAS:
        raise ProbeDataError("camera must be drive_up or drive_down.")
    start = _finite_number(requested_start, "requested_start")
    end = _finite_number(requested_end, "requested_end")
    target_epoch = _finite_number(target, "target")
    if end <= start:
        raise ProbeDataError("requested_end must be after requested_start.")
    if end - start > MAX_RANGE_SECONDS:
        raise ProbeDataError("requested range must not exceed 300 seconds.")
    if target_epoch < start or target_epoch > end:
        raise ProbeDataError("target must be inside the requested range.")
    return camera, start, end, target_epoch


def validate_prepare_request(
    camera: Any, requested_start: Any, requested_end: Any, target: Any
) -> tuple[str, float, float, float]:
    """Validate the v1 request without imposing a fixed camera inventory."""
    if not isinstance(camera, str) or not FRIGATE_CAMERA_ID.fullmatch(camera):
        raise ProbeDataError("camera must be a safe Frigate camera identifier.")
    start = _finite_number(requested_start, "requested_start")
    end = _finite_number(requested_end, "requested_end")
    target_epoch = _finite_number(target, "target")
    if end <= start:
        raise ProbeDataError("requested_end must be after requested_start.")
    if end - start > MAX_RANGE_SECONDS:
        raise ProbeDataError("requested range must not exceed 300 seconds.")
    if target_epoch < start or target_epoch > end:
        raise ProbeDataError("target must be inside the requested range.")
    return camera, start, end, target_epoch


def validate_recording_availability_request(
    camera: Any, requested_start: Any, requested_end: Any
) -> tuple[str, float, float]:
    """Validate one safe, bounded recording-availability request."""
    if not isinstance(camera, str) or not FRIGATE_CAMERA_ID.fullmatch(camera):
        raise ProbeDataError("camera must be a safe Frigate camera identifier.")
    start = _finite_number(requested_start, "start")
    end = _finite_number(requested_end, "end")
    if end <= start:
        raise ProbeDataError("end must be after start.")
    if end - start > MAX_AVAILABILITY_RANGE_SECONDS:
        raise ProbeDataError("recording availability range is too large.")
    return camera, start, end


def validate_presentation_request(
    camera: Any, target: Any, bounds_start: Any, bounds_end: Any
) -> tuple[str, float, float, float]:
    """Validate a bounded v2 presentation request using half-open bounds."""
    if not isinstance(camera, str) or not FRIGATE_CAMERA_ID.fullmatch(camera):
        raise ProbeDataError("camera must be a safe Frigate camera identifier.")
    target_epoch = _finite_number(target, "target")
    start = _finite_number(bounds_start, "bounds_start")
    end = _finite_number(bounds_end, "bounds_end")
    if end <= start:
        raise ProbeDataError("bounds_end must be after bounds_start.")
    if end - start > MAX_PRESENTATION_BOUNDS_SECONDS:
        raise ProbeDataError("presentation bounds are too large.")
    if not start <= target_epoch < end:
        raise ProbeDataError("target must be inside the half-open presentation bounds.")
    return camera, target_epoch, start, end


def validate_lab_probe_request(
    camera: Any, start: Any, end: Any, target: Any
) -> tuple[str, float, float, float]:
    """Validate the temporary Lab-only exact VOD range; never used by Review."""
    if not isinstance(camera, str) or not FRIGATE_CAMERA_ID.fullmatch(camera):
        raise ProbeDataError("camera must be a safe Frigate camera identifier.")
    first = _finite_number(start, "start")
    last = _finite_number(end, "end")
    selected = _finite_number(target, "target")
    if first < 0 or not first < selected < last or last - first > LAB_MAX_PROBE_SECONDS:
        raise ProbeDataError("Lab VOD range was invalid or too large.")
    if last > time.time() - LAB_FINALIZATION_MARGIN_SECONDS:
        raise ProbeDataError("Lab VOD range must be finalized historical coverage.")
    return camera, first, last, selected


def lab_recording_preflight(
    recordings: Any, camera: str, start: float, end: float, target: float
) -> dict[str, Any]:
    """Count rows and require one continuous operational run, without returning paths."""
    run = find_coverage_run(recordings, target, start, end)
    if run["known_start"] > start or run["known_end"] < end:
        raise ProbeDataError("Lab VOD interval crosses unavailable recording coverage.")
    intervals = _recording_intervals(recordings, start, end)
    return {
        "camera": camera,
        "requested_start": start,
        "requested_end": end,
        "requested_duration": end - start,
        "candidate_recording_row_count": len(intervals),
        "coverage_run": {
            key: run[key] for key in (
                "known_start", "known_end", "continues_before", "continues_after"
            )
        },
        "continuous_coverage": True,
    }


def _recording_intervals(
    recordings: Any, requested_start: float, requested_end: float
) -> list[tuple[float, float]]:
    if not isinstance(recordings, Sequence) or isinstance(recordings, (str, bytes)):
        raise ProbeDataError("Frigate recordings response must be a list.")
    intervals: list[tuple[float, float]] = []
    for item in recordings:
        if not isinstance(item, Mapping):
            raise ProbeDataError("Frigate returned a malformed recording.")
        start = _finite_number(item.get("start_time"), "recording start_time")
        end = _finite_number(item.get("end_time"), "recording end_time")
        if end <= start:
            raise ProbeDataError("Frigate returned an invalid recording range.")
        if end > requested_start and start < requested_end:
            intervals.append((max(start, requested_start), min(end, requested_end)))
    return sorted((start, end) for start, end in intervals if end > start)


def find_coverage_run(
    recordings: Any, target: float, requested_start: float, requested_end: float
) -> dict[str, Any]:
    """Find the normalized operational run containing target.

    The returned bounds are clipped to the query envelope.  Continuation flags
    conservatively indicate that the run may continue beyond that envelope.
    """
    target_epoch = _finite_number(target, "target")
    start = _finite_number(requested_start, "requested_start")
    end = _finite_number(requested_end, "requested_end")
    if not start < end:
        raise ProbeDataError("coverage query bounds must be ordered.")
    intervals = _recording_intervals(recordings, start, end)
    if not intervals:
        raise ProbeDataError("No recording covers the selected epoch.")

    runs: list[dict[str, Any]] = []
    for interval_start, interval_end in intervals:
        if runs and interval_start <= runs[-1]["known_end"] + RECORDING_MERGE_TOLERANCE_SECONDS:
            runs[-1]["known_end"] = max(runs[-1]["known_end"], interval_end)
        else:
            runs.append({"known_start": interval_start, "known_end": interval_end})

    for index, run in enumerate(runs):
        if run["known_start"] <= target_epoch < run["known_end"]:
            raw = recordings if isinstance(recordings, Sequence) else []
            starts_before = any(
                isinstance(item, Mapping)
                and _finite_number(item.get("start_time"), "recording start_time") <= requested_start
                and _finite_number(item.get("end_time"), "recording end_time") > requested_start
                for item in raw
            )
            ends_after = any(
                isinstance(item, Mapping)
                and _finite_number(item.get("start_time"), "recording start_time") < requested_end
                and _finite_number(item.get("end_time"), "recording end_time") >= requested_end
                for item in raw
            )
            return {
                "known_start": run["known_start"],
                "known_end": run["known_end"],
                "continues_before": bool(starts_before and run["known_start"] <= requested_start),
                "continues_after": bool(ends_after and run["known_end"] >= requested_end),
                "start_reason": "query_boundary" if run["known_start"] <= requested_start else "coverage_boundary",
                "end_reason": "query_boundary" if run["known_end"] >= requested_end else "coverage_boundary",
                "run_index": index,
            }
    raise ProbeDataError("No recording covers the selected epoch.")


def build_presentation_window(
    target: float,
    coverage_run: Mapping[str, Any],
    review_start: float,
    review_end: float,
    confirmed_end: float | None = None,
) -> dict[str, float]:
    """Select a forward-biased, at-most-two-hour logical presentation window."""
    target_epoch = _finite_number(target, "target")
    bounds_start = _finite_number(review_start, "review_start")
    bounds_end = _finite_number(review_end, "review_end")
    run_start = _finite_number(coverage_run.get("known_start"), "coverage known_start")
    run_end = _finite_number(coverage_run.get("known_end"), "coverage known_end")
    if not bounds_start < bounds_end or not run_start < run_end:
        raise ProbeDataError("presentation bounds must be ordered.")
    if not bounds_start <= target_epoch < bounds_end:
        raise ProbeDataError("target is outside Review bounds.")
    lower = max(bounds_start, run_start)
    upper = min(bounds_end, run_end)
    if confirmed_end is not None:
        upper = min(upper, _finite_number(confirmed_end, "confirmed_end"))
    if not lower < upper or not lower <= target_epoch < upper:
        raise ProbeDataError("No recording covers the selected epoch within Review bounds.")

    logical_start = max(lower, target_epoch - PRESENTATION_PREROLL_SECONDS)
    logical_end = min(upper, logical_start + PRESENTATION_MAX_SECONDS)
    if logical_end - logical_start < PRESENTATION_MAX_SECONDS and upper > lower:
        logical_end = upper
        logical_start = max(lower, logical_end - PRESENTATION_MAX_SECONDS)
    if not logical_start < logical_end or not logical_start <= target_epoch < logical_end:
        raise ProbeDataError("Unable to construct a playable presentation window.")
    return {
        "target": target_epoch,
        "logical_start": logical_start,
        "logical_end": logical_end,
        "requested_start": logical_start,
        "requested_end": logical_end,
    }


def normalize_recording_availability(
    recordings: Any,
    camera: str,
    requested_start: float,
    requested_end: float,
) -> dict[str, Any]:
    """Return clipped, coalesced recording coverage without raw Frigate fields.

    Frigate's approximately ten-second recording segments can leave harmless
    boundary discontinuities of about one second.  A 1.5-second tolerance
    coalesces those observed boundaries while preserving larger gaps as
    separate coverage intervals.
    """
    if not isinstance(recordings, Sequence) or isinstance(recordings, (str, bytes)):
        raise ProbeDataError("Frigate recordings response must be a list.")

    intervals: list[tuple[float, float]] = []
    for item in recordings:
        if not isinstance(item, Mapping):
            raise ProbeDataError("Frigate returned a malformed recording.")
        start = _finite_number(item.get("start_time"), "recording start_time")
        end = _finite_number(item.get("end_time"), "recording end_time")
        if end <= start:
            raise ProbeDataError("Frigate returned an invalid recording range.")
        if end <= requested_start or start >= requested_end:
            continue
        clipped_start = max(start, requested_start)
        clipped_end = min(end, requested_end)
        if clipped_end > clipped_start:
            intervals.append((clipped_start, clipped_end))

    intervals.sort()
    coverage: list[dict[str, float]] = []
    for start, end in intervals:
        if coverage and start <= coverage[-1]["end"] + RECORDING_MERGE_TOLERANCE_SECONDS:
            coverage[-1]["end"] = max(coverage[-1]["end"], end)
        else:
            coverage.append({"start": start, "end": end})

    return {
        "camera": camera,
        "requested_start": requested_start,
        "requested_end": requested_end,
        "coverage": coverage,
    }


def candidate_probe_windows(
    recordings: Any, requested_start: float, requested_end: float
) -> Iterator[dict[str, float]]:
    """Yield time windows that isolate known recording rows without using paths."""
    if not isinstance(recordings, Sequence) or isinstance(recordings, (str, bytes)):
        raise ProbeDataError("Frigate recordings response must be a list.")

    normalized: list[dict[str, float]] = []
    for item in recordings:
        if not isinstance(item, Mapping):
            raise ProbeDataError("Frigate returned a malformed recording.")
        start = _finite_number(item.get("start_time"), "recording start_time")
        end = _finite_number(item.get("end_time"), "recording end_time")
        if end <= start:
            raise ProbeDataError("Frigate returned an invalid recording range.")
        if end > requested_start and start < requested_end:
            normalized.append({"recording_start": start, "recording_end": end})

    normalized.sort(key=lambda item: item["recording_start"])
    yielded = False
    for index, recording in enumerate(normalized):
        probe_start = max(requested_start, recording["recording_start"])
        probe_end = min(requested_end, recording["recording_end"])

        for other_index, other in enumerate(normalized):
            if other_index == index:
                continue
            if other["recording_start"] <= probe_start < other["recording_end"]:
                raise ProbeDataError(
                    "Overlapping recordings prevent path-free timing association."
                )
            if probe_start < other["recording_start"] <= probe_end:
                probe_end = other["recording_start"] - ISOLATION_EPSILON_SECONDS

        if probe_end - probe_start >= MIN_CLIP_SECONDS:
            yielded = True
            yield {
                **recording,
                "probe_start": probe_start,
                "probe_end": probe_end,
            }

    if not yielded:
        raise ProbeDataError("No recording can be isolated for the requested range.")


def mapping_clips(mapping: Any) -> list[Mapping[str, Any]]:
    """Return mapping clips while rejecting malformed Frigate responses."""
    if not isinstance(mapping, Mapping):
        raise ProbeDataError("Frigate returned a malformed VOD mapping.")
    sequences = mapping.get("sequences")
    if not isinstance(sequences, list) or len(sequences) != 1:
        raise ProbeDataError("Frigate VOD mapping has no single sequence.")
    clips = sequences[0].get("clips") if isinstance(sequences[0], Mapping) else None
    if not isinstance(clips, list) or not clips:
        raise ProbeDataError("Frigate VOD mapping contains no clips.")
    if not all(isinstance(clip, Mapping) for clip in clips):
        raise ProbeDataError("Frigate VOD mapping contains a malformed clip.")
    return clips


def adjusted_clip_from_ms(clip: Mapping[str, Any]) -> int:
    """Read Frigate's retained, keyframe-adjusted clipFrom value."""
    value = clip.get("clipFrom", 0)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProbeDataError("Frigate returned an invalid adjusted clipFrom.")
    if not math.isfinite(float(value)) or value < 0 or int(value) != value:
        raise ProbeDataError("Frigate returned an invalid adjusted clipFrom.")
    return int(value)


def _clip_identity(item: Mapping[str, Any]) -> tuple[str, str] | None:
    for field in ("path", "id", "filename", "file"):
        value = item.get(field)
        if isinstance(value, str) and value:
            return field, value
    return None


def _clip_path_epoch(clip: Mapping[str, Any]) -> float:
    identity = _clip_identity(clip)
    if identity is None or identity[0] != "path":
        raise ProbeDataError("Differently identified VOD clips require Frigate recording paths.")
    match = FRIGATE_RECORDING_PATH.search(identity[1])
    if match is None:
        raise ProbeDataError("Frigate VOD clip path has no deterministic recording time.")
    try:
        stamp = datetime.strptime(
            f"{match.group(1)} {match.group(2)}:{match.group(3)}:{match.group(4)}",
            "%Y-%m-%d %H:%M:%S",
        ).replace(tzinfo=timezone.utc)
    except ValueError as err:
        raise ProbeDataError("Frigate VOD clip path has an invalid recording time.") from err
    return stamp.timestamp()


def _clip_duration_seconds(clip: Mapping[str, Any]) -> float:
    keyframe_durations = clip.get("keyFrameDurations")
    if keyframe_durations is not None:
        if not isinstance(keyframe_durations, Sequence) or isinstance(keyframe_durations, (str, bytes)):
            raise ProbeDataError("Frigate returned invalid key-frame durations.")
        values = [_finite_number(value, "key-frame duration") for value in keyframe_durations]
        if not values or any(value <= 0 for value in values):
            raise ProbeDataError("Frigate returned invalid key-frame durations.")
        return sum(values) / 1000.0
    value = clip.get("duration")
    if value is None:
        value = clip.get("clipDuration")
    if value is not None:
        duration = _finite_number(value, "clip duration")
        if duration <= 0:
            raise ProbeDataError("Frigate returned an invalid clip duration.")
        return duration
    clip_from = adjusted_clip_from_ms(clip)
    clip_to = clip.get("clipTo")
    if clip_to is None:
        raise ProbeDataError("Frigate VOD clip has no usable duration.")
    if isinstance(clip_to, bool) or not isinstance(clip_to, (int, float)):
        raise ProbeDataError("Frigate returned an invalid clipTo value.")
    duration_ms = float(clip_to) - clip_from
    if not math.isfinite(duration_ms) or duration_ms <= 0:
        raise ProbeDataError("Frigate returned an invalid clip duration.")
    return duration_ms / 1000.0


def associate_recording_clips(
    recordings: Any, clips: Sequence[Mapping[str, Any]]
) -> list[tuple[Mapping[str, Any], Mapping[str, Any]]]:
    """Associate private Frigate clips with recording rows deterministically."""
    if not isinstance(recordings, Sequence) or isinstance(recordings, (str, bytes)):
        raise ProbeDataError("Frigate recordings response must be a list.")
    if not clips or not all(isinstance(clip, Mapping) for clip in clips):
        raise ProbeDataError("VOD clips cannot be associated with recording rows.")
    rows = [row for row in recordings if isinstance(row, Mapping)]
    if len(rows) != len(recordings):
        raise ProbeDataError("Frigate returned a malformed recording.")
    row_identities = [_clip_identity(row) for row in rows]
    clip_identities = [_clip_identity(clip) for clip in clips]
    if all(identity is not None for identity in clip_identities) and all(
        identity is not None for identity in row_identities
    ):
        row_fields = {identity[0] for identity in row_identities if identity}
        clip_fields = {identity[0] for identity in clip_identities if identity}
        if row_fields != clip_fields:
            if len(row_fields) != 1 or len(clip_fields) != 1 or row_fields & clip_fields:
                raise ProbeDataError("VOD and recording identity namespaces are ambiguous.")
            clip_starts = [_clip_path_epoch(clip) for clip in clips]
            if any(current <= previous for previous, current in zip(clip_starts, clip_starts[1:])):
                raise ProbeDataError("VOD clips are not monotonically ordered.")
            clip_ends = [
                start + adjusted_clip_from_ms(clip) / 1000.0 + _clip_duration_seconds(clip)
                for start, clip in zip(clip_starts, clips)
            ]
            physical_start = clip_starts[0]
            physical_end = clip_ends[-1]
            candidate_rows = []
            for row in rows:
                row_start = _finite_number(row.get("start_time"), "recording start_time")
                row_end = _finite_number(row.get("end_time"), "recording end_time")
                if row_end <= row_start:
                    raise ProbeDataError("Frigate returned an invalid recording range.")
                if row_end > physical_start and row_start < physical_end:
                    candidate_rows.append(row)
            if len(candidate_rows) != len(clips):
                raise ProbeDataError("Differently identified VOD clips have ambiguous recording order.")
            row_starts = [
                _finite_number(row.get("start_time"), "recording start_time")
                for row in candidate_rows
            ]
            if any(current <= previous for previous, current in zip(row_starts, row_starts[1:])):
                raise ProbeDataError("Recording rows are not monotonically ordered.")
            pairs = []
            used_rows: set[int] = set()
            for clip, clip_start in zip(clips, clip_starts):
                matches = [
                    (index, row)
                    for index, (row, row_start) in enumerate(zip(candidate_rows, row_starts))
                    if abs(row_start - clip_start) <= ISOLATION_EPSILON_SECONDS
                ]
                if len(matches) != 1 or matches[0][0] in used_rows:
                    raise ProbeDataError("VOD clip temporal association is ambiguous.")
                index, row = matches[0]
                used_rows.add(index)
                row_end = _finite_number(row.get("end_time"), "recording end_time")
                clip_from = adjusted_clip_from_ms(clip)
                duration = _clip_duration_seconds(clip)
                epoch_start = clip_start + clip_from / 1000.0
                epoch_end = epoch_start + duration
                if epoch_start >= row_end or epoch_end > row_end + RECORDING_MERGE_TOLERANCE_SECONDS:
                    raise ProbeDataError("VOD clip does not fit its recording row.")
                pairs.append((clip, row))
            if len(used_rows) != len(candidate_rows):
                raise ProbeDataError("VOD clip pairing is not one-to-one.")
            return pairs
        by_id: dict[str, Mapping[str, Any]] = {}
        for row, identity in zip(rows, row_identities):
            if identity is None:
                continue
            value = identity[1]
            if value in by_id:
                raise ProbeDataError("Recording identities are ambiguous.")
            by_id[value] = row
        clip_ids = [identity[1] for identity in clip_identities if identity]
        if len(by_id) < len(clips) or any(identity not in by_id for identity in clip_ids):
            raise ProbeDataError("A VOD clip has no matching recording row.")
        return [(clip, by_id[identity]) for clip, identity in zip(clips, clip_ids) if identity]
    raise ProbeDataError("VOD and recording identities are incomplete.")


def _span_interpolation(
    epoch_start: float, epoch_end: float, media_start: float, media_end: float, epoch: float
) -> float:
    if epoch_end <= epoch_start or media_end <= media_start:
        raise ProbeDataError("VOD time map contains an invalid span.")
    return media_start + (epoch - epoch_start) * (media_end - media_start) / (epoch_end - epoch_start)


def _map_epoch_to_media(
    spans: Sequence[Mapping[str, float]], epoch: float, logical_start: float, logical_end: float
) -> tuple[float, float]:
    if not logical_start <= epoch < logical_end:
        raise ProbeDataError("Selected epoch is outside the logical presentation.")
    containing = [span for span in spans if span["epoch_start"] <= epoch < span["epoch_end"]]
    if containing:
        span = containing[-1]
        return _span_interpolation(**span, epoch=epoch), epoch
    following = next((span for span in spans if span["epoch_start"] > epoch), None)
    if following is not None and following["epoch_start"] - epoch <= RECORDING_MERGE_TOLERANCE_SECONDS:
        return following["media_start"], following["epoch_start"]
    raise ProbeDataError("Selected epoch cannot be resolved to VOD media.")


def build_piecewise_time_map(
    recordings: Any,
    clips: Sequence[Mapping[str, Any]],
    logical_start: float,
    logical_end: float,
    selected_epoch: float,
) -> dict[str, Any]:
    """Construct a compact absolute epoch/media map from private VOD data."""
    logical_start = _finite_number(logical_start, "logical_start")
    logical_end = _finite_number(logical_end, "logical_end")
    selected_epoch = _finite_number(selected_epoch, "selected_epoch")
    if not logical_start < logical_end:
        raise ProbeDataError("Logical presentation bounds must be ordered.")
    pairs = associate_recording_clips(recordings, clips)
    raw_spans: list[dict[str, float]] = []
    media_cursor = 0.0
    for clip, row in pairs:
        row_start = _finite_number(row.get("start_time"), "recording start_time")
        row_end = _finite_number(row.get("end_time"), "recording end_time")
        if row_end <= row_start:
            raise ProbeDataError("Frigate returned an invalid recording range.")
        clip_from = adjusted_clip_from_ms(clip)
        duration = _clip_duration_seconds(clip)
        epoch_start = row_start + clip_from / 1000.0
        epoch_end = epoch_start + duration
        if epoch_start < row_start - RECORDING_MERGE_TOLERANCE_SECONDS or epoch_start >= row_end:
            raise ProbeDataError("VOD clip begins before its recording row.")
        if epoch_end > row_end + RECORDING_MERGE_TOLERANCE_SECONDS:
            raise ProbeDataError("VOD clip exceeds its recording row.")
        if raw_spans and epoch_start < raw_spans[-1]["epoch_start"]:
            raise ProbeDataError("VOD clips are not ordered by recording time.")
        raw_spans.append({
            "epoch_start": epoch_start,
            "epoch_end": epoch_end,
            "media_start": media_cursor,
            "media_end": media_cursor + duration,
        })
        media_cursor += duration
    visible = []
    for span in raw_spans:
        start = max(logical_start, span["epoch_start"])
        end = min(logical_end, span["epoch_end"])
        if end <= start:
            continue
        media_start = _span_interpolation(
            span["epoch_start"], span["epoch_end"], span["media_start"], span["media_end"], start
        )
        media_end = _span_interpolation(
            span["epoch_start"], span["epoch_end"], span["media_start"], span["media_end"], end
        )
        visible.append({
            "epoch_start": start,
            "epoch_end": end,
            "media_start": media_start,
            "media_end": media_end,
        })
    if not visible:
        raise ProbeDataError("VOD mapping does not cover the logical presentation.")
    origin = visible[0]["epoch_start"]
    spans = [
        [
            int(round((span["epoch_start"] - origin) * 1_000_000)),
            int(round((span["epoch_end"] - origin) * 1_000_000)),
            int(round(span["media_start"] * 1_000_000)),
            int(round(span["media_end"] * 1_000_000)),
        ]
        for span in visible
    ]
    selected_media, resolved = _map_epoch_to_media(
        visible, selected_epoch, logical_start, logical_end
    )
    # The integer-microsecond time map is the browser-facing mapping authority.
    # Derive its scalar endpoints from those same serialized values so binary
    # float rounding cannot make two fields disagree by a fraction of a microsecond.
    logical_media_start = spans[0][2] / 1_000_000.0
    logical_media_end = spans[-1][3] / 1_000_000.0
    return {
        "effective_wall_start": origin,
        "effective_absolute_origin": origin,
        "media_start_position": logical_media_start,
        "selected_media_position": selected_media,
        "resolved_selected_epoch": resolved,
        "logical_media_end_position": logical_media_end,
        "time_map": {"epoch_origin": origin, "unit": "microseconds", "spans": spans},
    }


def derive_timing_result(
    *,
    camera: str,
    requested_start: float,
    requested_end: float,
    target: float,
    recording_start: float,
    full_mapping: Any,
    isolated_mapping: Any,
) -> dict[str, Any]:
    """Associate the full mapping with a known recording using an isolated mapping."""
    full_clip = mapping_clips(full_mapping)[0]
    isolated_clips = mapping_clips(isolated_mapping)
    if len(isolated_clips) != 1:
        raise ProbeDataError("Isolated VOD mapping did not contain exactly one clip.")

    full_adjusted = adjusted_clip_from_ms(full_clip)
    isolated_adjusted = adjusted_clip_from_ms(isolated_clips[0])
    if full_adjusted != isolated_adjusted:
        raise ProbeDataError(
            "Full and isolated VOD mappings have different adjusted clipFrom values."
        )

    requested_clip_from = max(0, int((requested_start - recording_start) * 1000))
    if full_adjusted > requested_clip_from:
        raise ProbeDataError("Adjusted clipFrom is after the requested clipFrom.")

    effective_origin = recording_start + full_adjusted / 1000
    target_seek = target - effective_origin
    if target_seek < 0:
        raise ProbeDataError("Target precedes the effective VOD origin.")

    # Deliberately omit source paths and all raw mapping content.
    return {
        "camera": camera,
        "requested_start": requested_start,
        "requested_end": requested_end,
        "recording_start": recording_start,
        "requested_clip_from_ms": requested_clip_from,
        "adjusted_clip_from_ms": full_adjusted,
        "effective_absolute_origin": effective_origin,
        "calculated_target_seek": target_seek,
    }
