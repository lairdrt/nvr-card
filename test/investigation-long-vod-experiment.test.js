import test from "node:test";
import assert from "node:assert/strict";

import {
  LongVodTwoPeerExperiment,
  LONG_VOD_OBSERVATION_POLICY
} from "../src/investigation-lab/long-vod-two-peer-experiment.js";

const CAMERAS = ["drive_up", "drive_down"];

const ranges = values => ({
  length: values.length,
  start: index => values[index][0],
  end: index => values[index][1]
});

class FakeVideo extends EventTarget {
  constructor() {
    super();
    this._currentTime = 0;
    this._callbacks = new Map();
    this._nextCallbackId = 0;
    this._presentedFrames = 0;
    this.paused = true;
    this.seeking = false;
    this.playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this.readyState = 4;
    this.networkState = 1;
    this.seekable = ranges([]);
    this.buffered = ranges([]);
  }
  get currentTime() { return this._currentTime; }
  set currentTime(value) {
    this._currentTime = Number(value);
    this.seeking = true;
    queueMicrotask(() => {
      this.seeking = false;
      this.dispatchEvent(new Event("seeked"));
      if (this.autoFrame !== false) queueMicrotask(() => this.emitFrame(this._currentTime));
    });
  }
  makeReady() {
    this.seekable = ranges([[0, 20000]]);
    this.buffered = ranges([[0, 20]]);
    this.dispatchEvent(new Event("progress"));
  }
  requestVideoFrameCallback(callback) {
    const id = ++this._nextCallbackId;
    this._callbacks.set(id, callback);
    return id;
  }
  cancelVideoFrameCallback(id) { this._callbacks.delete(id); }
  emitFrame(mediaTime, wallMs = 1000 + this._presentedFrames) {
    const entry = this._callbacks.entries().next().value;
    if (!entry) return false;
    const [id, callback] = entry;
    this._callbacks.delete(id);
    this._currentTime = Number(mediaTime);
    this._presentedFrames += 1;
    callback(wallMs, { mediaTime: Number(mediaTime), presentedFrames: this._presentedFrames });
    return true;
  }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  getVideoPlaybackQuality() {
    return { droppedVideoFrames: 0, totalVideoFrames: this._presentedFrames };
  }
}

class MockXhrLoader {
  loadInternal() { return new XMLHttpRequest(); }
}

class MockHls {
  static version = "1.7.2";
  static DefaultConfig = { loader: MockXhrLoader, progressive: false, pLoader: undefined, fLoader: undefined };
  static Events = { MANIFEST_LOADED: "manifestLoaded", MANIFEST_PARSED: "manifestParsed", ERROR: "error" };
  static isSupported() { return true; }
  constructor(options) {
    this.config = { ...MockHls.DefaultConfig, ...options };
    this.listeners = new Map(); this.destroyed = false; MockHls.instances.push(this);
  }
  on(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  off(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name, value = {}) { for (const callback of this.listeners.get(name) ?? []) callback(name, value); }
  attachMedia(video) { this.video = video; }
  loadSource(path) {
    this.path = path;
    queueMicrotask(() => {
      this.video.makeReady();
      this.emit(MockHls.Events.MANIFEST_LOADED, { data: "#EXTM3U\n#EXTINF:2,\nsegment.ts\n" });
      this.emit(MockHls.Events.MANIFEST_PARSED);
    });
  }
  destroy() { this.destroyed = true; }
  static instances = [];
}

class FakeXhr {
  constructor() { this.headers = new Map(); this.opened = false; }
  open(method, url) { this.opened = true; this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers.set(name, value); }
}

function presentation(camera, target, mediaOffset = 0, malformed = false) {
  const start = target - 15;
  const end = start + 3600;
  const durationUs = 3_600_000_000;
  const mediaOffsetUs = Math.round(mediaOffset * 1_000_000);
  const value = {
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
    media_start_position: mediaOffset,
    selected_media_position: mediaOffset + 15,
    logical_media_end_position: mediaOffset + 3600,
    coverage_run: {
      known_start: start - 120,
      known_end: end + 120,
      continues_before: true,
      continues_after: true
    },
    time_map: {
      epoch_origin: start,
      unit: "microseconds",
      spans: [[0, durationUs, mediaOffsetUs, mediaOffsetUs + durationUs]]
    }
  };
  if (malformed) value.time_map.spans = [];
  return value;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ prepare, now, policy, auth, cameras = CAMERAS, preflight, createXhr } = {}) {
  MockHls.instances = [];
  const videos = [];
  const sessions = [];
  const destroyed = [];
  const requests = [];
  let clock = 1000;
  const callWS = async message => {
    requests.push(structuredClone(message));
    if (message.type === "frigate_max/v2/vod/prepare") {
      return prepare ? prepare(message) : presentation(
        message.camera, message.target, message.camera === CAMERAS[0] ? 21 : 22
      );
    }
    if (message.type === "frigate_max/lab/vod/preflight") return preflight?.(message) ?? {
      camera: message.camera, requested_start: message.start, requested_end: message.end,
      continuous_coverage: true, candidate_recording_row_count: 1100,
      coverage_run: { known_start: message.start, known_end: message.end }
    };
    if (message.type === "frigate_max/lab/vod/prepare") {
      if (prepare) return prepare(message);
      const value = presentation(message.camera, message.target, 0);
      value.requested_wall_start = message.start;
      value.requested_wall_end = message.end;
      value.logical_wall_start = message.start;
      value.logical_wall_end = message.end;
      value.effective_wall_start = message.start;
      value.effective_absolute_origin = message.start;
      value.selected_media_position = message.target - message.start;
      value.logical_media_end_position = message.end - message.start;
      value.coverage_run.known_start = message.start;
      value.coverage_run.known_end = message.end;
      value.time_map.epoch_origin = message.start;
      value.time_map.spans = [[0, (message.end - message.start) * 1_000_000,
        0, (message.end - message.start) * 1_000_000]];
      value.candidate_recording_row_count = 1100;
      value.mapping_clip_count = 1100;
      value.vod_mapping_latency_ms = 12.5;
      return value;
    }
    throw new Error(`Unexpected request ${message.type}`);
  };
  const currentAuth = auth ?? { expired: false, accessToken: "fixture-access-token", refreshAccessToken: async () => {} };
  const experiment = new LongVodTwoPeerExperiment({
    cameras,
    callWS,
    getAuth: () => currentAuth,
    expectedOrigin: "https://ha.example.test",
    createVideo: () => { const video = new FakeVideo(); videos.push(video); return video; },
    createXhr,
    loadHls: async () => MockHls,
    onVideoCreated: session => sessions.push(session),
    onVideoDestroyed: session => destroyed.push(session),
    now: now ?? (() => ++clock),
    policy
  });
  return { experiment, videos, sessions, destroyed, requests };
}

test("requires one or two distinct configured safe peers", () => {
  const common = { callWS() {}, createVideo() {} };
  assert.throws(() => new LongVodTwoPeerExperiment({ ...common, cameras: [] }), /one or two/);
  assert.throws(() => new LongVodTwoPeerExperiment({ ...common, cameras: ["drive_up", "drive_up"] }), /one or two/);
  assert.throws(() => new LongVodTwoPeerExperiment({ ...common, cameras: ["drive_up", "bad/id"] }), /one or two/);
});

test("places two long V2 presentations with exactly one media pipeline per camera", async () => {
  const value = harness();
  assert.equal(await value.experiment.place(10000), true);
  const prepares = value.requests.filter(request => request.type === "frigate_max/v2/vod/prepare");
  assert.deepEqual(prepares.map(request => request.camera), CAMERAS);
  assert.ok(prepares.every(request => request.bounds_end - request.bounds_start === 7200));
  assert.equal(value.requests.length, 2);
  assert.deepEqual(MockHls.instances.map(hls => hls.path), CAMERAS.map(camera =>
    `/api/frigate/vod/${camera}/start/9985/end/13585/index.m3u8`));
  assert.equal(value.videos[0].currentTime, 36);
  assert.equal(value.videos[1].currentTime, 37);
  assert.equal(value.experiment.state.peers[0].representedEpoch, 10000);
  assert.equal(value.experiment.state.peers[1].representedEpoch, 10000);
  const report = value.experiment.getDiagnosticReport();
  assert.deepEqual(report.resources, {
    videoElementsCreated: 2, videoElementsDestroyed: 0,
    hlsInstancesCreated: 2, hlsInstancesDestroyed: 0,
    currentVideoElements: 2, currentHlsInstances: 2
  });
  assert.equal(report.architecture.stagingPlayers, 0);
  assert.equal(report.architecture.successorPreparation, false);
  assert.equal(report.architecture.signedPathUsed, false);
  assert.equal(report.authentication.mode, "ha-bearer-per-request");
  assert.equal(report.peers[0].presentation.logicalWallEnd - report.peers[0].presentation.logicalWallStart, 3600);
});

test("XHR setup authenticates expected manifests, media, init fragments, and keys at request time", async () => {
  let token = "fixture-first-token";
  let expired = false;
  let refreshes = 0;
  const auth = {
    get expired() { return expired; },
    get accessToken() { return token; },
    async refreshAccessToken() { refreshes += 1; token = "fixture-refreshed-token"; expired = false; }
  };
  const value = harness({ auth });
  assert.equal(await value.experiment.place(10000), true);
  const firstHls = MockHls.instances[0];
  const setup = firstHls.config.xhrSetup;
  const base = "https://ha.example.test/api/frigate/vod/drive_up/start/9985/end/13585/";
  const requests = [
    [base + "index.m3u8", { type: "manifest" }],
    [base + "segment.ts", { type: "media-fragment", frag: { sn: 1 } }],
    [base + "init-v1.mp4", { type: "media-fragment", frag: { sn: "initSegment" } }],
    [base + "key.bin", { type: "key" }]
  ];
  for (const [url, context] of requests) {
    const xhr = new FakeXhr();
    await setup(xhr, url, context);
    assert.equal(xhr.method, "GET");
    assert.equal(xhr.headers.get("Authorization"), `Bearer ${token}`);
  }
  token = "fixture-replaced-token";
  const later = new FakeXhr();
  await setup(later, base + "later.m4s", { type: "media-fragment", frag: { sn: 2 } });
  assert.equal(later.headers.get("Authorization"), "Bearer fixture-replaced-token");
  expired = true;
  const afterRefresh = new FakeXhr();
  await setup(afterRefresh, base + "later-again.m4s", { type: "media-fragment", frag: { sn: 3 } });
  assert.equal(afterRefresh.headers.get("Authorization"), "Bearer fixture-refreshed-token");
  assert.equal(refreshes, 1);
  assert.equal(MockHls.instances[0], firstHls);
  const authReport = value.experiment.getDiagnosticReport().authentication;
  assert.deepEqual(authReport.requestCategoryCounts, { manifest: 1, mediaFragment: 3, initFragment: 1, key: 1 });
  assert.equal(authReport.setupSuccessCount, 6);
  assert.equal(authReport.refreshAttemptCount, 1);
  assert.equal(authReport.refreshSuccessCount, 1);
  assert.equal(authReport.setupAfterRefreshCount, 1);
  assert.doesNotMatch(JSON.stringify(value.experiment.getDiagnosticReport()), /fixture-(first|replaced|refreshed)-token|Authorization\s*:/i);
});

test("XHR setup rejects unexpected origin and routes before attaching credentials", async () => {
  const value = harness();
  assert.equal(await value.experiment.place(10000), true);
  const setup = MockHls.instances[0].config.xhrSetup;
  const rejected = [
    ["https://outside.example.test/api/frigate/vod/drive_up/segment.ts", { type: "media-fragment" }],
    ["https://ha.example.test/api/frigate/recording/drive_up/segment.ts", { type: "media-fragment" }],
    ["https://ha.example.test/api/frigate/vod/drive_up/segment.ts?authSig=fixture", { type: "media-fragment" }],
    ["https://ha.example.test/api/frigate/vod/drive_up/index.m3u8", { type: "steering-manifest" }],
    ["https://ha.example.test/api/frigate/vod/other_camera/start/9985/end/13585/segment.ts", { type: "media-fragment" }]
  ];
  for (const [url, context] of rejected) {
    const xhr = new FakeXhr();
    await assert.rejects(setup(xhr, url, context), /authentication setup failed/);
    assert.equal(xhr.headers.size, 0);
  }
  const report = value.experiment.getDiagnosticReport().authentication;
  assert.equal(report.rejectedOriginCount, 1);
  assert.equal(report.rejectedRouteCount, 4);
  assert.equal(report.setupFailureCount, 5);
  assert.doesNotMatch(JSON.stringify(report), /authSig|fixture|outside\.example/i);
});

test("XHR setup fails closed when HA authentication cannot refresh", async () => {
  const value = harness({ auth: {
    expired: true, accessToken: "fixture-stale-token",
    async refreshAccessToken() { throw new Error("fixture-private-error"); }
  } });
  assert.equal(await value.experiment.place(10000), true);
  const xhr = new FakeXhr();
  await assert.rejects(MockHls.instances[0].config.xhrSetup(xhr,
    "/api/frigate/vod/drive_up/start/9985/end/13585/segment.ts",
    { type: "media-fragment" }), /authentication setup failed/);
  assert.equal(xhr.headers.size, 0);
  const report = value.experiment.getDiagnosticReport();
  assert.equal(report.authentication.refreshFailureCount, 1);
  assert.doesNotMatch(JSON.stringify(report), /fixture-stale-token|fixture-private-error/);
});

test("an unverified global Hls loader fails before VOD preparation", async () => {
  const previousVersion = MockHls.version;
  try {
    MockHls.version = "1.7.3";
    const value = harness();
    assert.equal(await value.experiment.place(10000), false);
    assert.equal(value.requests.length, 0);
    assert.equal(value.experiment.getDiagnosticReport().resources.currentHlsInstances, 0);
  } finally {
    MockHls.version = previousVersion;
  }
});

test("RVFC mediaTime alone advances representedEpoch and pair error without correction", async () => {
  const value = harness();
  await value.experiment.place(2000);
  value.videos[0]._currentTime = 100;
  value.videos[1]._currentTime = 101;
  assert.equal(value.experiment.state.playbackEpoch, 2000);
  value.videos[0].emitFrame(41, 2000);
  value.videos[1].emitFrame(42.125, 2000);
  assert.equal(value.experiment.state.playbackEpoch, 2005);
  assert.equal(value.experiment.state.followerErrorSeconds, 0.125);
  assert.equal(value.videos[0].currentTime, 41);
  assert.equal(value.videos[1].currentTime, 42.125);
  assert.equal(value.videos[0].playbackRate, 1);
  assert.equal(value.videos[1].playbackRate, 1);
  assert.equal(value.experiment.getDiagnosticReport().architecture.correction, "none");
});

test("pause and resume retain the latest truthfully presented state", async () => {
  const value = harness();
  await value.experiment.place(2000);
  assert.equal(await value.experiment.play(), true);
  value.videos[0].emitFrame(51, 2000);
  value.videos[1].emitFrame(52, 2000);
  const represented = value.experiment.state.peers.map(peer => peer.representedEpoch);
  assert.equal(value.experiment.pause(), true);
  assert.deepEqual(value.experiment.state.peers.map(peer => peer.representedEpoch), represented);
  assert.equal(await value.experiment.resume(), true);
  assert.deepEqual(value.experiment.state.peers.map(peer => peer.representedEpoch), represented);
  assert.ok(value.videos.every(video => video.playbackRate === 1 && !video.paused));
});

test("diagnostics retain a bounded primitive sample ring and compute pair summaries on copy", async () => {
  let tick = 1000;
  const value = harness({ now: () => tick, policy: { sampleIntervalMs: 0, sampleLimit: 8 } });
  await value.experiment.place(2000);
  for (let index = 0; index < 20; index += 1) {
    tick += 10;
    value.videos[0].emitFrame(40 + index, tick);
    value.videos[1].emitFrame(41 + index + index / 100, tick);
  }
  const report = value.experiment.getDiagnosticReport();
  assert.equal(report.samples.length, 8);
  assert.ok(report.pair.observationCount > report.pair.retainedObservationCount);
  assert.ok(Number.isFinite(report.pair.meanAbsoluteErrorSeconds));
  assert.ok(Number.isFinite(report.pair.p95AbsoluteErrorSeconds));
  assert.doesNotMatch(JSON.stringify(report), /authSig|\/signed\//);
});

test("HLS diagnostics retain safe HTTP, retry, fragment, and playback failure facts", async () => {
  let tick = 10_000;
  const value = harness({ now: () => tick });
  assert.equal(await value.experiment.place(2000), true);
  assert.equal(await value.experiment.play(), true);
  value.videos[0].emitFrame(40, tick);
  tick += 25;
  MockHls.instances[0].emit(MockHls.Events.ERROR, {
    type: "networkError", details: "fragLoadError", fatal: false,
    response: { code: 403, text: "Forbidden" },
    error: { code: "ERR_HTTP", name: "NetworkError", message: "request rejected" },
    errorAction: { retryCount: 2, retryConfig: { maxNumRetry: 6 } },
    frag: { type: "main", sn: 123, level: 2, cc: 4, start: 899.5, duration: 2 }
  });
  const entry = value.experiment.getDiagnosticReport().peers[0].hlsErrors.at(-1);
  assert.equal(entry.type, "networkError");
  assert.equal(entry.details, "fragLoadError");
  assert.equal(entry.fatal, false);
  assert.deepEqual(entry.response, { available: true, statusCode: 403, statusText: "Forbidden" });
  assert.equal(entry.failureSignal, "http-response");
  assert.equal(entry.errorCode, "ERR_HTTP");
  assert.equal(entry.retryCount, 2);
  assert.equal(entry.maxRetryCount, 6);
  assert.deepEqual(entry.fragment, { type: "main", sn: 123, level: 2, cc: 4, start: 899.5, duration: 2 });
  assert.equal(entry.mediaTime, 40);
  assert.equal(entry.representedEpoch, 2004);
  assert.equal(value.experiment.state.playing, true);
  assert.equal(value.videos[0].playbackRate, 1);
});

test("HLS diagnostics distinguish no-response, timeout, and abort signals without retaining secrets", async () => {
  const value = harness();
  assert.equal(await value.experiment.place(2000), true);
  MockHls.instances[0].emit(MockHls.Events.ERROR, {
    type: "networkError", details: "fragLoadError", fatal: false,
    error: { code: "ERR_NETWORK", name: "TypeError", message: "https://host/fragment.ts?authSig=secret" },
    context: { frag: { type: "main", sn: 12, level: 0, cc: 0, start: 20, duration: 2 }, url: "/private/path?token=secret" }
  });
  MockHls.instances[0].emit(MockHls.Events.ERROR, {
    type: "networkError", details: "fragLoadTimeOut", fatal: false,
    error: { name: "TimeoutError", message: "request timed out" }
  });
  MockHls.instances[0].emit(MockHls.Events.ERROR, {
    type: "networkError", details: "internalAborted", fatal: false,
    error: { name: "AbortError", message: "request aborted" }
  });
  const errors = value.experiment.getDiagnosticReport().peers[0].hlsErrors;
  assert.deepEqual(errors.slice(-3).map(error => error.failureSignal), [
    "no-http-response-exposed", "timeout-signaled", "abort-signaled"
  ]);
  assert.equal(errors.at(-3).response.available, false);
  assert.equal(errors.at(-3).errorText, "[redacted]");
  const serialized = JSON.stringify(errors);
  assert.doesNotMatch(serialized, /authSig|token=|private\/path|secret|https?:\/\//i);
});

test("HLS error diagnostics retain only the latest bounded entries", async () => {
  const value = harness();
  assert.equal(await value.experiment.place(2000), true);
  for (let index = 0; index < 20; index += 1) {
    MockHls.instances[0].emit(MockHls.Events.ERROR, {
      type: "networkError", details: "fragLoadError", fatal: false,
      response: { code: 500 + index, text: "Server Error" }
    });
  }
  const peer = value.experiment.getDiagnosticReport().peers[0];
  assert.equal(peer.hlsErrorCount, 20);
  assert.equal(peer.hlsErrors.length, 16);
  assert.equal(peer.hlsErrors[0].response.statusCode, 504);
  assert.equal(peer.hlsErrors.at(-1).response.statusCode, 519);
});

test("default sampling retains the full 15-minute observation window", async () => {
  assert.ok(LONG_VOD_OBSERVATION_POLICY.sampleIntervalMs *
    (LONG_VOD_OBSERVATION_POLICY.sampleLimit - 1) >= 15 * 60 * 1000);
  let tick = 1000;
  const value = harness({ now: () => tick });
  assert.equal(await value.experiment.place(2000), true);
  assert.equal(await value.experiment.play(), true);
  for (let second = 1; second <= 15 * 60; second += 1) {
    tick += 1000;
    value.videos[0].emitFrame(36 + second, tick);
    value.videos[1].emitFrame(37 + second, tick);
  }
  const samples = value.experiment.getDiagnosticReport().samples;
  assert.ok(samples.length <= LONG_VOD_OBSERVATION_POLICY.sampleLimit);
  assert.ok(samples.some(sample => sample.elapsedWallTimeMs <= 60 * 1000));
  assert.ok(samples.some(sample => Math.abs(sample.elapsedWallTimeMs - 5 * 60 * 1000) <= 1000));
  assert.ok(samples.some(sample => Math.abs(sample.elapsedWallTimeMs - 10 * 60 * 1000) <= 1000));
  assert.ok(samples.some(sample => Math.abs(sample.elapsedWallTimeMs - 15 * 60 * 1000) <= 1000));
});

test("malformed V2 map data fails closed and destroys partial resources", async () => {
  const value = harness({ prepare: message => presentation(message.camera, message.target, 0, true) });
  assert.equal(await value.experiment.place(2000), false);
  const report = value.experiment.getDiagnosticReport();
  assert.equal(report.resources.currentVideoElements, 0);
  assert.equal(report.resources.currentHlsInstances, 0);
  assert.equal(value.experiment.state.operationDisposition, "failed");
});

test("a newer Place supersedes stale preparation without letting it mutate current state", async () => {
  const old = deferred();
  const value = harness({
    prepare: message => message.target === 1000 && message.camera === CAMERAS[0]
      ? old.promise
      : presentation(message.camera, message.target, message.camera === CAMERAS[0] ? 21 : 22)
  });
  const stale = value.experiment.place(1000);
  await Promise.resolve();
  assert.equal(await value.experiment.place(2000), true);
  old.resolve(presentation(CAMERAS[0], 1000, 21));
  assert.equal(await stale, false);
  assert.equal(value.experiment.state.requestedEpoch, 2000);
  assert.ok(value.experiment.state.peers.every(peer => peer.representedEpoch === 2000));
  assert.equal(value.experiment.getDiagnosticReport().resources.currentVideoElements, 2);
});

test("destroy retires both pipelines and stale RVFC callbacks cannot change represented state", async () => {
  const value = harness();
  await value.experiment.place(2000);
  const before = value.experiment.state.peers.map(peer => peer.representedEpoch);
  value.experiment.destroy();
  assert.equal(value.videos[0].emitFrame(100, 5000), false);
  assert.equal(value.videos[1].emitFrame(100, 5000), false);
  assert.deepEqual(before, [2000, 2000]);
  const report = value.experiment.getDiagnosticReport();
  assert.equal(report.resources.currentVideoElements, 0);
  assert.equal(report.resources.currentHlsInstances, 0);
  assert.ok(MockHls.instances.every(instance => instance.destroyed));
});

test("logical mapping excludes physical lookahead and holds at the half-open end", async () => {
  const value = harness();
  await value.experiment.place(2000);
  const first = value.sessions[0];
  value.videos[0].emitFrame(first.presentation.logical_media_end_position, 5000);
  assert.equal(value.sessions[0].lifecycle, "logical-end-held");
  assert.equal(value.videos[0].paused, true);
  assert.equal(value.experiment.state.playing, false);
  assert.equal(value.experiment.state.peers[0].representedEpoch, first.presentation.logical_wall_end);
});

test("single-camera Lab range deliberately measures 1100 clips in one unchanged pipeline", async () => {
  const value = harness({ cameras: [CAMERAS[0]] });
  assert.equal(await value.experiment.placeRange(10000, 22000), true);
  assert.deepEqual(value.requests.map(request => request.type), [
    "frigate_max/lab/vod/preflight", "frigate_max/lab/vod/prepare"
  ]);
  assert.equal(value.requests[1].end - value.requests[1].start, 12000);
  const report = value.experiment.getDiagnosticReport();
  assert.equal(report.labProbe.preflight.candidateRecordingRowCount, 1100);
  assert.equal(report.peers[0].mappingClipCount, 1100);
  assert.equal(report.peers[0].presentation.timeMapSpanCount, 1);
  assert.equal(report.peers[0].manifest.segmentCount, 1);
  assert.equal(report.peers[0].manifest.byteCount, new TextEncoder().encode("#EXTM3U\n#EXTINF:2,\nsegment.ts\n").length);
  assert.equal(report.resources.currentVideoElements, 1);
  assert.equal(report.resources.currentHlsInstances, 1);
  assert.equal(report.architecture.stagingPlayers, 0);
  assert.equal(report.architecture.correction, "none");
  assert.doesNotMatch(JSON.stringify(report), /\/media\/|secret|bearer\s+|authSig/i);
  const video = value.videos[0];
  const hls = MockHls.instances[0];
  for (const epoch of [10001, 13000, 16000, 19000, 21999]) {
    assert.equal(await value.experiment.seekAbsolute(epoch), true);
    assert.equal(value.experiment.state.playbackEpoch, epoch);
  }
  assert.equal(value.videos[0], video);
  assert.equal(MockHls.instances[0], hls);
  assert.equal(report.architecture.successorPreparation, false);
  const after = value.experiment.getDiagnosticReport();
  assert.deepEqual(after.peers[0].seekProbes.map(probe => probe.absoluteMappingError), [0, 0, 0, 0, 0]);
  assert.ok(after.peers[0].seekProbes.every(probe => probe.sessionId === 1 && probe.presentationId === 1));
  value.experiment.destroy();
  assert.equal(value.experiment.getDiagnosticReport().resources.currentVideoElements, 0);
  assert.equal(value.experiment.getDiagnosticReport().resources.currentHlsInstances, 0);
});

test("Lab range rejects uncovered preflight before mapping or resource creation", async () => {
  const value = harness({ cameras: [CAMERAS[0]], preflight: message => ({
    camera: message.camera, requested_start: message.start, requested_end: message.end,
    continuous_coverage: false, candidate_recording_row_count: 1100
  }) });
  assert.equal(await value.experiment.placeRange(10000, 22000), false);
  assert.equal(value.requests.length, 1);
  assert.equal(value.videos.length, 0);
  assert.equal(value.experiment.getDiagnosticReport().resources.currentHlsInstances, 0);
});

test("stale seek cannot commit after a replacement placement", async () => {
  const value = harness({ cameras: [CAMERAS[0]] });
  assert.equal(await value.experiment.placeRange(10000, 22000), true);
  value.videos[0].autoFrame = false;
  const pending = value.experiment.seekAbsolute(16000);
  await Promise.resolve();
  assert.equal(await value.experiment.placeRange(23000, 35000), true);
  assert.equal(await pending, false);
  assert.equal(value.experiment.state.requestedEpoch, 23015);
  assert.equal(value.experiment.getDiagnosticReport().peers[0].seekProbes.length, 0);
  assert.equal(value.experiment.getDiagnosticReport().resources.currentVideoElements, 1);
});

test("HTTP manifest probe classifies an over-limit failure without exposing paths or credentials", async () => {
  let xhr;
  const value = harness({
    cameras: [CAMERAS[0]],
    prepare: () => { throw new Error("Frigate request failed with HTTP 500."); },
    createXhr: () => {
      xhr = new FakeXhr();
      xhr.status = 500;
      xhr.statusText = "Internal Server Error";
      xhr.responseText = "/private/recordings/path.mp4 secret-token";
      xhr.getResponseHeader = name => name === "Content-Type" ? "text/plain" : null;
      xhr.send = () => queueMicrotask(() => xhr.onload());
      return xhr;
    }
  });
  assert.equal(await value.experiment.placeRange(10000, 22000), false);
  assert.equal(value.experiment.getDiagnosticReport().labProbe.preflight.candidateRecordingRowCount, 1100);
  assert.equal(await value.experiment.probeManifest(), false);
  const report = value.experiment.getDiagnosticReport();
  assert.equal(report.labProbe.manifestHttp.status, 500);
  assert.equal(report.labProbe.manifestHttp.contentType, "text/plain");
  assert.equal(report.labProbe.manifestHttp.errorExcerpt, "[redacted]");
  assert.equal(xhr.headers.get("Authorization"), "Bearer fixture-access-token");
  assert.doesNotMatch(JSON.stringify(report), /fixture-access-token|private\/recordings|secret-token/);
  assert.equal(report.resources.currentVideoElements, 0);
});

test("HTTP manifest probe measures status, bytes, segments, and safe headers", async () => {
  const body = "#EXTM3U\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n";
  const value = harness({
    cameras: [CAMERAS[0]],
    createXhr: () => {
      const xhr = new FakeXhr();
      xhr.status = 200;
      xhr.statusText = "OK";
      xhr.responseText = body;
      xhr.getResponseHeader = name => ({ "Content-Type": "application/vnd.apple.mpegurl",
        "Content-Length": String(body.length), Server: "nginx" })[name] ?? null;
      xhr.send = () => queueMicrotask(() => xhr.onload());
      return xhr;
    }
  });
  assert.equal(await value.experiment.placeRange(10000, 22000), true);
  assert.equal(await value.experiment.probeManifest(), true);
  const http = value.experiment.getDiagnosticReport().labProbe.manifestHttp;
  assert.equal(http.status, 200);
  assert.equal(http.byteCount, new TextEncoder().encode(body).byteLength);
  assert.equal(http.segmentCount, 2);
  assert.equal(http.serverHeader, "nginx");
  assert.equal(http.failureSignal, null);
});

test("count-only Lab phase creates no media resources and can probe the manifest", async () => {
  const value = harness({
    cameras: [CAMERAS[0]],
    createXhr: () => {
      const xhr = new FakeXhr();
      xhr.status = 200;
      xhr.statusText = "OK";
      xhr.responseText = "#EXTM3U\n#EXTINF:2,\na.ts\n";
      xhr.getResponseHeader = () => null;
      xhr.send = () => queueMicrotask(() => xhr.onload());
      return xhr;
    }
  });
  assert.equal(await value.experiment.countRange(10000, 22000), true);
  assert.deepEqual(value.requests.map(request => request.type), ["frigate_max/lab/vod/preflight"]);
  assert.equal(MockHls.instances.length, 0);
  assert.equal(value.videos.length, 0);
  assert.equal(await value.experiment.probeManifest(), true);
  assert.equal(value.experiment.getDiagnosticReport().labProbe.manifestHttp.segmentCount, 1);
});
