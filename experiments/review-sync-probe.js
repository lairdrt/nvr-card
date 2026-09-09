/*
 * Temporary Review Prototype #1A.
 *
 * This disposable custom card tests two independent Frigate historical HLS
 * players through Home Assistant's authenticated VOD proxy. The production
 * NVR Card and its Live implementation are untouched. No synchronization
 * correction is intentionally performed after the coordinated initial seek.
 * hls.js 1.7.2 is vendored under experiments/vendor under Apache-2.0.
 */

const RANGE_PADDING_BEFORE_SECONDS = 15;
const RANGE_DURATION_SECONDS = 120;
const SIGNED_PATH_EXPIRES_SECONDS = 900;
const DIAGNOSTIC_SAMPLE_DELAYS = [10, 60];
const HLS_SCRIPT_PROMISE = Symbol("review-sync-hls-script");

export function parseReviewTarget(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("target must be an ISO timestamp or epoch seconds.");
  }
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid target timestamp: ${trimmed}`);
  }
  return parsed / 1000;
}

export function buildReviewRange(targetEpoch) {
  if (!Number.isFinite(targetEpoch)) {
    throw new Error("targetEpoch must be finite.");
  }
  return Object.freeze({
    targetEpoch,
    rangeStart: targetEpoch - RANGE_PADDING_BEFORE_SECONDS,
    rangeEnd: targetEpoch + RANGE_DURATION_SECONDS,
    seekPosition: RANGE_PADDING_BEFORE_SECONDS
  });
}

export function formatEpoch(epoch) {
  if (!Number.isFinite(epoch)) return "—";
  return new Date(epoch * 1000).toISOString();
}

export function sanitizeReviewError(error) {
  const name =
    error && typeof error.name === "string" && error.name.trim()
      ? error.name.trim()
      : "Error";
  const message =
    error && typeof error.message === "string" ? error.message.trim() : "";
  const details = `${name}${message ? `: ${message}` : ""}`;
  if (
    /authSig\s*=|\/api\/frigate(?:\/|\?|$)|https?:\/\//i.test(details)
  ) {
    return `${name}: [details redacted]`;
  }
  return details.slice(0, 240);
}

const BaseElement =
  typeof HTMLElement === "undefined" ? class {} : HTMLElement;

function getHassPath(path, clientId) {
  if (clientId) {
    return `/api/frigate/${encodeURIComponent(clientId)}${path}`;
  }
  return `/api/frigate${path}`;
}

function getManifestPath(camera, range, clientId) {
  return getHassPath(
    `/vod/${encodeURIComponent(camera)}/start/${range.rangeStart}/end/${range.rangeEnd}/index.m3u8`,
    clientId
  );
}

function waitForSeekable(video, timeoutMs = 15000) {
  if (video.seekable.length > 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      ["loadedmetadata", "progress", "canplay", "durationchange"].forEach(
        event => video.removeEventListener(event, check)
      );
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (video.seekable.length > 0) finish();
    };
    const timeout = window.setTimeout(
      () => finish(new Error("No seekable HLS range became available.")),
      timeoutMs
    );
    ["loadedmetadata", "progress", "canplay", "durationchange"].forEach(
      event => video.addEventListener(event, check)
    );
    check();
  });
}

export function waitForSeeked(video, target, timeoutMs = 15000) {
  const isSatisfied = () =>
    Number.isFinite(video.currentTime) &&
    Math.abs(video.currentTime - target) <= 0.05 &&
    !video.seeking;
  if (isSatisfied()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      if (error) reject(error);
      else resolve();
    };
    const onSeeked = () => {
      if (isSatisfied()) finish();
    };
    const timeout = window.setTimeout(
      () => finish(new Error("Video seek did not complete.")),
      timeoutMs
    );
    video.addEventListener("seeked", onSeeked, { once: true });
    Promise.resolve().then(onSeeked);
  });
}

export function loadHlsScript() {
  if (globalThis.Hls) return Promise.resolve(globalThis.Hls);
  if (globalThis[HLS_SCRIPT_PROMISE]) return globalThis[HLS_SCRIPT_PROMISE];

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("./vendor/hls.min.js", import.meta.url).href;
    script.async = true;
    script.onload = () => {
      if (globalThis.Hls) resolve(globalThis.Hls);
      else reject(new Error("Vendored hls.js loaded without Hls global."));
    };
    script.onerror = () => reject(new Error("Unable to load vendored hls.js."));
    document.head.appendChild(script);
  });
  globalThis[HLS_SCRIPT_PROMISE] = promise;
  return promise;
}

export class ReviewSyncProbe extends BaseElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._run = null;
    this._sampleTimers = [];
  }

  setConfig(config) {
    if (!config || typeof config !== "object") {
      throw new Error("Review Sync Probe requires a configuration object.");
    }
    for (const field of ["camera_a", "camera_b", "target"]) {
      if (typeof config[field] !== "string" || config[field].trim() === "") {
        throw new Error(`Review Sync Probe requires ${field}.`);
      }
    }
    this._config = {
      cameraA: config.camera_a.trim(),
      cameraB: config.camera_b.trim(),
      target: config.target.trim(),
      clientId:
        typeof config.client_id === "string" && config.client_id.trim()
          ? config.client_id.trim()
          : ""
    };
    if (this.isConnected) this.render();
  }

  set hass(value) {
    this._hass = value;
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    this.render();
  }

  disconnectedCallback() {
    this.stopRun();
  }

  render() {
    this.stopRun();
    this.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = `
      :host { display:block; }
      .probe { padding:16px; color:var(--primary-text-color); }
      .title { font-size:1.2em; font-weight:600; margin-bottom:12px; }
      .players { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
      .player-title { margin-bottom:4px; font-weight:600; }
      video { display:block; width:100%; aspect-ratio:16/9; background:#000; }
      .controls { display:flex; flex-wrap:wrap; gap:8px; align-items:end; margin-top:12px; }
      label { display:flex; flex-direction:column; gap:4px; }
      input { min-width:260px; padding:6px; }
      button { padding:7px 12px; }
      .status { margin-top:12px; white-space:pre-wrap; font-family:monospace; font-size:.85em; }
      .error { color:var(--error-color,#db4437); }
      @media (max-width:700px) { .players { grid-template-columns:1fr; } input { min-width:0; width:100%; } }
    `;
    this.appendChild(style);

    const root = document.createElement("div");
    root.className = "probe";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Review Sync Probe";
    root.appendChild(title);

    const players = document.createElement("div");
    players.className = "players";
    this._players = [
      this.createPlayer(players, "A", this._config.cameraA),
      this.createPlayer(players, "B", this._config.cameraB)
    ];
    root.appendChild(players);

    const controls = document.createElement("div");
    controls.className = "controls";
    const label = document.createElement("label");
    label.textContent = "Target timestamp";
    this._targetInput = document.createElement("input");
    this._targetInput.type = "text";
    this._targetInput.value = this._config.target ?? "";
    this._targetInput.placeholder = "2026-09-08T14:00:00";
    label.appendChild(this._targetInput);
    controls.appendChild(label);
    this._loadButton = document.createElement("button");
    this._loadButton.type = "button";
    this._loadButton.textContent = "Load / Play";
    this._loadButton.addEventListener("click", () => void this.loadAndPlay());
    controls.appendChild(this._loadButton);
    const stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.textContent = "Stop";
    stopButton.addEventListener("click", () => this.stopRun());
    controls.appendChild(stopButton);
    root.appendChild(controls);

    this._status = document.createElement("div");
    this._status.className = "status";
    this._status.textContent = "Ready.";
    root.appendChild(this._status);
    this.appendChild(root);
  }

  createPlayer(parent, label, camera) {
    const wrapper = document.createElement("section");
    const heading = document.createElement("div");
    heading.className = "player-title";
    heading.textContent = `Camera ${label}: ${camera || "—"}`;
    wrapper.appendChild(heading);
    const video = document.createElement("video");
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    wrapper.appendChild(video);
    parent.appendChild(wrapper);
    return { label, camera, video, hls: null, events: [], lastEvent: "none" };
  }

  setStatus(message, error = false) {
    if (!this._status) return;
    this._status.className = error ? "status error" : "status";
    this._status.textContent = message;
  }

  addVideoDiagnostics(player) {
    const events = ["loadedmetadata", "playing", "waiting", "stalled", "error"];
    for (const event of events) {
      const handler = () => {
        player.lastEvent = event;
        this.updateDiagnostics();
      };
      player.video.addEventListener(event, handler);
      player.events.push([event, handler]);
    }
  }

  updateDiagnostics(extra = "") {
    if (!this._run || !this._status) return;
    const lines = [
      `target: ${formatEpoch(this._run.range.targetEpoch)}`,
      `range: ${formatEpoch(this._run.range.rangeStart)} -> ${formatEpoch(this._run.range.rangeEnd)}`
    ];
    for (const player of this._players) {
      const video = player.video;
      const seekable = video.seekable.length
        ? `${video.seekable.start(0).toFixed(3)}..${video.seekable.end(video.seekable.length - 1).toFixed(3)}`
        : "none";
      lines.push(
        `${player.label}: readyState=${video.readyState} seekable=${seekable} ` +
          `requested=${this._run.range.seekPosition.toFixed(3)} ` +
          `current=${Number.isFinite(video.currentTime) ? video.currentTime.toFixed(3) : "—"} ` +
          `estimate=${formatEpoch(this._run.range.rangeStart + video.currentTime)} ` +
          `state=${video.paused ? "paused" : "playing"}${video.seeking ? ",seeking" : ""} ` +
          `event=${player.lastEvent}`
      );
    }
    const delta = this._players[0].video.currentTime - this._players[1].video.currentTime;
    lines.push(`A/B currentTime delta: ${Number.isFinite(delta) ? delta.toFixed(3) : "—"} seconds`);
    if (extra) lines.push(extra);
    this._status.textContent = lines.join("\n");
  }

  async signManifest(path) {
    if (!this._hass || typeof this._hass.callWS !== "function") {
      throw new Error("Home Assistant WebSocket API is unavailable.");
    }
    const result = await this._hass.callWS({
      type: "auth/sign_path",
      path,
      expires: SIGNED_PATH_EXPIRES_SECONDS
    });
    if (!result?.path) throw new Error("Home Assistant did not sign the VOD path.");
    return result.path;
  }

  async preparePlayer(player, range, Hls) {
    const manifestPath = getManifestPath(player.camera, range, this._config.clientId);
    const signedPath = await this.signManifest(manifestPath);
    const hls = new Hls({
      enableWorker: true,
      maxBufferLength: 20
    });
    player.hls = hls;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal && this._run) {
        this.setStatus(`${player.label} HLS failure: ${data.type || "unknown error"}`, true);
      }
    });
    const manifestReady = new Promise((resolve, reject) => {
      const onManifest = () => {
        hls.off(Hls.Events.MANIFEST_PARSED, onManifest);
        resolve();
      };
      hls.on(Hls.Events.MANIFEST_PARSED, onManifest);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal) reject(new Error(`${player.label} manifest failed.`));
      });
    });
    hls.attachMedia(player.video);
    hls.loadSource(signedPath);
    await manifestReady;
    await waitForSeekable(player.video);
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
      const Hls = await loadHlsScript();
      if (!Hls.isSupported()) throw new Error("This browser does not support hls.js.");
      this.setStatus("Loading both historical manifests...");
      this._players.forEach(player => this.addVideoDiagnostics(player));
      await Promise.all(this._players.map(player => this.preparePlayer(player, range, Hls)));
      const seekWaits = this._players.map(player =>
        waitForSeeked(player.video, range.seekPosition)
      );
      for (const player of this._players) {
        player.video.currentTime = range.seekPosition;
      }
      await Promise.all(seekWaits);
      this.updateDiagnostics("Initial coordinated seek complete; no correction loop is active.");
      await Promise.all(this._players.map(player => player.video.play()));
      this._sampleTimers = DIAGNOSTIC_SAMPLE_DELAYS.map(delay =>
        window.setTimeout(() => this.updateDiagnostics(`Observed sample: ~${delay}s`), delay * 1000)
      );
      this._diagnosticTimer = window.setInterval(() => this.updateDiagnostics(), 500);
    } catch (error) {
      const safeError = sanitizeReviewError(error);
      console.error("[Review Sync Probe] playback failure", safeError);
      this.setStatus(safeError, true);
    }
  }

  stopRun() {
    for (const timer of this._sampleTimers ?? []) window.clearTimeout(timer);
    this._sampleTimers = [];
    if (this._diagnosticTimer) window.clearInterval(this._diagnosticTimer);
    this._diagnosticTimer = null;
    for (const player of this._players ?? []) {
      for (const [event, handler] of player.events ?? []) {
        player.video.removeEventListener(event, handler);
      }
      player.events = [];
      player.video.pause();
      player.video.removeAttribute("src");
      player.video.load();
      player.hls?.destroy();
      player.hls = null;
    }
    this._run = null;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("review-sync-probe")) {
  customElements.define("review-sync-probe", ReviewSyncProbe);
}
