import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";

import {
  describeInvestigationLocalTime,
  formatInvestigationLocalCivil,
  INVESTIGATION_PLAYBACK_RATES,
  InvestigationPlaybackEngine,
  buildLabAvailabilityWindow,
  inspectLabAvailability,
  normalizeLabAvailability,
  parseInvestigationEpoch,
  resolveBackwardNavigation,
  resolveForwardNavigation,
  resolvePlayNavigation,
  successorPreparationLeadSeconds
} from "../src/investigation-lab/single-camera-engine.js";

const CAMERA = "garage";

function ranges(values = []) {
  return {
    length: values.length,
    start: index => values[index][0],
    end: index => values[index][1]
  };
}

class FakeVideo extends EventTarget {
  constructor({ autoFrame = true, presentFrameBeforeSeeked = false } = {}) {
    super();
    this._currentTime = 0;
    this._nextFrameReady = false;
    this._autoFrame = autoFrame;
    this._presentFrameBeforeSeeked = presentFrameBeforeSeeked;
    this._callbacks = new Map();
    this._nextCallbackId = 0;
    this._presentedFrames = 0;
    this._droppedFrames = 0;
    this.seeking = false;
    this.paused = true;
    this.muted = false;
    this.playsInline = false;
    this.preload = "";
    this.defaultPlaybackRate = 1;
    this.playbackRate = 1;
    this.seekable = ranges();
    this.buffered = ranges();
  }

  get currentTime() { return this._currentTime; }

  set currentTime(value) {
    this._currentTime = Number(value);
    this.seeking = true;
    this._nextFrameReady = true;
    queueMicrotask(() => {
      if (this._presentFrameBeforeSeeked) this.emitAllFrames(this._currentTime);
      this.seeking = false;
      this.dispatchEvent(new Event("seeked"));
      if (this._autoFrame && this._nextFrameReady) {
        queueMicrotask(() => {
          if (this._nextFrameReady) this.emitAllFrames(this._currentTime);
        });
      }
    });
  }

  makeReady() {
    this.seekable = ranges([[0, 3600]]);
    this.buffered = ranges([[0, 120]]);
    this.dispatchEvent(new Event("progress"));
  }

  requestVideoFrameCallback(callback) {
    const id = ++this._nextCallbackId;
    this._callbacks.set(id, callback);
    if (this._autoFrame && this._nextFrameReady) {
      this._nextFrameReady = false;
      queueMicrotask(() => this.emitFrame(this._currentTime, id));
    }
    return id;
  }

  cancelVideoFrameCallback(id) { this._callbacks.delete(id); }

  emitFrame(mediaTime = this._currentTime, onlyId = null, {
    preserveCurrentTime = false,
    wallMs = null,
    expectedDisplayTime = null
  } = {}) {
    const presentedMediaTime = Number(mediaTime);
    if (!preserveCurrentTime) this._currentTime = presentedMediaTime;
    const entry = onlyId === null
      ? this._callbacks.entries().next().value
      : this._callbacks.has(onlyId) ? [onlyId, this._callbacks.get(onlyId)] : null;
    if (!entry) return false;
    const [id, callback] = entry;
    this._callbacks.delete(id);
    this._presentedFrames += 1;
    callback(wallMs === null ? 1000 + this._presentedFrames : Number(wallMs), {
      mediaTime: presentedMediaTime,
      presentedFrames: this._presentedFrames,
      expectedDisplayTime: expectedDisplayTime === null
        ? 1010 + this._presentedFrames
        : Number(expectedDisplayTime),
      processingDuration: 0.002
    });
    return true;
  }

  emitAllFrames(mediaTime = this._currentTime) {
    const presentedMediaTime = Number(mediaTime);
    this._currentTime = presentedMediaTime;
    this._nextFrameReady = false;
    const callbacks = [...this._callbacks.values()];
    this._callbacks.clear();
    if (!callbacks.length) return false;
    this._presentedFrames += 1;
    const metadata = {
      mediaTime: presentedMediaTime,
      presentedFrames: this._presentedFrames,
      expectedDisplayTime: 1010 + this._presentedFrames,
      processingDuration: 0.002
    };
    this._onAllFrames?.(presentedMediaTime);
    for (const callback of callbacks) callback(1000 + this._presentedFrames, metadata);
    return true;
  }

  advanceWithoutFrame(mediaTime, eventName = "timeupdate") {
    this._currentTime = Number(mediaTime);
    this.dispatchEvent(new Event(eventName));
  }

  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() {}
  load() {}
  getVideoPlaybackQuality() {
    return { droppedVideoFrames: this._droppedFrames, totalVideoFrames: this._presentedFrames };
  }
}

class MockHls {
  static Events = { MANIFEST_PARSED: "manifestParsed", ERROR: "error" };
  static isSupported() { return true; }

  constructor() {
    this.listeners = new Map();
    this.destroyed = false;
  }

  on(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }

  off(name, callback) { this.listeners.get(name)?.delete(callback); }

  emit(name, data = {}) {
    for (const callback of [...(this.listeners.get(name) ?? [])]) callback(name, data);
  }

  attachMedia(video) { this.video = video; }

  loadSource(path) {
    this.loadedPath = path;
    queueMicrotask(() => {
      this.video.makeReady();
      this.video.dispatchEvent(new Event("waiting"));
      this.video.dispatchEvent(new Event("stalled"));
      this.emit(MockHls.Events.MANIFEST_PARSED, { fatal: false });
    });
  }

  destroy() { this.destroyed = true; }
}

function presentation(target, halfWidth = 20, camera = CAMERA) {
  const start = target - halfWidth;
  const end = target + halfWidth;
  const durationUs = Math.round((end - start) * 1_000_000);
  return {
    schema: 2,
    camera,
    selected_epoch: target,
    resolved_selected_epoch: target,
    requested_wall_start: start,
    requested_wall_end: end,
    effective_wall_start: start,
    logical_wall_start: start,
    logical_wall_end: end,
    effective_absolute_origin: start,
    media_start_position: 0,
    selected_media_position: target - start,
    logical_media_end_position: end - start,
    coverage_run: {
      known_start: start,
      known_end: end,
      continues_before: false,
      continues_after: false
    },
    time_map: {
      epoch_origin: start,
      unit: "microseconds",
      spans: [[0, durationUs, 0, durationUs]]
    }
  };
}

function upwardRoundedEndpointPresentation(target, halfWidth = 20, camera = CAMERA) {
  const value = presentation(target, halfWidth, camera);
  const rawMediaStart = 1.0000006;
  const quantizedMediaStartUs = 1_000_001;
  return {
    ...value,
    media_start_position: rawMediaStart,
    selected_media_position: rawMediaStart + target - value.logical_wall_start,
    logical_media_end_position: rawMediaStart + value.logical_wall_end - value.logical_wall_start,
    time_map: {
      ...value.time_map,
      spans: value.time_map.spans.map(span => [
        span[0], span[1], span[2] + quantizedMediaStartUs, span[3] + quantizedMediaStartUs
      ])
    }
  };
}

function clipCoverage(coverage, start, end) {
  return coverage.map(([left, right]) => ({
    start: Math.max(left, start),
    end: Math.min(right, end)
  })).filter(interval => interval.start < interval.end);
}

function createHarness({
  coverage = [[0, 10_000]],
  videoFactory,
  prepare,
  readinessTimeoutMs,
  camera = CAMERA,
  ownerGeneration = 1,
  getVisibilityState = () => "visible",
  now,
  setTimer,
  clearTimer
} = {}) {
  const videos = [];
  const sessions = [];
  const commits = [];
  const destroyed = [];
  const signedPaths = [];
  const holds = [];
  const states = [];
  let tick = 0;
  const callWS = async message => {
    if (message.type === "frigate_max/v1/recordings/availability") {
      return {
        camera,
        requested_start: message.start,
        requested_end: message.end,
        coverage: clipCoverage(coverage, message.start, message.end)
      };
    }
    if (message.type === "frigate_max/v2/vod/prepare") {
      return prepare ? prepare(message) : presentation(message.target, 20, camera);
    }
    if (message.type === "auth/sign_path") {
      signedPaths.push(message.path);
      return { path: `/signed/lab.m3u8?authSig=secret-${signedPaths.length}` };
    }
    throw new Error(`Unexpected message type ${message.type}`);
  };
  const engine = new InvestigationPlaybackEngine({
    camera,
    ownerGeneration,
    getVisibilityState,
    callWS,
    createVideo: () => {
      const video = videoFactory ? videoFactory(videos.length) : new FakeVideo();
      videos.push(video);
      return video;
    },
    loadHls: async () => MockHls,
    captureHoldFrame: (video, { visible = true } = {}) => {
      const hold = {
        video,
        visible,
        destroyed: false,
        show() { this.visible = true; },
        hide() { this.visible = false; },
        destroy() { this.destroyed = true; }
      };
      holds.push(hold);
      return hold;
    },
    onSessionCreated: session => {
      session.visible = false;
      sessions.push(session);
    },
    onSessionCommitted: (session, previous) => {
      commits.push({ session, previous, previousWasVisible: previous?.visible ?? null });
      session.visible = true;
      if (previous) previous.visible = false;
    },
    onSessionDestroyed: session => {
      session.visible = false;
      destroyed.push(session);
    },
    onStateChange: state => states.push(state),
    now: now ?? (() => ++tick),
    ...(setTimer === undefined ? {} : { setTimer }),
    ...(clearTimer === undefined ? {} : { clearTimer }),
    ...(readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs })
  });
  return { engine, videos, sessions, commits, destroyed, signedPaths, holds, states };
}

async function settleUntil(predicate, message = "condition did not settle") {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

function createManualClock(startMs = 1000) {
  let value = Number(startMs);
  let nextTimerId = 0;
  const timers = new Map();
  const runDue = () => {
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.atMs <= value)
        .sort((left, right) => left[1].atMs - right[1].atMs || left[0] - right[0])[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].callback();
    }
  };
  return {
    now: () => value,
    setTimer: (callback, delayMs) => {
      const id = ++nextTimerId;
      timers.set(id, { atMs: value + Math.max(0, Number(delayMs) || 0), callback });
      return id;
    },
    clearTimer: id => timers.delete(id),
    get value() { return value; },
    get pendingCount() { return timers.size; },
    advance(ms) {
      value += Number(ms);
      runDue();
    },
    set(ms) {
      value = Number(ms);
      runDue();
    }
  };
}

function createTimedHarness(options = {}) {
  const clock = createManualClock();
  return {
    clock,
    ...createHarness({
      ...options,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
  };
}

function lastOperation(engine) {
  return engine.getDiagnosticReport().operations.at(-1);
}

test("parses absolute input and builds a bounded two-hour availability query", () => {
  assert.equal(parseInvestigationEpoch("1000.25"), 1000.25);
  assert.equal(parseInvestigationEpoch("1970-01-01T00:16:40Z"), 1000);
  assert.deepEqual(buildLabAvailabilityWindow(1000), { start: -2600, end: 4600 });
  assert.throws(() => parseInvestigationEpoch("not-a-time"));
});

test("local civil parsing and formatting follow the runtime timezone with a stable round trip", () => {
  const previousTimeZone = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const pacificEpoch = parseInvestigationEpoch("2026-09-23T08:23:40");
    assert.equal(pacificEpoch, Date.parse("2026-09-23T15:23:40Z") / 1000);
    assert.equal(formatInvestigationLocalCivil(pacificEpoch), "2026-09-23T08:23:40");
    assert.equal(describeInvestigationLocalTime("2026-09-23T08:23:40").utcOffsetMinutes, -420);

    process.env.TZ = "America/New_York";
    const easternEpoch = parseInvestigationEpoch("2026-09-23T08:23:40");
    assert.equal(easternEpoch, Date.parse("2026-09-23T12:23:40Z") / 1000);
    assert.notEqual(easternEpoch, pacificEpoch);
    assert.equal(formatInvestigationLocalCivil(easternEpoch), "2026-09-23T08:23:40");
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});

test("local civil conversion uses native DST rules and rejects nonexistent civil time", () => {
  const previousTimeZone = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const winter = describeInvestigationLocalTime("2026-01-15T08:00:00");
    const summer = describeInvestigationLocalTime("2026-07-15T08:00:00");
    assert.equal(winter.utcOffsetMinutes, -480);
    assert.equal(summer.utcOffsetMinutes, -420);
    assert.throws(() => parseInvestigationEpoch("2026-03-08T02:30:00"), /nonexistent local/);
    assert.equal(parseInvestigationEpoch("2026-09-23T15:23:40Z"), 1790177020);
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});

test("normalizes half-open recording coverage and rejects overlap", () => {
  const availability = normalizeLabAvailability({
    camera: CAMERA, requested_start: 90, requested_end: 220,
    coverage: [{ start: 100, end: 150 }, { start: 160, end: 200 }]
  }, CAMERA);
  assert.equal(inspectLabAvailability(availability, 100).containing.start, 100);
  assert.equal(inspectLabAvailability(availability, 150).containing, null);
  assert.equal(inspectLabAvailability(availability, 200).containing, null);
  assert.throws(() => normalizeLabAvailability({
    camera: CAMERA, requested_start: 90, requested_end: 220,
    coverage: [{ start: 100, end: 170 }, { start: 160, end: 200 }]
  }, CAMERA));
});

test("resolves exact, bounded near-start, forward-crossing, and truthful backward limitation", () => {
  const availability = normalizeLabAvailability({
    camera: CAMERA, requested_start: 90, requested_end: 240,
    coverage: [{ start: 110, end: 200 }, { start: 220, end: 230 }]
  }, CAMERA);
  assert.equal(resolvePlayNavigation(availability, 115).reason, "exact");
  assert.deepEqual(resolvePlayNavigation(availability, 105), {
    requestedEpoch: 105, resolvedEpoch: 110, reason: "play-near-next-start",
    coverage: availability.coverage[0]
  });
  assert.equal(resolvePlayNavigation(availability, 99).reason, "uncovered-no-near-entry");
  assert.equal(resolveForwardNavigation(availability, 105).resolvedEpoch, 110);
  assert.equal(resolveForwardNavigation(availability, 105).reason, "forward-crossed-start");
  assert.equal(resolveBackwardNavigation(availability, 205).reason, "backward-crossed-end-unresolved");
});

test("Place keeps requested, resolved, and represented time distinct in a gap", async () => {
  const harness = createHarness({ coverage: [[100, 120], [140, 200]] });
  assert.equal(await harness.engine.place(110), true);
  assert.equal(harness.engine.state.representedEpoch, 110);
  assert.equal(await harness.engine.place(130), true);
  assert.equal(harness.engine.state.requestedEpoch, 130);
  assert.equal(harness.engine.state.resolvedEpoch, null);
  assert.equal(harness.engine.state.representedEpoch, 110);
  assert.equal(harness.engine.state.positionKind, "uncovered");
  assert.equal(lastOperation(harness.engine).disposition, "uncovered");
});

test("reacquire reports unavailable without treating a retained truthful frame as acquired", async () => {
  const harness = createHarness({ coverage: [[100, 120], [140, 200]] });
  await harness.engine.place(110);
  const outcome = await harness.engine.reacquire(130);
  assert.deepEqual(outcome, {
    outcome: "unavailable",
    completed: true,
    operationId: 2,
    targetEpoch: 130,
    resolvedEpoch: null,
    representedEpoch: 110,
    sessionId: null,
    presentationId: null
  });
  assert.equal(harness.engine.state.representedEpoch, 110);
  assert.equal(harness.engine.state.playing, false);
});

test("reacquire reports acquired only after this operation presents its target frame", async () => {
  const harness = createHarness();
  await harness.engine.place(100);
  const outcome = await harness.engine.reacquire(105);
  assert.equal(outcome.outcome, "acquired");
  assert.equal(outcome.targetEpoch, 105);
  assert.equal(outcome.resolvedEpoch, 105);
  assert.equal(outcome.representedEpoch, 105);
  assert.equal(outcome.sessionId, harness.engine.state.activeSessionId);
  assert.equal(outcome.presentationId, harness.engine.state.activePresentationId);
  assert.equal(harness.engine.state.playing, false);
});

test("reacquire reports acquired only after a replacement staging candidate commits", async () => {
  const harness = createHarness();
  await harness.engine.place(100);
  const previousSessionId = harness.engine.state.activeSessionId;
  const outcome = await harness.engine.reacquire(200);
  assert.equal(outcome.outcome, "acquired");
  assert.equal(outcome.representedEpoch, 200);
  assert.notEqual(outcome.sessionId, previousSessionId);
  assert.equal(harness.engine.state.activeSessionId, outcome.sessionId);
  assert.equal(harness.engine.state.counts.replaced, 1);
});

test("covered Place integrates V2 epoch/media mapping and presented-frame authority", async () => {
  const harness = createHarness();
  assert.equal(await harness.engine.place(100), true);
  const operation = lastOperation(harness.engine);
  assert.equal(operation.requestedEpoch, 100);
  assert.equal(operation.resolvedEpoch, 100);
  assert.equal(operation.representedEpoch, 100);
  assert.equal(operation.mediaCurrentTime, 20);
  assert.equal(operation.mappingErrorSeconds, 0);
  assert.equal(operation.presentedFrameObservations.length, 1);
  assert.equal(operation.waitingEvents, 1);
  assert.equal(operation.stalledEvents, 1);
  assert.equal(operation.disposition, "committed-paused");
});

test("missing requestVideoFrameCallback fails explicitly without a weaker clock", async () => {
  const harness = createHarness({ videoFactory: () => {
    const video = new FakeVideo();
    video.requestVideoFrameCallback = undefined;
    return video;
  } });
  assert.equal(await harness.engine.place(100), false);
  assert.equal(lastOperation(harness.engine).disposition, "failed");
  assert.match(lastOperation(harness.engine).error, /requestVideoFrameCallback is required/);
  assert.equal(harness.engine.state.representedEpoch, null);
});

test("in-map Place reuses the owned source and keeps a truthful hold until target frame", async () => {
  const harness = createHarness();
  await harness.engine.place(100);
  harness.videos[0]._autoFrame = false;
  const pending = harness.engine.place(105);
  await settleUntil(() => harness.holds.length === 1);
  assert.equal(harness.sessions.length, 1);
  assert.equal(harness.sessions[0].visible, true);
  assert.equal(harness.holds[0].destroyed, false);
  assert.equal(harness.videos[0].emitFrame(25), true);
  assert.equal(await pending, true);
  assert.equal(harness.engine.state.representedEpoch, 105);
  assert.equal(harness.holds[0].destroyed, true);
  assert.equal(harness.engine.state.counts.replaced, 0);
});

test("a canceled in-map seek keeps the held image authoritative until the source revalidates", async () => {
  const harness = createHarness();
  await harness.engine.place(100);
  const video = harness.videos[0];
  video._autoFrame = false;
  const canceled = harness.engine.place(105);
  await settleUntil(() => harness.holds.length === 1);
  const hold = harness.holds[0];
  assert.equal(hold.representedEpoch, 100);
  assert.equal(harness.engine.pause(), true);
  assert.equal(video._callbacks.size, 0);
  assert.equal(await canceled, false);
  assert.equal(harness.engine.state.representedEpoch, 100);
  assert.equal(hold.destroyed, false);
  assert.equal(hold.visible, true);

  const resumed = harness.engine.resume();
  await settleUntil(() => video.currentTime === 20 && video._callbacks.size === 1);
  assert.equal(harness.engine.state.playing, false);
  assert.equal(video.emitFrame(26), true);
  assert.equal(harness.engine.state.representedEpoch, 100);
  assert.equal(hold.destroyed, false);
  assert.equal(hold.visible, true);
  assert.equal(video.emitFrame(20), true);
  assert.equal(await resumed, true);
  assert.equal(harness.engine.state.representedEpoch, 100);
  assert.equal(hold.destroyed, true);
  assert.equal(harness.engine.state.playing, true);
});

test("backward commits a paused target frame presented before seeked", async () => {
  const harness = createHarness({ readinessTimeoutMs: 20 });
  await harness.engine.place(100);
  const video = harness.videos[0];
  await harness.engine.play();
  assert.equal(video.emitFrame(25), true);
  assert.equal(harness.engine.state.representedEpoch, 105);
  assert.equal(harness.engine.state.playing, true);

  video._presentFrameBeforeSeeked = true;
  let holdOwnedAtTargetFrame = false;
  video._onAllFrames = () => {
    const hold = harness.holds[0];
    holdOwnedAtTargetFrame = hold?.representedEpoch === 105 && hold.destroyed === false;
  };
  const backward = harness.engine.backward();
  await settleUntil(() => harness.holds.length === 1);
  const hold = harness.holds[0];
  assert.equal(hold.representedEpoch, 105);
  assert.equal(await backward, true);
  assert.ok(harness.states.some(state => state.operationIntent === "backward" &&
    state.operationDisposition === null && state.playing === false));
  assert.equal(holdOwnedAtTargetFrame, true);
  assert.equal(harness.engine.state.requestedEpoch, 95);
  assert.equal(harness.engine.state.resolvedEpoch, 95);
  assert.equal(harness.engine.state.representedEpoch, 95);
  assert.equal(harness.engine.state.playing, false);
  assert.equal(hold.destroyed, true);
  assert.equal(lastOperation(harness.engine).disposition, "committed-paused");
});

test("the exclusive logical endpoint is never reused as a represented frame", async () => {
  const harness = createHarness();
  await harness.engine.place(100);
  const video = harness.videos[0];
  assert.equal(video.currentTime, 20);
  assert.equal(await harness.engine.place(120), true);
  assert.equal(harness.engine.state.requestedEpoch, 120);
  assert.equal(harness.engine.state.resolvedEpoch, null);
  assert.equal(harness.engine.state.representedEpoch, 100);
  assert.equal(harness.engine.state.positionKind, "uncovered");
  assert.equal(video.currentTime, 20);
  assert.equal(lastOperation(harness.engine).resolutionReason, "logical-boundary-unrepresentable");
});

test("playback holds the final validated image before the logical endpoint", async () => {
  const harness = createHarness();
  await harness.engine.place(100);
  const video = harness.videos[0];
  assert.equal(await harness.engine.play(), true);
  assert.equal(video.emitFrame(39.98), true);
  assert.ok(Math.abs(harness.engine.state.representedEpoch - 119.98) < 1e-9);
  assert.equal(harness.engine.state.playing, false);
  assert.equal(video.paused, true);
  assert.equal(harness.holds.length, 1);
  assert.equal(harness.holds[0].visible, true);
  assert.ok(Math.abs(harness.holds[0].representedEpoch - 119.98) < 1e-9);
  assert.equal(video.emitFrame(40.25), false);
  assert.ok(Math.abs(harness.engine.state.representedEpoch - 119.98) < 1e-9);
  assert.equal(harness.engine.state.playing, false);
});

test("out-of-map Place atomically commits staging after its represented frame", async () => {
  const harness = createHarness({
    videoFactory: index => new FakeVideo({ autoFrame: index === 0 })
  });
  await harness.engine.place(100);
  const previous = harness.sessions[0];
  const pending = harness.engine.place(200);
  await settleUntil(() => harness.sessions.length === 2);
  assert.equal(previous.visible, true);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.destroyed.length, 0);
  assert.equal(harness.videos[1].emitFrame(20), true);
  assert.equal(await pending, true);
  assert.equal(harness.commits[1].previousWasVisible, true);
  assert.equal(harness.sessions[1].visible, true);
  assert.equal(harness.destroyed[0], previous);
  assert.deepEqual(harness.engine.state.counts, { created: 2, replaced: 1, destroyed: 1 });
});

test("a stale presented frame cannot authorize staging commit before the target frame", async () => {
  const harness = createHarness({
    videoFactory: index => new FakeVideo({ autoFrame: index === 0 })
  });
  await harness.engine.place(100);
  const previous = harness.sessions[0];
  const pending = harness.engine.place(200);
  await settleUntil(() => harness.sessions.length === 2);
  const stagingVideo = harness.videos[1];
  assert.equal(stagingVideo.currentTime, 20);
  assert.equal(stagingVideo.emitFrame(10, null, { preserveCurrentTime: true }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.engine.state.activeSessionId, previous.id);
  assert.equal(stagingVideo.emitFrame(20), true);
  assert.equal(await pending, true);
  assert.equal(harness.commits.length, 2);
  assert.equal(harness.engine.state.activeSessionId, harness.sessions[1].id);
});

test("a stale V2 completion is rejected without disturbing the newer owned session", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const harness = createHarness({
    prepare: async message => {
      if (message.target === 200) await blocked;
      return presentation(message.target);
    }
  });
  await harness.engine.place(100);
  const stale = harness.engine.place(200);
  await settleUntil(() => lastOperation(harness.engine).requestedEpoch === 200);
  const current = harness.engine.place(300);
  assert.equal(await current, true);
  const currentSession = harness.engine.state.activeSessionId;
  release();
  assert.equal(await stale, false);
  assert.equal(harness.engine.state.activeSessionId, currentSession);
  const report = harness.engine.getDiagnosticReport();
  assert.equal(report.operations.find(operation => operation.requestedEpoch === 200).disposition, "stale-rejected");
  assert.equal(report.operations.at(-1).disposition, "committed-paused");
});

test("a superseded reacquire reports superseded and cannot acquire the replacement session", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const harness = createHarness({
    prepare: async message => {
      if (message.target === 200) await blocked;
      return presentation(message.target);
    }
  });
  await harness.engine.place(100);
  const stale = harness.engine.reacquire(200);
  await settleUntil(() => lastOperation(harness.engine).requestedEpoch === 200);
  assert.equal(await harness.engine.place(300), true);
  release();
  const outcome = await stale;
  assert.equal(outcome.outcome, "superseded");
  assert.equal(harness.engine.state.representedEpoch, 300);
});

test("superseding a frame-waiting candidate cleans only that stale candidate", async () => {
  const harness = createHarness({
    videoFactory: index => new FakeVideo({ autoFrame: index !== 1 })
  });
  await harness.engine.place(100);
  const stale = harness.engine.place(200);
  await settleUntil(() => harness.sessions.length === 2);
  const staleCandidate = harness.sessions[1];
  const current = harness.engine.place(300);
  assert.equal(await current, true);
  assert.equal(await stale, false);
  assert.ok(harness.destroyed.includes(staleCandidate));
  assert.equal(harness.sessions[2].destroyed, false);
  assert.equal(harness.engine.state.activeSessionId, harness.sessions[2].id);
});

test("Play near a recording start resolves once and begins at that exact start", async () => {
  const harness = createHarness({ coverage: [[110, 200]] });
  await harness.engine.place(105);
  assert.equal(harness.engine.state.positionKind, "uncovered");
  assert.equal(await harness.engine.play(), true);
  assert.equal(harness.engine.state.requestedEpoch, 105);
  assert.equal(harness.engine.state.resolvedEpoch, 110);
  assert.equal(harness.engine.state.representedEpoch, 110);
  assert.equal(harness.engine.state.playing, true);
  assert.equal(lastOperation(harness.engine).resolutionReason, "play-near-next-start");
  assert.equal(lastOperation(harness.engine).disposition, "committed-playing");
});

test("Play in a larger gap remains paused with a deterministic terminal reason", async () => {
  const harness = createHarness({ coverage: [[120, 200]] });
  await harness.engine.place(105);
  assert.equal(await harness.engine.play(), true);
  assert.equal(harness.engine.state.requestedEpoch, 105);
  assert.equal(harness.engine.state.resolvedEpoch, null);
  assert.equal(harness.engine.state.playing, false);
  assert.equal(lastOperation(harness.engine).resolutionReason, "uncovered-no-near-entry");
  assert.equal(lastOperation(harness.engine).disposition, "uncovered");
});

test(">> resolves to the first crossed recording start rather than skipping it", async () => {
  const harness = createHarness({ coverage: [[110, 200]] });
  await harness.engine.place(105);
  assert.equal(await harness.engine.forward(), true);
  assert.equal(harness.engine.state.requestedEpoch, 115);
  assert.equal(harness.engine.state.resolvedEpoch, 110);
  assert.equal(harness.engine.state.representedEpoch, 110);
  assert.equal(lastOperation(harness.engine).resolutionReason, "forward-crossed-start");
});

test("<< exposes the missing last-representable-frame primitive without end-epsilon", async () => {
  const harness = createHarness({ coverage: [[100, 200], [220, 300]] });
  await harness.engine.place(205);
  assert.equal(await harness.engine.backward(), true);
  assert.equal(harness.engine.state.requestedEpoch, 195);
  assert.equal(harness.engine.state.resolvedEpoch, null);
  assert.equal(lastOperation(harness.engine).resolutionReason, "backward-crossed-end-unresolved");
  assert.equal(lastOperation(harness.engine).disposition, "truthful-subset-limitation");
});

test("exact recording start is playable while the half-open end is uncovered", async () => {
  const harness = createHarness({ coverage: [[110, 200]] });
  assert.equal(await harness.engine.place(110), true);
  assert.equal(harness.engine.state.representedEpoch, 110);
  assert.equal(await harness.engine.place(200), true);
  assert.equal(harness.engine.state.requestedEpoch, 200);
  assert.equal(harness.engine.state.resolvedEpoch, null);
  assert.equal(harness.engine.state.positionKind, "uncovered");
});

test("Pause freezes the last represented frame and Resume reuses the source", async () => {
  const harness = createHarness();
  await harness.engine.place(100);
  await harness.engine.play();
  assert.equal(harness.videos[0].emitFrame(24.5), true);
  assert.equal(harness.engine.state.requestedEpoch, 100);
  assert.equal(harness.engine.state.resolvedEpoch, 100);
  assert.equal(harness.engine.state.representedEpoch, 104.5);
  const playMeasurement = harness.engine.getDiagnosticReport().operations.find(
    operation => operation.intent === "play"
  );
  assert.equal(playMeasurement.representedAdvancementSeconds, 4.5);
  assert.ok(Number.isFinite(playMeasurement.achievedRepresentedRate));
  assert.equal(harness.engine.pause(), true);
  assert.equal(harness.engine.state.requestedEpoch, 104.5);
  assert.equal(harness.engine.state.playing, false);
  assert.equal(lastOperation(harness.engine).resolutionReason, "pause-at-presented-frame");
  assert.equal(await harness.engine.resume(), true);
  assert.equal(harness.engine.state.playing, true);
  assert.equal(harness.sessions.length, 1);
  assert.equal(harness.engine.state.counts.replaced, 0);
});

test("represented observation time comes only from validated RVFC frames", async () => {
  const harness = createHarness();
  await harness.engine.place(100);
  const observedAt = harness.engine.state.representedObservedAtMs;
  assert.equal(observedAt, 1001);
  harness.videos[0]._currentTime = 23;
  harness.engine.setEffectivePlaybackRate(1.05);
  assert.equal(harness.engine.state.representedEpoch, 100);
  assert.equal(harness.engine.state.representedObservedAtMs, observedAt);
  assert.equal(harness.engine.state.mediaCurrentTime, 23);
  assert.equal(harness.engine.state.lastPresentedMediaTime, 20);
  assert.equal(harness.engine.state.effectivePlaybackRate, 1.05);
});

test("Pause drains an already-presented queued frame before freezing represented time", async () => {
  const harness = createHarness();
  await harness.engine.place(100);
  await harness.engine.play();
  assert.equal(harness.videos[0].emitFrame(24.5), true);
  assert.equal(harness.engine.state.representedEpoch, 104.5);
  assert.equal(harness.engine.pause(), true);
  assert.equal(harness.videos[0].emitFrame(25), true);
  assert.equal(harness.engine.state.representedEpoch, 105);
  assert.equal(harness.engine.state.requestedEpoch, 105);
  assert.equal(harness.engine.state.resolvedEpoch, 105);
  assert.equal(harness.engine.state.representedObservedAtMs, 1003);
  assert.equal(lastOperation(harness.engine).representedEpoch, 105);
});

test("Reset returns to the session's initial committed position without replacement", async () => {
  const harness = createHarness();
  await harness.engine.place(100);
  await harness.engine.place(105);
  assert.equal(harness.engine.state.representedEpoch, 105);
  assert.equal(await harness.engine.reset(), true);
  assert.equal(harness.engine.state.requestedEpoch, 100);
  assert.equal(harness.engine.state.representedEpoch, 100);
  assert.equal(lastOperation(harness.engine).resolutionReason, "reset-initial-committed-position");
  assert.equal(harness.sessions.length, 1);
});

test("rate measurement applies upward, downward, and back to 1x without replacement", async () => {
  const harness = createHarness();
  await harness.engine.place(100);
  for (const rate of [0.25, 0.5, 0.75, 1, 2, 4, 8, 16, 8, 4, 2, 1]) {
    assert.equal(harness.engine.setPlaybackRate(rate), true);
    assert.equal(harness.videos[0].playbackRate, rate);
    assert.equal(lastOperation(harness.engine).requestedPlaybackRate, rate);
    assert.equal(lastOperation(harness.engine).actualPlaybackRate, rate);
    assert.equal(lastOperation(harness.engine).disposition, "rate-applied");
  }
  assert.deepEqual(INVESTIGATION_PLAYBACK_RATES, [0.25, 0.5, 0.75, 1, 2, 4, 8, 16]);
  assert.equal(harness.sessions.length, 1);
  assert.equal(harness.engine.state.counts.replaced, 0);
});

test("successor lead policy scales conservatively with requested playback rate", () => {
  assert.equal(successorPreparationLeadSeconds(0.25, 2000), 6);
  assert.equal(successorPreparationLeadSeconds(0.5, 2000), 6);
  assert.equal(successorPreparationLeadSeconds(0.75, 2000), 6);
  assert.equal(successorPreparationLeadSeconds(1, 2000), 6);
  assert.equal(successorPreparationLeadSeconds(16, 500), 10);
  assert.equal(successorPreparationLeadSeconds(16, 2000), 34);
});

test("continuous artificial boundary stages, RVFC-validates, and atomically commits a successor", async () => {
  const harness = createHarness({ coverage: [[0, 10_000]] });
  await harness.engine.place(100);
  const active = harness.sessions[0];
  assert.equal(await harness.engine.play(), true);
  assert.equal(harness.videos[0].emitFrame(34), true);
  await settleUntil(() => harness.engine.state.successor.state === "ready");
  assert.equal(harness.sessions.length, 2);
  const staging = harness.sessions[1];
  assert.equal(staging.visible, false);
  assert.equal(harness.engine.state.successor.firstRepresentedEpoch, 120);
  assert.equal(harness.videos[0].emitFrame(39.98), true);
  await settleUntil(() => harness.engine.state.transition.count === 1);
  assert.equal(harness.engine.state.activeSessionId, staging.id);
  assert.equal(harness.engine.state.successor.state, "committed");
  assert.equal(active.destroyed, true);
  assert.equal(harness.commits.at(-1).previous, active);
  assert.ok(Math.abs(harness.engine.state.transition.latest.oldFinalRepresentedEpoch - 119.98) < 1e-9);
  assert.equal(harness.engine.state.transition.latest.newFirstRepresentedEpoch, 120);
});

test("continuous successor accepts a legitimate upward-rounded microsecond map endpoint", async () => {
  let prepareCount = 0;
  const harness = createHarness({
    coverage: [[0, 10_000]],
    prepare: message => ++prepareCount === 1
      ? presentation(message.target, 20, CAMERA)
      : upwardRoundedEndpointPresentation(message.target, 20, CAMERA)
  });
  await harness.engine.place(100);
  assert.equal(await harness.engine.play(), true);
  assert.equal(harness.videos[0].emitFrame(34), true);
  await settleUntil(() => harness.engine.state.successor.state === "ready");
  const ready = harness.engine.state.successor.mapValidation;
  assert.equal(ready.outcome, "accepted");
  assert.ok(ready.mediaStartUnderflowSeconds > 0);
  assert.ok(ready.mediaStartUnderflowSeconds < 0.000001);
  assert.equal(harness.videos[0].emitFrame(39.98), true);
  await settleUntil(() => harness.engine.state.transition.count === 1);
  const timing = harness.engine.getDiagnosticReport().transitionTimings.at(-1);
  assert.equal(timing.state, "committed");
  assert.equal(timing.mapValidation.outcome, "accepted");
  assert.equal(timing.stagingValidation.representedEpoch, 120);
});

test("continuous successor still rejects a genuinely inconsistent map with bounded diagnostics", async () => {
  let prepareCount = 0;
  const harness = createHarness({
    coverage: [[0, 10_000]],
    prepare: message => {
      if (++prepareCount === 1) return presentation(message.target, 20, CAMERA);
      const malformed = upwardRoundedEndpointPresentation(message.target, 20, CAMERA);
      return { ...malformed, media_start_position: 0.999998 };
    }
  });
  await harness.engine.place(100);
  assert.equal(await harness.engine.play(), true);
  assert.equal(harness.videos[0].emitFrame(34), true);
  await settleUntil(() => harness.engine.state.successor.state === "failed");
  const timing = harness.engine.getDiagnosticReport().transitionTimings.at(-1);
  assert.equal(timing.state, "failed");
  assert.equal(timing.mapValidation.outcome, "rejected");
  assert.ok(timing.mapValidation.mediaStartUnderflowSeconds > 0.000001);
  assert.equal(timing.manifestReadyAtMs, null);
  assert.equal(harness.sessions.length, 1);
  assert.equal(harness.engine.pause(), true);
  const retained = harness.engine.getDiagnosticReport().transitionTimings.at(-1);
  assert.equal(retained.state, "failed");
  assert.equal(retained.mapValidation.outcome, "rejected");
});

test("truthful represented-frame deadline commits without currentTime reaching the numeric endpoint", async () => {
  const harness = createTimedHarness({ coverage: [[0, 10_000]], ownerGeneration: 7 });
  await harness.engine.place(100);
  const active = harness.sessions[0];
  assert.equal(await harness.engine.play(), true);

  harness.clock.set(2000);
  assert.equal(active.video.emitFrame(34, null, {
    wallMs: 2000,
    expectedDisplayTime: 2010
  }), true);
  await settleUntil(() => harness.engine.state.successor.state === "ready");

  harness.clock.set(4000);
  assert.equal(active.video.emitFrame(39.85, null, {
    wallMs: 4000,
    expectedDisplayTime: 4010
  }), true);
  const deadline = harness.engine.state.boundaryDeadline.latest;
  assert.equal(harness.engine.state.transition.count, 0);
  assert.equal(active.video.currentTime, 39.85);
  assert.equal(deadline.state, "armed");
  assert.ok(Math.abs(deadline.representedDeltaSeconds - 0.15) < 1e-9);
  assert.ok(Math.abs(deadline.deadlineAtMs - 4160) < 1e-9);

  harness.clock.advance(deadline.deadlineAtMs - harness.clock.value - 1);
  assert.equal(harness.engine.state.transition.count, 0);
  harness.clock.advance(1);
  await settleUntil(() => harness.engine.state.transition.count === 1);

  assert.equal(harness.engine.state.transition.latest.commitTrigger, "artificial-boundary-deadline");
  assert.equal(harness.engine.state.transition.latest.activeReachedLogicalHold, false);
  assert.equal(harness.engine.state.boundaryDeadline.fireCount, 1);
  assert.equal(harness.engine.state.boundaryDeadline.latest.outcome, "committed");
  assert.equal(harness.holds.length, 0);
  assert.equal(active.destroyed, true);
  assert.equal(harness.sessions[1].video._callbacks.size, 1);

  const successor = harness.sessions[1];
  for (const [mediaTime, wallMs, expectedDisplayTime] of [
    [20.1, 4170, 4180], [20.2, 4220, 4230], [20.3, 4270, 4280], [20.4, 4320, 4330]
  ]) {
    assert.equal(successor.video.emitFrame(mediaTime, null, { wallMs, expectedDisplayTime }), true);
  }
  const timing = harness.engine.getDiagnosticReport().transitionTimings.at(-1);
  assert.equal(timing.camera, CAMERA);
  assert.equal(timing.ownerGeneration, 7);
  assert.equal(timing.operationId, harness.engine.state.operationId);
  assert.equal(timing.outgoingPresentationId, active.presentationId);
  assert.equal(timing.outgoingSessionId, active.id);
  assert.equal(timing.incomingPresentationId, successor.presentationId);
  assert.equal(timing.incomingSessionId, successor.id);
  assert.equal(timing.transitionCount, 1);
  assert.equal(timing.state, "committed");
  assert.ok(Math.abs(timing.outgoingFinal.representedEpoch - 119.85) < 1e-9);
  assert.equal(timing.outgoingFinal.mediaTime, 39.85);
  assert.equal(timing.outgoingFinal.callbackAtMs, 4000);
  assert.equal(timing.outgoingFinal.expectedDisplayTime, 4010);
  assert.ok(timing.v2CompleteAtMs >= timing.preparationStartedAtMs);
  assert.ok(timing.manifestReadyAtMs >= timing.v2CompleteAtMs);
  assert.ok(timing.mediaReadyAtMs >= timing.manifestReadyAtMs);
  assert.equal(timing.stagingValidation.representedEpoch, 120);
  assert.equal(timing.stagingValidation.mediaTime, 20);
  assert.equal(timing.stagingValidation.paused, true);
  assert.equal(timing.stagingValidation.playing, false);
  assert.ok(timing.stagingReadyAtMs >= timing.mediaReadyAtMs);
  assert.ok(timing.deadline.armCount >= 1);
  assert.equal(timing.deadline.latestArm.anchorRepresentedEpoch, 119.85);
  assert.equal(timing.deadline.latestArm.anchorExpectedDisplayTime, 4010);
  assert.equal(timing.deadline.latestArm.successorRepresentedEpoch, 120);
  assert.equal(timing.deadline.latestArm.effectivePlaybackRate, 1);
  assert.ok(Math.abs(timing.deadline.latestArm.dueAtMs - 4160) < 1e-9);
  assert.ok(Math.abs(timing.deadline.firedAtMs - 4160) < 1e-9);
  assert.ok(Math.abs(timing.deadline.fireLatenessMs) < 1e-9);
  assert.equal(timing.deadline.outcome, "committed");
  assert.equal(timing.commit.reconciliationTrigger, "artificial-boundary-deadline");
  assert.equal(timing.commit.visibilityState, "visible");
  const commitOrder = [
    timing.commit.startedAtMs,
    timing.commit.successorPlayCalledAtMs,
    timing.commit.successorPlayResolvedAtMs,
    timing.commit.visibilitySwapAtMs,
    timing.commit.retiredDestructionStartedAtMs,
    timing.commit.retiredDestructionCompletedAtMs,
    timing.commit.completedAtMs
  ];
  assert.ok(commitOrder.every(Number.isFinite));
  assert.deepEqual(commitOrder, [...commitOrder].sort((left, right) => left - right));
  assert.equal(timing.hold.createdAtMs, null);
  assert.deepEqual(timing.postCommitFrames.map(frame => frame.mediaTime), [20.1, 20.2, 20.3]);
  assert.deepEqual(timing.postCommitFrames.map(frame => Number(frame.representedEpoch.toFixed(1))),
    [120.1, 120.2, 120.3]);
  assert.deepEqual(timing.postCommitFrames.map(frame => frame.callbackAtMs), [4170, 4220, 4270]);
});

test("artificial transition timing diagnostics retain only the latest 32 records", async () => {
  const harness = createHarness({ ownerGeneration: 11 });
  await harness.engine.place(100);
  const source = harness.sessions[0];
  for (let index = 0; index < 33; index += 1) {
    harness.engine._createTransitionTiming({ id: 100 + index, startedAtMs: index }, source, 120 + index);
  }
  const timings = harness.engine.getDiagnosticReport().transitionTimings;
  assert.equal(timings.length, 32);
  assert.equal(timings[0].operationId, 101);
  assert.equal(timings.at(-1).operationId, 132);
  assert.ok(timings.every(record => record.ownerGeneration === 11));
});

test("successor-ready-first ordering rearms the deadline from each newer active RVFC", async () => {
  const harness = createTimedHarness({ coverage: [[0, 10_000]] });
  await harness.engine.place(100);
  const active = harness.sessions[0];
  assert.equal(await harness.engine.play(), true);

  harness.clock.set(2000);
  assert.equal(active.video.emitFrame(34, null, {
    wallMs: 2000,
    expectedDisplayTime: 2010
  }), true);
  await settleUntil(() => harness.engine.state.successor.state === "ready");
  const initial = harness.engine.state.boundaryDeadline.latest;
  assert.equal(initial.reason, "successor-ready");

  harness.clock.set(3000);
  assert.equal(active.video.emitFrame(39.9, null, {
    wallMs: 3000,
    expectedDisplayTime: 3010
  }), true);
  const rearmed = harness.engine.state.boundaryDeadline.latest;
  assert.equal(rearmed.reason, "active-rvfc");
  assert.ok(rearmed.tokenId > initial.tokenId);
  assert.ok(rearmed.deadlineAtMs < initial.deadlineAtMs);
  assert.ok(harness.engine.state.boundaryDeadline.cancelCount >= 1);

  harness.clock.advance(rearmed.deadlineAtMs - harness.clock.value);
  await settleUntil(() => harness.engine.state.transition.count === 1);
  assert.equal(harness.engine.state.transition.latest.commitTrigger, "artificial-boundary-deadline");
});

test("active-terminal-frame-first ordering arms after successor RVFC validation completes", async () => {
  let releasePrepare;
  const deferred = new Promise(resolve => { releasePrepare = resolve; });
  const harness = createTimedHarness({
    coverage: [[0, 10_000]],
    prepare: message => message.target === 120 ? deferred : presentation(message.target)
  });
  await harness.engine.place(100);
  const active = harness.sessions[0];
  assert.equal(await harness.engine.play(), true);

  harness.clock.set(2000);
  assert.equal(active.video.emitFrame(34, null, {
    wallMs: 2000,
    expectedDisplayTime: 2010
  }), true);
  await settleUntil(() => harness.engine.state.successor.state === "preparing");
  harness.clock.set(3000);
  assert.equal(active.video.emitFrame(39.9, null, {
    wallMs: 3000,
    expectedDisplayTime: 3010
  }), true);
  assert.equal(harness.engine.state.boundaryDeadline.armed, false);

  releasePrepare(presentation(120));
  await settleUntil(() => harness.engine.state.successor.state === "ready" &&
    harness.engine.state.boundaryDeadline.armed);
  const deadline = harness.engine.state.boundaryDeadline.latest;
  assert.equal(deadline.reason, "successor-ready");
  assert.ok(Math.abs(deadline.deadlineAtMs - 3110) < 1e-9);
  harness.clock.advance(deadline.deadlineAtMs - harness.clock.value);
  await settleUntil(() => harness.engine.state.transition.count === 1);
  assert.equal(harness.engine.state.transition.latest.commitTrigger, "artificial-boundary-deadline");
});

test("effective playback-rate changes rebase an armed artificial-boundary deadline", async () => {
  const harness = createTimedHarness({ coverage: [[0, 10_000]] });
  await harness.engine.place(100);
  const active = harness.sessions[0];
  assert.equal(await harness.engine.play(), true);
  harness.clock.set(2000);
  assert.equal(active.video.emitFrame(34, null, {
    wallMs: 2000,
    expectedDisplayTime: 2010
  }), true);
  await settleUntil(() => harness.engine.state.successor.state === "ready");
  harness.clock.set(3000);
  assert.equal(active.video.emitFrame(39.85, null, {
    wallMs: 3000,
    expectedDisplayTime: 3010
  }), true);
  const atOne = harness.engine.state.boundaryDeadline.latest;

  assert.equal(harness.engine.setEffectivePlaybackRate(2), true);
  const atTwo = harness.engine.state.boundaryDeadline.latest;
  assert.equal(atTwo.reason, "effective-rate-change");
  assert.equal(atTwo.effectivePlaybackRate, 2);
  assert.ok(Math.abs(atTwo.deadlineAtMs - 3085) < 1e-9);
  assert.ok(atTwo.deadlineAtMs < atOne.deadlineAtMs);
  assert.ok(atTwo.tokenId > atOne.tokenId);

  harness.clock.advance(atTwo.deadlineAtMs - harness.clock.value);
  await settleUntil(() => harness.engine.state.transition.count === 1);
  assert.equal(harness.engine.state.transition.latest.commitTrigger, "artificial-boundary-deadline");
});

test("deadline and concurrent media boundary signals commit a prepared successor exactly once", async () => {
  const harness = createTimedHarness({ coverage: [[0, 10_000]] });
  await harness.engine.place(100);
  const active = harness.sessions[0];
  assert.equal(await harness.engine.play(), true);
  harness.clock.set(2000);
  assert.equal(active.video.emitFrame(34, null, {
    wallMs: 2000,
    expectedDisplayTime: 2010
  }), true);
  await settleUntil(() => harness.engine.state.successor.state === "ready");
  harness.clock.set(3000);
  assert.equal(active.video.emitFrame(39.85, null, {
    wallMs: 3000,
    expectedDisplayTime: 3010
  }), true);
  const deadlineAtMs = harness.engine.state.boundaryDeadline.latest.deadlineAtMs;

  harness.clock.advance(deadlineAtMs - harness.clock.value);
  active.video.advanceWithoutFrame(40, "timeupdate");
  active.video.advanceWithoutFrame(40, "ended");
  active.video.emitFrame(40);
  await settleUntil(() => harness.engine.state.transition.count === 1);

  assert.equal(harness.engine.state.boundaryReconciliation.commitAttemptCount, 1);
  assert.equal(harness.commits.length, 2);
  assert.equal(harness.destroyed.filter(session => session === active).length, 1);
});

test("three consecutive frame-grid gaps use deadline commits without a visible hold", async () => {
  const harness = createTimedHarness({ coverage: [[0, 10_000]] });
  await harness.engine.place(100);
  assert.equal(await harness.engine.play(), true);
  const gaps = [0.051, 0.1, 0.15];

  for (let index = 0; index < gaps.length; index += 1) {
    const active = harness.sessions[index];
    harness.clock.advance(100);
    assert.equal(active.video.emitFrame(34, null, {
      wallMs: harness.clock.value,
      expectedDisplayTime: harness.clock.value + 10
    }), true);
    await settleUntil(() => harness.engine.state.successor.state === "ready" &&
      harness.engine.state.successor.sourceSessionId === active.id);

    harness.clock.advance(100);
    assert.equal(active.video.emitFrame(40 - gaps[index], null, {
      wallMs: harness.clock.value,
      expectedDisplayTime: harness.clock.value + 10
    }), true);
    const deadline = harness.engine.state.boundaryDeadline.latest;
    assert.equal(deadline.state, "armed");
    assert.ok(Math.abs(deadline.representedDeltaSeconds - gaps[index]) < 1e-9);
    harness.clock.advance(deadline.deadlineAtMs - harness.clock.value);
    await settleUntil(() => harness.engine.state.transition.count === index + 1);
    assert.equal(harness.engine.state.transition.latest.commitTrigger, "artificial-boundary-deadline");
    assert.equal(harness.engine.state.transition.latest.activeReachedLogicalHold, false);
    assert.equal(harness.sessions[index + 1].video._callbacks.size, 1);
  }

  assert.equal(harness.holds.length, 0);
  assert.equal(harness.engine.state.boundaryDeadline.fireCount, 3);
  assert.equal(harness.engine.state.boundaryReconciliation.commitAttemptCount, 3);
  assert.deepEqual(harness.engine.state.counts, { created: 4, replaced: 3, destroyed: 3 });
});

test("pause, supersession, and teardown cancel armed deadline ownership", async () => {
  const prepareArmed = async () => {
    const harness = createTimedHarness({ coverage: [[0, 10_000]] });
    await harness.engine.place(100);
    const active = harness.sessions[0];
    assert.equal(await harness.engine.play(), true);
    harness.clock.set(2000);
    assert.equal(active.video.emitFrame(34, null, {
      wallMs: 2000,
      expectedDisplayTime: 2010
    }), true);
    await settleUntil(() => harness.engine.state.successor.state === "ready");
    harness.clock.set(3000);
    assert.equal(active.video.emitFrame(39.85, null, {
      wallMs: 3000,
      expectedDisplayTime: 3010
    }), true);
    assert.equal(harness.engine.state.boundaryDeadline.armed, true);
    return harness;
  };

  const paused = await prepareArmed();
  const pausedDeadline = paused.engine.state.boundaryDeadline.latest.deadlineAtMs;
  assert.equal(paused.engine.pause(), true);
  assert.equal(paused.engine.state.boundaryDeadline.armed, false);
  paused.clock.advance(pausedDeadline - paused.clock.value + 100);
  assert.equal(paused.engine.state.transition.count, 0);

  const superseded = await prepareArmed();
  const supersededDeadline = superseded.engine.state.boundaryDeadline.latest.deadlineAtMs;
  assert.equal(await superseded.engine.place(200), true);
  assert.equal(superseded.engine.state.boundaryDeadline.armed, false);
  superseded.clock.advance(supersededDeadline - superseded.clock.value + 100);
  assert.equal(superseded.engine.state.transition.count, 0);
  assert.equal(superseded.engine.state.representedEpoch, 200);

  const destroyed = await prepareArmed();
  const destroyedDeadline = destroyed.engine.state.boundaryDeadline.latest.deadlineAtMs;
  destroyed.engine.destroy();
  assert.equal(destroyed.engine.state.boundaryDeadline.armed, false);
  destroyed.clock.advance(destroyedDeadline - destroyed.clock.value + 100);
  assert.equal(destroyed.engine.state.transition.count, 0);
  assert.equal(destroyed.engine.state.activeSessionId, null);
});

test("a materially regressive validated successor cannot rewind represented time", async () => {
  const harness = createHarness({
    coverage: [[0, 10_000]],
    videoFactory: index => new FakeVideo({ autoFrame: index !== 1 })
  });
  await harness.engine.place(100);
  const active = harness.sessions[0];
  assert.equal(await harness.engine.play(), true);
  assert.equal(active.video.emitFrame(34), true);
  await settleUntil(() => harness.videos.length === 2 && harness.videos[1]._callbacks.size === 1);
  assert.equal(harness.videos[1].emitFrame(19.96), true);
  await settleUntil(() => harness.engine.state.successor.state === "ready");

  assert.equal(active.video.emitFrame(39.97), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.engine.state.transition.count, 0);
  assert.ok(Math.abs(harness.engine.state.representedEpoch - 119.97) < 1e-9);
  assert.ok(Math.abs(harness.engine.state.successor.firstRepresentedEpoch - 119.96) < 1e-9);
  assert.equal(harness.engine.state.boundaryDeadline.latest.outcome, "regressive-successor");
  assert.equal(harness.engine.state.boundaryReconciliation.latest.outcome,
    "successor-frame-regresses-active");
  assert.equal(harness.commits.length, 1);
});

test("genuine recording end never arms the artificial-boundary deadline", async () => {
  const harness = createTimedHarness({ coverage: [[80, 120]] });
  await harness.engine.place(100);
  assert.equal(await harness.engine.play(), true);
  harness.clock.set(2000);
  assert.equal(harness.videos[0].emitFrame(34, null, {
    wallMs: 2000,
    expectedDisplayTime: 2010
  }), true);
  await settleUntil(() => harness.engine.state.coverageBoundary.state === "genuine-recording-end");
  assert.equal(harness.engine.state.boundaryDeadline.armCount, 0);
  assert.equal(harness.engine.state.boundaryDeadline.armed, false);

  assert.equal(harness.videos[0].emitFrame(39.98), true);
  const heldEpoch = harness.engine.state.heldEpoch;
  harness.clock.advance(60_000);
  assert.equal(harness.engine.state.transition.count, 0);
  assert.equal(harness.engine.state.heldEpoch, heldEpoch);
  assert.equal(harness.engine.state.coverageBoundary.state, "genuine-recording-end");
});

test("three consecutive artificial boundaries commit RVFC-validated sessions 1 through 4 exactly once", async () => {
  const harness = createHarness({ coverage: [[0, 10_000]] });
  await harness.engine.place(100);
  assert.equal(await harness.engine.play(), true);

  for (let transition = 1; transition <= 3; transition += 1) {
    const active = harness.sessions[transition - 1];
    assert.equal(harness.engine.state.activeSessionId, active.id);
    assert.equal(active.video._callbacks.size, 1);
    assert.equal(active.video.emitFrame(34), true);
    await settleUntil(() => harness.engine.state.successor.state === "ready" &&
      harness.engine.state.successor.sourceSessionId === active.id);

    const staging = harness.sessions[transition];
    const boundaryEpoch = 100 + transition * 20;
    assert.equal(staging.visible, false);
    assert.equal(harness.engine.state.stagingSessionId, staging.id);
    assert.equal(harness.engine.state.successor.firstRepresentedEpoch, boundaryEpoch);

    assert.equal(active.video.emitFrame(39.98), true);
    await settleUntil(() => harness.engine.state.transition.count === transition);
    assert.equal(harness.engine.state.activeSessionId, staging.id);
    assert.equal(harness.engine.state.stagingSessionId, null);
    assert.equal(staging.visible, true);
    assert.equal(staging.video._callbacks.size, 1);
    assert.equal(harness.commits.at(-1).previous, active);
    assert.equal(active.destroyed, true);
  }

  assert.equal(harness.sessions.length, 4);
  assert.equal(harness.commits.length, 4);
  assert.equal(harness.engine.state.transition.count, 3);
  assert.deepEqual(harness.destroyed, harness.sessions.slice(0, 3));
  assert.equal(new Set(harness.destroyed).size, 3);
  assert.deepEqual(harness.engine.state.counts, { created: 4, replaced: 3, destroyed: 3 });
  assert.equal(harness.engine.state.boundaryReconciliation.commitAttemptCount, 3);

  for (const retired of harness.videos.slice(0, 3)) {
    assert.equal(retired.emitFrame(40), false);
    retired.advanceWithoutFrame(40, "ended");
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.engine.state.transition.count, 3);
  assert.equal(harness.commits.length, 4);
});

test("a ready successor commits when currentTime reaches the boundary after the final RVFC falls short", async () => {
  const harness = createHarness({ coverage: [[0, 10_000]] });
  await harness.engine.place(100);
  const active = harness.sessions[0];
  assert.equal(await harness.engine.play(), true);
  assert.equal(active.video.emitFrame(34), true);
  await settleUntil(() => harness.engine.state.successor.state === "ready");

  assert.equal(active.video.emitFrame(39.94), true);
  assert.equal(harness.engine.state.transition.count, 0);
  active.video.advanceWithoutFrame(40, "timeupdate");
  await settleUntil(() => harness.engine.state.transition.count === 1);

  assert.equal(harness.engine.state.activeSessionId, harness.sessions[1].id);
  assert.equal(harness.engine.state.boundaryReconciliation.commitAttemptCount, 1);
  assert.equal(harness.engine.state.boundaryReconciliation.latest.signal, "media-timeupdate");
  assert.equal(harness.engine.state.boundaryReconciliation.latest.outcome, "committed");
  assert.equal(harness.engine.state.transition.latest.commitTrigger, "media-timeupdate");
});

test("an exact-boundary RVFC commits a ready successor before logical-boundary hold handling", async () => {
  const harness = createHarness({ coverage: [[0, 10_000]] });
  await harness.engine.place(100);
  const active = harness.sessions[0];
  assert.equal(await harness.engine.play(), true);
  assert.equal(active.video.emitFrame(34), true);
  await settleUntil(() => harness.engine.state.successor.state === "ready");

  assert.equal(active.video.emitFrame(40), true);
  await settleUntil(() => harness.engine.state.transition.count === 1);
  assert.equal(harness.engine.state.successor.state, "committed");
  assert.equal(harness.engine.state.transition.latest.commitTrigger, "rvfc-exact-boundary");
  assert.equal(harness.engine.state.representedEpoch, 120);
  assert.equal(harness.engine.state.positionKind, "covered");
});

test("boundary arrival before successor readiness reconciles after the validated staging frame", async () => {
  let releasePrepare;
  const deferred = new Promise(resolve => { releasePrepare = resolve; });
  const harness = createHarness({
    coverage: [[0, 10_000]],
    prepare: message => message.target === 120 ? deferred : presentation(message.target)
  });
  await harness.engine.place(100);
  const active = harness.sessions[0];
  assert.equal(await harness.engine.play(), true);
  assert.equal(active.video.emitFrame(34), true);
  await settleUntil(() => harness.engine.state.successor.state === "preparing");

  assert.equal(active.video.emitFrame(39.98), true);
  assert.equal(harness.engine.state.playing, false);
  assert.equal(harness.engine.state.heldSessionId, active.id);
  releasePrepare(presentation(120));
  await settleUntil(() => harness.engine.state.transition.count === 1);

  assert.equal(harness.engine.state.activeSessionId, harness.sessions[1].id);
  assert.equal(harness.engine.state.transition.latest.commitTrigger, "successor-ready");
  assert.equal(harness.engine.state.boundaryReconciliation.commitAttemptCount, 1);
  const timing = harness.engine.getDiagnosticReport().transitionTimings.at(-1);
  assert.ok(Number.isFinite(timing.hold.createdAtMs));
  assert.ok(Number.isFinite(timing.hold.removedAtMs));
  assert.ok(timing.hold.removedAtMs >= timing.hold.createdAtMs);
  assert.equal(timing.hold.durationMs, timing.hold.removedAtMs - timing.hold.createdAtMs);
});

test("successor readiness and media-boundary arrival in the same turn reconcile exactly once", async () => {
  let releasePrepare;
  const deferred = new Promise(resolve => { releasePrepare = resolve; });
  const harness = createHarness({
    coverage: [[0, 10_000]],
    prepare: message => message.target === 120 ? deferred : presentation(message.target)
  });
  await harness.engine.place(100);
  const active = harness.sessions[0];
  assert.equal(await harness.engine.play(), true);
  assert.equal(active.video.emitFrame(34), true);
  await settleUntil(() => harness.engine.state.successor.state === "preparing");

  releasePrepare(presentation(120));
  active.video.advanceWithoutFrame(40, "timeupdate");
  active.video.advanceWithoutFrame(40, "ended");
  await settleUntil(() => harness.engine.state.transition.count === 1);

  assert.equal(harness.engine.state.activeSessionId, harness.sessions[1].id);
  assert.equal(harness.engine.state.boundaryReconciliation.commitAttemptCount, 1);
  assert.equal(harness.commits.length, 2);
});

test("concurrent boundary signals and stale successor ownership cannot duplicate or authorize commits", async () => {
  const concurrent = createHarness({ coverage: [[0, 10_000]] });
  await concurrent.engine.place(100);
  const active = concurrent.sessions[0];
  assert.equal(await concurrent.engine.play(), true);
  assert.equal(active.video.emitFrame(34), true);
  await settleUntil(() => concurrent.engine.state.successor.state === "ready");

  active.video.advanceWithoutFrame(40, "timeupdate");
  active.video.advanceWithoutFrame(40, "ended");
  active.video.emitFrame(40);
  await settleUntil(() => concurrent.engine.state.transition.count === 1);
  assert.equal(concurrent.engine.state.boundaryReconciliation.commitAttemptCount, 1);
  assert.equal(concurrent.commits.length, 2);

  const stale = createHarness({ coverage: [[0, 10_000]] });
  await stale.engine.place(100);
  const staleActive = stale.sessions[0];
  assert.equal(await stale.engine.play(), true);
  assert.equal(staleActive.video.emitFrame(34), true);
  await settleUntil(() => stale.engine.state.successor.state === "ready");
  const retiredStaging = stale.sessions[1];
  assert.equal(stale.engine.setPlaybackRate(2), true);
  assert.equal(stale.engine.state.successor.state, "superseded");
  assert.equal(retiredStaging.destroyed, true);

  retiredStaging.video.advanceWithoutFrame(40, "ended");
  staleActive.video.advanceWithoutFrame(40, "timeupdate");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stale.engine.state.transition.count, 0);
  assert.equal(stale.commits.length, 1);
});

test("a genuine recording end does not request a successor and retains the final truthful frame", async () => {
  const harness = createHarness({ coverage: [[80, 120]] });
  await harness.engine.place(100);
  assert.equal(await harness.engine.play(), true);
  assert.equal(harness.videos[0].emitFrame(34), true);
  await settleUntil(() => harness.engine.state.coverageBoundary.state === "genuine-recording-end");
  assert.equal(harness.sessions.length, 1);
  assert.equal(harness.videos[0].emitFrame(39.98), true);
  assert.equal(harness.engine.state.playing, false);
  assert.ok(Math.abs(harness.engine.state.representedEpoch - 119.98) < 1e-9);
  assert.ok(Math.abs(harness.engine.state.heldEpoch - 119.98) < 1e-9);
  assert.equal(harness.engine.state.coverageBoundary.state, "genuine-recording-end");
  const timing = harness.engine.getDiagnosticReport().transitionTimings.at(-1);
  assert.equal(timing.state, "not-continuous");
  assert.equal(timing.terminalReason, "genuine-recording-end");
  assert.equal(timing.commit.startedAtMs, null);
  assert.equal(timing.deadline.armCount, 0);
});

test("a later recording after a genuine gap is distinguished without fabricating a successor", async () => {
  const harness = createHarness({ coverage: [[80, 120], [140, 200]] });
  await harness.engine.place(100);
  assert.equal(await harness.engine.play(), true);
  assert.equal(harness.videos[0].emitFrame(34), true);
  await settleUntil(() => harness.engine.state.coverageBoundary.state === "genuine-recording-gap-with-future");
  assert.equal(harness.engine.state.coverageBoundary.futureCoverageStart, 140);
  assert.equal(harness.sessions.length, 1);
});

test("a newer Place supersedes and destroys a deferred successor before it can commit", async () => {
  let releasePrepare;
  const deferred = new Promise(resolve => { releasePrepare = resolve; });
  const harness = createHarness({
    prepare: async message => message.target === 120 ? deferred : presentation(message.target)
  });
  await harness.engine.place(100);
  assert.equal(await harness.engine.play(), true);
  assert.equal(harness.videos[0].emitFrame(34), true);
  await settleUntil(() => harness.engine.state.successor.state === "preparing");
  const staleTiming = harness.engine.getDiagnosticReport().transitionTimings.at(-1);
  const outgoingFinal = structuredClone(staleTiming.outgoingFinal);
  const replacement = harness.engine.place(200);
  releasePrepare(presentation(120));
  assert.equal(await replacement, true);
  assert.notEqual(harness.engine.state.activePresentationId, 1);
  assert.equal(harness.engine.state.successor.state, "superseded");
  assert.equal(harness.engine.state.representedEpoch, 200);
  const retained = harness.engine.getDiagnosticReport().transitionTimings.find(
    record => record.operationId === staleTiming.operationId
  );
  assert.equal(retained.state, "superseded");
  assert.equal(retained.terminalReason, "stale-investigation-operation");
  assert.deepEqual(retained.outgoingFinal, outgoingFinal);
  assert.equal(retained.commit.startedAtMs, null);
  assert.deepEqual(retained.postCommitFrames, []);
});

test("selected-camera teardown destroys deferred successor work before another safe camera starts", async () => {
  let releasePrepare;
  const deferred = new Promise(resolve => { releasePrepare = resolve; });
  const previous = createHarness({
    camera: "north_gate",
    prepare: async message => message.target === 120 ? deferred : presentation(message.target, 20, "north_gate")
  });
  await previous.engine.place(100);
  assert.equal(await previous.engine.play(), true);
  assert.equal(previous.videos[0].emitFrame(34), true);
  await settleUntil(() => previous.engine.state.successor.state === "preparing");
  previous.engine.destroy();
  releasePrepare(presentation(120, 20, "north_gate"));
  await new Promise(resolve => setImmediate(resolve));
  for (const video of previous.videos) video.advanceWithoutFrame(40, "ended");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(previous.commits.length, 1);
  assert.equal(previous.engine.state.activeSessionId, null);
  assert.ok(previous.destroyed.length >= 1);

  const selected = createHarness({ camera: "south_gate" });
  await selected.engine.place(100);
  assert.equal(selected.engine.state.camera, "south_gate");
  assert.equal(selected.engine.state.representedEpoch, 100);
});

test("all accepted controls terminate explicitly even before an investigation position exists", async () => {
  const harness = createHarness();
  assert.equal(await harness.engine.play(), true);
  assert.equal(lastOperation(harness.engine).disposition, "no-investigation-position");
  assert.equal(await harness.engine.forward(), true);
  assert.equal(lastOperation(harness.engine).disposition, "no-investigation-position");
  assert.equal(await harness.engine.backward(), true);
  assert.equal(lastOperation(harness.engine).disposition, "no-investigation-position");
  assert.equal(harness.engine.pause(), true);
  assert.equal(lastOperation(harness.engine).disposition, "no-active-presentation");
  assert.equal(await harness.engine.resume(), true);
  assert.equal(lastOperation(harness.engine).disposition, "no-active-presentation");
  assert.equal(await harness.engine.reset(), true);
  assert.equal(lastOperation(harness.engine).disposition, "no-reset-position");
});

test("diagnostics are bounded, lifecycle-accounted, and exclude signed URLs", async () => {
  const harness = createHarness();
  harness.engine._operationLimit = 3;
  await harness.engine.place(100);
  harness.engine.setPlaybackRate(2);
  harness.engine.setPlaybackRate(4);
  harness.engine.setPlaybackRate(1);
  const report = harness.engine.getDiagnosticReport();
  assert.equal(report.operations.length, 3);
  assert.deepEqual(report.counts, { created: 1, replaced: 0, destroyed: 0 });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /authSig|secret-|\/signed\//);
  harness.engine.destroy();
  assert.deepEqual(harness.engine.state.counts, { created: 1, replaced: 0, destroyed: 1 });
});

test("two-peer Lab is isolated from production controllers and renders equal peer cells", async () => {
  const source = await readFile(new URL("../src/investigation-lab/investigation-playback-lab.js", import.meta.url), "utf8");
  assert.match(source, /customElements\.define\("investigation-playback-lab"/);
  for (const label of ["Place", "Play 1x", "Pause", "Resume 1x", "Reset"]) {
    assert.ok(source.includes(label), `missing ${label}`);
  }
  assert.match(source, /Historical camera peers/);
  assert.match(source, /type="datetime-local"/);
  assert.match(source, /Observation reference/);
  assert.match(source, /Follower observation/);
  assert.match(source, /selectionGeneration/);
  assert.match(source, /Represented/);
  assert.doesNotMatch(source, /ReviewController|localStorage|sessionStorage/);
  const engine = await readFile(new URL("../src/investigation-lab/single-camera-engine.js", import.meta.url), "utf8");
  assert.doesNotMatch(engine, /Pacific|\bPDT\b|\bPST\b|UTC-7|UTC-8/);
});

test("Lab loader and build substitution version the complete Lab module graph", async () => {
  const [loader, entry, engine, longVod] = await Promise.all([
    readFile(new URL("../src/investigation-lab/investigation-playback-lab-loader.js", import.meta.url), "utf8"),
    readFile(new URL("../src/investigation-lab/investigation-playback-lab.js", import.meta.url), "utf8"),
    readFile(new URL("../src/investigation-lab/single-camera-engine.js", import.meta.url), "utf8"),
    readFile(new URL("../src/investigation-lab/long-vod-two-peer-experiment.js", import.meta.url), "utf8")
  ]);
  assert.match(loader, /import\(`\/local\/nvr-card\/src\/investigation-lab\/investigation-playback-lab\.js\?ts=\$\{investigationLabLoadTimestamp\}`\)/);
  const build = "LAB test-build";
  const generatedEntry = entry.replaceAll("__LAB_BUILD__", build);
  const generatedEngine = engine.replaceAll("__LAB_BUILD__", build);
  const generatedLongVod = longVod.replaceAll("__LAB_BUILD__", build);
  assert.match(generatedEntry, /single-camera-engine\.js\?v=LAB test-build/);
  assert.match(generatedEntry, /long-vod-two-peer-experiment\.js\?v=LAB test-build/);
  assert.match(generatedEngine, /historical-presentation\.js\?v=LAB test-build/);
  assert.match(generatedLongVod, /historical-presentation\.js\?v=LAB test-build/);
  assert.match(generatedLongVod, /single-camera-engine\.js\?v=LAB test-build/);
  assert.match(generatedEntry, /const LAB_BUILD = "LAB test-build"/);
  assert.match(generatedEntry, /\$\{LAB_BUILD\}/);
  assert.doesNotMatch(generatedEntry, /__LAB_BUILD__/);
  assert.doesNotMatch(generatedEngine, /__LAB_BUILD__/);
  assert.doesNotMatch(generatedLongVod, /__LAB_BUILD__/);
});

test("lab card copies the complete displayed sanitized diagnostics and reports clipboard status", async () => {
  const browser = new Window({ url: "http://localhost/" });
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    customElements: globalThis.customElements,
    HTMLElement: globalThis.HTMLElement
  };
  const writes = [];
  const fallbackWrites = [];
  let fallbackSucceeds = true;
  let selectedValue;
  const select = browser.HTMLTextAreaElement.prototype.select;
  browser.HTMLTextAreaElement.prototype.select = function () {
    selectedValue = this.value;
    return select.call(this);
  };
  Object.defineProperty(browser.document, "execCommand", {
    configurable: true,
    value: command => {
      if (command !== "copy" || !fallbackSucceeds) return false;
      fallbackWrites.push(selectedValue);
      return true;
    }
  });
  Object.defineProperty(browser.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async text => writes.push(text) }
  });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    customElements: browser.customElements,
    HTMLElement: browser.HTMLElement
  });

  let card;
  try {
    const { InvestigationPlaybackLab } = await import(
      `../src/investigation-lab/investigation-playback-lab.js?copy-test=${Date.now()}`
    );
    card = new InvestigationPlaybackLab();
    assert.throws(() => card.setConfig({ cameras: [] }), /one or two/);
    card.setConfig({ cameras: ["driveway", "side_yard"] });
    assert.deepEqual([...card.shadowRoot.querySelectorAll(".peer")].map(peer => peer.dataset.camera),
      ["driveway", "side_yard"]);
    assert.equal(card.shadowRoot.querySelector(".rate-select"), null);
    const report = {
      mode: "two-peer-rvfc-clock-holder-observation",
      observations: [{ errorSeconds: -0.05 }]
    };
    let destroyed = 0;
    let reportCalls = 0;
    let placedEpoch = null;
    card._coordinator = {
      getDiagnosticReport: () => { reportCalls += 1; return structuredClone(report); },
      place: epoch => { placedEpoch = epoch; return true; },
      destroy: () => { destroyed += 1; }
    };
    card.shadowRoot.querySelector(".ti").value = "2026-09-23T08:23:40";
    await card._placeFromEditor();
    assert.equal(placedEpoch, new Date(2026, 8, 23, 8, 23, 40).getTime() / 1000);
    const state = {
      playbackEpoch: 100,
      followerErrorSeconds: 0,
      authorityStatus: "both-peers-truthfully-placed",
      requestedEpoch: 100,
      resolvedEpoch: 100,
      operationId: 1,
      operationIntent: "place",
      operationDisposition: "placed-paused",
      nominalPlaybackRate: 1,
      playing: false,
      status: "placed-paused",
      peers: [
        { camera: "driveway", requestedEpoch: 100, resolvedEpoch: 100, representedEpoch: 100,
          nominalPlaybackRate: 1, actualPlaybackRate: 1, errorSeconds: null, errorBand: null,
          lifecycle: "ready-paused" },
        { camera: "side_yard", requestedEpoch: 100, resolvedEpoch: 100, representedEpoch: 100,
          nominalPlaybackRate: 1, actualPlaybackRate: 1, errorSeconds: 0, errorBand: "in-band",
          lifecycle: "ready-paused" }
      ]
    };
    card._update(state);
    card._update({ ...state, playbackEpoch: 100.05 });
    card._update({ ...state, playbackEpoch: 100.1 });

    const diagnostics = card.shadowRoot.querySelector(".diagnostics");
    const button = card.shadowRoot.querySelector(".copy-diagnostics");
    assert.equal(diagnostics.readOnly, true);
    assert.equal(reportCalls, 0);
    assert.equal(diagnostics.value,
      "Full diagnostics are generated only when Copy diagnostics is pressed.");
    assert.equal(card.shadowRoot.querySelector(".status").textContent,
      "#1 place: placed-paused - paused");
    assert.doesNotMatch(card.shadowRoot.querySelector(".status").textContent, /[^\x00-\x7F]/);
    button.click();
    await Promise.resolve();
    assert.deepEqual(writes, [diagnostics.value]);
    assert.equal(reportCalls, 1);
    const copied = JSON.parse(diagnostics.value);
    assert.deepEqual(copied.cameras, ["driveway", "side_yard"]);
    assert.deepEqual(copied.coordinator.observations, report.observations);
    assert.equal(copied.timeEditor.absoluteEpoch, placedEpoch);
    assert.equal(copied.timeEditor.localEditorValue, "2026-09-23T08:23:40");
    assert.equal(copied.timeEditor.utcIso, new Date(placedEpoch * 1000).toISOString());
    assert.equal(copied.diagnosticGeneration.mode, "copy-time");
    assert.ok(copied.diagnosticGeneration.reportGenerationDurationMs >= 0);
    assert.equal(copied.diagnosticGeneration.serializedCharacterCount, diagnostics.value.length);
    assert.equal(copied.diagnosticGeneration.serializedByteCount,
      new TextEncoder().encode(diagnostics.value).byteLength);
    assert.equal(button.textContent, "Copied");

    Object.defineProperty(browser.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("denied"); } }
    });
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fallbackWrites.length, 1);
    assert.equal(fallbackWrites[0], diagnostics.value);
    assert.equal(reportCalls, 2);
    assert.equal(button.textContent, "Copied");

    Object.defineProperty(browser.navigator, "clipboard", { configurable: true, value: undefined });
    button.click();
    await Promise.resolve();
    assert.equal(fallbackWrites.length, 2);
    assert.equal(fallbackWrites[1], diagnostics.value);
    assert.equal(reportCalls, 3);
    assert.equal(button.textContent, "Copied");

    fallbackSucceeds = false;
    Object.defineProperty(browser.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("denied"); } }
    });
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(button.textContent, "Copy failed");
    card._teardownExperiment();
    assert.equal(destroyed, 1);
    assert.ok(card._selectionGeneration > 0);
  } finally {
    card?.disconnectedCallback();
    Object.assign(globalThis, previousGlobals);
    browser.close();
  }
});
