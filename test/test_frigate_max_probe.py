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
