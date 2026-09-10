"""Minimal authenticated Frigate client for FrigateMax Prototype 0."""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import quote

import aiohttp

from .probe import (
    ProbeDataError,
    candidate_probe_windows,
    derive_timing_result,
    mapping_clips,
    normalize_review_events,
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
