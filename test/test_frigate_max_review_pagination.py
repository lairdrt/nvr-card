"""Frigate v0.17 start-time cursor behavior for Review event retrieval."""

from __future__ import annotations

import unittest
import importlib.util
import sys
import types

from test.test_frigate_max_lab_client import ROOT, PACKAGE, client_module


def event(camera: str, index: int, start: float) -> dict:
    return {"id": f"{camera}-{index}", "camera": camera,
            "start_time": start, "end_time": start + 2, "label": "person"}


class EventClient(client_module.FrigateProbeClient):
    def __init__(self, rows: dict[str, list[dict]]) -> None:
        super().__init__(None, "https://fixture.invalid", "", "", True)
        self.rows = rows
        self.requests: list[dict[str, str]] = []
        self.responder = None

    async def _get_json(self, path: str, *, params=None, allow_404=False):
        assert path == "/api/events"
        self.requests.append(dict(params))
        if self.responder is not None:
            response = self.responder(len(self.requests), params)
            if response is not None:
                return response
        camera = params["camera"]
        after, before = float(params["after"]), float(params["before"])
        matches = (row for row in self.rows.get(camera, [])
                   if after < row["start_time"] < before)
        return sorted(matches, key=lambda row: row["start_time"], reverse=True)[:int(params["limit"])]


class ReviewEventPaginationTests(unittest.IsolatedAsyncioTestCase):
    async def test_short_page_terminates_and_includes_start_boundaries(self) -> None:
        rows = [event("drive_up", index, 1000 + index) for index in range(10)]
        rows += [event("drive_up", 20, 999), event("drive_up", 21, 1010)]
        client = EventClient({"drive_up": rows})
        result = await client.get_review_events(["drive_up"], 999, 1010)
        self.assertEqual(len(result), 12)
        self.assertEqual(len(client.requests), 1)
        self.assertLess(float(client.requests[0]["after"]), 999)
        self.assertGreater(float(client.requests[0]["before"]), 1010)
        self.assertEqual(client.requests[0]["include_thumbnails"], "0")
        self.assertEqual({row["start_time"] for row in result}, set(range(999, 1011)))

    async def test_exactly_one_full_page_checks_boundary_then_terminates(self) -> None:
        rows = [event("drive_up", index, 2000 + index) for index in range(1000)]
        client = EventClient({"drive_up": rows})
        result = await client.get_review_events(["drive_up"], 1000, 4000)
        self.assertEqual(len(result), 1000)
        self.assertEqual(len(client.requests), 3)
        self.assertEqual(float(client.requests[-1]["before"]), 2000)

    async def test_more_than_one_page_advances_newest_first_without_loss(self) -> None:
        rows = [event("drive_up", index, 1000 + index) for index in range(2501)]
        client = EventClient({"drive_up": rows})
        result = await client.get_review_events(["drive_up"], 999, 4000)
        self.assertEqual(len(result), 2501)
        self.assertEqual(len({row["start_time"] for row in result}), 2501)
        ordinary = [request for request in client.requests
                    if float(request["after"]) < 999]
        self.assertEqual([float(request["before"]) for request in ordinary],
                         [float(client.requests[0]["before"]), 2501, 1501])
        self.assertEqual(len(client.requests), 5)

    async def test_boundary_bucket_recovers_shared_timestamps_and_deduplicates_ids(self) -> None:
        rows = [event("drive_up", index, 3000 + index) for index in range(998)]
        rows += [event("drive_up", 1000 + index, 2500) for index in range(5)]
        rows += [event("drive_up", 2000, 2000)]
        client = EventClient({"drive_up": rows})
        result = await client.get_review_events(["drive_up"], 1000, 5000)
        self.assertEqual(len(result), 1004)
        self.assertEqual({row["start_time"] for row in result if row["start_time"] == 2500}, {2500})
        self.assertEqual(len([row for row in result if row["start_time"] == 2500]), 5)
        self.assertEqual(len(client.requests), 3)

    async def test_full_identical_timestamp_bucket_fails_closed(self) -> None:
        rows = [event("drive_up", index, 2500) for index in range(1001)]
        client = EventClient({"drive_up": rows})
        with self.assertRaisesRegex(client_module.FrigateProbeError, "incomplete"):
            await client.get_review_events(["drive_up"], 1000, 5000)
        self.assertEqual(len(client.requests), 2)

    async def test_repeated_page_and_nonadvancing_cursor_fail_closed(self) -> None:
        rows = [event("drive_up", index, 2000 + index) for index in range(1000)]
        client = EventClient({"drive_up": rows})
        first_page = sorted(rows, key=lambda row: row["start_time"], reverse=True)
        client.responder = lambda number, params: first_page if number == 3 else None
        with self.assertRaisesRegex(client_module.FrigateProbeError, "incomplete"):
            await client.get_review_events(["drive_up"], 1000, 4000)
        self.assertEqual(len(client.requests), 3)

    async def test_later_page_failure_propagates_without_partial_result(self) -> None:
        rows = [event("drive_up", index, 1000 + index) for index in range(1001)]
        client = EventClient({"drive_up": rows})
        def fail_later(number, params):
            if number == 3:
                raise client_module.FrigateProbeError("later page failed")
            return None
        client.responder = fail_later
        with self.assertRaisesRegex(client_module.FrigateProbeError, "later page failed"):
            await client.get_review_events(["drive_up"], 999, 3000)
        self.assertEqual(len(client.requests), 3)

    async def test_camera_cursors_and_duplicate_ids_are_isolated(self) -> None:
        up = [event("drive_up", index, 1000 + index) for index in range(1001)]
        down = [event("drive_down", 0, 1500)]
        down[0]["id"] = up[0]["id"]
        client = EventClient({"drive_up": up, "drive_down": down})
        result = await client.get_review_events(["drive_up", "drive_down"], 999, 3000)
        self.assertEqual(len(result), 1002)
        self.assertEqual({row["camera_id"] for row in result}, {"drive_up", "drive_down"})
        self.assertEqual(client.requests[-1]["camera"], "drive_down")
        self.assertGreater(float(client.requests[-1]["before"]), 3000)

    async def test_event_start_and_end_are_not_rewritten(self) -> None:
        rows = [event("drive_up", 0, 999), event("drive_up", 1, 1001)]
        rows[0]["end_time"] = 1010
        client = EventClient({"drive_up": rows})
        result = await client.get_review_events(["drive_up"], 1000, 2000)
        self.assertEqual(result[0]["start_time"], 1001)
        self.assertEqual(result[0]["end_time"], 1003)
        self.assertEqual(len(result), 1)


class ReviewEventWebsocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_complete_envelope_is_emitted_only_after_success(self) -> None:
        vol = types.ModuleType("voluptuous")
        vol.Required = lambda key: key
        vol.Coerce = lambda kind: kind
        websocket = types.ModuleType("homeassistant.components.websocket_api")
        websocket.websocket_command = lambda schema: lambda function: function
        websocket.async_response = lambda function: function
        websocket.ActiveConnection = object
        websocket.async_register_command = lambda hass, function: None
        components = types.ModuleType("homeassistant.components")
        components.websocket_api = websocket
        core = types.ModuleType("homeassistant.core")
        core.HomeAssistant = object
        homeassistant = types.ModuleType("homeassistant")
        homeassistant.components = components
        modules = {
            f"{PACKAGE}.client": client_module,
            "voluptuous": vol, "homeassistant": homeassistant,
            "homeassistant.components": components,
            "homeassistant.components.websocket_api": websocket,
            "homeassistant.core": core,
        }
        previous = {name: sys.modules.get(name) for name in modules}
        try:
            sys.modules.update(modules)
            spec = importlib.util.spec_from_file_location(
                f"{PACKAGE}.websocket_api",
                ROOT / "custom_components" / "frigate_max" / "websocket_api.py",
            )
            assert spec is not None and spec.loader is not None
            api = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(api)

            class Connection:
                def __init__(self) -> None:
                    self.results = []
                    self.errors = []

                def send_result(self, message_id, result) -> None:
                    self.results.append((message_id, result))

                def send_error(self, message_id, code, error) -> None:
                    self.errors.append((message_id, code, error))

            class Backend:
                failed = False

                async def get_review_events(self, cameras, from_epoch, to_epoch):
                    if self.failed:
                        raise client_module.FrigateProbeError("later page failed")
                    return [{"camera_id": cameras[0], "start_time": from_epoch + 1}]

            backend = Backend()
            hass = types.SimpleNamespace(data={"frigate_max": backend})
            message = {"id": 7, "cameras": ["drive_up"], "from": 1000, "to": 2000}
            connection = Connection()
            await api.websocket_review_events_v1(hass, connection, message)
            self.assertEqual(connection.results, [(7, {
                "schema": 2, "complete": True,
                "items": [{"camera_id": "drive_up", "start_time": 1001}],
            })])
            backend.failed = True
            await api.websocket_review_events_v1(hass, connection, message)
            self.assertEqual(len(connection.results), 1)
            self.assertEqual(connection.errors[0][:2],
                             (7, "frigate_max_review_unavailable"))
        finally:
            for name, old in previous.items():
                if old is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = old


if __name__ == "__main__":
    unittest.main()
