import {
  epochToMedia,
  inspectHistoricalPresentationEndpoints,
  mediaToEpoch,
  validateHistoricalPresentation
} from "../review/historical-presentation.js?v=__LAB_BUILD__";

export const INVESTIGATION_TRANSPORT_STEP_SECONDS = 10;
export const INVESTIGATION_PLAYBACK_RATES = Object.freeze([0.25, 0.5, 0.75, 1, 2, 4, 8, 16]);

const AVAILABILITY_WINDOW_SECONDS = 2 * 60 * 60;
const AVAILABILITY_EDGE_REFRESH_SECONDS = 30;
const READINESS_TIMEOUT_MS = 15000;
const SEEK_TOLERANCE_SECONDS = 0.05;
const DIAGNOSTIC_OPERATION_LIMIT = 64;
const FRAME_OBSERVATION_LIMIT = 120;
const TRANSITION_TIMING_LIMIT = 32;
const LAB_PRESENTATION_WINDOW_SECONDS = 60;
const LAB_PRESENTATION_PREROLL_SECONDS = 15;
const SUCCESSOR_DEFAULT_LATENCY_MS = 2000;
const SUCCESSOR_SAFETY_SECONDS = 2;
const SUCCESSOR_MIN_LEAD_SECONDS = 6;
const TIME_MAP_QUANTIZATION_SECONDS = 1 / 1_000_000;
const HLS_SCRIPT_PATH = "/local/nvr-card/src/vendor/hls.min.js";
const HLS_PROMISE = Symbol.for("nvr.investigationLab.hlsScript");

function finite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be finite.`);
  return number;
}

function nowEpochMs(now) {
  return Number(now());
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function safeError(error) {
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim()
    : "Investigation playback failed.";
  if (/authSig\s*=|bearer\s+|https?:\/\/|rtsp:\/\/|[A-Z]:\\|\/media\//i.test(message)) {
    return "Investigation playback failed; details were redacted.";
  }
  return message.slice(0, 240);
}

function presentationMapDiagnostic(value, outcome) {
  const endpoints = inspectHistoricalPresentationEndpoints(value);
  return Object.freeze({
    outcome,
    selectedEpoch: Number.isFinite(Number(value?.selected_epoch)) ? Number(value.selected_epoch) : null,
    resolvedSelectedEpoch: Number.isFinite(Number(value?.resolved_selected_epoch))
      ? Number(value.resolved_selected_epoch) : null,
    requestedWallStart: Number.isFinite(Number(value?.requested_wall_start))
      ? Number(value.requested_wall_start) : null,
    requestedWallEnd: Number.isFinite(Number(value?.requested_wall_end))
      ? Number(value.requested_wall_end) : null,
    effectiveWallStart: Number.isFinite(Number(value?.effective_wall_start))
      ? Number(value.effective_wall_start) : null,
    logicalWallStart: Number.isFinite(Number(value?.logical_wall_start))
      ? Number(value.logical_wall_start) : null,
    logicalWallEnd: Number.isFinite(Number(value?.logical_wall_end))
      ? Number(value.logical_wall_end) : null,
    coverageKnownStart: Number.isFinite(Number(value?.coverage_run?.known_start))
      ? Number(value.coverage_run.known_start) : null,
    coverageKnownEnd: Number.isFinite(Number(value?.coverage_run?.known_end))
      ? Number(value.coverage_run.known_end) : null,
    physicalMediaExtent: null,
    ...endpoints
  });
}

export function parseInvestigationEpoch(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Enter an ISO timestamp or epoch seconds.");
  }
  const text = value.trim();
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text);
  if (local) {
    const [, year, month, day, hour, minute, second = "0", fraction = "0"] = local;
    const parts = [year, month, day, hour, minute, second].map(Number);
    const milliseconds = Number(fraction.padEnd(3, "0"));
    const date = new Date(0);
    date.setFullYear(parts[0], parts[1] - 1, parts[2]);
    date.setHours(parts[3], parts[4], parts[5], milliseconds);
    if (!Number.isFinite(date.getTime()) || date.getFullYear() !== parts[0] ||
        date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2] ||
        date.getHours() !== parts[3] || date.getMinutes() !== parts[4] ||
        date.getSeconds() !== parts[5] || date.getMilliseconds() !== milliseconds) {
      throw new Error("Invalid or nonexistent local investigation timestamp.");
    }
    return date.getTime() / 1000;
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error("Invalid investigation timestamp.");
  return parsed / 1000;
}

const localPart = value => String(value).padStart(2, "0");

export function formatInvestigationLocalCivil(epoch) {
  const date = new Date(finite(epoch, "Investigation epoch") * 1000);
  if (!Number.isFinite(date.getTime())) throw new Error("Investigation epoch must be finite.");
  return `${String(date.getFullYear()).padStart(4, "0")}-${localPart(date.getMonth() + 1)}-${localPart(date.getDate())}` +
    `T${localPart(date.getHours())}:${localPart(date.getMinutes())}:${localPart(date.getSeconds())}`;
}

export function describeInvestigationLocalTime(editorValue, epoch = null) {
  const absoluteEpoch = epoch === null ? parseInvestigationEpoch(editorValue) : finite(epoch, "Investigation epoch");
  const date = new Date(absoluteEpoch * 1000);
  let runtimeTimeZone = null;
  try { runtimeTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null; } catch {}
  return Object.freeze({
    localEditorValue: formatInvestigationLocalCivil(absoluteEpoch),
    absoluteEpoch,
    utcIso: date.toISOString(),
    runtimeTimeZone,
    utcOffsetMinutes: -date.getTimezoneOffset()
  });
}

export function buildLabAvailabilityWindow(targetEpoch) {
  const target = finite(targetEpoch, "Availability target");
  return Object.freeze({
    start: target - AVAILABILITY_WINDOW_SECONDS / 2,
    end: target + AVAILABILITY_WINDOW_SECONDS / 2
  });
}

export function successorPreparationLeadSeconds(playbackRate, latencyMs = SUCCESSOR_DEFAULT_LATENCY_MS) {
  const rate = finite(playbackRate, "Successor playback rate");
  const latencySeconds = Math.max(0, finite(latencyMs, "Successor latency") / 1000);
  return Math.max(
    SUCCESSOR_MIN_LEAD_SECONDS,
    rate * latencySeconds + SUCCESSOR_SAFETY_SECONDS
  );
}

export function normalizeLabAvailability(value, expectedCamera) {
  if (!value || typeof value !== "object" || value.camera !== expectedCamera ||
      !Number.isFinite(Number(value.requested_start)) ||
      !Number.isFinite(Number(value.requested_end)) ||
      !Array.isArray(value.coverage)) {
    throw new Error("FrigateMax returned invalid recording availability.");
  }
  const requestedStart = Number(value.requested_start);
  const requestedEnd = Number(value.requested_end);
  if (!(requestedStart < requestedEnd) ||
      requestedEnd - requestedStart > AVAILABILITY_WINDOW_SECONDS + 0.001) {
    throw new Error("FrigateMax returned invalid recording availability.");
  }
  const coverage = value.coverage.map(interval => {
    const start = Number(interval?.start);
    const end = Number(interval?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
        start < requestedStart || end > requestedEnd) {
      throw new Error("FrigateMax returned invalid recording availability.");
    }
    return Object.freeze({ start, end });
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
    coverage: Object.freeze(coverage)
  });
}

export function inspectLabAvailability(availability, epoch) {
  const target = Number(epoch);
  const insideWindow = Number.isFinite(target) &&
    target >= Number(availability?.requested_start) &&
    target < Number(availability?.requested_end);
  if (!insideWindow) {
    return Object.freeze({
      insideWindow: false, containing: null, previous: null, next: null
    });
  }
  let containing = null;
  let previous = null;
  let next = null;
  for (const interval of availability.coverage ?? []) {
    if (interval.start <= target && target < interval.end) {
      containing = interval;
      break;
    }
    if (interval.end <= target) previous = interval;
    else if (interval.start > target) {
      next = interval;
      break;
    }
  }
  if (containing) {
    const index = availability.coverage.indexOf(containing);
    previous = index > 0 ? availability.coverage[index - 1] : null;
    next = index + 1 < availability.coverage.length
      ? availability.coverage[index + 1]
      : null;
  }
  return Object.freeze({ insideWindow: true, containing, previous, next });
}

export function resolvePlayNavigation(availability, epoch) {
  const requestedEpoch = finite(epoch, "Play epoch");
  const inspected = inspectLabAvailability(availability, requestedEpoch);
  if (!inspected.insideWindow) {
    return Object.freeze({ requestedEpoch, resolvedEpoch: null, reason: "availability-unknown" });
  }
  if (inspected.containing) {
    return Object.freeze({
      requestedEpoch, resolvedEpoch: requestedEpoch, reason: "exact",
      coverage: inspected.containing
    });
  }
  if (inspected.next &&
      inspected.next.start <= requestedEpoch + INVESTIGATION_TRANSPORT_STEP_SECONDS) {
    return Object.freeze({
      requestedEpoch, resolvedEpoch: inspected.next.start,
      reason: "play-near-next-start", coverage: inspected.next
    });
  }
  return Object.freeze({
    requestedEpoch, resolvedEpoch: null, reason: "uncovered-no-near-entry",
    previous: inspected.previous, next: inspected.next
  });
}

export function resolveForwardNavigation(availability, epoch) {
  const from = finite(epoch, "Forward epoch");
  const requestedEpoch = from + INVESTIGATION_TRANSPORT_STEP_SECONDS;
  const crossed = (availability?.coverage ?? []).find(interval =>
    interval.start > from && interval.start <= requestedEpoch);
  if (crossed) {
    return Object.freeze({
      requestedEpoch, resolvedEpoch: crossed.start,
      reason: "forward-crossed-start", coverage: crossed
    });
  }
  const inspected = inspectLabAvailability(availability, requestedEpoch);
  return inspected.containing
    ? Object.freeze({
      requestedEpoch, resolvedEpoch: requestedEpoch,
      reason: "exact", coverage: inspected.containing
    })
    : Object.freeze({
      requestedEpoch, resolvedEpoch: null,
      reason: "uncovered-no-near-entry",
      previous: inspected.previous, next: inspected.next
    });
}

export function resolveBackwardNavigation(availability, epoch) {
  const from = finite(epoch, "Backward epoch");
  const requestedEpoch = from - INVESTIGATION_TRANSPORT_STEP_SECONDS;
  const crossed = [...(availability?.coverage ?? [])].reverse().find(interval =>
    interval.end > requestedEpoch && interval.end <= from);
  if (crossed) {
    return Object.freeze({
      requestedEpoch, resolvedEpoch: null,
      reason: "backward-crossed-end-unresolved",
      coverage: crossed,
      limitation: "The current contracts do not identify the last actually representable frame."
    });
  }
  const inspected = inspectLabAvailability(availability, requestedEpoch);
  return inspected.containing
    ? Object.freeze({
      requestedEpoch, resolvedEpoch: requestedEpoch,
      reason: "exact", coverage: inspected.containing
    })
    : Object.freeze({
      requestedEpoch, resolvedEpoch: null,
      reason: "uncovered-no-near-entry",
      previous: inspected.previous, next: inspected.next
    });
}

export function snapshotTimeRanges(ranges) {
  const output = [];
  const length = Number(ranges?.length) || 0;
  for (let index = 0; index < length; index += 1) {
    const start = Number(ranges.start(index));
    const end = Number(ranges.end(index));
    if (Number.isFinite(start) && Number.isFinite(end)) output.push([start, end]);
  }
  return output;
}

export function loadInvestigationHls(documentRef = globalThis.document) {
  if (globalThis.Hls) return Promise.resolve(globalThis.Hls);
  if (globalThis[HLS_PROMISE]) return globalThis[HLS_PROMISE];
  if (!documentRef?.head) return Promise.reject(new Error("A document is required to load hls.js."));
  const promise = new Promise((resolve, reject) => {
    const script = documentRef.createElement("script");
    script.src = HLS_SCRIPT_PATH;
    script.async = true;
    script.onload = () => globalThis.Hls
      ? resolve(globalThis.Hls)
      : reject(new Error("Vendored hls.js did not initialize."));
    script.onerror = () => reject(new Error("Unable to load vendored hls.js."));
    documentRef.head.appendChild(script);
  });
  globalThis[HLS_PROMISE] = promise;
  return promise;
}

function manifestPath(camera, presentation) {
  return `/api/frigate/vod/${encodeURIComponent(camera)}` +
    `/start/${presentation.requested_wall_start}/end/${presentation.requested_wall_end}/index.m3u8`;
}

export class InvestigationPlaybackEngine {
  constructor({
    camera,
    callWS,
    createVideo,
    loadHls = () => loadInvestigationHls(),
    captureHoldFrame = null,
    onSessionCreated = null,
    onSessionCommitted = null,
    onSessionDestroyed = null,
    onStateChange = null,
    ownerGeneration = null,
    getVisibilityState = () => globalThis.document?.visibilityState ?? null,
    now = () => performance.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer),
    readinessTimeoutMs = READINESS_TIMEOUT_MS,
    operationLimit = DIAGNOSTIC_OPERATION_LIMIT,
    frameObservationLimit = FRAME_OBSERVATION_LIMIT
  } = {}) {
    if (typeof camera !== "string" || !/^[A-Za-z0-9_-]+$/.test(camera)) {
      throw new Error("The lab requires one safe Frigate camera ID.");
    }
    if (typeof callWS !== "function" || typeof createVideo !== "function") {
      throw new Error("The lab requires callWS and createVideo adapters.");
    }
    this.camera = camera;
    this._callWS = callWS;
    this._createVideo = createVideo;
    this._loadHls = loadHls;
    this._captureHoldFrame = captureHoldFrame;
    this._onSessionCreated = onSessionCreated;
    this._onSessionCommitted = onSessionCommitted;
    this._onSessionDestroyed = onSessionDestroyed;
    this._onStateChange = onStateChange;
    this._ownerGeneration = ownerGeneration;
    this._getVisibilityState = getVisibilityState;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._readinessTimeoutMs = readinessTimeoutMs;
    this._operationLimit = operationLimit;
    this._frameObservationLimit = frameObservationLimit;
    this._nextOperationId = 0;
    this._nextPresentationId = 0;
    this._nextSessionId = 0;
    this._currentOperation = null;
    this._activeSession = null;
    this._stagingSession = null;
    this._hold = null;
    this._availability = null;
    this._operations = [];
    this._transitionTimings = [];
    this._destroyed = false;
    this._playbackRate = 1;
    this._playing = false;
    this._positionKind = "empty";
    this._requestedEpoch = null;
    this._resolvedEpoch = null;
    this._representedEpoch = null;
    this._representedObservedAtMs = null;
    this._latestFrameObservation = null;
    this._resolutionReason = null;
    this._status = "Idle";
    this._counts = { created: 0, replaced: 0, destroyed: 0 };
    this._successor = { state: "none", session: null };
    this._coverageBoundary = { state: "unknown", futureCoverageStart: null };
    this._transition = { count: 0, latest: null };
    this._boundaryHoldStartedAtMs = null;
    this._lastSuccessorReadyLatencyMs = null;
    this._boundaryReconciliation = { signalCount: 0, commitAttemptCount: 0, latest: null };
    this._boundaryCommitInFlight = null;
    this._boundaryDeadline = {
      timer: null,
      token: null,
      nextTokenId: 0,
      armed: false,
      armCount: 0,
      fireCount: 0,
      cancelCount: 0,
      latest: null
    };
  }

  get state() {
    const video = this._activeSession?.video ?? null;
    let quality = null;
    try { quality = video?.getVideoPlaybackQuality?.() ?? null; } catch {}
    return Object.freeze({
      camera: this.camera,
      operationId: this._currentOperation?.id ?? null,
      operationIntent: this._currentOperation?.intent ?? null,
      operationDisposition: this._currentOperation?.disposition ?? null,
      requestedEpoch: this._requestedEpoch,
      resolvedEpoch: this._resolvedEpoch,
      representedEpoch: this._representedEpoch,
      representedObservedAtMs: this._representedObservedAtMs,
      incidentEpoch: this.currentInvestigationEpoch(),
      resolutionReason: this._resolutionReason,
      positionKind: this._positionKind,
      status: this._status,
      playing: this._playing,
      playbackRate: this._playbackRate,
      effectivePlaybackRate: Number.isFinite(Number(video?.playbackRate))
        ? Number(video.playbackRate)
        : this._playbackRate,
      mediaCurrentTime: Number.isFinite(Number(video?.currentTime))
        ? Number(video.currentTime)
        : null,
      lastPresentedMediaTime: Number.isFinite(Number(this._latestFrameObservation?.mediaTime))
        ? Number(this._latestFrameObservation.mediaTime)
        : null,
      presentedFrameCount: Number.isFinite(Number(this._latestFrameObservation?.presentedFrames))
        ? Number(this._latestFrameObservation.presentedFrames)
        : null,
      droppedFrameCount: Number.isFinite(Number(quality?.droppedVideoFrames))
        ? Number(quality.droppedVideoFrames)
        : null,
      waitingEvents: this._activeSession?.waitingEvents ?? 0,
      stalledEvents: this._activeSession?.stalledEvents ?? 0,
      activeSessionId: this._activeSession?.id ?? null,
      activePresentationId: this._activeSession?.presentationId ?? null,
      activeLogicalWallStart: this._activeSession?.presentation?.logical_wall_start ?? null,
      activeLogicalWallEnd: this._activeSession?.presentation?.logical_wall_end ?? null,
      activeLogicalMediaEnd: this._activeSession?.presentation?.logical_media_end_position ?? null,
      stagingSessionId: this._stagingSession?.id ?? null,
      heldEpoch: this._hold?.representedEpoch ?? null,
      heldSessionId: this._hold?.sessionId ?? null,
      heldDurationMs: this._boundaryHoldStartedAtMs === null ? null :
        Math.max(0, nowEpochMs(this._now) - this._boundaryHoldStartedAtMs),
      coverageBoundary: Object.freeze({ ...this._coverageBoundary }),
      successor: this._successorDiagnostic(),
      boundaryReconciliation: Object.freeze({
        signalCount: this._boundaryReconciliation.signalCount,
        commitAttemptCount: this._boundaryReconciliation.commitAttemptCount,
        latest: this._boundaryReconciliation.latest
          ? Object.freeze({ ...this._boundaryReconciliation.latest })
          : null
      }),
      boundaryDeadline: Object.freeze({
        armed: this._boundaryDeadline.armed,
        armCount: this._boundaryDeadline.armCount,
        fireCount: this._boundaryDeadline.fireCount,
        cancelCount: this._boundaryDeadline.cancelCount,
        latest: this._boundaryDeadline.latest
          ? Object.freeze({ ...this._boundaryDeadline.latest })
          : null
      }),
      transition: Object.freeze({
        count: this._transition.count,
        latest: this._transition.latest ? { ...this._transition.latest } : null
      }),
      counts: Object.freeze({ ...this._counts })
    });
  }

  getDiagnosticReport() {
    return clone({
      schema: 1,
      camera: this.camera,
      state: this.state,
      operations: this._operations,
      transitionTimings: this._transitionTimings,
      counts: this._counts,
      limitations: {
        backwardEdge: "The current contracts do not identify the last actually representable frame.",
        snapshots: "Recording-derived edge imagery is intentionally outside Lab 1A+."
      }
    });
  }

  currentInvestigationEpoch() {
    if (this._positionKind === "uncovered" && Number.isFinite(this._requestedEpoch)) {
      return this._requestedEpoch;
    }
    return Number.isFinite(this._representedEpoch)
      ? this._representedEpoch
      : Number.isFinite(this._resolvedEpoch)
        ? this._resolvedEpoch
        : this._requestedEpoch;
  }

  _successorDiagnostic() {
    const successor = this._successor;
    return Object.freeze({
      state: successor.state,
      sourcePresentationId: successor.sourcePresentationId ?? null,
      sourceSessionId: successor.sourceSessionId ?? null,
      operationId: successor.operationId ?? null,
      presentationId: successor.session?.presentationId ?? successor.presentationId ?? null,
      sessionId: successor.session?.id ?? successor.sessionId ?? null,
      logicalWallStart: successor.presentation?.logical_wall_start ?? null,
      logicalWallEnd: successor.presentation?.logical_wall_end ?? null,
      triggerEpoch: successor.triggerEpoch ?? null,
      remainingRecordingSeconds: successor.remainingRecordingSeconds ?? null,
      requestedRate: successor.requestedRate ?? null,
      preparationStartedAtMs: successor.preparationStartedAtMs ?? null,
      v2PrepareLatencyMs: successor.v2PrepareLatencyMs ?? null,
      readinessLatencyMs: successor.readinessLatencyMs ?? null,
      firstRvfcLatencyMs: successor.firstRvfcLatencyMs ?? null,
      stagingReadyLatencyMs: successor.stagingReadyLatencyMs ?? null,
      firstRepresentedEpoch: successor.firstRepresentedEpoch ?? null,
      readyBeforeActiveEnd: successor.readyBeforeActiveEnd ?? null,
      mapValidation: successor.mapValidation ?? null,
      error: successor.error ?? null,
      staleOrSupersededCount: successor.staleOrSupersededCount ?? 0
    });
  }

  _transitionFrameObservation(observation) {
    if (!observation) return null;
    return {
      representedEpoch: Number.isFinite(Number(observation.representedEpoch))
        ? Number(observation.representedEpoch)
        : null,
      mediaTime: Number.isFinite(Number(observation.mediaTime)) ? Number(observation.mediaTime) : null,
      callbackAtMs: Number.isFinite(Number(observation.atMs)) ? Number(observation.atMs) : null,
      expectedDisplayTime: Number.isFinite(Number(observation.expectedDisplayTime))
        ? Number(observation.expectedDisplayTime)
        : null,
      presentedFrames: Number.isFinite(Number(observation.presentedFrames))
        ? Number(observation.presentedFrames)
        : null
    };
  }

  _createTransitionTiming(operation, sourceSession, boundaryEpoch) {
    const latest = this._latestFrameObservation;
    const latestOwned = latest?.sessionId === sourceSession.id &&
      latest?.presentationId === sourceSession.presentationId;
    const record = {
      schema: 1,
      camera: this.camera,
      ownerGeneration: this._ownerGeneration,
      operationId: operation.id,
      plannedTransitionCount: this._transition.count + 1,
      transitionCount: null,
      state: "preparing",
      boundaryEpoch,
      outgoingPresentationId: sourceSession.presentationId,
      outgoingSessionId: sourceSession.id,
      incomingPresentationId: null,
      incomingSessionId: null,
      preparationStartedAtMs: operation.startedAtMs,
      v2CompleteAtMs: null,
      mapValidation: null,
      manifestReadyAtMs: null,
      mediaReadyAtMs: null,
      stagingValidation: null,
      stagingReadyAtMs: null,
      outgoingFinal: latestOwned ? this._transitionFrameObservation(latest) : null,
      deadline: {
        armCount: 0,
        cancelCount: 0,
        latestArm: null,
        lastCancellationReason: null,
        lastCancellationAtMs: null,
        firedAtMs: null,
        fireLatenessMs: null,
        outcome: null
      },
      hold: { createdAtMs: null, removedAtMs: null, durationMs: null },
      commit: {
        reconciliationTrigger: null,
        startedAtMs: null,
        successorPlayCalledAtMs: null,
        successorPlayResolvedAtMs: null,
        visibilitySwapAtMs: null,
        retiredDestructionStartedAtMs: null,
        retiredDestructionCompletedAtMs: null,
        completedAtMs: null,
        visibilityState: null
      },
      postCommitFrames: [],
      terminalReason: null
    };
    this._transitionTimings.push(record);
    if (this._transitionTimings.length > TRANSITION_TIMING_LIMIT) this._transitionTimings.shift();
    return record;
  }

  _ownedTransitionTiming(successor = this._successor) {
    const record = successor?._transitionTiming;
    if (!record || record.camera !== this.camera ||
        record.ownerGeneration !== this._ownerGeneration ||
        record.operationId !== successor.operationId ||
        record.outgoingSessionId !== successor.sourceSessionId ||
        record.outgoingPresentationId !== successor.sourcePresentationId) return null;
    return record;
  }

  _recordOutgoingTransitionFrame(session, observation) {
    const successor = this._successor;
    const record = this._ownedTransitionTiming(successor);
    if (!record || (successor.state !== "preparing" && successor.state !== "ready") ||
        session !== this._activeSession || record.outgoingSessionId !== session.id ||
        record.outgoingPresentationId !== session.presentationId) return false;
    record.outgoingFinal = this._transitionFrameObservation(observation);
    return true;
  }

  _recordPostCommitTransitionFrame(session, observation) {
    if (session !== this._activeSession) return false;
    const record = session._postCommitTransitionTiming;
    if (!record || record.state !== "committed" || record.postCommitFrames.length >= 3 ||
        record.camera !== this.camera || record.ownerGeneration !== this._ownerGeneration ||
        record.incomingSessionId !== session.id ||
        record.incomingPresentationId !== session.presentationId) return false;
    record.postCommitFrames.push(this._transitionFrameObservation(observation));
    return true;
  }

  _presentationBounds(targetEpoch) {
    const availability = this._availability;
    const target = Number(targetEpoch);
    const lower = Math.max(Number(availability?.requested_start) || target - LAB_PRESENTATION_PREROLL_SECONDS,
      target - LAB_PRESENTATION_PREROLL_SECONDS);
    const upper = Math.min(Number(availability?.requested_end) || target + LAB_PRESENTATION_WINDOW_SECONDS,
      lower + LAB_PRESENTATION_WINDOW_SECONDS);
    if (!(lower < target && target < upper) && !(lower <= target && target < upper)) {
      throw new Error("Lab presentation bounds cannot contain the requested recording epoch.");
    }
    return { start: lower, end: upper };
  }

  _coverageAfterBoundary(boundaryEpoch) {
    const inspected = inspectLabAvailability(this._availability, boundaryEpoch);
    if (inspected.containing) {
      return { state: "continuous-successor-available", futureCoverageStart: null };
    }
    if (inspected.next) {
      return { state: "genuine-recording-gap-with-future", futureCoverageStart: inspected.next.start };
    }
    return { state: "genuine-recording-end", futureCoverageStart: null };
  }

  _invalidateSuccessor(reason = "superseded") {
    this._cancelArtificialBoundaryDeadline(reason);
    const successor = this._successor;
    const transitionTiming = this._ownedTransitionTiming(successor);
    if (transitionTiming && transitionTiming.state !== "committed" &&
        (successor?.state === "preparing" || successor?.state === "ready")) {
      transitionTiming.state = "superseded";
      transitionTiming.terminalReason = reason;
    }
    const session = successor?.session;
    if (session && session !== this._activeSession) {
      if (this._stagingSession === session) this._stagingSession = null;
      this._destroySession(session);
    }
    if (successor?.state === "preparing" || successor?.state === "ready") {
      this._successor = {
        ...successor,
        state: "superseded",
        session: null,
        sessionId: session?.id ?? successor.sessionId ?? null,
        presentationId: session?.presentationId ?? successor.presentationId ?? null,
        staleOrSupersededCount: (successor.staleOrSupersededCount ?? 0) + 1,
        error: reason
      };
    }
  }

  async place(value) {
    return (await this._place(value, "place")).completed;
  }

  async reacquire(value) {
    return this._place(value, "reacquire");
  }

  async _place(value, intent) {
    const requestedEpoch = parseInvestigationEpoch(value);
    const operation = this._beginOperation(intent, requestedEpoch);
    let completed = false;
    try {
      this._pauseActive();
      const availability = await this._ensureAvailability(operation, requestedEpoch);
      const inspected = inspectLabAvailability(availability, requestedEpoch);
      if (!inspected.containing) {
        completed = this._commitUncovered(operation, "uncovered-no-near-entry", inspected);
      } else {
        completed = await this._commitTarget(
          operation, requestedEpoch, "exact", inspected.containing, false
        );
      }
    } catch (error) {
      completed = this._failOperation(operation, error);
    }
    return this._placementOutcome(operation, requestedEpoch, completed);
  }

  _placementOutcome(operation, targetEpoch, completed) {
    const session = this._activeSession;
    const target = Number(targetEpoch);
    const represented = Number(this._representedEpoch);
    const acquired = completed === true &&
      operation === this._currentOperation &&
      operation.disposition === "committed-paused" &&
      Number.isFinite(operation.resolvedEpoch) &&
      Math.abs(operation.resolvedEpoch - target) <= SEEK_TOLERANCE_SECONDS &&
      Number.isFinite(operation.representedEpoch) &&
      Math.abs(operation.representedEpoch - operation.resolvedEpoch) <= SEEK_TOLERANCE_SECONDS &&
      Math.abs(represented - operation.representedEpoch) <= SEEK_TOLERANCE_SECONDS &&
      operation.presentedFrameObservations.length > 0 &&
      session?.id === operation.sessionId &&
      session?.presentationId === operation.presentationId &&
      session.requiresVisibleRevalidation === false;
    const outcome = acquired
      ? "acquired"
      : operation.disposition === "uncovered"
        ? "unavailable"
        : operation.disposition === "stale-rejected"
          ? "superseded"
          : "failed";
    return Object.freeze({
      outcome,
      completed: completed === true,
      operationId: operation.id,
      targetEpoch: target,
      resolvedEpoch: Number.isFinite(operation.resolvedEpoch) ? operation.resolvedEpoch : null,
      representedEpoch: Number.isFinite(operation.representedEpoch) ? operation.representedEpoch : null,
      sessionId: operation.sessionId,
      presentationId: operation.presentationId
    });
  }

  async play() {
    const requestedEpoch = this.currentInvestigationEpoch();
    const operation = this._beginOperation("play", requestedEpoch);
    if (!Number.isFinite(requestedEpoch)) {
      return this._finishOperation(operation, "no-investigation-position", "no-investigation-position");
    }
    try {
      const availability = await this._ensureAvailability(operation, requestedEpoch);
      const resolution = resolvePlayNavigation(availability, requestedEpoch);
      this._applyResolution(operation, resolution);
      if (!Number.isFinite(resolution.resolvedEpoch)) {
        this._pauseActive();
        return this._commitUncovered(
          operation, resolution.reason,
          inspectLabAvailability(availability, requestedEpoch)
        );
      }
      if (this._activeSession &&
          Math.abs(Number(this._representedEpoch) - resolution.resolvedEpoch) <= SEEK_TOLERANCE_SECONDS) {
        return await this._resumeCommitted(operation, resolution.reason);
      }
      return await this._commitTarget(
        operation, resolution.resolvedEpoch, resolution.reason, resolution.coverage, true
      );
    } catch (error) {
      return this._failOperation(operation, error);
    }
  }

  pause() {
    const represented = this._representedEpoch;
    const operation = this._beginOperation("pause", represented);
    if (!this._activeSession || !Number.isFinite(represented)) {
      return this._finishOperation(operation, "no-active-presentation", "no-active-presentation");
    }
    if (this._activeSession.frameCallbackId !== null) {
      this._activeSession.pauseDrainOperation = operation;
    }
    this._pauseActive();
    operation.requestedEpoch = represented;
    operation.resolvedEpoch = represented;
    operation.representedEpoch = represented;
    operation.resolutionReason = "pause-at-presented-frame";
    this._requestedEpoch = represented;
    this._resolvedEpoch = represented;
    this._resolutionReason = operation.resolutionReason;
    this._positionKind = "covered";
    this._status = "Paused at presented frame";
    return this._finishOperation(operation, "paused", operation.resolutionReason);
  }

  async resume() {
    const represented = this._representedEpoch;
    const operation = this._beginOperation("resume", represented);
    const session = this._activeSession;
    if (!session || !Number.isFinite(represented)) {
      return this._finishOperation(operation, "no-active-presentation", "no-active-presentation");
    }
    try {
      if (session.requiresVisibleRevalidation) {
        const mapped = epochToMedia(session.presentation, represented);
        if (mapped.isBoundary) return this._commitLogicalBoundary(operation);
        operation.resolvedEpoch = mapped.resolvedEpoch;
        operation.representedEpoch = represented;
        operation.resolutionReason = "resume-revalidate-visible-hold";
        return await this._seekExisting(operation, session, mapped, true);
      }
      operation.resolvedEpoch = represented;
      operation.representedEpoch = represented;
      operation.resolutionReason = "resume-current-presentation";
      return await this._resumeCommitted(operation, operation.resolutionReason);
    } catch (error) {
      return this._failOperation(operation, error);
    }
  }

  async reset() {
    const target = Number(this._activeSession?.resetEpoch);
    const operation = this._beginOperation("reset", target);
    if (!Number.isFinite(target)) {
      return this._finishOperation(operation, "no-reset-position", "no-reset-position");
    }
    try {
      this._pauseActive();
      const availability = await this._ensureAvailability(operation, target);
      const inspected = inspectLabAvailability(availability, target);
      if (!inspected.containing) {
        throw new Error("The reset position is no longer covered by recording availability.");
      }
      return await this._commitTarget(
        operation, target, "reset-initial-committed-position", inspected.containing, false
      );
    } catch (error) {
      return this._failOperation(operation, error);
    }
  }

  async forward() {
    const from = this.currentInvestigationEpoch();
    const operation = this._beginOperation("forward", from + INVESTIGATION_TRANSPORT_STEP_SECONDS);
    if (!Number.isFinite(from)) {
      return this._finishOperation(operation, "no-investigation-position", "no-investigation-position");
    }
    try {
      this._pauseActive();
      const availability = await this._ensureAvailability(operation, from);
      const resolution = resolveForwardNavigation(availability, from);
      this._applyResolution(operation, resolution);
      if (!Number.isFinite(resolution.resolvedEpoch)) {
        return this._commitUncovered(
          operation, resolution.reason,
          inspectLabAvailability(availability, resolution.requestedEpoch)
        );
      }
      return await this._commitTarget(
        operation, resolution.resolvedEpoch, resolution.reason, resolution.coverage, false
      );
    } catch (error) {
      return this._failOperation(operation, error);
    }
  }

  async backward() {
    const from = this.currentInvestigationEpoch();
    const operation = this._beginOperation("backward", from - INVESTIGATION_TRANSPORT_STEP_SECONDS);
    if (!Number.isFinite(from)) {
      return this._finishOperation(operation, "no-investigation-position", "no-investigation-position");
    }
    try {
      this._pauseActive();
      const availability = await this._ensureAvailability(operation, from);
      const resolution = resolveBackwardNavigation(availability, from);
      this._applyResolution(operation, resolution);
      if (resolution.reason === "backward-crossed-end-unresolved") {
        this._requestedEpoch = resolution.requestedEpoch;
        this._resolvedEpoch = null;
        this._resolutionReason = resolution.reason;
        this._positionKind = "uncovered";
        this._status = "Previous recording edge requires a last-frame resolver";
        return this._finishOperation(operation, "truthful-subset-limitation", resolution.reason);
      }
      if (!Number.isFinite(resolution.resolvedEpoch)) {
        return this._commitUncovered(
          operation, resolution.reason,
          inspectLabAvailability(availability, resolution.requestedEpoch)
        );
      }
      return await this._commitTarget(
        operation, resolution.resolvedEpoch, resolution.reason, resolution.coverage, false
      );
    } catch (error) {
      return this._failOperation(operation, error);
    }
  }

  setPlaybackRate(value) {
    const rate = finite(value, "Playback rate");
    if (!INVESTIGATION_PLAYBACK_RATES.includes(rate)) {
      throw new Error("Unsupported lab playback rate.");
    }
    const operation = this._beginOperation("rate", this.currentInvestigationEpoch());
    this._playbackRate = rate;
    if (this._activeSession?.video) {
      this._activeSession.video.defaultPlaybackRate = rate;
      this._activeSession.video.playbackRate = rate;
    }
    operation.requestedPlaybackRate = rate;
    operation.actualPlaybackRate = Number(this._activeSession?.video?.playbackRate ?? rate);
    operation.requestedEpoch = this._requestedEpoch;
    operation.resolvedEpoch = this._resolvedEpoch;
    operation.representedEpoch = this._representedEpoch;
    operation.resolutionReason = "rate-applied";
    this._status = `Playback rate ${rate}x applied for measurement`;
    return this._finishOperation(operation, "rate-applied", "rate-applied");
  }

  setEffectivePlaybackRate(value) {
    const rate = finite(value, "Effective playback rate");
    if (rate <= 0 || rate > 16) throw new Error("Unsupported effective playback rate.");
    if (this._activeSession?.video) this._activeSession.video.playbackRate = rate;
    this._refreshArtificialBoundaryDeadline(this._activeSession, "effective-rate-change");
    this._emit();
    return true;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._cancelArtificialBoundaryDeadline("engine-destroyed");
    const transitionTiming = this._ownedTransitionTiming();
    if (transitionTiming && transitionTiming.state !== "committed") {
      transitionTiming.state = "superseded";
      transitionTiming.terminalReason = "engine-destroyed";
    }
    if (this._currentOperation?.pending) {
      this._supersedeOperation(this._currentOperation, "engine-destroyed");
    }
    this._clearHold();
    if (this._stagingSession) this._destroySession(this._stagingSession);
    if (this._activeSession) this._destroySession(this._activeSession, { allowActive: true });
    this._activeSession = null;
    this._stagingSession = null;
    this._playing = false;
    this._emit();
  }

  _beginOperation(intent, requestedEpoch) {
    if (this._destroyed) throw new Error("Investigation playback engine is destroyed.");
    if (intent !== "successor") this._invalidateSuccessor(`${intent}-invalidated-successor`);
    else this._cancelArtificialBoundaryDeadline("successor-operation-started");
    if (this._currentOperation?.pending) this._supersedeOperation(this._currentOperation);
    const operation = {
      id: ++this._nextOperationId,
      intent,
      pending: true,
      startedAtMs: nowEpochMs(this._now),
      endedAtMs: null,
      requestedEpoch: Number.isFinite(Number(requestedEpoch)) ? Number(requestedEpoch) : null,
      resolvedEpoch: null,
      representedEpoch: this._representedEpoch,
      resolutionReason: null,
      coverage: null,
      presentationId: null,
      sessionId: null,
      logicalBounds: null,
      physicalBounds: null,
      mediaCurrentTime: null,
      mappedRepresentedEpoch: null,
      mappingErrorSeconds: null,
      buffered: [],
      seekable: [],
      requestedPlaybackRate: this._playbackRate,
      actualPlaybackRate: null,
      playStartRepresentedEpoch: null,
      playStartWallMs: null,
      presentedFrameObservations: [],
      presentedFrameCount: null,
      representedAdvancementSeconds: null,
      observationElapsedMs: null,
      achievedRepresentedRate: null,
      droppedVideoFrames: null,
      totalVideoFrames: null,
      waitingEvents: 0,
      stalledEvents: 0,
      timings: {},
      counts: null,
      disposition: null,
      error: null,
      cancellations: []
    };
    this._currentOperation = operation;
    this._operations.push(operation);
    if (this._operations.length > this._operationLimit) this._operations.shift();
    this._status = `${intent} pending`;
    this._emit();
    return operation;
  }

  _supersedeOperation(operation, reason = "superseded-by-newer-operation") {
    if (operation.reusedSessionId === this._activeSession?.id &&
        operation.reusedHoldSessionId === this._hold?.sessionId) {
      this._markSessionForVisibleRevalidation(this._activeSession);
    }
    for (const cancel of operation.cancellations.splice(0)) {
      try { cancel(); } catch {}
    }
    if (operation.pending) {
      operation.pending = false;
      operation.disposition = "stale-rejected";
      operation.resolutionReason = operation.resolutionReason ?? reason;
      operation.endedAtMs = nowEpochMs(this._now);
      operation.counts = { ...this._counts };
    }
  }

  _assertCurrent(operation) {
    if (this._destroyed || operation !== this._currentOperation || !operation.pending) {
      throw new Error("Stale investigation operation.");
    }
  }

  async _ensureAvailability(operation, targetEpoch) {
    this._assertCurrent(operation);
    const cached = this._availability;
    const target = Number(targetEpoch);
    const usable = cached && target >= cached.requested_start && target < cached.requested_end &&
      target - cached.requested_start > AVAILABILITY_EDGE_REFRESH_SECONDS &&
      cached.requested_end - target > AVAILABILITY_EDGE_REFRESH_SECONDS;
    if (usable) return cached;
    const range = buildLabAvailabilityWindow(target);
    operation.timings.availabilityStartMs = nowEpochMs(this._now);
    const result = await this._callWS({
      type: "frigate_max/v1/recordings/availability",
      camera: this.camera,
      start: range.start,
      end: range.end
    });
    this._assertCurrent(operation);
    operation.timings.availabilityCompleteMs = nowEpochMs(this._now);
    this._availability = normalizeLabAvailability(result, this.camera);
    return this._availability;
  }

  _applyResolution(operation, resolution) {
    operation.requestedEpoch = resolution.requestedEpoch;
    operation.resolvedEpoch = resolution.resolvedEpoch;
    operation.resolutionReason = resolution.reason;
    operation.coverage = resolution.coverage ? { ...resolution.coverage } : null;
  }

  _commitUncovered(operation, reason, inspected) {
    this._assertCurrent(operation);
    this._requestedEpoch = operation.requestedEpoch;
    this._resolvedEpoch = null;
    this._resolutionReason = reason;
    this._positionKind = "uncovered";
    this._playing = false;
    this._status = reason === "uncovered-no-near-entry"
      ? "No recording at TI; no nearby automatic entry"
      : reason === "logical-boundary-unrepresentable"
        ? "Logical presentation endpoint has no representable frame"
        : "No recording at TI";
    operation.resolutionReason = reason;
    operation.coverage = null;
    operation.previousCoverage = inspected?.previous ? { ...inspected.previous } : null;
    operation.nextCoverage = inspected?.next ? { ...inspected.next } : null;
    operation.representedEpoch = this._representedEpoch;
    return this._finishOperation(operation, "uncovered", reason);
  }

  async _commitTarget(operation, resolvedEpoch, reason, coverage, autoplay) {
    this._assertCurrent(operation);
    operation.resolvedEpoch = resolvedEpoch;
    operation.resolutionReason = reason;
    operation.coverage = coverage ? { ...coverage } : null;
    let mapped = null;
    if (this._activeSession?.presentation) {
      try { mapped = epochToMedia(this._activeSession.presentation, resolvedEpoch); } catch {}
    }
    if (mapped?.isBoundary) return this._commitLogicalBoundary(operation);
    const result = mapped
      ? await this._seekExisting(operation, this._activeSession, mapped, autoplay)
      : await this._prepareStaging(operation, resolvedEpoch, autoplay);
    return result;
  }

  _commitLogicalBoundary(operation) {
    this._assertCurrent(operation);
    this._pauseActive();
    return this._commitUncovered(operation, "logical-boundary-unrepresentable", null);
  }

  async _seekExisting(operation, session, mapped, autoplay) {
    this._assertCurrent(operation);
    if (mapped.isBoundary) return this._commitLogicalBoundary(operation);
    this._pauseActive();
    const hold = this._ensureHold(session);
    operation.reusedSessionId = session.id;
    operation.reusedHoldSessionId = hold.sessionId;
    operation.presentationId = session.presentationId;
    operation.sessionId = session.id;
    operation.timings.seekStartMs = nowEpochMs(this._now);
    try {
      const observation = await this._seekAndObserve(operation, session, mapped);
      this._assertCurrent(operation);
      operation.timings.commitMs = nowEpochMs(this._now);
      this._commitPosition(operation, session, observation, mapped.resolvedEpoch);
      if (this._hold === hold) this._clearHold();
      return autoplay
        ? this._resumeCommitted(operation, operation.resolutionReason)
        : this._finishOperation(operation, "committed-paused", operation.resolutionReason);
    } catch (error) {
      if (this._activeSession === session && this._hold === hold) {
        this._markSessionForVisibleRevalidation(session);
      }
      throw error;
    }
  }

  async _prepareStaging(operation, resolvedEpoch, autoplay) {
    this._assertCurrent(operation);
    operation.timings.v2StartMs = nowEpochMs(this._now);
    const bounds = this._presentationBounds(resolvedEpoch);
    const rawPresentation = await this._callWS({
      type: "frigate_max/v2/vod/prepare",
      camera: this.camera,
      target: resolvedEpoch,
      bounds_start: bounds.start,
      bounds_end: bounds.end
    });
    this._assertCurrent(operation);
    operation.timings.v2CompleteMs = nowEpochMs(this._now);
    let presentation;
    try {
      presentation = validateHistoricalPresentation(rawPresentation, this.camera);
      operation.mapValidation = presentationMapDiagnostic(rawPresentation, "accepted");
    } catch (error) {
      operation.mapValidation = presentationMapDiagnostic(rawPresentation, "rejected");
      throw error;
    }
    const mapped = epochToMedia(presentation, resolvedEpoch);
    if (mapped.isBoundary) return this._commitLogicalBoundary(operation);
    operation.resolvedEpoch = mapped.resolvedEpoch;
    operation.presentationId = ++this._nextPresentationId;
    operation.logicalBounds = {
      start: presentation.logical_wall_start,
      end: presentation.logical_wall_end
    };
    operation.physicalBounds = {
      start: presentation.coverage_run.known_start,
      end: presentation.coverage_run.known_end
    };
    operation.timings.signingStartMs = nowEpochMs(this._now);
    const signed = await this._callWS({
      type: "auth/sign_path",
      path: manifestPath(this.camera, presentation),
      expires: 900
    });
    this._assertCurrent(operation);
    operation.timings.signingCompleteMs = nowEpochMs(this._now);
    if (typeof signed?.path !== "string" || !signed.path.startsWith("/")) {
      throw new Error("Home Assistant did not sign the investigation media path.");
    }
    const Hls = await this._loadHls();
    this._assertCurrent(operation);
    if (!Hls?.isSupported?.()) throw new Error("This browser does not support investigation HLS.");
    const session = this._createSession(operation, presentation, Hls);
    this._stagingSession = session;
    try {
      await this._attachSource(operation, session, signed.path, Hls);
      const observation = await this._seekAndObserve(operation, session, mapped);
      this._assertCurrent(operation);
      const previous = this._activeSession;
      session.resetEpoch = mapped.resolvedEpoch;
      session.committedOperationId = operation.id;
      this._activeSession = session;
      this._stagingSession = null;
      operation.timings.commitMs = nowEpochMs(this._now);
      this._onSessionCommitted?.(session, previous);
      this._commitPosition(operation, session, observation, mapped.resolvedEpoch);
      this._clearHold();
      if (previous) {
        this._counts.replaced += 1;
        this._destroySession(previous, { allowActive: false });
      }
      return autoplay
        ? this._resumeCommitted(operation, operation.resolutionReason)
        : this._finishOperation(operation, "committed-paused", operation.resolutionReason);
    } catch (error) {
      if (this._stagingSession === session) this._stagingSession = null;
      if (session !== this._activeSession) this._destroySession(session);
      throw error;
    }
  }

  _maybePrepareSuccessor(session, representedEpoch) {
    if (!this._playing || session !== this._activeSession || !Number.isFinite(representedEpoch)) return;
    const boundary = Number(session.presentation?.logical_wall_end);
    if (!Number.isFinite(boundary) || representedEpoch >= boundary) return;
    const successor = this._successor;
    if ((successor.state === "preparing" || successor.state === "ready") &&
        successor.sourceSessionId === session.id) return;
    if (successor.boundaryEpoch === boundary &&
        (successor.state === "none" || successor.state === "failed" || successor.state === "superseded")) return;
    const latencyMs = Math.max(SUCCESSOR_DEFAULT_LATENCY_MS, this._lastSuccessorReadyLatencyMs ?? 0);
    const lead = successorPreparationLeadSeconds(this._playbackRate, latencyMs);
    const remaining = boundary - representedEpoch;
    if (remaining > lead) return;
    void this._startSuccessorPreparation(session, representedEpoch, boundary, remaining);
  }

  async _startSuccessorPreparation(sourceSession, triggerEpoch, boundaryEpoch, remainingRecordingSeconds) {
    if (sourceSession !== this._activeSession || this._destroyed) return;
    const operation = this._beginOperation("successor", boundaryEpoch);
    const successor = {
      state: "preparing",
      sourceSessionId: sourceSession.id,
      sourcePresentationId: sourceSession.presentationId,
      boundaryEpoch,
      triggerEpoch,
      remainingRecordingSeconds,
      requestedRate: this._playbackRate,
      operationId: operation.id,
      preparationStartedAtMs: operation.startedAtMs,
      session: null,
      presentation: null,
      continuousCoverageConfirmed: false,
      staleOrSupersededCount: this._successor.staleOrSupersededCount ?? 0,
      error: null
    };
    successor._transitionTiming = this._createTransitionTiming(operation, sourceSession, boundaryEpoch);
    this._successor = successor;
    this._status = "Preparing continuous presentation successor";
    this._emit();
    try {
      await this._ensureAvailability(operation, boundaryEpoch);
      this._assertCurrent(operation);
      const coverage = this._coverageAfterBoundary(boundaryEpoch);
      this._coverageBoundary = coverage;
      if (coverage.state !== "continuous-successor-available") {
        successor.state = "none";
        successor._transitionTiming.state = "not-continuous";
        successor._transitionTiming.terminalReason = coverage.state;
        successor.futureCoverageStart = coverage.futureCoverageStart;
        operation.resolutionReason = coverage.state;
        this._status = coverage.state === "genuine-recording-end"
          ? "Recording ends at the current presentation boundary"
          : "Recording gap follows the current presentation boundary";
        this._finishOperation(operation, "no-continuous-successor", coverage.state);
        return;
      }
      successor.continuousCoverageConfirmed = true;
      operation.timings.v2StartMs = nowEpochMs(this._now);
      const bounds = this._presentationBounds(boundaryEpoch);
      const rawPresentation = await this._callWS({
        type: "frigate_max/v2/vod/prepare",
        camera: this.camera,
        target: boundaryEpoch,
        bounds_start: bounds.start,
        bounds_end: bounds.end
      });
      this._assertCurrent(operation);
      operation.timings.v2CompleteMs = nowEpochMs(this._now);
      successor._transitionTiming.v2CompleteAtMs = operation.timings.v2CompleteMs;
      successor.v2PrepareLatencyMs = operation.timings.v2CompleteMs - operation.timings.v2StartMs;
      let presentation;
      try {
        presentation = validateHistoricalPresentation(rawPresentation, this.camera);
        successor.mapValidation = presentationMapDiagnostic(rawPresentation, "accepted");
      } catch (error) {
        successor.mapValidation = presentationMapDiagnostic(rawPresentation, "rejected");
        successor._transitionTiming.mapValidation = successor.mapValidation;
        operation.mapValidation = successor.mapValidation;
        throw error;
      }
      successor._transitionTiming.mapValidation = successor.mapValidation;
      operation.mapValidation = successor.mapValidation;
      const mapped = epochToMedia(presentation, boundaryEpoch);
      if (mapped.isBoundary) throw new Error("Continuous successor resolved to an unrepresentable boundary.");
      operation.resolvedEpoch = mapped.resolvedEpoch;
      operation.presentationId = ++this._nextPresentationId;
      operation.logicalBounds = { start: presentation.logical_wall_start, end: presentation.logical_wall_end };
      operation.physicalBounds = {
        start: presentation.coverage_run.known_start,
        end: presentation.coverage_run.known_end
      };
      operation.timings.signingStartMs = nowEpochMs(this._now);
      const signed = await this._callWS({
        type: "auth/sign_path",
        path: manifestPath(this.camera, presentation),
        expires: 900
      });
      this._assertCurrent(operation);
      operation.timings.signingCompleteMs = nowEpochMs(this._now);
      if (typeof signed?.path !== "string" || !signed.path.startsWith("/")) {
        throw new Error("Home Assistant did not sign the investigation media path.");
      }
      const Hls = await this._loadHls();
      this._assertCurrent(operation);
      if (!Hls?.isSupported?.()) throw new Error("This browser does not support investigation HLS.");
      const session = this._createSession(operation, presentation, Hls);
      successor.session = session;
      successor.presentation = presentation;
      successor._transitionTiming.incomingSessionId = session.id;
      successor._transitionTiming.incomingPresentationId = session.presentationId;
      this._stagingSession = session;
      await this._attachSource(operation, session, signed.path, Hls);
      successor._transitionTiming.manifestReadyAtMs = operation.timings.manifestCompleteMs;
      successor._transitionTiming.mediaReadyAtMs = operation.timings.readinessCompleteMs;
      successor.readinessLatencyMs = operation.timings.readinessCompleteMs - operation.timings.readinessStartMs;
      const observation = await this._seekAndObserve(operation, session, mapped);
      this._assertCurrent(operation);
      successor.firstObservation = observation;
      successor.firstRepresentedEpoch = observation.representedEpoch;
      successor._transitionTiming.stagingValidation = {
        ...this._transitionFrameObservation(observation),
        paused: session.video.paused === true,
        playing: session.video.paused === false
      };
      successor.firstRvfcLatencyMs = operation.timings.firstPresentedFrameCompleteMs -
        operation.timings.firstPresentedFrameStartMs;
      successor.stagingReadyLatencyMs = nowEpochMs(this._now) - successor.preparationStartedAtMs;
      successor._transitionTiming.stagingReadyAtMs =
        successor.preparationStartedAtMs + successor.stagingReadyLatencyMs;
      successor._transitionTiming.state = "ready";
      successor.readyBeforeActiveEnd = sourceSession === this._activeSession && this._playing;
      this._lastSuccessorReadyLatencyMs = successor.stagingReadyLatencyMs;
      successor.state = "ready";
      this._status = "Continuous presentation successor ready";
      this._emit();
      this._reconcilePreparedSuccessorAtBoundary(sourceSession, "successor-ready");
      this._refreshArtificialBoundaryDeadline(sourceSession, "successor-ready");
      this._emit();
    } catch (error) {
      this._cancelArtificialBoundaryDeadline("successor-preparation-failed");
      if (this._stagingSession === successor.session) this._stagingSession = null;
      if (successor.session && successor.session !== this._activeSession) this._destroySession(successor.session);
      successor.session = null;
      successor.state = /stale investigation operation/i.test(String(error?.message)) ? "superseded" : "failed";
      successor._transitionTiming.state = successor.state;
      successor._transitionTiming.terminalReason = successor.state === "failed"
        ? safeError(error)
        : "stale-investigation-operation";
      successor.error = successor.state === "failed" ? safeError(error) : null;
      if (successor.state === "superseded") successor.staleOrSupersededCount += 1;
      if (operation === this._currentOperation && operation.pending) {
        if (successor.state === "failed" && this._hold?.sessionId === sourceSession.id) {
          this._status = "Successor preparation failed; holding final truthful frame";
        }
        this._failOperation(operation, error);
      }
    }
  }

  async _commitPreparedSuccessor(successor, operation) {
    const next = successor?.session;
    const previous = this._activeSession;
    if (!next || previous?.id !== successor.sourceSessionId || this._stagingSession !== next ||
        operation !== this._currentOperation || !operation.pending) return false;
    const oldFinalEpoch = this._representedEpoch;
    const holdStartedAtMs = this._boundaryHoldStartedAtMs;
    const transitionTiming = this._ownedTransitionTiming(successor);
    try {
      if (transitionTiming) {
        transitionTiming.commit.reconciliationTrigger = successor.commitTrigger ?? null;
        transitionTiming.commit.startedAtMs = nowEpochMs(this._now);
        try { transitionTiming.commit.visibilityState = this._getVisibilityState?.() ?? null; } catch {}
      }
      this._cancelArtificialBoundaryDeadline("successor-commit-started");
      this._playing = false;
      try { previous.video.pause(); } catch {}
      if (transitionTiming) transitionTiming.commit.successorPlayCalledAtMs = nowEpochMs(this._now);
      await Promise.resolve(next.video.play());
      if (transitionTiming) transitionTiming.commit.successorPlayResolvedAtMs = nowEpochMs(this._now);
      this._assertCurrent(operation);
      if (this._activeSession !== previous || this._stagingSession !== next) return false;
      next.resetEpoch = successor.firstRepresentedEpoch;
      next.committedOperationId = operation.id;
      this._activeSession = next;
      this._stagingSession = null;
      this._onSessionCommitted?.(next, previous);
      if (transitionTiming) transitionTiming.commit.visibilitySwapAtMs = nowEpochMs(this._now);
      this._acceptRepresentedObservation(next, successor.firstObservation);
      this._clearHold();
      this._boundaryHoldStartedAtMs = null;
      this._counts.replaced += 1;
      if (transitionTiming) transitionTiming.commit.retiredDestructionStartedAtMs = nowEpochMs(this._now);
      this._destroySession(previous, { allowActive: false });
      if (transitionTiming) transitionTiming.commit.retiredDestructionCompletedAtMs = nowEpochMs(this._now);
      this._positionKind = "covered";
      this._resolutionReason = "continuous-presentation-successor";
      this._status = "Continuous presentation successor committed";
      this._transition.count += 1;
      if (transitionTiming) {
        transitionTiming.transitionCount = this._transition.count;
        transitionTiming.state = "committed";
        next._postCommitTransitionTiming = transitionTiming;
      }
      this._transition.latest = {
        sourcePresentationId: previous.presentationId,
        destinationPresentationId: next.presentationId,
        oldFinalRepresentedEpoch: oldFinalEpoch,
        newFirstRepresentedEpoch: successor.firstRepresentedEpoch,
        absoluteEpochDelta: Number.isFinite(oldFinalEpoch)
          ? successor.firstRepresentedEpoch - oldFinalEpoch : null,
        wallTransitionDurationMs: holdStartedAtMs === null ? 0 : nowEpochMs(this._now) - holdStartedAtMs,
        activeReachedLogicalHold: holdStartedAtMs !== null,
        visibleHoldDurationMs: holdStartedAtMs === null ? 0 : nowEpochMs(this._now) - holdStartedAtMs,
        commitTrigger: successor.commitTrigger ?? null,
        blackFrameObserved: null
      };
      this._successor = { ...successor, state: "committed", session: null };
      this._playing = true;
      this._startFrameObservation(next, operation);
      if (transitionTiming) transitionTiming.commit.completedAtMs = nowEpochMs(this._now);
      return this._finishOperation(operation, "successor-committed", this._resolutionReason);
    } catch (error) {
      successor.state = "failed";
      successor.error = safeError(error);
      if (transitionTiming) {
        transitionTiming.state = "failed";
        transitionTiming.terminalReason = successor.error;
      }
      if (operation === this._currentOperation && operation.pending) this._failOperation(operation, error);
      return false;
    }
  }

  _successorFrameIsValidated(successor, next) {
    const firstObservation = successor?.firstObservation;
    return firstObservation?.sessionId === next?.id &&
      firstObservation?.presentationId === next?.presentationId &&
      Number.isFinite(Number(firstObservation?.representedEpoch)) &&
      Number.isFinite(Number(successor?.boundaryEpoch)) &&
      Math.abs(Number(firstObservation.representedEpoch) - Number(successor.boundaryEpoch)) <=
        SEEK_TOLERANCE_SECONDS;
  }

  _cancelArtificialBoundaryDeadline(reason) {
    const deadline = this._boundaryDeadline;
    if (!deadline?.armed) return false;
    const transitionTiming = this._ownedTransitionTiming(deadline.token?.successor);
    if (deadline.timer !== null) {
      try { this._clearTimer(deadline.timer); } catch {}
    }
    const canceledAtMs = nowEpochMs(this._now);
    if (transitionTiming) {
      transitionTiming.deadline.cancelCount += 1;
      transitionTiming.deadline.lastCancellationReason = reason;
      transitionTiming.deadline.lastCancellationAtMs = canceledAtMs;
      transitionTiming.deadline.outcome = "canceled";
    }
    deadline.timer = null;
    deadline.token = null;
    deadline.armed = false;
    deadline.cancelCount += 1;
    deadline.latest = {
      ...deadline.latest,
      state: "canceled",
      reason,
      canceledAtMs,
      outcome: "canceled"
    };
    return true;
  }

  _refreshArtificialBoundaryDeadline(session, reason) {
    const successor = this._successor;
    const next = successor?.session;
    const operation = this._currentOperation;
    const observation = this._latestFrameObservation;
    const successorFrameValidated = this._successorFrameIsValidated(successor, next);
    const owned = session && session === this._activeSession &&
      successor?.state === "ready" &&
      successor.sourceSessionId === session.id &&
      successor.sourcePresentationId === session.presentationId &&
      next && this._stagingSession === next &&
      successor.operationId === operation?.id && operation?.pending &&
      successor.continuousCoverageConfirmed === true &&
      this._coverageBoundary.state === "continuous-successor-available";
    if (!owned || !successorFrameValidated || !this._playing) {
      this._cancelArtificialBoundaryDeadline(`${reason}-ineligible`);
      return false;
    }

    const activeEpoch = Number(observation?.representedEpoch);
    const activeExpectedDisplayTime = Number(observation?.expectedDisplayTime);
    const successorEpoch = Number(successor.firstObservation.representedEpoch);
    const effectiveRate = Number(session.video?.playbackRate);
    const anchorOwned = observation?.sessionId === session.id &&
      observation?.presentationId === session.presentationId;
    if (!anchorOwned || !Number.isFinite(activeEpoch) || !Number.isFinite(activeExpectedDisplayTime) ||
        !Number.isFinite(successorEpoch) || !Number.isFinite(effectiveRate) || effectiveRate <= 0) {
      this._cancelArtificialBoundaryDeadline(`${reason}-missing-truthful-anchor`);
      return false;
    }

    if (successorEpoch + TIME_MAP_QUANTIZATION_SECONDS < activeEpoch) {
      this._cancelArtificialBoundaryDeadline(`${reason}-regressive-successor`);
      this._boundaryDeadline.latest = {
        state: "rejected",
        reason,
        sourceSessionId: session.id,
        sourcePresentationId: session.presentationId,
        successorSessionId: next.id,
        successorPresentationId: next.presentationId,
        activeRepresentedEpoch: activeEpoch,
        activeExpectedDisplayTime,
        successorRepresentedEpoch: successorEpoch,
        effectivePlaybackRate: effectiveRate,
        deadlineAtMs: null,
        delayMs: null,
        outcome: "regressive-successor"
      };
      return false;
    }

    this._cancelArtificialBoundaryDeadline(`rearm:${reason}`);
    const scheduledAtMs = nowEpochMs(this._now);
    const representedDeltaSeconds = Math.max(0, successorEpoch - activeEpoch);
    const deadlineAtMs = activeExpectedDisplayTime + representedDeltaSeconds / effectiveRate * 1000;
    const delayMs = Math.max(0, deadlineAtMs - scheduledAtMs);
    const diagnostic = {
      state: "armed",
      reason,
      sourceSessionId: session.id,
      sourcePresentationId: session.presentationId,
      successorOperationId: successor.operationId,
      successorSessionId: next.id,
      successorPresentationId: next.presentationId,
      activeRepresentedEpoch: activeEpoch,
      activeExpectedDisplayTime,
      successorRepresentedEpoch: successorEpoch,
      effectivePlaybackRate: effectiveRate,
      representedDeltaSeconds,
      scheduledAtMs,
      deadlineAtMs,
      delayMs,
      outcome: "armed"
    };
    const token = {
      id: ++this._boundaryDeadline.nextTokenId,
      session,
      operation,
      successor,
      diagnostic
    };
    diagnostic.tokenId = token.id;
    this._boundaryDeadline.armed = true;
    this._boundaryDeadline.armCount += 1;
    this._boundaryDeadline.token = token;
    this._boundaryDeadline.latest = diagnostic;
    const transitionTiming = this._ownedTransitionTiming(successor);
    if (transitionTiming) {
      transitionTiming.deadline.armCount += 1;
      transitionTiming.deadline.latestArm = {
        tokenId: token.id,
        reason,
        armedAtMs: scheduledAtMs,
        anchorRepresentedEpoch: activeEpoch,
        anchorExpectedDisplayTime: activeExpectedDisplayTime,
        successorRepresentedEpoch: successorEpoch,
        effectivePlaybackRate: effectiveRate,
        dueAtMs: deadlineAtMs,
        delayMs
      };
      transitionTiming.deadline.outcome = "armed";
    }
    this._boundaryDeadline.timer = this._setTimer(() => {
      if (!this._boundaryDeadline.armed || this._boundaryDeadline.token !== token ||
          this._destroyed) return;
      this._boundaryDeadline.timer = null;
      this._boundaryDeadline.token = null;
      this._boundaryDeadline.armed = false;
      this._boundaryDeadline.fireCount += 1;
      diagnostic.state = "fired";
      diagnostic.firedAtMs = nowEpochMs(this._now);
      diagnostic.outcome = "reconciliation-pending";
      const firedTransitionTiming = this._ownedTransitionTiming(successor);
      if (firedTransitionTiming) {
        firedTransitionTiming.deadline.firedAtMs = diagnostic.firedAtMs;
        firedTransitionTiming.deadline.fireLatenessMs = diagnostic.firedAtMs - deadlineAtMs;
        firedTransitionTiming.deadline.outcome = "reconciliation-pending";
      }
      const started = this._reconcilePreparedSuccessorAtBoundary(
        session,
        "artificial-boundary-deadline",
        { boundaryReached: true, deadlineTokenId: token.id }
      );
      if (!started) {
        diagnostic.outcome = this._boundaryReconciliation.latest?.outcome ?? "reconciliation-rejected";
        if (firedTransitionTiming) firedTransitionTiming.deadline.outcome = diagnostic.outcome;
      }
      this._boundaryDeadline.latest = diagnostic;
      this._emit();
    }, delayMs);
    return true;
  }

  _reconcilePreparedSuccessorAtBoundary(session, signal, {
    boundaryReached = false,
    observedMediaTime = null,
    deadlineTokenId = null
  } = {}) {
    const activeMediaTime = Number(session?.video?.currentTime);
    const logicalMediaEnd = Number(session?.presentation?.logical_media_end_position);
    const cursorReachedBoundary = Number.isFinite(activeMediaTime) && Number.isFinite(logicalMediaEnd) &&
      activeMediaTime >= logicalMediaEnd;
    if (session && (boundaryReached || cursorReachedBoundary)) {
      session.logicalBoundaryReached = true;
      session.logicalBoundarySignal = signal;
    }

    const successor = this._successor;
    const next = successor?.session;
    const operation = this._currentOperation;
    const successorFrameValidated = this._successorFrameIsValidated(successor, next);
    const activeRepresentedEpoch = Number(this._representedEpoch);
    const successorRepresentedEpoch = Number(successor?.firstObservation?.representedEpoch);
    const successorRegresses = Number.isFinite(activeRepresentedEpoch) &&
      Number.isFinite(successorRepresentedEpoch) &&
      successorRepresentedEpoch + TIME_MAP_QUANTIZATION_SECONDS < activeRepresentedEpoch;
    let rejection = null;
    if (!session || session !== this._activeSession) rejection = "inactive-source-session";
    else if (!session.logicalBoundaryReached) rejection = "active-boundary-not-reached";
    else if (successor?.state !== "ready") rejection = "successor-not-ready";
    else if (successor.continuousCoverageConfirmed !== true ||
        this._coverageBoundary.state !== "continuous-successor-available") {
      rejection = "continuous-coverage-not-confirmed";
    }
    else if (successor.sourceSessionId !== session.id ||
        successor.sourcePresentationId !== session.presentationId) rejection = "source-ownership-mismatch";
    else if (!next || this._stagingSession !== next) rejection = "staging-ownership-mismatch";
    else if (successor.operationId !== operation?.id || !operation?.pending) {
      rejection = "operation-ownership-mismatch";
    } else if (!successorFrameValidated) rejection = "successor-frame-not-validated";
    else if (successorRegresses) rejection = "successor-frame-regresses-active";
    else if (this._boundaryCommitInFlight) rejection = "commit-already-in-flight";

    const diagnostic = {
      atMs: nowEpochMs(this._now),
      signal,
      sourceSessionId: session?.id ?? null,
      sourcePresentationId: session?.presentationId ?? null,
      activeMediaTime: Number.isFinite(activeMediaTime) ? activeMediaTime : null,
      observedMediaTime: Number.isFinite(Number(observedMediaTime)) ? Number(observedMediaTime) : null,
      logicalMediaEnd: Number.isFinite(logicalMediaEnd) ? logicalMediaEnd : null,
      boundaryReached: session?.logicalBoundaryReached === true,
      successorState: successor?.state ?? "none",
      successorOperationId: successor?.operationId ?? null,
      currentOperationId: operation?.id ?? null,
      successorFrameValidated,
      activeRepresentedEpoch: Number.isFinite(activeRepresentedEpoch) ? activeRepresentedEpoch : null,
      successorRepresentedEpoch: Number.isFinite(successorRepresentedEpoch)
        ? successorRepresentedEpoch
        : null,
      deadlineTokenId,
      commitAttempted: rejection === null,
      outcome: rejection ?? "commit-pending"
    };
    this._boundaryReconciliation.signalCount += 1;
    this._boundaryReconciliation.latest = diagnostic;
    if (rejection) {
      this._emit();
      return false;
    }

    this._boundaryReconciliation.commitAttemptCount += 1;
    this._cancelArtificialBoundaryDeadline("reconciliation-commit-started");
    successor.commitTrigger = signal;
    const transitionTiming = this._ownedTransitionTiming(successor);
    if (transitionTiming) transitionTiming.commit.reconciliationTrigger = signal;
    const token = { successor, session, operation, diagnostic };
    this._boundaryCommitInFlight = token;
    void this._commitPreparedSuccessor(successor, operation).then(committed => {
      if (this._boundaryCommitInFlight === token) this._boundaryCommitInFlight = null;
      diagnostic.outcome = committed ? "committed" : "commit-rejected";
      this._boundaryReconciliation.latest = diagnostic;
      if (deadlineTokenId !== null && this._boundaryDeadline.latest?.tokenId === deadlineTokenId) {
        this._boundaryDeadline.latest = {
          ...this._boundaryDeadline.latest,
          outcome: committed ? "committed" : "commit-rejected"
        };
      }
      if (transitionTiming && deadlineTokenId !== null) {
        transitionTiming.deadline.outcome = committed ? "committed" : "commit-rejected";
      }
      this._emit();
    });
    this._emit();
    return true;
  }

  _createSession(operation, presentation, Hls) {
    const video = this._createVideo();
    if (typeof video?.requestVideoFrameCallback !== "function") {
      throw new Error("Presented-frame evidence is unavailable: requestVideoFrameCallback is required.");
    }
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.defaultPlaybackRate = this._playbackRate;
    video.playbackRate = this._playbackRate;
    const session = {
      id: ++this._nextSessionId,
      presentationId: operation.presentationId,
      ownerOperationId: operation.id,
      committedOperationId: null,
      presentation,
      video,
      hls: new Hls({ enableWorker: true, maxBufferLength: 20 }),
      hlsListeners: [],
      mediaListeners: [],
      frameCallbackId: null,
      pauseDrainOperation: null,
      waitingEvents: 0,
      stalledEvents: 0,
      resetEpoch: null,
      requiresVisibleRevalidation: false,
      logicalBoundaryReached: false,
      logicalBoundarySignal: null,
      destroyed: false
    };
    operation.sessionId = session.id;
    this._counts.created += 1;
    this._createMediaMetricListeners(session);
    this._onSessionCreated?.(session);
    return session;
  }

  async _attachSource(operation, session, signedPath, Hls) {
    const manifest = this._waitForHlsEvent(
      operation, session, Hls.Events.MANIFEST_PARSED, "manifest", data => !data?.fatal
    );
    operation.timings.manifestStartMs = nowEpochMs(this._now);
    session.hls.attachMedia(session.video);
    this._assertCurrent(operation);
    session.hls.loadSource(signedPath);
    await manifest;
    this._assertCurrent(operation);
    operation.timings.manifestCompleteMs = nowEpochMs(this._now);
    operation.timings.readinessStartMs = nowEpochMs(this._now);
    await this._waitForMedia(
      operation, session.video, "progress",
      () => Number(session.video.seekable?.length) > 0,
      "Historical media did not become seekable."
    );
    this._assertCurrent(operation);
    operation.timings.readinessCompleteMs = nowEpochMs(this._now);
  }

  async _seekAndObserve(operation, session, mapped) {
    this._assertCurrent(operation);
    operation.timings.seekStartMs = operation.timings.seekStartMs ?? nowEpochMs(this._now);
    const seeked = this._waitForMedia(
      operation, session.video, "seeked",
      () => Number.isFinite(Number(session.video.currentTime)) &&
        Math.abs(Number(session.video.currentTime) - mapped.mediaTime) <= SEEK_TOLERANCE_SECONDS &&
        !session.video.seeking,
      "Investigation seek did not settle at the requested media position."
    );
    operation.timings.firstPresentedFrameStartMs = nowEpochMs(this._now);
    const targetFrame = this._waitForTargetFrame(operation, session, mapped);
    session.video.currentTime = mapped.mediaTime;
    const [, observation] = await Promise.all([seeked, targetFrame]);
    this._assertCurrent(operation);
    operation.timings.seekCompleteMs = nowEpochMs(this._now);
    operation.timings.firstPresentedFrameCompleteMs = nowEpochMs(this._now);
    return observation;
  }

  _waitForTargetFrame(operation, session, mapped) {
    const video = session.video;
    return new Promise((resolve, reject) => {
      let settled = false;
      let callbackId = null;
      let timer = null;
      const finish = (error, observation = null) => {
        if (settled) return;
        settled = true;
        if (timer !== null) this._clearTimer(timer);
        if (callbackId !== null) {
          try { video.cancelVideoFrameCallback?.(callbackId); } catch {}
        }
        const index = operation.cancellations.indexOf(cancel);
        if (index >= 0) operation.cancellations.splice(index, 1);
        if (error) reject(error);
        else resolve(observation);
      };
      const observe = (wallMs, metadata = {}) => {
        callbackId = null;
        try { this._assertCurrent(operation); } catch (error) {
          finish(error);
          return;
        }
        const mediaTime = Number(metadata.mediaTime);
        let mappedFrame = null;
        try { mappedFrame = mediaToEpoch(session.presentation, mediaTime); } catch {}
        const consistent = mappedFrame &&
          Math.abs(mappedFrame.epoch - mapped.resolvedEpoch) <= SEEK_TOLERANCE_SECONDS;
        const observation = this._frameObservation(session, wallMs, metadata, mappedFrame);
        this._recordFrame(operation, observation);
        if (consistent) finish(null, observation);
        else callbackId = video.requestVideoFrameCallback(observe);
      };
      const cancel = () => finish(new Error("Stale investigation operation."));
      operation.cancellations.push(cancel);
      timer = this._setTimer(
        () => finish(new Error("No consistent presented frame was observed.")),
        this._readinessTimeoutMs
      );
      callbackId = video.requestVideoFrameCallback(observe);
    });
  }

  _waitForMedia(operation, target, eventName, predicate, message) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = error => {
        if (settled) return;
        settled = true;
        if (timer !== null) this._clearTimer(timer);
        target.removeEventListener?.(eventName, onEvent);
        const index = operation.cancellations.indexOf(cancel);
        if (index >= 0) operation.cancellations.splice(index, 1);
        if (error) reject(error);
        else resolve();
      };
      const onEvent = () => {
        try {
          this._assertCurrent(operation);
          if (predicate()) finish();
        } catch (error) { finish(error); }
      };
      const cancel = () => finish(new Error("Stale investigation operation."));
      operation.cancellations.push(cancel);
      timer = this._setTimer(() => finish(new Error(message)), this._readinessTimeoutMs);
      target.addEventListener?.(eventName, onEvent);
      Promise.resolve().then(onEvent);
    });
  }

  _waitForHlsEvent(operation, session, eventName, label, predicate) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = error => {
        if (settled) return;
        settled = true;
        if (timer !== null) this._clearTimer(timer);
        session.hls.off(eventName, onEvent);
        session.hls.off(session.hls.constructor.Events.ERROR, onError);
        const index = operation.cancellations.indexOf(cancel);
        if (index >= 0) operation.cancellations.splice(index, 1);
        if (error) reject(error);
        else resolve();
      };
      const onEvent = (_event, data) => {
        if (predicate(data)) finish();
      };
      const onError = (_event, data) => {
        if (data?.fatal) finish(new Error(`Investigation ${label} failed.`));
      };
      const cancel = () => finish(new Error("Stale investigation operation."));
      operation.cancellations.push(cancel);
      timer = this._setTimer(
        () => finish(new Error(`Investigation ${label} timed out.`)),
        this._readinessTimeoutMs
      );
      session.hls.on(eventName, onEvent);
      session.hls.on(session.hls.constructor.Events.ERROR, onError);
      session.hlsListeners.push([eventName, onEvent]);
      session.hlsListeners.push([session.hls.constructor.Events.ERROR, onError]);
    });
  }

  _commitPosition(operation, session, observation, resolvedEpoch) {
    this._assertCurrent(operation);
    this._requestedEpoch = operation.requestedEpoch;
    this._resolvedEpoch = resolvedEpoch;
    this._acceptRepresentedObservation(session, observation);
    session.requiresVisibleRevalidation = false;
    this._resolutionReason = operation.resolutionReason;
    this._positionKind = "covered";
    this._playing = false;
    operation.representedEpoch = observation.representedEpoch;
    operation.mappedRepresentedEpoch = observation.representedEpoch;
    operation.mappingErrorSeconds = observation.representedEpoch - resolvedEpoch;
    operation.mediaCurrentTime = Number(session.video.currentTime);
    operation.actualPlaybackRate = Number(session.video.playbackRate);
    operation.buffered = snapshotTimeRanges(session.video.buffered);
    operation.seekable = snapshotTimeRanges(session.video.seekable);
    this._captureQuality(operation, session.video);
    this._status = `Representing ${observation.representedEpoch}`;
  }

  async _resumeCommitted(operation, reason) {
    this._assertCurrent(operation);
    const session = this._activeSession;
    if (!session) throw new Error("No committed presentation is available to play.");
    session.video.defaultPlaybackRate = this._playbackRate;
    session.video.playbackRate = this._playbackRate;
    operation.requestedEpoch = operation.requestedEpoch ?? this._requestedEpoch;
    operation.resolvedEpoch = operation.resolvedEpoch ?? this._resolvedEpoch;
    operation.representedEpoch = this._representedEpoch;
    operation.resolutionReason = reason;
    operation.presentationId = session.presentationId;
    operation.sessionId = session.id;
    operation.requestedPlaybackRate = this._playbackRate;
    operation.timings.playStartMs = nowEpochMs(this._now);
    operation.playStartRepresentedEpoch = this._representedEpoch;
    operation.playStartWallMs = operation.timings.playStartMs;
    await Promise.resolve(session.video.play());
    this._assertCurrent(operation);
    operation.timings.playCompleteMs = nowEpochMs(this._now);
    operation.actualPlaybackRate = Number(session.video.playbackRate);
    this._playing = true;
    this._positionKind = "covered";
    this._status = `Playing at ${this._playbackRate}x`;
    this._startFrameObservation(session, operation);
    return this._finishOperation(operation, "committed-playing", reason);
  }

  _pauseActive() {
    this._playing = false;
    if (this._activeSession?.video) {
      try { this._activeSession.video.pause(); } catch {}
    }
    this._emit();
  }

  _startFrameObservation(session, measurementOperation) {
    if (session.frameCallbackId !== null) {
      try { session.video.cancelVideoFrameCallback(session.frameCallbackId); } catch {}
    }
    session.pauseDrainOperation = null;
    const observe = (wallMs, metadata = {}) => {
      session.frameCallbackId = null;
      const pauseOperation = session.pauseDrainOperation;
      const pauseDrain = !this._playing && pauseOperation === this._currentOperation &&
        pauseOperation?.intent === "pause" && session === this._activeSession;
      if (session.destroyed || session !== this._activeSession ||
          (!this._playing && !pauseDrain) || session.requiresVisibleRevalidation || this._hold) {
        session.pauseDrainOperation = null;
        return;
      }
      let mapped = null;
      try { mapped = mediaToEpoch(session.presentation, Number(metadata.mediaTime)); } catch {}
      const observation = this._frameObservation(
        session, wallMs, metadata, mapped && !mapped.isBoundary ? mapped : null
      );
      if (!mapped || mapped.isBoundary) {
        const boundaryOperation = pauseDrain ? pauseOperation : measurementOperation;
        session.pauseDrainOperation = null;
        this._recordFrame(boundaryOperation, observation);
        if (mapped?.isBoundary && this._reconcilePreparedSuccessorAtBoundary(
          session,
          "rvfc-exact-boundary",
          { boundaryReached: true, observedMediaTime: metadata.mediaTime }
        )) return;
        this._stopAtLogicalBoundary(session, boundaryOperation);
        return;
      }
      if (mapped) {
        this._acceptRepresentedObservation(session, observation);
        this._positionKind = "covered";
        this._maybePrepareSuccessor(session, observation.representedEpoch);
        this._recordOutgoingTransitionFrame(session, observation);
        this._recordPostCommitTransitionFrame(session, observation);
        this._refreshArtificialBoundaryDeadline(session, "active-rvfc");
      }
      const observationOperation = pauseDrain ? pauseOperation : measurementOperation;
      this._recordFrame(observationOperation, observation);
      observationOperation.representedEpoch = this._representedEpoch;
      observationOperation.mappedRepresentedEpoch = this._representedEpoch;
      observationOperation.mediaCurrentTime = Number(session.video.currentTime);
      observationOperation.buffered = snapshotTimeRanges(session.video.buffered);
      observationOperation.seekable = snapshotTimeRanges(session.video.seekable);
      observationOperation.actualPlaybackRate = Number(session.video.playbackRate);
      this._captureQuality(observationOperation, session.video);
      if (pauseDrain) {
        session.pauseDrainOperation = null;
        this._requestedEpoch = this._representedEpoch;
        this._resolvedEpoch = this._representedEpoch;
        pauseOperation.requestedEpoch = this._representedEpoch;
        pauseOperation.resolvedEpoch = this._representedEpoch;
        pauseOperation.resolutionReason = "pause-at-presented-frame";
        this._status = "Paused at presented frame";
        this._emit();
        return;
      }
      if (session.presentation.logical_media_end_position - Number(metadata.mediaTime) <=
          SEEK_TOLERANCE_SECONDS) {
        this._ensureHold(session);
        if (this._reconcilePreparedSuccessorAtBoundary(
          session,
          "rvfc-near-boundary",
          { boundaryReached: true, observedMediaTime: metadata.mediaTime }
        )) return;
        this._stopAtLogicalBoundary(session, measurementOperation);
        return;
      }
      this._emit();
      session.frameCallbackId = session.video.requestVideoFrameCallback(observe);
    };
    session.frameCallbackId = session.video.requestVideoFrameCallback(observe);
  }

  _frameObservation(session, wallMs, metadata, mapped) {
    return {
      atMs: Number(wallMs),
      mediaTime: Number(metadata?.mediaTime),
      representedEpoch: mapped?.epoch ?? null,
      presentedFrames: Number.isFinite(Number(metadata?.presentedFrames))
        ? Number(metadata.presentedFrames)
        : null,
      expectedDisplayTime: Number.isFinite(Number(metadata?.expectedDisplayTime))
        ? Number(metadata.expectedDisplayTime)
        : null,
      processingDuration: Number.isFinite(Number(metadata?.processingDuration))
        ? Number(metadata.processingDuration)
        : null,
      sessionId: session.id,
      presentationId: session.presentationId
    };
  }

  _acceptRepresentedObservation(session, observation) {
    if (!Number.isFinite(Number(observation?.representedEpoch)) ||
        observation.sessionId !== session.id ||
        observation.presentationId !== session.presentationId) return false;
    this._representedEpoch = Number(observation.representedEpoch);
    this._representedObservedAtMs = Number.isFinite(Number(observation.atMs))
      ? Number(observation.atMs)
      : null;
    this._latestFrameObservation = { ...observation };
    return true;
  }

  _recordFrame(operation, observation) {
    if (!operation || !observation) return;
    operation.presentedFrameObservations.push(observation);
    if (operation.presentedFrameObservations.length > this._frameObservationLimit) {
      operation.presentedFrameObservations.shift();
    }
    if (Number.isFinite(observation.presentedFrames)) {
      operation.presentedFrameCount = observation.presentedFrames;
    }
    const first = operation.presentedFrameObservations[0];
    const last = operation.presentedFrameObservations.at(-1);
    const baselineEpoch = Number.isFinite(operation.playStartRepresentedEpoch)
      ? operation.playStartRepresentedEpoch
      : first?.representedEpoch;
    const baselineMs = Number.isFinite(operation.playStartWallMs)
      ? operation.playStartWallMs
      : first?.atMs;
    if (Number.isFinite(baselineEpoch) && Number.isFinite(last?.representedEpoch) &&
        Number.isFinite(baselineMs) && Number.isFinite(last?.atMs)) {
      operation.representedAdvancementSeconds = last.representedEpoch - baselineEpoch;
      operation.observationElapsedMs = last.atMs - baselineMs;
      operation.achievedRepresentedRate = operation.observationElapsedMs > 0
        ? operation.representedAdvancementSeconds / (operation.observationElapsedMs / 1000)
        : null;
    }
  }

  _captureQuality(operation, video) {
    if (typeof video?.getVideoPlaybackQuality !== "function") return;
    try {
      const quality = video.getVideoPlaybackQuality();
      operation.droppedVideoFrames = Number(quality?.droppedVideoFrames) || 0;
      operation.totalVideoFrames = Number(quality?.totalVideoFrames) || 0;
    } catch {}
  }

  _stopAtLogicalBoundary(session, operation) {
    if (session !== this._activeSession) return;
    this._playing = false;
    try { session.video.pause(); } catch {}
    if (session.frameCallbackId !== null) {
      try { session.video.cancelVideoFrameCallback?.(session.frameCallbackId); } catch {}
      session.frameCallbackId = null;
    }
    if (this._hold?.sessionId !== session.id) {
      this._representedEpoch = null;
      this._representedObservedAtMs = null;
      this._latestFrameObservation = null;
      this._positionKind = "uncovered";
      this._status = "Logical presentation exhausted without a retained validated image";
    } else {
      this._representedEpoch = this._hold.representedEpoch;
      this._positionKind = "covered";
      this._boundaryHoldStartedAtMs ??= nowEpochMs(this._now);
      const coverage = this._coverageAfterBoundary(session.presentation.logical_wall_end);
      this._coverageBoundary = coverage;
      this._status = coverage.state === "continuous-successor-available"
        ? "Artificial presentation boundary; waiting for truthful successor"
        : coverage.state === "genuine-recording-gap-with-future"
          ? "Recording gap follows; holding last represented frame"
          : "Recording ended; holding last represented frame";
    }
    session.requiresVisibleRevalidation = true;
    operation.representedEpoch = this._representedEpoch;
    operation.resolutionReason = "logical-presentation-exhausted";
    this._emit();
  }

  _markSessionForVisibleRevalidation(session) {
    if (!session || session !== this._activeSession) return;
    session.pauseDrainOperation = null;
    session.requiresVisibleRevalidation = true;
    this._playing = false;
    try { session.video.pause(); } catch {}
  }

  _ensureHold(session) {
    if (this._hold) return this._hold;
    if (typeof this._captureHoldFrame !== "function") {
      throw new Error("A truthful visible-frame hold is required before an in-map seek.");
    }
    if (!Number.isFinite(this._representedEpoch)) {
      throw new Error("A represented frame is required before a visible hold can be created.");
    }
    const hold = this._captureHoldFrame(session.video);
    if (!hold || typeof hold.destroy !== "function") {
      throw new Error("The visible-frame hold could not be established.");
    }
    hold.representedEpoch = this._representedEpoch;
    hold.sessionId = session.id;
    hold.presentationId = session.presentationId;
    const transitionTiming = this._ownedTransitionTiming();
    if (transitionTiming && transitionTiming.outgoingSessionId === session.id &&
        transitionTiming.outgoingPresentationId === session.presentationId) {
      const createdAtMs = nowEpochMs(this._now);
      transitionTiming.hold.createdAtMs ??= createdAtMs;
      hold._transitionTiming = transitionTiming;
    }
    this._hold = hold;
    return hold;
  }

  _clearHold() {
    const hold = this._hold;
    this._hold = null;
    const transitionTiming = hold?._transitionTiming;
    if (transitionTiming && transitionTiming.hold.createdAtMs !== null &&
        transitionTiming.hold.removedAtMs === null) {
      transitionTiming.hold.removedAtMs = nowEpochMs(this._now);
      transitionTiming.hold.durationMs =
        transitionTiming.hold.removedAtMs - transitionTiming.hold.createdAtMs;
    }
    try { hold?.destroy?.(); } catch {}
  }

  _createMediaMetricListeners(session) {
    for (const [name, field] of [["waiting", "waitingEvents"], ["stalled", "stalledEvents"]]) {
      const listener = () => {
        const operation = this._currentOperation;
        if (operation) operation[field] += 1;
        session[field] += 1;
      };
      session.video.addEventListener?.(name, listener);
      session.mediaListeners.push([name, listener]);
    }
    for (const name of ["timeupdate", "ended"]) {
      const listener = () => {
        if (session !== this._activeSession) return;
        const successor = this._successor;
        if ((successor.state !== "preparing" && successor.state !== "ready") ||
            successor.sourceSessionId !== session.id ||
            successor.sourcePresentationId !== session.presentationId) return;
        const currentTime = Number(session.video.currentTime);
        const logicalEnd = Number(session.presentation?.logical_media_end_position);
        if (!Number.isFinite(currentTime) || !Number.isFinite(logicalEnd) || currentTime < logicalEnd) return;
        if (this._reconcilePreparedSuccessorAtBoundary(session, `media-${name}`, {
          boundaryReached: true,
          observedMediaTime: currentTime
        })) return;
        if (session === this._activeSession && this._playing) {
          this._stopAtLogicalBoundary(session, this._currentOperation);
        }
      };
      session.video.addEventListener?.(name, listener);
      session.mediaListeners.push([name, listener]);
    }
  }

  _destroySession(session, { allowActive = false } = {}) {
    if (!session || session.destroyed || (session === this._activeSession && !allowActive)) return false;
    if (this._boundaryDeadline.token?.session === session) {
      this._cancelArtificialBoundaryDeadline("deadline-source-session-destroyed");
    }
    session.destroyed = true;
    session.pauseDrainOperation = null;
    if (session.frameCallbackId !== null) {
      try { session.video.cancelVideoFrameCallback?.(session.frameCallbackId); } catch {}
      session.frameCallbackId = null;
    }
    for (const [event, listener] of session.hlsListeners.splice(0)) {
      try { session.hls.off(event, listener); } catch {}
    }
    for (const [event, listener] of session.mediaListeners.splice(0)) {
      try { session.video.removeEventListener?.(event, listener); } catch {}
    }
    try { session.video.pause?.(); } catch {}
    try { session.hls.destroy?.(); } catch {}
    try {
      session.video.removeAttribute?.("src");
      session.video.load?.();
    } catch {}
    this._counts.destroyed += 1;
    this._onSessionDestroyed?.(session);
    return true;
  }

  _finishOperation(operation, disposition, reason) {
    if (operation !== this._currentOperation || !operation.pending) return false;
    operation.pending = false;
    operation.disposition = disposition;
    operation.resolutionReason = reason ?? operation.resolutionReason;
    operation.endedAtMs = nowEpochMs(this._now);
    operation.operationLatencyMs = operation.endedAtMs - operation.startedAtMs;
    operation.firstPresentedFrameLatencyMs = Number.isFinite(operation.timings.firstPresentedFrameCompleteMs)
      ? operation.timings.firstPresentedFrameCompleteMs - operation.startedAtMs
      : null;
    operation.counts = { ...this._counts };
    if (this._activeSession) {
      operation.mediaCurrentTime = Number(this._activeSession.video.currentTime);
      operation.buffered = snapshotTimeRanges(this._activeSession.video.buffered);
      operation.seekable = snapshotTimeRanges(this._activeSession.video.seekable);
      operation.actualPlaybackRate = Number(this._activeSession.video.playbackRate);
      this._captureQuality(operation, this._activeSession.video);
    }
    this._emit();
    return true;
  }

  _failOperation(operation, error) {
    if (operation !== this._currentOperation || !operation.pending) return false;
    const stale = /stale investigation operation/i.test(String(error?.message));
    operation.error = stale ? null : safeError(error);
    this._status = stale ? "Operation superseded" : operation.error;
    this._finishOperation(
      operation,
      stale ? "stale-rejected" : "failed",
      stale ? "superseded-by-newer-operation" : operation.resolutionReason ?? "operation-failed"
    );
    return false;
  }

  _emit() {
    try { this._onStateChange?.(this.state); } catch {}
  }
}
