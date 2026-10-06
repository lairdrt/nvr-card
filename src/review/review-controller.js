import "../vendor/flatpickr/flatpickr-4.6.13.min.js";
import {
  epochToMedia,
  mediaToEpoch,
  validateHistoricalPresentation
} from "./historical-presentation.js";

const REVIEW_RANGE_BEFORE_SECONDS = 15;
const REVIEW_RANGE_AFTER_SECONDS = 120;
const REVIEW_SIGNED_PATH_EXPIRES_SECONDS = 900;
const REVIEW_HLS_SCRIPT_PATH = "/local/nvr-card/src/vendor/hls.min.js";
const REVIEW_HLS_PROMISE = Symbol.for("nvr.review.hlsScript");
const REVIEW_KNOWN_TARGET = "2026-09-08T14:00:00-07:00";
const REVIEW_SLOT_CAPACITY = 16;
const REVIEW_DEFAULT_RANGE_SECONDS = 3600;
const REVIEW_MIN_ZOOM_SECONDS = 3600;
const REVIEW_MAX_ZOOM_SECONDS = 24 * 3600;
const REVIEW_CAMERA_DRAG_TYPE = "application/x-nvr-camera";
const REVIEW_LAYOUT_DRAG_TYPE = "application/x-nvr-layout";
const REVIEW_FILTERS = Object.freeze(["person", "car", "animal", "package"]);
const REVIEW_QUERY_DEBOUNCE_MS = 400;
const REVIEW_MEDIA_READY_TIMEOUT_MS = 15000;
const REVIEW_AVAILABILITY_WINDOW_SECONDS = 2 * 60 * 60;
const REVIEW_AVAILABILITY_EDGE_REFRESH_SECONDS = 30;
const HAVE_FUTURE_DATA = 3;
const CONTINUOUS_HANDOFF_PROTOTYPE_CAMERA = "Garage";
const CONTINUOUS_HANDOFF_PROTOTYPE_RATES = Object.freeze([0.25, 1]);
const CONTINUOUS_HANDOFF_PROTOTYPE_EVENT_LIMIT = 256;
const REVIEW_FAILURE_LIMIT = 16;
const REVIEW_OUTCOME_LIMIT = 8;
const REVIEW_FAILURE_STAGES = new Set([
  "availability", "prepare", "sign", "manifest", "seekable", "seek",
  "landing", "play", "continuation", "media"
]);
const REVIEW_FAILURE_REASONS = new Set([
  "authoritative_recording_gap", "availability_api_failure",
  "camera_prepare_failed", "prepare_reported_no_recording",
  "manifest_sign_failure", "manifest_failure", "seekable_or_media_readiness_failure",
  "mapped_seek_failure", "initial_landing_failed", "initial_availability_deadline",
  "initial_preparation_deadline", "initial_landing_deadline",
  "post_seek_playability_failure", "play_rejected", "play_timeout",
  "play_not_running", "rejoin_play_rejected", "rejoin_play_timeout",
  "rejoin_play_not_running", "continuous_presentation_exhausted",
  "unexpected_media_end", "hls_fatal", "media_error",
  "missing_frigate_camera_mapping", "shared_initialization_failure",
  "rejoin_target_moved"
]);
const REVIEW_HLS_TYPES = new Set(["networkError", "mediaError", "otherError"]);
const REVIEW_HLS_DETAILS = new Set([
  "manifestLoadError", "manifestLoadTimeOut", "manifestParsingError",
  "levelLoadError", "levelLoadTimeOut", "levelParsingError",
  "fragLoadError", "fragLoadTimeOut", "fragParsingError",
  "keyLoadError", "keyLoadTimeOut", "bufferAppendError",
  "bufferStalledError", "bufferFullError", "internalException"
]);
const REVIEW_LANDING_STATES = new Set([
  "not_started", "pending", "verified", "unsupported", "unmapped_frame", "callback_failed"
]);
const REVIEW_PLAY_STATES = new Set([
  "not_attempted", "fulfilled", "rejected", "timeout", "not_running"
]);
const finiteReviewNumber = value => typeof value === "number" && Number.isFinite(value) ? value : null;
function safeReviewHlsError(data) {
  const status = data?.response?.code;
  return {
    type: REVIEW_HLS_TYPES.has(data?.type) ? data.type : null,
    detail: REVIEW_HLS_DETAILS.has(data?.details) ? data.details : null,
    fatal: data?.fatal === true,
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null
  };
}
export const REVIEW_PLAYBACK_SPEEDS = Object.freeze([0.25, 0.5, 0.75, 1, 2, 4, 8, 16]);
export function formatNvrClockTime(value, timeZone, format = "24-hour", kind = "time") {
  const options = {
    ...(timeZone ? { timeZone } : {}),
    ...(kind === "footer" ? { weekday: "short", month: "short", day: "numeric" } : {}),
    ...(kind === "when" ? { year: "numeric", month: "2-digit", day: "2-digit" } : {}),
    ...(kind === "diagnostic" ? { year: "numeric", month: "short", day: "numeric" } : {}),
    hour: format === "12-hour" ? "numeric" : "2-digit",
    minute: "2-digit",
    ...(["footer", "diagnostic"].includes(kind) ? { second: "2-digit" } : {}),
    ...(format === "12-hour" ? { hour12: true } : { hourCycle: "h23" })
  };
  return new Intl.DateTimeFormat("en-US", options).format(value instanceof Date ? value : new Date(value * 1000));
}
export const REVIEW_TIMELINE_CAMERA_COLORS = Object.freeze([
  "#68c5e8", "#ef9b5f", "#77cf83", "#d58be8",
  "#f0cf65", "#5ed0bd", "#ee7896", "#8fa9f4",
  "#b9d873", "#dd8fca", "#7bc3a4", "#f0a86f",
  "#71b7de", "#c69ae7", "#98c96a", "#e88778"
]);

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

export function reviewTimelineMarkerGeometry(item, range) {
  const start = Number(item?.start_time);
  if (!Number.isFinite(start) || !(range?.from < range?.to)) return null;
  const candidateEnd = item?.end_time == null ? start : Number(item.end_time);
  const end = Number.isFinite(candidateEnd) && candidateEnd >= start
    ? candidateEnd
    : start;
  const top = reviewTimelineMarkerTop(end, range);
  const bottom = reviewTimelineMarkerTop(start, range);
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  return {
    top,
    height: Math.max(0, bottom - top),
    startEpoch: start,
    endEpoch: end
  };
}

export function reviewTimelineEpochFromCoordinate(clientY, contentTop, contentHeight, range) {
  const y = Number(clientY);
  const top = Number(contentTop);
  const height = Number(contentHeight);
  if (!Number.isFinite(y) || !Number.isFinite(top) || !(height > 0) ||
      !(range?.from < range?.to)) return null;
  const fraction = Math.min(1, Math.max(0, (y - top) / height));
  return range.to - fraction * (range.to - range.from);
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

export function reviewEventNavigationTimestamps(items, selectedCameraIds, range = null) {
  const cameras = new Set(selectedCameraIds);
  const from = Number(range?.from);
  const to = Number(range?.to);
  return [...new Set(items.filter(item => cameras.has(item?.camera_id))
    .filter(item => item?.start_time != null)
    .map(item => Number(item.start_time))
    .filter(start => Number.isFinite(start) &&
      (!Number.isFinite(from) || start >= from) &&
      (!Number.isFinite(to) || start <= to)))].sort((left, right) => left - right);
}

export function reviewEventNavigationTargets(timestamps, position) {
  if (position == null) return { previous: null, next: null };
  const target = Number(position);
  if (!Number.isFinite(target)) return { previous: null, next: null };
  let previous = null;
  let next = null;
  for (const timestamp of timestamps) {
    if (timestamp < target) previous = timestamp;
    else if (timestamp > target) {
      next = timestamp;
      break;
    }
  }
  return { previous, next };
}

export function normalizeRecordingAvailability(value, expectedCamera) {
  if (!value || typeof value !== "object" || value.camera !== expectedCamera ||
      !Number.isFinite(Number(value.requested_start)) ||
      !Number.isFinite(Number(value.requested_end)) ||
      !Array.isArray(value.coverage)) {
    throw new Error("FrigateMax returned invalid recording availability.");
  }
  const requestedStart = Number(value.requested_start);
  const requestedEnd = Number(value.requested_end);
  if (!(requestedStart < requestedEnd) ||
      requestedEnd - requestedStart > REVIEW_AVAILABILITY_WINDOW_SECONDS + 0.001) {
    throw new Error("FrigateMax returned invalid recording availability.");
  }
  const coverage = value.coverage.map(interval => {
    const start = Number(interval?.start);
    const end = Number(interval?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
        start < requestedStart || end > requestedEnd) {
      throw new Error("FrigateMax returned invalid recording availability.");
    }
    return { start, end };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < coverage.length; index += 1) {
    if (coverage[index].start < coverage[index - 1].end) {
      throw new Error("FrigateMax returned overlapping recording availability.");
    }
  }
  return Object.freeze({
    camera: expectedCamera,
    requested_start: requestedStart,
    requested_end: requestedEnd,
    coverage: Object.freeze(coverage.map(interval => Object.freeze(interval)))
  });
}

export function inspectRecordingAvailability(availability, epoch) {
  const target = Number(epoch);
  const insideWindow = Number.isFinite(target) &&
    target >= Number(availability?.requested_start) &&
    target < Number(availability?.requested_end);
  if (!insideWindow) {
    return Object.freeze({ insideWindow: false, containing: null, previousEnd: null, nextStart: null });
  }
  let containing = null;
  let previousEnd = null;
  let nextStart = null;
  for (const interval of availability.coverage ?? []) {
    if (interval.start <= target && target < interval.end) {
      containing = interval;
      break;
    }
    if (interval.end <= target) previousEnd = interval.end;
    else if (interval.start > target) {
      nextStart = interval.start;
      break;
    }
  }
  if (containing) {
    const index = availability.coverage.indexOf(containing);
    previousEnd = index > 0 ? availability.coverage[index - 1].end : null;
    nextStart = index + 1 < availability.coverage.length
      ? availability.coverage[index + 1].start : null;
  }
  return Object.freeze({
    insideWindow: true,
    containing: containing ? Object.freeze({ ...containing }) : null,
    previousEnd,
    nextStart
  });
}

export function buildRecordingAvailabilityWindow(targetEpoch, bounds = null) {
  const target = Number(targetEpoch);
  if (!Number.isFinite(target)) throw new Error("Recording availability target must be finite.");
  let start = target - REVIEW_AVAILABILITY_WINDOW_SECONDS / 2;
  let end = target + REVIEW_AVAILABILITY_WINDOW_SECONDS / 2;
  const lower = Number(bounds?.from);
  const upper = Number(bounds?.to);
  if (Number.isFinite(lower) && Number.isFinite(upper) && lower < upper) {
    if (upper - lower <= REVIEW_AVAILABILITY_WINDOW_SECONDS) {
      start = lower;
      end = upper;
    } else if (start < lower) {
      start = lower;
      end = lower + REVIEW_AVAILABILITY_WINDOW_SECONDS;
    } else if (end > upper) {
      end = upper;
      start = upper - REVIEW_AVAILABILITY_WINDOW_SECONDS;
    }
  }
  return Object.freeze({ start, end });
}

export function planContinuousHandoffPrototype(activeTiming, availability) {
  const boundary = Number(activeTiming?.requested_end);
  if (!Number.isFinite(boundary)) {
    throw new Error("The active VOD has no authoritative requested endpoint.");
  }
  const range = buildReviewRange(boundary);
  const interval = availability?.coverage?.find(candidate =>
    candidate.start <= range.start && candidate.end >= range.end
  ) ?? null;
  return Object.freeze({
    allowed: Boolean(interval),
    boundary,
    range,
    coverage: interval ? Object.freeze({ ...interval }) : null
  });
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

function historicalEpochFromMedia(player, mediaTime) {
  if (player?.timing?.time_map) {
    try {
      return mediaToEpoch(player.timing, mediaTime).epoch;
    } catch {
      return null;
    }
  }
  const origin = Number(player?.timing?.effective_absolute_origin);
  const media = Number(mediaTime);
  return Number.isFinite(origin) && Number.isFinite(media) ? origin + media : null;
}

export class ReviewController {
  static VIEWER_LAYOUTS = VIEWER_LAYOUTS;
  static buildViewerCameraMenuMarkup = buildViewerCameraMenuMarkup;
  static buildViewerLayoutMenuMarkup = buildViewerLayoutMenuMarkup;
  static normalizeVideoStateBadgePosition(value) {
    return ["top-left", "top-right", "bottom-left", "bottom-right"].includes(value)
      ? value : "bottom-left";
  }

  constructor({
    documentRef = globalThis.document,
    loadHls = loadReviewHls,
    now = () => performance.now(),
    wallClock = () => Date.now(),
    datePickerFactory = globalThis.flatpickr,
    queryDebounceMs = REVIEW_QUERY_DEBOUNCE_MS,
    mediaReadyTimeoutMs = REVIEW_MEDIA_READY_TIMEOUT_MS,
    scheduleInitialDeadline = (callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    }
  } = {}) {
    this._document = documentRef;
    this._loadHls = loadHls;
    this._datePickerFactory = datePickerFactory;
    this._datePickers = { from: null, to: null };
    this._wallClock = wallClock;
    this._timeFormat = "24-hour";
    this._root = null;
    this._transportRoot = null;
    this._reviewViewsAdapter = null;
    this._reviewViewsBody = null;
    this._hass = null;
    this._cameras = [];
    this._selectedCameraNames = [];
    this._primaryCameraName = null;
    this._reviewLayout = "primary12";
    this._reviewAssignments = new Array(REVIEW_SLOT_CAPACITY).fill(null);
    this._selectedReviewCamera = null;
    this._selectedReviewLayout = null;
    this._desiredReviewQuery = null;
    this._displayedReviewQuery = null;
    this._selectionInitialized = false;
    this._active = false;
    this._suspended = false;
    this._presentationMode = "live";
    this._videoStateBadgePosition = "bottom-left";
    this._reviewPosition = null;
    this._generation = 0;
    this._reviewRequestId = 0;
    this._cameraWorkSequence = 0;
    this._cameraTransitionSequence = 0;
    this._presentationSequence = 0;
    this._assignmentRevision = 0;
    this._diagnosticObjectSequence = 0;
    this._historicalPlayers = new Map();
    this._historicalRange = null;
    this._historicalPlaybackRange = null;
    this._historicalBoundaryTimer = null;
    this._historicalPreparing = false;
    this._playRequested = false;
    this._initialDeadlineCancel = null;
    this._historicalStatus = "";
    this._mediaPanels = new Map();
    this._diagnosticTimer = null;
    this._availabilityEvaluationPromise = null;
    this._availabilityEvaluationPending = false;
    this._debugEnabled = false;
    this._historicalSyncDiagnosticsEnabled = null;
    this._syncReports = [];
    this._syncSession = null;
    this._syncSequence = 0;
    this._reviewFailures = [];
    this._reviewOutcomes = [];
    this._reviewFailureSequence = 0;
    this._continuousHandoffPrototypeReport = null;
    this._continuousHandoffPrototypeRun = null;
    this._now = now;
    this._rhsMode = "timeline";
    this._selectedFilters = new Set();
    this._sectionExpanded = {
      cameras: false, layouts: false, views: false, when: false, filters: false, diagnostics: false
    };
    this._reviewRange = null;
    this._desiredReviewRange = null;
    this._whenDraftRange = null;
    this._queryRefreshCount = 0;
    this._queryGeneration = 0;
    this._queryTimer = null;
    this._whenOutsideClickHandler = null;
    this._queryDebounceMs = queryDebounceMs;
    this._mediaReadyTimeoutMs = mediaReadyTimeoutMs;
    this._scheduleInitialDeadline = scheduleInitialDeadline;
    this._timeline = {
      status: "idle", refreshing: false, items: [], error: null, queryRange: null
    };
    this._playbackSpeed = 1;
    this._timelineDrag = null;
    this._timelineRefreshDeferred = false;
    this._timelineClickSuppressionTimer = null;
    this._sceneExperiment = null;
    this.clock = new ReviewClock(now);
  }

  get timeZone() {
    return this._hass?.config?.time_zone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  get reviewPosition() {
    if (this._timelineDrag) return this._timelineDrag.previewEpoch;
    return this._presentationMode === "historical" && Number.isFinite(this.clock.absoluteTime)
      ? this.clock.absoluteTime : this._reviewPosition;
  }

  constrainReviewPositionToDisplayedRange() {
    if (this._presentationMode === "historical") return;
    const range = this._displayedReviewQuery?.range;
    if (!(range?.from < range?.to)) return;
    const position = Number.isFinite(this._reviewPosition)
      ? this._reviewPosition : this._wallClock() / 1000;
    this._reviewPosition = Math.min(range.to, Math.max(range.from, position));
    this.updateClockDisplay();
  }

  setTimeFormat(format) {
    if (format !== "12-hour" && format !== "24-hour") {
      throw new Error("time.format must be 12-hour or 24-hour.");
    }
    if (this._timeFormat === format) return;
    if (this._whenDraftRange) this.capturePendingWhenControls();
    this._timeFormat = format;
    if (this._active && !this._suspended && this._root) {
      this.cleanupDatePicker();
      this.renderWhenControls();
      this.updateRhs();
      this.updateClockDisplay();
    }
  }

  get todayKey() {
    return getCivilDayKey(Date.now(), this.timeZone);
  }

  get state() {
    this.ensureReviewQuery();
    const desiredReviewQuery = this.getDesiredReviewQuery();
    return {
      active: this._active,
      presentationMode: this._presentationMode,
      selectedCameraNames: [...this._selectedCameraNames],
      primaryCameraName: this._primaryCameraName,
      reviewLayout: this._reviewLayout,
      reviewAssignments: [...this._reviewAssignments],
      reviewClockAbsolute: this.clock.absoluteTime,
      reviewPositionEpoch: this.reviewPosition,
      reviewRange: this._reviewRange ? { ...this._reviewRange } : null,
      desiredReviewRange: this._desiredReviewRange ? { ...this._desiredReviewRange } : null,
      whenDraftRange: this._whenDraftRange ? { ...this._whenDraftRange } : null,
      desiredReviewQuery,
      displayedReviewQuery: this.cloneReviewQuery(this._displayedReviewQuery),
      timeline: {
        status: this._timeline.status,
        refreshing: this._timeline.refreshing,
        items: [...this._timeline.items],
        queryRange: this._timeline.queryRange ? { ...this._timeline.queryRange } : null
      },
      playbackSpeed: this._playbackSpeed,
      historicalPreparing: this._historicalPreparing,
      historicalStatus: this._historicalStatus,
      reviewRequestId: this._reviewRequestId,
      assignmentRevision: this._assignmentRevision,
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
      this.syncSelectionFromAssignments();
      this._selectionInitialized = true;
    } else {
      const enabled = new Set(enabledNames);
      this._reviewAssignments = this._reviewAssignments.map(name =>
        enabled.has(name) ? name : null);
      this._assignmentRevision += 1;
      this.syncSelectionFromAssignments();
      if (this._desiredReviewQuery) {
        this._desiredReviewQuery.cameraNames = this.canonicalCameraNames(
          this._desiredReviewQuery.cameraNames.filter(name => enabled.has(name))
        );
      }
    }
    if (this._active && !this._suspended) {
      this.returnToLive();
    }
  }

  setDebug(enabled) {
    const next = enabled === true;
    if (next === this._debugEnabled) return;
    this._debugEnabled = next;
    if (!(this._historicalSyncDiagnosticsEnabled ?? next)) {
      this.endSyncReport("diagnostics_disabled");
    }
    if (this._active && !this._suspended) this.render();
  }

  setHistoricalSyncDiagnostics(enabled) {
    this._historicalSyncDiagnosticsEnabled = enabled === true;
    if (!this._historicalSyncDiagnosticsEnabled) {
      this.endSyncReport("diagnostics_disabled");
    }
    return this._historicalSyncDiagnosticsEnabled;
  }

  // Explicit development retrieval. Always return a detached, JSON-compatible snapshot.
  getHistoricalSyncReports() {
    return JSON.parse(JSON.stringify(this._syncReports));
  }

  getLatestHistoricalSyncReport() {
    return JSON.parse(JSON.stringify(this._syncReports.at(-1) ?? null));
  }

  getRecentReviewFailures() {
    return [...this._reviewFailures, ...this._reviewOutcomes]
      .sort((left, right) => right.sequence - left.sequence)
      .map(({ record }) => JSON.parse(JSON.stringify(record)));
  }

  recordReviewFailure(player, { reason, outcome = "failure", stage = null,
    targetEpoch = null, play = null, occurrence = null } = {}) {
    if (!player?.camera || !REVIEW_FAILURE_REASONS.has(reason) ||
        !["failure", "no_coverage", "retained_after_failure", "normal_terminal"].includes(outcome)) return;
    const target = finiteReviewNumber(targetEpoch) ??
      finiteReviewNumber(player.transition?.targetEpoch) ??
      finiteReviewNumber(player.lastTargetEpoch);
    const inspected = this.inspectPlayerAvailability(player, target);
    const coverage = inspected.containing ? "covered" : inspected.insideWindow ? "gap" : "unknown";
    const video = player.video;
    const readyState = video?.readyState;
    const errorCode = video?.error?.code;
    const hls = player.reviewHlsError;
    const held = Boolean(player.heldCanvas && !player.heldCanvas.hidden &&
      Number.isFinite(player.heldFrameEpoch));
    const transitionId = Number.isSafeInteger(player.transition?.token)
      ? player.transition.token : null;
    const record = {
      atMs: this._wallClock(), camera: player.camera.name,
      requestId: Number.isSafeInteger(player.requestId) ? player.requestId : null,
      transitionId,
      targetEpoch: target,
      resolvedEpoch: player.reviewTimingPrepared === true
        ? finiteReviewNumber(player.resolvedEpoch) : null,
      stage: REVIEW_FAILURE_STAGES.has(stage) ? stage :
        REVIEW_FAILURE_STAGES.has(player.reviewStage) ? player.reviewStage : null,
      reason, outcome,
      stateBefore: ["preparing", "participating", "unavailable", "failed"]
        .includes(player.lifecycleState) ? player.lifecycleState : null,
      coverage,
      hasTimingMap: player.reviewTimingPrepared === true,
      seekTargetSeconds: player.reviewTimingPrepared === true
        ? finiteReviewNumber(player.seek) : null,
      video: {
        readyState: Number.isInteger(readyState) && readyState >= 0 && readyState <= 4
          ? readyState : null,
        seekable: typeof video?.seekable?.length === "number"
          ? video.seekable.length > 0 : null,
        errorCode: Number.isInteger(errorCode) && errorCode >= 1 && errorCode <= 4
          ? errorCode : null
      },
      landing: REVIEW_LANDING_STATES.has(player.reviewLanding)
        ? player.reviewLanding : "not_started",
      frameEpoch: held ? player.heldFrameEpoch :
        player.initialPlacement?.verifiedFrame === true &&
          player.initialPlacement.requestId === player.requestId
          ? finiteReviewNumber(player.initialPlacement.landedEpoch) : null,
      play: REVIEW_PLAY_STATES.has(play) ? play :
        REVIEW_PLAY_STATES.has(player.reviewPlay) ? player.reviewPlay : "not_attempted",
      hls: hls ? {
        type: REVIEW_HLS_TYPES.has(hls.type) ? hls.type : null,
        detail: REVIEW_HLS_DETAILS.has(hls.detail) ? hls.detail : null,
        fatal: hls.fatal === true,
        httpStatus: Number.isInteger(hls.httpStatus) && hls.httpStatus >= 100 &&
          hls.httpStatus <= 599 ? hls.httpStatus : null
      } : null,
      validHeldFrame: held,
      otherParticipatingCount: [...this._historicalPlayers.values()].filter(candidate =>
        candidate !== player && candidate.lifecycleState === "participating").length
    };
    const category = outcome === "no_coverage" || outcome === "normal_terminal"
      ? this._reviewOutcomes : this._reviewFailures;
    const key = [player.camera.name, player.requestId,
      occurrence ?? transitionId ?? player.transitionToken ?? player.lifecycleRevision ?? player.presentationId,
      reason, outcome].join("|");
    if (category.some(entry => entry.key === key)) return;
    category.push({ key, sequence: ++this._reviewFailureSequence, record });
    if (category.length > (category === this._reviewFailures
      ? REVIEW_FAILURE_LIMIT : REVIEW_OUTCOME_LIMIT)) category.shift();
  }

  startSyncReport(generation, targetEpoch, cameras, source) {
    if (!(this._historicalSyncDiagnosticsEnabled ?? this._debugEnabled)) return null;
    const query = this._displayedReviewQuery;
    const report = {
      id: ++this._syncSequence, generation, requestId: this._reviewRequestId,
      assignmentRevision: this._assignmentRevision,
      displayedQueryGeneration: this._queryGeneration,
      source, selectedEpoch: targetEpoch,
      selectedLocalTime: formatNvrClockTime(targetEpoch, this.timeZone, this._timeFormat, "diagnostic"),
      displayedFrom: query?.range?.from ?? null, displayedTo: query?.range?.to ?? null,
      playbackRate: this._playbackSpeed, startedAtMs: this._now(),
      disposition: "preparing", terminationReason: null,
      cameras: Object.fromEntries(cameras.map(camera => [camera.name, {
        logicalId: camera.name, generation, requestedEpoch: targetEpoch,
        status: "preparing", lifecycleState: "preparing", reason: null,
        availability: null, transition: null, boundaryEvents: [],
        stages: {}, firstAdvance: null, play: null
      }])),
      barrier: null, samples: {}, summary: null, identityEvents: []
    };
    this._syncReports.push(report);
    if (this._syncReports.length > 8) this._syncReports.shift();
    this._syncSession = report;
    return report;
  }

  syncCamera(report, generation, player) {
    return report && this._syncSession === report && this.isCurrentCameraWork(player, generation)
      ? report.cameras[player.camera.name] : null;
  }

  syncStage(report, generation, player, stage) {
    const camera = this.syncCamera(report, generation, player);
    if (camera && camera.stages[stage] == null) camera.stages[stage] = this._now();
  }

  syncUnavailable(report, generation, player, reason) {
    const camera = this.syncCamera(report, generation, player);
    if (!camera) return;
    camera.status = "unavailable";
    camera.reason = reason;
  }

  syncSnapshot(players, report, atMs = this._now()) {
    const clockEpoch = this.clock.absoluteTime;
    const cameras = {};
    for (const player of players) {
      if (player.unavailable || !player.video || !player.timing) continue;
      const currentTime = Number(player.video.currentTime);
      if (!Number.isFinite(currentTime)) continue;
      const reconstructedEpoch = historicalEpochFromMedia(player, currentTime);
      if (!Number.isFinite(reconstructedEpoch)) continue;
      cameras[player.camera.name] = {
        atMs, currentTime, reconstructedEpoch, reviewClockEpoch: clockEpoch,
        errorSeconds: Number.isFinite(clockEpoch) ? reconstructedEpoch - clockEpoch : null
      };
    }
    const epochs = Object.values(cameras).map(camera => camera.reconstructedEpoch);
    return { atMs, cameras, maxInterCameraDeltaSeconds:
      epochs.length > 1 ? Math.max(...epochs) - Math.min(...epochs) : 0 };
  }

  syncTick(report, generation) {
    if (!report || this._syncSession !== report || generation !== this._generation ||
        this._presentationMode !== "historical") return;
    const barrier = report.barrier;
    if (!barrier) return;
    const now = this._now();
    const players = [...this._historicalPlayers.values()];
    for (const player of players) {
      const camera = report.cameras[player.camera.name];
      const baseline = barrier.snapshot.cameras[player.camera.name];
      if (!camera || camera.firstAdvance || !baseline || player.unavailable || !player.video) continue;
      const currentTime = Number(player.video.currentTime);
      if (Number.isFinite(currentTime) && currentTime > baseline.currentTime + 0.01) {
        const reconstructedEpoch = historicalEpochFromMedia(player, currentTime);
        if (!Number.isFinite(reconstructedEpoch)) continue;
        camera.firstAdvance = { atMs: now, currentTime, reconstructedEpoch,
          delayMs: now - barrier.atMs,
          reviewClockErrorSeconds: reconstructedEpoch - this.clock.absoluteTime };
      }
    }
    for (const seconds of [1, 5, 30]) {
      if (!report.samples[seconds] && now - barrier.atMs >= seconds * 1000) {
        report.samples[seconds] = this.syncSnapshot(players, report, now);
      }
    }
    this.updateSyncSummary(report);
    if (report.samples[30]) {
      for (const player of players) this.removeSyncListeners(player);
      this._syncSession = null;
    }
  }

  updateSyncSummary(report) {
    const cameras = Object.values(report.cameras);
    const numbers = values => values.length ? Math.max(...values.map(Math.abs)) : null;
    report.summary = {
      selectedEpoch: report.selectedEpoch, requested: cameras.map(camera => camera.logicalId),
      released: cameras.filter(camera => camera.status === "released").map(camera => camera.logicalId),
      unavailable: cameras.filter(camera => camera.status === "unavailable").map(camera => camera.logicalId),
      barrierDeltaSeconds: report.barrier?.snapshot.maxInterCameraDeltaSeconds ?? null,
      sampleDeltaSeconds: Object.fromEntries([1, 5, 30].map(second =>
        [second, report.samples[second]?.maxInterCameraDeltaSeconds ?? null])),
      largestSeekErrorSeconds: numbers(cameras.map(camera => camera.seekErrorSeconds).filter(Number.isFinite)),
      largestFirstAdvanceDelayMs: numbers(cameras.map(camera => camera.firstAdvance?.delayMs).filter(Number.isFinite)),
      disposition: report.disposition
    };
  }

  endSyncReport(reason) {
    const report = this._syncSession;
    if (!report) return;
    report.terminationReason = reason;
    if (report.disposition === "preparing") report.disposition = "stale/cancelled";
    this.updateSyncSummary(report);
    this._syncSession = null;
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

  setReviewViewsAdapter(adapter = null) {
    this._reviewViewsAdapter = adapter && typeof adapter.render === "function"
      ? adapter
      : null;
    this.renderReviewViews();
  }

  renderReviewViews() {
    if (!this._reviewViewsBody || !this._reviewViewsAdapter) return;
    this._reviewViewsAdapter.render(this._reviewViewsBody);
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
    this.cleanupTimelineInteraction();
    if (this._transportRoot) this._transportRoot.replaceChildren();
    this._root = root;
    this._transportRoot = transportRoot;
    if (this._root) this._root.hidden = !this._active;
    if (this._transportRoot) this._transportRoot.hidden = !this._active;
    if (this._active && !this._suspended) this.render();
  }

  unmount() {
    this.cleanupHistorical();
    this.cleanupTimelineInteraction();
    this.cancelScheduledReviewQuery();
    this.cleanupDatePicker();
    this.cleanupWhenInteraction();
    this._whenDraftRange = null;
    if (this._root) this._root.replaceChildren();
    if (this._transportRoot) this._transportRoot.replaceChildren();
    this._mediaPanels.clear();
    this._root = null;
    this._transportRoot = null;
    this._reviewViewsBody = null;
  }

  activate() {
    this._active = true;
    this._suspended = false;
    this._presentationMode = "live";
    this.clock.reset();
    this._reviewPosition = this._wallClock() / 1000;
    const initialQuery = this.ensureReviewQuery();
    this.constrainReviewPositionToDisplayedRange();
    if (this._root) {
      this._root.hidden = false;
      if (this._transportRoot) this._transportRoot.hidden = false;
      this.render();
      if (initialQuery) void this.refreshReviewQuery();
    }
  }

  deactivate() {
    this._active = false;
    this._presentationMode = "live";
    this.cleanupHistorical();
    this.cleanupTimelineInteraction();
    this.cancelScheduledReviewQuery();
    this.cleanupDatePicker();
    this.cleanupWhenInteraction();
    this._whenDraftRange = null;
    this.clock.reset();
    this._reviewPosition = null;
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
    this.cleanupTimelineInteraction();
    this.cancelScheduledReviewQuery();
    this.cleanupDatePicker();
    this.cleanupWhenInteraction();
    this._whenDraftRange = null;
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

  canonicalCameraNames(names) {
    const requested = new Set(Array.isArray(names) ? names : []);
    return this._cameras.map(camera => camera.name).filter(name => requested.has(name));
  }

  canonicalFilters(filters) {
    const requested = new Set(filters ?? []);
    return REVIEW_FILTERS.filter(name => requested.has(name));
  }

  captureReviewViewState() {
    const range = this._desiredReviewRange;
    if (!Object.hasOwn(VIEWER_LAYOUTS, this._reviewLayout) ||
        !Number.isFinite(range?.from) || !Number.isFinite(range?.to) ||
        !(range.from < range.to)) {
      return null;
    }
    const assignedCameras = this._reviewAssignments.map(name => {
      const camera = this._cameras.find(candidate => candidate.name === name);
      return typeof camera?.entity === "string" && camera.entity.trim()
        ? camera.entity.trim()
        : null;
    });
    return JSON.parse(JSON.stringify({
      version: 1,
      layout: this._reviewLayout,
      assignedCameras,
      when: {
        version: 1,
        kind: "absolute-range",
        from: range.from,
        to: range.to
      },
      filters: this.canonicalFilters(this._selectedFilters)
    }));
  }

  getReviewViewCaptureResult() {
    const state = this.captureReviewViewState();
    return state
      ? { result: "valid", state }
      : { result: "invalid", state: null, reason: "invalid_when_range" };
  }

  normalizeReviewViewState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        value.version !== 1 || typeof value.layout !== "string" ||
        !Object.hasOwn(VIEWER_LAYOUTS, value.layout) ||
        !Array.isArray(value.assignedCameras) ||
        !value.when || typeof value.when !== "object" ||
        Array.isArray(value.when) || value.when.version !== 1 ||
        value.when.kind !== "absolute-range" ||
        !Number.isFinite(value.when.from) || !Number.isFinite(value.when.to) ||
        !(value.when.from < value.when.to) || !Array.isArray(value.filters)) {
      return { result: "invalid", state: null };
    }

    const entityToName = new Map();
    for (const camera of this._cameras) {
      if (typeof camera?.entity !== "string" || !camera.entity.trim() ||
          typeof camera.name !== "string") continue;
      if (!entityToName.has(camera.entity.trim())) {
        entityToName.set(camera.entity.trim(), camera.name);
      }
    }
    let partial = value.assignedCameras.length !== REVIEW_SLOT_CAPACITY;
    const seenEntities = new Set();
    const staleCameras = [];
    const duplicateCameras = [];
    const assignedCameras = new Array(REVIEW_SLOT_CAPACITY).fill(null);
    for (let slot = 0; slot < REVIEW_SLOT_CAPACITY; slot += 1) {
      const entity = value.assignedCameras[slot];
      if (entity == null) continue;
      if (typeof entity !== "string" || !entity.trim() || !entityToName.has(entity.trim())) {
        partial = true;
        staleCameras.push(entity);
        continue;
      }
      const normalizedEntity = entity.trim();
      if (seenEntities.has(normalizedEntity)) {
        partial = true;
        duplicateCameras.push(normalizedEntity);
        continue;
      }
      seenEntities.add(normalizedEntity);
      assignedCameras[slot] = entityToName.get(normalizedEntity);
    }

    const requestedFilters = new Set();
    const unknownFilters = [];
    for (const filter of value.filters) {
      if (typeof filter !== "string" || !REVIEW_FILTERS.includes(filter)) {
        unknownFilters.push(filter);
        continue;
      }
      requestedFilters.add(filter);
    }
    if (unknownFilters.length > 0) partial = true;

    return {
      result: partial ? "partial" : "restored",
      state: JSON.parse(JSON.stringify({
        version: 1,
        layout: value.layout,
        assignedCameras,
        when: {
          version: 1,
          kind: "absolute-range",
          from: value.when.from,
          to: value.when.to
        },
        filters: REVIEW_FILTERS.filter(filter => requestedFilters.has(filter))
      })),
      issues: {
        staleCameras,
        duplicateCameras,
        unknownFilters
      }
    };
  }

  getReviewCriteriaSignature(query) {
    if (!query) return null;
    return JSON.stringify({
      cameraNames: [...new Set(query.cameraNames)].sort(),
      range: { from: query.range.from, to: query.range.to },
      filters: [...new Set(query.filters)].sort()
    });
  }

  constrainReviewPositionToRange(range, position = this._reviewPosition) {
    if (!(range?.from < range?.to) || !Number.isFinite(position)) return position;
    this._reviewPosition = Math.min(range.to, Math.max(range.from, position));
    return this._reviewPosition;
  }

  restoreReviewView(value) {
    const normalized = this.normalizeReviewViewState(value);
    if (normalized.result === "invalid") return normalized;
    this._reviewRequestId += 1;

    this.ensureReviewQuery();
    const beforeCriteria = this.getReviewCriteriaSignature(this._desiredReviewQuery);
    const preservedPosition = this.reviewPosition;
    this.cancelScheduledReviewQuery();
    this._queryGeneration += 1;
    this.cleanupTimelineInteraction();
    if (this._presentationMode === "historical" || this._historicalPreparing) {
      this.returnToLive(true);
    }

    const state = normalized.state;
    this._reviewLayout = state.layout;
    this._reviewAssignments = [...state.assignedCameras];
    this._assignmentRevision += 1;
    this.syncSelectionFromAssignments();
    this._selectedFilters = new Set(state.filters);
    this._desiredReviewRange = { from: state.when.from, to: state.when.to };
    this._selectedReviewCamera = null;
    this._selectedReviewLayout = null;
    this._desiredReviewQuery = this.getDesiredReviewQuery();
    this.constrainReviewPositionToRange(state.when, preservedPosition);

    const afterCriteria = this.getReviewCriteriaSignature(this._desiredReviewQuery);
    if (this._active && !this._suspended) this.render();
    const criteriaChanged = beforeCriteria !== afterCriteria;
    if (criteriaChanged) this.reviewCriteriaChanged();
    else this.updateClockDisplay();

    return {
      result: normalized.result,
      state: JSON.parse(JSON.stringify(state)),
      issues: normalized.issues ?? {},
      criteriaChanged
    };
  }

  cloneReviewQuery(query) {
    if (!query) return null;
    return {
      cameraNames: [...query.cameraNames],
      range: { ...query.range },
      filters: [...query.filters]
    };
  }

  getDesiredReviewQuery() {
    this.ensureReviewRange();
    return {
      cameraNames: this.canonicalCameraNames(this._selectedCameraNames),
      range: { ...this._desiredReviewRange },
      filters: this.canonicalFilters(this._selectedFilters)
    };
  }

  ensureReviewQuery() {
    this.ensureReviewRange();
    this._desiredReviewQuery = this.getDesiredReviewQuery();
    if (this._displayedReviewQuery) return false;
    this._displayedReviewQuery = this.cloneReviewQuery(this._desiredReviewQuery);
    this._reviewRange = { ...this._displayedReviewQuery.range };
    return true;
  }

  setSelectedCameraNames(names) {
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
      this.renderCameraControls();
      return true;
    }
    this._reviewAssignments = next;
    this._assignmentRevision += 1;
    this.syncSelectionFromAssignments();
    this.handleAssignmentChange();
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

  handleAssignmentChange({ refreshQuery = true } = {}) {
    if (this._active && !this._suspended) {
      if (refreshQuery) this.retireHistoricalForReviewEdit();
      this.renderCameraControls();
      this.syncMediaPanels();
    }
    if (refreshQuery) this.reviewCriteriaChanged();
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
    this._assignmentRevision += 1;
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
    const names = this._reviewAssignments.filter(Boolean);
    this._reviewLayout = layoutKey;
    this._selectedReviewLayout = null;
    this._reviewAssignments.fill(null);
    this.currentLayout.cells.forEach((cell, index) => {
      this._reviewAssignments[cell.slot] = names[index] ?? null;
    });
    this._assignmentRevision += 1;
    this.syncSelectionFromAssignments();
    this.applyReviewLayout();
    this.handleAssignmentChange({ refreshQuery: false });
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
    if (sourceSlot >= 0) this._reviewAssignments[sourceSlot] = null;
    this._reviewAssignments[targetSlot] = cameraName;
    this._assignmentRevision += 1;
    this._selectedReviewCamera = null;
    this.syncSelectionFromAssignments();
    this.handleAssignmentChange();
    return true;
  }

  removeCameraFromSlot(cameraName) {
    const slot = this._reviewAssignments.indexOf(cameraName);
    if (slot < 0) return false;
    this._reviewAssignments[slot] = null;
    this._assignmentRevision += 1;
    this._selectedReviewCamera = null;
    this.syncSelectionFromAssignments();
    this.handleAssignmentChange({ refreshQuery: true });
    return true;
  }

  setRhsMode(mode) {
    if (!["timeline", "events", "details"].includes(mode)) return false;
    this._rhsMode = mode;
    this.updateRhs();
    return true;
  }

  setFilter(name, selected) {
    if (!REVIEW_FILTERS.includes(name)) return false;
    if (this._selectedFilters.has(name) === Boolean(selected)) return true;
    if (selected) this._selectedFilters.add(name);
    else this._selectedFilters.delete(name);
    this.retireHistoricalForReviewEdit();
    this.reviewCriteriaChanged();
    return true;
  }

  ensureReviewRange() {
    if (!this._reviewRange || !Number.isFinite(this._reviewRange.from) ||
        !Number.isFinite(this._reviewRange.to)) {
      const to = Math.floor((this._wallClock() / 1000) / 60) * 60;
      this._reviewRange = { from: to - REVIEW_DEFAULT_RANGE_SECONDS, to };
    }
    if (!this._desiredReviewRange || !Number.isFinite(this._desiredReviewRange.from) ||
        !Number.isFinite(this._desiredReviewRange.to)) {
      this._desiredReviewRange = { ...this._reviewRange };
    }
  }

  setTimelineZoomSpanSeconds(seconds) {
    if (!Number.isFinite(seconds)) return false;
    if (this._timelineDrag) {
      this.updateTimelineZoomControl();
      return false;
    }
    this.ensureReviewQuery();
    const span = Math.min(REVIEW_MAX_ZOOM_SECONDS,
      Math.max(REVIEW_MIN_ZOOM_SECONDS, seconds));
    const anchor = Number.isFinite(this.reviewPosition)
      ? this.reviewPosition : this._desiredReviewRange.to;
    const to = Math.min(anchor + span / 2, Math.max(anchor, this._wallClock() / 1000));
    const range = { from: to - span, to };
    if (range.from === this._desiredReviewRange.from &&
        range.to === this._desiredReviewRange.to) return false;
    if (this._historicalPreparing) this.retireHistoricalForReviewEdit();
    const preserveHistorical = this._presentationMode === "historical";
    this._whenDraftRange = null;
    this._desiredReviewRange = { ...range };
    this._reviewRange = { ...range };
    this.updateWhenControls();
    if (preserveHistorical) this._historicalPlaybackRange = { ...range };
    this.reviewCriteriaChanged({ preserveHistorical });
    this._displayedReviewQuery = {
      ...this._displayedReviewQuery, range: { ...range }
    };
    this.updateTimelineZoomControl();
    this.updateRhs();
    this.updateClockDisplay();
    return true;
  }

  updateTimelineZoomControl() {
    const input = this._root?.querySelector(".review-timeline-zoom-input");
    if (!input) return;
    this.ensureReviewRange();
    const hours = (this._desiredReviewRange.to - this._desiredReviewRange.from) / 3600;
    input.value = String(Math.min(24, Math.max(1, Math.round(hours))));
    const label = `${Number(hours.toFixed(2))} ${hours === 1 ? "hour" : "hours"} in When`;
    input.setAttribute("aria-valuetext", label);
  }

  cancelScheduledReviewQuery() {
    if (this._queryTimer === null) return;
    const view = this._root?.ownerDocument?.defaultView ?? globalThis;
    view.clearTimeout(this._queryTimer);
    this._queryTimer = null;
  }

  retireHistoricalForReviewEdit() {
    if (this._presentationMode === "historical" || this._historicalPreparing) {
      this.returnToLive(true);
    }
  }

  reviewCriteriaChanged({ preserveHistorical = false } = {}) {
    this.ensureReviewRange();
    if (!preserveHistorical) this._reviewRequestId += 1;
    this._desiredReviewQuery = this.getDesiredReviewQuery();
    const generation = ++this._queryGeneration;
    this.cancelScheduledReviewQuery();
    if (!(this._desiredReviewQuery.range.from < this._desiredReviewQuery.range.to)) {
      this._timeline.refreshing = false;
      this.updateRhs();
      return false;
    }
    const view = this._root?.ownerDocument?.defaultView ?? globalThis;
    this._queryTimer = view.setTimeout(() => {
      this._queryTimer = null;
      void this.refreshReviewQuery(generation);
    }, this._queryDebounceMs);
    return true;
  }

  flushScheduledReviewQuery() {
    const scheduled = this._queryTimer !== null;
    this.cancelScheduledReviewQuery();
    if (!scheduled) return Promise.resolve(false);
    return this.refreshReviewQuery(this._queryGeneration);
  }

  refreshReviewQuery(generation = this._queryGeneration) {
    this.cancelScheduledReviewQuery();
    this.ensureReviewQuery();
    const query = this.cloneReviewQuery(this._desiredReviewQuery);
    if (!(query.range.from < query.range.to)) return Promise.resolve(false);
    this._queryRefreshCount += 1;
    const range = query.range;
    const now = this._wallClock() / 1000;
    const queryTo = Math.min(range.to, now);
    const desiredNames = new Set(query.cameraNames);
    const cameras = this._cameras.filter(camera => desiredNames.has(camera.name))
      .map(camera => this.getFrigateCameraId(camera))
      .filter((camera, index, list) => camera && list.indexOf(camera) === index);
    this._timeline.refreshing = true;
    this._timeline.error = null;
    this.updateRhs();
    if (queryTo <= range.from || !this._hass || typeof this._hass.callWS !== "function" || cameras.length === 0) {
      if (generation !== this._queryGeneration) return Promise.resolve(this._queryRefreshCount);
      this._displayedReviewQuery = this.cloneReviewQuery(query);
      this._reviewRange = { ...range };
      this.constrainReviewPositionToDisplayedRange();
      this._timeline = {
        status: "loaded", refreshing: false, items: [], error: null,
        queryRange: { from: range.from, to: queryTo }
      };
      this.updateRhs();
      return Promise.resolve(this._queryRefreshCount);
    }
    const queryRange = { from: range.from, to: queryTo };
    this._timeline.queryRange = queryRange;
    return Promise.resolve(this._hass.callWS({
      type: "frigate_max/v1/review/get",
      cameras,
      from: queryRange.from,
      to: queryRange.to
    })).then(result => {
      if (generation !== this._queryGeneration) return;
      this._displayedReviewQuery = this.cloneReviewQuery(query);
      this._reviewRange = { ...range };
      this.constrainReviewPositionToDisplayedRange();
      this._timeline = {
        status: "loaded", refreshing: false,
        items: normalizeReviewTimelineItems(result, range), error: null, queryRange
      };
      this.updateRhs();
    }).catch(error => {
      if (generation !== this._queryGeneration) return;
      this._timeline.refreshing = false;
      this._timeline.error = "Unable to load activity.";
      if (this._timeline.status === "idle") this._timeline.status = "error";
      this.updateRhs();
      if (this._debugEnabled) console.warn("Review Timeline refresh failed", error?.message);
    }).then(() => this._queryRefreshCount);
  }

  setReviewRangeEndpoint(endpoint, value) {
    if (!["from", "to"].includes(endpoint)) return false;
    const epoch = value instanceof Date ? value.getTime() / 1000 : Number(value);
    if (!Number.isFinite(epoch)) return false;
    const draft = this.beginWhenDraft();
    if (draft[endpoint] === epoch) return true;
    draft[endpoint] = epoch;
    this.updateWhenControls();
    return true;
  }

  setVideoStateBadgePosition(value) {
    const position = ReviewController.normalizeVideoStateBadgePosition(value);
    if (position === this._videoStateBadgePosition) return;
    this._videoStateBadgePosition = position;
    for (const panel of this._mediaPanels.values()) {
      this.positionVideoStateBadge(panel.querySelector(".review-camera-presentation-kind"));
    }
  }

  positionVideoStateBadge(badge) {
    if (!badge) return;
    const [vertical, horizontal] = this._videoStateBadgePosition.split("-");
    for (const side of ["top", "right", "bottom", "left"]) {
      badge.style[side] = side === vertical || side === horizontal ? "6px" : "auto";
    }
  }

  beginWhenDraft() {
    this.ensureReviewRange();
    if (!this._whenDraftRange) {
      this._whenDraftRange = { ...this._desiredReviewRange };
    }
    return this._whenDraftRange;
  }

  getWhenControlRange() {
    this.ensureReviewRange();
    return this._whenDraftRange ?? this._desiredReviewRange;
  }

  setReviewDatePart(endpoint, value, updateControls = true) {
    if (!["from", "to"].includes(endpoint) || !(value instanceof Date) ||
        !Number.isFinite(value.getTime())) return false;
    const draft = this.beginWhenDraft();
    const date = pickerDateForEpoch(draft[endpoint], this.timeZone);
    date.setFullYear(value.getFullYear(), value.getMonth(), value.getDate());
    const epoch = pickerDateToEpoch(date, this.timeZone);
    if (!Number.isFinite(epoch)) return false;
    draft[endpoint] = epoch;
    if (updateControls) this.updateWhenControls();
    return true;
  }

  capturePendingWhenDate(endpoint) {
    const picker = this._datePickers[endpoint];
    const input = picker?.altInput ?? picker?._input ?? picker?.input;
    if (!picker) return true;
    if (!input || typeof picker.parseDate !== "function") return false;
    const raw = String(input.value ?? "").trim();
    if (!raw) return false;
    let parsed;
    try {
      parsed = picker.parseDate(
        raw,
        picker.config?.altFormat ?? picker.options?.altFormat
      );
    } catch {
      return false;
    }
    if (!parsed || !Number.isFinite(parsed.getTime?.())) return false;
    return this.setReviewDatePart(endpoint, parsed, false);
  }

  getWhenTimeSelect(endpoint, part) {
    return this._root?.querySelector(`.review-${endpoint}-picker`)
      ?.closest(".review-range-field")?.nextElementSibling
      ?.querySelector(`.review-time-${part}`) ?? null;
  }

  capturePendingWhenControls() {
    this.beginWhenDraft();
    for (const endpoint of ["from", "to"]) {
      if (!this.capturePendingWhenDate(endpoint)) return false;
      for (const part of ["hour", "minute"]) {
        const select = this.getWhenTimeSelect(endpoint, part);
        if (select && !this.setReviewTimePart(endpoint, part, select.value, false)) {
          return false;
        }
      }
    }
    return true;
  }

  applyWhenDraft() {
    if (!this.capturePendingWhenControls()) return false;
    const draft = this._whenDraftRange;
    if (!(Number.isFinite(draft.from) && Number.isFinite(draft.to) && draft.from < draft.to)) {
      return false;
    }
    const changed = draft.from !== this._desiredReviewRange.from ||
      draft.to !== this._desiredReviewRange.to;
    this._desiredReviewRange = { ...draft };
    this._reviewRange = { ...draft };
    this._whenDraftRange = null;
    this.updateWhenControls();
    if (!changed) return false;
    this.retireHistoricalForReviewEdit();
    this.reviewCriteriaChanged();
    return true;
  }

  abortWhenDraft() {
    const hadDraft = this._whenDraftRange !== null;
    this._whenDraftRange = null;
    this.updateWhenControls();
    return hadDraft;
  }

  populateWhenDay(dayKey) {
    const bounds = getCivilDayBounds(dayKey, this.timeZone);
    this._whenDraftRange = { from: bounds.start / 1000, to: bounds.end / 1000 - 1 };
    this.updateWhenControls();
  }

  stepWhenDay(days) {
    if (!Number.isInteger(days) || days === 0) return false;
    const draft = this.beginWhenDraft();
    const dayKey = getCivilDayKey(draft.from * 1000, this.timeZone);
    this.populateWhenDay(shiftCivilDayKey(dayKey, days));
    return true;
  }

  cleanupWhenInteraction() {
    if (this._whenOutsideClickHandler) {
      this._document?.removeEventListener("pointerdown", this._whenOutsideClickHandler, true);
      this._whenOutsideClickHandler = null;
    }
  }

  setReviewTimePart(endpoint, part, value, updateControls = true) {
    if (!['from', 'to'].includes(endpoint) || !['hour', 'minute'].includes(part)) return false;
    const draft = this.beginWhenDraft();
    const date = pickerDateForEpoch(draft[endpoint], this.timeZone);
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || (part === 'hour' && (numeric < 0 || numeric > 23)) ||
        (part === 'minute' && (numeric < 0 || numeric > 59))) return false;
    if (part === 'hour') date.setHours(numeric);
    else date.setMinutes(numeric);
    const epoch = pickerDateToEpoch(date, this.timeZone);
    if (!Number.isFinite(epoch)) return false;
    draft[endpoint] = epoch;
    if (updateControls) this.updateWhenControls();
    return true;
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
    this.scheduleHistoricalBoundaryTimer();
    this.updateTransport();
    return true;
  }

  nextDiagnosticObjectId(prefix) {
    this._diagnosticObjectSequence += 1;
    return `${prefix}-${this._diagnosticObjectSequence}`;
  }

  recordIdentityEvent(report, player, disposition, details = {}) {
    if (!report || !player) return;
    report.identityEvents.push({
      atMs: this._now(), disposition,
      requestId: player.requestId, cameraWorkId: player.cameraWorkId,
      presentationId: player.presentationId,
      assignmentRevision: this._assignmentRevision,
      logicalCamera: player.camera?.name ?? null,
      cameraEntity: player.camera?.entity ?? null,
      frigateCamera: player.frigateCamera ?? null,
      returnedCamera: player.returnedCamera ?? null,
      playerId: player.playerId,
      hlsId: player.hlsId ?? null, videoId: player.videoId ?? null,
      panelId: player.panelId ?? null, panelCamera: player.panelCamera ?? null,
      renderedSlot: Number.isInteger(player.renderedSlot) ? player.renderedSlot : null,
      presentationMode: this._presentationMode,
      current: this.isCurrentCameraWork(player),
      ...details
    });
    if (report.identityEvents.length > 64) report.identityEvents.shift();
  }

  includeReviewTarget(targetEpoch) {
    this.ensureReviewRange();
    this.cancelScheduledReviewQuery();
    this._queryGeneration += 1;
    const duration = this._reviewRange.to - this._reviewRange.from;
    if (targetEpoch < this._reviewRange.from) {
      this._reviewRange = { from: targetEpoch, to: targetEpoch + duration };
    } else if (targetEpoch > this._reviewRange.to) {
      this._reviewRange = { from: targetEpoch - duration, to: targetEpoch };
    }
    this._desiredReviewRange = { ...this._reviewRange };
    this._desiredReviewQuery = this.getDesiredReviewQuery();
    this._displayedReviewQuery = this.cloneReviewQuery(this._desiredReviewQuery);
    this.updateWhenControls();
  }

  returnToLive(preservePosition = false) {
    const previousPosition = this.reviewPosition;
    this._generation += 1;
    this._reviewRequestId += 1;
    this.cleanupHistorical();
    this.clock.reset();
    this._presentationMode = "live";
    this._reviewPosition = preservePosition && Number.isFinite(previousPosition)
      ? previousPosition : this._wallClock() / 1000;
    this.constrainReviewPositionToDisplayedRange();
    this._historicalStatus = "";
    if (this._active && !this._suspended) this.renderMediaArea();
  }

  getSceneExperimentReport() {
    if (!this._sceneExperiment) return null;
    return JSON.parse(JSON.stringify({
      ...this._sceneExperiment,
      currentTiEpoch: this.reviewPosition,
      activeHolds: [...this._historicalPlayers.values()]
        .filter(player => player.sceneExperimentSerial === this._sceneExperiment.serial &&
          player.holdStartedAtMs != null)
        .map(player => ({ camera: player.camera.name,
          representedEpoch: player.heldFrameEpoch,
          durationMs: this._now() - player.holdStartedAtMs }))
    }));
  }

  recordSceneEvent(player, kind, details = {}) {
    if (!this._sceneExperiment || (player &&
        player.sceneExperimentSerial !== this._sceneExperiment.serial)) return;
    const events = this._sceneExperiment.events;
    if (events.length >= 2048) {
      this._sceneExperiment.droppedEvents += 1;
      return;
    }
    events.push({ atMs: this._now(), tiEpoch: this.reviewPosition,
      camera: player?.camera?.name ?? null, kind, ...details });
  }

  getEventNavigationInventory() {
    const displayed = this._displayedReviewQuery;
    const selectedNames = this.canonicalCameraNames(this._selectedCameraNames);
    const displayedNames = this.canonicalCameraNames(displayed?.cameraNames);
    const activeRange = this._desiredReviewRange;
    const range = displayed?.range;
    if (this._timeline.status !== "loaded" || !range || !activeRange ||
        selectedNames.length !== displayedNames.length ||
        selectedNames.some((name, index) => name !== displayedNames[index]) ||
        range.from !== activeRange.from || range.to !== activeRange.to) return [];
    const selectedCameraIds = selectedNames.map(name => {
      const camera = this._cameras.find(candidate => candidate.name === name);
      return camera ? this.getFrigateCameraId(camera) : null;
    }).filter(Boolean);
    return reviewEventNavigationTimestamps(
      this._timeline.items, selectedCameraIds, range
    );
  }

  getEventNavigationTargets(position = this.reviewPosition) {
    return reviewEventNavigationTargets(
      this.getEventNavigationInventory(), Number(position)
    );
  }

  async snapToEvent(direction) {
    if (!this._active || this._suspended ||
        !["previous", "next"].includes(direction)) return false;
    const selectedNames = this.canonicalCameraNames(this._selectedCameraNames);
    const target = this.getEventNavigationTargets()[direction];
    if (!Number.isFinite(target) || selectedNames.length === 0) return false;
    this._playRequested = false;
    const generation = this._generation + 1;
    await this.playHistorical(target, {
      autoplay: false,
      updateDisplayedRange: false,
      playbackRange: { ...this._displayedReviewQuery.range },
      cameraNames: selectedNames,
      source: `event snap ${direction}`
    });
    if (this._generation !== generation || this._presentationMode !== "historical") {
      return false;
    }
    if (!this.clock.running) {
      this.clock.setAbsolute(target);
      this.updateTransport();
    }
    return true;
  }

  async snapToPreviousEvent() {
    return this.snapToEvent("previous");
  }

  async snapToNextEvent() {
    return this.snapToEvent("next");
  }

  async selectTimelineTime(value, source = "timeline click", autoplay = null) {
    this.ensureReviewRange();
    const targetEpoch = Number(value);
    const displayedQuery = this._displayedReviewQuery;
    const range = displayedQuery?.range;
    if (!Number.isFinite(targetEpoch) || !(range?.from < range?.to) ||
        targetEpoch < range.from || targetEpoch > range.to) return false;
    if (autoplay === false) this._playRequested = false;
    const displayedNames = this.canonicalCameraNames(displayedQuery.cameraNames);
    const assignedNames = this.canonicalCameraNames(this._selectedCameraNames);
    if (displayedNames.length !== assignedNames.length ||
        displayedNames.some((name, index) => name !== assignedNames[index])) {
      this._historicalStatus = "Preparing...";
      this.updateTransport();
      return false;
    }
    if (targetEpoch > this._wallClock() / 1000) {
      if (this._presentationMode === "historical" || this._historicalPreparing) {
        this.returnToLive();
      }
      this._historicalStatus = "No recording at this time.";
      this.updateTransport();
      return false;
    }
    if (this._presentationMode === "historical" && this._historicalPreparing) {
      await this.playHistorical(targetEpoch, {
        autoplay: typeof autoplay === "boolean" ? autoplay : true,
        updateDisplayedRange: false,
        playbackRange: { ...range },
        cameraNames: [...displayedQuery.cameraNames],
        source
      });
      return true;
    }
    if (this._presentationMode === "historical" && Number.isFinite(this.clock.absoluteTime)) {
      return this.seekHistoricalToEpoch(targetEpoch, {
        autoplay: typeof autoplay === "boolean" ? autoplay : this.clock.running,
        source
      });
    }
    await this.playHistorical(targetEpoch, {
      autoplay: typeof autoplay === "boolean" ? autoplay : true,
      updateDisplayedRange: false,
      playbackRange: { ...range },
      cameraNames: [...displayedQuery.cameraNames], source
    });
    return true;
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
      views: "mdi:view-dashboard-outline",
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
    const wasExpanded = this._sectionExpanded[name];
    this._sectionExpanded[name] = Boolean(expanded);
    if (name === "when" && this._sectionExpanded[name] !== wasExpanded) {
      if (this._sectionExpanded[name]) {
        this.beginWhenDraft();
        this.updateWhenControls();
      } else {
        this.abortWhenDraft();
      }
    }
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
    if (this._whenDraftRange) this.capturePendingWhenControls();
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
    const viewsContent = this._document.createElement("div");
    viewsContent.className = "saved-views-body review-saved-views-body sidebar-scroll-region";
    viewsContent.innerHTML = `
      <div class="saved-views-toolbar">
        <button type="button" class="saved-view-save-current" data-saved-view-action="create">
          Save Current View
        </button>
      </div>
      <div class="saved-views-list"></div>
      <div class="saved-views-message" role="status" aria-live="polite"></div>
    `;
    controls.appendChild(this.createSection("views", "Views", viewsContent));
    this._reviewViewsBody = viewsContent;
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
      const diagnosticRange = buildReviewRange(parseReviewTimestamp(REVIEW_KNOWN_TARGET));
      target.addEventListener("click", () => void this.playHistorical(REVIEW_KNOWN_TARGET, {
        playbackRange: { from: diagnosticRange.start, to: diagnosticRange.end }
      }));
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
    const transportGroup = this._document.createElement("div");
    transportGroup.className = "review-toolbar-group review-vcr-group";
    const speedGroup = this._document.createElement("div");
    speedGroup.className = "review-toolbar-group review-speed-group";
    const addTransportButton = ({
      parent = transportGroup, className, label, icon, disabled = false, action
    }) => {
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
      parent.appendChild(button);
      return button;
    };
    addTransportButton({
      className: "review-previous-event", label: "Snap to previous event",
      icon: "mdi:skip-previous", action: () => void this.snapToPreviousEvent()
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
      className: "review-next-event", label: "Snap to next event",
      icon: "mdi:skip-next", action: () => void this.snapToNextEvent()
    });
    const speed = this._document.createElement("select");
    speed.className = "review-speed-select";
    speed.setAttribute("aria-label", "Playback speed");
    speed.title = "Playback speed";
    for (const value of REVIEW_PLAYBACK_SPEEDS) {
      const option = this._document.createElement("option");
      option.value = String(value);
      option.textContent = `${value < 1 ? value.toFixed(2) : value}x`;
      option.selected = value === this._playbackSpeed;
      speed.appendChild(option);
    }
    speed.addEventListener("change", () => this.setPlaybackSpeed(speed.value));
    speedGroup.appendChild(speed);
    controlsGroup.append(transportGroup, speedGroup);
    transport.appendChild(controlsGroup);
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
    modes.setAttribute("role", "tablist");
    for (const mode of ["timeline", "events", "details"]) {
      const button = this._document.createElement("button");
      button.type = "button";
      button.dataset.mode = mode;
      button.textContent = mode[0].toUpperCase() + mode.slice(1);
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => this.setRhsMode(mode));
      modes.appendChild(button);
    }
    const rhsContent = this._document.createElement("div");
    rhsContent.className = "review-rhs-content";
    const timeTruth = this._document.createElement("footer");
    timeTruth.className = "review-time-truth";
    const clock = this._document.createElement("time");
    clock.className = "review-clock-display";
    timeTruth.appendChild(clock);
    const zoom = this._document.createElement("label");
    zoom.className = "review-timeline-zoom";
    zoom.innerHTML = '<span class="review-timeline-zoom-end">1h</span><input class="review-timeline-zoom-input" type="range" min="1" max="24" step="1" aria-label="Review investigation duration"><span class="review-timeline-zoom-end">24h</span>';
    zoom.querySelector("input").addEventListener("input", event => {
      this.setTimelineZoomSpanSeconds(Number(event.target.value) * 3600);
    });
    timeTruth.appendChild(zoom);
    rhs.append(modes, rhsContent, timeTruth);
    product.append(controls, media, rhs);
    this._root.appendChild(product);
    this.renderCameraControls();
    this.renderReviewLayoutControls();
    this.renderReviewViews();
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
    this.cleanupWhenInteraction();
    this.ensureReviewRange();
    if (this._sectionExpanded.when) this.beginWhenDraft();
    const shortcuts = this._document.createElement("div");
    shortcuts.className = "review-when-shortcuts";
    for (const { label, ariaLabel, action } of [
      { label: "-", ariaLabel: "Previous day", action: () => this.stepWhenDay(-1) },
      { label: "Today", ariaLabel: "Today", action: () => this.populateWhenDay(this.todayKey) },
      { label: "+", ariaLabel: "Next day", action: () => this.stepWhenDay(1) }
    ]) {
      const button = this._document.createElement("button");
      button.type = "button"; button.textContent = label;
      button.setAttribute("aria-label", ariaLabel);
      button.title = ariaLabel;
      button.addEventListener("click", action);
      shortcuts.appendChild(button);
    }
    content.appendChild(shortcuts);
    for (const endpoint of ["from", "to"]) {
      const label = this._document.createElement("label");
      label.className = "review-range-field";
      const caption = this._document.createElement("span");
      caption.textContent = endpoint === "from" ? "From" : "To";
      const input = this._document.createElement("input");
      input.type = "text";
      input.className = `review-range-picker review-${endpoint}-picker`;
      input.setAttribute("aria-label", `Review ${endpoint} date and time`);
      label.append(caption, input);
      content.appendChild(label);
      if (typeof this._datePickerFactory === "function") {
        this._datePickers[endpoint] = this._datePickerFactory(input, {
          enableTime: false,
          altInput: true,
          altInputClass: "review-range-picker",
          altFormat: "m/d/Y",
          dateFormat: "Y-m-d",
          allowInput: true,
          disableMobile: true,
          defaultDate: pickerDateForEpoch(this.getWhenControlRange()[endpoint], this.timeZone),
          appendTo: this._root,
          onChange: dates => {
            if (dates[0] instanceof Date) {
              this.setReviewDatePart(endpoint, dates[0]);
            }
          }
        });
        const pickerInput = this._datePickers[endpoint]?.altInput ??
          this._datePickers[endpoint]?._input ?? this._datePickers[endpoint]?.input;
        pickerInput?.addEventListener("input", () => this.capturePendingWhenDate(endpoint));
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
          option.textContent = part === "hour" && this._timeFormat === "12-hour"
            ? `${value % 12 || 12} ${value < 12 ? "AM" : "PM"}`
            : String(value).padStart(2, "0");
          select.appendChild(option);
        }
        select.addEventListener("change", () => this.setReviewTimePart(
          endpoint, part, select.value
        ));
        field.append(caption, select);
        direct.appendChild(field);
      }
      directField.appendChild(direct);
      content.appendChild(directField);
    }
    const apply = this._document.createElement("button");
    apply.type = "button"; apply.className = "review-when-apply"; apply.textContent = "Apply";
    apply.addEventListener("click", () => this.applyWhenDraft());
    content.appendChild(apply);
    content.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); this.abortWhenDraft(); }
      else if (event.key === "Enter") { event.preventDefault(); this.applyWhenDraft(); }
    });
    this._whenOutsideClickHandler = event => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const insideControls = path.includes(content) || content.contains(event.target);
      const insidePicker = Object.values(this._datePickers).some(picker => {
        const calendar = picker?.calendarContainer;
        return calendar && (path.includes(calendar) || calendar.contains(event.target));
      });
      if (!insideControls && !insidePicker && this._whenDraftRange) {
        this.abortWhenDraft();
      }
    };
    this._document.addEventListener("pointerdown", this._whenOutsideClickHandler, true);
    this.updateWhenControls();
  }

  cleanupDatePicker() {
    for (const endpoint of ["from", "to"]) {
      this._datePickers[endpoint]?.destroy();
      this._datePickers[endpoint] = null;
    }
  }

  updateWhenControls() {
    const range = this.getWhenControlRange();
    for (const endpoint of ["from", "to"]) {
      const input = this._root?.querySelector(`.review-${endpoint}-picker`);
      const value = pickerDateForEpoch(range[endpoint], this.timeZone);
      if (this._datePickers[endpoint]) {
        this._datePickers[endpoint].setDate(value, false);
      } else if (input) {
        input.value = formatNvrClockTime(value, null, this._timeFormat, "when");
      }
      const date = pickerDateForEpoch(range[endpoint], this.timeZone);
      const hour = this._root?.querySelector(`.review-${endpoint}-picker`)?.closest(".review-range-field")
        ?.nextElementSibling;
      const hourSelect = hour?.querySelector(".review-time-hour");
      const minuteSelect = hour?.querySelector(".review-time-minute");
      if (hourSelect) hourSelect.value = String(date.getHours());
      if (minuteSelect) minuteSelect.value = String(date.getMinutes());
    }
  }

  updateRhs() {
    if (!this._root) return;
    this.updateTimelineZoomControl();
    this.updateEventNavigationControls();
    if (this._timelineDrag) {
      const current = this._displayedReviewQuery;
      const drag = this._timelineDrag;
      const sameQuery = drag.queryGeneration === this._queryGeneration &&
        current?.range?.from === drag.range.from && current?.range?.to === drag.range.to &&
        JSON.stringify(current?.cameraNames) === JSON.stringify(drag.cameraNames);
      if (sameQuery) {
        this._timelineRefreshDeferred = true;
        return;
      }
      this.cancelTimelineDrag();
    }
    this._root.querySelectorAll(".review-rhs-modes button").forEach(button => {
      const selected = button.dataset.mode === this._rhsMode;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-selected", String(selected));
    });
    const content = this._root.querySelector(".review-rhs-content");
    if (!content) return;
    if (this._rhsMode === "timeline") {
      content.innerHTML = this.renderTimeline();
      this.attachTimelineSelection(content);
      this.updateTimelineCursor();
      return;
    }
    const title = this._rhsMode[0].toUpperCase() + this._rhsMode.slice(1);
    content.innerHTML = `<div class="review-placeholder"><strong>${title}</strong><span>Foundation placeholder</span><small>Newest / Now at top<br>Earlier time runs downward</small></div>`;
  }

  getTimelineLanes() {
    const names = this.canonicalCameraNames(
      this._displayedReviewQuery?.cameraNames ?? this._selectedCameraNames
    );
    return names.flatMap(name => {
      const camera = this._cameras.find(candidate => candidate.name === name);
      if (!camera) return [];
      const cameraId = this.getFrigateCameraId(camera);
      const index = Math.max(0, this._cameras.indexOf(camera));
      return [{
        name: camera.name,
        cameraId,
        color: REVIEW_TIMELINE_CAMERA_COLORS[index % REVIEW_TIMELINE_CAMERA_COLORS.length]
      }];
    });
  }

  renderTimeline() {
    this.ensureReviewRange();
    const range = this._displayedReviewQuery?.range ?? this._reviewRange;
    const lanes = this.getTimelineLanes();
    const format = epoch => formatNvrClockTime(epoch, this.timeZone, this._timeFormat);
    const ticks = Array.from({ length: 5 }, (_, index) => {
      const epoch = range.to - ((range.to - range.from) * index / 4);
      const top = reviewTimelineMarkerTop(epoch, range);
      return `<div class="review-timeline-tick" style="top:${top * 100}%"><span>${format(epoch)}</span></div>`;
    }).join("");
    const laneCount = Math.max(1, lanes.length);
    const headers = lanes.map(lane => {
      const name = escapeViewerHtml(lane.name);
      return `<div class="review-timeline-lane-heading" style="--review-camera-color:${lane.color}" title="${name}"><span>${name}</span></div>`;
    }).join("");
    const laneBodies = lanes.map(lane => {
      const markers = this._timeline.items.filter(item => item.camera_id === lane.cameraId &&
        item.start_time <= range.to && (item.end_time ?? item.start_time) >= range.from)
        .map(item => {
          const geometry = reviewTimelineMarkerGeometry(item, range);
          if (!geometry) return "";
          const camera = escapeViewerHtml(item.camera_id);
          const type = escapeViewerHtml(item.type);
          const diagnostics = this._debugEnabled
            ? ` data-camera-id="${camera}" data-start-epoch="${geometry.startEpoch}" data-end-epoch="${geometry.endEpoch}"`
            : "";
          const point = geometry.height === 0 ? " point" : "";
          const top = geometry.height > 0
            ? `min(${geometry.top * 100}%, calc(100% - 1px))`
            : `${geometry.top * 100}%`;
          const height = geometry.height > 0
            ? `max(${geometry.height * 100}%, 1px)`
            : "0%";
          return `<div class="review-timeline-marker${point}" style="top:${top};height:${height};--review-camera-color:${lane.color}"${diagnostics} title="${type}"></div>`;
        }).join("");
      return `<div class="review-timeline-lane" data-camera-id="${escapeViewerHtml(lane.cameraId ?? "")}" style="--review-camera-color:${lane.color}">${markers}</div>`;
    }).join("");
    let message = "";
    if (this._timeline.status === "idle") message = "<div class=\"review-timeline-message\">Loading activity…</div>";
    else if (this._timeline.status === "error") message = `<div class="review-timeline-message error">${this._timeline.error}</div>`;
    else if (this._timeline.items.length === 0) message = "<div class=\"review-timeline-message\">No activity in this range</div>";
    const refresh = this._timeline.refreshing
      ? '<div class="review-timeline-refresh" role="status">Updating...</div>'
      : this._timeline.error
        ? `<div class="review-timeline-refresh error" role="status">${this._timeline.error}</div>`
        : "";
    const gutter = this._timeFormat === "12-hour" ? "72px" : "58px";
    return `<div class="review-timeline" aria-label="Review activity timeline" style="--review-timeline-lane-count:${laneCount};--review-timeline-time-gutter:${gutter}">${refresh}<div class="review-timeline-lane-headings"><div class="review-timeline-time-heading">Time</div>${headers}</div><div class="review-timeline-axis" role="button" aria-label="Select Review playback time">${ticks}<div class="review-timeline-lanes">${laneBodies}</div>${message}<div class="review-timeline-cursor" hidden aria-hidden="true"><span class="review-timeline-handle" role="slider" aria-label="Drag Review time"></span></div></div></div>`;
  }

  attachTimelineSelection(content) {
    const axis = content?.querySelector(".review-timeline-axis");
    if (!axis) return;
    axis.addEventListener("click", event => {
      if (event.button !== 0) return;
      if (this._timelineClickSuppressionTimer !== null) return;
      const epoch = this.getTimelinePointerEpoch(axis, event.clientY);
      if (this._debugEnabled && Number.isFinite(epoch)) {
        axis.dataset.selectedEpoch = String(epoch);
        axis.dataset.displayedFrom = String(this._displayedReviewQuery?.range?.from ?? "");
        axis.dataset.displayedTo = String(this._displayedReviewQuery?.range?.to ?? "");
      }
      if (Number.isFinite(epoch)) void this.selectTimelineTime(
        epoch, "timeline click", false
      );
    });
    const handle = axis.querySelector(".review-timeline-handle");
    if (!handle) return;
    handle.addEventListener("pointerdown", event => this.beginTimelineDrag(event, axis, handle));
    handle.addEventListener("pointermove", event => this.moveTimelineDrag(event));
    handle.addEventListener("pointerup", event => this.finishTimelineDrag(event));
    handle.addEventListener("pointercancel", event => this.cancelTimelineDrag(event));
  }

  getTimelinePointerEpoch(axis, clientY, range = null) {
    const rect = axis?.getBoundingClientRect?.();
    if (!rect) return null;
    const borderTop = Number(axis.clientTop) || 0;
    const contentHeight = Number(axis.clientHeight) || Math.max(0, rect.height - borderTop);
    return reviewTimelineEpochFromCoordinate(
      clientY,
      rect.top + borderTop,
      contentHeight,
      range ?? this._displayedReviewQuery?.range ?? this._reviewRange
    );
  }

  beginTimelineDrag(event, axis, handle) {
    if ((event.button ?? 0) !== 0 || this._timelineDrag ||
        !Number.isFinite(this.reviewPosition)) return;
    const range = this._displayedReviewQuery?.range;
    if (!(range?.from < range?.to)) return;
    event.preventDefault();
    event.stopPropagation();
    const wasRunning = this.clock.running;
    if (wasRunning) this.pausePlayback();
    this._timelineDrag = {
      pointerId: event.pointerId,
      axis,
      handle,
      range: { ...range },
      queryGeneration: this._queryGeneration,
      cameraNames: [...(this._displayedReviewQuery?.cameraNames ?? [])],
      originalEpoch: this.reviewPosition,
      previewEpoch: this.reviewPosition,
      wasHistorical: this._presentationMode === "historical",
      wasRunning
    };
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch {}
    this.previewTimelineDrag(event.clientY);
  }

  previewTimelineDrag(clientY) {
    const drag = this._timelineDrag;
    if (!drag) return null;
    const epoch = this.getTimelinePointerEpoch(drag.axis, clientY, drag.range);
    if (!Number.isFinite(epoch)) return null;
    drag.previewEpoch = epoch;
    if (this._presentationMode === "historical") this.clock.setAbsolute(epoch);
    this.updateClockDisplay();
    return epoch;
  }

  moveTimelineDrag(event) {
    if (!this._timelineDrag || event.pointerId !== this._timelineDrag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.previewTimelineDrag(event.clientY);
  }

  finishTimelineDrag(event) {
    const drag = this._timelineDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const epoch = this.previewTimelineDrag(event.clientY);
    this._timelineDrag = null;
    if (this._presentationMode !== "historical" && Number.isFinite(epoch)) {
      this._reviewPosition = epoch;
    }
    try {
      drag.handle.releasePointerCapture?.(event.pointerId);
    } catch {}
    const view = this._root?.ownerDocument?.defaultView ?? globalThis;
    if (this._timelineClickSuppressionTimer !== null) {
      view.clearTimeout(this._timelineClickSuppressionTimer);
    }
    this._timelineClickSuppressionTimer = view.setTimeout(() => {
      this._timelineClickSuppressionTimer = null;
    }, 0);
    if (this._timelineRefreshDeferred) {
      this._timelineRefreshDeferred = false;
      this.updateRhs();
    }
    if (Number.isFinite(epoch)) void this.selectTimelineTime(
      epoch,
      "timeline drag release",
      false
    );
  }

  cancelTimelineDrag(event = null) {
    const drag = this._timelineDrag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return false;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    this._timelineDrag = null;
    try {
      drag.handle.releasePointerCapture?.(drag.pointerId);
    } catch {}
    if (Number.isFinite(drag.originalEpoch)) {
      if (this._presentationMode === "historical") this.clock.setAbsolute(drag.originalEpoch);
      else this._reviewPosition = drag.originalEpoch;
    }
    if (drag.wasRunning) this.resumePlayback();
    else this.updateClockDisplay();
    if (this._timelineRefreshDeferred) {
      this._timelineRefreshDeferred = false;
      this.updateRhs();
    }
    return true;
  }

  cleanupTimelineInteraction() {
    this._timelineDrag = null;
    this._timelineRefreshDeferred = false;
    if (this._timelineClickSuppressionTimer === null) return;
    const view = this._root?.ownerDocument?.defaultView ?? globalThis;
    view.clearTimeout(this._timelineClickSuppressionTimer);
    this._timelineClickSuppressionTimer = null;
  }

  updateTimelineCursor() {
    const cursor = this._root?.querySelector(".review-timeline-cursor");
    if (!cursor) return;
    const absolute = this.reviewPosition;
    const range = this._displayedReviewQuery?.range ?? this._reviewRange;
    const top = reviewTimelineMarkerTop(
      absolute,
      range
    );
    const visible = Number.isFinite(top) && absolute >= range.from && absolute <= range.to;
    cursor.hidden = !visible;
    cursor.setAttribute("aria-hidden", String(!visible));
    if (visible) {
      cursor.style.top = `${top * 100}%`;
      const handle = cursor.querySelector(".review-timeline-handle");
      handle?.setAttribute("aria-valuemin", String(this._displayedReviewQuery?.range?.from ?? ""));
      handle?.setAttribute("aria-valuemax", String(this._displayedReviewQuery?.range?.to ?? ""));
      handle?.setAttribute("aria-valuenow", String(absolute));
    }
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
    panel.dataset.presentationMode = this._presentationMode;
    panel.draggable = true;
    const media = this._document.createElement("div");
    media.className = "review-camera-media";
    if (this._presentationMode === "live") {
      media.appendChild(this.createLiveImage(camera));
    } else {
      const player = this._historicalPlayers.get(camera.name);
      if (!this.isCurrentCameraWork(player)) {
        const status = this._document.createElement("div");
        status.className = "review-camera-status";
        status.textContent = "Preparing...";
        media.appendChild(status);
      } else {
        const video = this._document.createElement("video");
      video.className = "review-historical-video";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.playbackRate = this._playbackSpeed;
      player.video = video;
      player.videoId = this.nextDiagnosticObjectId("video");
      panel.dataset.requestId = String(player.requestId);
      panel.dataset.cameraWorkId = String(player.cameraWorkId);
      panel.dataset.presentationId = String(player.presentationId);
      panel.dataset.videoId = player.videoId;
      player.panelId = this.nextDiagnosticObjectId("panel");
      player.panelCamera = camera.name;
      panel.dataset.panelId = player.panelId;
      media.appendChild(video);
      const status = this._document.createElement("div");
      status.className = "review-camera-status";
      status.textContent = player.message ?? "Preparing...";
      status.hidden = !status.textContent;
      player.statusElement = status;
      media.appendChild(status);
      const diagnostic = player.diagnosticReport?.cameras?.[camera.name];
      if (diagnostic) Object.assign(diagnostic, {
        videoId: player.videoId, panelId: player.panelId, panelCamera: camera.name
      });
        this.recordIdentityEvent(player.diagnosticReport, player, "panel-created");
      }
    }
    const overlay = this._document.createElement("div");
    overlay.className = "review-camera-overlay";
    const name = this._document.createElement("span");
    name.className = "review-camera-name";
    name.textContent = camera.name;
    const presentationKind = this._document.createElement("span");
    presentationKind.className = "review-camera-presentation-kind";
    presentationKind.textContent = this._presentationMode === "live"
      ? "Live" : this.historicalVideoStateBadge(this._historicalPlayers.get(camera.name));
    presentationKind.hidden = !presentationKind.textContent;
    this.positionVideoStateBadge(presentationKind);
    const close = this._document.createElement("button");
    close.type = "button";
    close.className = "review-camera-close";
    close.title = `Remove ${camera.name} from Review`;
    close.setAttribute("aria-label", close.title);
    const closeIcon = this._document.createElement("ha-icon");
    closeIcon.setAttribute("icon", "mdi:close");
    close.appendChild(closeIcon);
    close.addEventListener("pointerdown", event => event.stopPropagation());
    close.addEventListener("pointerup", event => event.stopPropagation());
    close.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      this.removeCameraFromSlot(camera.name);
    });
    overlay.append(name, close);
    panel.append(media, presentationKind, overlay);
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
      if (event.pointerType !== "touch" || !touchStart) return;
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
      panel.classList.add("controls-visible");
      if (previousTap > 0 && event.timeStamp - previousTap <= 450) {
        previousTap = 0;
        if (panel.classList.contains("secondary")) this.setPrimaryCamera(camera.name);
      } else {
        previousTap = event.timeStamp;
      }
    });
    return panel;
  }

  historicalVideoStateBadge(player) {
    if (player?.message === "No recording at this time." &&
        player.statusElement?.hidden === false) return "";
    return player?.holdStartedAtMs != null &&
      Number.isFinite(player.heldFrameEpoch) && player.heldCanvas?.hidden === false
      ? "Ended" : "Historical";
  }

  updateHistoricalVideoStateBadge(player) {
    const badge = this._mediaPanels.get(player.camera.name)
      ?.querySelector(".review-camera-presentation-kind");
    if (badge) {
      badge.textContent = this.historicalVideoStateBadge(player);
      badge.hidden = !badge.textContent;
    }
  }

  reconcileHistoricalAssignments() {
    if (this._presentationMode !== "historical") return;
    for (const [name, player] of this._historicalPlayers) {
      const slot = this.assignedSlotForCamera(name);
      if (slot === null) {
        this.cleanupHistoricalPlayer(player);
        this._historicalPlayers.delete(name);
        continue;
      }
      // A slot move keeps the same selected player, source and pending operation.
      const transition = player.transition;
      if (transition && player.requestId === this._reviewRequestId &&
          transition.requestId === this._reviewRequestId) {
        transition.assignmentRevision = this._assignmentRevision;
        transition.slot = slot;
      }
    }
  }

  syncMediaPanels() {
    this.reconcileHistoricalAssignments();
    const wall = this._root?.querySelector(".review-camera-wall");
    if (!wall) return;
    const historicalNames = this._presentationMode === "historical"
      ? this._selectedCameraNames.filter(name =>
        this.isCurrentCameraWork(this._historicalPlayers.get(name)))
      : null;
    const selectedNames = historicalNames ?? this._selectedCameraNames;
    const selected = new Set(selectedNames);
    const displayAssignments = [...this._reviewAssignments];
    if (historicalNames) for (let slot = 0; slot < displayAssignments.length; slot += 1) {
      if (displayAssignments[slot] && !selected.has(displayAssignments[slot])) {
        displayAssignments[slot] = null;
      }
    }
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
      const name = displayAssignments[slot];
      const camera = this._cameras.find(candidate => candidate.name === name);
      if (!cell || !camera) continue;
      let panel = this._mediaPanels.get(camera.name);
      if (!panel) {
        panel = this.createCameraPanel(camera);
        this._mediaPanels.set(camera.name, panel);
      }
      panel.classList.toggle("primary", slot === 0);
      panel.classList.toggle("secondary", slot !== 0);
      panel.dataset.reviewSlot = String(slot);
      panel.dataset.assignmentRevision = String(this._assignmentRevision);
      const player = this._historicalPlayers.get(camera.name);
      if (this._presentationMode === "historical") {
        if (!this.isCurrentCameraWork(player) || this._reviewAssignments[slot] !== camera.name) {
          this.recordIdentityEvent(player?.diagnosticReport, player, "render-rejected", { slot });
          panel.remove();
          this._mediaPanels.delete(camera.name);
          continue;
        }
        player.renderedSlot = slot;
        const diagnostic = player.diagnosticReport?.cameras?.[camera.name];
        if (diagnostic) Object.assign(diagnostic, {
          renderedSlot: slot, assignmentRevision: this._assignmentRevision
        });
        this.recordIdentityEvent(player.diagnosticReport, player, "rendered", { slot });
      }
      cell.appendChild(panel);
    }
    if (selectedNames.length === 0) {
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

  updateEventNavigationControls() {
    const { previous, next } = this.getEventNavigationTargets();
    const unavailable = !this._active || this._suspended;
    const previousButton = this._transportRoot?.querySelector(".review-previous-event");
    const nextButton = this._transportRoot?.querySelector(".review-next-event");
    if (previousButton) previousButton.disabled = unavailable || !previous;
    if (nextButton) nextButton.disabled = unavailable || !next;
  }

  updateTransport() {
    const playable = [...this._historicalPlayers.values()].some(player =>
      player.lifecycleState === "participating" && player.video && player.hls);
    const inHistorical = this._presentationMode === "historical";
    const readyHistorical = inHistorical &&
      !this._historicalPreparing &&
      playable;
    const pause = this._transportRoot?.querySelector(".review-pause");
    const play = this._transportRoot?.querySelector(".review-play");
    const back = this._transportRoot?.querySelector(".review-back-ten");
    const forward = this._transportRoot?.querySelector(".review-forward-ten");
    if (pause) {
      pause.disabled = !inHistorical || (!this.clock.running && !this._playRequested);
      pause.classList.toggle("selected", inHistorical && this.clock.running);
    }
    if (play) {
      play.disabled = !inHistorical || this.clock.running;
      play.classList.toggle("selected", inHistorical && !this.clock.running);
    }
    if (back) back.disabled = !readyHistorical;
    if (forward) forward.disabled = !readyHistorical;
    this.updateEventNavigationControls();
    const speed = this._transportRoot?.querySelector(".review-speed-select");
    if (speed) {
      speed.value = String(this._playbackSpeed);
      speed.disabled = !readyHistorical;
    }
    this.updateClockDisplay();
  }

  updateClockDisplay() {
    const output = this._root?.querySelector(".review-time-truth .review-clock-display");
    if (!output) return;
    const absolute = this.reviewPosition;
    output.textContent = Number.isFinite(absolute)
      ? formatNvrClockTime(absolute, this.timeZone, this._timeFormat, "footer")
      : "";
    output.dateTime = Number.isFinite(absolute) ? new Date(absolute * 1000).toISOString() : "";
    this.updateTimelineCursor();
    this.updateEventNavigationControls();
  }

  pausePlayback() {
    if (this._presentationMode !== "historical" || (!this.clock.running && !this._playRequested)) return false;
    this._playRequested = false;
    const players = [...this._historicalPlayers.values()].filter(player =>
      (player.lifecycleState === "participating" || player.transition?.playPending) && player.video);
    this.clock.pause();
    this.clearHistoricalBoundaryTimer();
    players.forEach(player => {
      player.transition?.interruptPendingPlay?.();
      player.video.pause();
    });
    this.updateTransport();
    this.updateDiagnostics();
    return true;
  }

  resumePlayback() {
    if (this._presentationMode !== "historical" || this.clock.running) return false;
    this._playRequested = true;
    if (this._historicalPreparing) {
      this.updateTransport();
      return true;
    }
    const players = [...this._historicalPlayers.values()].filter(player =>
      player.lifecycleState === "participating" && player.video);
    if (players.length === 0 && this._historicalPlayers.size === 0) {
      this._playRequested = false;
      return false;
    }
    this._playRequested = false;
    this.clock.start();
    players.forEach(player => { void this.startOwnedPlayback(player); });
    this.scheduleHistoricalBoundaryTimer();
    this.updateTransport();
    this.updateDiagnostics();
    return true;
  }

  async seekHistoricalRelative(deltaSeconds) {
    if (this._presentationMode !== "historical" ||
        !Number.isFinite(this.clock.absoluteTime)) return false;
    let target = this.clock.absoluteTime + Number(deltaSeconds);
    if (this._historicalPlaybackRange) {
      const now = this._wallClock() / 1000;
      const upper = Math.min(this._historicalPlaybackRange.to, now);
      if (target >= upper && this._historicalPlaybackRange.to > now) {
        this.returnToLive();
        return true;
      }
      target = Math.min(upper, Math.max(this._historicalPlaybackRange.from, target));
    }
    return this.seekHistoricalToEpoch(target, {
      autoplay: this.clock.running,
      source: "VCR seek"
    });
  }

  async seekHistoricalToEpoch(targetEpoch, {
    autoplay = this.clock.running,
    source = "explicit historical seek"
  } = {}) {
    const target = Number(targetEpoch);
    if (this._presentationMode !== "historical" || !Number.isFinite(target)) return false;
    const generation = this._generation;
    // Explicit placement supersedes older work even when it reuses the source.
    const requestId = ++this._reviewRequestId;
    this._playRequested = autoplay;
    this._historicalPreparing = true;
    this.endSyncReport(source);
    const players = [...this._historicalPlayers.values()];
    const report = this.startSyncReport(
      generation, target, players.map(player => player.camera), source
    );
    for (const player of players) {
      for (const cancel of [...player.waitCancellations]) cancel();
      player.requestId = requestId;
      player.diagnosticReport = report;
      const diagnostic = report?.cameras?.[player.camera.name];
      if (diagnostic) Object.assign(diagnostic, {
        requestId: player.requestId,
        cameraWorkId: player.cameraWorkId,
        presentationId: player.presentationId,
        assignmentRevision: this._assignmentRevision,
        cameraEntity: player.camera.entity,
        frigateCamera: player.frigateCamera,
        returnedCamera: player.returnedCamera,
        playerId: player.playerId,
        hlsId: player.hlsId,
        videoId: player.videoId,
        panelId: player.panelId,
        panelCamera: player.panelCamera,
        renderedSlot: player.renderedSlot
      });
      if (player.transition?.reason === "play_release") {
        // Supersede only the Play command; an explicit seek can retain its source.
        player.transition.hls = null;
        this.cancelCameraTransition(player);
        this.setCameraLifecycle(player, "participating");
      }
      if (player.lifecycleState === "preparing") {
        this.cancelCameraTransition(player);
        this.cleanupHistoricalPlayer(player);
        this.setCameraLifecycle(player, "unavailable", {
          boundaryReason: "superseded_by_explicit_seek", targetEpoch: target
        });
      }
      if (player.lifecycleState === "participating") player.video?.pause();
    }
    this.clock.pause();
    this.clock.setAbsolute(target);
    const results = await this.evaluateHistoricalAvailability(target, {
      explicit: true, reason: source, autoplay: false
    });
    if (generation !== this._generation || requestId !== this._reviewRequestId ||
        !this._active || this._suspended) return false;
    const playable = players.filter(player =>
      player.lifecycleState === "participating" && player.video && player.hls);
    const resolvedEpochs = playable
      .map(player => Number(player.resolvedEpoch))
      .filter(Number.isFinite);
    const resolvedEpoch = resolvedEpochs.length ? Math.min(...resolvedEpochs) : target;
    this.clock.setAbsolute(resolvedEpoch);
    this._historicalPreparing = false;
    if (this._playRequested && playable.length) {
      this.clock.start();
      await Promise.allSettled(playable.map(player => this.startOwnedPlayback(player)));
    }
    if (requestId !== this._reviewRequestId || generation !== this._generation) return false;
    this._playRequested = false;
    if (report && generation === this._generation && this._syncSession === report) {
      const atMs = this._now();
      report.barrier = {
        atMs,
        ready: playable.map(player => player.camera.name),
        unavailable: players.filter(player => player.lifecycleState !== "participating")
          .map(player => player.camera.name),
        reviewClockAnchorMs: this.clock._startedAt,
        reviewClockAnchorEpoch: this.clock._absolute,
        snapshot: this.syncSnapshot(playable, report, atMs)
      };
      report.disposition = playable.length === 0 ? "all unavailable" :
        playable.length < players.length ? "partial release" : "released";
      report.reconciliation = results;
      this.updateSyncSummary(report);
    }
    this._historicalPreparing = false;
    this.updateHistoricalAvailabilityStatus();
    if (playable.length) this.scheduleHistoricalBoundaryTimer(generation);
    this.updateTransport();
    this.updateClockDisplay();
    this.updateDiagnostics();
    return true;
  }
  clearHistoricalBoundaryTimer() {
    if (this._historicalBoundaryTimer === null) return;
    const view = this._root?.ownerDocument?.defaultView ?? globalThis;
    view.clearTimeout(this._historicalBoundaryTimer);
    this._historicalBoundaryTimer = null;
  }

  scheduleHistoricalBoundaryTimer(generation = this._generation) {
    this.clearHistoricalBoundaryTimer();
    if (generation !== this._generation || this._presentationMode !== "historical" ||
        !this.clock.running) return;
    this.queueHistoricalAvailabilityEvaluation("playback_started");
  }

  continueHistoricalPresentation(player, logicalWallEnd, achievedEpoch) {
    const left = this.leaveHistoricalCamera(
      player, "continuous_presentation_exhausted", logicalWallEnd, achievedEpoch
    );
    if (left) {
      void this.reconcileHistoricalCamera(player, logicalWallEnd, {
        reason: "presentation_window_exhausted", autoplay: this.clock.running
      }).catch(() => {});
    }
    return left;
  }

  enforceHistoricalPresentationBoundary(generation = this._generation) {
    if (generation !== this._generation || this._presentationMode !== "historical") return false;
    let transitioned = false;
    for (const player of this._historicalPlayers.values()) {
      if (player.lifecycleState !== "participating" || !player.timing?.time_map) continue;
      const achievedEpoch = this.cameraEpochFromMedia(player);
      if (Number.isFinite(achievedEpoch)) player.lastAchievedEpoch = achievedEpoch;
      const mediaTime = Number(player.video?.currentTime);
      const logicalMediaEnd = Number(player.timing.logical_media_end_position);
      const atLogicalEnd = Number.isFinite(mediaTime) && Number.isFinite(logicalMediaEnd) &&
        mediaTime >= logicalMediaEnd - 0.02;
      const inspected = this.inspectPlayerAvailability(player, achievedEpoch);
      if (inspected.insideWindow && !inspected.containing) {
        transitioned = this.leaveHistoricalCamera(
          player, "authoritative_recording_gap", achievedEpoch, achievedEpoch
        ) || transitioned;
        continue;
      }
      if (!atLogicalEnd) continue;
      const logicalWallEnd = Number(player.timing.logical_wall_end);
      if (this._historicalPlaybackRange &&
          logicalWallEnd >= this._historicalPlaybackRange.to - 0.02) continue;
      const boundary = this.inspectPlayerAvailability(player, logicalWallEnd);
      if (boundary.insideWindow && !boundary.containing) {
        transitioned = this.leaveHistoricalCamera(
          player, "authoritative_recording_gap", logicalWallEnd, achievedEpoch
        ) || transitioned;
      } else if (boundary.insideWindow && boundary.containing) {
        transitioned = this.continueHistoricalPresentation(
          player, logicalWallEnd, achievedEpoch
        ) || transitioned;
      } else {
        this.handleHistoricalVideoEnded(player, generation);
      }
    }
    return transitioned;
  }

  async resolveHistoricalVideoEnd(player, generation) {
    if (!this.isCurrentCameraWork(player, generation) ||
        player.lifecycleState !== "participating" || !player.timing?.time_map) return;
    const timing = player.timing;
    const hls = player.hls;
    if (player.endResolution?.timing === timing &&
        player.endResolution?.hls === hls) return;
    const resolution = { timing, hls };
    player.endResolution = resolution;
    try {
      const mediaTime = Number(player.video?.currentTime);
      const logicalMediaEnd = Number(player.timing.logical_media_end_position);
      const achievedEpoch = this.cameraEpochFromMedia(player);
      if (!(Number.isFinite(mediaTime) && Number.isFinite(logicalMediaEnd) &&
          mediaTime >= logicalMediaEnd - 0.05)) {
        this.leaveHistoricalCamera(
          player, "unexpected_media_end", achievedEpoch, achievedEpoch, "failed"
        );
        return;
      }
      const logicalWallEnd = Number(timing.logical_wall_end);
      if (this._historicalPlaybackRange &&
          logicalWallEnd >= this._historicalPlaybackRange.to - 0.05) return;
      try {
        await this.ensureCameraAvailability(player, logicalWallEnd, {
          reason: "media_logical_end"
        });
      } catch (error) {
        this.recordReviewFailure(player, { reason: "availability_api_failure",
          outcome: "retained_after_failure", stage: "availability",
          targetEpoch: logicalWallEnd, occurrence: player.availabilityRequestToken });
        this.recordCameraBoundary(player, "availability-refresh-failed-player-retained", {
          reason: "media_logical_end",
          targetEpoch: logicalWallEnd,
          error: sanitizeReviewError(error)
        });
        player.video?.pause();
        return;
      }
      if (!this.isCurrentCameraWork(player, generation) ||
          player.timing !== timing || player.hls !== hls) return;
      const boundary = this.inspectPlayerAvailability(player, logicalWallEnd);
      if (!boundary.containing) {
        this.leaveHistoricalCamera(
          player, "authoritative_recording_gap", logicalWallEnd, achievedEpoch
        );
      } else {
        this.continueHistoricalPresentation(player, logicalWallEnd, achievedEpoch);
      }
    } finally {
      if (player.endResolution === resolution) player.endResolution = null;
    }
  }

  handleHistoricalVideoEnded(player, generation) {
    if (generation !== this._generation || this._presentationMode !== "historical" ||
        player.unavailable || !player.timing?.time_map || this._continuousHandoffPrototypeRun) return;
    void this.resolveHistoricalVideoEnd(player, generation);
  }
  setPlayerStatus(player, message, unavailable = false) {
    player.message = message;
    player.unavailable = unavailable;
    if (player.statusElement) {
      player.statusElement.textContent = message;
      player.statusElement.hidden = !message || player.holdStartedAtMs != null;
      player.statusElement.classList.toggle("unavailable", unavailable);
      player.statusElement.classList.toggle("held", player.holdStartedAtMs != null);
    }
    this.updateHistoricalVideoStateBadge(player);
  }

  recordCameraBoundary(player, kind, details = {}) {
    this.recordSceneEvent(player, kind, details);
    const diagnostic = player?.diagnosticReport?.cameras?.[player.camera?.name];
    if (!diagnostic) return;
    diagnostic.boundaryEvents ??= [];
    diagnostic.boundaryEvents.push({ atMs: this._now(), kind, ...details });
    if (diagnostic.boundaryEvents.length > 32) diagnostic.boundaryEvents.shift();
  }

  setCameraLifecycle(player, state, {
    message = state === "unavailable" ? "No recording at this time." : "",
    boundaryReason = null,
    targetEpoch = null,
    achievedEpoch = null
  } = {}) {
    const previousState = player.lifecycleState;
    const previousReason = player.boundaryReason;
    if (boundaryReason === "authoritative_recording_gap" &&
        state === "unavailable" && previousState !== "unavailable") {
      this.recordReviewFailure(player, { reason: boundaryReason, outcome: "no_coverage",
        stage: "availability", targetEpoch });
    }
    player.lifecycleRevision = (player.lifecycleRevision ?? 0) + 1;
    player.lifecycleState = state;
    player.boundaryReason = boundaryReason;
    player.lastTargetEpoch = Number.isFinite(targetEpoch) ? targetEpoch : player.lastTargetEpoch;
    player.lastAchievedEpoch = Number.isFinite(achievedEpoch) ? achievedEpoch : player.lastAchievedEpoch;
    this.setPlayerStatus(player, message, state === "unavailable" || state === "failed");
    if (state !== previousState || boundaryReason !== previousReason) {
      this.recordSceneEvent(player, "lifecycle", { state, previousState,
        boundaryReason, targetEpoch, achievedEpoch });
    }
    const diagnostic = player.diagnosticReport?.cameras?.[player.camera.name];
    if (diagnostic) {
      diagnostic.lifecycleState = state;
      diagnostic.status = state === "participating" ? "released" : state;
      diagnostic.reason = boundaryReason;
      diagnostic.targetEpoch = Number.isFinite(targetEpoch) ? targetEpoch : null;
      diagnostic.achievedMediaEpoch = Number.isFinite(achievedEpoch) ? achievedEpoch : null;
    }
  }

  updateHistoricalAvailabilityStatus() {
    const players = [...this._historicalPlayers.values()];
    const participating = players.filter(player => player.lifecycleState === "participating").length;
    const preparing = players.some(player => player.lifecycleState === "preparing");
    this._historicalStatus = preparing
      ? "Preparing playback…"
      : participating === 0
        ? "No recording at this time."
        : participating < players.length
          ? "Some cameras have no recording."
          : "";
  }

  setCurrentPlayerStatus(player, message, unavailable = false, generation = player?.generation) {
    if (!this.isCurrentCameraWork(player, generation)) {
      this.recordIdentityEvent(player?.diagnosticReport, player, "stale-status-rejected");
      return false;
    }
    this.setPlayerStatus(player, message, unavailable);
    return true;
  }

  getContinuousHandoffPrototypeReport() {
    return this._continuousHandoffPrototypeReport
      ? JSON.parse(JSON.stringify(this._continuousHandoffPrototypeReport)) : null;
  }

  recordContinuousHandoffPrototype(report, kind, details = {}) {
    if (!report) return;
    const event = {
      atMs: this._now() - report.startedAtMs,
      kind,
      ...details
    };
    report.events.push(event);
    if (report.events.length > CONTINUOUS_HANDOFF_PROTOTYPE_EVENT_LIMIT) {
      report.events.splice(0, report.events.length - CONTINUOUS_HANDOFF_PROTOTYPE_EVENT_LIMIT);
    }
    if (globalThis.window === globalThis) {
      globalThis.console?.info?.("[NVR continuous VOD prototype]", event);
    }
  }

  setContinuousHandoffPrototypeRate(rate) {
    const value = Number(rate);
    if (!CONTINUOUS_HANDOFF_PROTOTYPE_RATES.includes(value)) {
      throw new Error("The continuous handoff prototype supports only 1x or 0.25x.");
    }
    this._playbackSpeed = value;
    this.clock.setRate(value);
    for (const player of this._historicalPlayers.values()) {
      if (!player.video) continue;
      player.video.defaultPlaybackRate = value;
      player.video.playbackRate = value;
    }
    return value;
  }

  async requestRecordingAvailability(player, range) {
    if (!this._hass || typeof this._hass.callWS !== "function") {
      throw new Error("Home Assistant WebSocket API is unavailable.");
    }
    const result = await this._hass.callWS({
      type: "frigate_max/v1/recordings/availability",
      camera: player.frigateCamera,
      start: range.start,
      end: range.end
    });
    return normalizeRecordingAvailability(result, player.frigateCamera);
  }

  availabilityWindowForTarget(targetEpoch) {
    return buildRecordingAvailabilityWindow(targetEpoch, this._historicalPlaybackRange);
  }

  inspectPlayerAvailability(player, targetEpoch) {
    return inspectRecordingAvailability(player?.availability, targetEpoch);
  }

  updateAvailabilityDiagnostic(player, targetEpoch, reason) {
    const availability = player?.availability;
    if (!availability) return;
    const inspected = inspectRecordingAvailability(availability, targetEpoch);
    const diagnostic = player.diagnosticReport?.cameras?.[player.camera.name];
    if (diagnostic) diagnostic.availability = {
      requestedStart: availability.requested_start,
      requestedEnd: availability.requested_end,
      coverage: availability.coverage.map(interval => ({ ...interval })),
      containing: inspected.containing ? { ...inspected.containing } : null,
      previousEnd: inspected.previousEnd,
      nextStart: inspected.nextStart,
      reason
    };
  }

  availabilityNeedsRefresh(player, targetEpoch) {
    const inspected = this.inspectPlayerAvailability(player, targetEpoch);
    if (!inspected.insideWindow) return true;
    const end = Number(player.availability?.requested_end);
    const playbackEnd = Number(this._historicalPlaybackRange?.to);
    return targetEpoch >= end - REVIEW_AVAILABILITY_EDGE_REFRESH_SECONDS &&
      !(Number.isFinite(playbackEnd) && end >= playbackEnd);
  }

  async ensureCameraAvailability(player, targetEpoch, {
    force = false,
    transition = null,
    reason = "availability_check"
  } = {}) {
    this.assertCurrentCameraWork(player, player.generation);
    if (transition) this.assertCurrentCameraTransition(player, transition);
    if (!force && !this.availabilityNeedsRefresh(player, targetEpoch)) {
      this.updateAvailabilityDiagnostic(player, targetEpoch, reason);
      return player.availability;
    }
    if (player.availabilityPromise) {
      const cached = await player.availabilityPromise;
      if (transition) this.assertCurrentCameraTransition(player, transition);
      if (!force && !this.availabilityNeedsRefresh(player, targetEpoch)) return cached;
    }
    const range = this.availabilityWindowForTarget(targetEpoch);
    const requestToken = ++player.availabilityRequestToken;
    const request = this.requestRecordingAvailability(player, range).then(availability => {
      this.assertCurrentCameraWork(player, player.generation);
      if (transition) this.assertCurrentCameraTransition(player, transition);
      if (requestToken !== player.availabilityRequestToken) {
        throw new Error("Historical availability request was superseded.");
      }
      player.availability = availability;
      const inspected = inspectRecordingAvailability(availability, targetEpoch);
      this.updateAvailabilityDiagnostic(player, targetEpoch, reason);
      this.recordCameraBoundary(player, "availability-refreshed", {
        reason, targetEpoch, containing: inspected.containing ? { ...inspected.containing } : null,
        nextCoverageStart: inspected.nextStart
      });
      return availability;
    });
    player.availabilityPromise = request;
    try {
      return await request;
    } finally {
      if (player.availabilityPromise === request) player.availabilityPromise = null;
    }
  }

  beginCameraTransition(player, reason, targetEpoch, { preservePlacement = false } = {}) {
    this.cancelCameraTransition(player);
    if (!preservePlacement) player.initialPlacement = null;
    const transition = {
      token: ++this._cameraTransitionSequence,
      reason,
      targetEpoch,
      generation: player.generation,
      requestId: player.requestId,
      presentationId: player.presentationId,
      assignmentRevision: this._assignmentRevision,
      slot: this.assignedSlotForCamera(player.camera.name),
      hls: null,
      cancellations: []
    };
    player.transitionToken = transition.token;
    player.transition = transition;
    player.reviewStage = "prepare";
    player.reviewLanding = "not_started";
    player.reviewPlay = "not_attempted";
    player.reviewHlsError = null;
    player.reviewTimingPrepared = preservePlacement && Boolean(player.timing?.time_map);
    this.setCameraLifecycle(player, "preparing", {
      message: "Preparing…", boundaryReason: reason, targetEpoch
    });
    const diagnostic = player.diagnosticReport?.cameras?.[player.camera.name];
    if (diagnostic) diagnostic.transition = {
      token: transition.token,
      reason,
      targetEpoch,
      assignmentRevision: transition.assignmentRevision,
      slot: transition.slot,
      outcome: "pending"
    };
    this.recordCameraBoundary(player, "transition-started", {
      reason, targetEpoch, transitionToken: transition.token
    });
    return transition;
  }

  isCurrentCameraTransition(player, transition) {
    return Boolean(transition && this.isCurrentCameraWork(player, transition.generation) &&
      player.transition === transition && player.transitionToken === transition.token &&
      transition.requestId === this._reviewRequestId &&
      transition.presentationId === player.presentationId &&
      (transition.reason === "initial_selection" ||
        transition.hls === null || transition.hls === player.hls) &&
      transition.assignmentRevision === this._assignmentRevision &&
      transition.slot === this.assignedSlotForCamera(player.camera.name));
  }

  assertCurrentCameraTransition(player, transition) {
    if (!this.isCurrentCameraTransition(player, transition)) {
      this.recordIdentityEvent(player?.diagnosticReport, player, "stale-transition-rejected", {
        transitionToken: transition?.token ?? null
      });
      throw new Error("Historical camera transition was cancelled.");
    }
  }

  cancelCameraTransition(player) {
    const transition = player?.transition;
    if (!transition) return;
    player.transition = null;
    for (const cancel of [...transition.cancellations]) cancel();
    transition.cancellations = [];
    if (transition.hls) {
      if (player.hls === transition.hls) {
        try { player.video?.pause(); } catch {}
        try {
          player.video?.removeAttribute("src");
          player.video?.load();
        } catch {}
        player.hls = null;
      }
      try { transition.hls.destroy?.(); } catch {}
    }
    transition.cleaned = true;
    const diagnostic = player.diagnosticReport?.cameras?.[player.camera.name];
    if (diagnostic?.transition?.token === transition.token &&
        diagnostic.transition.outcome === "pending") {
      diagnostic.transition.outcome = "cancelled";
    }
  }

  instrumentContinuousHandoffVideo(player, report) {
    const events = [
      "emptied", "loadedmetadata", "canplay", "waiting", "playing", "ended", "error"
    ];
    player.syncListeners ??= [];
    for (const name of events) {
      const handler = () => this.recordContinuousHandoffPrototype(report, `video:${name}`, {
        mediaTime: Number(player.video?.currentTime),
        paused: Boolean(player.video?.paused),
        readyState: Number(player.video?.readyState)
      });
      player.video.addEventListener(name, handler);
      player.syncListeners.push([name, handler]);
    }
  }

  instrumentContinuousHandoffHls(player, Hls, hls, report) {
    const names = [
      "MEDIA_ATTACHING", "MEDIA_ATTACHED", "MANIFEST_LOADING", "MANIFEST_LOADED",
      "MANIFEST_PARSED", "LEVEL_LOADING", "LEVEL_LOADED", "FRAG_LOADING",
      "FRAG_LOADED", "ERROR", "DESTROYING", "MEDIA_DETACHING", "MEDIA_DETACHED"
    ];
    const seen = new Set();
    for (const name of names) {
      const event = Hls.Events?.[name];
      if (!event || seen.has(event)) continue;
      seen.add(event);
      const handler = (_event, data) => this.recordContinuousHandoffPrototype(
        report,
        `hls:${name.toLowerCase()}`,
        name === "ERROR" ? {
          fatal: Boolean(data?.fatal),
          type: typeof data?.type === "string" ? data.type : null,
          details: typeof data?.details === "string" ? data.details : null,
          responseCode: Number.isFinite(Number(data?.response?.code))
            ? Number(data.response.code) : null
        } : {}
      );
      hls.on(event, handler);
      player.hlsListeners.push([event, handler]);
    }
  }

  waitForContinuousHandoffBoundary(player, generation, report, boundary, rate) {
    const video = player.video;
    const view = video.ownerDocument?.defaultView ?? globalThis;
    const remaining = Math.max(0, boundary - Number(this.clock.absoluteTime));
    const timeoutMs = Math.max(
      60000,
      Math.min(900000, ((remaining / rate) + 60) * 1000)
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      let cancel = null;
      const finish = error => {
        if (settled) return;
        settled = true;
        view.clearTimeout(timeout);
        view.clearInterval(staleCheck);
        video.removeEventListener("ended", onEnded);
        const index = player.waitCancellations.indexOf(cancel);
        if (index >= 0) player.waitCancellations.splice(index, 1);
        if (error) reject(error);
        else resolve();
      };
      const onEnded = () => finish();
      const staleCheck = view.setInterval(() => {
        if (generation !== this._generation || !this._active || this._suspended) {
          finish(new Error("Prototype successor became stale."));
        }
      }, 100);
      const timeout = view.setTimeout(
        () => finish(new Error("Prototype active source did not reach its boundary.")),
        timeoutMs
      );
      cancel = () => finish(new Error("Prototype successor became stale."));
      player.waitCancellations.push(cancel);
      video.addEventListener("ended", onEnded, { once: true });
      this.recordContinuousHandoffPrototype(report, "successor:waiting-for-boundary", {
        remainingRecordingSeconds: remaining,
        expectedWallSeconds: remaining / rate
      });
    });
  }

  async attachContinuousHandoffPrototypeSource(
    player, descriptor, Hls, generation, report, handoffEpoch, shouldResume
  ) {
    const video = player.video;
    const oldHls = player.hls;
    try { video.pause(); } catch {}
    this.clock.pause();
    this.recordContinuousHandoffPrototype(report, "handoff:replace-source", {
      handoffEpoch,
      mediaTime: Number(video.currentTime),
      playbackRate: Number(video.playbackRate),
      playIntent: shouldResume ? "playing" : "paused"
    });
    oldHls?.destroy?.();
    player.hlsListeners = [];
    try {
      video.removeAttribute("src");
      video.load();
    } catch {}

    const replacementStartedAtMs = this._now();
    report.handoff.sourceReplacementAtMs = replacementStartedAtMs - report.startedAtMs;
    player.timing = descriptor.timing;
    player.seek = calculateHistoricalSeek(handoffEpoch, player.timing);
    const hls = new Hls({ enableWorker: true, maxBufferLength: 20 });
    player.hls = hls;
    this.instrumentContinuousHandoffHls(player, Hls, hls, report);
    video.defaultPlaybackRate = report.rate;
    video.playbackRate = report.rate;

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
      const onManifest = () => finish();
      const onError = (_event, data) => {
        if (data?.fatal) finish(new Error("Prototype successor manifest failed."));
      };
      cancel = () => finish(new Error("Prototype successor became stale."));
      hls.on(Hls.Events.MANIFEST_PARSED, onManifest);
      hls.on(Hls.Events.ERROR, onError);
      player.hlsListeners.push([Hls.Events.MANIFEST_PARSED, onManifest]);
      player.hlsListeners.push([Hls.Events.ERROR, onError]);
      player.waitCancellations.push(cancel);
    });

    hls.attachMedia(video);
    hls.loadSource(descriptor.signedPath);
    await manifestReady;
    this.assertCurrentGeneration(generation);
    await waitForMediaEvent(
      video, "progress", () => video.seekable?.length > 0,
      this._mediaReadyTimeoutMs, player.waitCancellations
    );
    this.assertCurrentGeneration(generation);
    report.handoff.playbackRateAfterAttachment = Number(video.playbackRate);
    await this.seekHistoricalPlayer(player, generation);
    video.defaultPlaybackRate = report.rate;
    video.playbackRate = report.rate;
    report.handoff.successorReadyMs = this._now() - report.startedAtMs;
    report.handoff.sourceReplacementToReadyMs = this._now() - replacementStartedAtMs;
    report.handoff.mediaTimeAfterReadiness = Number(video.currentTime);
    report.handoff.reconstructedSuccessorEpoch =
      player.timing.effective_absolute_origin + Number(video.currentTime);
    report.handoff.playbackRateAfterReadiness = Number(video.playbackRate);

    this.clock.setAbsolute(handoffEpoch);
    this.clock.setRate(report.rate);
    if (shouldResume) {
      let playingEventSeen = false;
      const markPlayingEvent = () => { playingEventSeen = true; };
      video.addEventListener("playing", markPlayingEvent, { once: true });
      const playing = waitForMediaEvent(
        video, "playing", () => playingEventSeen,
        this._mediaReadyTimeoutMs, player.waitCancellations
      );
      try {
        this.clock.start();
        await Promise.resolve(video.play());
        await playing;
      } finally {
        video.removeEventListener("playing", markPlayingEvent);
      }
      report.handoff.boundaryToPlayingMs =
        this._now() - report.handoff.boundaryAtMonotonicMs;
    } else {
      try { video.pause(); } catch {}
    }
    this.assertCurrentGeneration(generation);
    report.handoff.reviewClockAfter = this.clock.absoluteTime;
    report.handoff.playbackRateAfterHandoff = Number(video.playbackRate);
    report.handoff.actualPausedAfterHandoff = Boolean(video.paused);
    report.handoff.sameVideoElement = player.video === video;
    this._historicalRange = descriptor.range;
    this.recordContinuousHandoffPrototype(report, "handoff:complete", {
      reviewClockEpoch: report.handoff.reviewClockAfter,
      reconstructedEpoch: report.handoff.reconstructedSuccessorEpoch,
      playbackRate: report.handoff.playbackRateAfterHandoff,
      paused: report.handoff.actualPausedAfterHandoff
    });
  }

  async runContinuousHandoffPrototype({
    cameraName = CONTINUOUS_HANDOFF_PROTOTYPE_CAMERA,
    targetEpoch,
    rate = 1
  } = {}) {
    if (this._continuousHandoffPrototypeRun) {
      throw new Error("A continuous handoff prototype is already running.");
    }
    if (cameraName !== CONTINUOUS_HANDOFF_PROTOTYPE_CAMERA) {
      throw new Error("The continuous handoff prototype is restricted to Garage.");
    }
    const target = Number(targetEpoch);
    if (!Number.isFinite(target)) {
      throw new Error("The continuous handoff prototype requires a finite targetEpoch.");
    }
    const playbackRate = Number(rate);
    if (!CONTINUOUS_HANDOFF_PROTOTYPE_RATES.includes(playbackRate)) {
      throw new Error("The continuous handoff prototype supports only 1x or 0.25x.");
    }

    const report = {
      prototype: "single-camera-continuous-vod-handoff",
      cameraName,
      targetEpoch: target,
      rate: playbackRate,
      startedAtMs: this._now(),
      outcome: "running",
      active: null,
      availability: null,
      successor: null,
      handoff: {},
      events: []
    };
    this._continuousHandoffPrototypeReport = report;
    const run = (async () => {
      try {
        this.setSelectedCameraNames([cameraName]);
        this.setContinuousHandoffPrototypeRate(playbackRate);
        await this.playHistorical(target, {
          cameraNames: [cameraName],
          source: "continuous VOD handoff prototype"
        });
        const generation = this._generation;
        this.assertCurrentGeneration(generation);
        const player = this._historicalPlayers.get(cameraName);
        if (!player?.video || !player.hls || !player.timing || player.unavailable) {
          if (this._presentationMode !== "historical" || !this._historicalPlayers.has(cameraName)) {
            throw new Error("The continuous handoff prototype became stale or was cancelled.");
          }
          throw new Error("Garage historical playback was not ready for the prototype.");
        }
        const Hls = await this._loadHls();
        this.assertCurrentGeneration(generation);
        this.instrumentContinuousHandoffVideo(player, report);
        this.instrumentContinuousHandoffHls(player, Hls, player.hls, report);
        const activeRequestedStart = player.timing.requested_start ?? player.timing.requested_wall_start;
        const activeRequestedEnd = player.timing.requested_end ?? player.timing.requested_wall_end;
        report.active = {
          requestedStart: activeRequestedStart,
          requestedEnd: activeRequestedEnd,
          effectiveOrigin: player.timing.effective_absolute_origin
        };
        const successorRange = buildReviewRange(activeRequestedEnd);
        const availability = await this.requestRecordingAvailability(player, successorRange);
        this.assertCurrentGeneration(generation);
        const plan = planContinuousHandoffPrototype({
          ...player.timing,
          requested_end: activeRequestedEnd
        }, availability);
        report.availability = {
          requestedStart: availability.requested_start,
          requestedEnd: availability.requested_end,
          coverage: availability.coverage.map(interval => ({ ...interval })),
          permitsSuccessor: plan.allowed
        };
        if (!plan.allowed) {
          report.outcome = "blocked-by-recording-gap";
          this.recordContinuousHandoffPrototype(report, "successor:blocked-by-recording-gap");
          return this.getContinuousHandoffPrototypeReport();
        }

        const timing = await this.requestPreparedTiming(player, plan.range, { legacy: true });
        this.assertCurrentGeneration(generation);
        const signedPath = await this.signManifest(player, plan.range);
        this.assertCurrentGeneration(generation);
        report.successor = {
          plannedAbsoluteEpoch: plan.boundary,
          requestedStart: timing.requested_start,
          requestedEnd: timing.requested_end,
          effectiveOrigin: timing.effective_absolute_origin,
          calculatedTargetSeek: timing.calculated_target_seek
        };
        this.recordContinuousHandoffPrototype(report, "successor:prepared", {
          plannedAbsoluteEpoch: plan.boundary,
          requestedStart: timing.requested_start,
          requestedEnd: timing.requested_end
        });

        const descriptor = { range: plan.range, timing, signedPath };
        await this.waitForContinuousHandoffBoundary(
          player, generation, report, plan.boundary, playbackRate
        );
        this.assertCurrentGeneration(generation);
        const shouldResume = this.clock.running;
        report.handoff.boundaryAtMonotonicMs = this._now();
        report.handoff.mediaTimeBefore = Number(player.video.currentTime);
        report.handoff.reviewClockBefore = this.clock.absoluteTime;
        report.handoff.playbackRateBefore = Number(player.video.playbackRate);
        report.handoff.playIntentBefore = shouldResume ? "playing" : "paused";
        const handoffEpoch = Number(this.clock.absoluteTime);
        await this.attachContinuousHandoffPrototypeSource(
          player, descriptor, Hls, generation, report, handoffEpoch, shouldResume
        );
        report.outcome = "completed";
        return this.getContinuousHandoffPrototypeReport();
      } catch (error) {
        report.outcome = /stale|cancel/i.test(String(error?.message)) ? "stale" : "error";
        report.error = sanitizeReviewError(error);
        this.recordContinuousHandoffPrototype(report, `prototype:${report.outcome}`);
        throw error;
      }
    })();
    this._continuousHandoffPrototypeRun = run;
    try {
      return await run;
    } finally {
      if (this._continuousHandoffPrototypeRun === run) {
        this._continuousHandoffPrototypeRun = null;
      }
    }
  }

  createHistoricalPlayer(camera, generation = this._generation, report = null) {
    const requestId = this._reviewRequestId;
    const cameraWorkId = ++this._cameraWorkSequence;
    const presentationId = ++this._presentationSequence;
    return {
      camera,
      frigateCamera: this.getFrigateCameraId(camera),
      returnedCamera: null,
      generation,
      requestId,
      cameraWorkId,
      presentationId,
      assignmentRevision: this._assignmentRevision,
      playerId: this.nextDiagnosticObjectId("player"),
      videoId: null,
      hlsId: null,
      panelId: null,
      panelCamera: null,
      renderedSlot: null,
      diagnosticReport: report,
      video: null,
      hls: null,
      hlsListeners: [],
      waitCancellations: [],
      lifecycleListeners: [],
      statusElement: null,
      message: "Loading...",
      unavailable: false,
      lifecycleState: "preparing",
      lifecycleRevision: 0,
      availability: null,
      availabilityPromise: null,
      availabilityRequestToken: 0,
      suppressedCoverage: null,
      transitionToken: 0,
      transition: null,
      boundaryReason: "initial_preparation",
      lastTargetEpoch: null,
      lastAchievedEpoch: null,
      initialPlacement: null,
      reviewStage: "availability",
      reviewLanding: "not_started",
      reviewPlay: "not_attempted",
      reviewHlsError: null,
      reviewTimingPrepared: false
    };
  }

  async requestPreparedTiming(player, range, { legacy = false, transition = null } = {}) {
    const requestId = player.requestId;
    const acceptIdentity = result => {
      if (requestId !== this._reviewRequestId) throw new Error("Historical preparation was superseded.");
      this.assertCurrentCameraBoundary(player, player.generation, transition);
      player.returnedCamera = typeof result?.camera === "string" &&
        /^[A-Za-z0-9_-]+$/.test(result.camera) ? result.camera : null;
    };
    this.recordSceneEvent(player, "vod-prepare-request", { targetEpoch: Number(range.targetEpoch) });
    if (!this._hass || typeof this._hass.callWS !== "function") {
      throw new Error("Home Assistant WebSocket API is unavailable.");
    }
    if (legacy) {
      const result = await this._hass.callWS({
        type: "frigate_max/v1/vod/prepare",
        camera: player.frigateCamera,
        requested_start: range.start,
        requested_end: range.end,
        target: range.targetEpoch
      });
      acceptIdentity(result);
      return normalizePreparedTiming(result, player.frigateCamera);
    }
    const target = Number(range.targetEpoch ?? range.target);
    const boundsStart = Number(range.boundsStart ?? range.start);
    const boundsEnd = Number(range.boundsEnd ?? range.end);
    const result = await this._hass.callWS({
      type: "frigate_max/v2/vod/prepare",
      camera: player.frigateCamera,
      target,
      bounds_start: boundsStart,
      bounds_end: boundsEnd
    });
    acceptIdentity(result);
    return validateHistoricalPresentation(result, player.frigateCamera);
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

  assignedSlotForCamera(cameraName) {
    const visibleSlots = new Set(this.currentLayout.cells.map(cell => cell.slot));
    const slot = this._reviewAssignments.findIndex((name, index) =>
      name === cameraName && visibleSlots.has(index));
    return slot >= 0 ? slot : null;
  }

  isCurrentCameraWork(player, generation = player?.generation) {
    return Boolean(player && generation === this._generation &&
      player.generation === generation && player.requestId === this._reviewRequestId &&
      this._active && !this._suspended && this._presentationMode === "historical" &&
      this._historicalPlayers.get(player.camera?.name) === player &&
      this.assignedSlotForCamera(player.camera?.name) !== null);
  }

  assertCurrentCameraWork(player, generation = player?.generation) {
    if (!this.isCurrentCameraWork(player, generation)) {
      this.recordIdentityEvent(player?.diagnosticReport, player, "stale-rejected");
      throw new Error("Historical camera work was cancelled.");
    }
  }

  assertCurrentCameraBoundary(player, generation, transition = null) {
    this.assertCurrentCameraWork(player, generation);
    if (transition) this.assertCurrentCameraTransition(player, transition);
  }

  async attachHistoricalPlayer(player, range, Hls, generation, report = null, transition = null) {
    const diagnostic = this.syncCamera(report, generation, player);
    this.syncStage(report, generation, player, "prepareStartMs");
    player.reviewStage = "prepare";
    try {
      const timing = await this.requestPreparedTiming(player, range, { transition });
      this.assertCurrentCameraBoundary(player, generation, transition);
      player.timing = timing;
      player.reviewTimingPrepared = true;
    } catch (error) {
      if (diagnostic) {
        diagnostic.prepareSucceeded = false;
        diagnostic.prepareFailure = /no recording|no vod/i.test(sanitizeReviewError(error))
          ? "prepare_reported_no_recording" : "prepare_api_failure";
      }
      throw error;
    } finally {
      this.syncStage(report, generation, player, "prepareCompleteMs");
    }
    this.assertCurrentCameraBoundary(player, generation, transition);
    player.returnedCamera = player.timing.camera ?? null;
    const identityDiagnostic = report?.cameras?.[player.camera.name];
    if (identityDiagnostic) identityDiagnostic.returnedCamera = player.returnedCamera;
    this.recordIdentityEvent(report, player, "prepare-validated");
    const selected = epochToMedia(player.timing, range.targetEpoch);
    player.seek = selected.mediaTime;
    player.resolvedEpoch = selected.resolvedEpoch;
    if (diagnostic) {
      diagnostic.prepareSucceeded = true;
      diagnostic.effectiveOriginEpoch = player.timing.effective_absolute_origin;
      diagnostic.requestedMediaTime = selected.mediaTime;
      diagnostic.resolvedEpoch = selected.resolvedEpoch;
      diagnostic.bounds = Object.fromEntries([
        "requested_wall_start", "requested_wall_end", "logical_wall_start", "logical_wall_end",
        "effective_absolute_origin", "media_start_position", "logical_media_end_position"
      ].map(key => [key, player.timing[key]]));
      diagnostic.insideKnownInterval = true;
    }
    player.reviewStage = "sign";
    const signedPath = await this.signManifest(player, {
      start: player.timing.requested_wall_start,
      end: player.timing.requested_wall_end
    });
    this.assertCurrentCameraBoundary(player, generation, transition);
    this.syncStage(report, generation, player, "manifestSignedMs");
    player.reviewStage = "manifest";
    const hls = new Hls({ enableWorker: true, maxBufferLength: 20 });
    if (transition) transition.hls = hls;
    player.hls = hls;
    const onReviewHlsError = (_event, data) => {
      if (!this.isCurrentCameraWork(player, generation) || player.hls !== hls) return;
      player.reviewHlsError = safeReviewHlsError(data);
      if (data?.fatal === true && player.lifecycleState === "participating") {
        this.recordReviewFailure(player, { reason: "hls_fatal", stage: "media",
          occurrence: player.presentationId });
      }
    };
    hls.on(Hls.Events.ERROR, onReviewHlsError);
    player.hlsListeners.push([Hls.Events.ERROR, onReviewHlsError]);
    this.recordSceneEvent(player, "hls-created");
    player.hlsId = this.nextDiagnosticObjectId("hls");
    if (identityDiagnostic) identityDiagnostic.hlsId = player.hlsId;
    const manifestReady = new Promise((resolve, reject) => {
      let settled = false;
      let cancel = null;
      const finish = error => {
        if (settled) return;
        settled = true;
        hls.off(Hls.Events.MANIFEST_PARSED, onManifest);
        hls.off(Hls.Events.ERROR, onError);
        const cancellations = transition?.cancellations ?? player.waitCancellations;
        const index = cancellations.indexOf(cancel);
        if (index >= 0) cancellations.splice(index, 1);
        if (error) reject(error);
        else resolve();
      };
      const onManifest = () => {
        this.syncStage(report, generation, player, "manifestParsedMs");
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
      (transition?.cancellations ?? player.waitCancellations).push(cancel);
    });
    this.assertCurrentCameraBoundary(player, generation, transition);
    hls.attachMedia(player.video);
    this.assertCurrentCameraBoundary(player, generation, transition);
    this.recordIdentityEvent(report, player, "hls-attached");
    this.syncStage(report, generation, player, "playerMountedMs");
    hls.loadSource(signedPath);
    this.recordSceneEvent(player, "source-loaded");
    await manifestReady;
    this.assertCurrentCameraBoundary(player, generation, transition);
    player.reviewStage = "seekable";
    await waitForMediaEvent(
      player.video,
      "progress",
      () => player.video.seekable?.length > 0,
      this._mediaReadyTimeoutMs,
      transition?.cancellations ?? player.waitCancellations
    );
    this.assertCurrentCameraBoundary(player, generation, transition);
    this.syncStage(report, generation, player, "seekableNonemptyMs");
  }

  observeInitialLanding(player, generation, transition) {
    const video = player.video;
    if (typeof video?.requestVideoFrameCallback !== "function") {
      player.reviewLanding = "unsupported";
      return null;
    }
    player.reviewLanding = "pending";
    const hls = player.hls;
    const timing = player.timing;
    const presentationId = player.presentationId;
    const issuedAt = this._now();
    let callbackId = null;
    let cancel = null;
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, observation = null) => {
        if (settled) return;
        settled = true;
        if (callbackId !== null) video.cancelVideoFrameCallback?.(callbackId);
        const index = transition.cancellations.indexOf(cancel);
        if (index >= 0) transition.cancellations.splice(index, 1);
        if (error) reject(error);
        else resolve(observation);
      };
      const arm = () => {
        try { callbackId = video.requestVideoFrameCallback(onFrame); }
        catch {
          player.reviewLanding = "callback_failed";
          finish(new Error("Historical frame observation failed."));
        }
      };
      const onFrame = (_now, metadata) => {
        callbackId = null;
        if (!this.isCurrentCameraTransition(player, transition) ||
            player.generation !== generation || player.video !== video ||
            player.hls !== hls || transition.hls !== hls ||
            player.timing !== timing || player.presentationId !== presentationId) {
          finish(new Error("Historical frame observation was superseded."));
          return;
        }
        if (!Number.isFinite(metadata?.presentationTime) ||
            metadata.presentationTime < issuedAt) {
          arm();
          return;
        }
        const mediaTime = typeof metadata?.mediaTime === "number"
          ? metadata.mediaTime : NaN;
        let landedEpoch = null;
        try {
          if (Number.isFinite(mediaTime)) {
            const mapped = mediaToEpoch(timing, mediaTime);
            if (!mapped.isBoundary) landedEpoch = mapped.epoch;
          }
        } catch {}
        if (!Number.isFinite(landedEpoch)) {
          player.reviewLanding = "unmapped_frame";
          arm();
          return;
        }
        finish(null, {
          requestedEpoch: transition.targetEpoch,
          requestedMediaTime: player.seek,
          landedMediaTime: mediaTime,
          landedEpoch,
          offsetSeconds: landedEpoch - transition.targetEpoch,
          verifiedFrame: true,
          presentationId,
          requestId: player.requestId,
          cameraWorkId: player.cameraWorkId
        });
        player.reviewLanding = "verified";
      };
      cancel = () => finish(new Error("Historical frame observation was cancelled."));
      transition.cancellations.push(cancel);
      arm();
    });
    // The seek/canplay wait can fail before this promise is awaited.
    void promise.catch(() => {});
    return { promise, cancel: () => cancel?.() };
  }

  async seekHistoricalPlayer(player, generation = null, report = null, transition = null,
    { observeLanding = false, landingAfterSeek = false } = {}) {
    const requestId = player.requestId;
    const assertOwned = () => {
      if (requestId !== this._reviewRequestId) throw new Error("Historical seek was superseded.");
      if (generation !== null) this.assertCurrentCameraBoundary(player, generation, transition);
    };
    assertOwned();
    player.reviewStage = "seek";
    const diagnostic = this.syncCamera(report, generation, player);
    if (diagnostic) {
      diagnostic.requestedMediaTime = player.seek;
      const onSeeked = () => this.syncStage(report, generation, player, "seekedEventMs");
      const onCanPlay = () => this.syncStage(report, generation, player, "canplayEventMs");
      player.video.addEventListener("seeked", onSeeked);
      player.video.addEventListener("canplay", onCanPlay);
      player.syncListeners = [["seeked", onSeeked], ["canplay", onCanPlay]];
    }
    let landing = observeLanding && !landingAfterSeek
      ? this.observeInitialLanding(player, generation, transition)
      : null;
    const wait = observeLanding ? null : waitForMediaEvent(
      player.video,
      "seeked",
      () => Number.isFinite(player.video.currentTime) &&
        Math.abs(player.video.currentTime - player.seek) <= 0.05 &&
        !player.video.seeking,
      this._mediaReadyTimeoutMs,
      transition?.cancellations ?? player.waitCancellations
    );
    try {
      this.syncStage(report, generation, player, "seekIssuedMs");
      player.video.currentTime = player.seek;
      if (observeLanding && landingAfterSeek) {
        landing = this.observeInitialLanding(player, generation, transition);
      }
      if (landing) {
        player.reviewStage = "landing";
        const placement = await landing.promise;
        assertOwned();
        player.initialPlacement = placement;
        this.syncStage(report, generation, player, "barrierReadyMs");
        if (diagnostic) {
          diagnostic.actualSeekTime = Number(player.video.currentTime);
          diagnostic.seekErrorSeconds = diagnostic.actualSeekTime - player.seek;
          diagnostic.landedMediaTime = player.initialPlacement.landedMediaTime;
          diagnostic.landedEpoch = player.initialPlacement.landedEpoch;
          diagnostic.landedOffsetSeconds = player.initialPlacement.offsetSeconds;
          diagnostic.frameVerified = true;
          diagnostic.barrierReadyEpoch = player.initialPlacement.landedEpoch;
          diagnostic.barrierReadyErrorSeconds = player.initialPlacement.offsetSeconds;
        }
        return;
      }
      await wait;
      assertOwned();
      this.syncStage(report, generation, player, "seekingFalseMs");
      this.syncStage(report, generation, player, "targetToleranceMs");
      if (diagnostic) {
        diagnostic.actualSeekTime = Number(player.video.currentTime);
        diagnostic.seekErrorSeconds = diagnostic.actualSeekTime - player.seek;
      }
      player.reviewStage = "seekable";
      await waitForMediaEvent(
        player.video,
        "canplay",
        () => player.video.readyState >= HAVE_FUTURE_DATA,
        this._mediaReadyTimeoutMs,
        transition?.cancellations ?? player.waitCancellations
      );
      assertOwned();
      this.syncStage(report, generation, player, "readyStateThresholdMs");
      this.syncStage(report, generation, player, "barrierReadyMs");
      if (diagnostic) {
        diagnostic.barrierReadyEpoch = historicalEpochFromMedia(player, Number(player.video.currentTime));
        diagnostic.barrierReadyErrorSeconds = diagnostic.barrierReadyEpoch - diagnostic.requestedEpoch;
      }
      if (observeLanding) {
        player.initialPlacement = {
          requestedEpoch: transition.targetEpoch,
          requestedMediaTime: player.seek,
          landedMediaTime: null,
          landedEpoch: null,
          offsetSeconds: null,
          verifiedFrame: false,
          presentationId: player.presentationId,
          requestId: player.requestId,
          cameraWorkId: player.cameraWorkId
        };
        assertOwned();
        if (diagnostic) {
          diagnostic.landedMediaTime = player.initialPlacement.landedMediaTime;
          diagnostic.landedEpoch = player.initialPlacement.landedEpoch;
          diagnostic.landedOffsetSeconds = player.initialPlacement.offsetSeconds;
          diagnostic.frameVerified = player.initialPlacement.verifiedFrame;
        }
      }
    } catch (error) {
      landing?.cancel();
      throw error;
    }
  }

  cameraEpochFromMedia(player) {
    const mediaTime = Number(player?.video?.currentTime);
    const epoch = historicalEpochFromMedia(player, mediaTime);
    return Number.isFinite(epoch) ? epoch : null;
  }

  async startOwnedPlayback(player) {
    const transition = this.beginCameraTransition(player, "play_release", this.clock.absoluteTime,
      { preservePlacement: true });
    transition.hls = player.hls;
    const diagnostic = player.diagnosticReport?.cameras?.[player.camera.name];
    const playDiagnostic = { issuedAtMs: this._now(), outcome: "pending", settledAtMs: null };
    if (diagnostic) diagnostic.play = playDiagnostic;
    player.reviewStage = "play";
    try {
      player.video.defaultPlaybackRate = this._playbackSpeed;
      player.video.playbackRate = this._playbackSpeed;
      await this.settleRejoinPlay(player, transition);
      if (this.clock.running && player.video.paused) await this.settleRejoinPlay(player, transition);
      this.assertCurrentCameraTransition(player, transition);
      if (this.clock.running && player.video.paused) {
        player.reviewPlay = "not_running";
        throw new Error("Historical Play did not start.");
      }
      if (!this.clock.running) player.video.pause();
      player.transition = null;
      this.setCameraLifecycle(player, "participating", { boundaryReason: "play_release" });
      this.observeHistoricalFrames(player);
      playDiagnostic.outcome = "fulfilled";
      player.reviewPlay = "fulfilled";
    } catch (error) {
      if (!this.isCurrentCameraTransition(player, transition)) return false;
      const reason = error.rejoinFailure === "rejoin_play_timeout" ? "play_timeout" : "play_rejected";
      playDiagnostic.outcome = reason === "play_timeout" ? "timeout" : "rejected";
      if (player.reviewPlay !== "not_running") {
        player.reviewPlay = reason === "play_timeout" ? "timeout" : "rejected";
      }
      this.leaveHistoricalCamera(player, reason, this.clock.absoluteTime, null, "failed");
      return false;
    } finally {
      playDiagnostic.settledAtMs = this._now();
      this.updateHistoricalAvailabilityStatus();
      this.updateTransport();
      this.updateDiagnostics();
    }
    return true;
  }

  async settleRejoinPlay(player, transition) {
    this.assertCurrentCameraTransition(player, transition);
    player.reviewStage = "play";
    const view = player.video?.ownerDocument?.defaultView ?? globalThis;
    let timeout = null;
    let cancel = null;
    let interruptPendingPlay = null;
    const deadline = new Promise((_, reject) => {
      timeout = view.setTimeout(() => {
        const error = new Error("Historical rejoin Play timed out.");
        error.rejoinFailure = "rejoin_play_timeout";
        reject(error);
      }, this._mediaReadyTimeoutMs);
      cancel = () => reject(new Error("Historical rejoin Play was cancelled."));
      transition.cancellations.push(cancel);
    });
    const interrupted = new Promise(resolve => { interruptPendingPlay = () => resolve("paused"); });
    transition.interruptPendingPlay = interruptPendingPlay;
    transition.playPending = true;
    try {
      let play;
      try { play = Promise.resolve(player.video.play()); }
      catch (error) { play = Promise.reject(error); }
      try { await Promise.race([play, deadline, interrupted]); }
      catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!failure.rejoinFailure && this.isCurrentCameraTransition(player, transition)) {
          failure.rejoinFailure = "rejoin_play_rejected";
        }
        throw failure;
      }
      this.assertCurrentCameraTransition(player, transition);
      player.reviewPlay = "fulfilled";
    } finally {
      transition.playPending = false;
      if (transition.interruptPendingPlay === interruptPendingPlay) {
        transition.interruptPendingPlay = null;
      }
      view.clearTimeout(timeout);
      const index = transition.cancellations.indexOf(cancel);
      if (index >= 0) transition.cancellations.splice(index, 1);
    }
  }

  observeHistoricalFrames(player) {
    player.cancelHistoricalFrameObserver?.();
    const video = player.video;
    if (typeof video?.requestVideoFrameCallback !== "function") return;
    let callbackId = null;
    let cancelled = false;
    const onFrame = (_now, metadata) => {
      if (cancelled || !this.isCurrentCameraWork(player) || player.video !== video ||
          player.lifecycleState !== "participating") return;
      try {
        const mapped = mediaToEpoch(player.timing, Number(metadata?.mediaTime));
        if (!mapped.isBoundary) {
          const canvas = player.heldCanvas ?? this._document.createElement("canvas");
          const context = canvas.getContext?.("2d", { alpha: false });
          if (context) {
            const width = Math.min(640, Number(video.videoWidth) || 640);
            const height = Math.max(1, Math.round(width *
              ((Number(video.videoHeight) || 360) / (Number(video.videoWidth) || 640))));
            if (canvas.width !== width || canvas.height !== height) {
              canvas.width = width;
              canvas.height = height;
            }
            context.drawImage(video, 0, 0, width, height);
            if (!player.heldCanvas) {
              canvas.className = "review-held-frame";
              canvas.hidden = true;
              video.parentElement?.appendChild(canvas);
              player.heldCanvas = canvas;
            }
            player.heldFrameEpoch = mapped.epoch;
            if (player.holdStartedAtMs != null) {
              this.recordCameraBoundary(player, "held-frame-ended", {
                durationMs: this._now() - player.holdStartedAtMs,
                representedEpoch: player.heldFrameEpoch
              });
              player.holdStartedAtMs = null;
              this.setPlayerStatus(player, "", false);
              this.updateHistoricalVideoStateBadge(player);
            }
            canvas.hidden = true;
          }
        }
      } catch {
        this.recordCameraBoundary(player, "held-frame-capture-unavailable");
      }
      if (!cancelled) callbackId = video.requestVideoFrameCallback(onFrame);
    };
    callbackId = video.requestVideoFrameCallback(onFrame);
    player.cancelHistoricalFrameObserver = () => {
      cancelled = true;
      if (callbackId !== null) video.cancelVideoFrameCallback?.(callbackId);
    };
  }

  holdHistoricalFrame(player, reason) {
    if (!player.heldCanvas ||
        !Number.isFinite(player.heldFrameEpoch) || player.holdStartedAtMs != null) return;
    player.heldCanvas.hidden = false;
    player.holdStartedAtMs = this._now();
    this.updateHistoricalVideoStateBadge(player);
    this.recordCameraBoundary(player, "held-frame-started", {
      reason, representedEpoch: player.heldFrameEpoch
    });
  }

  installHistoricalLifecycleListeners(player, generation = player.generation) {
    for (const [event, handler] of player.lifecycleListeners ?? []) {
      player.video?.removeEventListener(event, handler);
    }
    const onTimeUpdate = () => {
      if (!this.isCurrentCameraWork(player, generation) ||
          player.lifecycleState !== "participating") return;
      const achievedEpoch = this.cameraEpochFromMedia(player);
      if (Number.isFinite(achievedEpoch)) player.lastAchievedEpoch = achievedEpoch;
      this.syncTick(this._syncSession, generation);
      this.queueHistoricalAvailabilityEvaluation("media_progress");
    };
    const onEnded = () => this.handleHistoricalVideoEnded(player, generation);
    const onError = () => {
      if (this.isCurrentCameraWork(player, generation) &&
          player.lifecycleState === "participating") {
        this.recordReviewFailure(player, { reason: "media_error", stage: "media",
          occurrence: player.presentationId });
      }
    };
    player.video?.addEventListener("timeupdate", onTimeUpdate);
    player.video?.addEventListener("ended", onEnded);
    player.video?.addEventListener("error", onError);
    player.lifecycleListeners = [["timeupdate", onTimeUpdate], ["ended", onEnded],
      ["error", onError]];
    if (!this._historicalPreparing) this.observeHistoricalFrames(player);
  }

  async prepareCameraAtEpoch(player, targetEpoch, {
    reason = "camera_prepare",
    autoplay = this.clock.running,
    followReviewClock = false,
    report = player.diagnosticReport,
    Hls = null,
    availabilityKnown = false,
    deferInitialPlacement = false
  } = {}) {
    const generation = player.generation;
    this.assertCurrentCameraWork(player, generation);
    if (!availabilityKnown) {
      try {
        player.reviewStage = "availability";
        await this.ensureCameraAvailability(player, targetEpoch, { reason });
      } catch (error) {
        if (player.lifecycleState === "participating") {
          this.recordReviewFailure(player, { reason: "availability_api_failure",
            outcome: "retained_after_failure", stage: "availability", targetEpoch,
            occurrence: player.availabilityRequestToken });
          this.recordCameraBoundary(player, "availability-refresh-failed-player-retained", {
            reason, targetEpoch, error: sanitizeReviewError(error)
          });
          return false;
        }
        this.recordReviewFailure(player, { reason: "availability_api_failure",
          stage: "availability", targetEpoch });
        this.setCameraLifecycle(player, "failed", {
          message: "Recording availability unavailable.",
          boundaryReason: "availability_api_failure",
          targetEpoch
        });
        return false;
      }
    }
    this.assertCurrentCameraWork(player, generation);
    let inspected = this.inspectPlayerAvailability(player, targetEpoch);
    if (!inspected.insideWindow || !inspected.containing) {
      this.setCameraLifecycle(player, "unavailable", {
        boundaryReason: inspected.insideWindow ? "authoritative_recording_gap" : "availability_unknown",
        targetEpoch
      });
      player.nextCoverageStart = inspected.nextStart;
      return false;
    }

    if (player.lifecycleState === "participating") this.holdHistoricalFrame(player, reason);
    this.cleanupHistoricalPlayer(player);
    const transition = this.beginCameraTransition(player, reason, targetEpoch);
    try {
      const LoadedHls = Hls ?? await this._loadHls();
      this.assertCurrentCameraTransition(player, transition);
      if (!LoadedHls?.isSupported?.()) {
        throw new Error("This browser does not support historical HLS playback.");
      }
      let currentTarget = targetEpoch;
      if (followReviewClock) {
        player.reviewStage = "availability";
        currentTarget = this.clock.absoluteTime;
        await this.ensureCameraAvailability(player, currentTarget, { reason, transition });
        this.assertCurrentCameraTransition(player, transition);
        currentTarget = this.clock.absoluteTime;
        const currentCoverage = this.inspectPlayerAvailability(player, currentTarget);
        if (!currentCoverage.containing) {
          const error = new Error("Review time left camera recording coverage.");
          error.rejoinFailure = currentCoverage.insideWindow
            ? "authoritative_recording_gap" : "rejoin_target_moved";
          throw error;
        }
      }
      const baseRange = buildReviewRange(currentTarget);
      const requestRange = {
        ...baseRange,
        boundsStart: Number(this._historicalPlaybackRange?.from ?? baseRange.start),
        boundsEnd: Number(this._historicalPlaybackRange?.to ?? baseRange.end)
      };
      await this.attachHistoricalPlayer(
        player, requestRange, LoadedHls, generation, report, transition
      );
      this.assertCurrentCameraTransition(player, transition);
      if (deferInitialPlacement) return true;
      if (followReviewClock) {
        player.reviewStage = "availability";
        currentTarget = this.clock.absoluteTime;
        await this.ensureCameraAvailability(player, currentTarget, { reason, transition });
        this.assertCurrentCameraTransition(player, transition);
        currentTarget = this.clock.absoluteTime;
        const currentCoverage = this.inspectPlayerAvailability(player, currentTarget);
        if (!currentCoverage.containing) {
          const error = new Error("Review time left camera recording coverage.");
          error.rejoinFailure = currentCoverage.insideWindow
            ? "authoritative_recording_gap" : "rejoin_target_moved";
          throw error;
        }
        let mapped;
        try { mapped = epochToMedia(player.timing, currentTarget); }
        catch {
          const error = new Error("Review time left prepared presentation.");
          error.rejoinFailure = "rejoin_target_moved";
          throw error;
        }
        player.seek = mapped.mediaTime;
        player.resolvedEpoch = mapped.resolvedEpoch;
        transition.targetEpoch = currentTarget;
        const diagnostic = player.diagnosticReport?.cameras?.[player.camera.name];
        if (diagnostic?.transition?.token === transition.token) {
          diagnostic.transition.targetEpoch = currentTarget;
        }
      }
      await this.seekHistoricalPlayer(player, generation, report, transition,
        { observeLanding: followReviewClock, landingAfterSeek: followReviewClock });
      this.assertCurrentCameraTransition(player, transition);
      player.video.defaultPlaybackRate = this._playbackSpeed;
      player.video.playbackRate = this._playbackSpeed;
      this.assertCurrentCameraTransition(player, transition);
      if (followReviewClock && this.clock.running) {
        player.reviewStage = "play";
        await this.settleRejoinPlay(player, transition);
        if (this.clock.running && player.video.paused) {
          await this.settleRejoinPlay(player, transition);
        }
        if (this.clock.running && player.video.paused) {
          player.reviewPlay = "not_running";
          const error = new Error("Historical rejoin Play did not start.");
          error.rejoinFailure = "rejoin_play_not_running";
          throw error;
        }
      }
      this.assertCurrentCameraTransition(player, transition);
      if (followReviewClock && !this.clock.running) player.video.pause();
      if (followReviewClock && player.holdStartedAtMs != null) {
        this.recordCameraBoundary(player, "held-frame-ended", {
          durationMs: this._now() - player.holdStartedAtMs,
          representedEpoch: player.initialPlacement?.verifiedFrame
            ? player.initialPlacement.landedEpoch : null
        });
        player.holdStartedAtMs = null;
        if (player.heldCanvas) player.heldCanvas.hidden = true;
        this.updateHistoricalVideoStateBadge(player);
      }
      transition.outcome = "participating";
      const diagnostic = player.diagnosticReport?.cameras?.[player.camera.name];
      if (diagnostic?.transition?.token === transition.token) {
        diagnostic.transition.outcome = "participating";
        diagnostic.transition.resolvedEpoch = player.resolvedEpoch;
      }
      player.transition = null;
      this.setCameraLifecycle(player, "participating", {
        boundaryReason: reason,
        targetEpoch: followReviewClock ? currentTarget : targetEpoch,
        achievedEpoch: followReviewClock && player.initialPlacement?.verifiedFrame
          ? player.initialPlacement.landedEpoch : Number(player.resolvedEpoch)
      });
      this.installHistoricalLifecycleListeners(player, generation);
      if (autoplay && !followReviewClock) {
        await Promise.resolve(player.video.play());
        this.assertCurrentCameraWork(player, generation);
      }
      this.recordCameraBoundary(player, "join-complete", {
        reason, targetEpoch: currentTarget,
        achievedEpoch: player.initialPlacement?.verifiedFrame
          ? player.initialPlacement.landedEpoch : currentTarget,
        transitionToken: transition.token, playbackRate: player.video.playbackRate,
        playIntent: (followReviewClock ? this.clock.running : autoplay) ? "playing" : "paused"
      });
      return true;
    } catch (error) {
      const current = this.isCurrentCameraTransition(player, transition);
      const noRecording = /no recording|no vod/i.test(sanitizeReviewError(error));
      const diagnostic = player.diagnosticReport?.cameras?.[player.camera.name];
      const failureReason = error.rejoinFailure ?? (noRecording
        ? "prepare_reported_no_recording"
        : diagnostic?.stages?.targetToleranceMs != null
          ? "post_seek_playability_failure"
          : diagnostic?.stages?.manifestParsedMs != null
            ? "seekable_or_media_readiness_failure"
            : diagnostic?.stages?.manifestSignedMs != null
              ? "manifest_failure"
              : diagnostic?.prepareSucceeded
                ? "manifest_sign_failure"
                : "camera_prepare_failed");
      const ledgerReason = error.rejoinFailure ?? (noRecording
        ? "prepare_reported_no_recording"
        : ({ availability: "availability_api_failure", prepare: "camera_prepare_failed",
          sign: "manifest_sign_failure", manifest: "manifest_failure",
          seekable: "seekable_or_media_readiness_failure", seek: "mapped_seek_failure",
          landing: "initial_landing_failed", play: "rejoin_play_rejected" })[player.reviewStage]
          ?? failureReason);
      if (current && noRecording) {
        try {
          await this.ensureCameraAvailability(player, targetEpoch, {
            force: true, transition, reason: "v2_no_recording_refresh"
          });
          const refreshed = this.inspectPlayerAvailability(player, targetEpoch);
          player.suppressedCoverage = refreshed.containing
            ? { ...refreshed.containing }
            : null;
        } catch (refreshError) {
          this.recordCameraBoundary(player, "availability-refresh-after-v2-failed", {
            targetEpoch, error: sanitizeReviewError(refreshError)
          });
        }
      }
      if (this.isCurrentCameraTransition(player, transition)) {
        if (ledgerReason !== "rejoin_target_moved") {
          this.recordReviewFailure(player, { reason: ledgerReason,
            outcome: ledgerReason === "authoritative_recording_gap" ? "no_coverage" : "failure",
            stage: player.reviewStage, targetEpoch });
        }
        this.cancelCameraTransition(player);
        this.cleanupHistoricalPlayer(player);
        const noCoverage = noRecording || failureReason === "authoritative_recording_gap" ||
          failureReason === "rejoin_target_moved";
        this.setCameraLifecycle(player, noCoverage ? "unavailable" : "failed", {
          message: failureReason === "rejoin_target_moved" ? "" :
            noCoverage ? "No recording at this time." : "Historical playback unavailable.",
          boundaryReason: failureReason,
          targetEpoch
        });
        this.syncUnavailable(player.diagnosticReport, generation, player, failureReason);
        this.recordCameraBoundary(player, "join-failed", {
          reason, targetEpoch, transitionToken: transition.token,
          outcome: noRecording ? "no_recording" : "failed",
          error: sanitizeReviewError(error)
        });
        if (failureReason === "rejoin_target_moved") {
          void this.queueHistoricalAvailabilityEvaluation("rejoin_target_moved");
        }
      } else {
        if (!transition.cleaned && transition.hls && transition.hls !== player.hls) {
          try { transition.hls.destroy?.(); } catch {}
        }
        this.recordIdentityEvent(report, player, "stale-transition-cleaned", {
          transitionToken: transition.token
        });
      }
      return false;
    } finally {
      this.updateHistoricalAvailabilityStatus();
      this.updateTransport();
      this.updateDiagnostics();
    }
  }

  async completeInitialPlacement(player, report = player.diagnosticReport) {
    const generation = player.generation;
    const transition = player.transition;
    try {
      this.assertCurrentCameraTransition(player, transition);
      await this.seekHistoricalPlayer(player, generation, report, transition,
        { observeLanding: true });
      this.assertCurrentCameraTransition(player, transition);
      player.video.defaultPlaybackRate = this._playbackSpeed;
      player.video.playbackRate = this._playbackSpeed;
      transition.outcome = "participating";
      const diagnostic = report?.cameras?.[player.camera.name];
      if (diagnostic?.transition?.token === transition.token) {
        diagnostic.transition.outcome = "participating";
        diagnostic.transition.resolvedEpoch = player.resolvedEpoch;
      }
      player.transition = null;
      this.setCameraLifecycle(player, "participating", {
        boundaryReason: "initial_selection",
        targetEpoch: transition.targetEpoch,
        achievedEpoch: player.initialPlacement?.landedEpoch ?? player.resolvedEpoch
      });
      this.installHistoricalLifecycleListeners(player, generation);
      return true;
    } catch (error) {
      if (this.isCurrentCameraTransition(player, transition)) {
        this.recordReviewFailure(player, { reason: player.reviewStage === "seek"
          ? "mapped_seek_failure" : "initial_landing_failed",
        stage: player.reviewStage, targetEpoch: transition.targetEpoch });
        this.cleanupHistoricalPlayer(player);
        this.setCameraLifecycle(player, "failed", {
          message: "Historical playback unavailable.",
          boundaryReason: "initial_landing_failed",
          targetEpoch: transition.targetEpoch
        });
        this.syncUnavailable(report, generation, player, "initial_landing_failed");
      }
      return false;
    } finally {
      this.updateHistoricalAvailabilityStatus();
      this.updateTransport();
    }
  }

  async waitForInitialPhase(players, action, reason) {
    if (players.length === 0) return;
    const settled = new Set();
    const work = Promise.allSettled(players.map(async player => {
      try { await action(player); }
      finally { settled.add(player); }
    }));
    let clearDeadline = null;
    let releaseDeadline = null;
    const deadline = new Promise(resolve => {
      releaseDeadline = resolve;
      clearDeadline = this._scheduleInitialDeadline(
        () => resolve("deadline"), this._mediaReadyTimeoutMs);
    });
    const cancel = () => {
      clearDeadline?.();
      releaseDeadline("cancelled");
    };
    this._initialDeadlineCancel = cancel;
    const outcome = await Promise.race([work.then(() => "complete"), deadline]);
    if (this._initialDeadlineCancel === cancel) this._initialDeadlineCancel = null;
    clearDeadline?.();
    if (outcome !== "deadline") return;
    for (const player of players) {
      if (settled.has(player) || !this.isCurrentCameraWork(player)) continue;
      const stages = player.diagnosticReport?.cameras?.[player.camera.name]?.stages;
      const failureReason = reason === "initial_landing_deadline" &&
        stages?.targetToleranceMs != null && stages?.readyStateThresholdMs == null
        ? "post_seek_playability_failure" : reason;
      player.initialTimedOut = true;
      const ledgerReason = reason === "initial_landing_deadline" &&
        player.reviewStage === "seekable" ? "post_seek_playability_failure" : failureReason;
      this.recordReviewFailure(player, { reason: ledgerReason,
        stage: player.reviewStage, targetEpoch: player.lastTargetEpoch });
      this.cleanupHistoricalPlayer(player);
      this.setCameraLifecycle(player, "failed", {
        message: "Historical playback unavailable.",
        boundaryReason: failureReason,
        targetEpoch: player.lastTargetEpoch
      });
      this.syncUnavailable(player.diagnosticReport, player.generation, player, failureReason);
    }
  }

  async loadInitialHls() {
    let clearDeadline = null;
    let releaseDeadline = null;
    const deadline = new Promise(resolve => {
      releaseDeadline = resolve;
      clearDeadline = this._scheduleInitialDeadline(
        () => resolve({ expired: true }), this._mediaReadyTimeoutMs);
    });
    const cancel = () => {
      clearDeadline?.();
      releaseDeadline({ expired: true });
    };
    this._initialDeadlineCancel = cancel;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this._loadHls()).then(Hls => ({ Hls })), deadline
      ]);
      if (result.expired) throw new Error("Historical HLS loading timed out or was cancelled.");
      return result.Hls;
    } finally {
      if (this._initialDeadlineCancel === cancel) this._initialDeadlineCancel = null;
      clearDeadline?.();
    }
  }

  leaveHistoricalCamera(player, reason, targetEpoch, achievedEpoch = null, state = "unavailable") {
    if (!this.isCurrentCameraWork(player, player.generation)) return false;
    const inspected = this.inspectPlayerAvailability(player, targetEpoch);
    player.nextCoverageStart = inspected.nextStart;
    this.holdHistoricalFrame(player, reason);
    this.recordReviewFailure(player, { reason,
      outcome: reason === "authoritative_recording_gap" ? "no_coverage" :
        reason === "continuous_presentation_exhausted" ? "normal_terminal" : "failure",
      stage: reason === "continuous_presentation_exhausted" ? "continuation" :
        reason === "unexpected_media_end" ? "media" : player.reviewStage,
      targetEpoch });
    this.cleanupHistoricalPlayer(player);
    player.lastTiming = player.timing ?? player.lastTiming ?? null;
    player.timing = null;
    this.setCameraLifecycle(player, state, {
      message: state === "failed"
        ? "Historical playback unavailable."
        : "No recording at this time.",
      boundaryReason: reason,
      targetEpoch,
      achievedEpoch
    });
    this.recordCameraBoundary(player, "leave-complete", {
      reason, targetEpoch, achievedEpoch,
      nextCoverageStart: inspected.nextStart,
      outcome: state
    });
    const anyParticipating = [...this._historicalPlayers.values()]
      .some(candidate => candidate.lifecycleState === "participating");
    if (!anyParticipating && !this.clock.running) {
      this.clock.pause();
      this.clearHistoricalBoundaryTimer();
    }
    this.updateHistoricalAvailabilityStatus();
    this.updateTransport();
    this.updateDiagnostics();
    return true;
  }

  async reconcileHistoricalCamera(player, targetEpoch, {
    explicit = false,
    reason = "availability_boundary",
    autoplay = this.clock.running
  } = {}) {
    if (!this.isCurrentCameraWork(player, player.generation)) return "stale";
    if (player.lifecycleState === "preparing") return "preparing";
    if (player.lifecycleState === "failed" && !explicit) return "failed";
    if (!explicit && this._historicalPlaybackRange &&
        targetEpoch >= this._historicalPlaybackRange.to) return "at_playback_end";
    const requestId = player.requestId;
    const lifecycleRevision = player.lifecycleRevision;
    try {
      await this.ensureCameraAvailability(player, targetEpoch, { reason });
    } catch (error) {
      if (requestId !== this._reviewRequestId || !this.isCurrentCameraWork(player)) return "stale";
      if (player.lifecycleState === "participating") {
        this.recordReviewFailure(player, { reason: "availability_api_failure",
          outcome: "retained_after_failure", stage: "availability", targetEpoch,
          occurrence: player.availabilityRequestToken });
        this.recordCameraBoundary(player, "availability-refresh-failed-player-retained", {
          reason, targetEpoch, error: sanitizeReviewError(error)
        });
        return "retained_after_availability_failure";
      }
      this.recordReviewFailure(player, { reason: "availability_api_failure",
        stage: "availability", targetEpoch });
      this.setCameraLifecycle(player, "failed", {
        message: "Recording availability unavailable.",
        boundaryReason: "availability_api_failure",
        targetEpoch
      });
      return "availability_failure";
    }
    if (requestId !== this._reviewRequestId || !this.isCurrentCameraWork(player, player.generation)) return "stale";
    if (player.lifecycleRevision !== lifecycleRevision) return "superseded";
    if (!explicit && player.lifecycleState !== "participating") {
      targetEpoch = this.clock.absoluteTime;
      if (this.availabilityNeedsRefresh(player, targetEpoch)) {
        try { await this.ensureCameraAvailability(player, targetEpoch, { reason }); }
        catch { return "availability_failure"; }
        if (!this.isCurrentCameraWork(player, player.generation) ||
            player.lifecycleRevision !== lifecycleRevision) return "superseded";
      }
    }
    const inspected = this.inspectPlayerAvailability(player, targetEpoch);
    player.nextCoverageStart = inspected.nextStart;
    if (!inspected.containing) {
      if (player.lifecycleState === "participating") {
        this.leaveHistoricalCamera(
          player, "authoritative_recording_gap", targetEpoch, player.lastAchievedEpoch
        );
        return "left_gap";
      }
      this.setCameraLifecycle(player, "unavailable", {
        boundaryReason: "authoritative_recording_gap", targetEpoch
      });
      return "unavailable";
    }
    if (!explicit && player.suppressedCoverage &&
        player.suppressedCoverage.start === inspected.containing.start &&
        player.suppressedCoverage.end === inspected.containing.end) {
      this.setCameraLifecycle(player, "unavailable", {
        boundaryReason: "prepare_reported_no_recording_suppressed", targetEpoch
      });
      return "suppressed_after_v2_no_recording";
    }

    if (player.lifecycleState === "participating" && player.video && player.hls && player.timing) {
      try {
        const mapped = epochToMedia(player.timing, targetEpoch);
        if (!explicit) return "participating";
        player.seek = mapped.mediaTime;
        player.resolvedEpoch = mapped.resolvedEpoch;
        await this.seekHistoricalPlayer(player, player.generation, player.diagnosticReport);
        if (requestId !== this._reviewRequestId || !this.isCurrentCameraWork(player)) return "stale";
        this.setCameraLifecycle(player, "participating", {
          boundaryReason: "explicit_seek_reused_presentation",
          targetEpoch,
          achievedEpoch: mapped.resolvedEpoch
        });
        return "reused";
      } catch (error) {
        if (requestId !== this._reviewRequestId || !this.isCurrentCameraWork(player)) return "stale";
        if (!explicit) {
          const logicalEnd = Number(player.timing?.logical_wall_end);
          if (Number.isFinite(logicalEnd) && targetEpoch >= logicalEnd) {
            if (this._historicalPlaybackRange &&
                logicalEnd >= this._historicalPlaybackRange.to - 0.05) {
              return "at_playback_end";
            }
            this.continueHistoricalPresentation(player, logicalEnd, player.lastAchievedEpoch);
            return "presentation_exhausted";
          }
          return "participating";
        }
      }
    }

    const joined = await this.prepareCameraAtEpoch(player, targetEpoch, {
      reason: explicit ? "explicit_seek_new_presentation" : "availability_entry",
      autoplay,
      followReviewClock: !explicit,
      availabilityKnown: true
    });
    return joined ? "prepared" : "prepare_failed";
  }

  async evaluateHistoricalAvailability(targetEpoch = null, {
    explicit = false,
    reason = "shared_boundary_evaluation",
    autoplay = this.clock.running,
    awaitRejoins = true
  } = {}) {
    if (this._presentationMode !== "historical" || !this._active || this._suspended ||
        (this._historicalPreparing && !explicit)) return [];
    const sharedTarget = Number.isFinite(targetEpoch)
      ? Number(targetEpoch)
      : this.clock.absoluteTime;
    if (!Number.isFinite(sharedTarget)) return [];
    const results = await Promise.all([...this._historicalPlayers.values()].map(async player => {
      let cameraTarget = sharedTarget;
      if (!explicit && player.lifecycleState === "participating") {
        const achieved = this.cameraEpochFromMedia(player);
        if (Number.isFinite(achieved)) cameraTarget = achieved;
      }
      const operation = this.reconcileHistoricalCamera(player, cameraTarget, {
        explicit, reason, autoplay
      });
      if (!awaitRejoins && !explicit && player.lifecycleState !== "participating") {
        void operation.catch(() => {});
        return { camera: player.camera.name, result: player.lifecycleState };
      }
      return { camera: player.camera.name, result: await operation };
    }));
    this.updateHistoricalAvailabilityStatus();
    this.updateTransport();
    return results;
  }

  queueHistoricalAvailabilityEvaluation(reason = "media_progress") {
    if (this._availabilityEvaluationPromise) {
      this._availabilityEvaluationPending = true;
      return this._availabilityEvaluationPromise;
    }
    const run = async () => {
      do {
        this._availabilityEvaluationPending = false;
        await this.evaluateHistoricalAvailability(null, { reason, awaitRejoins: false });
      } while (this._availabilityEvaluationPending &&
        this._presentationMode === "historical" && this._active && !this._suspended);
    };
    const promise = run().catch(() => {}).finally(() => {
      if (this._availabilityEvaluationPromise === promise) {
        this._availabilityEvaluationPromise = null;
      }
    });
    this._availabilityEvaluationPromise = promise;
    return promise;
  }

  async playHistorical(value, {
    autoplay = true,
    updateDisplayedRange = true,
    playbackRange = null,
    cameraNames = null,
    source = "other historical path"
  } = {}) {
    const generation = ++this._generation;
    const requestId = ++this._reviewRequestId;
    this._playRequested = false;
    this.cleanupHistorical();
    try {
      const targetEpoch = parseReviewTimestamp(value);
      if (updateDisplayedRange) this.includeReviewTarget(targetEpoch);
      const range = buildReviewRange(targetEpoch);
      this._historicalRange = range;
      this._historicalPlaybackRange = playbackRange && playbackRange.from < playbackRange.to
        ? { ...playbackRange }
        : null;
      this.clock.setAbsolute(targetEpoch);
      this.clock.setRate(this._playbackSpeed);
      const requestedNames = new Set(this.canonicalCameraNames(
        cameraNames ?? this._displayedReviewQuery?.cameraNames ?? this._selectedCameraNames
      ));
      const assignedNames = new Set(this._selectedCameraNames);
      const participatingCameras = this._cameras.filter(camera =>
        requestedNames.has(camera.name) && assignedNames.has(camera.name));
      const report = this.startSyncReport(generation, targetEpoch, participatingCameras, source);
      for (const camera of participatingCameras) {
        const player = this.createHistoricalPlayer(camera, generation, report);
        player.sceneExperimentSerial = source === "scene snap experiment"
          ? this._sceneExperiment?.serial : null;
        this._historicalPlayers.set(camera.name, player);
        const diagnostic = report?.cameras[camera.name];
        if (diagnostic) Object.assign(diagnostic, {
          requestId: player.requestId,
          cameraWorkId: player.cameraWorkId,
          presentationId: player.presentationId,
          assignmentRevision: player.assignmentRevision,
          cameraEntity: camera.entity,
          frigateCamera: player.frigateCamera,
          returnedCamera: null,
          playerId: player.playerId,
          hlsId: null, videoId: null, panelId: null,
          panelCamera: null, renderedSlot: null
        });
      }
      this._historicalPreparing = true;
      this._historicalStatus = "Preparing playback…";
      this._presentationMode = "historical";
      for (const player of this._historicalPlayers.values()) {
        this.recordIdentityEvent(report, player, "camera-work-created");
      }
      this.renderMediaArea();
      const players = [...this._historicalPlayers.values()];
      for (const player of players) {
        if (!player.frigateCamera) {
          this.recordReviewFailure(player, { reason: "missing_frigate_camera_mapping",
            stage: "prepare", targetEpoch });
          this.setCameraLifecycle(player, "failed", {
            message: "Historical playback unavailable.",
            boundaryReason: "missing_frigate_camera_mapping",
            targetEpoch
          });
          this.syncUnavailable(report, generation, player, "missing_frigate_camera_mapping");
        }
      }
      const candidates = players.filter(player => player.frigateCamera);
      await this.waitForInitialPhase(candidates, async player => {
        try {
          await this.ensureCameraAvailability(player, targetEpoch, { reason: "initial_selection" });
          if (player.initialTimedOut) return;
          const inspected = this.inspectPlayerAvailability(player, targetEpoch);
          player.nextCoverageStart = inspected.nextStart;
          if (!inspected.containing) {
            this.recordReviewFailure(player, { reason: "authoritative_recording_gap",
              outcome: "no_coverage", stage: "availability", targetEpoch });
            this.setCameraLifecycle(player, "unavailable", {
              boundaryReason: "authoritative_recording_gap", targetEpoch
            });
            this.syncUnavailable(report, generation, player, "authoritative_recording_gap");
          }
        } catch (error) {
          if (player.initialTimedOut) return;
          this.recordReviewFailure(player, { reason: "availability_api_failure",
            stage: "availability", targetEpoch });
          this.setCameraLifecycle(player, "failed", {
            message: "Recording availability unavailable.",
            boundaryReason: "availability_api_failure", targetEpoch
          });
          this.syncUnavailable(report, generation, player, "availability_api_failure");
        }
      }, "initial_availability_deadline");
      this.assertCurrentGeneration(generation);
      const covered = candidates.filter(player =>
        player.lifecycleState === "preparing" &&
        this.inspectPlayerAvailability(player, targetEpoch).containing);
      const Hls = covered.length > 0 ? await this.loadInitialHls() : null;
      this.assertCurrentGeneration(generation);
      if (Hls && !Hls.isSupported()) {
        throw new Error("This browser does not support historical HLS playback.");
      }
      await this.waitForInitialPhase(covered, player => this.prepareCameraAtEpoch(
        player, targetEpoch, {
          reason: "initial_selection", autoplay: false, followReviewClock: false,
          report, Hls, availabilityKnown: true, deferInitialPlacement: true
        }
      ), "initial_preparation_deadline");
      this.assertCurrentGeneration(generation);
      const prepared = covered.filter(player =>
        this.isCurrentCameraTransition(player, player.transition) && player.hls && player.video);
      await this.waitForInitialPhase(prepared,
        player => this.completeInitialPlacement(player, report),
        "initial_landing_deadline");
      if (generation !== this._generation || !this._active) return;
      const playable = players.filter(player =>
        player.lifecycleState === "participating" && player.hls && player.video);
      if (generation !== this._generation || !this._active || this._suspended) return;
      playable.forEach(player => {
        player.video.playbackRate = this._playbackSpeed;
        const diagnostic = this.syncCamera(report, generation, player);
        if (diagnostic) diagnostic.appliedPlaybackRate = player.video.playbackRate;
      });
      const resolvedEpochs = playable
        .map(player => Number(player.resolvedEpoch))
        .filter(Number.isFinite);
      const resolvedEpoch = resolvedEpochs.length > 0
        ? Math.max(...resolvedEpochs)
        : targetEpoch;
      this.clock.setAbsolute(resolvedEpoch);
      const shouldPlay = playable.length > 0 &&
        (autoplay || this._playRequested);
      if (shouldPlay) {
        this.clock.start();
      }
      if (report) {
        const atMs = this._now();
        report.barrier = {
          atMs, ready: playable.map(player => player.camera.name),
          unavailable: players.filter(player => player.unavailable).map(player => player.camera.name),
          reviewClockAnchorMs: this.clock._startedAt,
          reviewClockAnchorEpoch: this.clock._absolute,
          snapshot: this.syncSnapshot(playable, report, atMs)
      };
      }
      const starts = shouldPlay
        ? playable.map(player => this.startOwnedPlayback(player))
        : [];
      if (!shouldPlay) playable.forEach(player => this.observeHistoricalFrames(player));
      // The barrier is complete. Per-camera Play waits must not gate availability.
      this._historicalPreparing = false;
      this._playRequested = false;
      const availableCount = players.filter(player => player.lifecycleState === "participating").length;
      if (report) {
        playable.filter(player => player.lifecycleState === "participating").forEach(player => {
          const diagnostic = this.syncCamera(report, generation, player);
          if (diagnostic) diagnostic.status = "released";
        });
        report.disposition = starts.length > 0 ? "play pending" : availableCount === 0 ? "all unavailable" :
          availableCount < players.length ? "partial release" : "released";
        this.updateSyncSummary(report);
      }
      this.updateHistoricalAvailabilityStatus();
      this.updateTransport();
      this.updateDiagnostics();
      const view = this._root?.ownerDocument?.defaultView ?? globalThis;
      if (players.length > 0) {
        this.scheduleHistoricalBoundaryTimer(generation);
        this._diagnosticTimer = view.setInterval(() => {
          if (this.enforceHistoricalPlaybackBoundary()) return;
          this.enforceHistoricalPresentationBoundary(generation);
          this.queueHistoricalAvailabilityEvaluation("shared_interval");
          this.updateClockDisplay();
          this.updateDiagnostics();
          this.syncTick(this._syncSession, generation);
          if (this._sceneExperiment && players.some(player =>
            player.sceneExperimentSerial === this._sceneExperiment.serial)) {
            this.recordSceneEvent(null, "ti-sample");
          }
        }, 500);
      }
      await Promise.allSettled(starts);
      if (generation !== this._generation || requestId !== this._reviewRequestId ||
          !this._active || this._suspended) return;
      if ([...this._historicalPlayers.values()].every(player =>
          player.lifecycleState !== "participating" && player.lifecycleState !== "preparing")) this.clock.pause();
      if (report && this._syncSession === report) {
        const count = [...this._historicalPlayers.values()].filter(player =>
          player.lifecycleState === "participating").length;
        report.disposition = count === 0 ? "all unavailable" : count < this._historicalPlayers.size
          ? "partial release" : "released";
        this.updateSyncSummary(report);
      }
      this.updateTransport();
    } catch (error) {
      if (generation !== this._generation) return;
      if (this._syncSession?.generation === generation) {
        this._syncSession.disposition = "error";
        this._syncSession.terminationReason = "preparation_or_release_error";
        this.updateSyncSummary(this._syncSession);
        this._syncSession = null;
      }
      this.clock.pause();
      this._playRequested = false;
      this._historicalPreparing = false;
      for (const player of this._historicalPlayers.values()) {
        if (!player.unavailable) {
          this.recordReviewFailure(player, { reason: "shared_initialization_failure",
            stage: "prepare", targetEpoch: this.clock.absoluteTime });
          this.cleanupHistoricalPlayer(player);
          this.setCurrentPlayerStatus(player, "Historical playback unavailable.", true, generation);
        }
      }
      this._historicalStatus = "Unable to prepare playback.";
      const output = this._root?.querySelector(".review-diagnostic-output");
      if (output) output.textContent = sanitizeReviewError(error);
      this.updateTransport();
    }
  }

  enforceHistoricalPlaybackBoundary() {
    if (!this._historicalPlaybackRange || this._presentationMode !== "historical" ||
        !this.clock.running) return false;
    const absolute = this.clock.absoluteTime;
    const now = this._wallClock() / 1000;
    const upper = Math.min(this._historicalPlaybackRange.to, now);
    if (!Number.isFinite(absolute) || absolute < upper) return false;
    if (this._historicalPlaybackRange.to > now) {
      this.returnToLive();
      return true;
    }
    this.clock.pause();
    this.clock.setAbsolute(this._historicalPlaybackRange.to);
    for (const player of this._historicalPlayers.values()) player.video?.pause();
    this.updateTransport();
    this.updateDiagnostics();
    return true;
  }

  updateDiagnostics() {
    const output = this._root?.querySelector(".review-diagnostic-output");
    if (!output || this._presentationMode !== "historical") return;
    const clock = this.clock.absoluteTime;
    const lines = [
      `Transport: ${this.clock.running ? "playing" : "paused"}`,
      "Per-camera recording availability; no correction loop."
    ];
    const estimates = [];
    for (const player of this._historicalPlayers.values()) {
      const achieved = this.cameraEpochFromMedia(player);
      const target = Number.isFinite(achieved) ? achieved : player.lastTargetEpoch;
      const availability = this.inspectPlayerAvailability(player, target);
      const cache = player.availability
        ? `${player.availability.requested_start}-${player.availability.requested_end}`
        : "none";
      const boundary = availability.containing
        ? `coverage=${availability.containing.start}-${availability.containing.end}`
        : `next=${availability.nextStart ?? "none"}`;
      const transition = player.transition?.token ?? player.transitionToken ?? 0;
      if (player.lifecycleState !== "participating" || !player.timing || !player.video) {
        lines.push(`${player.camera.name}: state=${player.lifecycleState}; cache=${cache}; ` +
          `${boundary}; transition=${transition}; reason=${player.boundaryReason ?? "none"}`);
        continue;
      }
      const estimate = achieved;
      if (!Number.isFinite(estimate)) continue;
      estimates.push({ name: player.camera.name, absolute: estimate });
      const delta = Number.isFinite(clock) ? estimate - clock : NaN;
      lines.push(
        `${player.camera.name}: state=participating; cache=${cache}; ${boundary}; ` +
        `transition=${transition}; achieved=${estimate.toFixed(3)}; ` +
        `clock delta=${Number.isFinite(delta) ? delta.toFixed(3) : "--"} s`
      );
    }
    if (estimates.length >= 2) {
      const absoluteTimes = estimates.map(estimate => estimate.absolute);
      lines.push(
        `${estimates[0].name}/${estimates[1].name} absolute delta=` +
        `${Math.abs(estimates[0].absolute - estimates[1].absolute).toFixed(3)} s`
      );
      lines.push(
        `maximum reconstructed absolute delta=` +
        `${(Math.max(...absoluteTimes) - Math.min(...absoluteTimes)).toFixed(3)} s`
      );
    }
    output.textContent = lines.join("\n");
  }

  cleanupHistoricalPlayer(player) {
    if (!player) return;
    if (player.hls) this.recordSceneEvent(player, "hls-destroyed");
    player.cancelHistoricalFrameObserver?.();
    player.cancelHistoricalFrameObserver = null;
    this.cancelCameraTransition(player);
    this.removeSyncListeners(player);
    for (const [event, handler] of player.lifecycleListeners ?? []) {
      player.video?.removeEventListener(event, handler);
    }
    player.lifecycleListeners = [];
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

  removeSyncListeners(player) {
    for (const [event, handler] of player.syncListeners ?? []) {
      player.video?.removeEventListener(event, handler);
    }
    player.syncListeners = [];
  }

  cleanupHistorical() {
    this._initialDeadlineCancel?.();
    this._initialDeadlineCancel = null;
    this.endSyncReport("historical_cleanup_or_generation_change");
    this._availabilityEvaluationPending = false;
    this.clearHistoricalBoundaryTimer();
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
    this._historicalPlaybackRange = null;
    this._historicalPreparing = false;
  }
}
