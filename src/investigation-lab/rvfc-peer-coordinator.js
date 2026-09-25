const SAFE_CAMERA_ID = /^[A-Za-z0-9_-]+$/;
const finite = value => value === null || value === undefined || value === ""
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const identity = state => state?.activeSessionId == null || state?.activePresentationId == null
  ? null : `${state.activeSessionId}:${state.activePresentationId}`;
const bands = () => ({ "in-band": 0, "mild-divergence": 0, "reacquisition-candidate": 0 });

export const INVESTIGATION_PEER_SYNC_POLICY = Object.freeze({
  observationLimit: 512,
  uiEmitIntervalMs: 250,
  inBandSeconds: 0.5,
  mildDivergenceSeconds: 2,
  achievedRateWindowMs: 5000,
  achievedRateSampleLimit: 64,
  maximumPlaybackRate: 16
});

const percentile = (sorted, fraction) => !sorted.length ? null :
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];

export class InvestigationRvfcPeerCoordinator {
  constructor({
    renderers,
    clockHolderCamera = null,
    ownerGeneration = null,
    now = () => performance.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer),
    getVisibilityState = () => globalThis.document?.visibilityState ?? null,
    onStateChange = null,
    syncPolicy = INVESTIGATION_PEER_SYNC_POLICY
  } = {}) {
    if (!Array.isArray(renderers) || renderers.length !== 2) {
      throw new Error("The synchronization experiment requires exactly two peer renderers.");
    }
    const cameras = renderers.map(peer => peer?.camera);
    if (new Set(cameras).size !== 2 || cameras.some(camera =>
      typeof camera !== "string" || !SAFE_CAMERA_ID.test(camera))) {
      throw new Error("The synchronization experiment requires two distinct safe camera IDs.");
    }
    if (renderers.some(peer => !peer?.renderer)) {
      throw new Error("Each synchronization peer requires a renderer.");
    }
    const holder = clockHolderCamera ?? cameras[0];
    if (!cameras.includes(holder)) throw new Error("Clock-holder camera must be one of the peers.");
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._visibility = getVisibilityState;
    this._onStateChange = onStateChange;
    this._policy = Object.freeze({ ...INVESTIGATION_PEER_SYNC_POLICY, ...syncPolicy });
    this._ownerGeneration = ownerGeneration;
    this._clockHolderCamera = holder;
    this._peers = renderers.map(item => ({
      camera: item.camera,
      renderer: item.renderer,
      ownerGeneration: item.ownerGeneration ?? ownerGeneration,
      role: item.camera === holder ? "clock-holder" : "follower",
      state: item.renderer.state ?? null,
      identity: null,
      retired: [],
      lastObservedAtMs: null,
      lastTransitionCount: 0,
      samples: []
    }));
    this._revision = 0;
    this._operation = null;
    this._requestedEpoch = null;
    this._resolvedEpoch = null;
    this._playbackEpoch = null;
    this._initialEpoch = null;
    this._nominalRate = 1;
    this._playing = false;
    this._authorityStatus = "awaiting-truthful-frames";
    this._clockHolderFailure = null;
    this._observations = [];
    this._aggregate = {
      observationCount: 0,
      minErrorSeconds: null,
      maxErrorSeconds: null,
      sumAbsoluteErrorSeconds: 0,
      bandCounts: bands(),
      bandDurationMs: bands(),
      previousBand: null,
      previousBandAtMs: null,
      correctionCounts: { speedUp: 0, slowDown: 0, pause: 0, reacquire: 0 },
      reacquisitionCandidateCount: 0,
      staleObservationRejectCount: 0,
      ownershipRejectCount: 0
    };
    this._emitTimer = null;
    this._destroyed = false;
    for (const peer of this._peers) {
      this.observeCamera(peer.camera, peer.renderer.state, {
        ownerGeneration: peer.ownerGeneration,
        emit: false
      });
    }
  }

  get state() {
    const follower = this._follower();
    const followerEpoch = finite(follower.state?.representedEpoch);
    const error = followerEpoch === null || this._playbackEpoch === null
      ? null : followerEpoch - this._playbackEpoch;
    return Object.freeze({
      revision: this._revision,
      operationId: this._operation?.id ?? null,
      operationIntent: this._operation?.intent ?? null,
      operationDisposition: this._operation?.disposition ?? null,
      requestedEpoch: this._requestedEpoch,
      resolvedEpoch: this._resolvedEpoch,
      playbackEpoch: this._playbackEpoch,
      incidentEpoch: this._playbackEpoch,
      playing: this._playing,
      nominalPlaybackRate: this._nominalRate,
      clockHolderCamera: this._clockHolderCamera,
      followerCamera: follower.camera,
      followerErrorSeconds: error,
      followerErrorBand: error === null ? null : this._classify(error),
      authorityStatus: this._authorityStatus,
      clockHolderFailure: this._clockHolderFailure
        ? Object.freeze({ ...this._clockHolderFailure }) : null,
      status: this._operation?.status ?? "Idle",
      peers: Object.freeze(this._peers.map(peer => this._peerState(peer)))
    });
  }

  getDiagnosticReport() {
    const errors = this._observations.map(item => Math.abs(item.errorSeconds)).sort((a, b) => a - b);
    const duration = { ...this._aggregate.bandDurationMs };
    if (this._playing && this._aggregate.previousBand && this._aggregate.previousBandAtMs !== null) {
      duration[this._aggregate.previousBand] += Math.max(0, this._now() - this._aggregate.previousBandAtMs);
    }
    return {
      schema: 1,
      mode: "two-peer-rvfc-clock-holder-observation",
      state: this.state,
      synchronizationPolicy: this._policy,
      errorSignConvention: "followerRepresentedEpoch - playbackEpoch; positive is ahead, negative is behind",
      correctionPolicy: "observation-only; no rate correction and no automatic reacquisition",
      aggregate: {
        observationCount: this._aggregate.observationCount,
        retainedObservationCount: this._observations.length,
        minErrorSeconds: this._aggregate.minErrorSeconds,
        maxErrorSeconds: this._aggregate.maxErrorSeconds,
        meanAbsoluteErrorSeconds: this._aggregate.observationCount
          ? this._aggregate.sumAbsoluteErrorSeconds / this._aggregate.observationCount : null,
        p50AbsoluteErrorSeconds: percentile(errors, 0.50),
        p90AbsoluteErrorSeconds: percentile(errors, 0.90),
        p95AbsoluteErrorSeconds: percentile(errors, 0.95),
        bandCounts: { ...this._aggregate.bandCounts },
        bandDurationMs: duration,
        correctionCounts: { ...this._aggregate.correctionCounts },
        reacquisitionCandidateCount: this._aggregate.reacquisitionCandidateCount,
        staleObservationRejectCount: this._aggregate.staleObservationRejectCount,
        ownershipRejectCount: this._aggregate.ownershipRejectCount
      },
      observations: this._observations.map(item => ({ ...item })),
      peers: this._peers.map(peer => ({
        camera: peer.camera,
        role: peer.role,
        ownerGeneration: peer.ownerGeneration,
        achievedRepresentedRate: this._achievedRate(peer),
        engine: peer.renderer.getDiagnosticReport?.() ?? null
      }))
    };
  }

  observeCamera(camera, state, options = {}) {
    if (typeof options === "boolean") options = { emit: options };
    const peer = this._peers.find(item => item.camera === camera);
    if (this._destroyed || !peer || !state) return false;
    const generation = options.ownerGeneration ?? peer.ownerGeneration;
    if (peer.ownerGeneration != null && generation !== peer.ownerGeneration ||
        state.camera && state.camera !== camera) {
      this._aggregate.ownershipRejectCount += 1;
      return false;
    }
    const observedAtMs = finite(state.representedObservedAtMs);
    const representedEpoch = finite(state.representedEpoch);
    const frameIdentity = identity(state);
    const hasFrame = observedAtMs !== null && representedEpoch !== null && frameIdentity !== null;
    if (hasFrame && (peer.retired.includes(frameIdentity) ||
        frameIdentity === peer.identity && peer.lastObservedAtMs !== null &&
        observedAtMs < peer.lastObservedAtMs)) {
      this._aggregate.staleObservationRejectCount += 1;
      return false;
    }
    const newFrame = hasFrame && (observedAtMs !== peer.lastObservedAtMs || frameIdentity !== peer.identity);
    if (newFrame && peer.identity && frameIdentity !== peer.identity) {
      peer.retired.push(peer.identity);
      peer.retired = peer.retired.slice(-16);
      peer.samples = [];
    }
    if (newFrame) {
      peer.identity = frameIdentity;
      peer.lastObservedAtMs = observedAtMs;
    }
    peer.state = state;
    if (newFrame) {
      this._recordRateSample(peer, representedEpoch, observedAtMs);
      if (peer.role === "clock-holder") {
        this._playbackEpoch = representedEpoch;
        this._authorityStatus = "owned-rvfc-frame";
      }
      this._recordObservation(peer, observedAtMs);
    }
    if (peer.role === "clock-holder" && state.playing === false &&
        String(state.coverageBoundary?.state ?? "").startsWith("genuine-recording-")) {
      this._freezeAtGenuineEnd(state.coverageBoundary.state);
    }
    if (peer.role === "clock-holder" && state.successor?.state === "failed") {
      this._freezeAtClockHolderFailure(state);
    }
    if (options.emit !== false) this._scheduleEmit();
    return true;
  }

  async place(epoch) {
    const target = finite(epoch);
    if (target === null) throw new Error("Experiment epoch must be finite.");
    const operation = this._begin("place", target);
    this._playing = false;
    this._clockHolderFailure = null;
    this._requestedEpoch = target;
    this._resolvedEpoch = null;
    this._authorityStatus = "placing-both-peers";
    const results = await this._dispatch(operation, "place", target);
    if (!this._isCurrent(operation)) return false;
    const ready = results.length === 2 && results.every(result => result.ok) &&
      this._peers.every(peer => this._hasTruth(peer));
    if (ready) {
      this._resolvedEpoch = target;
      this._initialEpoch ??= target;
      this._authorityStatus = "both-peers-truthfully-placed";
    }
    return this._finish(operation, ready ? "placed-paused" : "initial-peer-unavailable", results);
  }

  async play() { return this._startBoth("play"); }
  async resume() { return this._startBoth("resume"); }

  pause() {
    const operation = this._begin("pause", this._playbackEpoch);
    this._playing = false;
    const results = this._peers.map(peer => {
      try {
        const ok = peer.renderer.pause() !== false;
        this.observeCamera(peer.camera, peer.renderer.state, { ownerGeneration: peer.ownerGeneration, emit: false });
        return { camera: peer.camera, ok };
      } catch (error) {
        return { camera: peer.camera, ok: false, error: this._safeError(error) };
      }
    });
    this._authorityStatus = "paused-at-truthful-frame";
    return this._finish(operation, results.every(result => result.ok) ? "paused" : "partial-pause", results);
  }

  async backward() { return this.place(this._requiredEpoch() - 10); }
  async forward() { return this.place(this._requiredEpoch() + 10); }
  async reset() { return this._initialEpoch === null ? false : this.place(this._initialEpoch); }

  setPlaybackRate(value) {
    const rate = Number(value);
    if (![0.25, 0.5, 0.75, 1, 2, 4, 8, 16].includes(rate)) {
      throw new Error("Unsupported synchronization experiment playback rate.");
    }
    const operation = this._begin("rate", this._playbackEpoch);
    this._nominalRate = rate;
    const results = this._peers.map(peer => {
      try {
        const ok = peer.renderer.setPlaybackRate(rate) !== false;
        this.observeCamera(peer.camera, peer.renderer.state, { ownerGeneration: peer.ownerGeneration, emit: false });
        return { camera: peer.camera, ok };
      } catch (error) {
        return { camera: peer.camera, ok: false, error: this._safeError(error) };
      }
    });
    return this._finish(operation, results.every(result => result.ok) ? "rate-applied" : "partial-rate", results);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._playing = false;
    this._cancelEmit();
    for (const peer of this._peers) {
      try { peer.renderer.destroy?.(); } catch {}
    }
  }

  async _startBoth(method) {
    const target = this._requiredEpoch();
    const operation = this._begin(method, target);
    if (this._clockHolderFailure) {
      this._authorityStatus = "clock-holder-successor-failed";
      return this._finish(operation, "clock-holder-failure-requires-new-place", []);
    }
    if (!this._peers.every(peer => this._hasTruth(peer))) {
      this._authorityStatus = "startup-barrier-missing-peer-truth";
      return this._finish(operation, "startup-barrier-not-ready", []);
    }
    const results = await this._dispatch(operation, method);
    if (!this._isCurrent(operation)) return false;
    const started = results.length === 2 && results.every(result => result.ok) &&
      this._peers.every(peer => peer.renderer.state?.playing === true);
    if (!started) {
      for (const peer of this._peers) try { peer.renderer.pause?.(); } catch {}
      this._playing = false;
      this._authorityStatus = "startup-barrier-failed";
      return this._finish(operation, "startup-barrier-failed", results);
    }
    this._playing = true;
    this._authorityStatus = "awaiting-clock-holder-rvfc";
    return this._finish(operation, "playing", results);
  }

  async _dispatch(operation, method, ...args) {
    const results = await Promise.all(this._peers.map(async peer => {
      try {
        const result = await peer.renderer[method](...args);
        if (this._isCurrent(operation)) this.observeCamera(peer.camera, peer.renderer.state, {
          ownerGeneration: peer.ownerGeneration,
          emit: false
        });
        return { camera: peer.camera, ok: result !== false };
      } catch (error) {
        return { camera: peer.camera, ok: false, error: this._safeError(error) };
      }
    }));
    return this._isCurrent(operation) ? results : [];
  }

  _begin(intent, requestedEpoch) {
    if (this._operation?.pending) {
      this._operation.pending = false;
      this._operation.disposition = "stale-rejected";
    }
    this._operation = {
      id: ++this._revision, intent, requestedEpoch, pending: true,
      disposition: null, status: `${intent} pending`, cameraResults: []
    };
    this._emit();
    return this._operation;
  }

  _finish(operation, disposition, results) {
    if (!this._isCurrent(operation)) return false;
    operation.pending = false;
    operation.disposition = disposition;
    operation.status = disposition;
    operation.cameraResults = results;
    this._emit();
    return ![
      "initial-peer-unavailable",
      "startup-barrier-not-ready",
      "startup-barrier-failed",
      "clock-holder-failure-requires-new-place"
    ].includes(disposition);
  }

  _isCurrent(operation) { return operation === this._operation && operation.pending; }
  _holder() { return this._peers.find(peer => peer.role === "clock-holder"); }
  _follower() { return this._peers.find(peer => peer.role === "follower"); }
  _requiredEpoch() {
    if (this._playbackEpoch === null) throw new Error("Place both peers before using transport controls.");
    return this._playbackEpoch;
  }
  _hasTruth(peer) {
    const state = peer.state ?? peer.renderer.state;
    return finite(state?.representedEpoch) !== null && finite(state?.representedObservedAtMs) !== null &&
      identity(state) !== null && state?.positionKind !== "uncovered";
  }

  _recordRateSample(peer, representedEpoch, observedAtMs) {
    peer.samples.push({ representedEpoch, observedAtMs });
    const cutoff = observedAtMs - this._policy.achievedRateWindowMs;
    peer.samples = peer.samples.filter(sample => sample.observedAtMs >= cutoff)
      .slice(-this._policy.achievedRateSampleLimit);
  }
  _achievedRate(peer) {
    if (peer.samples.length < 2) return null;
    const first = peer.samples[0];
    const last = peer.samples.at(-1);
    const seconds = (last.observedAtMs - first.observedAtMs) / 1000;
    return seconds > 0 ? (last.representedEpoch - first.representedEpoch) / seconds : null;
  }

  _recordObservation(triggerPeer, observedAtMs) {
    const holder = this._holder();
    const follower = this._follower();
    const followerEpoch = finite(follower.state?.representedEpoch);
    if (this._playbackEpoch === null || followerEpoch === null || !holder.identity || !follower.identity) return;
    const errorSeconds = followerEpoch - this._playbackEpoch;
    const band = this._classify(errorSeconds);
    const now = this._now();
    if (this._playing && this._aggregate.previousBand && this._aggregate.previousBandAtMs !== null) {
      this._aggregate.bandDurationMs[this._aggregate.previousBand] +=
        Math.max(0, now - this._aggregate.previousBandAtMs);
    }
    this._aggregate.previousBand = band;
    this._aggregate.previousBandAtMs = now;
    this._aggregate.observationCount += 1;
    this._aggregate.minErrorSeconds = this._aggregate.minErrorSeconds === null
      ? errorSeconds : Math.min(this._aggregate.minErrorSeconds, errorSeconds);
    this._aggregate.maxErrorSeconds = this._aggregate.maxErrorSeconds === null
      ? errorSeconds : Math.max(this._aggregate.maxErrorSeconds, errorSeconds);
    this._aggregate.sumAbsoluteErrorSeconds += Math.abs(errorSeconds);
    this._aggregate.bandCounts[band] += 1;
    if (band === "reacquisition-candidate") this._aggregate.reacquisitionCandidateCount += 1;
    const holderTransition = finite(holder.state?.transition?.count) ?? 0;
    const followerTransition = finite(follower.state?.transition?.count) ?? 0;
    this._observations.push({
      observedAtMs,
      monotonicRecordedAtMs: now,
      triggerCamera: triggerPeer.camera,
      nominalPlaybackRate: this._nominalRate,
      clockHolderCamera: holder.camera,
      clockHolderGeneration: holder.ownerGeneration,
      clockHolderSessionId: holder.state.activeSessionId ?? null,
      clockHolderPresentationId: holder.state.activePresentationId ?? null,
      clockHolderRepresentedEpoch: this._playbackEpoch,
      followerCamera: follower.camera,
      followerGeneration: follower.ownerGeneration,
      followerSessionId: follower.state.activeSessionId ?? null,
      followerPresentationId: follower.state.activePresentationId ?? null,
      followerRepresentedEpoch: followerEpoch,
      errorSeconds,
      errorBand: band,
      clockHolderActualPlaybackRate: finite(holder.state.effectivePlaybackRate),
      followerActualPlaybackRate: finite(follower.state.effectivePlaybackRate),
      temporaryCorrectiveRate: null,
      action: band === "reacquisition-candidate" ? "observe-reacquisition-candidate" : "observe",
      reason: band === "reacquisition-candidate"
        ? "absolute-peer-error-exceeds-experimental-band" : "owned-rvfc-observation",
      clockHolderSuccessorState: holder.state.successor?.state ?? null,
      followerSuccessorState: follower.state.successor?.state ?? null,
      clockHolderTransitionCount: holderTransition,
      followerTransitionCount: followerTransition,
      clockHolderJustTransitioned: holderTransition > holder.lastTransitionCount,
      followerJustTransitioned: followerTransition > follower.lastTransitionCount,
      clockHolderDeadlineFireCount: finite(holder.state.boundaryDeadline?.fireCount) ?? 0,
      followerDeadlineFireCount: finite(follower.state.boundaryDeadline?.fireCount) ?? 0,
      clockHolderDroppedFrameCount: finite(holder.state.droppedFrameCount),
      followerDroppedFrameCount: finite(follower.state.droppedFrameCount),
      clockHolderWaitingEvents: finite(holder.state.waitingEvents) ?? 0,
      followerWaitingEvents: finite(follower.state.waitingEvents) ?? 0,
      clockHolderStalledEvents: finite(holder.state.stalledEvents) ?? 0,
      followerStalledEvents: finite(follower.state.stalledEvents) ?? 0,
      visibilityState: this._visibility?.() ?? null,
      ownershipValid: true
    });
    holder.lastTransitionCount = Math.max(holder.lastTransitionCount, holderTransition);
    follower.lastTransitionCount = Math.max(follower.lastTransitionCount, followerTransition);
    this._observations = this._observations.slice(-this._policy.observationLimit);
  }

  _classify(error) {
    if (Math.abs(error) <= this._policy.inBandSeconds) return "in-band";
    if (Math.abs(error) <= this._policy.mildDivergenceSeconds) return "mild-divergence";
    return "reacquisition-candidate";
  }

  _peerState(peer) {
    const state = peer.state ?? {};
    const representedEpoch = finite(state.representedEpoch);
    const error = peer.role === "follower" && representedEpoch !== null && this._playbackEpoch !== null
      ? representedEpoch - this._playbackEpoch : null;
    return Object.freeze({
      camera: peer.camera,
      role: peer.role,
      ownerGeneration: peer.ownerGeneration,
      sessionId: state.activeSessionId ?? null,
      presentationId: state.activePresentationId ?? null,
      requestedEpoch: finite(state.requestedEpoch),
      resolvedEpoch: finite(state.resolvedEpoch),
      representedEpoch,
      representedObservedAtMs: finite(state.representedObservedAtMs),
      playing: state.playing === true,
      nominalPlaybackRate: this._nominalRate,
      actualPlaybackRate: finite(state.effectivePlaybackRate),
      achievedRepresentedRate: this._achievedRate(peer),
      errorSeconds: error,
      errorBand: error === null ? null : this._classify(error),
      successorState: state.successor?.state ?? null,
      transitionCount: finite(state.transition?.count) ?? 0,
      waitingEvents: finite(state.waitingEvents) ?? 0,
      stalledEvents: finite(state.stalledEvents) ?? 0,
      droppedFrameCount: finite(state.droppedFrameCount),
      positionKind: state.positionKind ?? null,
      coverageBoundaryState: state.coverageBoundary?.state ?? null,
      status: state.status ?? null
    });
  }

  _freezeAtGenuineEnd(boundaryState) {
    if (!this._playing && this._authorityStatus === "authority-handoff-required") return;
    this._playing = false;
    this._authorityStatus = "authority-handoff-required";
    for (const peer of this._peers) if (peer.role === "follower" && peer.renderer.state?.playing) {
      try { peer.renderer.pause?.(); } catch {}
    }
    if (this._operation) this._operation.status = `${boundaryState}; authority handoff required`;
  }

  _freezeAtClockHolderFailure(state) {
    if (this._clockHolderFailure) return;
    this._playing = false;
    this._authorityStatus = "clock-holder-successor-failed";
    this._clockHolderFailure = Object.freeze({
      camera: this._clockHolderCamera,
      operationId: state.operationId ?? null,
      sourceSessionId: state.successor?.sourceSessionId ?? state.activeSessionId ?? null,
      sourcePresentationId: state.successor?.sourcePresentationId ?? state.activePresentationId ?? null,
      boundaryEpoch: finite(state.successor?.boundaryEpoch),
      reason: state.successor?.error ?? "Clock-holder successor preparation failed."
    });
    for (const peer of this._peers) {
      if (peer.renderer.state?.playing) {
        try { peer.renderer.pause?.(); } catch {}
      }
    }
    if (this._operation) {
      this._operation.disposition = "clock-holder-successor-failed";
      this._operation.status = this._clockHolderFailure.reason;
    }
  }

  _scheduleEmit() {
    if (this._destroyed || this._emitTimer !== null) return;
    this._emitTimer = this._setTimer(() => { this._emitTimer = null; this._emit(); }, this._policy.uiEmitIntervalMs);
    this._emitTimer?.unref?.();
  }
  _cancelEmit() {
    if (this._emitTimer === null) return;
    try { this._clearTimer(this._emitTimer); } catch {}
    this._emitTimer = null;
  }
  _safeError(error) {
    const message = typeof error?.message === "string" ? error.message : "Peer operation failed.";
    return /authSig|bearer|https?:\/\//i.test(message)
      ? "Peer operation failed; details redacted." : message.slice(0, 200);
  }
  _emit() {
    if (this._destroyed) return;
    try { this._onStateChange?.(this.state); } catch {}
  }
}
