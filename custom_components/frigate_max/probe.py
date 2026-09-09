"""Pure validation and timing calculations for FrigateMax Prototype 0."""

from __future__ import annotations

import math
from collections.abc import Iterator, Mapping, Sequence
from typing import Any

ALLOWED_CAMERAS = frozenset({"drive_up", "drive_down"})
MAX_RANGE_SECONDS = 300.0
ISOLATION_EPSILON_SECONDS = 0.001
MIN_CLIP_SECONDS = 0.101


class ProbeDataError(ValueError):
    """Raised when probe input or Frigate data cannot be associated safely."""


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
