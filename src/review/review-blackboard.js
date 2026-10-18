// Review Blackboard: an observational flight recorder for unattended Review investigations.
//
// The Blackboard only accumulates. It reads samples and notifications that the
// ReviewController hands it, keeps fixed-size counters, histograms, time bins and bounded
// rings, and formats one sanitized report on request. Nothing in the controller reads it
// back: playback, coverage, recovery and navigation never depend on anything recorded here.
// Every entry point is called through the controller's single isolation boundary, which
// counts faults and disables the Blackboard after repeated failures.

export const BLACKBOARD_VERSION = 1;

// Presentation states, by explicit state only. EMPTY is "no participating presentation
// and no visible held frame", never a claim about pixels.
export const BLACKBOARD_STATES = Object.freeze([
  "verified", "media_only", "frozen", "acquiring", "held", "empty", "paused", "unobserved"
]);
const S = Object.fromEntries(BLACKBOARD_STATES.map((name, index) => [name, index]));
export const BLACKBOARD_COVERAGE = Object.freeze(["recorded", "gap", "unknown"]);
const C = Object.fromEntries(BLACKBOARD_COVERAGE.map((name, index) => [name, index]));
export const BLACKBOARD_EVENT_CLASSES = Object.freeze([
  "played", "flash", "landed_only", "nothing", "not_expected", "unobserved"
]);
const E = Object.fromEntries(BLACKBOARD_EVENT_CLASSES.map((name, index) => [name, index]));
// Time accounting is mutually exclusive across clock x coverage x presentation state. An
// interval counts as clock-running only when the ReviewClock ran at both of its boundary
// samples; everything else is clock-stopped (navigation, preparation, pauses).
export const BLACKBOARD_CLOCK = Object.freeze(["running", "stopped"]);
const K = { running: 0, stopped: 1 };
const CELL = (clock, coverage, state) =>
  (clock * BLACKBOARD_COVERAGE.length + coverage) * BLACKBOARD_STATES.length + state;
// How a navigation request ended, by the evidence available when it was replaced.
export const BLACKBOARD_NAVIGATION_OUTCOMES = Object.freeze([
  "settled_observed",   // a heartbeat saw the request settled
  "settled_unsampled",  // settled before the next request, between heartbeats
  "unsettled_replaced", // still unsettled when the next request began
  "unsettled_window",   // heartbeats saw it unsettled for the whole observation window
  "indeterminate"       // ended without evidence either way (session end)
]);
const ABANDON_REASONS = new Set(["superseded_by_explicit_seek", "authoritative_recording_gap",
  "availability_unknown", "prepare_reported_no_recording_suppressed",
  "continuous_presentation_exhausted"]);
const STOP_DESCRIPTIONS = {
  finished: "Auto Snap event traversal finished \u2014 no further events through the investigation range end",
  awaiting_future_events: "Auto Snap is waiting \u2014 no further events have been published yet within the range",
  blocked_ongoing: "Auto Snap stopped at an event that has no end time yet",
  blocked_incomplete: "Auto Snap stopped \u2014 the event inventory was incomplete"
};

// Provisional, conservative observation thresholds (see the report legend).
export const BLACKBOARD_THRESHOLDS = Object.freeze({
  heartbeatGapMs: 2000,        // a tick later than this means the browser did not observe
  freezeMs: 2000,              // no frame and no media progress while expected
  mediaOnlyWarnMs: 10000,      // media advances without any presented-frame evidence
  expectedEmptyMs: 15000,      // recording exists, clock runs, nothing shown, no failure open
  divergenceSustainMs: 10000,  // |media - clock| beyond tolerance this long
  divergenceBaseSeconds: 2,    // tolerance = base + perRate * playback rate
  divergencePerRateSeconds: 0.5,
  stuckMs: 30000,              // Play intent but the clock is stopped without explanation
  navigationWindowMs: 60000,   // arrival / first-frame observation window per navigation
  discontinuitySeconds: 1,     // unexplained clock movement beyond this (plus 25 %)
  observedShareHealthy: 0.9,
  problemShare: 0.02,
  mediaOnlyShare: 0.1,
  playedMinFrames: 3,
  playedMinSpanSeconds: 1
});
const T = BLACKBOARD_THRESHOLDS;

const DRIFT_EDGES = [0.25, 0.5, 1, 2, 5, 15];
const LATENCY_EDGES_MS = [250, 500, 1000, 2000, 5000, 15000];
const EVENT_DURATION_EDGES = [1, 2, 5, 30];
const EVENT_DURATION_LABELS = ["<1s", "1-2s", "2-5s", "5-30s", ">=30s"];
const MAX_BINS = 336;
const MAX_CAMERAS = 32;
// Per camera, per bin, investigation seconds of: visited with recording, verified,
// media-only, frozen or empty, held or acquiring, gap, unknown, unobserved; problem starts.
const BIN = { rec: 0, ver: 1, mo: 2, bad: 3, trans: 4, gap: 5, unk: 6, uno: 7, inc: 8 };
const BIN_FIELDS = 9;
const INCIDENT_FIRST = 16;
const INCIDENT_RECENT = 48;
const INCIDENT_WORST = 8;
const EVENT_EXAMPLES_FIRST = 8;
const EVENT_EXAMPLES_RECENT = 16;
const NAVIGATION_RECENT = 16;
const GAP_RING = 16;
const CHANGE_RING = 16;
const MAX_FAULTS = 20;
const REPORT_TARGET_BYTES = 40 * 1024;
const REPORT_CAP_BYTES = 64 * 1024;

const NAVIGATION_SOURCES = ["start", "auto_snap", "skip_deadspace", "timeline", "relative",
  "event_snap", "manual", "prototype", "other"];
const ACQUISITION_TRIGGERS = ["navigation", "continuation", "recovery", "join"];
const FAILURE_REASONS = new Set([
  "availability_api_failure", "camera_prepare_failed", "prepare_reported_no_recording",
  "manifest_sign_failure", "manifest_failure", "seekable_or_media_readiness_failure",
  "mapped_seek_failure", "initial_landing_failed", "initial_availability_deadline",
  "initial_preparation_deadline", "initial_landing_deadline", "post_seek_playability_failure",
  "play_rejected", "play_timeout", "play_not_running", "rejoin_play_rejected",
  "rejoin_play_timeout", "rejoin_play_not_running", "unexpected_media_end", "hls_fatal",
  "media_error", "media_stalled", "missing_frigate_camera_mapping",
  "shared_initialization_failure", "rejoin_target_moved"
]);
const FATAL_MEDIA = new Set(["hls_fatal", "media_error", "unexpected_media_end"]);
const INCIDENTS = {
  camera_failure: "problem",
  expected_but_empty: "problem",
  progression_stuck: "problem",
  clock_discontinuity: "problem",
  presentation_freeze: "warning",
  frames_unconfirmed: "warning",
  clock_media_divergence: "warning",
  availability_retained: "warning",
  expected_transition_prolonged: "problem"
};

export function blackboardNavigationSource(source) {
  const text = typeof source === "string" ? source : "";
  if (text === "auto snap event") return "auto_snap";
  if (text === "recording gap skip") return "skip_deadspace";
  if (text === "VCR seek") return "relative";
  if (text.startsWith("timeline")) return "timeline";
  if (text.startsWith("event snap")) return "event_snap";
  if (text === "explicit historical seek") return "manual";
  if (text.startsWith("continuous VOD handoff")) return "prototype";
  return "other";
}

const bbFinite = value => typeof value === "number" && Number.isFinite(value);
const bucket = (edges, value) => {
  for (let index = 0; index < edges.length; index += 1) if (value < edges[index]) return index;
  return edges.length;
};
const safeName = value => typeof value === "string"
  ? value.replace(/[^\w .,:()#+&'-]/g, "").slice(0, 48) || "camera" : "camera";
const ring = (list, item, size) => {
  list.push(item);
  if (list.length > size) list.shift();
};

export function formatBlackboardDuration(ms) {
  if (!bbFinite(ms)) return "--";
  const negative = ms < 0;
  let value = Math.abs(ms);
  if (value < 1000) return `${negative ? "-" : ""}${Math.round(value)}ms`;
  if (value < 60000) return `${negative ? "-" : ""}${(value / 1000).toFixed(1)}s`;
  value = Math.round(value / 1000);
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  const parts = days ? [`${days}d`, `${hours}h`, `${minutes}m`]
    : hours ? [`${hours}h`, `${minutes}m`] : [`${minutes}m`, `${seconds}s`];
  return `${negative ? "-" : ""}${parts.join(" ")}`;
}
const fmt = formatBlackboardDuration;
const fmtS = seconds => fmt(seconds * 1000);
const pct = (part, whole) => whole > 0 ? `${(100 * part / whole).toFixed(1)}%` : "n/a";

export class ReviewBlackboard {
  constructor({ maxFaults = MAX_FAULTS } = {}) {
    this.session = null;
    this.previous = null;
    this.faults = 0;
    this.firstFault = null;
    this.lastFault = null;
    this.disabled = false;
    this._maxFaults = maxFaults;
    this._sessionSequence = 0;
    this._presentationKeys = new WeakMap();
    this._presentationSequence = 0;
  }

  // Called only by the controller's isolation boundary. Must never throw.
  fault(error, where = "unknown") {
    try {
      this.faults += 1;
      const name = typeof error?.name === "string" ? error.name.replace(/[^\w]/g, "").slice(0, 32) : "Error";
      const record = { where: String(where).replace(/[^\w.]/g, "").slice(0, 48), name };
      this.firstFault ??= record;
      this.lastFault = record;
      if (this.faults >= this._maxFaults) this.disabled = true;
    } catch {
      this.disabled = true;
    }
  }

  presentationKey(presentation) {
    if (!presentation || typeof presentation !== "object") return 0;
    let key = this._presentationKeys.get(presentation);
    if (!key) {
      key = ++this._presentationSequence;
      this._presentationKeys.set(presentation, key);
    }
    return key;
  }

  // ---- Session lifecycle ----

  open(spec) {
    const range = bbFinite(spec.range?.from) && bbFinite(spec.range?.to) && spec.range.from < spec.range.to
      ? { from: spec.range.from, to: spec.range.to } : null;
    const names = [...new Set((spec.cameras ?? []).map(safeName))].slice(0, MAX_CAMERAS);
    const current = this.session;
    if (current && current.status !== "ended" &&
        current.intended.rangeKey === (range ? `${range.from}-${range.to}` : "open") &&
        current.intended.cameras.join("\u0000") === names.join("\u0000")) {
      // Same investigation: a restart (event snap, timeline re-placement) is a navigation.
      this.navigationStart({ ...spec, source: spec.source ?? "other" });
      return false;
    }
    if (current && current.status !== "ended") this.end("new_investigation", spec);
    if (this.session) this.previous = this.summaryLine(this.session);
    const startEpoch = bbFinite(spec.startEpoch) ? spec.startEpoch : range?.from ?? 0;
    const width = range
      ? Math.max(3600, Math.ceil((range.to - range.from) / MAX_BINS / 3600) * 3600) : 3600;
    const base = Math.floor((range?.from ?? startEpoch) / 3600) * 3600;
    const span = range ? range.to - base : width * MAX_BINS;
    const binCount = Math.max(1, Math.min(MAX_BINS, Math.ceil(span / width)));
    const session = {
      id: ++this._sessionSequence,
      status: "running",
      endReason: null,
      startedMs: spec.nowMs, startedWall: spec.wallMs, endedMs: null, endedWall: null,
      intended: {
        range, rangeKey: range ? `${range.from}-${range.to}` : "open",
        startEpoch, cameras: names,
        rate: bbFinite(spec.rate) ? spec.rate : null,
        autoSnap: spec.autoSnap === true, skipDeadspace: spec.skipDeadspace === true,
        autoplay: spec.autoplay !== false
      },
      env: { rvfc: spec.rvfc === true ? true : spec.rvfc === false ? false : null,
        visibleAtStart: spec.visible !== false },
      changes: [],
      intent: spec.autoplay === false ? "paused" : "play",
      autoSnapStop: null,
      autoSnapStopSinceMs: null,
      completion: null,
      endingReason: null,
      clock: {
        runningMs: 0, pausedMs: { operator: 0, preparation: 0, end: 0, auto_snap_stopped: 0, unexplained: 0 },
        rateMs: {}, minEpoch: startEpoch, maxEpoch: startEpoch, lastEpoch: startEpoch,
        continuousS: 0, unobservedS: 0, discontinuities: 0, discontinuityS: 0,
        jumps: Object.fromEntries(NAVIGATION_SOURCES.map(source => [source, { count: 0, seconds: 0 }]))
      },
      observation: { ticks: 0, lateTicks: 0, hiddenMs: 0, gapMs: 0, longestGapMs: 0,
        unobservedMs: 0, observedRunningMs: 0, gaps: [], droppedGaps: 0 },
      bins: { base, width, count: binCount,
        visited: new Float32Array(binCount), unobserved: new Float32Array(binCount) },
      cameras: new Map(),
      incidents: { open: new Map(), byType: {}, first: [], recent: [], worst: [],
        total: 0, dropped: 0, sequence: 0 },
      navigation: { bySource: {}, recent: [], pending: null },
      autoSnap: { intervals: 0, interrupted: 0, stops: {}, active: null, pendingExit: [], sequence: 0,
        examples: { first: [], recent: [], dropped: 0 }, deadTimeHist: new Float64Array(7),
        lastEndMs: null },
      skip: { count: 0, seconds: 0, max: 0 },
      spreadHist: new Float64Array(7),
      last: null,
      // Start of Review time not yet credited as traversal: a navigation target, an
      // interval end, or the previous heartbeat. Null means "re-baseline, credit nothing".
      anchor: null
    };
    this.session = session;
    for (const name of names) this.camera(name);
    this.navigationStart({ ...spec, source: spec.source ?? "start", forceSource: "start" });
    return true;
  }

  camera(name) {
    const session = this.session;
    if (!session) return null;
    const key = safeName(name);
    let record = session.cameras.get(key);
    if (record) return record;
    if (session.cameras.size >= MAX_CAMERAS) return null;
    record = {
      name: key,
      matrix: new Float64Array(BLACKBOARD_CLOCK.length * BLACKBOARD_COVERAGE.length *
        BLACKBOARD_STATES.length),
      sampledMs: 0,
      bins: new Float32Array(session.bins.count * BIN_FIELDS),
      driftHist: new Float64Array(7), lagHist: new Float64Array(7), maxDrift: 0,
      landingHist: new Float64Array(7),
      acquisitions: { attempted: 0, landed: 0, verified: 0, unverified: 0, failed: 0, abandoned: 0,
        byTrigger: Object.fromEntries(ACQUISITION_TRIGGERS.map(trigger => [trigger, 0])),
        abandonedByReason: {}, abandonedLinked: {}, plays: 0, longestMs: 0 },
      failures: {}, fatalMedia: 0, stalls: 0, gapLeaves: 0, continuations: 0,
      recovery: { episodes: 0, recovered: 0, superseded: 0, endedByGap: 0, persistent: 0,
        exhausted: 0, maxAttempts: 0, ttrHist: new Float64Array(7), maxTtrMs: 0 },
      events: new Uint32Array((EVENT_DURATION_EDGES.length + 1) * BLACKBOARD_EVENT_CLASSES.length),
      // Session-wide incident counts by type; details may rotate, these never do.
      incidentCounts: {},
      held: 0,
      // Sample baseline and stretch tracking.
      prev: null, preparingSinceMs: null, preparingTrigger: null, preparingInterval: null,
      preparingNavigation: null, lastEvent: null,
      frozenSinceMs: null, mediaOnlySinceMs: null, emptySinceMs: null, transitionSinceMs: null,
      divergeSinceMs: null, final: null
    };
    session.cameras.set(key, record);
    return record;
  }

  end(reason, spec = {}) {
    const session = this.session;
    if (!session || session.status === "ended") return false;
    const nowMs = bbFinite(spec.nowMs) ? spec.nowMs : session.last?.nowMs ?? session.startedMs;
    const wallMs = bbFinite(spec.wallMs) ? spec.wallMs : session.last?.wallMs ?? session.startedWall;
    this.finishInterval(nowMs, "session_ended");
    this.finalizeExits(nowMs, { force: true });
    this.finishNavigation(nowMs, "session_ended");
    for (const incident of [...session.incidents.open.values()]) {
      this.closeIncident(incident, incident.type === "camera_failure" ? "persistent" : "session_ended",
        nowMs, wallMs);
    }
    session.status = "ended";
    session.endReason = session.endingReason ?? reason;
    session.endedMs = nowMs;
    session.endedWall = wallMs;
    return true;
  }

  noteEnding(reason) {
    if (this.session && this.session.status !== "ended") this.session.endingReason = reason;
  }

  // ---- Intent, options and clock notifications ----

  intent(kind, value, spec = {}) {
    const session = this.active();
    if (!session) return;
    if (kind === "play") {
      session.intent = "play";
      session.autoSnapStop = null;
      session.autoSnapStopSinceMs = null;
      if (session.completion === "reached_end") session.completion = null;
    } else if (kind === "pause") {
      session.intent = "paused";
      this.finishInterval(spec.nowMs, "interrupted");
    }
    ring(session.changes, { atWall: spec.wallMs ?? null, kind: String(kind).slice(0, 24),
      value: typeof value === "boolean" || bbFinite(value) ? value : null }, CHANGE_RING);
  }

  clockJump() {
    const session = this.active();
    if (session) session.anchor = null;
  }

  reachedEnd(spec = {}) {
    const session = this.active();
    if (!session) return;
    const end = session.intended.range?.to;
    if (bbFinite(end)) this.creditTo(end, spec);
    session.anchor = null;
    session.completion = "reached_end";
    ring(session.changes, { atWall: spec.wallMs ?? null, kind: "reached_end", value: null }, CHANGE_RING);
  }

  autoSnapStopped(outcome, spec = {}) {
    const session = this.active();
    if (!session) return;
    const key = String(outcome).replace(/[^\w]/g, "").slice(0, 32) || "other";
    session.autoSnapStop = key;
    session.autoSnapStopSinceMs = bbFinite(spec.nowMs) ? spec.nowMs : null;
    session.autoSnap.stops[key] = (session.autoSnap.stops[key] ?? 0) + 1;
    this.finishInterval(spec.nowMs, "interrupted");
  }

  active() {
    return this.session && this.session.status !== "ended" ? this.session : null;
  }

  // ---- Navigation ----

  navigationStart(spec) {
    const session = this.active();
    if (!session) return;
    const nowMs = spec.nowMs;
    const source = spec.forceSource ?? blackboardNavigationSource(spec.source);
    this.finishNavigation(nowMs, "replaced",
      typeof spec.previousSettled === "boolean" ? spec.previousSettled : null);
    const from = bbFinite(spec.fromEpoch) ? spec.fromEpoch : null;
    const target = bbFinite(spec.target) ? spec.target : bbFinite(spec.startEpoch) ? spec.startEpoch : null;
    const jump = from !== null && target !== null ? target - from : 0;
    const counts = this.navigationCounts(source);
    counts.requested += 1;
    session.clock.jumps[source].count += 1;
    session.clock.jumps[source].seconds += Math.max(0, jump);
    if (source === "skip_deadspace") {
      session.skip.count += 1;
      session.skip.seconds += Math.max(0, jump);
      session.skip.max = Math.max(session.skip.max, jump);
    } else if (source !== "auto_snap" && source !== "start") {
      // Operator navigation ends any Auto Snap interval in progress.
      this.finishInterval(nowMs, "interrupted");
    }
    if (typeof spec.autoplay === "boolean") session.intent = spec.autoplay ? "play" : "paused";
    session.autoSnapStop = null;
    session.autoSnapStopSinceMs = null;
    if (session.completion === "reached_end") session.completion = null;
    // A jump is never traversal: credit resumes from the target.
    session.anchor = target !== null ? { epoch: target, nowMs } : null;
    // A navigation discards any owed recovery; an open failure is marked superseded.
    for (const incident of session.incidents.open.values()) {
      if (incident.type === "camera_failure") incident.superseded = true;
    }
    session.navigation.pending = { source, startedMs: nowMs, startedWall: spec.wallMs ?? null,
      requestId: Number.isSafeInteger(spec.requestId) ? spec.requestId : null,
      from, target, settledMs: null, ticks: 0, acquisitions: new Map() };
  }

  navigationCounts(source) {
    return this.session.navigation.bySource[source] ??= {
      requested: 0,
      outcomes: Object.fromEntries(BLACKBOARD_NAVIGATION_OUTCOMES.map(outcome => [outcome, 0])),
      landed: 0, notLanded: 0, noAcquisition: 0, presented: 0, presentedExact: 0, notPresented: 0,
      frameNotSampled: 0, landingHist: new Float64Array(7), frameHist: new Float64Array(7),
      frameBoundHist: new Float64Array(7)
    };
  }

  // Finalizes a request once. Later observations of its acquisitions never revise it.
  finishNavigation(nowMs, cause, previousSettled = null) {
    const session = this.session;
    const pending = session?.navigation.pending;
    if (!pending) return;
    session.navigation.pending = null;
    const counts = this.navigationCounts(pending.source);
    const outcome = pending.settledMs !== null ? "settled_observed"
      : cause === "replaced" && previousSettled === true ? "settled_unsampled"
        : cause === "replaced" && previousSettled === false ? "unsettled_replaced"
          : cause === "window_elapsed" ? "unsettled_window" : "indeterminate";
    counts.outcomes[outcome] += 1;
    // Landing uses the cameras' lifecycle timestamps; it is measured exactly or not at all.
    const acquisitions = [...pending.acquisitions.values()];
    let landingMs = null;
    let frameMs = null;
    let frameExact = false;
    if (!acquisitions.length) counts.noAcquisition += 1;
    else if (acquisitions.every(item => item.outcome === "landed")) {
      landingMs = Math.max(...acquisitions.map(item => item.endMs)) - pending.startedMs;
      counts.landed += 1;
      counts.landingHist[bucket(LATENCY_EDGES_MS, landingMs)] += 1;
      // First presented advance: the frame observer's own timestamp when its Play attempt
      // recorded one; otherwise the heartbeat that first saw a new frame (an upper bound).
      if (acquisitions.every(item => bbFinite(item.frameMs))) {
        frameMs = Math.max(...acquisitions.map(item => item.frameMs)) - pending.startedMs;
        frameExact = acquisitions.every(item => item.frameExact);
        counts.presented += 1;
        if (frameExact) {
          counts.presentedExact += 1;
          counts.frameHist[bucket(LATENCY_EDGES_MS, frameMs)] += 1;
        } else counts.frameBoundHist[bucket(LATENCY_EDGES_MS, frameMs)] += 1;
      } else if (pending.ticks === 0) counts.frameNotSampled += 1;
      else counts.notPresented += 1;
    } else counts.notLanded += 1;
    ring(session.navigation.recent, {
      source: pending.source, atWall: pending.startedWall, from: pending.from, target: pending.target,
      outcome, landingMs, frameMs, frameExact, acquisitions: acquisitions.length,
      landedCount: acquisitions.filter(item => item.outcome === "landed").length,
      unfinished: acquisitions.filter(item => item.outcome === "acquiring").length,
      sampled: pending.ticks > 0
    }, NAVIGATION_RECENT);
  }

  // ---- Camera notifications (lifecycle, holds, failures, recovery) ----

  cameraEvent(name, kind, details = {}) {
    const session = this.active();
    const record = session && this.camera(name);
    if (!record) return;
    const nowMs = details.nowMs;
    if (kind === "lifecycle") {
      const { state, previousState } = details;
      const pending = session.navigation.pending;
      if (state === "preparing" && previousState !== "preparing") {
        if (details.boundaryReason === "play_release") {
          record.acquisitions.plays += 1;
          record.preparingTrigger = "play";
        } else {
          const trigger = this.openFailure(record.name) ? "recovery"
            : details.boundaryReason === "presentation_window_exhausted" ? "continuation"
              : pending ? "navigation" : "join";
          record.acquisitions.attempted += 1;
          record.acquisitions.byTrigger[trigger] += 1;
          record.preparingTrigger = trigger;
          record.preparingInterval = session.autoSnap.active?.id ?? null;
          record.preparingNavigation = pending ?? null;
          if (pending) pending.acquisitions.set(record.name, { startMs: nowMs, endMs: null,
            outcome: "acquiring", frameMs: null });
          if (session.autoSnap.active) {
            const camera = session.autoSnap.active.cameras.get(record.name);
            if (camera) camera.acquisition = true;
          }
        }
        record.preparingSinceMs = nowMs;
      } else if (previousState === "preparing" && state !== "preparing") {
        if (record.preparingSinceMs === null) {
          // Began before observation (a camera is created preparing): count the attempt.
          const trigger = pending ? "navigation" : "join";
          record.acquisitions.attempted += 1;
          record.acquisitions.byTrigger[trigger] += 1;
          record.preparingTrigger = trigger;
          record.preparingInterval = session.autoSnap.active?.id ?? null;
          record.preparingNavigation = pending ?? null;
          if (pending) pending.acquisitions.set(record.name, { startMs: pending.startedMs, endMs: null,
            outcome: "acquiring", frameMs: null });
        }
        if (record.preparingTrigger !== "play") {
          const outcome = state === "participating" ? "landed" : state === "failed" ? "failed" : "abandoned";
          if (outcome === "landed") {
            record.acquisitions.landed += 1;
            if (details.verified === true) record.acquisitions.verified += 1;
            else record.acquisitions.unverified += 1;
            if (bbFinite(record.preparingSinceMs) && bbFinite(nowMs)) {
              const ms = nowMs - record.preparingSinceMs;
              record.landingHist[bucket(LATENCY_EDGES_MS, ms)] += 1;
              record.acquisitions.longestMs = Math.max(record.acquisitions.longestMs, ms);
            }
          } else if (outcome === "failed") record.acquisitions.failed += 1;
          else this.abandoned(record, details.boundaryReason);
          // Only the request that started this acquisition, while still current, records it.
          const owner = record.preparingNavigation;
          if (owner && owner === session.navigation.pending) {
            const item = owner.acquisitions.get(record.name);
            if (item && item.outcome === "acquiring") {
              item.outcome = outcome;
              item.endMs = nowMs;
            }
          }
        }
        record.preparingSinceMs = null;
        record.preparingTrigger = null;
        record.preparingInterval = null;
        record.preparingNavigation = null;
      }
    } else if (kind === "held-frame-started") {
      record.held += 1;
    }
  }

  // An acquisition ended without landing or failing. It is linked to an Auto Snap interval
  // only when that same interval started the acquisition.
  abandoned(record, boundaryReason) {
    const session = this.session;
    const reason = ABANDON_REASONS.has(boundaryReason) ? boundaryReason : "other";
    const counts = record.acquisitions;
    counts.abandoned += 1;
    counts.abandonedByReason[reason] = (counts.abandonedByReason[reason] ?? 0) + 1;
    const interval = record.preparingInterval;
    if (interval === null) return;
    const active = session.autoSnap.active;
    if (active?.id === interval) {
      const tracked = active.cameras.get(record.name);
      if (tracked) tracked.abandoned = reason;
      return;
    }
    if (record.lastEvent?.id !== interval) return;
    counts.abandonedLinked[record.lastEvent.cls] = (counts.abandonedLinked[record.lastEvent.cls] ?? 0) + 1;
    const examples = session.autoSnap.examples;
    for (const example of [...session.autoSnap.pendingExit.map(item => item.example), ...examples.first,
      ...examples.recent]) {
      if (example.intervalId === interval && example.camera === record.name) example.abandoned = reason;
    }
  }

  failure(record) {
    const session = this.active();
    const camera = session && this.camera(record?.camera);
    if (!camera) return;
    const reason = FAILURE_REASONS.has(record.reason) ? record.reason
      : record.reason === "authoritative_recording_gap" ? record.reason
        : record.reason === "continuous_presentation_exhausted" ? record.reason : "other";
    if (record.outcome === "no_coverage") {
      camera.gapLeaves += 1;
      return;
    }
    if (record.outcome === "normal_terminal") {
      camera.continuations += 1;
      return;
    }
    if (record.outcome === "retained_after_failure") {
      this.instantIncident("availability_retained", camera.name, record, reason);
      return;
    }
    camera.failures[reason] = (camera.failures[reason] ?? 0) + 1;
    if (FATAL_MEDIA.has(reason)) camera.fatalMedia += 1;
    if (reason === "media_stalled") camera.stalls += 1;
    const open = this.openFailure(camera.name);
    if (open) {
      open.failures += 1;
      open.lastReason = reason;
      return;
    }
    const incident = this.openIncident("camera_failure", camera.name, {
      nowMs: record.nowMs, wallMs: record.wallMs,
      epoch: bbFinite(record.targetEpoch) ? record.targetEpoch : session.clock.lastEpoch,
      trigger: reason, stage: typeof record.stage === "string" ? record.stage.slice(0, 32) : null
    });
    incident.failures = 1;
    incident.lastReason = reason;
    camera.recovery.episodes += 1;
  }

  recovery(name, { attempts = 0, exhausted = false, availabilityFailed = false } = {}) {
    const session = this.active();
    const camera = session && this.camera(name);
    if (!camera) return;
    const incident = this.openFailure(camera.name);
    if (!incident) return;
    if (bbFinite(attempts)) {
      incident.attempts = Math.max(incident.attempts ?? 0, attempts);
      camera.recovery.maxAttempts = Math.max(camera.recovery.maxAttempts, attempts);
    }
    if (availabilityFailed) incident.availabilityFailed = true;
    if (exhausted && !incident.exhausted) {
      incident.exhausted = true;
      camera.recovery.exhausted += 1;
    }
  }

  openFailure(name) {
    return this.session?.incidents.open.get(`camera_failure|${name}`) ?? null;
  }

  // ---- Auto Snap intervals (R-09) ----

  autoSnapStart(spec, cameras) {
    const session = this.active();
    if (!session) return;
    const nowMs = spec.nowMs;
    this.finalizeExits(nowMs, { nextReached: true });
    this.finishInterval(nowMs, "interrupted");
    if (bbFinite(session.autoSnap.lastEndMs)) {
      session.autoSnap.deadTimeHist[bucket(LATENCY_EDGES_MS, nowMs - session.autoSnap.lastEndMs)] += 1;
      session.autoSnap.lastEndMs = null;
    }
    if (!bbFinite(spec.start) || !bbFinite(spec.end) || !(spec.end > spec.start)) return;
    const active = { id: ++session.autoSnap.sequence, start: spec.start, end: spec.end, startedMs: nowMs,
      cameras: new Map() };
    for (const camera of cameras ?? []) {
      const name = safeName(camera.name);
      if (!this.camera(name)) continue;
      active.cameras.set(name, { frames0: bbFinite(camera.frames) ? camera.frames : 0,
        unobserved: camera.visible === false, acquisition: false, abandoned: null });
    }
    session.autoSnap.active = active;
  }

  autoSnapEnd(spec, cameras) {
    const session = this.active();
    const active = session?.autoSnap.active;
    if (!active) return;
    const nowMs = spec.nowMs;
    // The clock traversed the interval up to where it actually reached, even between
    // heartbeats. Completing early (Skip Deadspace proved the rest empty) is a jump.
    const reached = bbFinite(spec.epoch) ? Math.min(spec.epoch, active.end) : active.end;
    this.creditTo(reached, spec);
    if (reached < active.end) {
      const skipped = active.end - reached;
      session.skip.count += 1;
      session.skip.seconds += skipped;
      session.skip.max = Math.max(session.skip.max, skipped);
      session.clock.jumps.skip_deadspace.count += 1;
      session.clock.jumps.skip_deadspace.seconds += skipped;
    }
    session.anchor = { epoch: active.end, nowMs };
    session.autoSnap.active = null;
    session.autoSnap.intervals += 1;
    session.autoSnap.lastEndMs = nowMs;
    const duration = active.end - active.start;
    const durationIndex = bucket(EVENT_DURATION_EDGES, duration);
    for (const camera of cameras ?? []) {
      const name = safeName(camera.name);
      const record = this.camera(name);
      const tracked = active.cameras.get(name);
      if (!record || !tracked) continue;
      const frames = Math.max(0, (bbFinite(camera.frames) ? camera.frames : 0) - tracked.frames0);
      const landedEpoch = bbFinite(camera.landedEpoch) ? camera.landedEpoch : null;
      const landed = camera.verifiedLanding === true && landedEpoch !== null &&
        landedEpoch >= active.start - 0.5 && landedEpoch <= active.end + 0.5;
      const spanStart = landed ? Math.max(active.start, landedEpoch) : active.start;
      const frameEpoch = bbFinite(camera.frameEpoch) ? camera.frameEpoch : null;
      const span = frames > 0 && frameEpoch !== null && frameEpoch >= active.start - 0.5
        ? Math.max(0, Math.min(frameEpoch, active.end) - spanStart) : 0;
      let kind;
      if (tracked.unobserved || camera.visible === false) kind = E.unobserved;
      else if (camera.coverage !== "recorded") kind = E.not_expected;
      else if (frames >= T.playedMinFrames &&
        span >= Math.min(T.playedMinSpanSeconds, duration * 0.5)) kind = E.played;
      else if (frames > 0) kind = E.flash;
      else if (landed) kind = E.landed_only;
      else kind = E.nothing;
      record.events[durationIndex * BLACKBOARD_EVENT_CLASSES.length + kind] += 1;
      record.lastEvent = { id: active.id, cls: BLACKBOARD_EVENT_CLASSES[kind] };
      if (tracked.abandoned) {
        const cls = BLACKBOARD_EVENT_CLASSES[kind];
        record.acquisitions.abandonedLinked[cls] = (record.acquisitions.abandonedLinked[cls] ?? 0) + 1;
      }
      if (kind === E.flash || kind === E.landed_only || kind === E.nothing) {
        session.autoSnap.pendingExit.push({ record, example: {
          intervalId: active.id, camera: name, start: active.start, duration,
          cls: BLACKBOARD_EVENT_CLASSES[kind], frames, span, landed, acquisition: tracked.acquisition,
          abandoned: tracked.abandoned, exit: null, nextReached: false, atWall: spec.wallMs ?? null },
          dueMs: nowMs });
      }
    }
  }

  finishInterval(nowMs, outcome) {
    const session = this.session;
    if (!session?.autoSnap.active) return;
    session.autoSnap.active = null;
    if (outcome === "interrupted" || outcome === "session_ended") session.autoSnap.interrupted += 1;
  }

  // Exit presentation of problematic events is judged one heartbeat later, once the
  // next acquisition has either held the frame, kept its own video, or left the cell empty.
  finalizeExits(nowMs, { force = false, nextReached = false } = {}) {
    const session = this.session;
    if (!session?.autoSnap.pendingExit.length) return;
    const remaining = [];
    for (const item of session.autoSnap.pendingExit) {
      if (nextReached) item.example.nextReached = true;
      const prev = item.record.prev;
      if (!force && !(prev && prev.nowMs > item.dueMs)) {
        remaining.push(item);
        continue;
      }
      item.example.exit = !prev || prev.nowMs <= item.dueMs ? "unknown" : prev.held ? "held"
        : prev.lifecycle === "participating" ? "own_video" : "empty";
      const examples = session.autoSnap.examples;
      if (examples.first.length < EVENT_EXAMPLES_FIRST) examples.first.push(item.example);
      else {
        if (examples.recent.length >= EVENT_EXAMPLES_RECENT) examples.dropped += 1;
        ring(examples.recent, item.example, EVENT_EXAMPLES_RECENT);
      }
    }
    session.autoSnap.pendingExit = remaining;
  }

  // ---- Incidents ----

  openIncident(type, camera, { nowMs, wallMs, epoch, trigger = null, stage = null } = {}) {
    const session = this.session;
    const key = `${type}|${camera ?? "-"}`;
    const existing = session.incidents.open.get(key);
    if (existing) return existing;
    const incident = { seq: ++session.incidents.sequence, type, severity: INCIDENTS[type] ?? "warning",
      camera: camera ?? null, startMs: nowMs, startWall: bbFinite(wallMs) ? wallMs : null,
      startEpoch: bbFinite(epoch) ? epoch : null, endWall: null, durationMs: null,
      trigger: typeof trigger === "string" ? trigger.slice(0, 48) : null, stage,
      attempts: 0, failures: 0, exhausted: false, superseded: false, outcome: "open" };
    session.incidents.open.set(key, incident);
    session.incidents.total += 1;
    const stats = session.incidents.byType[type] ??= { count: 0, totalMs: 0, maxMs: 0, recovered: 0,
      superseded: 0, unresolved: 0, open: 0, firstWall: null, firstEpoch: null, lastWall: null, lastEpoch: null };
    stats.count += 1;
    stats.firstWall ??= incident.startWall;
    stats.firstEpoch ??= incident.startEpoch;
    stats.lastWall = incident.startWall;
    stats.lastEpoch = incident.startEpoch;
    const record = camera ? session.cameras.get(camera) : null;
    if (record) {
      record.incidentCounts[type] = (record.incidentCounts[type] ?? 0) + 1;
      const index = this.binIndex(incident.startEpoch);
      if (incident.severity === "problem" && index !== null) record.bins[index * BIN_FIELDS + BIN.inc] += 1;
    }
    return incident;
  }

  closeIncident(incident, outcome, nowMs, wallMs) {
    const session = this.session;
    session.incidents.open.delete(`${incident.type}|${incident.camera ?? "-"}`);
    incident.outcome = outcome;
    incident.durationMs = bbFinite(nowMs) && bbFinite(incident.startMs) ? Math.max(0, nowMs - incident.startMs) : 0;
    incident.endWall = bbFinite(wallMs) ? wallMs : null;
    const stats = session.incidents.byType[incident.type];
    stats.totalMs += incident.durationMs;
    stats.maxMs = Math.max(stats.maxMs, incident.durationMs);
    if (outcome === "recovered" || outcome === "resolved") stats.recovered += 1;
    else if (outcome === "superseded") stats.superseded += 1;
    else if (outcome === "persistent") stats.unresolved += 1;
    if (incident.type === "camera_failure") {
      const record = session.cameras.get(incident.camera);
      if (record) {
        if (outcome === "recovered") record.recovery.recovered += 1;
        else if (outcome === "superseded") record.recovery.superseded += 1;
        else if (outcome === "ended_by_gap") record.recovery.endedByGap += 1;
        else if (outcome === "persistent") record.recovery.persistent += 1;
        if (outcome === "recovered" || outcome === "superseded") {
          record.recovery.ttrHist[bucket(LATENCY_EDGES_MS, incident.durationMs)] += 1;
          record.recovery.maxTtrMs = Math.max(record.recovery.maxTtrMs, incident.durationMs);
        }
      }
    }
    const detail = this.incidentDetail(incident);
    const store = session.incidents;
    if (store.first.length < INCIDENT_FIRST) store.first.push(detail);
    else {
      if (store.recent.length >= INCIDENT_RECENT) store.dropped += 1;
      ring(store.recent, detail, INCIDENT_RECENT);
    }
    if (store.worst.length < INCIDENT_WORST || detail.durationMs > store.worst.at(-1).durationMs) {
      store.worst.push(detail);
      store.worst.sort((left, right) => right.durationMs - left.durationMs);
      if (store.worst.length > INCIDENT_WORST) store.worst.pop();
    }
  }

  instantIncident(type, camera, record, trigger) {
    const session = this.session;
    const incident = this.openIncident(type, camera, { nowMs: record?.nowMs, wallMs: record?.wallMs,
      epoch: bbFinite(record?.targetEpoch) ? record.targetEpoch : session.clock.lastEpoch, trigger });
    this.closeIncident(incident, "resolved", record?.nowMs ?? incident.startMs, record?.wallMs);
  }

  incidentDetail(incident) {
    return { seq: incident.seq, type: incident.type, severity: incident.severity, camera: incident.camera,
      startWall: incident.startWall, startEpoch: incident.startEpoch, durationMs: incident.durationMs,
      trigger: incident.trigger, lastReason: incident.lastReason ?? null, failures: incident.failures,
      attempts: incident.attempts, exhausted: incident.exhausted, superseded: incident.superseded,
      outcome: incident.outcome };
  }

  binIndex(epoch) {
    const bins = this.session?.bins;
    if (!bins || !bbFinite(epoch)) return null;
    const index = Math.floor((epoch - bins.base) / bins.width);
    return index < 0 ? 0 : index >= bins.count ? bins.count - 1 : index;
  }

  // Spreads investigation seconds [from, from + seconds) across time bins.
  spread(from, seconds, add) {
    const bins = this.session.bins;
    let cursor = from;
    let left = seconds;
    for (let guard = 0; left > 1e-9 && guard < 8; guard += 1) {
      const index = this.binIndex(cursor);
      if (index === null) return;
      const binEnd = index === bins.count - 1 ? Infinity : bins.base + (index + 1) * bins.width;
      const part = Math.min(left, Math.max(1e-9, binEnd - cursor));
      add(index, part);
      cursor += part;
      left -= part;
    }
  }

  // Credits Review time from the anchor to an epoch the clock is known to have reached
  // (an Auto Snap interval end or the range end) between heartbeats. Unobserved spans are
  // credited as unobserved; an implausible span is never credited.
  creditTo(epoch, spec = {}) {
    const session = this.session;
    const anchor = session.anchor;
    const last = session.last;
    if (!anchor || !bbFinite(epoch)) return;
    const credit = epoch - anchor.epoch;
    const nowMs = bbFinite(spec.nowMs) ? spec.nowMs : last?.nowMs;
    if (!(credit > 0) || !bbFinite(nowMs)) return;
    const rate = Math.max(last?.rate ?? 0, session.intended.rate ?? 0);
    if (credit > rate * Math.max(0, nowMs - anchor.nowMs) / 1000 * 1.25 + T.discontinuitySeconds) return;
    const observed = spec.visible !== false && !!last && last.visible &&
      nowMs - last.nowMs <= T.heartbeatGapMs;
    this.creditTraversal(anchor.epoch, credit, observed);
  }

  creditTraversal(from, seconds, observed) {
    const session = this.session;
    if (observed) session.clock.continuousS += seconds;
    else session.clock.unobservedS += seconds;
    const target = observed ? session.bins.visited : session.bins.unobserved;
    this.spread(from, seconds, (index, part) => { target[index] += part; });
  }

  // ---- Heartbeat sample ----

  sample(sample) {
    const session = this.active();
    if (!session) return;
    const last = session.last;
    session.observation.ticks += 1;
    if (sample.rvfc === true) session.env.rvfc = true;
    else if (sample.rvfc === false && session.env.rvfc === null) session.env.rvfc = false;
    if (!last) {
      session.last = this.baseline(sample);
      for (const camera of sample.cameras) this.cameraBaseline(camera, sample);
      // A navigation target recorded before the first heartbeat stays the anchor.
      session.anchor ??= { epoch: sample.epoch, nowMs: sample.nowMs };
      return;
    }
    const dtMs = Math.max(0, sample.nowMs - last.nowMs);
    const late = dtMs > T.heartbeatGapMs;
    const unobserved = late || !sample.visible || !last.visible;
    const observation = session.observation;
    if (late) {
      observation.lateTicks += 1;
      observation.gapMs += dtMs;
      observation.longestGapMs = Math.max(observation.longestGapMs, dtMs);
      if (observation.gaps.length >= GAP_RING) observation.droppedGaps += 1;
      ring(observation.gaps, { atWall: last.wallMs, ms: dtMs, hidden: !sample.visible || !last.visible,
        epochBefore: last.epoch, epochAfter: sample.epoch }, GAP_RING);
    }
    if (!sample.visible) observation.hiddenMs += dtMs;
    if (unobserved) observation.unobservedMs += dtMs;

    // Clock progression.
    const clock = session.clock;
    const running = last.running && sample.running;
    if (running) {
      clock.runningMs += dtMs;
      if (!unobserved) observation.observedRunningMs += dtMs;
      const rateKey = String(sample.rate);
      clock.rateMs[rateKey] = (clock.rateMs[rateKey] ?? 0) + dtMs;
    } else if (!sample.running) {
      clock.pausedMs[this.pauseCause(session, sample)] += dtMs;
    }
    // Traversal since the anchor (the previous heartbeat, or a navigation target or interval
    // end reached since then). A jump moved the anchor; unexplained movement is never credited.
    const anchor = session.anchor;
    let visited = 0;
    const visitedFrom = anchor?.epoch ?? last.epoch;
    if (anchor && bbFinite(sample.epoch)) {
      const dEpoch = sample.epoch - anchor.epoch;
      const spanMs = Math.max(0, sample.nowMs - anchor.nowMs);
      const moved = last.running || sample.running;
      const expected = moved ? Math.max(sample.rate, last.rate) * spanMs / 1000 : 0;
      const unexplained = dEpoch < -T.discontinuitySeconds ||
        dEpoch > expected * 1.25 + T.discontinuitySeconds;
      if (unexplained) {
        if (!unobserved && sample.rate === last.rate) {
          clock.discontinuities += 1;
          clock.discontinuityS += Math.abs(dEpoch - expected);
          this.instantIncident("clock_discontinuity", null,
            { nowMs: sample.nowMs, wallMs: sample.wallMs, targetEpoch: anchor.epoch }, "unexplained_clock_movement");
        }
      } else if (moved && dEpoch > 0) visited = dEpoch;
    }
    if (visited > 0) this.creditTraversal(visitedFrom, visited, !unobserved);
    session.anchor = bbFinite(sample.epoch) ? { epoch: sample.epoch, nowMs: sample.nowMs } : null;
    if (bbFinite(sample.epoch)) {
      clock.minEpoch = Math.min(clock.minEpoch, sample.epoch);
      clock.maxEpoch = Math.max(clock.maxEpoch, sample.epoch);
      clock.lastEpoch = sample.epoch;
    }

    // Progression stuck: Play intent, a stopped clock and nothing that explains it.
    if (!sample.running && this.pauseCause(session, sample) === "unexplained") {
      session.stuckSinceMs ??= last.nowMs;
      if (sample.nowMs - session.stuckSinceMs >= T.stuckMs) {
        this.openIncident("progression_stuck", null, { nowMs: session.stuckSinceMs,
          wallMs: sample.wallMs - (sample.nowMs - session.stuckSinceMs), epoch: sample.epoch,
          trigger: "play_intent_without_clock" });
      }
    } else {
      session.stuckSinceMs = null;
      const stuck = session.incidents.open.get("progression_stuck|-");
      if (stuck) this.closeIncident(stuck, "resolved", sample.nowMs, sample.wallMs);
    }

    // Cameras.
    const drifts = [];
    for (const camera of sample.cameras) {
      const drift = this.sampleCamera(camera, sample, dtMs, unobserved, visited, visitedFrom, last);
      if (bbFinite(drift)) drifts.push(drift);
    }
    if (drifts.length > 1 && !unobserved) {
      session.spreadHist[bucket(DRIFT_EDGES, Math.max(...drifts) - Math.min(...drifts))] += dtMs;
    }

    // Navigation settlement as heartbeats observe it, and each landed camera's first
    // presented advance by the frame observer's own timestamp.
    const pending = session.navigation.pending;
    if (pending) {
      pending.ticks += 1;
      if (pending.settledMs === null && !sample.navigationPreparing &&
          (pending.requestId === null || sample.requestId === pending.requestId)) {
        pending.settledMs = sample.nowMs;
      }
      for (const camera of sample.cameras) {
        const item = pending.acquisitions.get(safeName(camera.name));
        if (!item || item.outcome !== "landed" || item.frameMs !== null) continue;
        if (bbFinite(camera.firstAdvanceAtMs) && camera.firstAdvanceAtMs >= pending.startedMs &&
            bbFinite(camera.playIssuedAtMs) && camera.playIssuedAtMs >= pending.startedMs) {
          item.frameMs = camera.firstAdvanceAtMs;
          item.frameExact = true;
        } else if (!unobserved && session.cameras.get(safeName(camera.name))?.prev?.state === S.verified) {
          item.frameMs = sample.nowMs;
          item.frameExact = false;
        }
      }
      const acquisitions = [...pending.acquisitions.values()];
      const done = pending.settledMs !== null && acquisitions.every(item => item.outcome !== "acquiring" &&
        (item.outcome !== "landed" || item.frameMs !== null));
      if (done) this.finishNavigation(sample.nowMs, "settled");
      else if (sample.nowMs - pending.startedMs > T.navigationWindowMs) {
        this.finishNavigation(sample.nowMs, "window_elapsed");
      }
    }
    if (session.autoSnap.active && unobserved) {
      for (const camera of session.autoSnap.active.cameras.values()) camera.unobserved = true;
    }
    this.finalizeExits(sample.nowMs);
    session.last = this.baseline(sample);
  }

  baseline(sample) {
    return { nowMs: sample.nowMs, wallMs: sample.wallMs, epoch: sample.epoch, running: sample.running,
      rate: sample.rate, visible: sample.visible };
  }

  cameraBaseline(camera, sample) {
    const record = this.camera(camera.name);
    if (!record) return;
    record.prev = { nowMs: sample.nowMs, frames: camera.frames,
      key: this.presentationKey(camera.presentation), media: camera.mediaEpoch,
      lifecycle: camera.lifecycle, held: camera.held === true, state: S.acquiring };
  }

  pauseCause(session, sample) {
    if (sample.preparing) return "preparation";
    if (session.completion === "reached_end") return "end";
    if (session.autoSnapStop) return "auto_snap_stopped";
    if (session.intent === "paused") return "operator";
    return "unexplained";
  }

  sampleCamera(camera, sample, dtMs, unobserved, visited, visitedFrom, last) {
    const session = this.session;
    const record = this.camera(camera.name);
    if (!record) return null;
    const prev = record.prev;
    const key = this.presentationKey(camera.presentation);
    const coverage = C[camera.coverage] ?? C.unknown;
    let state;
    if (unobserved || !prev) state = S.unobserved;
    else if (camera.held) state = S.held;
    else if (camera.lifecycle === "preparing" || camera.transition || camera.waiting) state = S.acquiring;
    else if (sample.preparing && camera.lifecycle === "participating") state = S.acquiring;
    else if (!sample.running) state = S.paused;
    else if (camera.lifecycle === "participating") {
      if (key !== prev.key || prev.lifecycle !== "participating") state = S.acquiring;
      else if (bbFinite(camera.frames) && camera.frames > prev.frames) state = S.verified;
      else if (bbFinite(camera.mediaEpoch) && bbFinite(prev.media) &&
        Math.abs(camera.mediaEpoch - prev.media) > 0.001) state = S.media_only;
      else state = S.frozen;
    } else state = S.empty;
    const clockIndex = last.running && sample.running ? K.running : K.stopped;
    record.matrix[CELL(clockIndex, coverage, state)] += dtMs;
    record.sampledMs += dtMs;

    if (visited > 0) {
      const field = state === S.unobserved ? BIN.uno
        : coverage === C.gap ? BIN.gap : coverage === C.unknown ? BIN.unk : null;
      this.spread(visitedFrom, visited, (index, part) => {
        const offset = index * BIN_FIELDS;
        if (field !== null) {
          record.bins[offset + field] += part;
          return;
        }
        record.bins[offset + BIN.rec] += part;
        if (state === S.verified) record.bins[offset + BIN.ver] += part;
        else if (state === S.media_only) record.bins[offset + BIN.mo] += part;
        else if (state === S.frozen || state === S.empty) record.bins[offset + BIN.bad] += part;
        else record.bins[offset + BIN.trans] += part;
      });
    }

    const nowMs = sample.nowMs;
    const expected = coverage === C.recorded && clockIndex === K.running && !unobserved;
    // Observational stretches. Unobserved time closes them and starts a fresh baseline.
    this.stretch(record, "frozenSinceMs", "presentation_freeze", expected && state === S.frozen,
      T.freezeMs, sample, last, state === S.verified || state === S.media_only ? "resolved" : "ended");
    this.stretch(record, "mediaOnlySinceMs", "frames_unconfirmed", expected && state === S.media_only,
      T.mediaOnlyWarnMs, sample, last, "resolved");
    this.stretch(record, "emptySinceMs", "expected_but_empty",
      expected && state === S.empty && !this.openFailure(record.name), T.expectedEmptyMs, sample, last,
      "resolved");
    // Acquiring or holding while the clock runs is not presentation; it is bounded too.
    this.stretch(record, "transitionSinceMs", "expected_transition_prolonged",
      expected && (state === S.acquiring || state === S.held) && !this.openFailure(record.name),
      T.expectedEmptyMs, sample, last, "resolved");

    // Failure episodes resolve on verified presented frames, or end at a confirmed gap.
    const failure = this.openFailure(record.name);
    if (failure) {
      if (camera.recovery) this.recovery(record.name, camera.recovery);
      if (state === S.verified) {
        this.closeIncident(failure, failure.superseded ? "superseded" : "recovered", nowMs, sample.wallMs);
      } else if (coverage === C.gap && camera.lifecycle !== "participating") {
        this.closeIncident(failure, "ended_by_gap", nowMs, sample.wallMs);
      }
    }

    // Alignment: media position mapped to recording time against the ReviewClock.
    let drift = null;
    if (!unobserved && camera.lifecycle === "participating" && !camera.transition && !camera.held &&
        bbFinite(camera.mediaEpoch) && bbFinite(sample.epoch) &&
        (state === S.verified || state === S.media_only || state === S.frozen || state === S.paused)) {
      drift = camera.mediaEpoch - sample.epoch;
      record.driftHist[bucket(DRIFT_EDGES, Math.abs(drift))] += dtMs;
      record.maxDrift = Math.max(record.maxDrift, Math.abs(drift));
      if (state === S.verified && bbFinite(camera.frameEpoch)) {
        record.lagHist[bucket(DRIFT_EDGES, Math.abs(sample.epoch - camera.frameEpoch))] += dtMs;
      }
      const tolerance = T.divergenceBaseSeconds + T.divergencePerRateSeconds * sample.rate;
      this.stretch(record, "divergeSinceMs", "clock_media_divergence",
        sample.running && Math.abs(drift) > tolerance, T.divergenceSustainMs, sample, last, "resolved");
    } else {
      this.stretch(record, "divergeSinceMs", "clock_media_divergence", false, 0, sample, last, "ended");
    }

    record.prev = { nowMs, frames: camera.frames, key, media: camera.mediaEpoch,
      lifecycle: camera.lifecycle, held: camera.held === true, state };
    record.final = { lifecycle: camera.lifecycle, reason: camera.reason, coverage: BLACKBOARD_COVERAGE[coverage],
      held: camera.held === true, state: BLACKBOARD_STATES[state] };
    return drift;
  }

  stretch(record, field, type, active, thresholdMs, sample, last, outcome) {
    const key = `${type}|${record.name}`;
    if (active) {
      record[field] ??= last.nowMs;
      if (sample.nowMs - record[field] >= thresholdMs && !this.session.incidents.open.has(key)) {
        this.openIncident(type, record.name, { nowMs: record[field],
          wallMs: sample.wallMs - (sample.nowMs - record[field]), epoch: sample.epoch });
      }
      return;
    }
    record[field] = null;
    const open = this.session.incidents.open.get(key);
    if (open) this.closeIncident(open, outcome, sample.nowMs, sample.wallMs);
  }

  // ---- Assessment ----

  // Accounting for one camera. Expected = recording exists at Review time AND the clock ran.
  cameraAccounting(record) {
    const states = BLACKBOARD_STATES.length;
    const row = (clock, coverage) => Array.from({ length: states },
      (_, index) => record.matrix[CELL(clock, coverage, index)]);
    const total = values => values.reduce((sum, value) => sum + value, 0);
    const expected = row(K.running, C.recorded);
    const stopped = row(K.stopped, C.recorded);
    const expectedMs = total(expected);
    const unobservedMs = expected[S.unobserved];
    const observedMs = expectedMs - unobservedMs;
    const steadyMs = expected[S.verified] + expected[S.media_only] + expected[S.frozen] + expected[S.empty];
    const transitionMs = expected[S.acquiring] + expected[S.held];
    const coverageMs = coverage => total(row(K.running, coverage)) + total(row(K.stopped, coverage));
    return { expected, stopped, expectedMs, unobservedMs, observedMs, steadyMs, transitionMs,
      stoppedTransitionMs: stopped[S.acquiring] + stopped[S.held], stoppedMs: total(stopped),
      recordedMs: coverageMs(C.recorded), gapMs: coverageMs(C.gap), unknownMs: coverageMs(C.unknown),
      conservedMs: total(Array.from(record.matrix)) };
  }

  cameraAssessment(record) {
    const account = this.cameraAccounting(record);
    const { expected, expectedMs, observedMs, steadyMs, transitionMs } = account;
    const deficitMs = expected[S.frozen] + expected[S.empty] + transitionMs;
    const incidents = this.session.incidents;
    const openProblems = [...incidents.open.values()].filter(item => item.camera === record.name &&
      item.severity === "problem");
    const problemCount = Object.entries(record.incidentCounts)
      .filter(([type]) => INCIDENTS[type] === "problem").reduce((sum, [, count]) => sum + count, 0);
    const reasons = [];
    let verdict;
    if (openProblems.length || record.recovery.persistent || record.recovery.exhausted) {
      verdict = "PROBLEM DETECTED (unresolved)";
      if (openProblems.length) reasons.push(`${openProblems.length} open problem incident(s): ` +
        openProblems.map(item => item.type + (item.trigger ? `/${item.trigger}` : "")).join(", "));
      if (record.recovery.exhausted) reasons.push(`recovery budget exhausted ${record.recovery.exhausted}x`);
      if (record.recovery.persistent) reasons.push(`${record.recovery.persistent} failure(s) never recovered`);
    } else if (problemCount > 0 || (observedMs > 0 && deficitMs / observedMs > T.problemShare)) {
      verdict = "PROBLEM DETECTED (recovered)";
      if (problemCount) reasons.push(`${problemCount} problem incident(s), all resolved`);
      if (observedMs > 0 && deficitMs / observedMs > T.problemShare) {
        reasons.push(`not presenting ${pct(deficitMs, observedMs)} of observed expected time (frozen ` +
          `${pct(expected[S.frozen], observedMs)}, empty ${pct(expected[S.empty], observedMs)}, acquiring ` +
          `${pct(expected[S.acquiring], observedMs)}, held ${pct(expected[S.held], observedMs)})`);
      }
    } else if (expectedMs <= 0) {
      verdict = "INCONCLUSIVE";
      reasons.push("no recorded time was traversed while the clock ran");
    } else if (observedMs / expectedMs < T.observedShareHealthy) {
      verdict = "INCONCLUSIVE";
      reasons.push(`only ${pct(observedMs, expectedMs)} of expected time was observable`);
    } else if (steadyMs > 0 && expected[S.media_only] / steadyMs > T.mediaOnlyShare) {
      verdict = "INCONCLUSIVE";
      reasons.push(`presented-frame evidence missing for ${pct(expected[S.media_only], steadyMs)} of steady expected playback`);
    } else if (steadyMs <= 0) {
      verdict = "INCONCLUSIVE";
      reasons.push("no steady playback was observed while the clock ran (only transitions or held frames)");
    } else {
      verdict = "HEALTHY";
      reasons.push(`verified ${pct(expected[S.verified], steadyMs)} of steady expected playback; acquiring or ` +
        `held ${pct(transitionMs, observedMs)} of observed expected time`);
    }
    const warnings = Object.entries(record.incidentCounts)
      .filter(([type, count]) => INCIDENTS[type] !== "problem" && count);
    const events = this.cameraEvents(record);
    const eventVerdict = events.missing > 0 ? "PROBLEM DETECTED (R-09 short events)"
      : events.expected > 0 ? "HEALTHY" : "NOT APPLICABLE";
    return { verdict: this.combinedVerdict(verdict, eventVerdict), steadyVerdict: verdict, eventVerdict,
      events, reasons, warnings, ...account };
  }

  cameraEvents(record) {
    const counts = Object.fromEntries(BLACKBOARD_EVENT_CLASSES.map(name => [name, 0]));
    for (let index = 0; index < record.events.length; index += 1) {
      counts[BLACKBOARD_EVENT_CLASSES[index % BLACKBOARD_EVENT_CLASSES.length]] += record.events[index];
    }
    const missing = counts.flash + counts.landed_only + counts.nothing;
    return { counts, missing, expected: counts.played + missing };
  }

  // A camera headline reflects both dimensions; neither hides the other.
  combinedVerdict(steady, events) {
    const rank = verdict => verdict.startsWith("PROBLEM DETECTED (unresolved)") ? 4
      : verdict.startsWith("PROBLEM") ? 3 : verdict === "INCONCLUSIVE" ? 2 : verdict === "HEALTHY" ? 1 : 0;
    if (rank(steady) === 3 && rank(events) === 3) return "PROBLEM DETECTED (recovered; R-09 short events)";
    return rank(events) > rank(steady) ? events : steady;
  }

  shortEventAssessment() {
    const counts = Object.fromEntries(BLACKBOARD_EVENT_CLASSES.map(name => [name, 0]));
    for (const record of this.session.cameras.values()) {
      for (let index = 0; index < record.events.length; index += 1) {
        counts[BLACKBOARD_EVENT_CLASSES[index % BLACKBOARD_EVENT_CLASSES.length]] += record.events[index];
      }
    }
    const expected = counts.played + counts.flash + counts.landed_only + counts.nothing;
    const missing = counts.flash + counts.landed_only + counts.nothing;
    const verdict = this.session.autoSnap.intervals === 0 ? "NOT APPLICABLE"
      : missing > 0 ? "PROBLEM DETECTED (R-09 short events)"
        : expected === 0 ? "INCONCLUSIVE" : "HEALTHY";
    return { verdict, counts, expected, missing };
  }

  progressionAssessment() {
    const session = this.session;
    const types = session.incidents.byType;
    const stuck = types.progression_stuck?.count ?? 0;
    const open = session.incidents.open.has("progression_stuck|-");
    const discontinuities = types.clock_discontinuity?.count ?? 0;
    const running = session.clock.runningMs;
    const observed = session.observation.observedRunningMs;
    if (open) return { verdict: "PROBLEM DETECTED (unresolved)", reason: "Play intent with a stopped clock now" };
    if (stuck || discontinuities) {
      return { verdict: "PROBLEM DETECTED (recovered)",
        reason: `${stuck} stuck episode(s), ${discontinuities} unexplained clock discontinuity(ies)` };
    }
    if (running <= 0) return { verdict: "INCONCLUSIVE", reason: "the clock never ran" };
    if (observed / running < T.observedShareHealthy) {
      return { verdict: "INCONCLUSIVE", reason: `only ${pct(observed, running)} of running time was observed` };
    }
    return { verdict: "HEALTHY", reason: `clock progressed as expected; ${pct(observed, running)} observed` };
  }

  status() {
    const session = this.session;
    if (!session) return "none";
    if (session.status === "ended") return `ended: ${session.endReason}`;
    if (session.incidents.open.has("progression_stuck|-")) return "stuck";
    if (session.completion === "reached_end") return "reached_end";
    if (session.autoSnapStop) return `auto_snap_stopped: ${session.autoSnapStop}`;
    if (session.last?.running) return "running";
    return session.intent === "paused" ? "paused" : "waiting";
  }

  completionText(nowMs) {
    const session = this.session;
    const stop = session.autoSnapStop;
    if (stop) {
      const since = bbFinite(session.autoSnapStopSinceMs) && bbFinite(nowMs)
        ? `; stopped since then ${fmt(nowMs - session.autoSnapStopSinceMs)}` : "";
      return `${STOP_DESCRIPTIONS[stop] ?? `Auto Snap stopped (${stop})`}. This is event traversal, ` +
        `not continuous review of recording through the range end${since}.`;
    }
    if (session.completion === "reached_end") return "Review time reached the investigation range end.";
    return null;
  }

  summaryLine(session) {
    const previous = this.session;
    this.session = session;
    try {
      const verdicts = [...session.cameras.values()].map(record =>
        `${record.name}=${this.cameraAssessment(record).verdict}`);
      return `#${session.id} ${session.status === "ended" ? `ended (${session.endReason})` : session.status}; ` +
        `ran ${fmt(session.clock.runningMs)}; incidents ${session.incidents.total}; ${verdicts.join("; ")}`;
    } finally {
      this.session = previous;
    }
  }

  // Approximate retained bytes: typed arrays exactly, rings by their element counts.
  retainedBytes() {
    const session = this.session;
    if (!session) return 0;
    let bytes = session.bins.visited.byteLength + session.bins.unobserved.byteLength + 2048;
    for (const record of session.cameras.values()) {
      bytes += record.matrix.byteLength + record.bins.byteLength + record.driftHist.byteLength * 4 +
        record.events.byteLength + record.recovery.ttrHist.byteLength + 1024;
    }
    const incidents = session.incidents;
    bytes += (incidents.first.length + incidents.recent.length + incidents.worst.length +
      incidents.open.size) * 320;
    bytes += (session.autoSnap.examples.first.length + session.autoSnap.examples.recent.length +
      session.autoSnap.pendingExit.length) * 256;
    bytes += (session.navigation.recent.length + session.observation.gaps.length +
      session.changes.length) * 160;
    bytes += Object.keys(session.navigation.bySource).length * 200;
    return bytes;
  }

  // ---- Report ----

  report({ build = "unknown", wallMs = Date.now(), nowMs = null, formatEpoch = null,
    timeZone = null } = {}) {
    const session = this.session;
    const epochText = epoch => {
      if (!bbFinite(epoch)) return "--";
      let local = null;
      try { local = formatEpoch ? formatEpoch(epoch) : null; } catch {}
      return `${local ?? new Date(epoch * 1000).toISOString()} [${Math.round(epoch)}]`;
    };
    const wallText = ms => bbFinite(ms) ? new Date(ms).toISOString() : "--";
    const essential = [];
    const detail = [];
    const out = (lines, text = "") => lines.push(text);
    const safeBuild = String(build).replace(/[^\w.:+-]/g, "").slice(0, 64) || "unknown";
    out(essential, `FrigateMax Review Blackboard report v${BLACKBOARD_VERSION}`);
    out(essential, `Build: ${safeBuild} | Generated: ${wallText(wallMs)}${timeZone ?
      ` | Time zone: ${String(timeZone).replace(/[^\w/+-]/g, "").slice(0, 40)}` : ""}`);
    out(essential, "How to read: times are recording time (absolute epoch in brackets) unless marked wall.");
    out(essential, "  verified = presented-frame callbacks confirmed new frames; media_only = media position moved,");
    out(essential, "  no frame evidence; frozen = neither moved while expected; held = a retained historical frame");
    out(essential, "  was shown; empty = no presentation and no held frame (state, not pixel analysis);");
    out(essential, "  unobserved = tab hidden or heartbeat late (browser throttled or suspended): never judged.");
    out(essential, "  Expected = recording exists at Review time AND the clock runs (both heartbeats of an");
    out(essential, "  interval). Steady expected playback = verified + media_only + frozen + empty within Expected;");
    out(essential, "  acquiring and held within Expected count as not presenting. Clock-stopped navigation");
    out(essential, "  transitions (acquiring or held while the clock is stopped) are reported separately.");
    out(essential, "  Gap = coverage proves no recording; unknown = coverage not established (never a gap or failure).");
    out(essential, `  Thresholds (provisional): freeze ${T.freezeMs / 1000}s; divergence ${T.divergenceBaseSeconds}s+` +
      `${T.divergencePerRateSeconds}s x rate for ${T.divergenceSustainMs / 1000}s; stuck ${T.stuckMs / 1000}s;` +
      ` expected-but-empty ${T.expectedEmptyMs / 1000}s; late heartbeat ${T.heartbeatGapMs / 1000}s.`);
    if (!session) {
      out(essential, "");
      out(essential, "No Review investigation has run since this page loaded. Evidence before a page load or");
      out(essential, "card teardown is never retained.");
      return essential.join("\n");
    }
    const elapsedMs = (session.endedMs ?? (bbFinite(nowMs) ? nowMs : session.last?.nowMs ?? session.startedMs)) -
      session.startedMs;
    const status = this.status();
    out(essential, `Session #${session.id} | Status: ${status.toUpperCase()}${session.status === "ended" ? "" :
      " (copied while the session is open)"} | Started: ${wallText(session.startedWall)} | Elapsed wall: ${fmt(elapsedMs)}`);
    const completion = this.completionText(session.endedMs ?? (bbFinite(nowMs) ? nowMs : session.last?.nowMs));
    if (completion) out(essential, `Completion: ${completion}`);
    if (this.disabled || this.faults) {
      out(essential, `BLACKBOARD FAULTS: ${this.faults}${this.disabled ? " - collection DISABLED; later evidence missing" : ""}`);
    }

    // Verdict.
    const assessments = [...session.cameras.values()].map(record => [record, this.cameraAssessment(record)]);
    const progression = this.progressionAssessment();
    const shortEvents = this.shortEventAssessment();
    const rank = verdict => verdict.startsWith("PROBLEM DETECTED (unresolved)") ? 4
      : verdict.startsWith("PROBLEM") ? 3 : verdict === "INCONCLUSIVE" ? 2 : verdict === "HEALTHY" ? 1 : 0;
    const components = [progression.verdict, shortEvents.verdict, ...assessments.map(([, a]) => a.verdict),
      this.disabled ? "INCONCLUSIVE" : "HEALTHY"];
    const worst = components.reduce((best, verdict) => rank(verdict) > rank(best) ? verdict : best, "HEALTHY");
    out(essential, "");
    out(essential, "== VERDICT ==");
    out(essential, `Session: ${worst}`);
    out(essential, `- Progression: ${progression.verdict} - ${progression.reason}`);
    for (const [record, assessment] of assessments) {
      out(essential, `- ${record.name}: ${assessment.verdict}`);
      out(essential, `    Steady playback: ${assessment.steadyVerdict} - ${assessment.reasons.join("; ")}` +
        (assessment.warnings.length ? `; warnings: ${assessment.warnings.map(([type, count]) =>
          `${type} x${count}`).join(", ")}` : ""));
      const events = assessment.events;
      out(essential, `    Short events: ${events.expected ? `${events.missing}/${events.expected} below visible-playback ` +
        `criterion (flash ${events.counts.flash}, landed_only ${events.counts.landed_only}, nothing ` +
        `${events.counts.nothing})` : "no expected Auto Snap events"}`);
    }
    out(essential, `- Short events (Auto Snap): ${shortEvents.verdict}` + (session.autoSnap.intervals
      ? ` - ${shortEvents.missing} of ${shortEvents.expected} expected camera-events lacked visible playback` +
        ` (flash ${shortEvents.counts.flash}, landed_only ${shortEvents.counts.landed_only},` +
        ` nothing ${shortEvents.counts.nothing}); unobserved ${shortEvents.counts.unobserved}` : ""));
    const observation = session.observation;
    out(essential, `- Evidence quality: observed ${pct(observation.observedRunningMs, session.clock.runningMs)} ` +
      `of running time; hidden ${fmt(observation.hiddenMs)}; late heartbeats ${observation.lateTicks} ` +
      `(${fmt(observation.gapMs)}, longest ${fmt(observation.longestGapMs)}); presented-frame callbacks: ` +
      `${session.env.rvfc === null ? "unknown" : session.env.rvfc ? "supported" : "UNSUPPORTED"}`);

    // Investigation and progression.
    const clock = session.clock;
    const intended = session.intended;
    out(essential, "");
    out(essential, "== INVESTIGATION ==");
    out(essential, `Intended: ${intended.range ? `${epochText(intended.range.from)} -> ${epochText(intended.range.to)} ` +
      `(${fmtS(intended.range.to - intended.range.from)})` : "open range"} | start ${epochText(intended.startEpoch)}`);
    out(essential, `Cameras: ${intended.cameras.join(", ") || "none"} | Auto Snap ${intended.autoSnap ? "on" : "off"}` +
      ` | Skip Deadspace ${intended.skipDeadspace ? "on" : "off"} | rate at start ${intended.rate ?? "--"}x`);
    out(essential, `Visited: ${epochText(clock.minEpoch)} -> ${epochText(clock.maxEpoch)}; last ${epochText(clock.lastEpoch)}` +
      `${intended.range ? `; intended end ${epochText(intended.range.to)}` : ""}`);
    out(essential, `Review time traversed continuously: ${fmtS(clock.continuousS)} observed + ${fmtS(clock.unobservedS)}` +
      ` unobserved${intended.range ? ` (${pct(clock.continuousS + clock.unobservedS,
        intended.range.to - intended.range.from)} of the range)` : ""}. ReviewClock motion only: not proof that` +
      " recording was reviewed or presented.");
    const jumps = Object.entries(clock.jumps).filter(([, value]) => value.count)
      .map(([source, value]) => `${source} ${value.count} (${fmtS(value.seconds)} forward)`);
    out(essential, `Intentional jumps (not traversed): ${jumps.join("; ") || "none"}`);
    if (intended.range) {
      out(essential, `Outside visited time: before first visit ${fmtS(Math.max(0, clock.minEpoch - intended.range.from))},` +
        ` after last visit ${fmtS(Math.max(0, intended.range.to - clock.maxEpoch))} (jumps and revisits overlap;` +
        " these figures are not additive)");
    }
    out(essential, `Skip Deadspace: ${session.skip.count} skips, ${fmtS(session.skip.seconds)} skipped` +
      ` (largest ${fmtS(session.skip.max)})`);
    out(essential, `Unexplained clock discontinuities: ${clock.discontinuities}` +
      (clock.discontinuities ? ` (${fmtS(clock.discontinuityS)})` : ""));
    out(essential, `Clock running ${fmt(clock.runningMs)}; paused: ` + Object.entries(clock.pausedMs)
      .map(([cause, ms]) => `${cause} ${fmt(ms)}`).join(", "));
    out(essential, `Time at rate: ${Object.entries(clock.rateMs).map(([rate, ms]) => `${rate}x ${fmt(ms)}`).join(", ") || "--"}`);
    out(essential, `Auto Snap: ${session.autoSnap.intervals} intervals completed, ${session.autoSnap.interrupted} interrupted;` +
      ` stops: ${Object.entries(session.autoSnap.stops).map(([key, count]) => `${key} ${count}`).join(", ") || "none"}`);

    // Cameras.
    out(essential, "");
    out(essential, "== CAMERAS ==");
    for (const [record, assessment] of assessments) {
      const expected = assessment.expected;
      const expectedMs = assessment.expectedMs;
      const observed = assessment.observedMs;
      out(essential, `${record.name}: ${assessment.verdict}`);
      out(essential, `  Expected (recording + clock running) ${fmt(expectedMs)} wall; observable ` +
        `${pct(observed, expectedMs)}; unobserved ${fmt(assessment.unobservedMs)}`);
      out(essential, `  Steady expected playback ${fmt(assessment.steadyMs)}: ` +
        ["verified", "media_only", "frozen", "empty"].map(name =>
          `${name} ${pct(expected[S[name]], assessment.steadyMs)}`).join(", "));
      out(essential, `  Not presenting while expected: acquiring ${pct(expected[S.acquiring], observed)}, held ` +
        `${pct(expected[S.held], observed)} of observed expected time`);
      const stopped = assessment.stopped;
      out(essential, `  Clock stopped with recording at Review time ${fmt(assessment.stoppedMs)}: navigation transitions` +
        ` ${fmt(assessment.stoppedTransitionMs)} (acquiring ${fmt(stopped[S.acquiring])}, held ${fmt(stopped[S.held])}),` +
        ` paused ${fmt(stopped[S.paused])}, other ${fmt(assessment.stoppedMs - assessment.stoppedTransitionMs -
          stopped[S.paused])}`);
      out(essential, `  Coverage at Review time (wall, clock running or stopped): recorded ${fmt(assessment.recordedMs)},` +
        ` confirmed gap ${fmt(assessment.gapMs)}, unknown ${fmt(assessment.unknownMs)}; gap leaves ${record.gapLeaves}`);
      const binsTotal = field => {
        let sum = 0;
        for (let index = 0; index < session.bins.count; index += 1) sum += record.bins[index * BIN_FIELDS + field];
        return sum;
      };
      out(essential, `  Recording time traversed (approximate, heartbeat-attributed): with recording ` +
        `${fmtS(binsTotal(BIN.rec))} (verified ${fmtS(binsTotal(BIN.ver))}), gap ${fmtS(binsTotal(BIN.gap))}, ` +
        `unknown ${fmtS(binsTotal(BIN.unk))}, unobserved ${fmtS(binsTotal(BIN.uno))}`);
      const acquisitions = record.acquisitions;
      out(essential, `  Acquisitions: ${acquisitions.attempted} (` + ACQUISITION_TRIGGERS
        .map(trigger => `${trigger} ${acquisitions.byTrigger[trigger]}`).join(", ") + `); landed ${acquisitions.landed}` +
        ` (verified frame ${acquisitions.verified}, unverified ${acquisitions.unverified}), failed ${acquisitions.failed},` +
        ` abandoned ${acquisitions.abandoned}; longest ${fmt(acquisitions.longestMs)}; plays ${acquisitions.plays}`);
      if (acquisitions.abandoned) {
        const linked = Object.entries(acquisitions.abandonedLinked);
        const linkedTotal = linked.reduce((sum, [, count]) => sum + count, 0);
        out(essential, `  Abandoned by reason: ${Object.entries(acquisitions.abandonedByReason).map(([reason, count]) =>
          `${reason} ${count}`).join(", ")}; started within an Auto Snap interval and linked to it ${linkedTotal}` +
          `${linked.length ? ` (${linked.map(([cls, count]) => `${cls} ${count}`).join(", ")})` : ""}`);
      }
      out(essential, `  Landing time: ${this.histText(record.landingHist, LATENCY_EDGES_MS, "ms")}`);
      const failures = Object.entries(record.failures).map(([reason, count]) => `${reason} ${count}`).join(", ");
      out(essential, `  Failures: ${failures || "none"} | fatal media ${record.fatalMedia}, stalls ${record.stalls}`);
      const recovery = record.recovery;
      out(essential, `  Recovery: ${recovery.episodes} episode(s): recovered ${recovery.recovered}, superseded ` +
        `${recovery.superseded}, ended by gap ${recovery.endedByGap}, persistent ${recovery.persistent}, budget ` +
        `exhausted ${recovery.exhausted}; max attempts ${recovery.maxAttempts}; longest to recover ${fmt(recovery.maxTtrMs)}`);
      out(essential, `  |media - clock|: ${this.histText(record.driftHist, DRIFT_EDGES, "s", true)}; max ${record.maxDrift.toFixed(2)}s`);
      out(essential, `  |clock - latest frame|: ${this.histText(record.lagHist, DRIFT_EDGES, "s", true)}`);
      out(essential, `  Held frames shown ${record.held}x; final: ${record.final ? `${record.final.lifecycle}` +
        ` (${String(record.final.reason ?? "-").replace(/[^\w]/g, "").slice(0, 48)}), coverage ${record.final.coverage},` +
        ` state ${record.final.state}` : "not sampled"}`);
    }
    if (session.spreadHist.some(value => value)) {
      out(essential, `Inter-camera spread: ${this.histText(session.spreadHist, DRIFT_EDGES, "s", true)}`);
    }

    // Short events.
    out(essential, "");
    out(essential, "== SHORT EVENTS (per camera, by event duration) ==");
    if (!session.autoSnap.intervals) out(essential, "No Auto Snap intervals completed.");
    else {
      out(essential, `classes: ${BLACKBOARD_EVENT_CLASSES.join(" / ")} (played = >=${T.playedMinFrames} frames spanning` +
        ` >=min(${T.playedMinSpanSeconds}s, half the event))`);
      for (const record of session.cameras.values()) {
        const rows = EVENT_DURATION_LABELS.map((label, durationIndex) => {
          const values = BLACKBOARD_EVENT_CLASSES.map((_, cls) =>
            record.events[durationIndex * BLACKBOARD_EVENT_CLASSES.length + cls]);
          return values.some(Boolean) ? `${label} ${values.join("/")}` : null;
        }).filter(Boolean);
        out(essential, `${record.name}: ${rows.join(" | ") || "none"}`);
      }
      out(essential, `Dead time between intervals: ${this.histText(session.autoSnap.deadTimeHist, LATENCY_EDGES_MS, "ms")}`);
    }

    // Incidents summary.
    out(essential, "");
    out(essential, "== INCIDENTS ==");
    const types = Object.entries(session.incidents.byType);
    if (!types.length) out(essential, "None recorded.");
    for (const [type, stats] of types) {
      out(essential, `${type} [${INCIDENTS[type] ?? "warning"}]: ${stats.count}x, total ${fmt(stats.totalMs)}, worst ` +
        `${fmt(stats.maxMs)}, recovered/resolved ${stats.recovered}, superseded ${stats.superseded}, unresolved ` +
        `${stats.unresolved}; first ${wallText(stats.firstWall)} @ ${epochText(stats.firstEpoch)}; last ` +
        `${wallText(stats.lastWall)} @ ${epochText(stats.lastEpoch)}`);
    }
    const open = [...session.incidents.open.values()];
    if (open.length) {
      out(essential, "Open now:");
      for (const incident of open) out(essential, `  ${this.incidentText(incident, epochText, wallText, nowMs)}`);
    }

    // Details, in priority order, while within budget.
    const section = (title, lines) => {
      if (!lines.length) return;
      detail.push("", `== ${title} ==`, ...lines);
    };
    section("WORST INCIDENTS", session.incidents.worst.map(item => this.incidentText(item, epochText, wallText)));
    section("HEALTH STRIPS (one character per time bin of recording time)", this.strips(epochText));
    const examples = session.autoSnap.examples;
    section("PROBLEMATIC SHORT EVENTS", [...examples.first, ...examples.recent].map(item =>
      `${item.camera} @ ${epochText(item.start)} (${item.duration.toFixed(2)}s): ${item.cls}; frames ${item.frames},` +
      ` span ${item.span.toFixed(2)}s, landing ${item.landed ? "verified" : "none"}, acquisition ` +
      `${item.acquisition ? "yes" : "no"}${item.abandoned ? ` (abandoned: ${item.abandoned})` : ""}, exit ` +
      `${item.exit ?? "pending"}, next reached ${item.nextReached ? "yes" : "no"}`)
      .concat(examples.dropped ? [`[${examples.dropped} more omitted; counts above are complete]`] : []));
    section("NAVIGATION (outcomes: settled_observed = a heartbeat saw it settled; settled_unsampled = settled" +
      " between heartbeats; unsettled_replaced = still unsettled when the next request began)",
    Object.entries(session.navigation.bySource).map(([source, value]) =>
      `${source}: requested ${value.requested}; ` + BLACKBOARD_NAVIGATION_OUTCOMES
        .map(outcome => `${outcome} ${value.outcomes[outcome]}`).join(", ") +
      `; every acquisition landed ${value.landed} (not ${value.notLanded}, none begun ${value.noAcquisition});` +
      ` landing ${this.histText(value.landingHist, LATENCY_EDGES_MS, "ms")} (lifecycle timestamps); first` +
      ` presented advance ${value.presented} (not observed ${value.notPresented}, not sampled ${value.frameNotSampled}):` +
      ` observer-timed ${value.presentedExact} ${this.histText(value.frameHist, LATENCY_EDGES_MS, "ms")}; heartbeat` +
      ` upper bound ${value.presented - value.presentedExact} ${this.histText(value.frameBoundHist, LATENCY_EDGES_MS, "ms")}`));
    section("RECENT NAVIGATION", session.navigation.recent.slice().reverse().map(item =>
      `${wallText(item.atWall)} ${item.source} ${epochText(item.from)} -> ${epochText(item.target)}: ${item.outcome};` +
      ` acquisitions ${item.landedCount}/${item.acquisitions} landed${item.unfinished ? `, ${item.unfinished} unfinished` : ""};` +
      ` landing ${item.landingMs === null ? "--" : fmt(item.landingMs)}, first frame ` +
      `${item.frameMs === null ? (item.sampled ? "not observed" : "not sampled")
        : item.frameExact ? fmt(item.frameMs) : `<=${fmt(item.frameMs)} (heartbeat)`}`));
    section("FIRST INCIDENTS", session.incidents.first.map(item => this.incidentText(item, epochText, wallText)));
    section("RECENT INCIDENTS", session.incidents.recent.slice().reverse().map(item =>
      this.incidentText(item, epochText, wallText)).concat(session.incidents.dropped
      ? [`[${session.incidents.dropped} older incident details omitted; counts above are complete]`] : []));
    section("OBSERVATION GAPS", observation.gaps.map(item => `${wallText(item.atWall)} ${fmt(item.ms)}` +
      `${item.hidden ? " (tab hidden)" : ""}; Review time ${epochText(item.epochBefore)} -> ${epochText(item.epochAfter)}`)
      .concat(observation.droppedGaps ? [`[${observation.droppedGaps} earlier gaps omitted]`] : []));
    section("CHANGES", session.changes.map(item => `${wallText(item.atWall)} ${item.kind}` +
      `${item.value === null ? "" : ` ${item.value}`}`));
    section("LIMITATIONS", [
      "Frames are browser presented-frame callbacks, not pixel analysis; a frame can be presented while the tab",
      "is visible yet the cell is off screen or covered. Hidden or throttled time is unobserved, never a failure.",
      "Very short events (for example 1s at 8x = 125ms wall) may not allow more than a landing frame.",
      "A page reload or card teardown discards the Blackboard; this report covers only this page's session(s).",
      `Blackboard faults: ${this.faults}${this.firstFault ? ` (first ${this.firstFault.where}/${this.firstFault.name})` : ""}` +
        `; retained state about ${Math.round(this.retainedBytes() / 1024)} KB`
    ]);
    if (this.previous) section("PREVIOUS SESSION", [this.previous]);

    let text = essential.join("\n");
    for (const line of detail) {
      if (text.length + line.length + 1 > REPORT_TARGET_BYTES) {
        text += "\n[report detail truncated at the size target; summary counts above are complete]";
        break;
      }
      text += `\n${line}`;
    }
    if (text.length > REPORT_CAP_BYTES) {
      text = `${text.slice(0, REPORT_CAP_BYTES - 64)}\n[report truncated at the hard cap]`;
    }
    return text;
  }

  histText(hist, edges, unit, timeWeighted = false) {
    const total = hist.reduce((sum, value) => sum + value, 0);
    if (!total) return "no samples";
    const label = index => index < edges.length
      ? `<${unit === "ms" ? fmt(edges[index]) : `${edges[index]}s`}`
      : `>=${unit === "ms" ? fmt(edges.at(-1)) : `${edges.at(-1)}s`}`;
    return Array.from(hist).map((value, index) => value
      ? `${label(index)} ${timeWeighted ? pct(value, total) : value}` : null).filter(Boolean).join(", ");
  }

  incidentText(item, epochText, wallText, nowMs = null) {
    const duration = item.durationMs ?? (bbFinite(nowMs) && bbFinite(item.startMs) ? nowMs - item.startMs : null);
    return `#${item.seq} ${item.type}${item.camera ? ` ${item.camera}` : ""}: ${item.outcome}` +
      `${item.trigger ? `; trigger ${item.trigger}` : ""}${item.lastReason && item.lastReason !== item.trigger
        ? `; last ${item.lastReason}` : ""}${item.failures > 1 ? `; ${item.failures} failures` : ""}` +
      `${item.attempts ? `; attempts ${item.attempts}` : ""}${item.exhausted ? "; BUDGET EXHAUSTED" : ""}` +
      `${item.superseded ? "; superseded by navigation" : ""}; started ${wallText(item.startWall)} @ ` +
      `${epochText(item.startEpoch)}; duration ${fmt(duration)}${item.outcome === "open" ? " (still open)" : ""}`;
  }

  strips(epochText) {
    const session = this.session;
    const bins = session.bins;
    const lines = ["legend: . verified  o mostly transitions/held  ~ frames unconfirmed  x frozen/empty",
      "        ! problem began  g confirmed gap  u unknown coverage  ? unobserved  - not traversed"];
    const perLine = Math.max(1, Math.round(86400 / bins.width));
    for (const record of session.cameras.values()) {
      let line = "";
      let lineStart = 0;
      for (let index = 0; index < bins.count; index += 1) {
        if (index % perLine === 0) {
          if (line) lines.push(`${record.name.padEnd(14).slice(0, 14)} ${epochText(bins.base + lineStart * bins.width)} |${line}|`);
          line = "";
          lineStart = index;
        }
        line += this.glyph(record, index);
      }
      if (line && /[^-]/.test(line)) {
        lines.push(`${record.name.padEnd(14).slice(0, 14)} ${epochText(bins.base + lineStart * bins.width)} |${line}|`);
      }
    }
    // Drop untraversed lines entirely.
    return lines.filter((line, index) => index < 2 || /\|[^|]*[^-|][^|]*\|$/.test(line));
  }

  glyph(record, index) {
    const session = this.session;
    const offset = index * BIN_FIELDS;
    const value = field => record.bins[offset + field];
    const visited = session.bins.visited[index];
    const unobserved = session.bins.unobserved[index];
    if (visited + unobserved <= 0) return "-";
    if (value(BIN.inc) > 0) return "!";
    if (unobserved > 0.5 * (visited + unobserved)) return "?";
    const recorded = value(BIN.rec);
    if (recorded < 0.5 * visited) return value(BIN.gap) >= value(BIN.unk) ? "g" : "u";
    if (value(BIN.ver) >= 0.9 * recorded) return ".";
    if (value(BIN.mo) >= 0.5 * recorded) return "~";
    if (value(BIN.bad) > 0.1 * recorded) return "x";
    return "o";
  }
}
