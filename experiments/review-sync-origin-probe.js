/*
 * Temporary FrigateMax Prototype 0 frontend.
 *
 * This preserves Review Prototype #1A and changes only its initial per-camera
 * seek calculation. Historical media still uses the proven HA-signed Frigate
 * index.m3u8 path. No correction loop is active.
 */

import {
  ReviewSyncProbe,
  buildReviewRange,
  formatEpoch,
  loadHlsScript,
  parseReviewTarget,
  sanitizeReviewError,
  waitForSeeked
} from "./review-sync-probe.js?prototype=0";

const DIAGNOSTIC_SAMPLE_DELAYS = [10, 60];

export function calculateOriginSeek(targetEpoch, timing) {
  const origin = Number(timing?.effective_absolute_origin);
  if (!Number.isFinite(targetEpoch) || !Number.isFinite(origin)) {
    throw new Error("FrigateMax returned invalid VOD timing.");
  }
  const seek = targetEpoch - origin;
  if (!Number.isFinite(seek) || seek < 0) {
    throw new Error("FrigateMax returned an origin after the target.");
  }
  return seek;
}

export function sanitizeTimingResult(timing) {
  const safeFields = [
    "camera",
    "requested_start",
    "requested_end",
    "recording_start",
    "requested_clip_from_ms",
    "adjusted_clip_from_ms",
    "effective_absolute_origin",
    "calculated_target_seek"
  ];
  const safe = {};
  for (const field of safeFields) {
    if (Object.hasOwn(timing ?? {}, field)) safe[field] = timing[field];
  }
  return safe;
}

export class ReviewSyncOriginProbe extends ReviewSyncProbe {
  render() {
    super.render();
    const title = this.querySelector?.(".title");
    if (title) title.textContent = "Review Sync Origin Probe";
  }

  async requestTiming(player, range) {
    if (!this._hass || typeof this._hass.callWS !== "function") {
      throw new Error("Home Assistant WebSocket API is unavailable.");
    }
    const raw = await this._hass.callWS({
      type: "frigate_max/probe_vod_timing",
      camera: player.camera,
      requested_start: range.rangeStart,
      requested_end: range.rangeEnd,
      target: range.targetEpoch
    });
    const timing = sanitizeTimingResult(raw);
    if (timing.camera !== player.camera) {
      throw new Error("FrigateMax returned timing for the wrong camera.");
    }
    player.timing = timing;
    player.seekPosition = calculateOriginSeek(range.targetEpoch, timing);
    return timing;
  }

  updateDiagnostics(extra = "") {
    if (!this._run || !this._status) return;
    const lines = [
      `target: ${formatEpoch(this._run.range.targetEpoch)}`,
      `range: ${formatEpoch(this._run.range.rangeStart)} -> ${formatEpoch(this._run.range.rangeEnd)}`
    ];
    for (const player of this._players) {
      const video = player.video;
      const timing = player.timing;
      const seekable = video.seekable.length
        ? `${video.seekable.start(0).toFixed(3)}..${video.seekable.end(video.seekable.length - 1).toFixed(3)}`
        : "none";
      const estimatedEpoch = timing
        ? timing.effective_absolute_origin + video.currentTime
        : NaN;
      lines.push(
        `${player.label}/${player.camera}: origin=${formatEpoch(timing?.effective_absolute_origin)} ` +
          `requestedClip=${timing?.requested_clip_from_ms ?? "—"}ms ` +
          `adjustedClip=${timing?.adjusted_clip_from_ms ?? "—"}ms ` +
          `seek=${Number.isFinite(player.seekPosition) ? player.seekPosition.toFixed(3) : "—"} ` +
          `current=${Number.isFinite(video.currentTime) ? video.currentTime.toFixed(3) : "—"} ` +
          `estimate=${formatEpoch(estimatedEpoch)} seekable=${seekable} ` +
          `state=${video.paused ? "paused" : "playing"}${video.seeking ? ",seeking" : ""} ` +
          `event=${player.lastEvent}`
      );
    }
    const estimatedA =
      this._players[0].timing?.effective_absolute_origin +
      this._players[0].video.currentTime;
    const estimatedB =
      this._players[1].timing?.effective_absolute_origin +
      this._players[1].video.currentTime;
    const delta = estimatedA - estimatedB;
    lines.push(
      `A/B estimated absolute delta: ${Number.isFinite(delta) ? delta.toFixed(3) : "—"} seconds`
    );
    if (extra) lines.push(extra);
    this._status.textContent = lines.join("\n");
  }

  async loadAndPlay() {
    if (!this._players || !this._config.cameraA) {
      this.setStatus("Set camera_a, camera_b, and target in the card configuration.", true);
      return;
    }
    this.stopRun();
    try {
      const range = buildReviewRange(parseReviewTarget(this._targetInput.value));
      this._run = { range };
      this.setStatus("Requesting authoritative VOD timing...");
      await Promise.all(this._players.map(player => this.requestTiming(player, range)));

      const Hls = await loadHlsScript();
      if (!Hls.isSupported()) throw new Error("This browser does not support hls.js.");
      this.setStatus("Loading both historical manifests...");
      this._players.forEach(player => this.addVideoDiagnostics(player));
      await Promise.all(this._players.map(player => this.preparePlayer(player, range, Hls)));

      const seekWaits = this._players.map(player =>
        waitForSeeked(player.video, player.seekPosition)
      );
      for (const player of this._players) {
        player.video.currentTime = player.seekPosition;
      }
      await Promise.all(seekWaits);
      this.updateDiagnostics(
        "Origin-adjusted coordinated seek complete; no correction loop is active."
      );
      await Promise.all(this._players.map(player => player.video.play()));
      this._sampleTimers = DIAGNOSTIC_SAMPLE_DELAYS.map(delay =>
        window.setTimeout(
          () => this.updateDiagnostics(`Observed sample: ~${delay}s`),
          delay * 1000
        )
      );
      this._diagnosticTimer = window.setInterval(() => this.updateDiagnostics(), 500);
    } catch (error) {
      const safeError = sanitizeReviewError(error);
      console.error("[Review Sync Origin Probe] playback failure", safeError);
      this.setStatus(safeError, true);
    }
  }
}

if (
  typeof customElements !== "undefined" &&
  !customElements.get("review-sync-origin-probe")
) {
  customElements.define("review-sync-origin-probe", ReviewSyncOriginProbe);
}
