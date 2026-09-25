"""Minimal authenticated Frigate client for FrigateMax Prototype 0."""

from __future__ import annotations

import asyncio
import time
from typing import Any
from urllib.parse import quote

import aiohttp

from .probe import (
    ProbeDataError,
    MAPPING_LOOKAROUND_SECONDS,
    MAX_PRESENTATION_QUERY_SECONDS,
    PRESENTATION_MAX_SECONDS,
    candidate_probe_windows,
    build_piecewise_time_map,
    build_presentation_window,
    derive_timing_result,
    find_coverage_run,
    lab_recording_preflight,
    mapping_clips,
    normalize_review_events,
    normalize_recording_availability,
)


class FrigateProbeError(RuntimeError):
    """A safe error that contains no URL, response body, path, or credential."""


class FrigateProbeClient:
    """Perform only the Frigate requests needed by Prototype 0."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        base_url: str,
        username: str,
        password: str,
        verify_ssl: bool,
    ) -> None:
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._username = username
        self._password = password
        self._verify_ssl = verify_ssl
        self._cookie_header: str | None = None
        self._login_lock = asyncio.Lock()
        self._timeout = aiohttp.ClientTimeout(total=20)

    async def _login(self, *, force: bool = False) -> None:
        async with self._login_lock:
            if self._cookie_header is not None and not force:
                return
            try:
                async with self._session.post(
                    f"{self._base_url}/api/login",
                    json={"user": self._username, "password": self._password},
                    ssl=self._verify_ssl,
                    timeout=self._timeout,
                ) as response:
                    if response.status != 200:
                        raise FrigateProbeError("Frigate authentication failed.")
                    cookies = [
                        f"{name}={morsel.value}"
                        for name, morsel in response.cookies.items()
                    ]
                    if not cookies:
                        raise FrigateProbeError(
                            "Frigate authentication returned no session cookie."
                        )
                    self._cookie_header = "; ".join(cookies)
            except (aiohttp.ClientError, TimeoutError) as err:
                raise FrigateProbeError("Unable to authenticate with Frigate.") from err

    async def _get_json(
        self, path: str, *, params: dict[str, str] | None = None, allow_404: bool = False
    ) -> Any | None:
        await self._login()
        for attempt in range(2):
            try:
                async with self._session.get(
                    f"{self._base_url}{path}",
                    params=params,
                    headers={"Cookie": self._cookie_header or ""},
                    ssl=self._verify_ssl,
                    timeout=self._timeout,
                ) as response:
                    if response.status == 401 and attempt == 0:
                        await self._login(force=True)
                        continue
                    if response.status == 404 and allow_404:
                        return None
                    if response.status < 200 or response.status >= 300:
                        raise FrigateProbeError(
                            f"Frigate request failed with HTTP {response.status}."
                        )
                    try:
                        return await response.json(content_type=None)
                    except (ValueError, aiohttp.ClientPayloadError) as err:
                        raise FrigateProbeError(
                            "Frigate returned malformed JSON."
                        ) from err
            except FrigateProbeError:
                raise
            except (aiohttp.ClientError, TimeoutError) as err:
                raise FrigateProbeError("Unable to query Frigate.") from err
        raise FrigateProbeError("Frigate authentication failed.")

    @staticmethod
    def _vod_path(camera: str, start: float, end: float) -> str:
        return (
            f"/api/vod/{quote(camera, safe='')}/start/{start:.3f}/end/{end:.3f}"
        )

    async def prepare_vod(
        self,
        camera: str,
        requested_start: float,
        requested_end: float,
        target: float,
    ) -> dict[str, Any]:
        """Prepare authoritative VOD timing without exposing Frigate internals."""
        encoded_camera = quote(camera, safe="")
        recordings = await self._get_json(
            f"/api/{encoded_camera}/recordings",
            params={"after": str(requested_start), "before": str(requested_end)},
        )
        full_mapping = await self._get_json(
            self._vod_path(camera, requested_start, requested_end)
        )
        # Validate the full response before issuing deterministic isolation probes.
        mapping_clips(full_mapping)

        for window in candidate_probe_windows(
            recordings, requested_start, requested_end
        ):
            isolated_mapping = await self._get_json(
                self._vod_path(
                    camera, window["probe_start"], window["probe_end"]
                ),
                allow_404=True,
            )
            if isolated_mapping is None:
                continue
            try:
                return derive_timing_result(
                    camera=camera,
                    requested_start=requested_start,
                    requested_end=requested_end,
                    target=target,
                    recording_start=window["recording_start"],
                    full_mapping=full_mapping,
                    isolated_mapping=isolated_mapping,
                )
            except ProbeDataError as err:
                raise FrigateProbeError(str(err)) from err

        raise FrigateProbeError(
            "No Frigate recording could be associated with the VOD mapping."
        )

    async def probe_vod_timing(
        self,
        camera: str,
        requested_start: float,
        requested_end: float,
        target: float,
    ) -> dict[str, Any]:
        """Retain the Prototype 0 command while Review migrates to the v1 API."""
        return await self.prepare_vod(camera, requested_start, requested_end, target)

    async def get_review_events(
        self, cameras: list[str], from_epoch: float, to_epoch: float
    ) -> list[dict[str, Any]]:
        """Return normalized Frigate events for the requested Review window."""
        events: list[dict[str, Any]] = []
        for camera in cameras:
            result = await self._get_json(
                "/api/events",
                params={
                    "camera": camera,
                    "after": str(from_epoch),
                    "before": str(to_epoch),
                    "limit": "1000",
                },
            )
            events.extend(normalize_review_events(result, camera))
        return events

    async def get_recording_availability(
        self, camera: str, requested_start: float, requested_end: float
    ) -> dict[str, Any]:
        """Return normalized recording coverage for one bounded interval."""
        encoded_camera = quote(camera, safe="")
        recordings = await self._get_json(
            f"/api/{encoded_camera}/recordings",
            params={
                "after": str(requested_start),
                "before": str(requested_end),
            },
        )
        return normalize_recording_availability(
            recordings, camera, requested_start, requested_end
        )

    async def prepare_presentation(
        self,
        camera: str,
        target: float,
        bounds_start: float,
        bounds_end: float,
        *,
        lab_exact_range: bool = False,
    ) -> dict[str, Any]:
        """Prepare one bounded, absolute-time presentation without exposing Frigate data."""
        query_start = bounds_start if lab_exact_range else max(bounds_start, target - PRESENTATION_MAX_SECONDS)
        query_end = bounds_end if lab_exact_range else min(bounds_end, target + PRESENTATION_MAX_SECONDS)
        if not lab_exact_range and query_end - query_start > MAX_PRESENTATION_QUERY_SECONDS:
            raise FrigateProbeError("Presentation query envelope is too large.")
        row_start = max(0.0, query_start - MAPPING_LOOKAROUND_SECONDS)
        row_end = query_end + MAPPING_LOOKAROUND_SECONDS if lab_exact_range else min(bounds_end, query_end + MAPPING_LOOKAROUND_SECONDS)
        encoded_camera = quote(camera, safe="")
        recordings = await self._get_json(
            f"/api/{encoded_camera}/recordings",
            params={"after": str(row_start), "before": str(row_end)},
        )
        try:
            coverage_run = find_coverage_run(recordings, target, query_start, query_end)
            preflight = lab_recording_preflight(
                recordings, camera, query_start, query_end, target
            ) if lab_exact_range else None
            window = ({
                "requested_start": query_start,
                "requested_end": query_end,
                "logical_start": query_start,
                "logical_end": query_end,
            } if lab_exact_range else build_presentation_window(
                target, coverage_run, bounds_start, bounds_end
            ))
        except ProbeDataError as err:
            raise FrigateProbeError(str(err)) from err

        requested_start = window["requested_start"]
        requested_end = window["requested_end"]
        mapping_started = time.perf_counter()
        full_mapping = await self._get_json(
            self._vod_path(camera, requested_start, requested_end)
        )
        mapping_latency_ms = (time.perf_counter() - mapping_started) * 1000
        try:
            clips = mapping_clips(full_mapping)
            mapped = build_piecewise_time_map(
                recordings,
                clips,
                window["logical_start"],
                window["logical_end"],
                target,
            )
        except ProbeDataError as err:
            raise FrigateProbeError(str(err)) from err

        result = {
            "schema": 2,
            "camera": camera,
            "selected_epoch": target,
            "resolved_selected_epoch": mapped["resolved_selected_epoch"],
            "requested_wall_start": requested_start,
            "requested_wall_end": requested_end,
            "effective_wall_start": mapped["effective_wall_start"],
            "logical_wall_start": window["logical_start"],
            "logical_wall_end": window["logical_end"],
            "effective_absolute_origin": mapped["effective_absolute_origin"],
            "media_start_position": mapped["media_start_position"],
            "selected_media_position": mapped["selected_media_position"],
            "logical_media_end_position": mapped["logical_media_end_position"],
            "coverage_run": {
                key: coverage_run[key]
                for key in (
                    "known_start", "known_end", "continues_before", "continues_after"
                )
            },
            "time_map": mapped["time_map"],
        }
        if lab_exact_range:
            result["candidate_recording_row_count"] = preflight["candidate_recording_row_count"]
            result["mapping_clip_count"] = len(clips)
            result["vod_mapping_latency_ms"] = mapping_latency_ms
        return result

    async def lab_preflight_vod(
        self, camera: str, start: float, end: float, target: float
    ) -> dict[str, Any]:
        """Temporary Lab measurement: rows and coverage before requesting a mapping."""
        encoded_camera = quote(camera, safe="")
        recordings = await self._get_json(
            f"/api/{encoded_camera}/recordings",
            params={
                "after": str(max(0.0, start - MAPPING_LOOKAROUND_SECONDS)),
                "before": str(end + MAPPING_LOOKAROUND_SECONDS),
            },
        )
        try:
            return lab_recording_preflight(recordings, camera, start, end, target)
        except ProbeDataError as err:
            raise FrigateProbeError(str(err)) from err
