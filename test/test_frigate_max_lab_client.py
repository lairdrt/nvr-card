"""Temporary Lab range regression against the shared FrigateMax client path."""

from __future__ import annotations

import importlib.util
import re
import sys
import types
import unittest
from pathlib import Path

from test.test_frigate_max_probe import probe


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "_frigate_max_lab_test"
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT / "custom_components" / "frigate_max")]
sys.modules[PACKAGE] = package
sys.modules[f"{PACKAGE}.probe"] = probe
aiohttp = types.ModuleType("aiohttp")
aiohttp.ClientSession = object
aiohttp.ClientError = Exception
aiohttp.ClientTimeout = lambda **kwargs: kwargs
sys.modules.setdefault("aiohttp", aiohttp)
spec = importlib.util.spec_from_file_location(
    f"{PACKAGE}.client", ROOT / "custom_components" / "frigate_max" / "client.py"
)
assert spec is not None and spec.loader is not None
client_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client_module)


class FixtureClient(client_module.FrigateProbeClient):
    def __init__(self, rows: list[dict]) -> None:
        super().__init__(None, "https://fixture.invalid", "", "", True)
        self.rows = rows
        self.requests: list[str] = []

    async def _get_json(self, path: str, *, params=None, allow_404=False):
        self.requests.append(path)
        if path.endswith("/recordings"):
            start = float(params["after"])
            end = float(params["before"])
            return [row for row in self.rows if row["end_time"] > start and row["start_time"] < end]
        match = re.search(r"/start/([\d.]+)/end/([\d.]+)$", path)
        if match is None:
            raise AssertionError("Unexpected fixture request")
        start, end = map(float, match.groups())
        clips = [
            {"id": row["id"], "clipFrom": 0, "keyFrameDurations": [10000]}
            for row in self.rows if row["end_time"] > start and row["start_time"] < end
        ]
        return {"sequences": [{"clips": clips}]}


class FrigateMaxLabClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_lab_preflight_and_prepare_cross_1080_while_normal_v2_stays_two_hour_bounded(self) -> None:
        start = 1000.0
        rows = [
            {"id": f"row-{index}", "private_path": f"/private/row-{index}.mp4",
             "start_time": start + 10 * index, "end_time": start + 10 * (index + 1)}
            for index in range(1101)
        ]
        client = FixtureClient(rows)
        end = start + 11010
        count = await client.lab_preflight_vod("garage", start, end, start + 15)
        self.assertEqual(count["candidate_recording_row_count"], 1101)
        self.assertTrue(count["continuous_coverage"])
        lab = await client.prepare_presentation(
            "garage", start + 15, start, end, lab_exact_range=True
        )
        self.assertEqual(lab["requested_wall_end"] - lab["requested_wall_start"], 11010)
        self.assertEqual(lab["candidate_recording_row_count"], 1101)
        self.assertEqual(lab["mapping_clip_count"], 1101)
        self.assertEqual(len(lab["time_map"]["spans"]), 1101)
        self.assertNotIn("/private/", repr(probe.normalize_lab_presentation_result(lab, "garage")))

        normal = await client.prepare_presentation("garage", start + 15, start, end)
        self.assertEqual(normal["logical_wall_start"], start)
        self.assertEqual(normal["logical_wall_end"], start + 7200)
        self.assertEqual(normal["requested_wall_end"] - normal["requested_wall_start"], 7200)
        self.assertEqual(len(normal["time_map"]["spans"]), 720)
        self.assertNotIn("candidate_recording_row_count", normal)
        self.assertNotIn("mapping_clip_count", normal)
        self.assertNotIn("/private/", repr(probe.normalize_presentation_result(normal, "garage")))

    async def test_normal_v2_centered_target_allows_four_hour_coverage_query(self) -> None:
        start = 1000.0
        rows = [
            {"id": f"row-{index}", "start_time": start + index * 10,
             "end_time": start + (index + 1) * 10}
            for index in range(1440)
        ]
        client = FixtureClient(rows)
        target = start + 7200
        normal = await client.prepare_presentation("garage", target, start, start + 14400)
        self.assertEqual(normal["logical_wall_start"], target - 15)
        self.assertEqual(normal["logical_wall_end"], target - 15 + 7200)
        self.assertEqual(len(normal["time_map"]["spans"]), 721)

    async def test_normal_v2_short_coverage_stops_before_a_real_gap(self) -> None:
        start = 1000.0
        rows = [
            {"id": f"first-{index}", "start_time": start + index * 10,
             "end_time": start + (index + 1) * 10}
            for index in range(400)
        ]
        rows.extend(
            {"id": f"later-{index}", "start_time": start + 4010 + index * 10,
             "end_time": start + 4020 + index * 10}
            for index in range(400)
        )
        client = FixtureClient(rows)
        normal = await client.prepare_presentation("garage", start + 15, start, start + 9000)
        self.assertEqual(normal["logical_wall_start"], start)
        self.assertEqual(normal["logical_wall_end"], start + 4000)
        self.assertEqual(len(normal["time_map"]["spans"]), 400)
        self.assertEqual(normal["logical_media_end_position"], 4000)


if __name__ == "__main__":
    unittest.main()
