import "../vendor/flatpickr/flatpickr-4.6.13.min.js";

const REVIEW_RANGE_BEFORE_SECONDS = 15;
const REVIEW_RANGE_AFTER_SECONDS = 120;
const REVIEW_SIGNED_PATH_EXPIRES_SECONDS = 900;
const REVIEW_HLS_SCRIPT_PATH = "/local/nvr-card/src/vendor/hls.min.js";
const REVIEW_HLS_PROMISE = Symbol.for("nvr.review.hlsScript");
const REVIEW_KNOWN_TARGET = "2026-09-08T14:00:00-07:00";
const REVIEW_SLOT_CAPACITY = 16;
const REVIEW_DEFAULT_RANGE_SECONDS = 3600;
const REVIEW_CAMERA_DRAG_TYPE = "application/x-nvr-camera";
const REVIEW_LAYOUT_DRAG_TYPE = "application/x-nvr-layout";
export const REVIEW_PLAYBACK_SPEEDS = Object.freeze([1, 2, 4, 8, 16]);

const gridCells = count => Array.from({ length: count }, (_, slot) => ({ slot }));
const freezeLayout = layout => Object.freeze({
  ...layout,
  cells: Object.freeze(layout.cells.map(cell => Object.freeze({ ...cell })))
});

export const VIEWER_LAYOUTS = Object.freeze({
  "1x1": freezeLayout({
    label: "1x1", columns: "1fr", rows: "1fr", cells: gridCells(1)
  }),
  "2x2": freezeLayout({
    label: "2x2", columns: "repeat(2, 1fr)", rows: "repeat(2, 1fr)",
    cells: gridCells(4)
  }),
  "3x3": freezeLayout({
    label: "3x3", columns: "repeat(3, 1fr)", rows: "repeat(3, 1fr)",
    cells: gridCells(9)
  }),
  "4x4": freezeLayout({
    label: "4x4", columns: "repeat(4, 1fr)", rows: "repeat(4, 1fr)",
    cells: gridCells(16)
  }),
  large3: freezeLayout({
    label: "Large+3", columns: "repeat(2, 1fr)", rows: "repeat(3, 1fr)",
    cells: [
      { slot: 0, column: "1", row: "1 / span 2" },
      { slot: 1, column: "2", row: "1" },
      { slot: 2, column: "2", row: "2" },
      { slot: 3, column: "1 / span 2", row: "3" }
    ]
  }),
  large5: freezeLayout({
    label: "Large+5", columns: "repeat(3, 1fr)", rows: "repeat(3, 1fr)",
    cells: [
      { slot: 0, column: "1 / span 2", row: "1 / span 2" },
      { slot: 1, column: "3", row: "1" },
      { slot: 2, column: "3", row: "2" },
      { slot: 3, column: "1", row: "3" },
      { slot: 4, column: "2", row: "3" },
      { slot: 5, column: "3", row: "3" }
    ]
  }),
  large7: freezeLayout({
    label: "Large+7", columns: "repeat(4, 1fr)", rows: "repeat(4, 1fr)",
    cells: [
      { slot: 0, column: "1 / span 3", row: "1 / span 3" },
      { slot: 1, column: "4", row: "1" },
      { slot: 2, column: "4", row: "2" },
      { slot: 3, column: "4", row: "3" },
      { slot: 4, column: "1", row: "4" },
      { slot: 5, column: "2", row: "4" },
      { slot: 6, column: "3", row: "4" },
      { slot: 7, column: "4", row: "4" }
    ]
  }),
  topwide: freezeLayout({
    label: "Top Wide", columns: "repeat(3, 1fr)", rows: "repeat(3, 1fr)",
    cells: [
      { slot: 0, column: "1 / span 3", row: "1 / span 2" },
      { slot: 1, column: "1", row: "3" },
      { slot: 2, column: "2", row: "3" },
      { slot: 3, column: "3", row: "3" }
    ]
  }),
  leftwide: freezeLayout({
    label: "Left Wide", columns: "repeat(3, 1fr)", rows: "repeat(3, 1fr)",
    cells: [
      { slot: 0, column: "1 / span 2", row: "1 / span 3" },
      { slot: 1, column: "3", row: "1" },
      { slot: 2, column: "3", row: "2" },
      { slot: 3, column: "3", row: "3" }
    ]
  }),
  primary12: freezeLayout({
    label: "Primary+12",
    columns: "repeat(4, minmax(0, 1fr))",
    rows: "minmax(0, 58fr) repeat(3, minmax(0, 14fr))",
    cells: [
      { slot: 0, column: "1 / span 4", row: "1" },
      ...gridCells(12).map((_, index) => ({ slot: index + 1 }))
    ],
    primary: true
  })
});

function escapeViewerHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildLayoutMiniatureMarkup(layout) {
  const cells = layout.cells.map(cell => {
    const column = cell.column ? `grid-column:${cell.column};` : "";
    const row = cell.row ? `grid-row:${cell.row};` : "";
    return `<span class="layout-icon-cell" style="${column}${row}"></span>`;
  }).join("");
  return `<div class="layout-icon" style="grid-template-columns:${layout.columns};grid-template-rows:${layout.rows};">${cells}</div>`;
}

export function buildViewerLayoutMenuMarkup(layouts = VIEWER_LAYOUTS) {
  return Object.entries(layouts).map(([key, layout]) => `
    <button type="button" class="sidebar-layout-item" data-layout="${escapeViewerHtml(key)}"
      aria-label="${escapeViewerHtml(layout.label)} layout" draggable="true">
      ${buildLayoutMiniatureMarkup(layout)}
      <div class="sidebar-layout-label">${escapeViewerHtml(layout.label)}</div>
    </button>
  `).join("");
}

export function buildViewerCameraMenuMarkup(cameras, isOnline = () => false) {
  return cameras.map(camera => {
    const name = escapeViewerHtml(camera.name);
    const online = isOnline(camera);
    const statusLabel = online ? "Online" : "Offline";
    return `
      <button type="button" class="camera-item ${camera.entity ? "live-capable" : ""}"
        data-camera="${name}" draggable="true">
        <ha-icon class="camera-row-icon" icon="mdi:cctv" aria-hidden="true"></ha-icon>
        <span class="camera-name">${name}</span>
        <span class="camera-status ${online ? "online" : "offline"}" role="img"
          aria-label="${statusLabel}" title="${statusLabel}"></span>
      </button>
    `;
  }).join("");
}

export function normalizeReviewTimelineItems(result, range) {
  if (!Array.isArray(result)) throw new Error("Review Timeline returned malformed data.");
  const items = [];
  for (const item of result) {
    if (!item || typeof item !== "object") continue;
    const start = Number(item.start_time);
    if (!Number.isFinite(start) || start < range.from || start > range.to) continue;
    const end = item.end_time == null ? null : Number(item.end_time);
    items.push({
      camera_id: typeof item.camera_id === "string" ? item.camera_id : "unknown",
      start_time: start,
      ...(Number.isFinite(end) && end >= start ? { end_time: Math.min(end, range.to) } : {}),
      type: typeof item.type === "string" ? item.type : "event",
      labels: Array.isArray(item.labels) ? item.labels.filter(label => typeof label === "string") : []
    });
  }
  return items.sort((a, b) => a.start_time - b.start_time || a.camera_id.localeCompare(b.camera_id));
}

export function reviewTimelineMarkerTop(epoch, range) {
  if (!(range.from < range.to) || !Number.isFinite(epoch)) return null;
  return Math.min(1, Math.max(0, (range.to - epoch) / (range.to - range.from)));
}

export class ReviewClock {
  constructor(now = () => performance.now()) {
    this._now = now;
    this._absolute = null;
    this._startedAt = null;
    this._rate = 1;
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

  setRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("ReviewClock rate must be positive.");
    }
    if (value === this._rate) return;
    const running = this.running;
    if (running) this.pause();
    this._rate = value;
    if (running) this.start();
  }

  get rate() {
    return this._rate;
  }

  get running() {
    return this._startedAt !== null;
  }

  get absoluteTime() {
    if (!Number.isFinite(this._absolute)) return null;
    return this._startedAt === null
      ? this._absolute
      : this._absolute + ((this._now() - this._startedAt) / 1000) * this._rate;
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

function getDateTimeParts(value, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value).filter(part => part.type !== "literal")
    .map(part => [part.type, part.value]));
}

function pickerDateForEpoch(epochSeconds, timeZone) {
  const parts = getDateTimeParts(new Date(epochSeconds * 1000), timeZone);
  return new Date(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
}

function pickerDateToEpoch(value, timeZone) {
  const desired = Date.UTC(
    value.getFullYear(), value.getMonth(), value.getDate(),
    value.getHours(), value.getMinutes(), value.getSeconds()
  );
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getDateTimeParts(new Date(guess), timeZone);
    const observed = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)
    );
    guess += desired - observed;
  }
  return guess / 1000;
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
  static VIEWER_LAYOUTS = VIEWER_LAYOUTS;
  static buildViewerCameraMenuMarkup = buildViewerCameraMenuMarkup;
  static buildViewerLayoutMenuMarkup = buildViewerLayoutMenuMarkup;

  constructor({
    documentRef = globalThis.document,
    loadHls = loadReviewHls,
    now = () => performance.now(),
    wallClock = () => Date.now(),
    datePickerFactory = globalThis.flatpickr
  } = {}) {
    this._document = documentRef;
    this._loadHls = loadHls;
    this._datePickerFactory = datePickerFactory;
    this._datePickers = { from: null, to: null };
    this._wallClock = wallClock;
    this._root = null;
    this._transportRoot = null;
    this._hass = null;
    this._cameras = [];
    this._selectedCameraNames = [];
    this._primaryCameraName = null;
    this._reviewLayout = "primary12";
    this._reviewAssignments = new Array(REVIEW_SLOT_CAPACITY).fill(null);
    this._selectedReviewCamera = null;
    this._selectedReviewLayout = null;
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
    this._sectionExpanded = {
      cameras: false, layouts: false, when: false, filters: false, diagnostics: false
    };
    this._reviewRange = null;
    this._draftReviewRange = null;
    this._rangeRefreshCount = 0;
    this._timelineRequestId = 0;
    this._timeline = { status: "idle", items: [], error: null, queryRange: null };
    this._playbackSpeed = 1;
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
      reviewLayout: this._reviewLayout,
      reviewAssignments: [...this._reviewAssignments],
      reviewClockAbsolute: this.clock.absoluteTime,
      reviewRange: this._reviewRange ? { ...this._reviewRange } : null,
      activeReviewRange: this._reviewRange ? { ...this._reviewRange } : null,
      draftReviewRange: this._draftReviewRange ? { ...this._draftReviewRange } : null,
      reviewRangeDirty: this.isReviewRangeDirty(),
      timeline: {
        status: this._timeline.status,
        items: [...this._timeline.items],
        queryRange: this._timeline.queryRange ? { ...this._timeline.queryRange } : null
      },
      playbackSpeed: this._playbackSpeed,
      selectedFilters: [...this._selectedFilters],
      rhsMode: this._rhsMode,
      sectionExpanded: { ...this._sectionExpanded }
    };
  }

  configure(cameras) {
    this._cameras = Array.isArray(cameras)
      ? cameras.filter(camera => camera?.active === true)
      : [];
    const enabledNames = this._cameras.map(camera => camera.name);
    if (!this._selectionInitialized) {
      this._reviewAssignments.fill(null);
      enabledNames.slice(0, 2).forEach((name, slot) => {
        this._reviewAssignments[slot] = name;
      });
      this.syncSelectionFromAssignments();
      this._selectionInitialized = true;
    } else {
      const enabled = new Set(enabledNames);
      this._reviewAssignments = this._reviewAssignments.map(name =>
        enabled.has(name) ? name : null);
      this.syncSelectionFromAssignments();
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
    this.ensureReviewRange();
    this._root?.querySelectorAll("hui-image.review-live-camera").forEach(image => {
      image.hass = hass;
    });
    this.updateWhenControls();
    this.updateClockDisplay();
    this.updateCameraStatuses();
  }

  updateCameraStatuses() {
    this._root?.querySelectorAll(".review-camera-controls .camera-item").forEach(row => {
      const camera = this._cameras.find(candidate => candidate.name === row.dataset.camera);
      const status = row.querySelector(".camera-status");
      if (!status) return;
      const online = this.isCameraOnline(camera);
      const label = online ? "Online" : "Offline";
      status.classList.toggle("online", online);
      status.classList.toggle("offline", !online);
      status.setAttribute("aria-label", label);
      status.setAttribute("title", label);
    });
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
    this.ensureReviewRange();
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
      .filter(name => requested.has(name))
      .slice(0, this.currentLayout.cells.length);
    const visibleSlots = this.currentLayout.cells.map(cell => cell.slot);
    const next = new Array(REVIEW_SLOT_CAPACITY).fill(null);
    for (const slot of visibleSlots) {
      const name = this._reviewAssignments[slot];
      if (ordered.includes(name)) next[slot] = name;
    }
    if (this.currentLayout.primary && next[0] === null && ordered.length > 0) {
      const promotedSlot = next.indexOf(ordered[0]);
      if (promotedSlot >= 0) next[promotedSlot] = null;
      next[0] = ordered[0];
    }
    for (const name of ordered) {
      if (next.includes(name)) continue;
      const slot = visibleSlots.find(candidate => next[candidate] === null);
      if (slot === undefined) break;
      next[slot] = name;
    }
    if (next.every((name, slot) => name === this._reviewAssignments[slot])) {
      return true;
    }
    this._reviewAssignments = next;
    this.syncSelectionFromAssignments();
    this.handleAssignmentChange(previous);
    return true;
  }

  get currentLayout() {
    return VIEWER_LAYOUTS[this._reviewLayout];
  }

  syncSelectionFromAssignments() {
    const visibleSlots = new Set(this.currentLayout.cells.map(cell => cell.slot));
    this._selectedCameraNames = this._reviewAssignments.filter((name, slot) =>
      visibleSlots.has(slot) && typeof name === "string");
    this._primaryCameraName = this._reviewAssignments[0] ??
      this._selectedCameraNames[0] ?? null;
  }

  handleAssignmentChange(previous = new Set()) {
    const selected = new Set(this._selectedCameraNames);
    if (this._active && !this._suspended) {
      if (this._presentationMode === "historical") {
        for (const name of previous) {
          if (!selected.has(name)) {
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
  }

  setPrimaryCamera(name) {
    // Review slot 0 is the historical orchestration primary in every layout;
    // only Primary+12 exposes promotion as a visible interaction.
    if (!this._selectedCameraNames.includes(name)) return false;
    if (name === this._primaryCameraName) return true;
    const sourceSlot = this._reviewAssignments.indexOf(name);
    if (sourceSlot < 0) return false;
    const displaced = this._reviewAssignments[0];
    this._reviewAssignments[0] = name;
    this._reviewAssignments[sourceSlot] = displaced;
    this.syncSelectionFromAssignments();
    if (this._active && !this._suspended) {
      this.renderCameraControls();
      this.syncMediaPanels();
    }
    return true;
  }

  setReviewLayout(layoutKey) {
    if (!Object.hasOwn(VIEWER_LAYOUTS, layoutKey)) return false;
    if (layoutKey === this._reviewLayout) {
      this._selectedReviewLayout = null;
      this.updateReviewLayoutControls();
      return true;
    }
    const previous = new Set(this._selectedCameraNames);
    const names = this._reviewAssignments.filter(Boolean);
    this._reviewLayout = layoutKey;
    this._selectedReviewLayout = null;
    this._reviewAssignments.fill(null);
    this.currentLayout.cells.forEach((cell, index) => {
      this._reviewAssignments[cell.slot] = names[index] ?? null;
    });
    this.syncSelectionFromAssignments();
    this.applyReviewLayout();
    this.handleAssignmentChange(previous);
    this.updateReviewLayoutControls();
    return true;
  }

  toggleReviewLayoutTarget(layoutKey) {
    if (!Object.hasOwn(VIEWER_LAYOUTS, layoutKey)) return false;
    this._selectedReviewCamera = null;
    this._selectedReviewLayout = this._selectedReviewLayout === layoutKey
      ? null
      : layoutKey;
    this.renderCameraControls();
    this.updateReviewLayoutControls();
    return true;
  }

  toggleReviewCameraTarget(cameraName) {
    if (!this._cameras.some(camera => camera.name === cameraName)) return false;
    this._selectedReviewLayout = null;
    this._selectedReviewCamera = this._selectedReviewCamera === cameraName
      ? null
      : cameraName;
    this.renderCameraControls();
    this.updateReviewLayoutControls();
    return true;
  }

  assignCameraToSlot(cameraName, targetSlot) {
    const camera = this._cameras.find(candidate => candidate.name === cameraName);
    const visible = this.currentLayout.cells.some(cell => cell.slot === targetSlot);
    if (!camera || !visible || !Number.isInteger(targetSlot)) return false;
    const sourceSlot = this._reviewAssignments.indexOf(cameraName);
    if (sourceSlot === targetSlot) return true;
    const previous = new Set(this._selectedCameraNames);
    if (sourceSlot >= 0) this._reviewAssignments[sourceSlot] = null;
    this._reviewAssignments[targetSlot] = cameraName;
    this._selectedReviewCamera = null;
    this.syncSelectionFromAssignments();
    this.handleAssignmentChange(previous);
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

  ensureReviewRange() {
    if (!(this._reviewRange?.from < this._reviewRange?.to)) {
      const to = Math.floor((this._wallClock() / 1000) / 60) * 60;
      this._reviewRange = { from: to - REVIEW_DEFAULT_RANGE_SECONDS, to };
    }
    if (!(this._draftReviewRange?.from < this._draftReviewRange?.to)) {
      this._draftReviewRange = { ...this._reviewRange };
    }
  }

  isReviewRangeDirty() {
    return Boolean(this._draftReviewRange && this._reviewRange &&
      (this._draftReviewRange.from !== this._reviewRange.from ||
       this._draftReviewRange.to !== this._reviewRange.to));
  }

  refreshReviewRange() {
    this.ensureReviewRange();
    this._rangeRefreshCount += 1;
    const requestId = ++this._timelineRequestId;
    const range = { ...this._reviewRange };
    const now = this._wallClock() / 1000;
    const queryTo = Math.min(range.to, now);
    const cameras = this.getOrderedCameras()
      .map(camera => this.getFrigateCameraId(camera))
      .filter((camera, index, list) => camera && list.indexOf(camera) === index);
    this._timeline = { status: "loading", items: [], error: null, queryRange: null };
    this.updateRhs();
    if (queryTo <= range.from || !this._hass || typeof this._hass.callWS !== "function" || cameras.length === 0) {
      this._timeline = { status: "loaded", items: [], error: null, queryRange: { from: range.from, to: queryTo } };
      this.updateRhs();
      return Promise.resolve(this._rangeRefreshCount);
    }
    const queryRange = { from: range.from, to: queryTo };
    this._timeline.queryRange = queryRange;
    return Promise.resolve(this._hass.callWS({
      type: "frigate_max/v1/review/get",
      cameras,
      from: queryRange.from,
      to: queryRange.to
    })).then(result => {
      if (requestId !== this._timelineRequestId) return;
      this._timeline = { status: "loaded", items: normalizeReviewTimelineItems(result, range), error: null, queryRange };
      this.updateRhs();
    }).catch(error => {
      if (requestId !== this._timelineRequestId) return;
      this._timeline = { status: "error", items: [], error: "Unable to load activity.", queryRange };
      this.updateRhs();
      if (this._debugEnabled) console.warn("Review Timeline refresh failed", error?.message);
    }).then(() => this._rangeRefreshCount);
  }

  applyReviewRange() {
    this.ensureReviewRange();
    if (!this.isReviewRangeDirty()) return false;
    const next = { ...this._draftReviewRange };
    if (!(next.from < next.to)) return false;
    this._reviewRange = next;
    const absolute = this.clock.absoluteTime;
    if (Number.isFinite(absolute) &&
        (absolute < next.from || absolute > next.to)) {
      this.clock.setAbsolute(Math.min(Math.max(absolute, next.from), next.to));
      this.updateClockDisplay();
    }
    void this.refreshReviewRange();
    this.updateTransport();
    return true;
  }

  setReviewRangeEndpoint(endpoint, value) {
    if (!["from", "to"].includes(endpoint)) return false;
    const epoch = value instanceof Date ? value.getTime() / 1000 : Number(value);
    if (!Number.isFinite(epoch)) return false;
    this.ensureReviewRange();
    const duration = Math.max(
      this._draftReviewRange.to - this._draftReviewRange.from,
      REVIEW_DEFAULT_RANGE_SECONDS
    );
    if (endpoint === "from") {
      this._draftReviewRange.from = epoch;
      if (epoch >= this._draftReviewRange.to) this._draftReviewRange.to = epoch + duration;
    } else {
      this._draftReviewRange.to = epoch;
      if (epoch <= this._draftReviewRange.from) this._draftReviewRange.from = epoch - duration;
    }
    this.updateWhenControls();
    return true;
  }

  setReviewTimePart(endpoint, part, value) {
    if (!['from', 'to'].includes(endpoint) || !['hour', 'minute'].includes(part)) return false;
    this.ensureReviewRange();
    const date = pickerDateForEpoch(this._draftReviewRange[endpoint], this.timeZone);
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || (part === 'hour' && (numeric < 0 || numeric > 23)) ||
        (part === 'minute' && (numeric < 0 || numeric > 59))) return false;
    if (part === 'hour') date.setHours(numeric);
    else date.setMinutes(numeric);
    return this.setReviewRangeEndpoint(endpoint, pickerDateToEpoch(date, this.timeZone));
  }

  setPlaybackSpeed(value) {
    const speed = Number(value);
    if (!REVIEW_PLAYBACK_SPEEDS.includes(speed)) return false;
    this._playbackSpeed = speed;
    this.clock.setRate(speed);
    if (this._presentationMode === "historical") {
      for (const player of this._historicalPlayers.values()) {
        if (player.video) player.video.playbackRate = speed;
      }
    }
    this.updateTransport();
    return true;
  }

  includeReviewTarget(targetEpoch) {
    this.ensureReviewRange();
    const duration = this._reviewRange.to - this._reviewRange.from;
    if (targetEpoch < this._reviewRange.from) {
      this._reviewRange = { from: targetEpoch, to: targetEpoch + duration };
    } else if (targetEpoch > this._reviewRange.to) {
      this._reviewRange = { from: targetEpoch - duration, to: targetEpoch };
    }
    this._draftReviewRange = { ...this._reviewRange };
    this.updateWhenControls();
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
    return this._reviewAssignments
      .filter(Boolean)
      .map(name => this._cameras.find(camera => camera.name === name))
      .filter(Boolean);
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
      layouts: "mdi:view-grid-outline",
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
    const layoutContent = this._document.createElement("div");
    layoutContent.className = "sidebar-layout-body review-layout-controls";
    controls.appendChild(this.createSection("layouts", "Layouts", layoutContent));
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
    const speed = this._document.createElement("select");
    speed.className = "review-speed-select";
    speed.setAttribute("aria-label", "Playback speed");
    speed.title = "Playback speed";
    for (const value of REVIEW_PLAYBACK_SPEEDS) {
      const option = this._document.createElement("option");
      option.value = String(value);
      option.textContent = `${value}x`;
      option.selected = value === this._playbackSpeed;
      speed.appendChild(option);
    }
    speed.addEventListener("change", () => this.setPlaybackSpeed(speed.value));
    controlsGroup.appendChild(speed);
    addTransportButton({
      className: "review-now", label: "Now",
      icon: "mdi:clock-fast", action: () => this.returnToLive()
    });
    const clock = this._document.createElement("time");
    clock.className = "review-clock-display";
    transport.append(controlsGroup, clock);
    const wall = this._document.createElement("div");
    wall.className = "review-camera-wall";
    for (let slot = 0; slot < REVIEW_SLOT_CAPACITY; slot += 1) {
      const cell = this._document.createElement("div");
      cell.className = "review-layout-cell";
      cell.dataset.reviewSlot = String(slot);
      wall.appendChild(cell);
    }
    this.attachReviewPlacementHandlers(wall);
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
    this.renderReviewLayoutControls();
    this.renderWhenControls();
    this.updateRhs();
    this.applyReviewLayout();
    this.renderMediaArea();
  }

  renderCameraControls() {
    const content = this._root?.querySelector(".review-camera-controls");
    if (!content) return;
    content.innerHTML = buildViewerCameraMenuMarkup(
      this._cameras,
      camera => this.isCameraOnline(camera)
    );
    for (const row of content.querySelectorAll(".camera-item")) {
      const cameraName = row.dataset.camera;
      row.classList.toggle("assigned", this._selectedCameraNames.includes(cameraName));
      row.classList.toggle("target-selected", this._selectedReviewCamera === cameraName);
      row.addEventListener("click", () => this.toggleReviewCameraTarget(cameraName));
      row.addEventListener("dragstart", event => {
        if (!event.dataTransfer) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(REVIEW_CAMERA_DRAG_TYPE, cameraName);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
    }
  }

  isCameraOnline(camera) {
    const state = camera?.entity ? this._hass?.states?.[camera.entity] : null;
    return Boolean(state && !["unavailable", "unknown"].includes(state.state));
  }

  renderReviewLayoutControls() {
    const content = this._root?.querySelector(".review-layout-controls");
    if (!content) return;
    const grid = this._document.createElement("div");
    grid.className = "sidebar-layout-grid";
    grid.innerHTML = buildViewerLayoutMenuMarkup();
    for (const button of grid.querySelectorAll(".sidebar-layout-item")) {
      const key = button.dataset.layout;
      button.addEventListener("click", () => this.toggleReviewLayoutTarget(key));
      button.addEventListener("dragstart", event => {
        if (!event.dataTransfer) return;
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(REVIEW_LAYOUT_DRAG_TYPE, key);
        button.classList.add("dragging");
      });
      button.addEventListener("dragend", () => button.classList.remove("dragging"));
    }
    content.replaceChildren();
    content.appendChild(grid);
    this.updateReviewLayoutControls();
  }

  updateReviewLayoutControls() {
    this._root?.querySelectorAll(".review-layout-controls .sidebar-layout-item").forEach(button => {
      button.classList.toggle("selected", button.dataset.layout === this._reviewLayout);
      button.classList.toggle(
        "target-selected",
        button.dataset.layout === this._selectedReviewLayout
      );
    });
  }

  attachReviewPlacementHandlers(wall) {
    wall.addEventListener("click", event => {
      const cell = event.composedPath().find(node =>
        node?.classList?.contains("review-layout-cell"));
      if (!cell || cell.hidden) return;
      if (this._selectedReviewLayout) {
        this.setReviewLayout(this._selectedReviewLayout);
        return;
      }
      if (this._selectedReviewCamera) {
        this.assignCameraToSlot(this._selectedReviewCamera, Number(cell.dataset.reviewSlot));
      }
    });
    wall.addEventListener("dragover", event => {
      const types = Array.from(event.dataTransfer?.types ?? []);
      if (!types.includes(REVIEW_CAMERA_DRAG_TYPE) &&
          !types.includes(REVIEW_LAYOUT_DRAG_TYPE)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect =
        types.includes(REVIEW_CAMERA_DRAG_TYPE) ? "move" : "copy";
    });
    wall.addEventListener("drop", event => {
      const types = Array.from(event.dataTransfer?.types ?? []);
      const cell = event.composedPath().find(node =>
        node?.classList?.contains("review-layout-cell"));
      if (types.includes(REVIEW_LAYOUT_DRAG_TYPE)) {
        event.preventDefault();
        this.setReviewLayout(event.dataTransfer.getData(REVIEW_LAYOUT_DRAG_TYPE));
      } else if (types.includes(REVIEW_CAMERA_DRAG_TYPE) && cell && !cell.hidden) {
        event.preventDefault();
        this.assignCameraToSlot(
          event.dataTransfer.getData(REVIEW_CAMERA_DRAG_TYPE),
          Number(cell.dataset.reviewSlot)
        );
      }
    });
  }

  renderWhenControls() {
    const content = this._root?.querySelector(".review-when-controls");
    if (!content) return;
    content.replaceChildren();
    this.ensureReviewRange();
    for (const endpoint of ["from", "to"]) {
      const label = this._document.createElement("label");
      label.className = "review-range-field";
      const caption = this._document.createElement("span");
      caption.textContent = endpoint === "from" ? "From" : "To";
      const input = this._document.createElement("input");
      input.type = "text";
      input.className = `review-range-picker review-${endpoint}-picker`;
      input.setAttribute("aria-label", `Review ${endpoint} date and time`);
      input.addEventListener("keydown", event => {
        if (event.key === "Enter" && this.isReviewRangeDirty()) this.applyReviewRange();
      });
      label.append(caption, input);
      content.appendChild(label);
      if (typeof this._datePickerFactory === "function") {
        this._datePickers[endpoint] = this._datePickerFactory(input, {
          enableTime: true,
          time_24hr: true,
          minuteIncrement: 1,
          altInput: true,
          altInputClass: "review-range-picker",
          altFormat: "m/d/Y H:i",
          dateFormat: "Y-m-d H:i",
          allowInput: true,
          disableMobile: true,
          defaultDate: pickerDateForEpoch(this._draftReviewRange[endpoint], this.timeZone),
          appendTo: this._root,
          onChange: dates => {
            if (dates[0] instanceof Date) {
              this.setReviewRangeEndpoint(
                endpoint,
                pickerDateToEpoch(dates[0], this.timeZone)
              );
            }
          }
        });
      }
      const directField = this._document.createElement("div");
      directField.className = "review-range-field review-direct-time-row";
      const directCaption = this._document.createElement("span");
      directCaption.setAttribute("aria-hidden", "true");
      directField.appendChild(directCaption);
      const direct = this._document.createElement("div");
      direct.className = "review-direct-time";
      for (const part of ["hour", "minute"]) {
        const field = this._document.createElement("label");
        field.className = "review-direct-time-field";
        const caption = this._document.createElement("span");
        caption.textContent = part[0].toUpperCase() + part.slice(1);
        const select = this._document.createElement("select");
        select.className = `review-time-${part}`;
        select.setAttribute("aria-label", `Review ${endpoint} ${part}`);
        const max = part === "hour" ? 23 : 59;
        for (let value = 0; value <= max; value += 1) {
          const option = this._document.createElement("option");
          option.value = String(value);
          option.textContent = String(value).padStart(2, "0");
          select.appendChild(option);
        }
        select.addEventListener("change", () => this.setReviewTimePart(endpoint, part, select.value));
        field.append(caption, select);
        direct.appendChild(field);
      }
      directField.appendChild(direct);
      content.appendChild(directField);
    }
    const applyField = this._document.createElement("div");
    applyField.className = "review-range-field review-range-apply-field";
    const applyCaption = this._document.createElement("span");
    applyCaption.setAttribute("aria-hidden", "true");
    applyField.appendChild(applyCaption);
    const apply = this._document.createElement("button");
    apply.type = "button";
    apply.className = "review-when-apply";
    apply.textContent = "Apply";
    apply.setAttribute("aria-label", "Apply Review investigation window");
    apply.addEventListener("click", () => this.applyReviewRange());
    applyField.appendChild(apply);
    content.appendChild(applyField);
    this.updateWhenControls();
  }

  cleanupDatePicker() {
    for (const endpoint of ["from", "to"]) {
      this._datePickers[endpoint]?.destroy();
      this._datePickers[endpoint] = null;
    }
  }

  updateWhenControls() {
    this.ensureReviewRange();
    for (const endpoint of ["from", "to"]) {
      const input = this._root?.querySelector(`.review-${endpoint}-picker`);
      const value = pickerDateForEpoch(this._draftReviewRange[endpoint], this.timeZone);
      if (this._datePickers[endpoint]) {
        this._datePickers[endpoint].setDate(value, false);
      } else if (input) {
        input.value = new Intl.DateTimeFormat("en-US", {
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", hourCycle: "h23",
        }).format(value);
      }
      const date = pickerDateForEpoch(this._draftReviewRange[endpoint], this.timeZone);
      const hour = this._root?.querySelector(`.review-${endpoint}-picker`)?.closest(".review-range-field")
        ?.nextElementSibling;
      const hourSelect = hour?.querySelector(".review-time-hour");
      const minuteSelect = hour?.querySelector(".review-time-minute");
      if (hourSelect) hourSelect.value = String(date.getHours());
      if (minuteSelect) minuteSelect.value = String(date.getMinutes());
    }
    const apply = this._root?.querySelector(".review-when-apply");
    if (apply) {
      const dirty = this.isReviewRangeDirty();
      apply.disabled = !dirty;
      apply.classList.toggle("dirty", dirty);
      apply.setAttribute("aria-disabled", String(!dirty));
    }
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
    if (this._rhsMode === "timeline") {
      content.innerHTML = this.renderTimeline();
      return;
    }
    const title = this._rhsMode[0].toUpperCase() + this._rhsMode.slice(1);
    content.innerHTML = `<div class="review-placeholder"><strong>${title}</strong><span>Foundation placeholder</span><small>Newest / Now at top<br>Earlier time runs downward</small></div>`;
  }

  renderTimeline() {
    this.ensureReviewRange();
    const range = this._reviewRange;
    const format = epoch => new Intl.DateTimeFormat(undefined, {
      timeZone: this.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(new Date(epoch * 1000));
    const ticks = Array.from({ length: 5 }, (_, index) => {
      const epoch = range.to - ((range.to - range.from) * index / 4);
      return `<div class="review-timeline-tick" style="top:${index * 25}%"><span>${format(epoch)}</span></div>`;
    }).join("");
    let body = "";
    if (this._timeline.status === "loading") body = "<div class=\"review-timeline-message\">Loading activity…</div>";
    else if (this._timeline.status === "error") body = `<div class="review-timeline-message error">${this._timeline.error}</div>`;
    else if (this._timeline.items.length === 0) body = "<div class=\"review-timeline-message\">No activity in this range</div>";
    else body = this._timeline.items.map(item => {
      const top = reviewTimelineMarkerTop(item.start_time, range) * 100;
      const camera = escapeViewerHtml(item.camera_id);
      const type = escapeViewerHtml(item.type);
      return `<div class="review-timeline-marker" style="top:${top}%" title="${camera}: ${type}"><span>${camera}</span></div>`;
    }).join("");
    return `<div class="review-timeline" aria-label="Review activity timeline"><div class="review-timeline-axis">${ticks}${body}</div><div class="review-timeline-endpoints"><span>${format(range.to)}</span><span>${format(range.from)}</span></div></div>`;
  }

  renderMediaArea() {
    if (!this._root) return;
    for (const panel of this._mediaPanels.values()) panel.remove();
    this._mediaPanels.clear();
    this.syncMediaPanels();
    this.updateTransport();
    this.updateDiagnostics();
  }

  createCameraPanel(camera) {
    const panel = this._document.createElement("section");
    panel.className = "review-camera-panel";
    panel.dataset.camera = camera.name;
    panel.draggable = true;
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
      video.playbackRate = this._playbackSpeed;
      if (player) player.video = video;
      media.appendChild(video);
      const status = this._document.createElement("div");
      status.className = "review-camera-status";
      status.textContent = player?.message ?? "Preparing recording...";
      if (player) player.statusElement = status;
      media.appendChild(status);
    }
    panel.append(heading, media);
    panel.addEventListener("dragstart", event => {
      if (!event.dataTransfer) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(REVIEW_CAMERA_DRAG_TYPE, camera.name);
    });
    panel.addEventListener("dblclick", event => {
      if (this.currentLayout.primary && panel.classList.contains("secondary") &&
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
    const wall = this._root?.querySelector(".review-camera-wall");
    if (!wall) return;
    const selected = new Set(this._selectedCameraNames);
    for (const [name, panel] of this._mediaPanels) {
      if (!selected.has(name)) {
        panel.remove();
        this._mediaPanels.delete(name);
      }
    }
    wall.querySelectorAll(".review-empty-state").forEach(empty => empty.remove());
    for (const cellDefinition of this.currentLayout.cells) {
      const slot = cellDefinition.slot;
      const cell = wall.querySelector(`[data-review-slot="${slot}"]`);
      const name = this._reviewAssignments[slot];
      const camera = this._cameras.find(candidate => candidate.name === name);
      if (!cell || !camera) continue;
      let panel = this._mediaPanels.get(camera.name);
      if (!panel) {
        panel = this.createCameraPanel(camera);
        this._mediaPanels.set(camera.name, panel);
      }
      panel.classList.toggle("primary", slot === 0);
      panel.classList.toggle("secondary", slot !== 0);
      cell.appendChild(panel);
    }
    if (this._selectedCameraNames.length === 0) {
      const firstSlot = this.currentLayout.cells[0]?.slot;
      const firstCell = wall.querySelector(`[data-review-slot="${firstSlot}"]`);
      if (firstCell) {
        const empty = this._document.createElement("div");
        empty.className = "review-empty-state";
        empty.textContent = "Select or drag cameras into Review cells.";
        firstCell.appendChild(empty);
      }
    }
  }

  applyReviewLayout() {
    const wall = this._root?.querySelector(".review-camera-wall");
    if (!wall) return;
    const layout = this.currentLayout;
    const definitions = new Map(layout.cells.map(cell => [cell.slot, cell]));
    wall.dataset.reviewLayout = this._reviewLayout;
    wall.style.gridTemplateColumns = layout.columns;
    wall.style.gridTemplateRows = layout.rows;
    wall.querySelectorAll(".review-layout-cell").forEach(cell => {
      const definition = definitions.get(Number(cell.dataset.reviewSlot));
      cell.hidden = !definition;
      cell.style.gridColumn = definition?.column ?? "";
      cell.style.gridRow = definition?.row ?? "";
      cell.classList.toggle("review-primary-cell", definition?.slot === 0 && layout.primary === true);
    });
    this.syncMediaPanels();
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
    if (now) now.disabled = false;
    const speed = this._transportRoot?.querySelector(".review-speed-select");
    if (speed) speed.value = String(this._playbackSpeed);
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
      player.video.playbackRate = this._playbackSpeed;
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
        player.video.playbackRate = this._playbackSpeed;
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
      this.includeReviewTarget(targetEpoch);
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
        ? playable.map(player => {
          player.video.playbackRate = this._playbackSpeed;
          return Promise.resolve(player.video.play());
        })
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
