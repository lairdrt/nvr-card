"""Single authenticated WebSocket command for FrigateMax Prototype 0."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .client import FrigateProbeError
from .probe import (
    ProbeDataError,
    normalize_prepare_result,
    validate_prepare_request,
    validate_probe_request,
)

DOMAIN = "frigate_max"


@websocket_api.websocket_command(
    {
        vol.Required("type"): "frigate_max/probe_vod_timing",
        vol.Required("camera"): str,
        vol.Required("requested_start"): vol.Coerce(float),
        vol.Required("requested_end"): vol.Coerce(float),
        vol.Required("target"): vol.Coerce(float),
    }
)
@websocket_api.async_response
async def websocket_probe_vod_timing(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return safe, authoritative timing for one bounded historical request."""
    try:
        camera, start, end, target = validate_probe_request(
            msg["camera"], msg["requested_start"], msg["requested_end"], msg["target"]
        )
        result = await hass.data[DOMAIN].probe_vod_timing(
            camera, start, end, target
        )
    except (ProbeDataError, FrigateProbeError) as err:
        connection.send_error(msg["id"], "frigate_max_probe_error", str(err))
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "frigate_max/v1/vod/prepare",
        vol.Required("camera"): str,
        vol.Required("requested_start"): vol.Coerce(float),
        vol.Required("requested_end"): vol.Coerce(float),
        vol.Required("target"): vol.Coerce(float),
    }
)
@websocket_api.async_response
async def websocket_prepare_vod_v1(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return the safe normalized v1 VOD preparation response."""
    try:
        camera, start, end, target = validate_prepare_request(
            msg["camera"], msg["requested_start"], msg["requested_end"], msg["target"]
        )
        result = await hass.data[DOMAIN].prepare_vod(camera, start, end, target)
        normalized = normalize_prepare_result(result, camera)
    except (ProbeDataError, FrigateProbeError) as err:
        connection.send_error(msg["id"], "frigate_max_vod_unavailable", str(err))
        return
    connection.send_result(msg["id"], normalized)


def async_register(hass: HomeAssistant) -> None:
    """Register the Prototype 0 compatibility command and Review v1 API."""
    websocket_api.async_register_command(hass, websocket_probe_vod_timing)
    websocket_api.async_register_command(hass, websocket_prepare_vod_v1)
