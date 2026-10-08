import {
  epochToMedia,
  mediaToEpoch,
  validateHistoricalPresentation
} from "../review/historical-presentation.js?v=__LAB_BUILD__";
import {
  loadInvestigationHls,
  snapshotTimeRanges
} from "./single-camera-engine.js?v=__LAB_BUILD__";

const SAFE_CAMERA_ID = /^[A-Za-z0-9_-]+$/;
const PRESENTATION_BOUNDS_SECONDS = 2 * 60 * 60;
const READINESS_TIMEOUT_MS = 15000;
// Only checks whether the seek operation settled; never authorizes a video frame.
const SEEK_SETTLE_TOLERANCE_SECONDS = 0.05;
const HLS_ERROR_LIMIT = 16;
const SEEK_PROBE_LIMIT = 16;
const VERIFIED_HLS_VERSION = "1.7.2";
const PLAYLIST_TYPES = new Set(["manifest", "level", "audioTrack", "subtitleTrack"]);
export const LONG_VOD_PLAYBACK_RATES = Object.freeze([1, 2, 4, 8, 16]);

export const LONG_VOD_OBSERVATION_POLICY = Object.freeze({
  playbackRate: 1,
  sampleIntervalMs: 1000,
  sampleLimit: 1024,
  stoppedAdvancingAfterMs: 3000
});

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const safeError = error => {
  const message = typeof error?.message === "string" ? error.message : "Long-VOD playback failed.";
  return /authSig\s*=|bearer\s+|https?:\/\/|rtsp:\/\/|[A-Z]:\\|\/media\//i.test(message)
    ? "Long-VOD playback failed; details were redacted."
    : message.slice(0, 240);
};
const diagnosticText = value => {
  if (typeof value !== "string") return null;
  const text = value.slice(0, 160);
  return /authSig\s*=|bearer\s+|https?:\/\/|rtsp:\/\/|[?&](?:token|signature|jwt|password)=/i.test(text)
    ? "[redacted]"
    : text;
};
const safeResponseExcerpt = value => {
  if (typeof value !== "string") return null;
  const excerpt = value.slice(0, 200);
  return /[\\/]|auth|token|password|secret|jwt|signature/i.test(excerpt)
    ? "[redacted]" : excerpt;
};
const diagnosticNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;
const observedNumber = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const failureText = value => typeof value !== "string" ? null :
  /[\\/]|bearer|authsig|token|password|credential|signature|secret/i.test(value)
    ? "[redacted]" : value.slice(0, 240);
const failureValue = value => {
  if (typeof value === "string") return failureText(value);
  if (Array.isArray(value)) return value.map(failureValue);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, failureValue(entry)]));
  return value;
};
const diagnosticFragment = value => value && typeof value === "object" ? {
  type: diagnosticText(value.type),
  sn: diagnosticNumber(value.sn),
  level: diagnosticNumber(value.level),
  cc: diagnosticNumber(value.cc),
  start: diagnosticNumber(value.start),
  duration: diagnosticNumber(value.duration)
} : null;
const hlsFailureSignal = (data, response, error) => {
  if (data?.details === "fragLoadTimeOut" || /timeout/i.test(error?.name ?? "")) return "timeout-signaled";
  if (data?.details === "internalAborted" || /abort/i.test(error?.name ?? "")) return "abort-signaled";
  if (response?.available) return "http-response";
  if (data?.type === "networkError") return "no-http-response-exposed";
  return "unknown";
};
const hlsErrorCategory = data => {
  const type = data?.context?.type;
  if (PLAYLIST_TYPES.has(type) || /manifest|levelLoad/i.test(data?.details ?? "")) return "manifest";
  if (type === "media-fragment" || data?.frag) return "mediaFragment";
  if (type === "key") return "key";
  return "unknown";
};
const percentile = (sorted, fraction) => !sorted.length ? null :
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];

function manifestPath(camera, presentation) {
  return `/api/frigate/vod/${encodeURIComponent(camera)}` +
    `/start/${presentation.requested_wall_start}/end/${presentation.requested_wall_end}/index.m3u8`;
}

function verifiedHlsLoader(Hls) {
  const defaults = Hls?.DefaultConfig;
  const loader = defaults?.loader;
  return Hls?.version === VERIFIED_HLS_VERSION &&
    typeof loader === "function" &&
    typeof loader.prototype?.loadInternal === "function" &&
    String(loader.prototype.loadInternal).includes("XMLHttpRequest") &&
    defaults.progressive === false && !defaults.pLoader && !defaults.fLoader;
}

function requestCategory(context, path) {
  if (PLAYLIST_TYPES.has(context?.type) && path.endsWith(".m3u8")) return "manifest";
  if (context?.type === "media-fragment" && /\.(ts|m4s|mp4)$/.test(path)) {
    return context.frag?.sn === "initSegment" ? "initFragment" : "mediaFragment";
  }
  if (context?.type === "key") return "key";
  return null;
}

function presentationSummary(presentation) {
  return presentation ? {
    camera: presentation.camera,
    selectedEpoch: presentation.selected_epoch,
    resolvedSelectedEpoch: presentation.resolved_selected_epoch,
    requestedWallStart: presentation.requested_wall_start,
    requestedWallEnd: presentation.requested_wall_end,
    logicalWallStart: presentation.logical_wall_start,
    logicalWallEnd: presentation.logical_wall_end,
    effectiveWallStart: presentation.effective_wall_start,
    mediaStartPosition: presentation.media_start_position,
    selectedMediaPosition: presentation.selected_media_position,
    logicalMediaEndPosition: presentation.logical_media_end_position,
    coverageRunStart: presentation.coverage_run.known_start,
    coverageRunEnd: presentation.coverage_run.known_end,
    timeMapSpanCount: presentation.time_map.spans.length
  } : null;
}

export class LongVodTwoPeerExperiment {
  constructor({
    cameras,
    callWS,
    getAuth,
    createVideo,
    createXhr = () => new globalThis.XMLHttpRequest(),
    loadHls = () => loadInvestigationHls(),
    onVideoCreated = null,
    onVideoDestroyed = null,
    onStateChange = null,
    now = () => performance.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer),
    expectedOrigin = globalThis.location?.origin,
    policy = LONG_VOD_OBSERVATION_POLICY
  } = {}) {
    if (!Array.isArray(cameras) || cameras.length < 1 || cameras.length > 2 || new Set(cameras).size !== cameras.length ||
        cameras.some(camera => typeof camera !== "string" || !SAFE_CAMERA_ID.test(camera))) {
      throw new Error("The long-VOD experiment requires one or two distinct safe camera IDs.");
    }
    if (typeof callWS !== "function" || typeof getAuth !== "function" || typeof createVideo !== "function") {
      throw new Error("The long-VOD experiment requires callWS, getAuth, and createVideo adapters.");
    }
    let origin;
    try {
      origin = new URL(expectedOrigin);
    } catch {
      throw new Error("The long-VOD experiment requires a valid Home Assistant origin.");
    }
    if (!(["http:", "https:"].includes(origin.protocol)) || origin.origin !== expectedOrigin) {
      throw new Error("The long-VOD experiment requires a valid Home Assistant origin.");
    }
    this._cameras = [...cameras];
    this._callWS = callWS;
    this._getAuth = getAuth;
    this._expectedOrigin = expectedOrigin;
    this._allowedVodPrefixes = new Set();
    this._createVideo = createVideo;
    this._createXhr = createXhr;
    this._loadHls = loadHls;
    this._onVideoCreated = onVideoCreated;
    this._onVideoDestroyed = onVideoDestroyed;
    this._onStateChange = onStateChange;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._policy = Object.freeze({ ...LONG_VOD_OBSERVATION_POLICY, ...policy, playbackRate: 1 });
    this._playbackRate = 1;
    this._generation = 0;
    this._nextSessionId = 0;
    this._nextPresentationId = 0;
    this._sessions = new Map();
    this._pendingSessions = new Set();
    this._requestedEpoch = null;
    this._initialEpoch = null;
    this._initialRange = null;
    this._labProbe = null;
    this._failedPlacement = null;
    this._seekSerial = 0;
    this._manifestProbeSerial = 0;
    this._manifestProbeXhr = null;
    this._playing = false;
    this._status = "Idle";
    this._operation = null;
    this._destroyed = false;
    this._playStartedAtMs = null;
    this._samples = [];
    this._lastSampleAtMs = null;
    this._aggregate = { count: 0, min: null, max: null, sum: 0, sumAbsolute: 0 };
    this._resources = {
      videoElementsCreated: 0, videoElementsDestroyed: 0,
      hlsInstancesCreated: 0, hlsInstancesDestroyed: 0
    };
    this._authentication = {
      mode: "ha-bearer-per-request", signedPathUsed: false,
      expectedOriginValidated: true, runtimeHlsVersion: null,
      loaderMechanism: "xhrSetup/XhrLoader",
      requestCategoryCounts: { manifest: 0, mediaFragment: 0, initFragment: 0, key: 0 },
      setupSuccessCount: 0, setupFailureCount: 0,
      setupAfterRefreshCount: 0,
      rejectedOriginCount: 0, rejectedRouteCount: 0,
      refreshAttemptCount: 0, refreshSuccessCount: 0, refreshFailureCount: 0
    };
  }

  get state() {
    const reference = this._sessions.get(this._cameras[0]);
    const follower = this._sessions.get(this._cameras[1]);
    const referenceEpoch = finite(reference?.representedEpoch);
    const followerEpoch = finite(follower?.representedEpoch);
    const error = referenceEpoch === null || followerEpoch === null
      ? null : followerEpoch - referenceEpoch;
    return Object.freeze({
      operationId: this._operation?.id ?? null,
      operationIntent: this._operation?.intent ?? null,
      operationDisposition: this._operation?.disposition ?? null,
      status: this._status,
      requestedEpoch: this._requestedEpoch,
      playbackEpoch: referenceEpoch,
      playing: this._playing,
      nominalPlaybackRate: this._playbackRate,
      referenceCamera: this._cameras[0],
      followerCamera: this._cameras[1],
      followerErrorSeconds: error,
      authorityStatus: referenceEpoch === null ? "awaiting-reference-rvfc" : "reference-rvfc-observation",
      peers: Object.freeze(this._cameras.map((camera, index) => {
        const session = this._sessions.get(camera);
        const peerError = index === 0 || error === null ? null : error;
        return Object.freeze({
          camera,
          role: index === 0 ? "observation-reference" : "follower-observation",
          requestedEpoch: this._requestedEpoch,
          resolvedEpoch: finite(session?.placement?.resolvedEpoch ?? session?.presentation?.resolved_selected_epoch),
          representedEpoch: finite(session?.representedEpoch),
          actualPlaybackRate: finite(session?.video?.playbackRate),
          nominalPlaybackRate: this._playbackRate,
          errorSeconds: peerError,
          lifecycle: session?.lifecycle ?? "empty",
          playing: Boolean(session && !session.video.paused),
          sessionId: session?.id ?? null,
          presentationId: session?.presentationId ?? null
        });
      }))
    });
  }

  async place(epoch) {
    return this._place(epoch, null);
  }

  async placeRange(start, end) {
    const range = this._validateLabRange(start, end);
    return this._place(range.start + 15, range);
  }

  _validateLabRange(start, end) {
    const first = finite(start);
    const last = finite(end);
    if (this._cameras.length !== 1 || first === null || last === null ||
        first < 0 || last - first <= 30 || last - first > 5 * 60 * 60) {
      throw new Error("The single-camera Lab range must be 30 seconds to five hours.");
    }
    return { start: first, end: last };
  }

  async countRange(start, end) {
    const range = this._validateLabRange(start, end);
    const generation = ++this._generation;
    const startedAtMs = this._now();
    this._seekSerial += 1;
    this._manifestProbeSerial += 1;
    this._manifestProbeXhr?.abort?.();
    this._manifestProbeXhr = null;
    this._destroySessions();
    this._playing = false;
    this._requestedEpoch = null;
    this._initialEpoch = null;
    this._initialRange = null;
    this._labProbe = {
      camera: this._cameras[0], requestedStart: range.start, requestedEnd: range.end,
      requestedDuration: range.end - range.start, preflight: null,
      preflightLatencyMs: null, preparationError: null
    };
    const operation = this._operation = {
      id: generation, intent: "count-range", disposition: "measuring",
      startedAtMs, completedAtMs: null, error: null
    };
    this._status = "Counting candidate Frigate recording rows";
    this._emit();
    try {
      await this._preflightRange(range, range.start + 15, generation);
      operation.disposition = "counted";
      operation.completedAtMs = this._now();
      this._status = "Covered candidate range counted";
      this._emit();
      return true;
    } catch (error) {
      if (generation === this._generation && !this._destroyed) {
        operation.disposition = "failed";
        operation.completedAtMs = this._now();
        operation.error = safeError(error);
        this._status = operation.error;
        this._emit();
      }
      return false;
    }
  }

  async _preflightRange(range, target, generation) {
    const began = this._now();
    const preflight = await this._callWS({
      type: "frigate_max/lab/vod/preflight", camera: this._cameras[0],
      start: range.start, end: range.end, target
    });
    this._assertCurrent(generation);
    if (preflight?.camera !== this._cameras[0] ||
        preflight.requested_start !== range.start || preflight.requested_end !== range.end ||
        preflight.continuous_coverage !== true ||
        !Number.isSafeInteger(preflight.candidate_recording_row_count) ||
        preflight.candidate_recording_row_count < 1 ||
        !Number.isFinite(preflight.coverage_run?.known_start) ||
        !Number.isFinite(preflight.coverage_run?.known_end) ||
        preflight.coverage_run.known_start > range.start ||
        preflight.coverage_run.known_end < range.end) {
      throw new Error("Long-VOD Lab preflight was invalid.");
    }
    this._labProbe.preflight = {
      candidateRecordingRowCount: preflight.candidate_recording_row_count,
      coverageRunStart: finite(preflight.coverage_run?.known_start),
      coverageRunEnd: finite(preflight.coverage_run?.known_end),
      continuousCoverage: true
    };
    this._labProbe.preflightLatencyMs = this._now() - began;
  }

  async _place(epoch, range) {
    const target = finite(epoch);
    if (target === null) throw new Error("Investigation epoch must be finite.");
    const generation = ++this._generation;
    this._failedPlacement = null;
    const operation = this._operation = {
      id: generation, intent: "place", disposition: "preparing", requestedEpoch: target,
      startedAtMs: this._now(), completedAtMs: null, error: null
    };
    this._playing = false;
    this._seekSerial += 1;
    this._manifestProbeSerial += 1;
    this._manifestProbeXhr?.abort?.();
    this._manifestProbeXhr = null;
    this._labProbe = range ? {
      camera: this._cameras[0], requestedStart: range.start, requestedEnd: range.end,
      requestedDuration: range.end - range.start, preflight: null, preflightLatencyMs: null,
      preparationError: null
    } : null;
    this._status = "Preparing two long VOD presentations";
    this._destroySessions();
    this._emit();
    const prepared = [];
    try {
      if (range) {
        await this._preflightRange(range, target, generation);
      }
      const Hls = await this._loadHls();
      this._assertCurrent(generation);
      if (!Hls?.isSupported?.()) throw new Error("This browser does not support investigation HLS.");
      if (!verifiedHlsLoader(Hls)) throw new Error("The long-VOD experiment requires the verified hls.js 1.7.2 XHR loader.");
      this._authentication.runtimeHlsVersion = Hls.version;
      const sessions = await Promise.all(this._cameras.map(camera =>
        this._prepareCamera(camera, target, generation, Hls, range).then(session => {
          prepared.push(session);
          return session;
        })));
      this._assertCurrent(generation);
      for (const session of sessions) {
        this._pendingSessions.delete(session);
        this._sessions.set(session.camera, session);
      }
      this._requestedEpoch = target;
      this._initialEpoch = target;
      this._initialRange = range;
      this._samples = [];
      this._lastSampleAtMs = null;
      this._aggregate = { count: 0, min: null, max: null, sum: 0, sumAbsolute: 0 };
      operation.disposition = "placed-paused";
      operation.completedAtMs = this._now();
      this._status = "Two long VOD presentations placed and paused";
      for (const session of sessions) this._startFrameObservation(session, generation);
      this._recordPairSample(this._now(), true);
      this._emit();
      return true;
    } catch (error) {
      this._retainFailedPlacement(generation, error);
      for (const session of prepared) this._destroySession(session);
      if (generation === this._generation && !this._destroyed) {
        if (this._labProbe) this._labProbe.preparationError = safeError(error);
        operation.disposition = "failed";
        operation.completedAtMs = this._now();
        operation.error = safeError(error);
        this._status = operation.error;
        this._destroySessions();
        this._emit();
      }
      if (/Stale long-VOD operation/.test(error?.message ?? "")) return false;
      return false;
    }
  }

  setPlaybackRate(rate) {
    if (!LONG_VOD_PLAYBACK_RATES.includes(rate)) {
      throw new Error("Long-VOD playback rate must be 1, 2, 4, 8, or 16.");
    }
    if (this._playing || [...this._sessions.values()].some(session => !session.video.paused)) {
      throw new Error("Pause both peers before changing the experiment rate.");
    }
    this._playbackRate = rate;
    for (const session of this._sessions.values()) session.video.playbackRate = rate;
    this._emit();
    return true;
  }

  async play() {
    if (this._sessions.size !== this._cameras.length) return false;
    this._cancelPendingSeek();
    const generation = this._generation;
    const operation = this._operation = {
      id: generation, intent: "play", disposition: "starting", startedAtMs: this._now(), error: null
    };
    try {
      await Promise.all(this._cameras.map(camera => {
        const session = this._sessions.get(camera);
        const video = session.video;
        video.playbackRate = this._playbackRate;
        session.lifecycle = "playing";
        return video.play();
      }));
      this._assertCurrent(generation);
      this._playing = true;
      this._playStartedAtMs = this._playStartedAtMs ?? this._now();
      operation.disposition = "playing";
      this._status = `Playing two independent long VOD presentations at requested ${this._playbackRate}x`;
      this._emit();
      return true;
    } catch (error) {
      for (const session of this._sessions.values()) {
        session.video.pause?.();
        session.lifecycle = "play-failed-paused";
      }
      this._playing = false;
      operation.disposition = "failed";
      operation.error = safeError(error);
      this._status = operation.error;
      this._emit();
      return false;
    }
  }

  pause() {
    this._cancelPendingSeek();
    for (const session of this._sessions.values()) {
      session.video.pause?.();
      if (!session.lifecycle.includes("end") && !session.lifecycle.includes("error")) {
        session.lifecycle = "paused";
      }
    }
    this._playing = false;
    this._operation = { id: this._generation, intent: "pause", disposition: "paused", startedAtMs: this._now() };
    this._status = "Paused on latest truthfully presented frames";
    this._emit();
    return this._sessions.size === this._cameras.length;
  }

  resume() { return this.play(); }

  async seekAbsolute(epoch) {
    if (this._sessions.size !== this._cameras.length) return false;
    const requestedEpoch = finite(epoch);
    if (requestedEpoch === null) throw new Error("Seek epoch must be finite.");
    const generation = this._generation;
    this._cancelPendingSeek();
    const serial = ++this._seekSerial;
    const startedAtMs = this._now();
    this._playing = false;
    this._failedPlacement = null;
    for (const session of this._sessions.values()) session.video.pause?.();
    const operation = this._operation = {
      id: generation, intent: "seek", disposition: "seeking", requestedEpoch,
      startedAtMs, completedAtMs: null, error: null
    };
    try {
      await Promise.all(this._cameras.map(async camera => {
        const session = this._sessions.get(camera);
        const mapped = epochToMedia(session.presentation, requestedEpoch);
        if (mapped.isBoundary) {
          throw new Error("Seek target is outside truthful logical coverage.");
        }
        if (session.frameCallbackId !== null) {
          session.video.cancelVideoFrameCallback?.(session.frameCallbackId);
          session.frameCallbackId = null;
        }
        const owned = () => generation === this._generation && serial === this._seekSerial &&
          !session.destroyed && this._sessions.get(camera) === session;
        const seeked = this._waitForMedia(session.video, "seeked", () =>
          !session.video.seeking && Math.abs(Number(session.video.currentTime) - mapped.mediaTime) <= SEEK_SETTLE_TOLERANCE_SECONDS,
        generation, "Long-VOD probe seek did not settle.");
        const frame = this._waitForTargetFrame(session, mapped, generation, owned, requestedEpoch);
        session.video.currentTime = mapped.mediaTime;
        await Promise.all([seeked, frame]);
        if (!owned()) throw new Error("Stale long-VOD seek.");
        session.seekProbes.push({
          requestedEpoch, mappedMediaPosition: mapped.mediaTime,
          rvfcMediaTime: session.latestRvfcMediaTime,
          representedEpoch: session.representedEpoch,
          absoluteMappingError: session.representedEpoch - requestedEpoch,
          latencyMs: this._now() - startedAtMs,
          sessionId: session.id, presentationId: session.presentationId,
          videoReplaced: false, hlsReplaced: false
        });
        if (session.seekProbes.length > SEEK_PROBE_LIMIT) session.seekProbes.shift();
        session.lifecycle = "ready-paused";
        this._startFrameObservation(session, generation);
      }));
      this._assertCurrent(generation);
      if (serial !== this._seekSerial) return false;
      this._requestedEpoch = requestedEpoch;
      operation.disposition = "placed-paused";
      operation.completedAtMs = this._now();
      this._status = "Absolute seek placed on truthful frames";
      this._emit();
      return true;
    } catch (error) {
      if (generation === this._generation && serial === this._seekSerial) {
        this._retainFailedPlacement(generation, error);
        this._cancelPendingSeek();
        for (const session of this._sessions.values()) session.video.pause?.();
        operation.disposition = "failed";
        operation.completedAtMs = this._now();
        operation.error = safeError(error);
        this._status = operation.error;
        for (const session of this._sessions.values()) {
          if (session.frameCallbackId === null) this._startFrameObservation(session, generation);
        }
        this._emit();
      }
      return false;
    }
  }

  async probeManifest() {
    const probe = this._labProbe;
    if (this._cameras.length !== 1 || !probe?.preflight?.continuousCoverage) {
      throw new Error("A continuously covered single-camera Lab range is required.");
    }
    const generation = this._generation;
    const serial = ++this._manifestProbeSerial;
    const path = manifestPath(probe.camera, {
      requested_wall_start: probe.requestedStart,
      requested_wall_end: probe.requestedEnd
    });
    this._allowedVodPrefixes.add(path.slice(0, -"index.m3u8".length));
    const startedAtMs = this._now();
    const xhr = this._createXhr();
    this._manifestProbeXhr = xhr;
    const result = {
      attempted: true, status: null, statusText: null, contentType: null,
      contentLengthHeader: null, serverHeader: null, viaHeader: null,
      byteCount: null, segmentCount: null, latencyMs: null,
      errorExcerpt: null, failureSignal: null
    };
    try {
      await this._authenticateHlsRequest(xhr, path, { type: "manifest" });
      this._assertCurrent(generation);
      if (serial !== this._manifestProbeSerial) return false;
      await new Promise(resolve => {
        xhr.onload = resolve;
        xhr.onerror = () => { result.failureSignal = "network-error"; resolve(); };
        xhr.ontimeout = () => { result.failureSignal = "timeout"; resolve(); };
        xhr.onabort = () => { result.failureSignal = "aborted"; resolve(); };
        xhr.timeout = READINESS_TIMEOUT_MS;
        xhr.send();
      });
      if (generation !== this._generation || serial !== this._manifestProbeSerial) return false;
      result.status = diagnosticNumber(xhr.status);
      result.statusText = diagnosticText(xhr.statusText);
      const header = name => diagnosticText(xhr.getResponseHeader?.(name));
      result.contentType = header("Content-Type");
      result.contentLengthHeader = header("Content-Length");
      result.serverHeader = header("Server");
      result.viaHeader = header("Via");
      const body = typeof xhr.responseText === "string" ? xhr.responseText : "";
      if (result.status >= 200 && result.status < 300) {
        result.byteCount = new TextEncoder().encode(body).byteLength;
        result.segmentCount = (body.match(/^#EXTINF:/gm) ?? []).length;
      } else {
        result.failureSignal ??= "http-error";
        result.errorExcerpt = safeResponseExcerpt(body);
      }
    } catch (error) {
      result.failureSignal = safeError(error);
    } finally {
      if (this._manifestProbeXhr === xhr) this._manifestProbeXhr = null;
      if (generation === this._generation && serial === this._manifestProbeSerial) {
        result.latencyMs = this._now() - startedAtMs;
        probe.manifestHttp = result;
        this._emit();
      }
    }
    return result.status >= 200 && result.status < 300;
  }

  reset() { return this._initialEpoch === null ? false :
    this._initialRange ? this.placeRange(this._initialRange.start, this._initialRange.end) : this.place(this._initialEpoch); }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._generation += 1;
    this._seekSerial += 1;
    this._manifestProbeSerial += 1;
    this._manifestProbeXhr?.abort?.();
    this._manifestProbeXhr = null;
    this._destroySessions();
    this._playing = false;
  }

  getDiagnosticReport() {
    const now = this._now();
    const absoluteErrors = this._samples.map(sample => Math.abs(sample.pairErrorSeconds))
      .sort((left, right) => left - right);
    const current = this.state;
    return {
      schema: 1,
      mode: "two-peer-long-vod-observation-only",
      state: current,
      policy: { ...this._policy, playbackRate: this._playbackRate },
      architecture: {
        observationReferenceIsNotProductPrimary: true,
        correction: "none",
        syntheticClock: false,
        stagingPlayers: 0,
        successorPreparation: false,
        sourceTransitionsInScope: false,
        signedPathUsed: false
      },
      authentication: {
        ...this._authentication,
        requestCategoryCounts: { ...this._authentication.requestCategoryCounts }
      },
      labProbe: this._labProbe ? structuredClone(this._labProbe) : null,
      failedPlacement: this._failedPlacement ? structuredClone(this._failedPlacement) : null,
      resources: {
        ...this._resources,
        currentVideoElements: this._resources.videoElementsCreated - this._resources.videoElementsDestroyed,
        currentHlsInstances: this._resources.hlsInstancesCreated - this._resources.hlsInstancesDestroyed
      },
      pair: {
        errorSignConvention: "follower representedEpoch - observation-reference representedEpoch",
        currentErrorSeconds: current.followerErrorSeconds,
        currentAbsoluteErrorSeconds: current.followerErrorSeconds === null
          ? null : Math.abs(current.followerErrorSeconds),
        minimumErrorSeconds: this._aggregate.min,
        maximumErrorSeconds: this._aggregate.max,
        meanErrorSeconds: this._aggregate.count ? this._aggregate.sum / this._aggregate.count : null,
        meanAbsoluteErrorSeconds: this._aggregate.count
          ? this._aggregate.sumAbsolute / this._aggregate.count : null,
        p50AbsoluteErrorSeconds: percentile(absoluteErrors, 0.5),
        p90AbsoluteErrorSeconds: percentile(absoluteErrors, 0.9),
        p95AbsoluteErrorSeconds: percentile(absoluteErrors, 0.95),
        observationCount: this._aggregate.count,
        retainedObservationCount: this._samples.length,
        elapsedWallTimeMs: this._playStartedAtMs === null ? 0 : Math.max(0, now - this._playStartedAtMs)
      },
      peers: this._cameras.map((camera, index) => this._sessionDiagnostic(
        camera, this._sessions.get(camera), index === 0 ? "observation-reference" : "follower-observation", now
      )),
      samples: this._samples.map(sample => ({ ...sample })),
      operation: this._operation ? { ...this._operation } : null
    };
  }

  async _prepareCamera(camera, target, generation, Hls, range = null) {
    const half = PRESENTATION_BOUNDS_SECONDS / 2;
    const began = this._now();
    let raw;
    try { raw = await this._callWS(range ? {
      type: "frigate_max/lab/vod/prepare", camera, target,
      start: range.start, end: range.end
    } : {
      type: "frigate_max/v2/vod/prepare", camera, target,
      bounds_start: Math.max(0, target - half), bounds_end: target + half
    }); } finally {
      if (range && this._labProbe && generation === this._generation) {
        this._labProbe.backendPreparationLatencyMs = this._now() - began;
      }
    }
    this._assertCurrent(generation);
    const presentation = validateHistoricalPresentation(raw, camera);
    if (range && (presentation.requested_wall_start !== range.start ||
        presentation.requested_wall_end !== range.end ||
        presentation.logical_wall_start !== range.start ||
        presentation.logical_wall_end !== range.end)) {
      throw new Error("Long-VOD Lab preparation returned an unexpected range.");
    }
    const mapped = epochToMedia(presentation, target);
    if (mapped.isBoundary) throw new Error("The selected epoch is a non-playable logical boundary.");
    const path = manifestPath(camera, presentation);
    this._allowedVodPrefixes.add(path.slice(0, -"index.m3u8".length));
    const video = this._createVideo(camera);
    if (typeof video?.requestVideoFrameCallback !== "function") {
      throw new Error("Presented-frame evidence requires requestVideoFrameCallback.");
    }
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.defaultPlaybackRate = this._playbackRate;
    video.playbackRate = this._playbackRate;
    const hls = new Hls({
      enableWorker: true, maxBufferLength: 20,
      xhrSetup: (xhr, url, context) => this._authenticateHlsRequest(xhr, url, context)
    });
    if (hls.config?.loader !== Hls.DefaultConfig.loader || hls.config?.progressive !== false ||
        hls.config?.pLoader || hls.config?.fLoader || typeof hls.config?.xhrSetup !== "function") {
      hls.destroy?.();
      throw new Error("The long-VOD HLS loader changed from the verified XHR configuration.");
    }
    const session = {
      camera,
      id: ++this._nextSessionId,
      presentationId: ++this._nextPresentationId,
      presentation,
      video,
      hls,
      lifecycle: "loading",
      frameCallbackId: null,
      pendingFrameWaitCancel: null,
      mediaListeners: [],
      hlsListeners: [],
      destroyed: false,
      representedEpoch: null,
      latestRvfcMediaTime: null,
      latestPresentedFrames: null,
      latestRvfcAtMs: null,
      firstRepresentedEpoch: null,
      totalRvfcObservations: 0,
      waitingCount: 0,
      stalledCount: 0,
      seekingCount: 0,
      seekedCount: 0,
      playingCount: 0,
      pauseCount: 0,
      hlsErrorCount: 0,
      hlsErrors: [],
      createdAtMs: this._now(),
      operationStartedAtMs: this._operation?.startedAtMs ?? null
    };
    session.preparationLatencyMs = this._now() - began;
    session.candidateRecordingRowCount = range ? diagnosticNumber(raw.candidate_recording_row_count) : null;
    session.mappingClipCount = range ? diagnosticNumber(raw.mapping_clip_count) : null;
    session.vodMappingLatencyMs = range ? diagnosticNumber(raw.vod_mapping_latency_ms) : null;
    session.manifest = { latencyMs: null, byteCount: null, segmentCount: null, parsed: false };
    session.mediaReadiness = { loadedMetadataLatencyMs: null, canplayLatencyMs: null, firstTruthfulRvfcLatencyMs: null };
    session.seekProbes = [];
    this._resources.videoElementsCreated += 1;
    this._resources.hlsInstancesCreated += 1;
    this._pendingSessions.add(session);
    this._onVideoCreated?.(session);
    this._wireMetrics(session, Hls);
    try {
      await this._attachAndPlace(session, path, mapped, generation, Hls);
      session.lifecycle = "ready-paused";
      return session;
    } catch (error) {
      this._retainFailedPlacement(generation, error, session);
      this._destroySession(session);
      throw error;
    }
  }

  async _authenticateHlsRequest(xhr, url, context) {
    const metrics = this._authentication;
    try {
      if (typeof url !== "string") throw new Error("Invalid HLS resource.");
      let resource;
      try { resource = new URL(url, this._expectedOrigin); }
      catch { throw new Error("Invalid HLS resource."); }
      if (resource.origin !== this._expectedOrigin || resource.username || resource.password || resource.hash) {
        metrics.rejectedOriginCount += 1;
        throw new Error("Unexpected HLS resource origin.");
      }
      if (![...this._allowedVodPrefixes].some(prefix => resource.pathname.startsWith(prefix)) ||
          resource.searchParams.has("authSig")) {
        metrics.rejectedRouteCount += 1;
        throw new Error("Unexpected HLS resource route.");
      }
      const category = requestCategory(context, resource.pathname);
      if (!category) {
        metrics.rejectedRouteCount += 1;
        throw new Error("Unexpected HLS resource category.");
      }
      let auth;
      try { auth = this._getAuth(); }
      catch { throw new Error("Home Assistant authentication is unavailable."); }
      if (!auth || typeof auth.refreshAccessToken !== "function") {
        throw new Error("Home Assistant authentication is unavailable.");
      }
      let refreshedThisRequest = false;
      try {
        if (auth.expired) {
          metrics.refreshAttemptCount += 1;
          try {
            await auth.refreshAccessToken();
            metrics.refreshSuccessCount += 1;
            refreshedThisRequest = true;
          } catch {
            metrics.refreshFailureCount += 1;
            throw new Error("Home Assistant authentication refresh failed.");
          }
        }
        const token = auth.accessToken;
        if (typeof token !== "string" || !token) {
          throw new Error("Home Assistant access token is unavailable.");
        }
        xhr.open("GET", url, true);
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      } catch {
        throw new Error("Home Assistant HLS authentication setup failed.");
      }
      metrics.requestCategoryCounts[category] += 1;
      metrics.setupSuccessCount += 1;
      if (refreshedThisRequest) metrics.setupAfterRefreshCount += 1;
    } catch {
      metrics.setupFailureCount += 1;
      throw new Error("Home Assistant HLS authentication setup failed.");
    }
  }

  async _attachAndPlace(session, path, mapped, generation, Hls) {
    const manifest = this._waitForHls(session, Hls.Events.MANIFEST_PARSED, generation);
    session.hls.attachMedia(session.video);
    session.sourceStartedAtMs = this._now();
    session.hls.loadSource(path);
    await manifest;
    session.manifest.parsed = true;
    session.manifest.parseLatencyMs = this._now() - session.sourceStartedAtMs;
    await this._waitForMedia(session.video, "progress", () => Number(session.video.seekable?.length) > 0,
      generation, "Long-VOD media did not become seekable.");
    const seeked = this._waitForMedia(session.video, "seeked", () =>
      !session.video.seeking && Math.abs(Number(session.video.currentTime) - mapped.mediaTime) <= SEEK_SETTLE_TOLERANCE_SECONDS,
    generation, "Long-VOD seek did not settle.");
    const frame = this._waitForTargetFrame(session, mapped, generation, undefined, session.presentation.selected_epoch);
    session.video.currentTime = mapped.mediaTime;
    await Promise.all([seeked, frame]);
    session.video.pause?.();
  }

  _waitForTargetFrame(session, mapped, generation, owned = () => !session.destroyed,
    requestedEpoch = mapped.resolvedEpoch) {
    const video = session.video;
    const presentation = session.presentation;
    const spans = presentation.time_map.spans;
    const targetUs = Math.round(mapped.mediaTime * 1_000_000);
    const targetSpan = spans.findIndex(span => targetUs >= span[2] && targetUs < span[3]);
    if (targetSpan < 0) return Promise.reject(new Error("Seek target has no playable mapping span."));
    // A discrete landing may straddle a recording boundary. Use the target's
    // mapped span and its neighbors as a broad association check, not frame precision.
    const seekMediaRange = [spans[Math.max(0, targetSpan - 1)][2] / 1_000_000,
      spans[Math.min(spans.length - 1, targetSpan + 1)][3] / 1_000_000];
    const previousPresentedFrames = session.latestPresentedFrames;
    const placement = session.placement = {
      requestedEpoch, resolvedEpoch: mapped.resolvedEpoch, mappedTargetMediaTime: mapped.mediaTime,
      sessionId: session.id, presentationId: session.presentationId,
      startedAtMs: this._now(), durationMs: null, disposition: "observing", failureReason: null,
      initialRvfcMediaTime: null, initialRepresentedEpoch: null,
      rvfcObservationCount: 0, ignoredStaleFrameCount: 0, seekMediaRange,
      acceptedRvfcMediaTime: null, acceptedRepresentedEpoch: null, acceptedOffsetSeconds: null
    };
    return new Promise((resolve, reject) => {
      let callbackId = null;
      let settled = false;
      const timer = this._setTimer(() => finish(new Error("No consistent long-VOD frame was presented.")), READINESS_TIMEOUT_MS);
      const finish = error => {
        if (settled) return;
        settled = true;
        session.pendingFrameWaitCancel = null;
        this._clearTimer(timer);
        if (callbackId !== null) video.cancelVideoFrameCallback?.(callbackId);
        video.removeEventListener?.("error", onMediaError);
        video.removeEventListener?.("ended", onEnded);
        placement.durationMs = this._now() - placement.startedAtMs;
        placement.disposition = error ? "failed" : "accepted";
        placement.failureReason = error ? failureText(error.message) : null;
        error ? reject(error) : resolve();
      };
      const onMediaError = () => finish(new Error("Media error during target-frame placement."));
      const onEnded = () => finish(new Error("Presentation ended before target-frame placement."));
      session.pendingFrameWaitCancel = error => finish(error ?? new Error("Stale long-VOD seek."));
      video.addEventListener?.("error", onMediaError);
      video.addEventListener?.("ended", onEnded);
      const observe = (wallMs, metadata = {}) => {
        if (settled) return;
        callbackId = null;
        try {
          this._assertCurrent(generation);
          if (!owned() || session.video !== video || session.presentation !== presentation ||
              session.placement !== placement) throw new Error("Stale long-VOD seek.");
          placement.rvfcObservationCount += 1;
          const presentedAt = observedNumber(metadata.presentationTime);
          const presentedFrames = observedNumber(metadata.presentedFrames);
          if ((presentedAt !== null && presentedAt < placement.startedAtMs) ||
              (previousPresentedFrames !== null && presentedFrames !== null && presentedFrames <= previousPresentedFrames)) {
            placement.ignoredStaleFrameCount += 1;
            callbackId = video.requestVideoFrameCallback(observe);
            return;
          }
          const mediaTime = observedNumber(metadata.mediaTime);
          if (mediaTime === null) throw new Error("Presented frame has no valid media time.");
          const mappedFrame = mediaToEpoch(presentation, mediaTime);
          if (mappedFrame.isBoundary || mediaTime < seekMediaRange[0] || mediaTime >= seekMediaRange[1]) {
            throw new Error("Presented frame is outside the requested seek's mapped context.");
          }
          if (Number(video.readyState) < 2) throw new Error("Presented seek frame is not ready.");
          this._acceptFrame(session, wallMs, metadata, mappedFrame.epoch);
          placement.initialRvfcMediaTime = placement.acceptedRvfcMediaTime = mediaTime;
          placement.initialRepresentedEpoch = placement.acceptedRepresentedEpoch = mappedFrame.epoch;
          placement.acceptedOffsetSeconds = mappedFrame.epoch - requestedEpoch;
          session.mediaReadiness.firstTruthfulRvfcLatencyMs ??= this._now() - session.operationStartedAtMs;
          // RVFC can precede seeked. Keep this frame; the caller also waits for
          // the seek to settle before committing a paused Place.
          finish();
        } catch (error) { finish(error); }
      };
      if (video.error) onMediaError();
      else if (video.ended) onEnded();
      else if (session.hlsErrors.some(error => error.fatal)) {
        finish(new Error("Fatal HLS error during target-frame placement."));
      } else callbackId = video.requestVideoFrameCallback(observe);
    });
  }

  _startFrameObservation(session, generation) {
    const placement = session.placement;
    const observe = (wallMs, metadata = {}) => {
      if (session.destroyed || generation !== this._generation || this._destroyed ||
          session.placement !== placement) return;
      session.frameCallbackId = null;
      try {
        const mapped = mediaToEpoch(session.presentation, Number(metadata.mediaTime));
        this._acceptFrame(session, wallMs, metadata, mapped.epoch);
        if (mapped.isBoundary) {
          session.video.pause?.();
          session.lifecycle = "logical-end-held";
          this._playing = false;
          this._status = `${session.camera} reached its truthful long-VOD logical end`;
        }
      } catch {
        session.video.pause?.();
        session.lifecycle = "outside-logical-coverage";
        this._playing = false;
        this._status = `${session.camera} reached unavailable logical media`;
      }
      if (session.camera === this._cameras[1]) this._recordPairSample(wallMs);
      this._emit();
      if (!session.destroyed) session.frameCallbackId = session.video.requestVideoFrameCallback(observe);
    };
    session.frameCallbackId = session.video.requestVideoFrameCallback(observe);
  }

  _acceptFrame(session, wallMs, metadata, representedEpoch) {
    session.latestRvfcMediaTime = finite(metadata.mediaTime);
    session.latestPresentedFrames = finite(metadata.presentedFrames);
    session.latestRvfcAtMs = finite(wallMs) ?? this._now();
    session.representedEpoch = representedEpoch;
    session.firstRepresentedEpoch ??= representedEpoch;
    session.totalRvfcObservations += 1;
  }

  _recordPairSample(wallMs, force = false) {
    const reference = this._sessions.get(this._cameras[0]);
    const follower = this._sessions.get(this._cameras[1]);
    if (!reference || !follower || finite(reference.representedEpoch) === null ||
        finite(follower.representedEpoch) === null) return;
    const observedAtMs = finite(wallMs) ?? this._now();
    if (!force && this._lastSampleAtMs !== null &&
        observedAtMs - this._lastSampleAtMs < this._policy.sampleIntervalMs) return;
    const error = follower.representedEpoch - reference.representedEpoch;
    const sample = {
      observedAtMs,
      requestedPlaybackRate: this._playbackRate,
      elapsedWallTimeMs: this._playStartedAtMs === null ? 0 : Math.max(0, observedAtMs - this._playStartedAtMs),
      referenceRepresentedEpoch: reference.representedEpoch,
      followerRepresentedEpoch: follower.representedEpoch,
      pairErrorSeconds: error,
      referenceMediaTime: reference.latestRvfcMediaTime,
      followerMediaTime: follower.latestRvfcMediaTime,
      referenceCurrentTime: finite(reference.video.currentTime),
      followerCurrentTime: finite(follower.video.currentTime)
    };
    this._lastSampleAtMs = observedAtMs;
    this._samples.push(sample);
    if (this._samples.length > this._policy.sampleLimit) this._samples.splice(0, this._samples.length - this._policy.sampleLimit);
    this._aggregate.count += 1;
    this._aggregate.min = this._aggregate.min === null ? error : Math.min(this._aggregate.min, error);
    this._aggregate.max = this._aggregate.max === null ? error : Math.max(this._aggregate.max, error);
    this._aggregate.sum += error;
    this._aggregate.sumAbsolute += Math.abs(error);
  }

  _wireMetrics(session, Hls) {
    for (const [event, field] of [
      ["loadedmetadata", "loadedMetadataLatencyMs"], ["canplay", "canplayLatencyMs"]
    ]) {
      const listener = () => {
        session.mediaReadiness[field] ??= this._now() - session.operationStartedAtMs;
      };
      session.video.addEventListener?.(event, listener);
      session.mediaListeners.push([event, listener]);
    }
    if (Hls.Events.MANIFEST_LOADED) {
      const onManifestLoaded = (_event, data) => {
        session.manifest.latencyMs = session.sourceStartedAtMs === undefined
          ? null : this._now() - session.sourceStartedAtMs;
        if (typeof data?.data === "string") {
          session.manifest.byteCount = new TextEncoder().encode(data.data).byteLength;
          session.manifest.segmentCount = (data.data.match(/^#EXTINF:/gm) ?? []).length;
        }
      };
      session.hls.on(Hls.Events.MANIFEST_LOADED, onManifestLoaded);
      session.hlsListeners.push([Hls.Events.MANIFEST_LOADED, onManifestLoaded]);
    }
    for (const [event, field] of [
      ["waiting", "waitingCount"], ["stalled", "stalledCount"], ["seeking", "seekingCount"],
      ["seeked", "seekedCount"], ["playing", "playingCount"], ["pause", "pauseCount"]
    ]) {
      const listener = () => { session[field] += 1; };
      session.video.addEventListener?.(event, listener);
      session.mediaListeners.push([event, listener]);
    }
    const onError = (_event, data) => {
      const observedAtMs = this._now();
      const response = data?.response;
      const error = data?.error;
      const responseDiagnostic = {
        available: Boolean(response && typeof response === "object"),
        statusCode: diagnosticNumber(response?.code ?? response?.status),
        statusText: diagnosticText(response?.text ?? response?.statusText)
      };
      session.hlsErrorCount += 1;
      session.hlsErrors.push({
        observedAtMs,
        type: diagnosticText(data?.type),
        details: diagnosticText(data?.details),
        requestCategory: hlsErrorCategory(data),
        fatal: data?.fatal === true,
        response: responseDiagnostic,
        failureSignal: hlsFailureSignal(data, responseDiagnostic, error),
        errorCode: diagnosticNumber(error?.code) ?? diagnosticText(error?.code),
        errorName: diagnosticText(error?.name),
        errorText: diagnosticText(error?.message),
        retryCount: diagnosticNumber(data?.errorAction?.retryCount ?? data?.retryCount),
        maxRetryCount: diagnosticNumber(data?.errorAction?.retryConfig?.maxNumRetry),
        fragment: diagnosticFragment(data?.frag ?? data?.context?.frag),
        mediaTime: finite(session.video.currentTime),
        representedEpoch: session.representedEpoch,
        elapsedSincePlayStartedMs: this._playStartedAtMs === null ? null :
          Math.max(0, observedAtMs - this._playStartedAtMs),
        elapsedSinceOperationStartedMs: session.operationStartedAtMs === null ? null :
          Math.max(0, observedAtMs - session.operationStartedAtMs),
        sessionAgeMs: Math.max(0, observedAtMs - session.createdAtMs)
      });
      if (session.hlsErrors.length > HLS_ERROR_LIMIT) session.hlsErrors.splice(0, session.hlsErrors.length - HLS_ERROR_LIMIT);
      if (data?.fatal) {
        session.lifecycle = "fatal-hls-error";
        this._playing = false;
        this._status = `${session.camera} reported a fatal HLS error`;
        session.pendingFrameWaitCancel?.(new Error("Fatal HLS error during target-frame placement."));
        this._emit();
      }
    };
    session.hls.on(Hls.Events.ERROR, onError);
    session.hlsListeners.push([Hls.Events.ERROR, onError]);
  }

  _waitForHls(session, eventName, generation) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = this._setTimer(() => finish(new Error("Long-VOD manifest timed out.")), READINESS_TIMEOUT_MS);
      const finish = error => {
        if (settled) return;
        settled = true;
        this._clearTimer(timer);
        session.hls.off(eventName, onEvent);
        error ? reject(error) : resolve();
      };
      const onEvent = () => {
        try { this._assertCurrent(generation); finish(); } catch (error) { finish(error); }
      };
      session.hls.on(eventName, onEvent);
    });
  }

  _waitForMedia(target, eventName, predicate, generation, message) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = this._setTimer(() => finish(new Error(message)), READINESS_TIMEOUT_MS);
      const finish = error => {
        if (settled) return;
        settled = true;
        this._clearTimer(timer);
        target.removeEventListener?.(eventName, onEvent);
        error ? reject(error) : resolve();
      };
      const onEvent = () => {
        try { this._assertCurrent(generation); if (predicate()) finish(); }
        catch (error) { finish(error); }
      };
      target.addEventListener?.(eventName, onEvent);
      Promise.resolve().then(onEvent);
    });
  }

  _sessionDiagnostic(camera, session, role, now) {
    if (!session) return { camera, role, lifecycle: "empty", stoppedAdvancing: this._playing };
    let quality = null;
    try { quality = session.video.getVideoPlaybackQuality?.() ?? null; } catch {}
    return {
      camera, role, sessionId: session.id, presentationId: session.presentationId,
      lifecycle: session.lifecycle, presentation: presentationSummary(session.presentation),
      candidateRecordingRowCount: session.candidateRecordingRowCount,
      mappingClipCount: session.mappingClipCount,
      vodMappingLatencyMs: session.vodMappingLatencyMs,
      preparationLatencyMs: session.preparationLatencyMs,
      manifest: { ...session.manifest }, mediaReadiness: { ...session.mediaReadiness },
      seekProbes: session.seekProbes.map(probe => ({ ...probe })),
      placement: session.placement ? { ...session.placement } : null,
      requestedEpoch: session.placement?.requestedEpoch ?? this._requestedEpoch,
      resolvedEpoch: session.placement?.resolvedEpoch ?? session.presentation.resolved_selected_epoch,
      latestRvfcMediaTime: session.latestRvfcMediaTime,
      latestRepresentedEpoch: session.representedEpoch,
      latestPresentedFrames: session.latestPresentedFrames,
      totalRvfcObservations: session.totalRvfcObservations,
      representedAdvancementSeconds: session.firstRepresentedEpoch === null
        ? null : session.representedEpoch - session.firstRepresentedEpoch,
      mediaCurrentTime: finite(session.video.currentTime),
      readyState: finite(session.video.readyState), networkState: finite(session.video.networkState),
      buffered: snapshotTimeRanges(session.video.buffered), seekable: snapshotTimeRanges(session.video.seekable),
      waitingCount: session.waitingCount, stalledCount: session.stalledCount,
      seekingCount: session.seekingCount, seekedCount: session.seekedCount,
      playingCount: session.playingCount, pauseCount: session.pauseCount,
      hlsErrorCount: session.hlsErrorCount,
      hlsErrors: session.hlsErrors.map(error => ({ ...error })),
      requestedPlaybackRate: this._playbackRate, actualPlaybackRate: finite(session.video.playbackRate),
      droppedVideoFrames: finite(quality?.droppedVideoFrames),
      totalVideoFrames: finite(quality?.totalVideoFrames),
      stoppedAdvancing: this._playing && session.latestRvfcAtMs !== null &&
        now - session.latestRvfcAtMs >= this._policy.stoppedAdvancingAfterMs
    };
  }

  _retainFailedPlacement(generation, error, failedSession = null) {
    if (generation !== this._generation || this._destroyed || failedSession?.destroyed) return;
    const reason = failureText(error?.message);
    if (!this._failedPlacement) {
      const now = this._now();
      const target = this._operation?.requestedEpoch ?? null;
      const sessions = [...this._pendingSessions, ...this._sessions.values()];
      this._failedPlacement = {
        operationId: generation, requestedEpoch: target, capturedAtMs: now,
        reason, capturePhase: "before-first-placement-teardown",
        documentVisibility: globalThis.document?.visibilityState ?? null,
        resources: {
          currentVideoElements: this._resources.videoElementsCreated - this._resources.videoElementsDestroyed,
          currentHlsInstances: this._resources.hlsInstancesCreated - this._resources.hlsInstancesDestroyed
        },
        authenticationScope: "experiment-cumulative",
        authentication: structuredClone(this._authentication),
        peers: this._cameras.map((camera, index) => {
          const session = sessions.find(peer => peer.camera === camera && !peer.destroyed);
          if (!session) return { camera, sessionId: null, presentationId: null,
            snapshotAvailable: false, peerRejectionReason: null };
          const video = session.video;
          let quality = null;
          try { quality = video.getVideoPlaybackQuality?.() ?? null; } catch {}
          return {
            ...this._sessionDiagnostic(camera, session,
              index === 0 ? "observation-reference" : "follower-observation", now),
            snapshotAvailable: true, peerRejectionReason: null,
            requestedEpoch: target,
            mappedTargetMediaPosition: session.presentation.selected_media_position,
            paused: typeof video.paused === "boolean" ? video.paused : null,
            ended: typeof video.ended === "boolean" ? video.ended : null,
            latestRvfcAtMs: session.latestRvfcAtMs,
            targetErrorSeconds: session.representedEpoch === null || target === null
              ? null : session.representedEpoch - target,
            videoWidth: observedNumber(video.videoWidth), videoHeight: observedNumber(video.videoHeight),
            mediaCurrentTime: observedNumber(video.currentTime),
            mediaCurrentTimeIsFrameTruth: false,
            readyState: observedNumber(video.readyState), networkState: observedNumber(video.networkState),
            mediaErrorCode: observedNumber(video.error?.code),
            mediaErrorEventCount: null,
            droppedVideoFrames: observedNumber(quality?.droppedVideoFrames),
            totalVideoFrames: observedNumber(quality?.totalVideoFrames),
            corruptedVideoFrames: observedNumber(quality?.corruptedVideoFrames),
            hlsErrors: failureValue(session.hlsErrors)
          };
        })
      };
    }
    if (failedSession) {
      const peer = this._failedPlacement.peers.find(peer => peer.sessionId === failedSession.id);
      if (peer) peer.peerRejectionReason = reason;
    }
  }

  _destroySessions() {
    for (const session of new Set([...this._sessions.values(), ...this._pendingSessions])) {
      this._destroySession(session);
    }
    this._sessions.clear();
    this._pendingSessions.clear();
    this._allowedVodPrefixes.clear();
  }

  _cancelPendingSeek() {
    this._seekSerial += 1;
    for (const session of this._sessions.values()) session.pendingFrameWaitCancel?.();
  }

  _destroySession(session) {
    if (!session || session.destroyed) return;
    session.destroyed = true;
    session.pendingFrameWaitCancel?.();
    this._pendingSessions.delete(session);
    if (session.frameCallbackId !== null) session.video.cancelVideoFrameCallback?.(session.frameCallbackId);
    for (const [event, listener] of session.mediaListeners) session.video.removeEventListener?.(event, listener);
    for (const [event, listener] of session.hlsListeners) session.hls.off?.(event, listener);
    try { session.video.pause?.(); } catch {}
    try { session.hls.destroy?.(); } catch {}
    this._resources.hlsInstancesDestroyed += 1;
    this._resources.videoElementsDestroyed += 1;
    this._onVideoDestroyed?.(session);
  }

  _assertCurrent(generation) {
    if (this._destroyed || generation !== this._generation) throw new Error("Stale long-VOD operation.");
  }

  _emit() { this._onStateChange?.(this.state); }
}
