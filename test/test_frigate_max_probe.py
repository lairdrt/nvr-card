"""Focused tests for the disposable FrigateMax Prototype 0 timing probe."""

from __future__ import annotations

import importlib.util
import math
import unittest
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


if __name__ == "__main__":
    unittest.main()
