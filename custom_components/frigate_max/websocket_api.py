"""Single authenticated WebSocket command for FrigateMax Prototype 0."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .client import FrigateProbeError
from .probe import (
    ProbeDataError,
    normalize_lab_presentation_result,
    normalize_prepare_result,
    normalize_presentation_result,
    validate_prepare_request,
    validate_presentation_request,
    validate_lab_probe_request,
    validate_probe_request,
    validate_recording_availability_request,
    validate_review_request,
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
    websocket_api.async_register_command(hass, websocket_review_events_v1)
    websocket_api.async_register_command(hass, websocket_recording_availability_v1)
    websocket_api.async_register_command(hass, websocket_prepare_presentation_v2)
    websocket_api.async_register_command(hass, websocket_lab_vod_preflight)
    websocket_api.async_register_command(hass, websocket_lab_vod_prepare)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "frigate_max/v1/review/get",
        vol.Required("cameras"): [str],
        vol.Required("from"): vol.Coerce(float),
        vol.Required("to"): vol.Coerce(float),
    }
)
@websocket_api.async_response
async def websocket_review_events_v1(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return allowlisted event markers for an active Review range."""
    try:
        cameras, from_epoch, to_epoch = validate_review_request(
            msg["cameras"], msg["from"], msg["to"]
        )
        result = await hass.data[DOMAIN].get_review_events(cameras, from_epoch, to_epoch)
    except (ProbeDataError, FrigateProbeError) as err:
        connection.send_error(msg["id"], "frigate_max_review_unavailable", str(err))
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "frigate_max/v1/recordings/availability",
        vol.Required("camera"): str,
        vol.Required("start"): vol.Coerce(float),
        vol.Required("end"): vol.Coerce(float),
    }
)
@websocket_api.async_response
async def websocket_recording_availability_v1(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return safe recording coverage for one bounded interval."""
    try:
        camera, start, end = validate_recording_availability_request(
            msg["camera"], msg["start"], msg["end"]
        )
        result = await hass.data[DOMAIN].get_recording_availability(camera, start, end)
    except (ProbeDataError, FrigateProbeError) as err:
        connection.send_error(msg["id"], "frigate_max_recordings_unavailable", str(err))
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "frigate_max/v2/vod/prepare",
        vol.Required("camera"): str,
        vol.Required("target"): vol.Coerce(float),
        vol.Required("bounds_start"): vol.Coerce(float),
        vol.Required("bounds_end"): vol.Coerce(float),
    }
)
@websocket_api.async_response
async def websocket_prepare_presentation_v2(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return the sanitized v2 absolute-time presentation contract."""
    try:
        camera, target, bounds_start, bounds_end = validate_presentation_request(
            msg["camera"], msg["target"], msg["bounds_start"], msg["bounds_end"]
        )
        result = await hass.data[DOMAIN].prepare_presentation(
            camera, target, bounds_start, bounds_end
        )
        normalized = normalize_presentation_result(result, camera)
    except (ProbeDataError, FrigateProbeError) as err:
        connection.send_error(msg["id"], "frigate_max_vod_presentation_unavailable", str(err))
        return
    connection.send_result(msg["id"], normalized)


_LAB_VOD_SCHEMA = {
    vol.Required("camera"): str,
    vol.Required("start"): vol.Coerce(float),
    vol.Required("end"): vol.Coerce(float),
    vol.Required("target"): vol.Coerce(float),
}


@websocket_api.websocket_command({vol.Required("type"): "frigate_max/lab/vod/preflight", **_LAB_VOD_SCHEMA})
@websocket_api.async_response
async def websocket_lab_vod_preflight(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Temporary Lab-only row/coverage measurement before a long VOD mapping."""
    try:
        camera, start, end, target = validate_lab_probe_request(
            msg["camera"], msg["start"], msg["end"], msg["target"]
        )
        result = await hass.data[DOMAIN].lab_preflight_vod(camera, start, end, target)
    except (ProbeDataError, FrigateProbeError) as err:
        connection.send_error(msg["id"], "frigate_max_lab_preflight_unavailable", str(err))
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): "frigate_max/lab/vod/prepare", **_LAB_VOD_SCHEMA})
@websocket_api.async_response
async def websocket_lab_vod_prepare(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Temporary Lab-only exact range; production V2 still uses its hour window."""
    try:
        camera, start, end, target = validate_lab_probe_request(
            msg["camera"], msg["start"], msg["end"], msg["target"]
        )
        result = await hass.data[DOMAIN].prepare_presentation(
            camera, target, start, end, lab_exact_range=True
        )
        normalized = normalize_lab_presentation_result(result, camera)
    except (ProbeDataError, FrigateProbeError) as err:
        connection.send_error(msg["id"], "frigate_max_lab_presentation_unavailable", str(err))
        return
    connection.send_result(msg["id"], normalized)
