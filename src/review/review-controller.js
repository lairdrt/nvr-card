const REVIEW_RANGE_BEFORE_SECONDS = 15;
const REVIEW_RANGE_AFTER_SECONDS = 120;
const REVIEW_SIGNED_PATH_EXPIRES_SECONDS = 900;
const REVIEW_HLS_SCRIPT_PATH = "/local/nvr-card/src/vendor/hls.min.js";
const REVIEW_HLS_PROMISE = Symbol.for("nvr.review.hlsScript");

export class ReviewClock {
  constructor(now = () => performance.now()) {
    this._now = now;
    this._absolute = null;
    this._startedAt = null;
  }

  setAbsolute(epochSeconds) {
    const value = Number(epochSeconds);
    if (!Number.isFinite(value)) {
      throw new Error("ReviewClock requires a finite absolute timestamp.");
    }
    this._absolute = value;
    this._startedAt = null;
  }

  start() {
    if (!Number.isFinite(this._absolute)) {
      throw new Error("ReviewClock has no absolute timestamp.");
    }
    if (this._startedAt === null) this._startedAt = this._now();
  }

  pause() {
    if (this._startedAt !== null) {
      this._absolute = this.absoluteTime;
      this._startedAt = null;
    }
  }

  reset() {
    this._absolute = null;
    this._startedAt = null;
  }

  get running() {
    return this._startedAt !== null;
  }

  get absoluteTime() {
    if (!Number.isFinite(this._absolute)) return null;
    return this._startedAt === null
      ? this._absolute
      : this._absolute + (this._now() - this._startedAt) / 1000;
  }
}

export function parseReviewTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Enter an ISO timestamp or epoch seconds.");
  }
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) throw new Error("Invalid historical timestamp.");
  return parsed / 1000;
}

export function buildReviewRange(targetEpoch) {
  if (!Number.isFinite(targetEpoch)) {
    throw new Error("Historical target must be finite.");
  }
  return Object.freeze({
    targetEpoch,
    start: targetEpoch - REVIEW_RANGE_BEFORE_SECONDS,
    end: targetEpoch + REVIEW_RANGE_AFTER_SECONDS
  });
}

export function calculateHistoricalSeek(targetEpoch, timing) {
  const origin = Number(timing?.effective_absolute_origin);
  const seek = targetEpoch - origin;
  if (!Number.isFinite(origin) || !Number.isFinite(seek) || seek < 0) {
    throw new Error("FrigateMax returned invalid VOD timing.");
  }
  return seek;
}

export function normalizePreparedTiming(value, expectedCamera) {
  const fields = [
    "camera",
    "requested_start",
    "requested_end",
    "recording_start",
    "requested_clip_from_ms",
    "adjusted_clip_from_ms",
    "effective_absolute_origin",
    "calculated_target_seek"
  ];
  if (!value || typeof value !== "object" || value.camera !== expectedCamera) {
    throw new Error("FrigateMax returned timing for the wrong camera.");
  }
  const normalized = {};
  for (const field of fields) {
    if (Object.hasOwn(value, field)) normalized[field] = value[field];
  }
  for (const field of fields.slice(1)) {
    if (!Number.isFinite(Number(normalized[field]))) {
      throw new Error("FrigateMax returned incomplete VOD timing.");
    }
    normalized[field] = Number(normalized[field]);
  }
  return normalized;
}

export function sanitizeReviewError(error) {
  const message = typeof error?.message === "string"
    ? error.message.trim()
    : "Historical playback failed.";
  if (/authSig\s*=|https?:\/\/|rtsp:\/\/|\/media\//i.test(message)) {
    return "Historical playback failed; details were redacted.";
  }
  return message.slice(0, 180);
}

export function loadReviewHls() {
  if (globalThis.Hls) return Promise.resolve(globalThis.Hls);
  if (globalThis[REVIEW_HLS_PROMISE]) return globalThis[REVIEW_HLS_PROMISE];
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = REVIEW_HLS_SCRIPT_PATH;
    script.async = true;
    script.onload = () => globalThis.Hls
      ? resolve(globalThis.Hls)
      : reject(new Error("Vendored hls.js did not initialize."));
    script.onerror = () => reject(new Error("Unable to load vendored hls.js."));
    document.head.appendChild(script);
  });
  globalThis[REVIEW_HLS_PROMISE] = promise;
  return promise;
}

function waitForMediaEvent(
  video,
  eventName,
  satisfied,
  timeoutMs = 15000,
  cancellations = null
) {
  if (satisfied()) return Promise.resolve();
  const view = video.ownerDocument?.defaultView ?? globalThis;
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancel = null;
    const finish = error => {
      if (settled) return;
      settled = true;
      view.clearTimeout(timeout);
      video.removeEventListener(eventName, onEvent);
      if (cancel && cancellations) {
        const index = cancellations.indexOf(cancel);
        if (index >= 0) cancellations.splice(index, 1);
      }
      if (error) reject(error);
      else resolve();
    };
    const onEvent = () => {
      if (satisfied()) finish();
    };
    const timeout = view.setTimeout(
      () => finish(new Error("Historical media readiness timed out.")),
      timeoutMs
    );
    video.addEventListener(eventName, onEvent);
    cancel = () => finish(new Error("Historical media preparation was cancelled."));
    cancellations?.push(cancel);
    Promise.resolve().then(onEvent);
  });
}

function getManifestPath(camera, range) {
  return `/api/frigate/vod/${encodeURIComponent(camera)}` +
    `/start/${range.start}/end/${range.end}/index.m3u8`;
}

export class ReviewController {
  constructor({
    documentRef = globalThis.document,
    loadHls = loadReviewHls,
    now = () => performance.now()
  } = {}) {
    this._document = documentRef;
    this._loadHls = loadHls;
    this._root = null;
    this._hass = null;
    this._cameras = [];
    this._selectedCameraNames = [];
    this._primaryCameraName = null;
    this._active = false;
    this._suspended = false;
    this._presentationMode = "live";
    this._targetText = "";
    this._generation = 0;
    this._historicalPlayers = new Map();
    this._diagnosticTimer = null;
    this.clock = new ReviewClock(now);
  }

  get state() {
    return {
      active: this._active,
      presentationMode: this._presentationMode,
      selectedCameraNames: [...this._selectedCameraNames],
      primaryCameraName: this._primaryCameraName,
      reviewClockAbsolute: this.clock.absoluteTime
    };
  }

  configure(cameras) {
    this._cameras = Array.isArray(cameras)
      ? cameras.filter(camera => camera?.active === true)
      : [];
    const enabledNames = this._cameras.map(camera => camera.name);
    const retained = this._selectedCameraNames.filter(name => enabledNames.includes(name));
    this._selectedCameraNames = retained.length > 0
      ? enabledNames.filter(name => retained.includes(name))
      : enabledNames.slice(0, 2);
    if (!this._selectedCameraNames.includes(this._primaryCameraName)) {
      this._primaryCameraName = this._selectedCameraNames[0] ?? null;
    }
    if (this._active && !this._suspended) {
      this.returnToLive();
    }
  }

  setHass(hass) {
    this._hass = hass;
    this._root?.querySelectorAll("hui-image.review-live-camera").forEach(image => {
      image.hass = hass;
    });
  }

  mount(root) {
    if (this._root === root) return;
    this.cleanupHistorical();
    this._root = root;
    if (this._root) this._root.hidden = !this._active;
    if (this._active && !this._suspended) this.render();
  }

  unmount() {
    this.cleanupHistorical();
    if (this._root) this._root.replaceChildren();
    this._root = null;
  }

  activate() {
    this._active = true;
    this._suspended = false;
    this._presentationMode = "live";
    this.clock.reset();
    if (this._root) {
      this._root.hidden = false;
      this.render();
    }
  }

  deactivate() {
    this._active = false;
    this._presentationMode = "live";
    this.cleanupHistorical();
    this.clock.reset();
    if (this._root) {
      this._root.replaceChildren();
      this._root.hidden = true;
    }
  }

  suspend() {
    this._suspended = true;
    this.cleanupHistorical();
    if (this._root) this._root.replaceChildren();
  }

  resume() {
    this._suspended = false;
    if (this._active) {
      this._presentationMode = "live";
      this.render();
    }
  }

  setSelectedCameraNames(names) {
    const requested = new Set(Array.isArray(names) ? names : []);
    const ordered = this._cameras
      .map(camera => camera.name)
      .filter(name => requested.has(name));
    if (ordered.length === 0) return false;
    this._selectedCameraNames = ordered;
    if (!ordered.includes(this._primaryCameraName)) {
      this._primaryCameraName = ordered[0];
    }
    if (this._active) this.returnToLive();
    return true;
  }

  setPrimaryCamera(name) {
    if (!this._selectedCameraNames.includes(name)) return false;
    this._primaryCameraName = name;
    if (this._active) this.render();
    return true;
  }

  returnToLive() {
    this._generation += 1;
    this.cleanupHistorical();
    this.clock.reset();
    this._presentationMode = "live";
    if (this._active && !this._suspended) this.render();
  }

  getSelectedCameras() {
    const selected = new Set(this._selectedCameraNames);
    return this._cameras.filter(camera => selected.has(camera.name));
  }

  getOrderedCameras() {
    const selected = this.getSelectedCameras();
    const primary = selected.find(camera => camera.name === this._primaryCameraName);
    return primary
      ? [primary, ...selected.filter(camera => camera !== primary)]
      : selected;
  }

  getFrigateCameraId(camera) {
    const value = this._hass?.states?.[camera.entity]?.attributes?.camera_name;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  createLiveImage(camera) {
    const image = this._document.createElement("hui-image");
    image.className = "review-live-camera";
    image.dataset.entity = camera.entity;
    image.cameraImage = camera.live?.substream ?? camera.entity;
    image.cameraView = "live";
    image.hass = this._hass;
    return image;
  }

  createCameraPanel(camera, primary) {
    const panel = this._document.createElement("section");
    panel.className = `review-camera-panel${primary ? " primary" : " secondary"}`;
    panel.dataset.camera = camera.name;
    const heading = this._document.createElement("div");
    heading.className = "review-camera-heading";
    heading.textContent = camera.name;
    panel.appendChild(heading);
    const media = this._document.createElement("div");
    media.className = "review-camera-media";
    if (this._presentationMode === "live") {
      media.appendChild(this.createLiveImage(camera));
    } else {
      const player = this._historicalPlayers.get(camera.name);
      const video = this._document.createElement("video");
      video.className = "review-historical-video";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.controls = true;
      if (player) player.video = video;
      media.appendChild(video);
      const status = this._document.createElement("div");
      status.className = "review-camera-status";
      status.textContent = player?.message ?? "Preparing recording...";
      if (player) player.statusElement = status;
      media.appendChild(status);
    }
    panel.appendChild(media);
    return panel;
  }

  render() {
    if (!this._root || !this._active || this._suspended) return;
    this._root.replaceChildren();
    const toolbar = this._document.createElement("div");
    toolbar.className = "review-toolbar";

    const selection = this._document.createElement("div");
    selection.className = "review-selection";
    for (const camera of this._cameras) {
      const label = this._document.createElement("label");
      const checkbox = this._document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this._selectedCameraNames.includes(camera.name);
      checkbox.addEventListener("change", () => {
        const next = new Set(this._selectedCameraNames);
        if (checkbox.checked) next.add(camera.name);
        else next.delete(camera.name);
        if (!this.setSelectedCameraNames([...next])) checkbox.checked = true;
      });
      label.append(checkbox, ` ${camera.name}`);
      selection.appendChild(label);
    }
    toolbar.appendChild(selection);

    const primaryLabel = this._document.createElement("label");
    primaryLabel.textContent = "Primary ";
    const primarySelect = this._document.createElement("select");
    for (const name of this._selectedCameraNames) {
      const option = this._document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.selected = name === this._primaryCameraName;
      primarySelect.appendChild(option);
    }
    primarySelect.addEventListener("change", () => this.setPrimaryCamera(primarySelect.value));
    primaryLabel.appendChild(primarySelect);
    toolbar.appendChild(primaryLabel);

    const target = this._document.createElement("input");
    target.className = "review-target";
    target.type = "text";
    target.placeholder = "2026-09-08T14:00:00-07:00";
    target.value = this._targetText;
    target.addEventListener("input", () => { this._targetText = target.value; });
    toolbar.appendChild(target);

    const historical = this._document.createElement("button");
    historical.type = "button";
    historical.className = "review-load-historical";
    historical.textContent = "Play Historical";
    historical.addEventListener("click", () => void this.playHistorical(target.value));
    toolbar.appendChild(historical);

    const live = this._document.createElement("button");
    live.type = "button";
    live.className = "review-return-live";
    live.textContent = "Return to Live";
    live.disabled = this._presentationMode === "live";
    live.addEventListener("click", () => this.returnToLive());
    toolbar.appendChild(live);
    this._root.appendChild(toolbar);

    const status = this._document.createElement("div");
    status.className = "review-status";
    status.setAttribute("role", "status");
    status.textContent = this._presentationMode === "live"
      ? "Review live: Home Assistant / ONVIF"
      : "Preparing synchronized historical playback...";
    this._statusElement = status;
    this._root.appendChild(status);

    const ordered = this.getOrderedCameras();
    const primary = ordered[0];
    if (!primary) {
      status.textContent = "No enabled Review cameras are available.";
      return;
    }
    const stage = this._document.createElement("div");
    stage.className = "review-primary";
    stage.appendChild(this.createCameraPanel(primary, true));
    this._root.appendChild(stage);
    const strip = this._document.createElement("div");
    strip.className = "review-secondary-strip";
    for (const camera of ordered.slice(1)) {
      strip.appendChild(this.createCameraPanel(camera, false));
    }
    this._root.appendChild(strip);
  }

  setPlayerStatus(player, message, unavailable = false) {
    player.message = message;
    player.unavailable = unavailable;
    if (player.statusElement) {
      player.statusElement.textContent = message;
      player.statusElement.classList.toggle("unavailable", unavailable);
    }
  }

  async requestPreparedTiming(player, range) {
    if (!this._hass || typeof this._hass.callWS !== "function") {
      throw new Error("Home Assistant WebSocket API is unavailable.");
    }
    const result = await this._hass.callWS({
      type: "frigate_max/v1/vod/prepare",
      camera: player.frigateCamera,
      requested_start: range.start,
      requested_end: range.end,
      target: range.targetEpoch
    });
    return normalizePreparedTiming(result, player.frigateCamera);
  }

  async signManifest(player, range) {
    const result = await this._hass.callWS({
      type: "auth/sign_path",
      path: getManifestPath(player.frigateCamera, range),
      expires: REVIEW_SIGNED_PATH_EXPIRES_SECONDS
    });
    if (typeof result?.path !== "string" || !result.path.startsWith("/")) {
      throw new Error("Home Assistant did not sign the historical media path.");
    }
    return result.path;
  }

  assertCurrentGeneration(generation) {
    if (generation !== this._generation || !this._active || this._suspended) {
      throw new Error("Historical preparation was cancelled.");
    }
  }

  async attachHistoricalPlayer(player, range, Hls, generation) {
    player.timing = await this.requestPreparedTiming(player, range);
    this.assertCurrentGeneration(generation);
    player.seek = calculateHistoricalSeek(range.targetEpoch, player.timing);
    const signedPath = await this.signManifest(player, range);
    this.assertCurrentGeneration(generation);
    const hls = new Hls({ enableWorker: true, maxBufferLength: 20 });
    player.hls = hls;
    const manifestReady = new Promise((resolve, reject) => {
      let settled = false;
      let cancel = null;
      const finish = error => {
        if (settled) return;
        settled = true;
        hls.off(Hls.Events.MANIFEST_PARSED, onManifest);
        hls.off(Hls.Events.ERROR, onError);
        const index = player.waitCancellations.indexOf(cancel);
        if (index >= 0) player.waitCancellations.splice(index, 1);
        if (error) reject(error);
        else resolve();
      };
      const onManifest = () => {
        finish();
      };
      const onError = (_event, data) => {
        if (data?.fatal) finish(new Error("Historical manifest failed."));
      };
      cancel = () => finish(new Error("Historical manifest preparation was cancelled."));
      hls.on(Hls.Events.MANIFEST_PARSED, onManifest);
      hls.on(Hls.Events.ERROR, onError);
      player.hlsListeners.push([Hls.Events.MANIFEST_PARSED, onManifest]);
      player.hlsListeners.push([Hls.Events.ERROR, onError]);
      player.waitCancellations.push(cancel);
    });
    hls.attachMedia(player.video);
    hls.loadSource(signedPath);
    await manifestReady;
    this.assertCurrentGeneration(generation);
    await waitForMediaEvent(
      player.video,
      "progress",
      () => player.video.seekable?.length > 0,
      15000,
      player.waitCancellations
    );
    this.assertCurrentGeneration(generation);
    this.setPlayerStatus(player, `Ready; seek ${player.seek.toFixed(3)} s`);
  }

  async seekHistoricalPlayer(player) {
    const wait = waitForMediaEvent(
      player.video,
      "seeked",
      () => Number.isFinite(player.video.currentTime) &&
        Math.abs(player.video.currentTime - player.seek) <= 0.05 &&
        !player.video.seeking,
      15000,
      player.waitCancellations
    );
    player.video.currentTime = player.seek;
    await wait;
  }

  async playHistorical(value) {
    const generation = ++this._generation;
    this.cleanupHistorical();
    try {
      const targetEpoch = parseReviewTimestamp(value);
      this._targetText = typeof value === "string" ? value : String(value);
      const range = buildReviewRange(targetEpoch);
      this.clock.setAbsolute(targetEpoch);
      for (const camera of this.getOrderedCameras()) {
        this._historicalPlayers.set(camera.name, {
          camera,
          frigateCamera: this.getFrigateCameraId(camera),
          video: null,
          hls: null,
          hlsListeners: [],
          waitCancellations: [],
          statusElement: null,
          message: "Preparing recording...",
          unavailable: false
        });
      }
      this._presentationMode = "historical";
      this.render();
      const players = [...this._historicalPlayers.values()];
      for (const player of players) {
        if (!player.frigateCamera) {
          this.setPlayerStatus(player, "Unavailable: no Frigate camera identity.", true);
        }
      }
      const candidates = players.filter(player => !player.unavailable);
      const Hls = candidates.length > 0 ? await this._loadHls() : null;
      if (Hls && !Hls.isSupported()) {
        throw new Error("This browser does not support historical HLS playback.");
      }
      await Promise.all(candidates.map(async player => {
        try {
          await this.attachHistoricalPlayer(player, range, Hls, generation);
          this.assertCurrentGeneration(generation);
        } catch (error) {
          this.cleanupHistoricalPlayer(player);
          this.setPlayerStatus(
            player,
            `Unavailable: ${sanitizeReviewError(error)}`,
            true
          );
        }
      }));
      if (generation !== this._generation || !this._active) return;
      const ready = players.filter(player => !player.unavailable && player.hls);
      await Promise.all(ready.map(async player => {
        try {
          await this.seekHistoricalPlayer(player);
        } catch (error) {
          this.cleanupHistoricalPlayer(player);
          this.setPlayerStatus(
            player,
            `Unavailable: ${sanitizeReviewError(error)}`,
            true
          );
        }
      }));
      const playable = ready.filter(player => !player.unavailable && player.hls);
      if (generation !== this._generation || !this._active) return;
      const starts = playable.map(player => Promise.resolve(player.video.play()));
      if (starts.length > 0) this.clock.start();
      const startResults = await Promise.allSettled(starts);
      startResults.forEach((result, index) => {
        if (result.status === "rejected") {
          this.setPlayerStatus(playable[index], "Unavailable: playback was blocked.", true);
        }
      });
      if (playable.every(player => player.unavailable)) this.clock.pause();
      this.updateDiagnostics();
      const view = this._root?.ownerDocument?.defaultView ?? globalThis;
      this._diagnosticTimer = view.setInterval(() => this.updateDiagnostics(), 500);
    } catch (error) {
      if (generation !== this._generation) return;
      this.clock.pause();
      if (this._statusElement) {
        this._statusElement.textContent = sanitizeReviewError(error);
        this._statusElement.classList.add("error");
      }
    }
  }

  updateDiagnostics() {
    if (!this._statusElement || this._presentationMode !== "historical") return;
    const clock = this.clock.absoluteTime;
    const lines = [
      `ReviewClock: ${Number.isFinite(clock) ? new Date(clock * 1000).toISOString() : "stopped"}`,
      "Initial coordinated seek only; no correction loop."
    ];
    const estimates = [];
    for (const player of this._historicalPlayers.values()) {
      if (player.unavailable || !player.timing || !player.video) {
        lines.push(`${player.camera.name}: unavailable`);
        continue;
      }
      const estimate = player.timing.effective_absolute_origin + player.video.currentTime;
      estimates.push({ name: player.camera.name, absolute: estimate });
      const delta = Number.isFinite(clock) ? estimate - clock : NaN;
      lines.push(
        `${player.camera.name}: seek=${player.seek.toFixed(3)} s; ` +
        `clock delta=${Number.isFinite(delta) ? delta.toFixed(3) : "--"} s`
      );
    }
    if (estimates.length >= 2) {
      lines.push(
        `${estimates[0].name}/${estimates[1].name} absolute delta=` +
        `${Math.abs(estimates[0].absolute - estimates[1].absolute).toFixed(3)} s`
      );
    }
    this._statusElement.textContent = lines.join("\n");
  }

  cleanupHistoricalPlayer(player) {
    if (!player) return;
    for (const cancel of [...(player.waitCancellations ?? [])]) cancel();
    player.waitCancellations = [];
    for (const [event, handler] of player.hlsListeners ?? []) {
      player.hls?.off?.(event, handler);
    }
    player.hlsListeners = [];
    try { player.video?.pause(); } catch {}
    try {
      player.video?.removeAttribute("src");
      player.video?.load();
    } catch {}
    player.hls?.destroy?.();
    player.hls = null;
  }

  cleanupHistorical() {
    if (this._diagnosticTimer !== null) {
      const view = this._root?.ownerDocument?.defaultView ?? globalThis;
      view.clearInterval(this._diagnosticTimer);
      this._diagnosticTimer = null;
    }
    this.clock.pause();
    for (const player of this._historicalPlayers.values()) {
      this.cleanupHistoricalPlayer(player);
    }
    this._historicalPlayers.clear();
  }
}
