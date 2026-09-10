import "../vendor/flatpickr/flatpickr-4.6.13.min.js";

const REVIEW_RANGE_BEFORE_SECONDS = 15;
const REVIEW_RANGE_AFTER_SECONDS = 120;
const REVIEW_SIGNED_PATH_EXPIRES_SECONDS = 900;
const REVIEW_HLS_SCRIPT_PATH = "/local/nvr-card/src/vendor/hls.min.js";
const REVIEW_HLS_PROMISE = Symbol.for("nvr.review.hlsScript");
const REVIEW_KNOWN_TARGET = "2026-09-08T14:00:00-07:00";
const REVIEW_MINI_SLOT_CAPACITY = 12;

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
  if (/authSig\s*=|https?:\/\/|rtsp:\/\/|\/media\/|[A-Z]:\\/i.test(message)) {
    return "Historical playback failed; details were redacted.";
  }
  return message.slice(0, 180);
}

function getDateParts(value, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(value).filter(part => part.type !== "literal")
    .map(part => [part.type, part.value]));
}

export function getCivilDayKey(epochMs, timeZone) {
  const parts = getDateParts(new Date(epochMs), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shiftCivilDayKey(dayKey, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) throw new Error("Invalid civil day.");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function civilMidnightEpoch(dayKey, timeZone) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const desired = Date.UTC(year, month - 1, day);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getDateParts(new Date(guess), timeZone);
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    guess += desired - observed;
    const hour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(guess)).find(part => part.type === "hour")?.value ?? 0);
    guess -= hour * 3600000;
  }
  return guess;
}

export function getCivilDayBounds(dayKey, timeZone) {
  const start = civilMidnightEpoch(dayKey, timeZone);
  const end = civilMidnightEpoch(shiftCivilDayKey(dayKey, 1), timeZone);
  return Object.freeze({ start, end, durationHours: (end - start) / 3600000 });
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
    now = () => performance.now(),
    datePickerFactory = globalThis.flatpickr
  } = {}) {
    this._document = documentRef;
    this._loadHls = loadHls;
    this._datePickerFactory = datePickerFactory;
    this._datePicker = null;
    this._root = null;
    this._transportRoot = null;
    this._hass = null;
    this._cameras = [];
    this._selectedCameraNames = [];
    this._primaryCameraName = null;
    this._selectionInitialized = false;
    this._active = false;
    this._suspended = false;
    this._presentationMode = "live";
    this._generation = 0;
    this._historicalPlayers = new Map();
    this._historicalRange = null;
    this._historicalPreparing = false;
    this._mediaPanels = new Map();
    this._diagnosticTimer = null;
    this._debugEnabled = false;
    this._rhsMode = "timeline";
    this._selectedFilters = new Set();
    this._sectionExpanded = { cameras: false, when: false, filters: false, diagnostics: false };
    this._selectedDay = null;
    this.clock = new ReviewClock(now);
  }

  get timeZone() {
    return this._hass?.config?.time_zone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  get todayKey() {
    return getCivilDayKey(Date.now(), this.timeZone);
  }

  get state() {
    return {
      active: this._active,
      presentationMode: this._presentationMode,
      selectedCameraNames: [...this._selectedCameraNames],
      primaryCameraName: this._primaryCameraName,
      reviewClockAbsolute: this.clock.absoluteTime,
      selectedDay: this._selectedDay,
      selectedFilters: [...this._selectedFilters],
      rhsMode: this._rhsMode
    };
  }

  configure(cameras) {
    this._cameras = Array.isArray(cameras)
      ? cameras.filter(camera => camera?.active === true)
      : [];
    const enabledNames = this._cameras.map(camera => camera.name);
    if (!this._selectionInitialized) {
      this._selectedCameraNames = enabledNames.slice(0, 2);
      this._selectionInitialized = true;
    } else {
      this._selectedCameraNames = enabledNames.filter(name =>
        this._selectedCameraNames.includes(name));
    }
    if (!this._selectedCameraNames.includes(this._primaryCameraName)) {
      this._primaryCameraName = this._selectedCameraNames[0] ?? null;
    }
    if (this._active && !this._suspended) {
      this.returnToLive();
    }
  }

  setDebug(enabled) {
    const next = enabled === true;
    if (next === this._debugEnabled) return;
    this._debugEnabled = next;
    if (this._active && !this._suspended) this.render();
  }

  setHass(hass) {
    this._hass = hass;
    if (!this._selectedDay) this._selectedDay = this.todayKey;
    this._root?.querySelectorAll("hui-image.review-live-camera").forEach(image => {
      image.hass = hass;
    });
    this.updateWhenControls();
    this.updateClockDisplay();
  }

  mount(root, transportRoot = null) {
    if (this._root === root && this._transportRoot === transportRoot) return;
    this.cleanupHistorical();
    if (this._transportRoot) this._transportRoot.replaceChildren();
    this._root = root;
    this._transportRoot = transportRoot;
    if (this._root) this._root.hidden = !this._active;
    if (this._transportRoot) this._transportRoot.hidden = !this._active;
    if (this._active && !this._suspended) this.render();
  }

  unmount() {
    this.cleanupHistorical();
    this.cleanupDatePicker();
    if (this._root) this._root.replaceChildren();
    if (this._transportRoot) this._transportRoot.replaceChildren();
    this._mediaPanels.clear();
    this._root = null;
    this._transportRoot = null;
  }

  activate() {
    this._active = true;
    this._suspended = false;
    this._presentationMode = "live";
    this.clock.reset();
    if (!this._selectedDay) this._selectedDay = this.todayKey;
    if (this._root) {
      this._root.hidden = false;
      if (this._transportRoot) this._transportRoot.hidden = false;
      this.render();
    }
  }

  deactivate() {
    this._active = false;
    this._presentationMode = "live";
    this.cleanupHistorical();
    this.cleanupDatePicker();
    this.clock.reset();
    this._mediaPanels.clear();
    if (this._root) {
      this._root.replaceChildren();
      this._root.hidden = true;
    }
    if (this._transportRoot) {
      this._transportRoot.replaceChildren();
      this._transportRoot.hidden = true;
    }
  }

  suspend() {
    this._suspended = true;
    this.cleanupHistorical();
    this.cleanupDatePicker();
    this._mediaPanels.clear();
    if (this._root) this._root.replaceChildren();
    if (this._transportRoot) this._transportRoot.replaceChildren();
  }

  resume() {
    this._suspended = false;
    if (this._active) {
      this._presentationMode = "live";
      this.render();
    }
  }

  setSelectedCameraNames(names) {
    const previous = new Set(this._selectedCameraNames);
    const requested = new Set(Array.isArray(names) ? names : []);
    const ordered = this._cameras
      .map(camera => camera.name)
      .filter(name => requested.has(name));
    if (ordered.length === this._selectedCameraNames.length &&
        ordered.every((name, index) => name === this._selectedCameraNames[index])) {
      return true;
    }
    this._selectedCameraNames = ordered;
    if (!ordered.includes(this._primaryCameraName)) {
      this._primaryCameraName = ordered[0] ?? null;
    }
    if (this._active && !this._suspended) {
      if (this._presentationMode === "historical") {
        for (const name of previous) {
          if (!ordered.includes(name)) {
            this.cleanupHistoricalPlayer(this._historicalPlayers.get(name));
            this._historicalPlayers.delete(name);
          }
        }
        const additions = this.getSelectedCameras().filter(camera => !previous.has(camera.name));
        for (const camera of additions) {
          this._historicalPlayers.set(camera.name, this.createHistoricalPlayer(camera));
        }
        this.renderCameraControls();
        this.syncMediaPanels();
        const generation = this._generation;
        additions.forEach(camera => {
          void this.prepareHistoricalAddition(
            this._historicalPlayers.get(camera.name),
            generation
          );
        });
        if (this._historicalPlayers.size === 0) this.clock.pause();
        this.updateTransport();
      } else {
        this.renderCameraControls();
        this.syncMediaPanels();
      }
    }
    return true;
  }

  setPrimaryCamera(name) {
    if (!this._selectedCameraNames.includes(name)) return false;
    if (name === this._primaryCameraName) return true;
    this._primaryCameraName = name;
    if (this._active && !this._suspended) {
      this.renderCameraControls();
      this.syncMediaPanels();
    }
    return true;
  }

  setRhsMode(mode) {
    if (!["timeline", "events", "details"].includes(mode)) return false;
    this._rhsMode = mode;
    this.updateRhs();
    return true;
  }

  setFilter(name, selected) {
    if (!["person", "car", "animal", "package"].includes(name)) return false;
    if (selected) this._selectedFilters.add(name);
    else this._selectedFilters.delete(name);
    return true;
  }

  setSelectedDay(dayKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || dayKey > this.todayKey) return false;
    getCivilDayBounds(dayKey, this.timeZone);
    this._selectedDay = dayKey;
    this.updateWhenControls();
    return true;
  }

  shiftSelectedDay(days) {
    return this.setSelectedDay(shiftCivilDayKey(
      this._selectedDay ?? this.todayKey,
      days
    ));
  }

  returnToLive() {
    this._generation += 1;
    this.cleanupHistorical();
    this.clock.reset();
    this._presentationMode = "live";
    if (this._active && !this._suspended) this.renderMediaArea();
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

  createSection(name, title, content) {
    const section = this._document.createElement("section");
    section.className = `sidebar-section review-${name}-section${
      this._sectionExpanded[name] ? " expanded" : ""
    }`;
    const header = this._document.createElement("button");
    header.type = "button";
    header.className = "sidebar-section-header";
    header.dataset.reviewSection = name;
    header.setAttribute("aria-label", title);
    header.title = title;
    const sectionTitle = this._document.createElement("span");
    sectionTitle.className = "section-title";
    const icon = this._document.createElement("ha-icon");
    icon.setAttribute("icon", {
      cameras: "mdi:video-outline",
      when: "mdi:calendar-clock-outline",
      filters: "mdi:filter-outline",
      diagnostics: "mdi:stethoscope"
    }[name]);
    const label = this._document.createElement("span");
    label.textContent = title.toUpperCase();
    sectionTitle.append(icon, label);
    const indicator = this._document.createElement("span");
    indicator.className = "section-indicator";
    indicator.setAttribute("aria-hidden", "true");
    header.append(sectionTitle, indicator);
    content.classList.add("sidebar-section-body");
    const expanded = this._sectionExpanded[name];
    section.classList.toggle("expanded", expanded);
    header.setAttribute("aria-expanded", String(expanded));
    content.hidden = !expanded;
    content.style.display = expanded ? "" : "none";
    content.setAttribute("aria-hidden", String(!expanded));
    section.append(header, content);
    return section;
  }

  toggleSection(name) {
    return this.setSectionExpanded(name, !this._sectionExpanded[name]);
  }

  setSectionExpanded(name, expanded) {
    if (!Object.hasOwn(this._sectionExpanded, name)) return false;
    this._sectionExpanded[name] = Boolean(expanded);
    const section = this._root?.querySelector(`.review-${name}-section`);
    const header = section?.querySelector(".sidebar-section-header");
    const body = section?.querySelector(".sidebar-section-body");
    const sectionExpanded = this._sectionExpanded[name];
    section?.classList.toggle("expanded", sectionExpanded);
    header?.setAttribute("aria-expanded", String(sectionExpanded));
    if (body) {
      body.hidden = !sectionExpanded;
      body.style.display = sectionExpanded ? "" : "none";
      body.setAttribute("aria-hidden", String(!sectionExpanded));
    }
    return true;
  }

  render() {
    if (!this._root || !this._active || this._suspended) return;
    this.cleanupDatePicker();
    this._root.replaceChildren();
    if (this._transportRoot) this._transportRoot.replaceChildren();
    this._mediaPanels.clear();
    const product = this._document.createElement("div");
    product.className = "review-product";

    const controls = this._document.createElement("aside");
    controls.className = "review-control-rail camera-list nvr-sidebar";
    controls.addEventListener("click", event => {
      if (controls.closest(".nvr-shell")) return;
      const header = event.composedPath().find(node =>
        node?.classList?.contains("sidebar-section-header") &&
        node.dataset.reviewSection);
      if (header && controls.contains(header)) {
        this.toggleSection(header.dataset.reviewSection);
      }
    });
    const cameraContent = this._document.createElement("div");
    cameraContent.className = "review-camera-controls camera-section-body";
    controls.appendChild(this.createSection("cameras", "Cameras", cameraContent));
    const whenContent = this._document.createElement("div");
    whenContent.className = "review-section-content review-when-controls";
    controls.appendChild(this.createSection("when", "When", whenContent));
    const filterContent = this._document.createElement("div");
    filterContent.className = "review-section-content review-filter-controls";
    for (const [value, title] of [["person", "Person"], ["car", "Car"], ["animal", "Animal"], ["package", "Package"]]) {
      const label = this._document.createElement("label");
      const input = this._document.createElement("input");
      input.type = "checkbox";
      input.checked = this._selectedFilters.has(value);
      input.addEventListener("change", () => this.setFilter(value, input.checked));
      label.append(input, title);
      filterContent.appendChild(label);
    }
    controls.appendChild(this.createSection("filters", "Filters", filterContent));
    if (this._debugEnabled) {
      const diagnosticContent = this._document.createElement("div");
      diagnosticContent.className = "review-section-content review-diagnostics";
      const target = this._document.createElement("button");
      target.type = "button";
      target.className = "review-known-target";
      target.textContent = "Load known sync target";
      target.addEventListener("click", () => void this.playHistorical(REVIEW_KNOWN_TARGET));
      const output = this._document.createElement("pre");
      output.className = "review-diagnostic-output";
      output.textContent = "Diagnostics idle.";
      diagnosticContent.append(target, output);
      controls.appendChild(this.createSection("diagnostics", "Diagnostics", diagnosticContent));
    }

    const media = this._document.createElement("main");
    media.className = "review-media-workspace";
    const transport = this._document.createElement("div");
    transport.className = "review-transport";
    const controlsGroup = this._document.createElement("div");
    controlsGroup.className = "review-transport-controls";
    const addTransportButton = ({ className, label, icon, disabled = false, action }) => {
      const button = this._document.createElement("button");
      button.type = "button";
      button.className = className;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.disabled = disabled;
      const symbol = this._document.createElement("ha-icon");
      symbol.setAttribute("icon", icon);
      button.appendChild(symbol);
      if (action) button.addEventListener("click", action);
      controlsGroup.appendChild(button);
      return button;
    };
    addTransportButton({
      className: "review-previous-event", label: "Previous event",
      icon: "mdi:skip-previous", disabled: true
    });
    addTransportButton({
      className: "review-back-ten", label: "Back 10 seconds",
      icon: "mdi:rewind-10", action: () => void this.seekHistoricalRelative(-10)
    });
    addTransportButton({
      className: "review-pause", label: "Pause",
      icon: "mdi:pause", action: () => this.pausePlayback()
    });
    addTransportButton({
      className: "review-play", label: "Play",
      icon: "mdi:play", action: () => this.resumePlayback()
    });
    addTransportButton({
      className: "review-forward-ten", label: "Forward 10 seconds",
      icon: "mdi:fast-forward-10", action: () => void this.seekHistoricalRelative(10)
    });
    addTransportButton({
      className: "review-next-event", label: "Next event",
      icon: "mdi:skip-next", disabled: true
    });
    addTransportButton({
      className: "review-now", label: "Now",
      icon: "mdi:clock-fast", action: () => this.returnToLive()
    });
    const clock = this._document.createElement("time");
    clock.className = "review-clock-display";
    transport.append(controlsGroup, clock);
    const wall = this._document.createElement("div");
    wall.className = "review-camera-wall";
    const primary = this._document.createElement("div");
    primary.className = "review-primary";
    const miniGrid = this._document.createElement("div");
    miniGrid.className = "review-mini-grid";
    wall.append(primary, miniGrid);
    media.appendChild(wall);
    this._transportRoot?.appendChild(transport);

    const rhs = this._document.createElement("aside");
    rhs.className = "review-rhs";
    const modes = this._document.createElement("div");
    modes.className = "review-rhs-modes";
    for (const mode of ["timeline", "events", "details"]) {
      const button = this._document.createElement("button");
      button.type = "button";
      button.dataset.mode = mode;
      button.textContent = mode[0].toUpperCase() + mode.slice(1);
      button.addEventListener("click", () => this.setRhsMode(mode));
      modes.appendChild(button);
    }
    const rhsContent = this._document.createElement("div");
    rhsContent.className = "review-rhs-content";
    rhs.append(modes, rhsContent);
    product.append(controls, media, rhs);
    this._root.appendChild(product);
    this.renderCameraControls();
    this.renderWhenControls();
    this.updateRhs();
    this.renderMediaArea();
  }

  renderCameraControls() {
    const content = this._root?.querySelector(".review-camera-controls");
    if (!content) return;
    content.replaceChildren();
    for (const camera of this._cameras) {
      const row = this._document.createElement("label");
      row.className = "camera-item review-camera-control";
      row.dataset.camera = camera.name;
      const icon = this._document.createElement("ha-icon");
      icon.className = "camera-row-icon";
      icon.setAttribute("icon", "mdi:cctv");
      icon.setAttribute("aria-hidden", "true");
      const name = this._document.createElement("span");
      name.className = "camera-name";
      name.textContent = camera.name;
      const checkbox = this._document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "review-participation";
      checkbox.setAttribute("aria-label", `${camera.name} participates in Review`);
      checkbox.checked = this._selectedCameraNames.includes(camera.name);
      checkbox.addEventListener("change", () => {
        const next = new Set(this._selectedCameraNames);
        if (checkbox.checked) next.add(camera.name);
        else next.delete(camera.name);
        this.setSelectedCameraNames([...next]);
      });
      row.append(icon, name, checkbox);
      content.appendChild(row);
    }
  }

  renderWhenControls() {
    const content = this._root?.querySelector(".review-when-controls");
    if (!content) return;
    content.replaceChildren();
    const previous = this._document.createElement("button");
    previous.type = "button";
    previous.className = "review-day-previous";
    previous.setAttribute("aria-label", "Previous day");
    previous.textContent = "‹";
    previous.addEventListener("click", () => this.shiftSelectedDay(-1));
    const pickerField = this._document.createElement("div");
    pickerField.className = "review-date-picker-field";
    const date = this._document.createElement("input");
    date.type = "text";
    date.className = "review-day-picker";
    date.setAttribute("aria-label", "Review date");
    const calendarButton = this._document.createElement("button");
    calendarButton.type = "button";
    calendarButton.className = "review-calendar-button";
    calendarButton.setAttribute("aria-label", "Choose date from calendar");
    const calendarIcon = this._document.createElement("ha-icon");
    calendarIcon.setAttribute("icon", "mdi:calendar-month-outline");
    calendarButton.appendChild(calendarIcon);
    calendarButton.addEventListener("click", () => this._datePicker?.open());
    pickerField.append(date, calendarButton);
    const next = this._document.createElement("button");
    next.type = "button";
    next.className = "review-day-next";
    next.setAttribute("aria-label", "Next day");
    next.textContent = "›";
    next.addEventListener("click", () => this.shiftSelectedDay(1));
    content.append(previous, pickerField, next);
    if (typeof this._datePickerFactory === "function") {
      this._datePicker = this._datePickerFactory(date, {
        altInput: true,
        altInputClass: "review-day-picker",
        altFormat: "m/d/Y",
        dateFormat: "Y-m-d",
        allowInput: true,
        disableMobile: true,
        defaultDate: this._selectedDay ?? this.todayKey,
        maxDate: this.todayKey,
        appendTo: this._root,
        onChange: (_dates, dayKey) => {
          if (dayKey) this.setSelectedDay(dayKey);
        }
      });
    }
    this.updateWhenControls();
  }

  cleanupDatePicker() {
    this._datePicker?.destroy();
    this._datePicker = null;
  }

  updateWhenControls() {
    const date = this._root?.querySelector(".review-day-picker");
    if (!date) return;
    const today = this.todayKey;
    const selectedDay = this._selectedDay ?? today;
    if (this._datePicker) {
      this._datePicker.set("maxDate", today);
      this._datePicker.setDate(selectedDay, false, "Y-m-d");
    } else date.value = selectedDay;
    const next = this._root.querySelector(".review-day-next");
    if (next) next.disabled = selectedDay >= today;
  }

  updateRhs() {
    if (!this._root) return;
    this._root.querySelectorAll(".review-rhs-modes button").forEach(button => {
      const selected = button.dataset.mode === this._rhsMode;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const content = this._root.querySelector(".review-rhs-content");
    if (!content) return;
    const title = this._rhsMode[0].toUpperCase() + this._rhsMode.slice(1);
    content.innerHTML = `<div class="review-placeholder"><strong>${title}</strong><span>Foundation placeholder</span><small>Newest / Now at top<br>Earlier time runs downward</small></div>`;
  }

  renderMediaArea() {
    if (!this._root) return;
    this._mediaPanels.clear();
    this._root.querySelector(".review-primary")?.replaceChildren();
    this._root.querySelector(".review-mini-grid")?.replaceChildren();
    this.syncMediaPanels();
    this.updateTransport();
    this.updateDiagnostics();
  }

  createCameraPanel(camera) {
    const panel = this._document.createElement("section");
    panel.className = "review-camera-panel";
    panel.dataset.camera = camera.name;
    const heading = this._document.createElement("div");
    heading.className = "review-camera-heading";
    heading.textContent = camera.name;
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
      if (player) player.video = video;
      media.appendChild(video);
      const status = this._document.createElement("div");
      status.className = "review-camera-status";
      status.textContent = player?.message ?? "Preparing recording...";
      if (player) player.statusElement = status;
      media.appendChild(status);
    }
    panel.append(heading, media);
    panel.addEventListener("dblclick", event => {
      if (panel.classList.contains("secondary") &&
          !event.target.closest?.("button, input")) {
        this.setPrimaryCamera(camera.name);
      }
    });
    let touchStart = null;
    let previousTap = 0;
    panel.addEventListener("pointerdown", event => {
      if (event.pointerType !== "touch") return;
      touchStart = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    });
    panel.addEventListener("pointercancel", () => { touchStart = null; });
    panel.addEventListener("pointerup", event => {
      if (event.pointerType !== "touch" || !touchStart ||
          !panel.classList.contains("secondary")) return;
      const moved = Math.hypot(
        event.clientX - touchStart.x,
        event.clientY - touchStart.y
      );
      const duration = event.timeStamp - touchStart.at;
      touchStart = null;
      if (moved > 12 || duration > 500) {
        previousTap = 0;
        return;
      }
      if (previousTap > 0 && event.timeStamp - previousTap <= 450) {
        previousTap = 0;
        this.setPrimaryCamera(camera.name);
      } else {
        previousTap = event.timeStamp;
      }
    });
    return panel;
  }

  syncMediaPanels() {
    const primaryHost = this._root?.querySelector(".review-primary");
    const miniGrid = this._root?.querySelector(".review-mini-grid");
    if (!primaryHost || !miniGrid) return;
    miniGrid.querySelectorAll(".review-mini-blank").forEach(blank => blank.remove());
    const selected = new Set(this._selectedCameraNames);
    for (const [name, panel] of this._mediaPanels) {
      if (!selected.has(name)) {
        panel.remove();
        this._mediaPanels.delete(name);
      }
    }
    const ordered = this.getOrderedCameras();
    if (ordered.length === 0) {
      primaryHost.replaceChildren();
      const empty = this._document.createElement("div");
      empty.className = "review-empty-state";
      empty.textContent = "Select cameras to begin Review.";
      primaryHost.appendChild(empty);
    } else {
      primaryHost.querySelector(".review-empty-state")?.remove();
      ordered.forEach((camera, index) => {
        let panel = this._mediaPanels.get(camera.name);
        if (!panel) {
          panel = this.createCameraPanel(camera);
          this._mediaPanels.set(camera.name, panel);
        }
        panel.classList.toggle("primary", index === 0);
        panel.classList.toggle("secondary", index !== 0);
        if (index === 0) primaryHost.appendChild(panel);
        else miniGrid.appendChild(panel);
      });
    }
    const occupied = Math.max(ordered.length - 1, 0);
    for (let slot = occupied; slot < REVIEW_MINI_SLOT_CAPACITY; slot += 1) {
      const blank = this._document.createElement("div");
      blank.className = "review-mini-blank";
      blank.dataset.miniSlot = String(slot);
      miniGrid.appendChild(blank);
    }
  }

  updateTransport() {
    const historical = this._presentationMode === "historical" &&
      !this._historicalPreparing &&
      this._historicalPlayers.size > 0;
    const pause = this._transportRoot?.querySelector(".review-pause");
    const play = this._transportRoot?.querySelector(".review-play");
    const back = this._transportRoot?.querySelector(".review-back-ten");
    const forward = this._transportRoot?.querySelector(".review-forward-ten");
    if (pause) {
      pause.disabled = !historical || !this.clock.running;
      pause.classList.toggle("selected", historical && this.clock.running);
    }
    if (play) {
      play.disabled = !historical || this.clock.running;
      play.classList.toggle("selected", historical && !this.clock.running);
    }
    if (back) back.disabled = !historical;
    if (forward) forward.disabled = !historical;
    const now = this._transportRoot?.querySelector(".review-now");
    if (now) now.disabled = this._presentationMode === "live";
    this.updateClockDisplay();
  }

  updateClockDisplay() {
    const output = this._transportRoot?.querySelector(".review-clock-display");
    if (!output) return;
    const absolute = this.clock.absoluteTime;
    output.textContent = Number.isFinite(absolute)
      ? new Intl.DateTimeFormat(undefined, {
        timeZone: this.timeZone,
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", second: "2-digit"
      }).format(new Date(absolute * 1000))
      : "";
  }

  pausePlayback() {
    if (this._presentationMode !== "historical" || !this.clock.running) return false;
    const players = [...this._historicalPlayers.values()].filter(player =>
      !player.unavailable && player.video);
    this.clock.pause();
    players.forEach(player => player.video.pause());
    this.updateTransport();
    this.updateDiagnostics();
    return true;
  }

  resumePlayback() {
    if (this._presentationMode !== "historical" || this.clock.running) return false;
    const players = [...this._historicalPlayers.values()].filter(player =>
      !player.unavailable && player.video);
    if (players.length === 0) return false;
    players.forEach(player => {
      void Promise.resolve(player.video.play()).catch(() => {});
    });
    this.clock.start();
    this.updateTransport();
    this.updateDiagnostics();
    return true;
  }

  async seekHistoricalRelative(deltaSeconds) {
    if (this._presentationMode !== "historical" ||
        !Number.isFinite(this.clock.absoluteTime)) return false;
    const target = this.clock.absoluteTime + Number(deltaSeconds);
    const wasRunning = this.clock.running;
    const withinPreparedRange = this._historicalRange &&
      target >= this._historicalRange.start && target <= this._historicalRange.end;
    if (!withinPreparedRange) {
      await this.playHistorical(target, { autoplay: wasRunning });
      return true;
    }
    this.clock.pause();
    this.clock.setAbsolute(target);
    const players = [...this._historicalPlayers.values()].filter(player =>
      !player.unavailable && player.video && player.timing);
    players.forEach(player => player.video.pause());
    await Promise.all(players.map(async player => {
      try {
        player.seek = calculateHistoricalSeek(target, player.timing);
        await this.seekHistoricalPlayer(player);
      } catch (error) {
        this.setPlayerStatus(player, `Unavailable: ${sanitizeReviewError(error)}`, true);
      }
    }));
    if (wasRunning && players.some(player => !player.unavailable)) {
      players.filter(player => !player.unavailable).forEach(player => {
        void Promise.resolve(player.video.play()).catch(() => {});
      });
      this.clock.start();
    }
    this.updateTransport();
    this.updateDiagnostics();
    return true;
  }

  setPlayerStatus(player, message, unavailable = false) {
    player.message = message;
    player.unavailable = unavailable;
    if (player.statusElement) {
      player.statusElement.textContent = message;
      player.statusElement.classList.toggle("unavailable", unavailable);
    }
  }

  createHistoricalPlayer(camera) {
    return {
      camera,
      frigateCamera: this.getFrigateCameraId(camera),
      video: null,
      hls: null,
      hlsListeners: [],
      waitCancellations: [],
      statusElement: null,
      message: "Preparing recording...",
      unavailable: false
    };
  }

  async prepareHistoricalAddition(player, generation) {
    const targetEpoch = this.clock.absoluteTime;
    if (!player || !Number.isFinite(targetEpoch)) return;
    try {
      if (!player.frigateCamera) throw new Error("No Frigate camera identity.");
      const range = buildReviewRange(targetEpoch);
      const Hls = await this._loadHls();
      if (!Hls.isSupported()) throw new Error("This browser does not support historical HLS playback.");
      await this.attachHistoricalPlayer(player, range, Hls, generation);
      if (this._historicalPlayers.get(player.camera.name) !== player) return;
      player.seek = calculateHistoricalSeek(this.clock.absoluteTime, player.timing);
      await this.seekHistoricalPlayer(player);
      if (this.clock.running) await Promise.resolve(player.video.play());
      this.setPlayerStatus(player, "Ready");
    } catch (error) {
      this.cleanupHistoricalPlayer(player);
      if (this._historicalPlayers.get(player?.camera?.name) === player) {
        this.setPlayerStatus(player, `Unavailable: ${sanitizeReviewError(error)}`, true);
      }
    }
    this.updateDiagnostics();
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
    this.setPlayerStatus(player, "Ready");
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

  async playHistorical(value, { autoplay = true } = {}) {
    const generation = ++this._generation;
    this.cleanupHistorical();
    try {
      const targetEpoch = parseReviewTimestamp(value);
      const range = buildReviewRange(targetEpoch);
      this._historicalRange = range;
      this.clock.setAbsolute(targetEpoch);
      for (const camera of this.getOrderedCameras()) {
        this._historicalPlayers.set(camera.name, this.createHistoricalPlayer(camera));
      }
      this._historicalPreparing = true;
      this._presentationMode = "historical";
      this.renderMediaArea();
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
      const starts = autoplay
        ? playable.map(player => Promise.resolve(player.video.play()))
        : [];
      if (starts.length > 0) this.clock.start();
      const startResults = await Promise.allSettled(starts);
      startResults.forEach((result, index) => {
        if (result.status === "rejected") {
          this.setPlayerStatus(playable[index], "Unavailable: playback was blocked.", true);
        }
      });
      if (playable.every(player => player.unavailable)) this.clock.pause();
      this._historicalPreparing = false;
      this.updateTransport();
      this.updateDiagnostics();
      const view = this._root?.ownerDocument?.defaultView ?? globalThis;
      this._diagnosticTimer = view.setInterval(() => {
        this.updateClockDisplay();
        this.updateDiagnostics();
      }, 500);
    } catch (error) {
      if (generation !== this._generation) return;
      this.clock.pause();
      this._historicalPreparing = false;
      const output = this._root?.querySelector(".review-diagnostic-output");
      if (output) output.textContent = sanitizeReviewError(error);
      this.updateTransport();
    }
  }

  updateDiagnostics() {
    const output = this._root?.querySelector(".review-diagnostic-output");
    if (!output || this._presentationMode !== "historical") return;
    const clock = this.clock.absoluteTime;
    const lines = [
      `Transport: ${this.clock.running ? "playing" : "paused"}`,
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
    output.textContent = lines.join("\n");
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
    this._historicalRange = null;
    this._historicalPreparing = false;
  }
}
