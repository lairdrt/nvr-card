import test from "node:test";
import assert from "node:assert/strict";
import { RvfcFlightRecorder, analyzeCameraTrace, compareDisplayCoordinates } from "../src/investigation-lab/rvfc-flight-recorder.js";
import { NativeVodSyncExperiment } from "../src/investigation-lab/native-vod-sync-experiment.js";
import { AnchoredPairSeamExperiment } from "../src/investigation-lab/anchored-pair-seam-experiment.js";
import { createAnchoredCameraTime } from "../src/review/anchored-camera-time.js";

const close = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const epoch = 1790449093.35;
const video = () => ({ currentTime: 0, readyState: 4, networkState: 2, paused: false, seeking: false, ended: false });
function camera(camera = "A", options = {}) {
  let entry = 1000;
  const recorder = new RvfcFlightRecorder({ camera, recorderId: `recorder-${camera}`, operationId: "play-1",
    sessionId: `session-${camera}`, presentationId: `presentation-${camera}`, timeOriginId: "document-1",
    anchor: { id: `anchor-${camera}`, absoluteTime: epoch, mediaTime: camera === "B" ? 10 : 0 },
    playReferenceMs: 1000, durationMs: 10000, maxRecords: 1000, now: () => entry, ...options });
  const element = video();
  return { recorder, element, trace: () => recorder.snapshot(),
    frame(advancement, display, receipt = display, extra = {}, ownership) {
      entry = receipt;
      return recorder.capture(receipt, { mediaTime: recorder.anchor.mediaTime + advancement,
        presentationTime: display - 1, expectedDisplayTime: display,
        presentedFrames: recorder.sequence + 1, processingDuration: .004, ...extra }, element, ownership);
    } };
}
const pairs = (a, b, options = { maxDistanceMs: 0 }) => compareDisplayCoordinates(a.trace(), b.trace(), options).comparisons;
function aligned() {
  const a = camera(), b = camera("B");
  a.frame(.2, 3200); b.frame(.2, 3200, 3900);
  return { a, b };
}
function preparation(camera) {
  return { camera, requestedStart: 1004, requestedEnd: 1035,
    observationPresentation: { schema: 2, camera, selected_epoch: 1004, resolved_selected_epoch: 1004,
      requested_wall_start: 1000, requested_wall_end: 1035, logical_wall_start: 1000, logical_wall_end: 1035,
      effective_wall_start: 1000, effective_absolute_origin: 1000, media_start_position: 0,
      selected_media_position: 4, logical_media_end_position: 35,
      coverage_run: { known_start: 1000, known_end: 1035, continues_before: false, continues_after: false },
      time_map: { epoch_origin: 1000, unit: "microseconds", spans: [[0, 35000000, 0, 35000000]] } } };
}
const experimentOptions = extra => ({ start: 1004, end: 1035,
  preparations: [preparation("drive_up"), preparation("drive_down")], seamMediaTime: 20,
  expectedOrigin: "https://ha.example.test", getAuth: () => ({}), now: () => 1000, ...extra });

test("1 identical advancement preserves immutable anchor difference", () => {
  const a = camera(), b = camera("B", { anchor: { id: "b", absoluteTime: epoch - .01, mediaTime: 10 } });
  a.frame(1, 2000); b.frame(1, 2000);
  const p = pairs(a, b)[0]; close(p.rawResidual, 0);
  assert.equal(p.anchoredResidual, a.recorder.anchor.absoluteTime - b.recorder.anchor.absoluteTime);
  assert.ok(Object.isFrozen(a.recorder.anchor)); assert.equal(p.acceptedA, true);
});

test("2 genuine B 700 ms startup head start survives equal subsequent rates", () => {
  const a = camera(), b = camera("B");
  for (const [d, t] of [[0, 1100], [1, 2100], [2, 3100]]) { a.frame(d, t); b.frame(d + .7, t); }
  for (const p of pairs(a, b)) { close(p.rawResidual, -.7); close(p.anchoredResidual, -.7); }
});

test("3 exact golden: actual old observer manufactures +700 ms; new display pairing does not", t => {
  const old = new AnchoredPairSeamExperiment(experimentOptions()); old.phase = "playing";
  old.peers.forEach((p, i) => {
    p.clock = createAnchoredCameraTime(epoch, i ? 10 : 0); p.anchorIdentity = p.clock.anchor;
  });
  const feed = (index, mediaTime, wallMs) => {
    const peer = old.peers[index]; peer.video = video(); peer.rvfcCount += 1;
    peer.latest = { mediaTime, wallMs, representedEpoch: epoch + mediaTime - (index ? 10 : 0) };
    old.onObservation(peer);
  };
  feed(0, .2, 3200); feed(0, .9, 3900); feed(1, 10.2, 3900);
  const { a, b } = aligned(); a.frame(.9, 3900);
  const comparison = pairs(a, b);
  close(old.latestPair.rawResidual, .7); assert.equal(old.latestPair.observationSeparationMs, 0);
  close(comparison[0].rawResidual, 0); assert.equal(comparison[0].separationMs, 0);
  assert.equal(comparison[1].separationMs, 700); assert.equal(comparison[1].qualified, false);
  t.diagnostic(`old raw=${old.latestPair.rawResidual}s, old anchored=${old.latestPair.anchoredResidual}s; new=${comparison[0].rawResidual}s; old paired display separation=700ms, new=0ms`);
});

test("4 350 ms callback delivery delay cannot create 350 ms media skew", () => {
  const a = camera(), b = camera("B");
  for (let i = 0; i < 4; i++) { a.frame(i / 10, 2000 + i * 100); b.frame(i / 10, 2000 + i * 100, 2350 + i * 100); }
  for (const p of pairs(a, b)) { close(p.rawResidual, 0); assert.equal(p.b.entryNow - p.a.entryNow, 350); }
});

test("5 rejected callback retains every raw field and exact reason", () => {
  const a = camera(); a.element.currentTime = .75; a.element.seeking = true;
  const r = a.frame(.7, 1016, 1020, { presentationTime: 999.9, presentedFrames: 7, processingDuration: .023 });
  assert.deepEqual(r, { camera: "A", recorderId: "recorder-A", operationId: "play-1", sessionId: "session-A",
    presentationId: "presentation-A", timeOriginId: "document-1", sequence: 1, callbackNow: 1020, entryNow: 1020,
    mediaTime: .7, presentationTime: 999.9, expectedDisplayTime: 1016, presentedFrames: 7, processingDuration: .023,
    currentTime: .75, readyState: 4, networkState: 2, paused: false, seeking: true, ended: false,
    anchorId: "anchor-A", normalizedAdvancement: .7, accepted: false, reason: "submitted-before-play" });
  assert.equal(a.trace().records[0], r);
  assert.equal(analyzeCameraTrace(a.trace()).firstAccepted, null);
  const b = camera("B"); b.frame(.7, 1016, 1020);
  assert.equal(pairs(a, b)[0].acceptedA, false); close(pairs(a, b)[0].rawResidual, 0);
  assert.equal(pairs(a, b, { maxDistanceMs: 0, acceptedOnly: true }).length, 0);
});

test("6 repeated paused M0 is not advancement, even for sub-frame positive advance", () => {
  const a = camera(); a.element.paused = true;
  a.frame(0, 1100); a.frame(0, 1200); a.frame(0, 1300);
  const first = a.frame(1e-10, 1400), result = analyzeCameraTrace(a.trace());
  assert.equal(result.repeatedAnchor.length, 3); assert.equal(result.firstAdvancing, first);
  assert.equal(result.firstRaw.sequence, 1); assert.equal(result.firstAccepted.sequence, 1);
});

test("7 backward observations remain raw and do not count as forward from M0", () => {
  const a = camera(); const back = a.frame(-.1, 1100); const forward = a.frame(.1, 1200); a.frame(.05, 1300);
  const result = analyzeCameraTrace(a.trace()); assert.equal(result.firstAdvancing, forward);
  assert.equal(result.backwards[0], back); assert.equal(result.backwards.length, 2);
});

test("8 composition, display, RVFC now and JS entry are distinct", () => {
  const a = camera(); const r = a.frame(.1, 1016, 1035, { presentationTime: 1005 });
  // Exercise direct primitive with a supplied rendering timestamp different from entry.
  const r2 = a.recorder.capture(1030, { mediaTime: .2, presentationTime: 1006, expectedDisplayTime: 1017 }, a.element);
  assert.deepEqual([r2.presentationTime, r2.expectedDisplayTime, r2.callbackNow, r2.entryNow], [1006, 1017, 1030, 1035]);
  const b = camera("B"); b.frame(.1, 1016, 1100);
  assert.equal(pairs(a, b)[0].a, r); assert.equal(pairs(a, b)[0].separationMs, 0);
});

test("9 presentedFrames jump is a diagnostic, never invented frames", () => {
  const a = camera(); a.frame(0, 1100, 1100, { presentedFrames: 2 }); a.frame(.1, 1200, 1200, { presentedFrames: 7 });
  const result = analyzeCameraTrace(a.trace()); assert.equal(result.presentedFrameJumps[0].countDelta, 5);
  assert.equal(result.currentRecordCount, 2); assert.equal(a.trace().records.length, 2);
});

test("10 different callback rates cannot create accumulated drift at corresponding coordinates", () => {
  const a = camera(), b = camera("B");
  for (let i = 0; i < 20; i++) a.frame(i / 10, 1100 + i * 100);
  for (let i = 0; i < 20; i += 2) b.frame(i / 10, 1100 + i * 100, 1200 + i * 100);
  const all = pairs(a, b); const qualified = all.filter(p => p.qualified);
  assert.equal(qualified.length, 10); qualified.forEach(p => close(p.rawResidual, 0));
  assert.ok(all.filter(p => !p.qualified).every(p => p.separationMs === 100));
});

for (const [number, seam] of [[11, -1], [12, 1.010]]) test(`${number} provider ${seam}s seam is not an anchored input`, () => {
  const a = camera(), b = camera("B");
  for (const d of [1, 2]) {
    // These deliberately hostile extra fields cannot enter the primitive record.
    a.frame(d, 1000 + d * 1000, undefined, { providerEpoch: epoch + d + (d === 2 ? seam : 0) });
    b.frame(d, 1000 + d * 1000);
  }
  pairs(a, b).forEach(p => { close(p.anchoredResidual, 0); assert.equal("providerEpoch" in p.a, false); });
});

test("13 2026 epoch magnitude uses small-difference residual arithmetic", () => {
  const a = camera(), b = camera("B"); a.frame(.000001, 2000); b.frame(0, 2000);
  const p = pairs(a, b)[0]; assert.equal(p.anchoredResidual, .000001);
  assert.notEqual(p.anchoredTimeA - p.anchoredTimeB, p.anchoredResidual);
});

test("14 initial 10.056 ms landing difference survives identical progression", () => {
  const a = camera(), b = camera("B", { anchor: { id: "b", absoluteTime: epoch - .010056, mediaTime: 10 } });
  a.frame(1, 2000); b.frame(1, 2000);
  assert.equal(pairs(a, b)[0].anchoredResidual, a.recorder.anchor.absoluteTime - b.recorder.anchor.absoluteTime);
  close(pairs(a, b)[0].anchoredResidual, .010056, 1.2e-7);
});

test("15 -700 ms media plus +10.056 ms anchor decomposes to -689.944 ms", () => {
  const a = camera(), b = camera("B", { anchor: { id: "b", absoluteTime: epoch - .010056, mediaTime: 10 } });
  a.frame(1.05, 2000); b.frame(1.75, 2000);
  const p = pairs(a, b)[0]; close(p.rawResidual, -.7); close(p.anchoredResidual, -.689944, 1.2e-7);
  assert.equal(p.anchoredResidual, (a.recorder.anchor.absoluteTime - b.recorder.anchor.absoluteTime) + p.rawResidual);
});

test("16 near but nonidentical display coordinates expose selection and separation", () => {
  const a = camera(), b = camera("B"); const ar = a.frame(1, 2000), br = b.frame(1.004, 2004);
  const p = pairs(a, b, { maxDistanceMs: 4 })[0]; assert.equal(p.a, ar); assert.equal(p.b, br);
  assert.deepEqual([p.expectedDisplayTimeA, p.expectedDisplayTimeB, p.separationMs], [2000, 2004, 4]);
  close(p.rawResidual, -.004); assert.equal(p.exactDisplayCoordinate, false); assert.equal(p.qualified, true);
});

test("17 far nearest candidate is explicitly unqualified, without an implicit policy", () => {
  const a = camera(), b = camera("B"); a.frame(1, 2000); b.frame(1, 8000);
  const p = pairs(a, b, { maxDistanceMs: 20 })[0]; assert.equal(p.separationMs, 6000); assert.equal(p.qualified, false);
  assert.equal(p.reason, "outside-requested-distance"); assert.equal(pairs(a, b, {})[0].qualified, null);
});

test("18 actual classification runs after append; rejection and exceptions cannot erase raw", () => {
  const a = camera(); const original = a.recorder.classify.bind(a.recorder);
  a.recorder.classify = record => {
    assert.equal(a.recorder.records.at(-1), record); assert.equal(record.reason, "unclassified");
    assert.equal(record.mediaTime, .1); return original(record);
  };
  a.frame(.1, 1100, 1100, { presentationTime: 999 });
  assert.equal(a.trace().records[0].reason, "submitted-before-play");
  a.recorder.classify = () => { throw new Error("classification failed"); }; a.frame(.2, 1200);
  assert.equal(a.trace().records[1].reason, "classification-error");
  assert.equal(analyzeCameraTrace(a.trace()).currentRecordCount, 1);
});

test("19 stale operation/session/presentation is retained with deterministic precedence and excluded", () => {
  const a = camera(), b = camera("B");
  for (const key of ["operationId", "sessionId", "presentationId"]) {
    const r = a.frame(99, 1100, 1100, {}, { ...a.recorder.identity, [key]: "old" });
    assert.equal(r.reason, `stale-${key.replace(/Id$/, "").toLowerCase()}`);
  }
  const first = a.frame(.2, 1200); b.frame(.2, 1200);
  assert.equal(a.trace().records.length, 4); assert.equal(analyzeCameraTrace(a.trace()).firstAdvancing, first);
  assert.equal(pairs(a, b).length, 1); close(pairs(a, b)[0].rawResidual, 0);
  a.recorder.currentOwnership = () => ({ operationId: "new", sessionId: "new", presentationId: "new" });
  assert.equal(a.frame(100, 1300).reason, "stale-operation"); assert.equal(pairs(a, b).length, 1);
});

test("20 bounded storage keeps earliest records; window and dropped-newest counts are explicit", () => {
  const a = camera("A", { durationMs: 100, maxRecords: 2 });
  a.frame(-1, 999); a.frame(0, 1000); a.frame(.1, 1001); a.frame(.2, 1002); a.frame(.3, 1100);
  const trace = a.trace(); assert.equal(trace.records.length, 2); assert.equal(trace.records[0].mediaTime, 0);
  assert.equal(trace.retention, "earliest-drop-newest"); assert.equal(trace.droppedNewest, 1);
  assert.equal(trace.outsideWindow, 2); assert.equal(trace.observedCallbacks, 5); assert.equal(trace.windowEnded, true);
  assert.equal(trace.truncated, true); assert.equal(analyzeCameraTrace(trace).truncated, true);
});

test("21 measurement is observational: forbidden playback/source/Hls writes or calls throw", () => {
  const a = camera(), b = camera("B"); const controls = new Set(["currentTime", "playbackRate", "src", "source", "hls", "Hls"]);
  const calls = new Set(["play", "pause", "load", "seek", "correct", "replaceSource"]);
  a.element = new Proxy(video(), { set(target, key, value) { assert.ok(!controls.has(key), `write ${key}`); target[key] = value; return true; },
    get(target, key) { if (calls.has(key)) return () => assert.fail(`call ${key}`); return target[key]; } });
  // Direct primitive path, using the spy element (the helper's lexical element is separate).
  a.recorder.capture(1000, { mediaTime: .1, presentationTime: 1000, expectedDisplayTime: 1000 }, a.element);
  b.frame(.1, 1000); analyzeCameraTrace(a.trace()); close(pairs(a, b)[0].rawResidual, 0);
});

test("22 same Run-A callback story distinguishes real -700 ms from aligned delayed frames", () => {
  const run = real => {
    const a = camera(), b = camera("B", { anchor: { id: "b", absoluteTime: epoch - .010056, mediaTime: 10 } });
    a.frame(0, 1100, 2024.6); a.frame(1.05, 2075, 2075);
    b.frame(real ? .7 : 0, 1100, 1075.1); b.frame(real ? 1.75 : 1.05, 2075, 2425);
    return pairs(a, b);
  };
  const real = run(true), aligned = run(false);
  real.forEach(p => { close(p.rawResidual, -.7); close(p.anchoredResidual, -.689944, 1.2e-7); });
  aligned.forEach(p => { close(p.rawResidual, 0); close(p.anchoredResidual, .010056, 1.2e-7); });
  assert.deepEqual(real.map(p => [p.a.entryNow, p.b.entryNow]), aligned.map(p => [p.a.entryNow, p.b.entryNow]));
});

class FakeVideo extends EventTarget {
  constructor() { super(); Object.assign(this, video()); this.callback = null; this.serial = 0; }
  requestVideoFrameCallback(fn) { this.callback = fn; return ++this.serial; }
  cancelVideoFrameCallback() { this.callback = null; }
  frame(now, metadata) { this.callback(now, metadata); }
  getVideoPlaybackQuality() { return { totalVideoFrames: 0, droppedVideoFrames: 0 }; }
}
class FakeHls {
  static Events = { MANIFEST_PARSED: "manifest", ERROR: "error" };
  on() {} attachMedia() {} loadSource() {}
}
test("integration: selected raw camera bypasses acceptance, provider map, statistics, pairs and UI", () => {
  const native = new NativeVodSyncExperiment(experimentOptions({ Hls: FakeHls, createVideo: () => new FakeVideo() }));
  native.loadSources();
  const a = camera("drive_up", { sessionId: 1, presentationId: 1 }); native.setRawRecorder("drive_up", a.recorder);
  for (const name of ["acceptObservation", "observePair", "onObservation"]) native[name] = () => assert.fail(name);
  const peer = native.peers[0]; peer.map = () => assert.fail("provider map");
  const originalHls = peer.hls;
  peer.video.frame(1000, { mediaTime: .1, presentationTime: 999, expectedDisplayTime: 1016 });
  assert.equal(a.trace().records.length, 1); assert.equal(a.trace().records[0].reason, "submitted-before-play");
  assert.equal(peer.rvfcCount, 0); assert.equal(peer.latest, null); assert.equal(peer.hls, originalHls);
  assert.equal(peer.video.serial, 2); // One rearm, no second observer loop.
  assert.equal(native.report().pair.synchronizationEvidence, false);
  assert.throws(() => native.setRawRecorder("drive_up", a.recorder), /ownership/);
  native.destroyed = true;
  peer.video.frame(1001, { mediaTime: .2, presentationTime: 1001, expectedDisplayTime: 1001 });
  assert.equal(a.trace().records[1].reason, "stale-operation");
  assert.equal(peer.video.serial, 2); assert.equal(analyzeCameraTrace(a.trace()).currentRecordCount, 1);
});

test("adversarial: shuffled callback delivery cannot change coordinate-selected residuals", () => {
  const run = order => {
    const a = camera(), b = camera("B");
    for (const i of order) { a.frame(i / 10, 2000 + i * 100, 3000 + a.recorder.sequence); b.frame(i / 10, 2000 + i * 100, 3500 + b.recorder.sequence); }
    return pairs(a, b).map(p => [p.expectedDisplayTimeA, p.expectedDisplayTimeB, p.rawResidual]);
  };
  assert.deepEqual(run([2, 0, 3, 1]), run([0, 1, 2, 3]));
});

test("adversarial: missing/nonfinite display metadata never falls back to callback clocks", () => {
  const a = camera(), b = camera("B"); a.frame(.1, 1100); b.frame(.1, 1100, 1100, { expectedDisplayTime: NaN });
  assert.equal(pairs(a, b)[0].reason, "no-display-candidate");
  a.frame(.2, 1200, 1200, { expectedDisplayTime: undefined }); assert.equal(pairs(a, b).length, 1);
});

test("adversarial: nearest ties and duplicate display coordinates are deterministic", () => {
  const a = camera(), b = camera("B"); a.frame(1, 2000);
  b.frame(1.2, 2010); b.frame(.95, 1990); b.frame(.9, 1990);
  const p = pairs(a, b, { maxDistanceMs: 10 })[0]; assert.equal(p.b.expectedDisplayTime, 1990); close(p.advancementB, .9);
  assert.equal(p.ambiguousB, true); assert.equal(p.qualified, false); assert.equal(p.reason, "ambiguous-display-coordinate");
});

test("adversarial: duplicate identical frames remain usable, differing frames are ambiguous on either camera", () => {
  const a = camera(), b = camera("B"); a.frame(1, 2000); a.frame(1, 2000); b.frame(1, 2000); b.frame(1, 2000);
  assert.ok(pairs(a, b).every(p => p.qualified && !p.ambiguousA && !p.ambiguousB));
  a.frame(1.7, 2000); assert.ok(pairs(a, b).every(p => !p.qualified && p.ambiguousA));
});

test("adversarial: display coordinates outside capture window stay raw but do not qualify", () => {
  const a = camera(), b = camera("B"); a.frame(1, 12000, 2000); b.frame(1, 12000, 2000);
  assert.equal(a.trace().records.length, 1); assert.equal(pairs(a, b).length, 0);
});

test("integration: raw hook refuses foreign sessions and incorrectly supplied landed anchors", () => {
  const native = new NativeVodSyncExperiment(experimentOptions({ Hls: FakeHls, createVideo: () => new FakeVideo() }));
  const unloaded = camera("drive_up", { sessionId: 1, presentationId: 1 });
  assert.throws(() => native.setRawRecorder("drive_up", unloaded.recorder), /ownership/);
  native.loadSources();
  assert.throws(() => native.setRawRecorder("drive_up", camera("drive_up").recorder), /ownership/);
  native.peers[0].initial = { mediaTime: 4, representedEpoch: 1004 };
  const incorrect = camera("drive_up", { sessionId: 1, presentationId: 1 });
  assert.throws(() => native.setRawRecorder("drive_up", incorrect.recorder), /landing/);
  const correct = camera("drive_up", { sessionId: 1, presentationId: 1,
    anchor: { id: "landed", mediaTime: 4, absoluteTime: 1004 } });
  native.setRawRecorder("drive_up", correct.recorder); assert.equal(native.peers[0].rawRecorder, correct.recorder);
});

test("adversarial: first raw, accepted and advancing callbacks are distinct evidence", () => {
  const a = camera(); const raw = a.frame(0, 1100, 1100, { presentationTime: 999 });
  const accepted = a.frame(0, 1101); const advancing = a.frame(.000001, 1102);
  const result = analyzeCameraTrace(a.trace());
  assert.equal(result.firstRaw, raw); assert.equal(result.firstAccepted, accepted); assert.equal(result.firstAdvancing, advancing);
  assert.equal(result.repeatedAnchor.length, 2);
});

test("integration: stale player replacement cannot contaminate raw startup analysis", () => {
  const native = new NativeVodSyncExperiment(experimentOptions({ Hls: FakeHls, createVideo: () => new FakeVideo() }));
  native.loadSources(); const peer = native.peers[0], original = peer.video;
  const a = camera("drive_up", { sessionId: 1, presentationId: 1 }); native.setRawRecorder("drive_up", a.recorder);
  peer.video = new FakeVideo(); original.frame(1000, { mediaTime: 99, expectedDisplayTime: 1000 });
  assert.equal(a.trace().records[0].reason, "stale-operation");
  assert.equal(analyzeCameraTrace(a.trace()).firstAdvancing, null);
});

test("adversarial: different document origins and invalid bounds cannot manufacture comparisons", () => {
  const a = camera(), b = camera("B", { timeOriginId: "other-document" });
  assert.throws(() => pairs(a, b), /time origins/);
  assert.throws(() => camera("A", { maxRecords: Infinity }), /bounded/);
  assert.throws(() => camera("A", { durationMs: 0 }), /bounded/);
  assert.throws(() => pairs(a, camera("B"), { maxDistanceMs: NaN }), /distance/);
});

test("adversarial: missing media metadata stays raw and cannot produce advancement or residual", () => {
  const a = camera(), b = camera("B"); const r = a.frame(0, 1100, 1100, { mediaTime: NaN }); b.frame(0, 1100);
  assert.equal(r.reason, "missing-media-time"); assert.equal(r.normalizedAdvancement, null);
  assert.equal(analyzeCameraTrace(a.trace()).firstAdvancing, null); assert.equal(pairs(a, b).length, 0);
});
