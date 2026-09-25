"""Focused tests for the disposable FrigateMax Prototype 0 timing probe."""

from __future__ import annotations

import importlib.util
import math
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

PROBE_PATH = (
    Path(__file__).resolve().parents[1]
    / "custom_components"
    / "frigate_max"
    / "probe.py"
)
SPEC = importlib.util.spec_from_file_location("frigate_max_probe", PROBE_PATH)
assert SPEC is not None and SPEC.loader is not None
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class FrigateMaxProbeTests(unittest.TestCase):
    def test_review_request_and_event_normalization_are_allowlisted(self) -> None:
        self.assertEqual(
            probe.validate_review_request(["drive_up", "drive_down"], 1000, 4600),
            (["drive_up", "drive_down"], 1000.0, 4600.0),
        )
        result = probe.normalize_review_events(
            [{
                "camera": "drive_up", "start_time": 1200, "end_time": 1300,
                "label": "person", "sub_label": "alice", "id": "private-id",
                "thumbnail": "/private/path.jpg",
            }],
            "drive_up",
        )
        self.assertEqual(result, [{
            "camera_id": "drive_up", "start_time": 1200.0, "end_time": 1300.0,
            "type": "person", "labels": ["person", "alice"],
        }])
        self.assertNotIn("private-id", repr(result))
        self.assertNotIn("private/path", repr(result))

    def test_review_request_rejects_unsafe_or_unbounded_ranges(self) -> None:
        for cameras, start, end in (([], 1000, 1100), (["front/door"], 1000, 1100),
                                     (["drive_up"], 1000, 1000 + probe.MAX_REVIEW_RANGE_SECONDS + 1)):
            with self.assertRaises(probe.ProbeDataError):
                probe.validate_review_request(cameras, start, end)

    def test_v1_prepare_accepts_safe_camera_ids_without_a_two_camera_cap(self) -> None:
        self.assertEqual(
            probe.validate_prepare_request("back_yard-2", 1000, 1120, 1015),
            ("back_yard-2", 1000.0, 1120.0, 1015.0),
        )
        for camera in ("", "front/door", "front door", "../front"):
            with self.assertRaises(probe.ProbeDataError):
                probe.validate_prepare_request(camera, 1000, 1120, 1015)

    def test_recording_availability_request_is_safe_and_two_hour_bounded(self) -> None:
        self.assertEqual(
            probe.validate_recording_availability_request("garage", 1000, 4600),
            ("garage", 1000.0, 4600.0),
        )
        for invalid in (
            ("front/door", 1000, 1100),
            ("garage", 1000, 1000),
            ("garage", 1000, 1000 + probe.MAX_AVAILABILITY_RANGE_SECONDS + 1),
            ("garage", float("nan"), 1100),
        ):
            with self.assertRaises(probe.ProbeDataError):
                probe.validate_recording_availability_request(*invalid)

    def test_recording_availability_empty_result_is_allowlisted(self) -> None:
        result = probe.normalize_recording_availability([], "garage", 1000, 1100)
        self.assertEqual(
            result,
            {
                "camera": "garage",
                "requested_start": 1000,
                "requested_end": 1100,
                "coverage": [],
            },
        )

    def test_recording_availability_merges_overlap_touch_and_normal_boundaries(self) -> None:
        result = probe.normalize_recording_availability(
            [
                {"start_time": 1000, "end_time": 1010},
                {"start_time": 1009, "end_time": 1020},
                {"start_time": 1020, "end_time": 1030},
                {"start_time": 1030.9, "end_time": 1040},
                {"start_time": 1041.010, "end_time": 1050},
            ],
            "garage",
            1000,
            1050,
        )
        self.assertEqual(result["coverage"], [{"start": 1000, "end": 1050}])

    def test_recording_availability_preserves_meaningful_gap(self) -> None:
        result = probe.normalize_recording_availability(
            [
                {"start_time": 1000, "end_time": 1010},
                {"start_time": 1011.5, "end_time": 1020},
                {"start_time": 1022, "end_time": 1030},
            ],
            "garage",
            1000,
            1030,
        )
        self.assertEqual(
            result["coverage"],
            [
                {"start": 1000, "end": 1020},
                {"start": 1022, "end": 1030},
            ],
        )

    def test_recording_availability_clips_rows_to_requested_interval(self) -> None:
        result = probe.normalize_recording_availability(
            [{"start_time": 900, "end_time": 1200}], "garage", 1000, 1100
        )
        self.assertEqual(result["coverage"], [{"start": 1000, "end": 1100}])

    def test_recording_availability_rejects_malformed_upstream_rows(self) -> None:
        with self.assertRaises(probe.ProbeDataError):
            probe.normalize_recording_availability(
                [{"start_time": 1000, "end_time": 999}], "garage", 900, 1100
            )
        with self.assertRaises(probe.ProbeDataError):
            probe.normalize_recording_availability(
                {"recording": "not-a-list"}, "garage", 900, 1100
            )

    def test_v1_prepare_normalization_drops_paths_credentials_and_unknowns(self) -> None:
        result = probe.normalize_prepare_result(
            {
                "camera": "drive_up",
                "requested_start": 1000,
                "requested_end": 1120,
                "recording_start": 990,
                "requested_clip_from_ms": 10000,
                "adjusted_clip_from_ms": 7000,
                "effective_absolute_origin": 997,
                "calculated_target_seek": 18,
                "path": "/media/private/recording.mp4",
                "password": "synthetic-secret",
                "mapping": {"clips": []},
            },
            "drive_up",
        )
        self.assertEqual(set(result), set(probe.PREPARED_TIMING_FIELDS))
        self.assertNotIn("path", result)
        self.assertNotIn("password", result)
        self.assertNotIn("synthetic-secret", repr(result))

    def test_websocket_semantic_input_validation_is_bounded(self) -> None:
        self.assertEqual(
            probe.validate_probe_request("drive_up", 1000, 1120, 1015),
            ("drive_up", 1000.0, 1120.0, 1015.0),
        )
        for invalid in (
            ("front_door", 1000, 1120, 1015),
            ("drive_up", 1000, 999, 1000),
            ("drive_up", 1000, 1400, 1015),
            ("drive_up", 1000, 1120, 1200),
            ("drive_up", math.nan, 1120, 1015),
        ):
            with self.assertRaises(probe.ProbeDataError):
                probe.validate_probe_request(*invalid)

    def test_adjusted_clip_from_produces_authoritative_origin(self) -> None:
        full = {
            "sequences": [
                {
                    "clips": [
                        {
                            "type": "source",
                            "path": "/media/frigate/internal/secret.mp4",
                            "clipFrom": 7000,
                            "keyFrameDurations": [13000],
                        }
                    ]
                }
            ]
        }
        isolated = {
            "sequences": [
                {
                    "clips": [
                        {
                            "type": "source",
                            "path": "/different/internal/value-is-ignored.mp4",
                            "clipFrom": 7000,
                        }
                    ]
                }
            ]
        }
        result = probe.derive_timing_result(
            camera="drive_up",
            requested_start=1010,
            requested_end=1130,
            target=1025,
            recording_start=1000,
            full_mapping=full,
            isolated_mapping=isolated,
        )
        self.assertEqual(result["requested_clip_from_ms"], 10000)
        self.assertEqual(result["adjusted_clip_from_ms"], 7000)
        self.assertEqual(result["effective_absolute_origin"], 1007)
        self.assertEqual(result["calculated_target_seek"], 18)
        self.assertNotIn("path", result)
        self.assertNotIn("sequences", result)
        self.assertNotIn("secret", repr(result))

    def test_candidate_window_isolates_known_recording_without_paths(self) -> None:
        windows = list(
            probe.candidate_probe_windows(
                [
                    {"id": "opaque-a", "start_time": 1000, "end_time": 1010},
                    {"id": "opaque-b", "start_time": 1012, "end_time": 1022},
                ],
                1005,
                1020,
            )
        )
        self.assertEqual(windows[0]["recording_start"], 1000)
        self.assertEqual(windows[0]["probe_start"], 1005)
        self.assertEqual(windows[0]["probe_end"], 1010)
        self.assertNotIn("id", windows[0])

        contiguous = list(
            probe.candidate_probe_windows(
                [
                    {"start_time": 1000, "end_time": 1010},
                    {"start_time": 1010, "end_time": 1020},
                ],
                1005,
                1015,
            )
        )
        self.assertAlmostEqual(contiguous[0]["probe_end"], 1009.999)

    def test_later_fractional_overlap_does_not_block_first_safe_candidate(self) -> None:
        windows = probe.candidate_probe_windows(
            [
                {"start_time": 1178, "end_time": 1187.989941},
                {"start_time": 1188, "end_time": 1197.989941},
                {"start_time": 1198, "end_time": 1208.039941},
                {"start_time": 1208, "end_time": 1217.989941},
            ],
            1185,
            1320,
        )

        first = next(windows)

        self.assertEqual(first["recording_start"], 1178)
        self.assertEqual(first["probe_start"], 1185)
        self.assertEqual(first["probe_end"], 1187.989941)

        with self.assertRaisesRegex(probe.ProbeDataError, "Overlapping"):
            list(windows)

    def test_malformed_or_ambiguous_frigate_data_fails_closed(self) -> None:
        with self.assertRaises(probe.ProbeDataError):
            probe.mapping_clips({"sequences": []})
        with self.assertRaises(probe.ProbeDataError):
            probe.derive_timing_result(
                camera="drive_down",
                requested_start=1010,
                requested_end=1130,
                target=1025,
                recording_start=1000,
                full_mapping={
                    "sequences": [{"clips": [{"clipFrom": 7000}]}]
                },
                isolated_mapping={
                    "sequences": [{"clips": [{"clipFrom": 6000}]}]
                },
            )
        with self.assertRaisesRegex(probe.ProbeDataError, "Overlapping"):
            list(
                probe.candidate_probe_windows(
                    [
                        {"start_time": 1000, "end_time": 1012},
                        {"start_time": 1010, "end_time": 1020},
                    ],
                    1011,
                    1018,
                )
            )

    def _presentation_rows(self) -> list[dict[str, object]]:
        return [
            {"path": "r0", "start_time": 1000.0, "end_time": 1010.0},
            {"path": "r1", "start_time": 1009.95, "end_time": 1019.95},
            {"path": "r2", "start_time": 1021.0, "end_time": 1025.0},
        ]

    def _presentation_mapping(self) -> dict[str, object]:
        return {
            "sequences": [{"clips": [
                {"path": "r0", "clipFrom": 100, "keyFrameDurations": [9900]},
                {"path": "r1", "clipFrom": 0, "keyFrameDurations": [10000]},
                {"path": "r2", "clipFrom": 0, "keyFrameDurations": [4000]},
            ]}],
        }

    def test_v2_presentation_request_is_safe_and_half_open(self) -> None:
        self.assertEqual(
            probe.validate_presentation_request("garage", 1005, 1000, 1100),
            ("garage", 1005.0, 1000.0, 1100.0),
        )
        for invalid in (
            ("front/door", 1005, 1000, 1100),
            ("garage", 1100, 1000, 1100),
            ("garage", 1000, 1100, 1000),
            ("garage", float("nan"), 1000, 1100),
            ("garage", 1005, 1000, 1000 + probe.MAX_PRESENTATION_BOUNDS_SECONDS + 1),
        ):
            with self.assertRaises(probe.ProbeDataError):
                probe.validate_presentation_request(*invalid)

    def test_find_coverage_run_reports_bounded_continuation_and_gap(self) -> None:
        rows = self._presentation_rows()
        run = probe.find_coverage_run(rows, 1015, 1005, 1018)
        self.assertEqual(run["known_start"], 1005)
        self.assertEqual(run["known_end"], 1018)
        self.assertTrue(run["continues_before"])
        self.assertTrue(run["continues_after"])
        gapped = [*rows[:2], {"id": "gap", "start_time": 1022.1, "end_time": 1025}]
        with self.assertRaisesRegex(probe.ProbeDataError, "No recording"):
            probe.find_coverage_run(gapped, 1020.5, 1000, 1025)

    def test_presentation_window_is_forward_biased_and_backfills_near_end(self) -> None:
        run = {"known_start": 1000.0, "known_end": 10000.0}
        window = probe.build_presentation_window(2000, run, 1000, 12000)
        self.assertEqual(window["logical_start"], 1985)
        self.assertEqual(window["logical_end"], 9185)
        self.assertEqual(window["logical_end"] - window["logical_start"], 7200)
        near_end = probe.build_presentation_window(9990, run, 1000, 12000)
        self.assertEqual(near_end["logical_end"], 10000)
        self.assertEqual(near_end["logical_start"], 2800)

    def test_presentation_window_accepts_short_run_but_never_crosses_gap(self) -> None:
        short = probe.build_presentation_window(
            1005, {"known_start": 1000, "known_end": 1010}, 900, 1100
        )
        self.assertEqual(short["logical_start"], 1000)
        self.assertEqual(short["logical_end"], 1010)
        with self.assertRaises(probe.ProbeDataError):
            probe.build_presentation_window(
                1020, {"known_start": 1000, "known_end": 1010}, 900, 1100
            )

    def test_two_hour_window_stays_inside_short_coverage_and_a_real_gap(self) -> None:
        rows = [
            {"start_time": 1000, "end_time": 5000},
            {"start_time": 5010, "end_time": 12000},
        ]
        run = probe.find_coverage_run(rows, 1015, 1000, 12000)
        self.assertEqual(run["known_end"], 5000)
        window = probe.build_presentation_window(1015, run, 1000, 12000)
        self.assertEqual((window["logical_start"], window["logical_end"]), (1000, 5000))
        self.assertEqual(window["logical_end"] - window["logical_start"], 4000)

    def test_piecewise_map_associates_keyframe_origin_and_clips_lookahead(self) -> None:
        result = probe.build_piecewise_time_map(
            self._presentation_rows(),
            probe.mapping_clips(self._presentation_mapping()),
            1000,
            1022,
            1015,
        )
        self.assertEqual(result["effective_absolute_origin"], 1000.1)
        self.assertEqual(result["resolved_selected_epoch"], 1015)
        self.assertAlmostEqual(result["selected_media_position"], 14.95)
        overlap = probe.build_piecewise_time_map(
            self._presentation_rows(),
            probe.mapping_clips(self._presentation_mapping()),
            1000,
            1022,
            1009.98,
        )
        self.assertAlmostEqual(overlap["selected_media_position"], 9.93)
        seam = probe.build_piecewise_time_map(
            self._presentation_rows(),
            probe.mapping_clips(self._presentation_mapping()),
            1000,
            1022,
            1020.5,
        )
        self.assertEqual(seam["resolved_selected_epoch"], 1021.0)
        self.assertLess(result["logical_media_end_position"], 23.9)
        self.assertEqual(result["time_map"]["unit"], "microseconds")
        self.assertTrue(all(isinstance(value, int) for span in result["time_map"]["spans"] for value in span))

    def test_piecewise_map_scalar_endpoints_use_the_serialized_microsecond_map(self) -> None:
        rows = [{"path": "r0", "start_time": 1000.0, "end_time": 1010.0}]
        clips = [{"path": "r0", "clipFrom": 333, "keyFrameDurations": [9667]}]
        result = probe.build_piecewise_time_map(
            rows, clips, 1000.3330006, 1009.0, 1001.0
        )
        first = result["time_map"]["spans"][0]
        last = result["time_map"]["spans"][-1]
        self.assertEqual(result["media_start_position"], first[2] / 1_000_000)
        self.assertEqual(result["logical_media_end_position"], last[3] / 1_000_000)
        self.assertEqual(first[2], 1)

    def _different_namespace_fixture(self) -> tuple[list[dict[str, object]], list[dict[str, object]], float]:
        paths = [
            "fixture://clip/2026-09-15/18/garage/30.00.mp4",
            "fixture://clip/2026-09-15/18/garage/30.10.mp4",
            "fixture://clip/2026-09-15/18/garage/30.20.mp4",
        ]
        base = probe._clip_path_epoch({"path": paths[0]})
        rows = [
            {"id": "outside-before", "start_time": base - 10, "end_time": base},
            {"id": "row-0", "start_time": base, "end_time": base + 10},
            {"id": "row-1", "start_time": base + 10, "end_time": base + 20},
            {"id": "row-2", "start_time": base + 20, "end_time": base + 30},
            {"id": "outside-after", "start_time": base + 30, "end_time": base + 40},
        ]
        clips = [
            {"path": path, "clipFrom": 0, "keyFrameDurations": [10000]}
            for path in paths
        ]
        return rows, clips, base

    def test_different_namespaces_accept_exact_temporal_pairing(self) -> None:
        rows, clips, base = self._different_namespace_fixture()
        result = probe.build_piecewise_time_map(rows, clips, base, base + 25, base + 5)
        self.assertEqual(result["resolved_selected_epoch"], base + 5)
        self.assertEqual(len(result["time_map"]["spans"]), 3)

    def test_different_namespaces_reject_count_mismatch(self) -> None:
        rows, clips, base = self._different_namespace_fixture()
        rows.pop(2)
        with self.assertRaisesRegex(probe.ProbeDataError, "ambiguous recording order"):
            probe.build_piecewise_time_map(rows, clips, base, base + 25, base + 5)

    def test_different_namespaces_reject_temporal_mismatch(self) -> None:
        rows, clips, base = self._different_namespace_fixture()
        rows[2]["start_time"] = base + 10.01
        with self.assertRaisesRegex(probe.ProbeDataError, "temporal association"):
            probe.build_piecewise_time_map(rows, clips, base, base + 25, base + 5)

    def test_different_namespaces_reject_one_row_forward_shift(self) -> None:
        _rows, clips, base = self._different_namespace_fixture()
        shifted_rows = [
            {"id": f"row-{index}", "start_time": base + offset, "end_time": base + 50 + index}
            for index, offset in enumerate((-10, 0, 10))
        ]
        with self.assertRaisesRegex(probe.ProbeDataError, "temporal association"):
            probe.associate_recording_clips(shifted_rows, clips)

    def test_different_namespaces_reject_one_row_backward_shift(self) -> None:
        _rows, clips, base = self._different_namespace_fixture()
        clips[-1]["keyFrameDurations"] = [11000]
        shifted_rows = [
            {"id": f"row-{index}", "start_time": base + offset, "end_time": base + 50 + index}
            for index, offset in enumerate((10, 20, 30))
        ]
        with self.assertRaisesRegex(probe.ProbeDataError, "temporal association"):
            probe.associate_recording_clips(shifted_rows, clips)

    def test_different_namespaces_reject_ambiguous_pairing(self) -> None:
        rows, clips, base = self._different_namespace_fixture()
        rows[2]["start_time"] = base
        rows[2]["end_time"] = base + 10
        with self.assertRaises(probe.ProbeDataError):
            probe.build_piecewise_time_map(rows, clips, base, base + 25, base + 5)

    def test_same_namespace_identity_mismatch_never_falls_back_to_order(self) -> None:
        rows, clips, base = self._different_namespace_fixture()
        same_namespace_rows = [
            {"path": f"row-{index}", "start_time": row["start_time"], "end_time": row["end_time"]}
            for index, row in enumerate(rows[1:4])
        ]
        with self.assertRaisesRegex(probe.ProbeDataError, "no matching recording row"):
            probe.build_piecewise_time_map(same_namespace_rows, clips, base, base + 25, base + 5)

    def test_terminal_lookahead_is_associated_but_excluded_from_logical_map(self) -> None:
        rows, clips, base = self._different_namespace_fixture()
        logical_end = base + 25
        result = probe.build_piecewise_time_map(rows, clips, base, logical_end, base + 5)
        physical_media_end = sum(probe._clip_duration_seconds(clip) for clip in clips)
        self.assertEqual(result["logical_media_end_position"], 25)
        self.assertLess(result["logical_media_end_position"], physical_media_end)
        self.assertEqual(result["time_map"]["spans"][-1][1], int((logical_end - base) * 1_000_000))

    def test_hour_terminal_lookahead_keeps_all_362_physical_pairs(self) -> None:
        base = 1_789_521_800.0
        rows = []
        clips = []
        for index in range(362):
            start = base + index * 10
            stamp = datetime.fromtimestamp(start, timezone.utc)
            path = stamp.strftime("/recordings/%Y-%m-%d/%H/garage/%M.%S.mp4")
            rows.append({"id": f"row-{index}", "start_time": start, "end_time": start + 10})
            clips.append({"path": path, "clipFrom": 0, "keyFrameDurations": [10000]})
        logical_end = base + 3612
        pairs = probe.associate_recording_clips(rows, clips)
        result = probe.build_piecewise_time_map(rows, clips, base, logical_end, base + 15)
        self.assertEqual(len(pairs), 362)
        self.assertEqual(rows[-1]["end_time"] - logical_end, 8)
        self.assertEqual(sum(probe._clip_duration_seconds(clip) for clip in clips), 3620)
        self.assertEqual(result["logical_media_end_position"], 3612)
        self.assertEqual(len(result["time_map"]["spans"]), 362)
        self.assertEqual(result["time_map"]["spans"][-1][1], 3_612_000_000)
        with self.assertRaises(probe.ProbeDataError):
            probe._map_epoch_to_media(
                [{
                    "epoch_start": base,
                    "epoch_end": logical_end,
                    "media_start": 0,
                    "media_end": 3612,
                }],
                logical_end,
                base,
                logical_end,
            )

    def test_two_hour_terminal_lookahead_preserves_half_open_microsecond_end(self) -> None:
        base = 1_789_521_800.04
        rows = []
        clips = []
        for index in range(721):
            start = base + index * 10
            path = f"/private/recording-{index}.mp4"
            rows.append({"path": path, "start_time": start, "end_time": start + 10})
            clips.append({"path": path, "clipFrom": 0, "keyFrameDurations": [10000]})
        logical_end = base + 7200
        result = probe.build_piecewise_time_map(rows, clips, base, logical_end, base + 15)
        self.assertEqual(len(probe.associate_recording_clips(rows, clips)), 721)
        self.assertEqual(len(result["time_map"]["spans"]), 720)
        self.assertEqual(result["time_map"]["spans"][-1][1], 7_200_000_000)
        self.assertEqual(result["logical_media_end_position"],
                         result["time_map"]["spans"][-1][3] / 1_000_000)
        self.assertLess(result["logical_media_end_position"], 7210)
        with self.assertRaises(probe.ProbeDataError):
            probe._map_epoch_to_media(
                [{"epoch_start": base, "epoch_end": logical_end,
                  "media_start": 0, "media_end": 7200}],
                logical_end, base, logical_end,
            )

    def test_piecewise_map_rejects_ambiguous_or_malformed_association(self) -> None:
        clips = probe.mapping_clips(self._presentation_mapping())
        with self.assertRaises(probe.ProbeDataError):
            probe.build_piecewise_time_map(
                [{"id": "r0", "start_time": 1000, "end_time": 1010}],
                clips,
                1000,
                1010,
                1005,
            )
        with self.assertRaises(probe.ProbeDataError):
            probe.build_piecewise_time_map(
                self._presentation_rows(),
                [{"path": "r0", "clipFrom": 0}],
                1000,
                1010,
                1005,
            )
        with self.assertRaises(probe.ProbeDataError):
            probe._map_epoch_to_media(
                [
                    {"epoch_start": 1000, "epoch_end": 1010, "media_start": 0, "media_end": 10},
                    {"epoch_start": 1012, "epoch_end": 1020, "media_start": 10, "media_end": 18},
                ],
                1010.0,
                1000,
                1020,
            )

    def test_v2_result_normalization_is_strictly_allowlisted(self) -> None:
        result = {
            "schema": 2,
            "camera": "garage",
            "selected_epoch": 1015,
            "resolved_selected_epoch": 1015,
            "requested_wall_start": 1000,
            "requested_wall_end": 1022,
            "effective_wall_start": 1000.1,
            "logical_wall_start": 1000,
            "logical_wall_end": 1022,
            "effective_absolute_origin": 1000.1,
            "media_start_position": 0,
            "selected_media_position": 14.9,
            "logical_media_end_position": 23,
            "coverage_run": {
                "known_start": 1000,
                "known_end": 1022,
                "continues_before": False,
                "continues_after": True,
                "private": "drop",
            },
            "time_map": {
                "epoch_origin": 1000.1,
                "unit": "microseconds",
                "spans": [[0, 9_900_000, 0, 9_900_000]],
            },
            "path": "/private/recording.mp4",
            "password": "secret",
        }
        normalized = probe.normalize_presentation_result(result, "garage")
        self.assertNotIn("path", normalized)
        self.assertNotIn("password", normalized)
        self.assertNotIn("private", normalized["coverage_run"])
        self.assertEqual(set(normalized), set(probe.PRESENTATION_FIELDS))

        result["candidate_recording_row_count"] = 1101
        result["mapping_clip_count"] = 1100
        result["vod_mapping_latency_ms"] = 12.5
        lab = probe.normalize_lab_presentation_result(result, "garage")
        self.assertEqual(lab["candidate_recording_row_count"], 1101)
        self.assertEqual(lab["mapping_clip_count"], 1100)
        self.assertNotIn("private/recording", repr(lab))
        self.assertEqual(set(normalized), set(probe.PRESENTATION_FIELDS))

    def test_lab_exact_range_accepts_over_1080_without_changing_production_window(self) -> None:
        camera, start, end, target = probe.validate_lab_probe_request(
            "garage", 1000, 12010, 1015
        )
        rows = [
            {"path": f"/private/recording-{index}.mp4",
             "start_time": start + index * 10, "end_time": start + (index + 1) * 10}
            for index in range(1101)
        ]
        preflight = probe.lab_recording_preflight(rows, camera, start, end, target)
        self.assertEqual(preflight["candidate_recording_row_count"], 1101)
        self.assertTrue(preflight["continuous_coverage"])
        self.assertNotIn("/private/", repr(preflight))
        normal = probe.build_presentation_window(
            target, probe.find_coverage_run(rows, target, start, end), start, end
        )
        self.assertEqual(normal["logical_end"] - normal["logical_start"], 7200)

    def test_lab_range_rejects_gap_and_unsafe_or_unbounded_requests(self) -> None:
        for args in (
            ("../camera", 1000, 12010, 1015),
            ("garage", 1000, 1000 + probe.LAB_MAX_PROBE_SECONDS + 1, 1015),
            ("garage", 1000, 12010, 12010),
            ("garage", time.time() - 100, time.time() + 100, time.time()),
        ):
            with self.assertRaises(probe.ProbeDataError):
                probe.validate_lab_probe_request(*args)
        rows = [
            {"start_time": 1000, "end_time": 1010},
            {"start_time": 1012, "end_time": 1020},
        ]
        with self.assertRaisesRegex(probe.ProbeDataError, "crosses unavailable"):
            probe.lab_recording_preflight(rows, "garage", 1000, 1020, 1005)


if __name__ == "__main__":
    unittest.main()
