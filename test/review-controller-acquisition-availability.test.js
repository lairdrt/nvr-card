// Review availability, acquisition classification and failure ledger.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ReviewController
} from "../src/review/review-controller.js";
import {
  presentationPrepared,
  setReviewTi,
  createHistoricalHarness,
  waitForHistoricalMedia,
  waitForCalls,
  waitForCondition,
  createRejoinHarness,
  createAvailabilityQueueHarness,
  createAvailabilityOwnershipHarness,
  track,
  flushMicrotasksUntil,
  atFirstMicrotask,
  assertPeerUndisturbed,
  manualInitialDeadlines,
  ACQUISITION_HISTORY_MODES,
  ACQUISITION_PROGRESS_FLAGS,
  acquisitionProgress,
  useAcquisitionHistory,
  alterAcquisitionHistory,
  recordCameraTransitions,
  recordCameraClassifications,
  acquisitionCommands,
  INITIAL_ACQUISITION_FAILURES,
  runInitialAcquisitionFailure,
  INITIAL_DEADLINE_SCENARIOS,
  runInitialDeadline,
  flushManifestMicrotasksUntil,
  createManifestIsolationHarness,
  assertManifestIsolationCleanup,
  runManifestIsolationSuccess,
  runManifestIsolationRejoin,
  createContinuationFailureExperiment
} from "./review-controller-test-support.js";

test("availability queue: requests during an evaluation coalesce into one follow-up", async t => {
  const queue = await createAvailabilityQueueHarness(t);
  const { controller, evaluations } = queue;
  let release;
  queue.gate = new Promise(resolve => { release = resolve; });
  const first = controller.queueHistoricalAvailabilityEvaluation("first_request");
  const joined = [1, 2, 3].map(() => controller.queueHistoricalAvailabilityEvaluation("joined"));
  assert.ok(joined.every(promise => promise === first), "in-flight requests join the owner");
  assert.equal(controller._availabilityEvaluationPending, true);
  queue.gate = null;
  release();
  await first;
  assert.equal(evaluations.length, 2);
  assert.ok(evaluations.every(entry => entry.end !== null));
  assert.equal(controller._availabilityEvaluationPending, false);
  assert.equal(controller._availabilityEvaluationPromise, null);
});


for (const failure of ["rejected", "synchronous throw"]) {
  test(`availability queue: ownership is released after a ${failure} evaluation`, async t => {
    const queue = await createAvailabilityQueueHarness(t);
    const { controller } = queue;
    const recorded = controller.evaluateHistoricalAvailability;
    let calls = 0;
    controller.evaluateHistoricalAvailability = (...args) => {
      calls += 1;
      if (calls > 1) return recorded(...args);
      if (failure === "rejected") return Promise.reject(new Error("evaluation failed"));
      throw new Error("evaluation threw");
    };
    await controller.queueHistoricalAvailabilityEvaluation("failing_request");
    assert.equal(controller._availabilityEvaluationPromise, null);
    await controller.queueHistoricalAvailabilityEvaluation("next_request");
    assert.equal(calls, 2, "a later request must run a new evaluation");
    assert.equal(controller._availabilityEvaluationPromise, null);
    assert.equal(controller._availabilityEvaluationPending, false);
  });
}


for (const debug of [false, true]) {
  test(`availability ownership: an older failure cannot supersede a newer successful recovery (debug=${debug})`, async t => {
    const scene = await createAvailabilityOwnershipHarness(t, { debug });
    const { controller, base, outage, requests, up, lifecycles, failureRecords, harness } = scene;
    outage.delete("drive_up");
    setReviewTi(controller, base + 7);
    const older = track(controller.reconcileHistoricalCamera(up, base + 7, { reason: "older" }));
    assert.equal(requests.length, 1);
    const revisionBeforeFailure = up.lifecycleRevision;
    requests[0].fail();
    // The exact race: the older request has released its promise, but its failure
    // has not yet been applied, when the newer recovery issues its own request.
    const newer = await atFirstMicrotask(() => up.availabilityPromise === null, () => {
      assert.equal(up.lifecycleRevision, revisionBeforeFailure,
        "the older failure must still be pending application");
      return track(controller.reconcileHistoricalCamera(up, base + 7, { reason: "newer" }));
    }, "the older request must release its in-flight promise");
    assert.equal(requests.length, 2, "the newer recovery issues its own request");
    await older.promise;
    assert.equal(older.value, "superseded");
    assert.equal(up.lifecycleRevision, revisionBeforeFailure, "a stale failure cannot change the revision");
    assert.deepEqual(failureRecords, [], "a stale failure is not recorded");
    requests[1].succeed();
    assert.equal(await newer.promise, "prepared");
    assert.equal(up.lifecycleState, "participating");
    assert.equal(lifecycles.some(entry => entry.camera === "Drive Up" && entry.state === "failed"), false);
    const prepare = harness.calls.filter(call =>
      call.type === "frigate_max/v2/vod/prepare" && call.camera === "drive_up").at(-1);
    assert.equal(prepare.target, base + 7, "recovery acquires at the current Review TI");
    assert.equal(up.resolvedEpoch, base + 7);
    assert.equal(up.initialPlacement.landedEpoch, base + 7);
    assert.equal(up.video.paused, false, "the recovered camera follows Play intent");
    assert.equal(controller.clock.running, true);
    assertPeerUndisturbed(scene);
    assert.equal(controller._availabilityEvaluationPromise, null);
    assert.equal(controller._availabilityEvaluationPending, false);
  });
}


test("availability ownership: a current failure still fails the camera", async t => {
  const scene = await createAvailabilityOwnershipHarness(t);
  const { controller, base, outage, requests, up, lifecycles, failureRecords } = scene;
  outage.delete("drive_up");
  const revision = up.lifecycleRevision;
  const attempt = track(controller.reconcileHistoricalCamera(up, base, { reason: "current" }));
  requests[0].fail();
  assert.equal(await attempt.promise, "availability_failure");
  assert.equal(up.lifecycleState, "failed");
  assert.equal(up.boundaryReason, "availability_api_failure");
  assert.equal(up.lifecycleRevision, revision + 1);
  assert.deepEqual(lifecycles.filter(entry => entry.camera === "Drive Up"),
    [{ camera: "Drive Up", state: "failed", reason: "availability_api_failure" }]);
  assert.deepEqual(failureRecords,
    [{ camera: "Drive Up", reason: "availability_api_failure", outcome: "failure" }]);
  assertPeerUndisturbed(scene);
});


test("availability ownership: a newer attempt joining an in-flight request shares its genuine failure", async t => {
  const scene = await createAvailabilityOwnershipHarness(t);
  const { controller, base, outage, requests, up, lifecycles } = scene;
  outage.delete("drive_up");
  const older = track(controller.reconcileHistoricalCamera(up, base, { reason: "older" }));
  const newer = track(controller.reconcileHistoricalCamera(up, base, { reason: "newer" }));
  assert.equal(requests.length, 1, "the newer attempt joins the in-flight request");
  requests[0].fail();
  await Promise.all([older.promise, newer.promise]);
  assert.deepEqual([older.value, newer.value], ["availability_failure", "superseded"]);
  assert.equal(up.lifecycleState, "failed");
  assert.equal(lifecycles.filter(entry => entry.camera === "Drive Up" && entry.state === "failed").length, 1);
  assertPeerUndisturbed(scene);
});


test("availability ownership: a stale success cannot overwrite a newer request's failure", async t => {
  const scene = await createAvailabilityOwnershipHarness(t, { autoplay: false });
  const { controller, base, outage, requests, up } = scene;
  outage.delete("drive_up");
  const older = track(controller.reconcileHistoricalCamera(up, base, { reason: "older" }));
  assert.equal(requests.length, 1);
  const seek = controller.seekHistoricalToEpoch(base + 5, { autoplay: false });
  await flushMicrotasksUntil(() => requests.length === 2, "the explicit seek issues a newer request");
  requests[1].fail();
  await seek;
  assert.equal(up.lifecycleState, "failed");
  assert.equal(up.boundaryReason, "availability_api_failure");
  const revision = up.lifecycleRevision;
  requests[0].succeed();
  assert.equal(await older.promise, "stale");
  assert.equal(up.availability, null, "a stale success cannot install availability");
  assert.equal(up.lifecycleState, "failed");
  assert.equal(up.lifecycleRevision, revision);
  // The explicit seek legitimately pauses the peer; it must keep its presentation.
  assert.equal(scene.down.lifecycleState, "participating");
  assert.strictEqual(scene.down.hls, scene.downBefore.hls);
});


test("availability ownership: leaving historical playback rejects a pending failure", async t => {
  const scene = await createAvailabilityOwnershipHarness(t);
  const { controller, base, outage, requests, up, lifecycles } = scene;
  outage.delete("drive_up");
  const older = track(controller.reconcileHistoricalCamera(up, base, { reason: "older" }));
  controller.returnToLive();
  const count = lifecycles.length;
  requests[0].fail();
  assert.equal(await older.promise, "stale");
  assert.equal(lifecycles.length, count);
  assert.equal(controller._historicalPlayers.size, 0);
});


test("availability ownership: cameras recover independently of another camera's pending failure", async t => {
  const scene = await createAvailabilityOwnershipHarness(t);
  const { controller, base, outage, requests, up, down, harness } = scene;
  outage.delete("drive_up");
  requests.manual = new Set(["drive_down"]);
  // A refresh of a window the shared cache does not hold yet issues a real request.
  const downAttempt = track(controller.reconcileHistoricalCamera(down, base + 7205, { reason: "peer_refresh" }));
  const upAttempt = track(controller.reconcileHistoricalCamera(up, base, { reason: "recovery" }));
  const downRequest = requests.find(request => request.camera === "drive_down");
  const upRequest = requests.find(request => request.camera === "drive_up");
  upRequest.succeed();
  assert.equal(await upAttempt.promise, "prepared");
  assert.equal(up.lifecycleState, "participating");
  assert.equal(downAttempt.settled, false, "the peer's request is still pending");
  downRequest.fail();
  assert.equal(await downAttempt.promise, "retained_after_availability_failure");
  assert.equal(down.lifecycleState, "participating");
  assert.strictEqual(down.hls, scene.downBefore.hls);
  assert.equal(up.lifecycleState, "participating");
  assert.equal(harness.playCalls.filter(call => call.camera === "Drive Down").length,
    scene.downBefore.plays);
});


test("a superseded rejoin Play settlement cannot change current camera state", async t => {
  const target = 1800000000;
  let resolveOldPlay;
  const oldPlay = new Promise(resolve => { resolveOldPlay = resolve; });
  let downPlayCount = 0;
  const harness = createRejoinHarness(target, {
    playResponder: camera => camera !== "Drive Down" ? Promise.resolve() :
      ++downPlayCount === 1 ? oldPlay : Promise.resolve()
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  setReviewTi(harness.controller, target + 6);
  const oldDown = harness.controller._historicalPlayers.get("Drive Down");
  const oldJoin = harness.controller.evaluateHistoricalAvailability(null, { reason: "old_play" });
  await waitForCondition(() => oldDown.transition?.playPending === true);
  const newer = harness.controller.playHistorical(target + 30, { autoplay: false });
  await newer;
  const currentDown = harness.controller._historicalPlayers.get("Drive Down");
  assert.notStrictEqual(currentDown, oldDown);
  assert.equal(currentDown.lifecycleState, "participating");
  const currentHls = currentDown.hls;
  resolveOldPlay();
  await oldJoin;
  assert.strictEqual(currentDown.hls, currentHls);
  assert.equal(currentDown.lifecycleState, "participating");
  assert.equal(currentDown.video.paused, true);
});


test("rejoin Play rejection and timeout fail only that camera", async t => {
  const target = 1800000000;
  for (const outcome of ["reject", "timeout"]) {
    const harness = createRejoinHarness(target, {
      playResponder: camera => camera !== "Drive Down" ? Promise.resolve() :
        outcome === "reject" ? Promise.reject(new Error("synthetic Play rejection")) :
          new Promise(() => {})
    });
    t.after(() => harness.close());
    await harness.controller.playHistorical(target);
    harness.controller._mediaReadyTimeoutMs = 30;
    setReviewTi(harness.controller, target + 6);
    const up = harness.controller._historicalPlayers.get("Drive Up");
    const down = harness.controller._historicalPlayers.get("Drive Down");
    const upHls = up.hls;
    const upPauseCount = up.video.pauseCount;
    const upPlayCount = harness.playCalls.filter(call => call.camera === "Drive Up").length;
    await harness.controller.evaluateHistoricalAvailability(null, { reason: `play_${outcome}` });
    assert.equal(down.lifecycleState, "failed");
    assert.equal(down.boundaryReason, outcome === "reject"
      ? "rejoin_play_rejected" : "rejoin_play_timeout");
    assert.equal(down.video.paused, true);
    assert.equal(up.lifecycleState, "participating");
    assert.strictEqual(up.hls, upHls);
    assert.equal(up.video.pauseCount, upPauseCount);
    assert.equal(harness.playCalls.filter(call => call.camera === "Drive Up").length, upPlayCount);
    assert.equal(harness.controller.clock.running, true);
  }
});


test("non-RVFC rejoin retains explicitly weaker readiness evidence", async t => {
  const target = 1800000000;
  const harness = createRejoinHarness(target, { noRvfc: new Set(["Drive Down"]) });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  setReviewTi(harness.controller, target + 6);
  const down = harness.controller._historicalPlayers.get("Drive Down");
  await harness.controller.evaluateHistoricalAvailability(null, { reason: "fallback_rejoin" });
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.initialPlacement.verifiedFrame, false);
  assert.equal(down.initialPlacement.landedEpoch, null);
});


test("a held gap frame remains separate from participation through rejoin", async t => {
  const target = 1800000000;
  const deferredFrame = new Set();
  const harness = createHistoricalHarness({
    now: () => 0,
    deferredFrame,
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_down"
        ? [{ start: target, end: target + 10 },
          { start: target + 20, end: target + 40 }]
        : [{ start: message.start, end: message.end }]
    })
  });
  t.after(() => harness.close());
  harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  await harness.controller.playHistorical(target);
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const initialControl = harness.mediaControls.find(item => item.camera === "Drive Down");
  initialControl.emitFrame();
  assert.ok(down.heldCanvas?.hidden);
  setReviewTi(harness.controller, target + 10);
  down.video.currentTime = down.timing.logical_media_end_position;
  await harness.controller.evaluateHistoricalAvailability(null, { reason: "gap_hold" });
  assert.equal(down.lifecycleState, "unavailable");
  assert.equal(down.heldCanvas.hidden, false);
  assert.equal(down.statusElement.hidden, true);
  assert.ok(down.holdStartedAtMs != null);
  const heldOpacity = harness.window.getComputedStyle(down.heldCanvas).opacity;
  const heldFilter = harness.window.getComputedStyle(down.heldCanvas).filter;
  deferredFrame.add("Drive Down");
  setReviewTi(harness.controller, target + 21);
  const join = harness.controller.evaluateHistoricalAvailability(null, { reason: "gap_rejoin" });
  await waitForCondition(() => down.video?.currentTimeWrites?.length === 1 &&
    down.lifecycleState === "preparing");
  assert.equal(down.heldCanvas.hidden, false);
  assert.equal(down.statusElement.hidden, true);
  assert.equal(harness.window.getComputedStyle(down.heldCanvas).opacity, heldOpacity);
  assert.equal(harness.window.getComputedStyle(down.heldCanvas).filter, heldFilter);
  assert.equal(down.heldCanvas.style.opacity, "");
  assert.equal(down.heldCanvas.style.filter, "");
  assert.equal(harness.controller.clock.running, true);
  const rejoinControl = harness.mediaControls.findLast(item => item.camera === "Drive Down");
  rejoinControl.emitFrame();
  await join;
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.heldCanvas.hidden, true);
  assert.equal(down.holdStartedAtMs, null);
  assert.equal(down.initialPlacement.verifiedFrame, true);
});


test("a camera leaves at a genuine gap while its peer continues, then rejoins the next cached interval", async t => {
  const target = 1800000000;
  const harness = createHistoricalHarness({
    now: () => 0,
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_down"
        ? [
          { start: target, end: target + 10 },
          { start: target + 20, end: target + 40 }
        ]
        : [{ start: message.start, end: message.end }]
    })
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const upHls = up.hls;
  const upPauseCount = up.video.pauseCount;
  down.video.currentTime = target + 10 - down.timing.effective_absolute_origin;
  up.video.currentTime = target + 10 - up.timing.effective_absolute_origin;
  setReviewTi(harness.controller, target + 10);
  await harness.controller.evaluateHistoricalAvailability(null, { reason: "gap_entry" });
  assert.equal(down.lifecycleState, "unavailable");
  assert.equal(down.nextCoverageStart, target + 20);
  assert.strictEqual(up.hls, upHls);
  assert.equal(up.video.pauseCount, upPauseCount);
  assert.equal(harness.controller.clock.running, true);

  up.video.currentTime = target + 21 - up.timing.effective_absolute_origin;
  setReviewTi(harness.controller, target + 21);
  await harness.controller.evaluateHistoricalAvailability(null, { reason: "next_interval" });
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.resolvedEpoch, target + 21);
  assert.strictEqual(up.hls, upHls);
});


test("explicit seeks reconcile covered and uncovered cameras independently", async t => {
  const target = 1800000000;
  const harness = createHistoricalHarness({
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_down"
        ? [{ start: target + 20, end: target + 50 }]
        : [{ start: message.start, end: message.end }]
    })
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const upHls = up.hls;
  const before = harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare").length;
  await harness.controller.seekHistoricalToEpoch(target + 25, { autoplay: false });
  assert.strictEqual(up.hls, upHls);
  assert.equal(down.lifecycleState, "participating");
  assert.equal(
    harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare").length,
    before + 1
  );

  await harness.controller.seekHistoricalToEpoch(target + 10, { autoplay: false });
  assert.equal(down.lifecycleState, "unavailable");
  assert.strictEqual(up.hls, upHls);
});


test("an explicit covered seek reuses maps that contain it and prepares only the camera outside its map", async t => {
  const target = 1800000000;
  const harness = createHistoricalHarness({
    presentationResponder: message => Promise.resolve(presentationPrepared(
      message.camera,
      message.target - 20,
      message.target,
      message.camera === "drive_up" ? message.target + 400 : message.target + 40
    ))
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const upHls = up.hls;
  const downHls = down.hls;
  const before = harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare").length;
  await harness.controller.seekHistoricalToEpoch(target + 100, { autoplay: false });
  assert.strictEqual(up.hls, upHls);
  assert.notStrictEqual(down.hls, downHls);
  const added = harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare").slice(before);
  assert.deepEqual(added.map(call => call.camera), ["drive_down"]);
});


test("availability cache misses refresh once and API failure preserves a functioning player", async t => {
  const target = 1800000000;
  let failDriveUp = false;
  const harness = createHistoricalHarness({
    availabilityResponder: message => failDriveUp && message.camera === "drive_up"
      ? Promise.reject(new Error("synthetic availability outage"))
      : Promise.resolve({
        camera: message.camera,
        requested_start: message.start,
        requested_end: message.end,
        coverage: [{ start: message.start, end: message.end }]
      })
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const hls = up.hls;
  const availabilityBefore = harness.calls.filter(call =>
    call.type === "frigate_max/v1/recordings/availability" && call.camera === "drive_up").length;
  // Aligned 2 h windows: target + 7300 is the first epoch of an unloaded window.
  await harness.controller.ensureCameraAvailability(up, target + 7300, { reason: "cache_miss" });
  assert.equal(harness.calls.filter(call =>
    call.type === "frigate_max/v1/recordings/availability" && call.camera === "drive_up").length,
  availabilityBefore + 1);
  failDriveUp = true;
  const outcome = await harness.controller.reconcileHistoricalCamera(up, target + 14500, {
    explicit: false, reason: "outage"
  });
  assert.equal(outcome, "retained_after_availability_failure");
  assert.strictEqual(up.hls, hls);
  assert.equal(up.lifecycleState, "participating");
});


test("V2 no-recording after cached coverage refreshes once and suppresses retry loops", async t => {
  const target = 1800000000;
  // Counts playback availability lookups only; timeline coverage is display-only.
  const harness = createHistoricalHarness({ unavailable: new Set(["drive_down"]),
    recordingCoverage: false });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const v2Count = () => harness.calls.filter(call =>
    call.type === "frigate_max/v2/vod/prepare" && call.camera === "drive_down").length;
  const availabilityCount = () => harness.calls.filter(call =>
    call.type === "frigate_max/v1/recordings/availability" && call.camera === "drive_down").length;
  assert.equal(v2Count(), 1);
  assert.equal(availabilityCount(), 2);
  await harness.controller.evaluateHistoricalAvailability(target, { reason: "repeat_boundary" });
  await harness.controller.evaluateHistoricalAvailability(target, { reason: "repeat_boundary" });
  assert.equal(v2Count(), 1);
  assert.equal(availabilityCount(), 2);
  assert.equal(down.lifecycleState, "unavailable");
});


test("a stale late join after a newer explicit seek cannot attach or overwrite the newer player", async t => {
  const target = 1800000000;
  let releaseOld;
  let downPrepareCount = 0;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  const harness = createHistoricalHarness({
    now: () => 0,
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_down"
        ? [{ start: target + 5, end: target + 100 }]
        : [{ start: message.start, end: message.end }]
    }),
    presentationResponder: message => {
      if (message.camera !== "drive_down") {
        return Promise.resolve(presentationPrepared(message.camera, message.target - 20, message.target));
      }
      downPrepareCount += 1;
      const result = presentationPrepared(message.camera, message.target - 20, message.target);
      return downPrepareCount === 1 ? oldGate.then(() => result) : Promise.resolve(result);
    }
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  up.video.currentTime = target + 6 - up.timing.effective_absolute_origin;
  setReviewTi(harness.controller, target + 6);
  const oldJoin = harness.controller.evaluateHistoricalAvailability(null, { reason: "old_join" });
  await waitForCondition(() => downPrepareCount === 1);
  const newerSeek = harness.controller.seekHistoricalToEpoch(target + 30, { autoplay: false });
  await waitForCondition(() => downPrepareCount === 2);
  await newerSeek;
  const currentHls = down.hls;
  const currentTiming = down.timing;
  releaseOld();
  await oldJoin;
  assert.strictEqual(down.hls, currentHls);
  assert.strictEqual(down.timing, currentTiming);
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.resolvedEpoch, target + 30);
});


test("a stale late join after reassignment cannot affect the replacement camera", async t => {
  const target = 1800000000;
  let releaseDown;
  const downGate = new Promise(resolve => { releaseDown = resolve; });
  const harness = createHistoricalHarness({
    now: () => 0,
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_down"
        ? [{ start: target + 5, end: target + 100 }]
        : [{ start: message.start, end: message.end }]
    }),
    presentationResponder: message => {
      const result = presentationPrepared(message.camera, message.target - 20, message.target);
      return message.camera === "drive_down" ? downGate.then(() => result) : Promise.resolve(result);
    }
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  up.video.currentTime = target + 6 - up.timing.effective_absolute_origin;
  setReviewTi(harness.controller, target + 6);
  const staleJoin = harness.controller.evaluateHistoricalAvailability(null, {
    reason: "join_before_reassignment"
  });
  await waitForCalls(harness, "frigate_max/v2/vod/prepare", 2);
  harness.controller.setSelectedCameraNames(["Drive Up", "Back"]);
  await harness.controller.playHistorical(target + 30, {
    cameraNames: ["Drive Up", "Back"]
  });
  const replacement = harness.controller._historicalPlayers.get("Back");
  const replacementHls = replacement.hls;
  releaseDown();
  await staleJoin;
  assert.equal(harness.controller._historicalPlayers.has("Drive Down"), false);
  assert.strictEqual(harness.controller._historicalPlayers.get("Back"), replacement);
  assert.strictEqual(replacement.hls, replacementHls);
  assert.equal(replacement.lifecycleState, "participating");
});


test("rapid boundary evaluation creates only one concurrent preparation per camera", async t => {
  const target = 1800000000;
  let release;
  let downPrepares = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createHistoricalHarness({
    now: () => 0,
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_down"
        ? [{ start: target + 5, end: target + 30 }]
        : [{ start: message.start, end: message.end }]
    }),
    presentationResponder: message => {
      const result = presentationPrepared(message.camera, message.target - 20, message.target);
      if (message.camera !== "drive_down") return Promise.resolve(result);
      downPrepares += 1;
      return gate.then(() => result);
    }
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  up.video.currentTime = target + 6 - up.timing.effective_absolute_origin;
  setReviewTi(harness.controller, target + 6);
  const first = harness.controller.evaluateHistoricalAvailability(null, { reason: "boundary_one" });
  await waitForCondition(() => downPrepares === 1);
  const second = harness.controller.evaluateHistoricalAvailability(null, { reason: "boundary_two" });
  await second;
  assert.equal(downPrepares, 1);
  release();
  await first;
});


test("Review TI determines rejoin while a healthy camera retains its own media boundary", async t => {
  const target = 1800000000;
  const harness = createHistoricalHarness({
    now: () => 0,
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_down"
        ? [{ start: target + 10, end: target + 20 }]
        : [{ start: message.start, end: message.end }]
    })
  });
  t.after(() => harness.close());
  harness.controller.setPlaybackSpeed(8);
  await harness.controller.playHistorical(target);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  setReviewTi(harness.controller, target + 100);
  up.video.currentTime = target + 5 - up.timing.effective_absolute_origin;
  await harness.controller.evaluateHistoricalAvailability(null, { reason: "clock_lead" });
  assert.equal(down.lifecycleState, "unavailable");
  up.video.currentTime = target + 11 - up.timing.effective_absolute_origin;
  setReviewTi(harness.controller, target + 11);
  await harness.controller.evaluateHistoricalAvailability(null, { reason: "media_entry" });
  assert.equal(down.lifecycleState, "participating");
  down.video.currentTime = target + 19 - down.timing.effective_absolute_origin;
  setReviewTi(harness.controller, target + 19);
  await harness.controller.evaluateHistoricalAvailability(null, { reason: "clock_leave_lead" });
  assert.equal(down.lifecycleState, "participating");
});


test("logical V2 exhaustion preserves a genuine recording gap", async t => {
  const target = 1800000000;
  const range = { from: target - 15, to: target + 300 };
  const gapHarness = createHistoricalHarness({
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_down"
        ? [{ start: message.start, end: target + 120 }]
        : [{ start: message.start, end: message.end }]
    })
  });
  t.after(() => gapHarness.close());
  gapHarness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  await gapHarness.controller.playHistorical(target, { playbackRange: range });
  const gapPlayer = gapHarness.controller._historicalPlayers.get("Drive Down");
  gapHarness.mediaControls.find(control => control.camera === "Drive Down").emitFrame();
  gapPlayer.video.currentTime = gapPlayer.timing.logical_media_end_position;
  gapPlayer.video.dispatchEvent(new gapHarness.window.Event("ended"));
  await waitForCondition(() => gapPlayer.lifecycleState !== "participating");
  assert.equal(gapPlayer.lifecycleState, "unavailable");
  assert.equal(gapPlayer.boundaryReason, "authoritative_recording_gap");
  assert.equal(gapPlayer.heldCanvas.hidden, false);
  assert.equal(gapHarness.root.querySelector(
    '.review-camera-panel[data-camera="Drive Down"] .review-camera-presentation-kind'
  ).textContent, "");
  assert.equal(gapHarness.controller._historicalPlayers.get("Drive Up").lifecycleState, "participating");
  assert.equal(gapHarness.controller.clock.running, true);

});


test("a bounded continuous presentation crosses the old 120-second cutoff without reacquisition", async t => {
  const target = 1800000000;
  const range = { from: target - 15, to: target + 300 };
  const harness = createHistoricalHarness({
    presentationResponder: message => Promise.resolve(presentationPrepared(
      message.camera, message.target - 21, message.target, message.bounds_end
    ))
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target, { playbackRange: range });
  const player = harness.controller._historicalPlayers.get("Drive Down");
  const hls = player.hls;
  const prepareCount = harness.calls.filter(call =>
    call.type === "frigate_max/v2/vod/prepare" && call.camera === "drive_down").length;
  assert.equal(player.timing.logical_wall_end, range.to);
  player.video.currentTime = target + 121 - player.timing.effective_absolute_origin;
  assert.equal(harness.controller.enforceHistoricalPresentationBoundary(), false);
  assert.equal(player.lifecycleState, "participating");
  assert.strictEqual(player.hls, hls);
  assert.equal(harness.calls.filter(call =>
    call.type === "frigate_max/v2/vod/prepare" && call.camera === "drive_down").length,
  prepareCount);
  player.video.currentTime = player.timing.logical_media_end_position;
  await harness.controller.resolveHistoricalVideoEnd(player, player.generation);
  await harness.controller.evaluateHistoricalAvailability(range.to, {
    reason: "requested_playback_end"
  });
  assert.equal(player.lifecycleState, "participating",
    "the requested investigation end is handled by the playback boundary");
  assert.strictEqual(player.hls, hls);
});


test("a finite end without a presented frame never claims a held last frame", async t => {
  const target = 1800000000;
  const range = { from: target - 15, to: target + 300 };
  // A verified landing is a presented frame; this camera cannot verify one.
  const harness = createHistoricalHarness({ now: () => 0, noRvfc: new Set(["Drive Down"]) });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target, { playbackRange: range });
  const player = harness.controller._historicalPlayers.get("Drive Down");
  const badge = harness.root.querySelector(
    '.review-camera-panel[data-camera="Drive Down"] .review-camera-presentation-kind'
  );
  assert.equal(player.heldCanvas, undefined);
  player.video.currentTime = player.timing.logical_media_end_position;
  setReviewTi(harness.controller, target + 120);
  await harness.controller.resolveHistoricalVideoEnd(player, player.generation);
  assert.equal(player.holdStartedAtMs, undefined);
  assert.equal(badge.textContent, "");
  await waitForCondition(() => player.lifecycleState === "participating" &&
    player.timing.selected_epoch === target + 120);
});


test("initial landing uses presented RVFC mediaTime once and leaves playing streams untouched", async t => {
  const harness = createHistoricalHarness({ now: () => 1000,
    frameOffsetByCamera: new Map([["Drive Up", -0.25], ["Drive Down", 0.45]])
  });
  t.after(() => harness.close());
  const target = 1800000000;
  await harness.controller.playHistorical(target);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  assert.equal(up.initialPlacement.verifiedFrame, true);
  assert.equal(down.initialPlacement.verifiedFrame, true);
  assert.ok(Math.abs(up.initialPlacement.landedMediaTime - (up.seek - 0.25)) < 1e-6);
  assert.ok(Math.abs(down.initialPlacement.landedMediaTime - (down.seek + 0.45)) < 1e-6);
  assert.ok(Math.abs(up.initialPlacement.offsetSeconds + 0.25) < 1e-4);
  assert.ok(Math.abs(down.initialPlacement.offsetSeconds - 0.45) < 1e-4);
  for (const player of [up, down]) {
    assert.deepEqual(player.video.currentTimeWrites, [player.seek]);
    assert.equal(player.initialPlacement.requestedEpoch, target);
  }
  assert.deepEqual(harness.playCalls.map(call => call.camera), ["Drive Up", "Drive Down"]);
  const before = [up, down].map(player => ({
    seeks: player.video.currentTimeWrites.length,
    rates: player.video.playbackRateWrites.length,
    hls: player.hls
  }));
  harness.controller.updateDiagnostics();
  harness.controller.enforceHistoricalPresentationBoundary();
  for (const player of [up, down]) {
    player.video.dispatchEvent(new harness.window.Event("timeupdate"));
  }
  await Promise.resolve();
  await Promise.resolve();
  for (const [index, player] of [up, down].entries()) {
    assert.equal(player.video.currentTimeWrites.length, before[index].seeks);
    assert.equal(player.video.playbackRateWrites.length, before[index].rates);
    assert.strictEqual(player.hls, before[index].hls);
  }
});


test("initial cameras place independently and wait for the slow peer before playback", async t => {
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const deadlines = manualInitialDeadlines();
  const harness = createHistoricalHarness({ preparationTimeoutMs: 1500, now: () => 1000,
    scheduleInitialDeadline: deadlines.schedule.bind(deadlines),
    presentationResponder: message => message.camera === "drive_down"
      ? slow.then(() => presentationPrepared(message.camera, message.target - 22, message.target))
      : Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target))
  });
  t.after(() => harness.close());
  const run = harness.controller.playHistorical(1800000000);
  await waitForCalls(harness, "frigate_max/v2/vod/prepare", 2);
  await waitForHistoricalMedia(harness, 1);
  await waitForCondition(() => harness.mediaControls[0].video.currentTimeWrites.length === 1);
  assert.deepEqual(harness.mediaControls[0].video.currentTimeWrites, [21]);
  assert.equal(harness.playCalls.length, 0);
  releaseSlow();
  await run;
  assert.deepEqual(harness.playCalls.map(call => call.camera), ["Drive Up", "Drive Down"]);
  assert.deepEqual(harness.mediaControls.map(control => control.video.currentTimeWrites.length), [1, 1]);
  assert.equal(deadlines.jobs.some(job => job.active), false);
});


test("a never-finishing VOD preparation does not block a ready peer after the deadline", async t => {
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const deadlines = manualInitialDeadlines();
  const harness = createHistoricalHarness({ preparationTimeoutMs: 1500, now: () => 1000,
    scheduleInitialDeadline: deadlines.schedule.bind(deadlines),
    presentationResponder: message => message.camera === "drive_down"
      ? slow.then(() => presentationPrepared(message.camera, message.target - 22, message.target))
      : Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target))
  });
  t.after(() => harness.close());
  const run = harness.controller.playHistorical(1800000000);
  await waitForCalls(harness, "frigate_max/v2/vod/prepare", 2);
  await waitForHistoricalMedia(harness, 1);
  await waitForCondition(() => harness.mediaControls[0].video.currentTimeWrites.length === 1);
  assert.deepEqual(harness.mediaControls[0].video.currentTimeWrites, [21]);
  await waitForCondition(() => harness.controller._historicalPlayers.get("Drive Up").lifecycleState === "participating");
  deadlines.jobs.find(job => job.active && job.delay === 1500).fire();
  deadlines.fireActive();
  await run;
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  assert.deepEqual(harness.playCalls.map(call => call.camera), ["Drive Up"]);
  assert.deepEqual(up.video.currentTimeWrites, [up.seek]);
  assert.equal(down.boundaryReason, "initial_preparation_deadline");
  releaseSlow();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.playCalls.length, 1);
  assert.equal(down.hls, null);
});


test("a camera without a landed frame cannot hold a ready peer past the group deadline", async t => {
  const deadlines = manualInitialDeadlines();
  const harness = createHistoricalHarness({ preparationTimeoutMs: 1500, now: () => 1000,
    deferredFrame: new Set(["Drive Down"]),
    scheduleInitialDeadline: deadlines.schedule.bind(deadlines)
  });
  t.after(() => harness.close());
  const run = harness.controller.playHistorical(1800000000);
  await waitForHistoricalMedia(harness, 2);
  await waitForCondition(() => harness.mediaControls.every(control =>
    control.video.currentTimeWrites.length === 1));
  assert.equal(harness.playCalls.length, 0);
  await waitForCondition(() => harness.controller._historicalPlayers.get("Drive Up").lifecycleState === "participating");
  deadlines.jobs.find(job => job.active && job.delay === 1500).fire();
  deadlines.fireActive();
  await run;
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  assert.deepEqual(harness.playCalls.map(call => call.camera), ["Drive Up"]);
  assert.equal(up.initialPlacement.verifiedFrame, true);
  assert.equal(down.boundaryReason, "initial_landing_deadline");
  assert.deepEqual(up.video.currentTimeWrites, [up.seek]);
});


test("initial gap and source failure do not reseek a healthy camera", async t => {
  const gap = createHistoricalHarness({ unavailable: new Set(["drive_down"]) });
  t.after(() => gap.close());
  await gap.controller.playHistorical(1800000000);
  const gapUp = gap.controller._historicalPlayers.get("Drive Up");
  assert.deepEqual(gap.playCalls.map(call => call.camera), ["Drive Up"]);
  assert.deepEqual(gapUp.video.currentTimeWrites, [gapUp.seek]);
  assert.equal(gap.controller._historicalPlayers.get("Drive Down").lifecycleState, "unavailable");

  const failed = createHistoricalHarness({
    presentationResponder: message => message.camera === "drive_down"
      ? Promise.reject(new Error("synthetic source preparation failure"))
      : Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target))
  });
  t.after(() => failed.close());
  await failed.controller.playHistorical(1800000000);
  const up = failed.controller._historicalPlayers.get("Drive Up");
  assert.deepEqual(failed.playCalls.map(call => call.camera), ["Drive Up"]);
  assert.deepEqual(up.video.currentTimeWrites, [up.seek]);
  assert.equal(failed.controller._historicalPlayers.get("Drive Down").lifecycleState, "failed");
});


test("superseded post-seek RVFC cannot release an old acquisition", async t => {
  const deferredFrame = new Set(["Drive Up", "Drive Down"]);
  const harness = createHistoricalHarness({ deferredFrame });
  t.after(() => harness.close());
  const first = harness.controller.playHistorical(1800000000);
  await waitForHistoricalMedia(harness, 2);
  await waitForCondition(() => harness.mediaControls.every(control =>
    control.video.currentTimeWrites.length === 1));
  const oldCallbacks = harness.mediaControls.flatMap(control => control.pendingFrameCallbacks());
  assert.equal(oldCallbacks.length, 2);
  const second = harness.controller.playHistorical(1800000060);
  await waitForHistoricalMedia(harness, 4);
  await waitForCondition(() => harness.mediaControls.slice(2).every(control =>
    control.video.currentTimeWrites.length === 1));
  for (const callback of oldCallbacks) callback(0, {
    mediaTime: 21,
    presentationTime: harness.controller._now()
  });
  assert.equal(harness.playCalls.length, 0);
  for (const control of harness.mediaControls.slice(2)) control.emitFrame();
  await second;
  await first;
  assert.deepEqual(harness.playCalls.map(call => call.camera), ["Drive Up", "Drive Down"]);
  assert.equal(harness.controller.clock.absoluteTime >= 1800000060, true);
});


test("an RVFC frame presented before the final seek cannot establish landing", async t => {
  const harness = createHistoricalHarness({ preparationTimeoutMs: 1500, now: () => 1000, deferredFrame: new Set(["Drive Up"]) });
  t.after(() => harness.close());
  const run = harness.controller.playHistorical(1800000000);
  await waitForHistoricalMedia(harness, 2);
  const up = harness.mediaControls.find(control => control.camera === "Drive Up");
  await waitForCondition(() => up.video.currentTimeWrites.length === 1 &&
    up.pendingFrameCallbacks().length === 1);
  up.emitFrame(up.video.currentTime, -1);
  assert.equal(harness.playCalls.length, 0);
  assert.equal(up.pendingFrameCallbacks().length, 1);
  up.emitFrame();
  await run;
  assert.equal(harness.controller._historicalPlayers.get("Drive Up").initialPlacement.verifiedFrame, true);
  assert.equal(harness.playCalls.length, 2);
});


test("a frame from a replaced Hls source cannot establish initial readiness", async t => {
  const harness = createHistoricalHarness({ deferredFrame: new Set(["Drive Up"]) });
  t.after(() => harness.close());
  const run = harness.controller.playHistorical(1800000000);
  await waitForHistoricalMedia(harness, 2);
  const upControl = harness.mediaControls.find(control => control.camera === "Drive Up");
  await waitForCondition(() => upControl.video.currentTimeWrites.length === 1 &&
    upControl.pendingFrameCallbacks().length === 1);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  up.hls = { destroy() {} };
  upControl.emitFrame();
  await run;
  assert.equal(up.lifecycleState, "failed");
  assert.equal(up.initialPlacement, null);
  assert.deepEqual(harness.playCalls.map(call => call.camera), ["Drive Down"]);
});


test("initial Play dispatch invokes every peer before awaiting a pending or rejected Play", async t => {
  let releaseUp;
  const upPlay = new Promise(resolve => { releaseUp = resolve; });
  const harness = createHistoricalHarness({
    playResponder: camera => camera === "Drive Up"
      ? upPlay : Promise.reject(new Error("synthetic autoplay rejection"))
  });
  t.after(() => harness.close());
  const run = harness.controller.playHistorical(1800000000);
  await waitForCondition(() => harness.playCalls.length === 2);
  assert.deepEqual(harness.playCalls.map(call => call.camera), ["Drive Up", "Drive Down"]);
  releaseUp();
  await run;
  assert.equal(harness.controller._historicalPlayers.get("Drive Up").lifecycleState, "participating");
  assert.equal(harness.controller._historicalPlayers.get("Drive Down").lifecycleState, "failed");
});


test("browser without RVFC retains legacy readiness but never claims a landed frame", async t => {
  const harness = createHistoricalHarness({ noRvfc: new Set(["Drive Up", "Drive Down"]) });
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  for (const player of harness.controller._historicalPlayers.values()) {
    assert.equal(player.initialPlacement.verifiedFrame, false);
    assert.equal(player.initialPlacement.landedMediaTime, null);
    assert.equal(player.initialPlacement.landedEpoch, null);
  }
  assert.equal(harness.playCalls.length, 2);
});


test("D2 layout changes preserve a selected camera's pending RVFC admission", async t => {
  const target = 1800000000;
  const harness = createRejoinHarness(target, { deferredFrame: new Set(["Drive Down"]) });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  setReviewTi(harness.controller, target + 6);
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const join = harness.controller.evaluateHistoricalAvailability();
  await waitForCondition(() => down.video?.currentTimeWrites?.length === 1);
  harness.controller.setReviewLayout("2x2");
  harness.controller.setPrimaryCamera("Drive Down");
  harness.mediaControls.find(item => item.camera === "Drive Down").emitFrame();
  await join;
  assert.equal(down.lifecycleState, "participating");
});


test("D3 latest explicit placement owns autoplay in both directions", async t => {
  for (const latestAutoplay of [false, true]) {
    const deferredSeek = new Set();
    const harness = createHistoricalHarness({ now: () => 0, deferredSeek });
    t.after(() => harness.close());
    const target = 1800000000;
    await harness.controller.playHistorical(target);
    const players = [...harness.controller._historicalPlayers.values()];
    deferredSeek.add("Drive Up"); deferredSeek.add("Drive Down");
    const oldSeek = harness.controller.seekHistoricalToEpoch(target + 10, { autoplay: !latestAutoplay });
    await waitForCondition(() => players.every(player => player.video.currentTimeWrites.length === 2));
    const newSeek = harness.controller.seekHistoricalToEpoch(target + 20, { autoplay: latestAutoplay });
    await waitForCondition(() => players.every(player => player.video.currentTimeWrites.length === 3));
    harness.mediaControls.forEach(control => control.completeSeek());
    await Promise.all([oldSeek, newSeek]);
    assert.equal(harness.controller.clock.running, latestAutoplay);
    assert.ok(players.every(player => player.video.paused === !latestAutoplay));
    assert.equal(harness.controller.clock.absoluteTime, target + 20);
  }
});


test("D4 resume rejection is camera-local and does not retain false participation", async t => {
  const harness = createHistoricalHarness({ now: () => 0, playResponder: (camera, video) => {
    if (camera === "Drive Down") {
      video.pause();
      return Promise.reject(new Error("synthetic resume rejection"));
    }
    return Promise.resolve();
  }});
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000, { autoplay: false });
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const hls = up.hls;
  const pauses = up.video.pauseCount;
  const seeks = up.video.currentTimeWrites.length;
  harness.controller.resumePlayback();
  await waitForCondition(() => down.lifecycleState === "failed");
  assert.equal(up.lifecycleState, "participating");
  assert.strictEqual(up.hls, hls);
  assert.equal(up.video.pauseCount, pauses);
  assert.equal(up.video.currentTimeWrites.length, seeks);
  assert.equal(up.video.paused, false);
});


test("D5 pending initial Play does not block another selected camera rejoin", async t => {
  const target = 1800000000;
  let releaseUp;
  const upPlay = new Promise(resolve => { releaseUp = resolve; });
  const harness = createRejoinHarness(target, {
    playResponder: camera => camera === "Drive Up" ? upPlay : Promise.resolve()
  });
  t.after(() => harness.close());
  const initial = harness.controller.playHistorical(target);
  await waitForCondition(() => harness.playCalls.length === 1);
  setReviewTi(harness.controller, target + 6);
  await harness.controller.evaluateHistoricalAvailability();
  const state = harness.controller._historicalPlayers.get("Drive Down").lifecycleState;
  releaseUp();
  await initial;
  assert.equal(state, "participating");
});


test("D6 shrinking layout retires removed playback without disturbing retained camera", async t => {
  const harness = createHistoricalHarness({ now: () => 0 });
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const hls = up.hls;
  const pauses = up.video.pauseCount;
  const seeks = up.video.currentTimeWrites.length;
  harness.controller.setReviewLayout("1x1");
  assert.equal(harness.controller.state.selectedCameraNames.includes("Drive Down"), false);
  assert.equal(down.video.paused, true);
  assert.equal(down.hls, null);
  assert.equal(harness.controller._historicalPlayers.has("Drive Down"), false);
  assert.strictEqual(up.hls, hls);
  assert.equal(up.video.pauseCount, pauses);
  assert.equal(up.video.currentTimeWrites.length, seeks);
  assert.equal(up.video.paused, false);
});


test("D3 Play and Pause during explicit placement override captured intent", async t => {
  for (const play of [true, false]) {
    const deferredSeek = new Set();
    const harness = createHistoricalHarness({ now: () => 0, deferredSeek });
    t.after(() => harness.close());
    await harness.controller.playHistorical(1800000000, { autoplay: false });
    deferredSeek.add("Drive Up"); deferredSeek.add("Drive Down");
    const placement = harness.controller.seekHistoricalToEpoch(1800000010, { autoplay: !play });
    await waitForCondition(() => harness.mediaControls.every(control => control.video.currentTimeWrites.length === 2));
    assert.equal(play ? harness.controller.resumePlayback() : harness.controller.pausePlayback(), true);
    harness.mediaControls.forEach(control => control.completeSeek());
    await placement;
    assert.equal(harness.controller.clock.running, play);
    assert.ok([...harness.controller._historicalPlayers.values()].every(player => player.video.paused === !play));
  }
});


test("D4 obsolete resume rejection cannot retire a newer paused presentation", async t => {
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const harness = createHistoricalHarness({ now: () => 0,
    playResponder: camera => camera === "Drive Down" ? pending : Promise.resolve() });
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000, { autoplay: false });
  harness.controller.resumePlayback();
  await harness.controller.seekHistoricalToEpoch(1800000030, { autoplay: false });
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const hls = down.hls;
  const timing = down.timing;
  reject(new Error("obsolete Play rejection"));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(down.hls, hls);
  assert.strictEqual(down.timing, timing);
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.video.paused, true);
});


test("D5 initial Play timeout is bounded and leaves a healthy peer untouched", async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const harness = createHistoricalHarness({ now: () => 0, mediaReadyTimeoutMs: 100,
    playResponder: camera => camera === "Drive Down" ? pending : Promise.resolve() });
  t.after(() => harness.close());
  const initial = harness.controller.playHistorical(1800000000);
  await waitForCondition(() => harness.playCalls.length === 2);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const hls = up.hls;
  const pauses = up.video.pauseCount;
  const seeks = up.video.currentTimeWrites.length;
  await initial;
  assert.equal(down.lifecycleState, "failed");
  assert.equal(down.boundaryReason, "play_timeout");
  assert.equal(up.lifecycleState, "participating");
  assert.strictEqual(up.hls, hls);
  assert.equal(up.video.pauseCount, pauses);
  assert.equal(up.video.currentTimeWrites.length, seeks);
  assert.equal(up.video.paused, false);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(down.lifecycleState, "failed");
  assert.equal(down.hls, null);
});


test("D6 obsolete preparation cannot restore a camera removed by layout shrink", async t => {
  const target = 1800000000;
  let release;
  let requested = false;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createRejoinHarness(target, { presentationResponder: message => {
    const result = presentationPrepared(message.camera, message.target - 20, message.target);
    if (message.camera === "drive_down") { requested = true; return gate.then(() => result); }
    return Promise.resolve(result);
  }});
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  setReviewTi(harness.controller, target + 6);
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const join = harness.controller.evaluateHistoricalAvailability();
  await waitForCondition(() => requested);
  harness.controller.setReviewLayout("1x1");
  release();
  await join;
  assert.equal(harness.controller._historicalPlayers.has("Drive Down"), false);
  assert.equal(down.hls, null);
  assert.equal(down.timing, undefined);
  assert.equal(harness.playCalls.some(call => call.camera === "Drive Down"), false);
});


test("Review failure ledger captures media and held-frame facts before destructive cleanup", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller.setDebug(false);
  await harness.controller.playHistorical(1800000000, { autoplay: false });
  assert.equal(harness.controller.getLatestHistoricalSyncReport(), null);
  const player = harness.controller._historicalPlayers.get("Drive Up");
  const video = player.video;
  const hls = player.hls;
  Object.defineProperty(video, "error", { configurable: true, value: { code: 3,
    message: "https://secret.example/token=private" } });
  player.heldCanvas = harness.window.document.createElement("canvas");
  player.heldCanvas.hidden = true;
  player.heldFrameEpoch = 1800000000.25;
  // A captured frame belongs to the presentation that presented it.
  player.heldFrameHls = hls;
  for (const handler of hls.handlers.get(hls.constructor.Events.ERROR) ?? []) {
    handler("error", { type: "networkError", details: "fragLoadError", fatal: false,
      response: { code: 503, body: "token=private" }, url: "https://secret.example" });
  }
  assert.equal(harness.controller.leaveHistoricalCamera(player, "unexpected_media_end",
    1800000001, 1800000000.25, "failed"), true);
  const record = harness.controller.getRecentReviewFailures()
    .find(item => item.reason === "unexpected_media_end");
  assert.equal(hls.destroyCount, 1);
  assert.equal(player.hls, null);
  assert.equal(record.video.errorCode, 3);
  assert.equal(record.video.seekable, true);
  assert.equal(record.hasTimingMap, true);
  assert.equal(record.validHeldFrame, true);
  assert.equal(record.frameEpoch, 1800000000.25);
  assert.deepEqual(record.hls, { type: "networkError", detail: "fragLoadError",
    fatal: false, httpStatus: 503 });
  assert.equal(JSON.stringify(record).includes("secret"), false);
});


test("Review failure ledger keeps coverage, VOD discrepancy, exhaustion, and Play failure distinct", async t => {
  const cases = [
    { options: { availabilityResponder: message => Promise.resolve({ camera: message.camera,
      requested_start: message.start, requested_end: message.end, coverage: [] }) },
    reason: "authoritative_recording_gap", outcome: "no_coverage", coverage: "gap" },
    { options: { unavailable: new Set(["drive_down"]) },
    reason: "prepare_reported_no_recording", outcome: "failure", coverage: "covered" },
    { options: { presentationResponder: message => message.camera === "drive_down"
      ? Promise.reject(new Error("synthetic preparation failure"))
      : Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target)) },
    reason: "camera_prepare_failed", outcome: "failure", coverage: "covered" },
    { options: { playResponder: camera => camera === "Drive Down"
      ? Promise.reject(new Error("private token in rejected Play")) : Promise.resolve() },
    reason: "play_rejected", outcome: "failure", coverage: "covered" }
  ];
  for (const item of cases) {
    const harness = createHistoricalHarness(item.options);
    t.after(() => harness.close());
    harness.controller.setDebug(false);
    await harness.controller.playHistorical(1800000000);
    const record = harness.controller.getRecentReviewFailures()
      .find(entry => entry.camera === "Drive Down" && entry.reason === item.reason);
    assert.ok(record, item.reason);
    assert.equal(record.outcome, item.outcome);
    assert.equal(record.coverage, item.coverage);
    if (item.outcome === "no_coverage") {
      assert.equal(harness.controller.getRecentReviewFailures().filter(entry =>
        entry.camera === "Drive Down" && entry.reason === item.reason).length, 1);
    }
    assert.equal(JSON.stringify(record).includes("private token"), false);
  }
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000, { autoplay: false });
  const player = harness.controller._historicalPlayers.get("Drive Up");
  harness.controller.leaveHistoricalCamera(player, "continuous_presentation_exhausted",
    1800000010, null);
  const record = harness.controller.getRecentReviewFailures()
    .find(entry => entry.reason === "continuous_presentation_exhausted");
  assert.equal(record.outcome, "normal_terminal");
  assert.equal(record.coverage, "covered");
});


test("Review failure ledger distinguishes signing, manifest, seekability, seek, and landing exits", async t => {
  const target = 1800000000;
  const cases = [
    { reason: "manifest_sign_failure", setup: harness => {
      harness.controller.signManifest = async player => {
        if (player.camera.name === "Drive Down") throw new Error("private signed URL");
        return "/fixture.m3u8";
      };
    } },
    { reason: "manifest_failure", setup: async harness => {
      const Base = await harness.controller._loadHls();
      harness.controller._loadHls = async () => class extends Base {
        loadSource(source) {
          if (this.video.closest(".review-camera-panel")?.dataset.camera !== "Drive Down") {
            super.loadSource(source);
            return;
          }
          for (const handler of this.handlers.get(Base.Events.ERROR) ?? []) {
            handler(Base.Events.ERROR, { fatal: true, type: "networkError",
              details: "manifestLoadError", response: { code: 503,
                body: "token=private" } });
          }
        }
      };
    } },
    { reason: "seekable_or_media_readiness_failure", options: {
      mediaReadyTimeoutMs: 100,
      scheduleInitialDeadline: (callback, delay) => {
        const timer = setTimeout(callback, delay * 5);
        return () => clearTimeout(timer);
      }
    }, setup: async harness => {
      const Base = await harness.controller._loadHls();
      harness.controller._loadHls = async () => class extends Base {
        attachMedia(video) {
          super.attachMedia(video);
          if (video.closest(".review-camera-panel")?.dataset.camera === "Drive Down") {
            Object.defineProperty(video, "seekable", { configurable: true,
              value: { length: 0 } });
          }
        }
      };
    } },
    { reason: "mapped_seek_failure", setup: harness => {
      const original = harness.controller.seekHistoricalPlayer;
      harness.controller.seekHistoricalPlayer = async function(player, ...args) {
        if (player.camera.name === "Drive Down") {
          player.reviewStage = "seek";
          throw new Error("private seek failure");
        }
        return original.call(this, player, ...args);
      };
    } },
    { reason: "initial_landing_deadline", options: {
      deferredFrame: new Set(["Drive Down"]), mediaReadyTimeoutMs: 100
    }, setup: () => {} }
  ];
  for (const item of cases) {
    const harness = createHistoricalHarness(item.options);
    t.after(() => harness.close());
    harness.controller.setDebug(false);
    await item.setup(harness);
    await harness.controller.playHistorical(target, { autoplay: false });
    const record = harness.controller.getRecentReviewFailures()
      .find(entry => entry.camera === "Drive Down" && entry.reason === item.reason);
    assert.ok(record, item.reason);
    assert.equal(record.outcome, "failure");
    assert.equal(record.coverage, "covered");
    assert.equal(JSON.stringify(record).includes("private"), false);
    if (item.reason === "manifest_failure") {
      assert.deepEqual(record.hls, { type: "networkError", detail: "manifestLoadError",
        fatal: true, httpStatus: 503 });
    }
    if (item.reason === "initial_landing_deadline") {
      assert.equal(record.landing, "pending");
    }
  }
});


test("Review failure ledger retains initial deadline stages without sync reports", async t => {
  const never = new Promise(() => {});
  const cases = [
    { reason: "initial_availability_deadline", options: {
      mediaReadyTimeoutMs: 100,
      availabilityResponder: message => message.camera === "drive_down" ? never :
        Promise.resolve({ camera: message.camera, requested_start: message.start,
          requested_end: message.end, coverage: [{ start: message.start, end: message.end }] })
    } },
    { reason: "initial_preparation_deadline", options: {
      mediaReadyTimeoutMs: 100,
      presentationResponder: message => message.camera === "drive_down" ? never :
        Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target))
    } },
    { reason: "post_seek_playability_failure", options: {
      mediaReadyTimeoutMs: 100,
      noRvfc: new Set(["Drive Down"]), deferredPlayable: new Set(["Drive Down"])
    } }
  ];
  for (const item of cases) {
    const harness = createHistoricalHarness(item.options);
    t.after(() => harness.close());
    harness.controller.setDebug(false);
    await harness.controller.playHistorical(1800000000, { autoplay: false });
    assert.equal(harness.controller.getLatestHistoricalSyncReport(), null);
    const record = harness.controller.getRecentReviewFailures()
      .find(entry => entry.camera === "Drive Down" && entry.reason === item.reason);
    assert.ok(record, item.reason);
    assert.equal(record.outcome, "failure");
  }
});


for (const item of INITIAL_ACQUISITION_FAILURES) {
  for (const autoplay of [false, true]) {
    test(`acquisition classification: ${item.name} is history-independent (autoplay=${autoplay})`, async () => {
      const signatures = [];
      for (const mode of ACQUISITION_HISTORY_MODES) {
        signatures.push({ mode, ...await runInitialAcquisitionFailure(item, mode, autoplay) });
      }
      const [first] = signatures;
      assert.deepEqual(first.classification, { state: item.state, boundaryReason: item.expected });
      assert.deepEqual(first.attempts, ["initial_selection"]);
      assert.deepEqual(first.progress, acquisitionProgress(...item.progress));
      assert.equal(first.cleaned, true);
      assert.equal(first.released, true);
      assert.equal(first.commands.filter(command => command.startsWith("prepare:")).length, 1);
      assert.equal(first.commands.filter(command => command.startsWith("sign:")).length,
        ["manifest", "seekable"].includes(item.fail) ? 1 : 0);
      assert.equal(first.downPlays, 0);
      assert.equal(first.peer, "participating");
      assert.equal(first.clock, 1800000000);
      assert.equal(first.running, autoplay);
      assert.equal(first.playbackRequested, autoplay);
      for (const signature of signatures.slice(1)) {
        const { mode, ...rest } = signature;
        const { mode: _first, ...expected } = first;
        assert.deepEqual(rest, expected, `diagnostic history ${mode} changed acquisition`);
      }
    });
  }
}


for (const scenario of INITIAL_DEADLINE_SCENARIOS) {
  for (const autoplay of [false, true]) {
    test(`acquisition classification: initial deadline during ${scenario.name} is history-independent (autoplay=${autoplay})`, async () => {
      const signatures = [];
      for (const mode of ACQUISITION_HISTORY_MODES) {
        signatures.push({ mode, ...await runInitialDeadline(scenario, mode, autoplay) });
      }
      const [first] = signatures;
      assert.deepEqual(first.classification, { state: "failed", boundaryReason: scenario.expected });
      assert.equal(first.lateOutcomeUnchanged, true);
      assert.deepEqual(first.attempts, ["initial_selection"]);
      assert.equal(first.attemptOwned, true);
      assert.deepEqual(first.progress, acquisitionProgress(...scenario.progress));
      assert.equal(first.cleaned, true);
      assert.equal(first.timedOut, true);
      assert.equal(first.released, true);
      assert.equal(first.downPlays, 0);
      assert.equal(first.peer, "participating");
      assert.equal(first.clock, 1800000000);
      assert.equal(first.running, autoplay);
      assert.equal(first.playbackRequested, autoplay);
      for (const signature of signatures.slice(1)) {
        const { mode, ...rest } = signature;
        const { mode: _first, ...expected } = first;
        assert.deepEqual(rest, expected, `diagnostic history ${mode} changed acquisition`);
      }
    });
  }
}


test("acquisition classification: a later acquisition classifies only its own milestones", async () => {
  const target = 1800000000;
  const signatures = [];
  for (const mode of ACQUISITION_HISTORY_MODES) {
    const harness = createHistoricalHarness({ now: () => 1000, noRvfc: new Set(["Drive Down"]) });
    try {
      const controller = harness.controller;
      useAcquisitionHistory(controller, mode);
      const transitionsFor = recordCameraTransitions(controller);
      const classifications = recordCameraClassifications(controller, "Drive Down");
      await controller.playHistorical(target, { autoplay: false });
      const down = controller._historicalPlayers.get("Drive Down");
      const [initial] = transitionsFor("Drive Down");
      assert.equal(down.lifecycleState, "participating");
      assert.deepEqual({ ...initial.acquisitionProgress },
        acquisitionProgress(...ACQUISITION_PROGRESS_FLAGS));
      const sign = controller.signManifest.bind(controller);
      controller.signManifest = async (player, range) => {
        if (player !== down) return sign(player, range);
        alterAcquisitionHistory(player, mode);
        throw new Error("synthetic sign failure");
      };
      controller.leaveHistoricalCamera(down, "authoritative_recording_gap", target, target);
      const commandsBefore = acquisitionCommands(harness, "drive_down").length;
      await controller.evaluateHistoricalAvailability(null, { reason: "acquisition_probe" });
      const attempts = transitionsFor("Drive Down");
      const later = attempts.at(-1);
      signatures.push({
        mode,
        classification: classifications.at(-1),
        attempts: attempts.map(attempt => attempt.reason),
        distinct: later !== initial && later.acquisitionProgress !== initial.acquisitionProgress,
        initial: { ...initial.acquisitionProgress },
        later: { ...later.acquisitionProgress },
        newCommands: acquisitionCommands(harness, "drive_down").slice(commandsBefore),
        released: down.hls === null && down.transition === null,
        clock: controller.clock.absoluteTime,
        playbackRequested: controller.playbackRequested
      });
    } finally {
      harness.close();
    }
  }
  const [first] = signatures;
  assert.deepEqual(first.classification, { state: "failed", boundaryReason: "manifest_sign_failure" });
  assert.deepEqual(first.attempts, ["initial_selection", "availability_entry"]);
  assert.equal(first.distinct, true);
  assert.deepEqual(first.initial, acquisitionProgress(...ACQUISITION_PROGRESS_FLAGS));
  assert.deepEqual(first.later, acquisitionProgress("prepareMapped"));
  assert.deepEqual(first.newCommands.map(command => command.split(":")[0]), ["prepare"]);
  assert.equal(first.released, true);
  assert.equal(first.clock, target);
  assert.equal(first.playbackRequested, false);
  for (const { mode, ...rest } of signatures.slice(1)) {
    const { mode: _first, ...expected } = first;
    assert.deepEqual(rest, expected, `diagnostic history ${mode} changed acquisition`);
  }
});


for (const debug of [false, true]) {
  test(`acquisition classification: each seek resets only its own seek milestones (debug=${debug})`, async t => {
    const deferredSeek = new Set();
    const harness = createHistoricalHarness({ now: () => 1000, deferredSeek });
    t.after(() => harness.close());
    const controller = harness.controller;
    controller.setDebug(debug);
    await controller.playHistorical(1800000000, { autoplay: false });
    const up = controller._historicalPlayers.get("Drive Up");
    const writes = up.video.currentTimeWrites.length;
    const transition = controller.beginCameraTransition(up, "explicit_seek",
      controller.clock.absoluteTime, { preservePlacement: true });
    transition.hls = up.hls;
    const progress = transition.acquisitionProgress;
    assert.deepEqual({ ...progress }, acquisitionProgress());
    Object.assign(progress, acquisitionProgress(...ACQUISITION_PROGRESS_FLAGS));
    // A different media position, so the pre-seek state cannot already satisfy tolerance.
    up.seek += 1;
    deferredSeek.add("Drive Up");
    const seek = controller.seekHistoricalPlayer(up, up.generation, null, transition);
    assert.deepEqual({ ...progress },
      acquisitionProgress("prepareMapped", "manifestSigned", "manifestParsed"));
    await waitForCondition(() => up.video.currentTimeWrites.length === writes + 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(progress.seekToleranceReached, false);
    harness.mediaControls.find(entry => entry.camera === "Drive Up").completeSeek();
    await seek;
    assert.deepEqual({ ...progress }, acquisitionProgress(...ACQUISITION_PROGRESS_FLAGS));
    assert.deepEqual(up.video.currentTimeWrites.slice(writes), [up.seek]);
    assert.equal(controller.clock.absoluteTime, 1800000000);
    assert.equal(controller.playbackRequested, false);
  });
}


for (const debug of [false, true]) {
  for (const autoplay of [false, true]) {
    test(`manifest diagnostic isolation: acquisition matches control (debug=${debug}, autoplay=${autoplay})`, async () => {
      const control = await runManifestIsolationSuccess(debug, autoplay, false);
      const throwing = await runManifestIsolationSuccess(debug, autoplay, true);
      assert.deepEqual(throwing, control);
      assert.deepEqual(control.commands,
        ["attach", "source", "manifest", "seek", ...(autoplay ? ["play"] : [])]);
    });
  }

  test(`manifest diagnostic isolation: fatal manifest still fails and cleans up (debug=${debug})`, async () => {
    const harness = await createManifestIsolationHarness(debug, true);
    const controller = harness.controller;
    let operation;
    try {
      operation = controller.playHistorical(1800000000, { autoplay: false });
      await flushManifestMicrotasksUntil(() => harness.manifests.length === 1);
      const player = controller._historicalPlayers.get("Drive Up");
      const transition = player.transition;
      harness.manifests[0].emitFatal();
      await operation;
      assert.equal(player.lifecycleState, "failed");
      assert.equal(player.boundaryReason, "manifest_failure");
      assert.deepEqual({ ...transition.acquisitionProgress },
        acquisitionProgress("prepareMapped", "manifestSigned"));
      assert.deepEqual(player.video.currentTimeWrites, []);
      assert.deepEqual(harness.playCalls, []);
      assert.deepEqual(harness.manifestObservations, []);
      assert.deepEqual(harness.internalExceptions, []);
      assert.equal(controller.getRecentReviewFailures()[0].reason, "manifest_failure");
      controller.returnToLive();
      assertManifestIsolationCleanup(harness, player);
    } finally {
      harness.close();
      await operation;
    }
  });

  test(`manifest diagnostic isolation: stale callback cannot settle a newer manifest (debug=${debug})`, async () => {
    const harness = await createManifestIsolationHarness(debug, true);
    const controller = harness.controller;
    const target = 1800000000;
    let initial, replacement;
    try {
      initial = controller.playHistorical(target, { autoplay: false });
      await flushManifestMicrotasksUntil(() => harness.manifests.length === 1);
      const player = controller._historicalPlayers.get("Drive Up");
      const stale = player.transition;
      replacement = controller.seekHistoricalToEpoch(target + 5, { autoplay: false });
      await flushManifestMicrotasksUntil(() => harness.manifests.length === 2);
      const current = player.transition;
      assert.notEqual(current, stale);
      assert.equal(stale.cleaned, true);
      harness.manifests[0].emitParsed();
      // The stale attempt is already settled, so an escaped throw would only be logged.
      assert.deepEqual(harness.internalExceptions, []);
      assert.deepEqual(stale.cancellations, []);
      assert.deepEqual({ ...stale.acquisitionProgress },
        acquisitionProgress("prepareMapped", "manifestSigned"));
      assert.deepEqual({ ...current.acquisitionProgress },
        acquisitionProgress("prepareMapped", "manifestSigned"));
      assert.equal(player.transition, current);
      assert.equal(controller.isCurrentCameraTransition(player, current), true);
      assert.equal(current.cancellations.length, 1);
      assert.deepEqual(player.video.currentTimeWrites, []);
      assert.equal(harness.manifests[1].hls.handlers.get(harness.events.MANIFEST_PARSED).length, 1);
      harness.manifests[1].emitParsed();
      await flushManifestMicrotasksUntil(() => player.video.currentTimeWrites.length === 1);
      harness.mediaControls.at(-1).emitFrame();
      assert.equal(await replacement, true);
      await initial;
      assert.equal(player.lifecycleState, "participating");
      assert.equal(player.initialPlacement.landedEpoch, target + 5);
      assert.equal(controller.clock.absoluteTime, target + 5);
      assert.equal(controller.playbackRequested, false);
      assert.deepEqual(harness.internalExceptions, []);
      controller.returnToLive();
      assertManifestIsolationCleanup(harness, player);
    } finally {
      harness.close();
      await Promise.allSettled([initial, replacement]);
    }
  });
}


for (const debug of [false, true]) {
  for (const autoplay of [false, true]) {
    test(`manifest diagnostic isolation: deadline-free rejoin matches control (debug=${debug}, autoplay=${autoplay})`, async () => {
      const control = await runManifestIsolationRejoin(debug, autoplay, false);
      const throwing = await runManifestIsolationRejoin(debug, autoplay, true);
      assert.deepEqual(throwing, control);
      assert.deepEqual(control.attempts, ["initial_selection",
        ...(autoplay ? ["play_release"] : []), "availability_entry"]);
      assert.deepEqual(control.commands, ["attach", "source", "manifest", "seek",
        ...(autoplay ? ["play"] : []), "attach", "source", "manifest", "seek",
        ...(autoplay ? ["play"] : [])]);
      assert.deepEqual(control.seeks, [21]);
    });
  }
}


test("acquisition classification: a superseded manifest callback cannot write its stale attempt", async t => {
  const target = 1800000000;
  const harness = createHistoricalHarness({ now: () => 1000 });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller.setDebug(false);
  const transitionsFor = recordCameraTransitions(controller);
  const Base = await controller._loadHls();
  let held = null;
  controller._loadHls = async () => class extends Base {
    loadSource(source) {
      if (!held && this.video.closest(".review-camera-panel")?.dataset.camera === "Drive Down") {
        held = this;
        this.source = source;
        return;
      }
      super.loadSource(source);
    }
  };
  const initial = controller.playHistorical(target, { autoplay: false });
  await waitForCondition(() => held !== null);
  const down = controller._historicalPlayers.get("Drive Down");
  const stale = down.transition;
  const staleHandlers = [...held.handlers.get(Base.Events.MANIFEST_PARSED)];
  assert.deepEqual({ ...stale.acquisitionProgress },
    acquisitionProgress("prepareMapped", "manifestSigned"));
  const seek = controller.seekHistoricalToEpoch(target + 5, { autoplay: false });
  assert.equal(stale.cleaned, true);
  assert.ok(held.destroyCount >= 1);
  for (const handler of staleHandlers) handler(Base.Events.MANIFEST_PARSED, {});
  assert.deepEqual({ ...stale.acquisitionProgress },
    acquisitionProgress("prepareMapped", "manifestSigned"));
  assert.equal(await seek, true);
  await initial;
  const attempts = transitionsFor("Drive Down");
  assert.equal(attempts[0], stale);
  assert.equal(down.lifecycleState, "participating");
  assert.equal(attempts.at(-1).reason, "explicit_seek_new_presentation");
  assert.deepEqual({ ...stale.acquisitionProgress },
    acquisitionProgress("prepareMapped", "manifestSigned"));
  assert.equal(controller.clock.absoluteTime, target + 5);
  assert.equal(controller.playbackRequested, false);
});


test("acquisition classification: a superseded readiness wait cannot write its stale attempt", async t => {
  const target = 1800000000;
  const deferredPlayable = new Set(["Drive Down"]);
  const harness = createHistoricalHarness({ now: () => 1000,
    noRvfc: new Set(["Drive Down"]), deferredPlayable });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller.setDebug(false);
  const transitionsFor = recordCameraTransitions(controller);
  const initial = controller.playHistorical(target, { autoplay: false });
  const down = () => controller._historicalPlayers.get("Drive Down");
  await waitForCondition(() => down()?.reviewStage === "seekable" &&
    down().transition?.acquisitionProgress.seekToleranceReached);
  const stale = down().transition;
  const staleControl = harness.mediaControls.find(entry => entry.camera === "Drive Down");
  deferredPlayable.delete("Drive Down");
  const seek = controller.seekHistoricalToEpoch(target + 5, { autoplay: false });
  assert.equal(stale.cleaned, true);
  staleControl.makePlayable();
  assert.equal(await seek, true);
  await initial;
  assert.deepEqual({ ...stale.acquisitionProgress }, acquisitionProgress(
    "prepareMapped", "manifestSigned", "manifestParsed", "seekToleranceReached"));
  const later = transitionsFor("Drive Down").at(-1);
  assert.notEqual(later, stale);
  assert.deepEqual({ ...later.acquisitionProgress },
    acquisitionProgress(...ACQUISITION_PROGRESS_FLAGS));
  assert.equal(down().lifecycleState, "participating");
  assert.equal(controller.clock.absoluteTime, target + 5);
  assert.equal(controller.playbackRequested, false);
});


test("acquisition classification: request ownership guards readiness even without cleanup", async t => {
  // Production supersession always cancels first; this isolates the ownership guard itself.
  const target = 1800000000;
  const harness = createHistoricalHarness({ now: () => 1000,
    noRvfc: new Set(["Drive Down"]), deferredPlayable: new Set(["Drive Down"]) });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller.setDebug(false);
  const initial = controller.playHistorical(target, { autoplay: false });
  const down = controller._historicalPlayers.get("Drive Down");
  await waitForCondition(() => down.reviewStage === "seekable" &&
    down.transition?.acquisitionProgress.seekToleranceReached);
  const stale = down.transition;
  controller._reviewRequestId += 1;
  assert.equal(stale.cleaned, undefined);
  harness.mediaControls.find(entry => entry.camera === "Drive Down").makePlayable();
  await initial;
  assert.deepEqual({ ...stale.acquisitionProgress }, acquisitionProgress(
    "prepareMapped", "manifestSigned", "manifestParsed", "seekToleranceReached"));
  assert.equal(harness.playCalls.some(call => call.camera === "Drive Down"), false);
});


test("Review failure ledger bounds, deduplicates, detaches, and allowlists records", () => {
  const controller = new ReviewController({ wallClock: () => 1000 });
  const player = { camera: { name: "Drive Up", entity: "camera.secret", password: "private" },
    requestId: 1, lifecycleRevision: 0, lifecycleState: "preparing",
    reviewStage: "prepare", reviewLanding: "not_started", reviewPlay: "not_attempted",
    reviewHlsError: { type: "https://secret", detail: "token=private", fatal: true,
      httpStatus: 999 }, video: { readyState: 100, seekable: { length: 0 },
      error: { code: 77, message: "secret" } } };
  controller.recordReviewFailure(player, { reason: "camera_prepare_failed", targetEpoch: 1800000000 });
  controller.recordReviewFailure(player, { reason: "camera_prepare_failed", targetEpoch: 1800000000 });
  assert.equal(controller.getRecentReviewFailures().length, 1);
  player.lifecycleRevision = 1;
  controller.recordReviewFailure(player, { reason: "camera_prepare_failed", targetEpoch: 1800000001 });
  assert.equal(controller.getRecentReviewFailures().length, 2);
  for (let requestId = 2; requestId <= 18; requestId++) {
    player.requestId = requestId;
    controller.recordReviewFailure(player, { reason: "camera_prepare_failed",
      targetEpoch: 1800000000 + requestId });
  }
  assert.equal(controller._reviewFailures.length, 16);
  assert.equal(controller.getRecentReviewFailures()[0].requestId, 18);
  for (let requestId = 20; requestId <= 29; requestId++) {
    player.requestId = requestId;
    controller.recordReviewFailure(player, { reason: "authoritative_recording_gap",
      outcome: "no_coverage", stage: "availability", targetEpoch: 1800000000 + requestId });
  }
  assert.equal(controller._reviewOutcomes.length, 8);
  assert.equal(controller._reviewFailures.length, 16);
  const records = controller.getRecentReviewFailures();
  assert.equal(records.length, 24);
  assert.equal(records[0].requestId, 29);
  assert.deepEqual(records.at(-1).hls, { type: null, detail: null, fatal: true,
    httpStatus: null });
  assert.equal(records.at(-1).video.errorCode, null);
  assert.equal(records.at(-1).video.readyState, null);
  assert.equal(JSON.stringify(records).includes("secret"), false);
  records[0].video.readyState = 4;
  assert.equal(controller.getRecentReviewFailures()[0].video.readyState, null);
});


// R-13 Phase 2 deliberately replaces "fatal errors are observational": a confirmed fatal
// error ends that presentation once and enters bounded recovery; a code-less media error
// event stays observational.
test("Review fatal Hls errors end the presentation once and enter bounded recovery", async t => {
  const harness = createHistoricalHarness({ now: () => 1000 });
  t.after(() => harness.close());
  harness.controller.setDebug(false);
  await harness.controller.playHistorical(1800000000);
  const player = harness.controller._historicalPlayers.get("Drive Up");
  const peer = harness.controller._historicalPlayers.get("Drive Down");
  const peerHls = peer.hls;
  const hls = player.hls;
  const video = player.video;
  const calls = harness.calls.length;
  const plays = harness.playCalls.length;
  for (let index = 0; index < 2; index++) {
    for (const handler of hls.handlers.get(hls.constructor.Events.ERROR) ?? []) {
      handler("error", { fatal: true, type: "networkError", details: "fragLoadError",
        response: { code: 404, body: "token=private" } });
    }
    video.dispatchEvent(new harness.window.Event("error"));
  }
  // Hls is never destroyed inside its own error dispatch.
  assert.equal(hls.destroyCount, 0);
  assert.equal(player.lifecycleState, "participating");
  await Promise.resolve();
  const records = harness.controller.getRecentReviewFailures();
  assert.equal(records.filter(record => record.reason === "hls_fatal").length, 1);
  assert.equal(records.filter(record => record.reason === "media_error").length, 1);
  assert.equal(JSON.stringify(records).includes("private"), false);
  assert.equal(player.lifecycleState, "failed");
  assert.equal(hls.destroyCount, 1);
  assert.equal(player.hls, null);
  assert.equal(player.continuationRecovery.attempts, 1, "duplicate fatal events consume one attempt");
  assert.notEqual(player.boundaryReason, "authoritative_recording_gap");
  assert.equal(harness.calls.length, calls, "no uncontrolled immediate rebuild");
  assert.equal(harness.playCalls.length, plays);
  assert.equal(peer.lifecycleState, "participating");
  assert.ok(peer.hls === peerHls, "the healthy peer keeps its presentation");
});


test("Review failure ledger captures resume rejection and retained availability failure", async t => {
  let rejectPlay = false;
  let rejectAvailability = false;
  const harness = createHistoricalHarness({
    playResponder: camera => rejectPlay && camera === "Drive Down"
      ? Promise.reject(new Error("private resume rejection")) : Promise.resolve(),
    availabilityResponder: message => rejectAvailability && message.camera === "drive_up"
      ? Promise.reject(new Error("private availability failure"))
      : Promise.resolve({ camera: message.camera, requested_start: message.start,
        requested_end: message.end, coverage: [{ start: message.start, end: message.end }] })
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000, { autoplay: false });
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const upHls = up.hls;
  rejectAvailability = true;
  // A window the shared cache does not hold yet needs a real (failing) request.
  assert.equal(await harness.controller.reconcileHistoricalCamera(up, 1800000000 + 7205),
    "retained_after_availability_failure");
  const retained = harness.controller.getRecentReviewFailures()
    .find(record => record.camera === "Drive Up" &&
      record.outcome === "retained_after_failure");
  assert.equal(retained.reason, "availability_api_failure");
  assert.equal(up.lifecycleState, "participating");
  assert.strictEqual(up.hls, upHls);
  rejectPlay = true;
  harness.controller.resumePlayback();
  await waitForCondition(() => down.lifecycleState === "failed");
  const play = harness.controller.getRecentReviewFailures()
    .find(record => record.camera === "Drive Down" && record.reason === "play_rejected");
  assert.equal(play.play, "rejected");
  assert.equal(play.stage, "play");
  assert.equal(up.lifecycleState, "participating");
});


test("Review failure ledger retains finite exhaustion separately from failed continuation", async t => {
  let laterFails = false;
  const harness = createHistoricalHarness({ presentationResponder: message => {
    if (laterFails && message.camera === "drive_down") {
      return Promise.reject(new Error("private continuation failure"));
    }
    return Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target));
  }});
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000, { autoplay: false });
  const down = harness.controller._historicalPlayers.get("Drive Down");
  laterFails = true;
  assert.equal(harness.controller.continueHistoricalPresentation(down, 1800000010,
    1800000009.9), true);
  await waitForCondition(() => down.lifecycleState === "failed" &&
    harness.controller.getRecentReviewFailures().some(record =>
      record.camera === "Drive Down" && record.reason === "camera_prepare_failed"));
  const records = harness.controller.getRecentReviewFailures()
    .filter(record => record.camera === "Drive Down");
  assert.equal(records.find(record => record.reason === "continuous_presentation_exhausted")
    .outcome, "normal_terminal");
  assert.equal(records.find(record => record.reason === "camera_prepare_failed").outcome,
    "failure");
});


test("experiment: covered finite presentation continues when successor preparation succeeds", async t => {
  const run = await createContinuationFailureExperiment(t);
  const { controller, player, trace } = run;
  assert.deepEqual(trace.map(entry => entry.phase), [
    "initial_paused", "playing_initial", "exhausted_preparing_successor", "successor_playing"
  ]);
  assert.equal(trace[2].heldFrameVisible, true);
  assert.equal(trace[2].badge, "");
  assert.equal(trace[3].cameraState, "participating");
  assert.equal(trace[3].participatingCount, 1);
  assert.equal(trace[3].heldFrameVisible, false);
  assert.equal(trace[3].clockRunning, true);
  assert.equal(player.video.paused, false);
  assert.equal(controller.getRecentReviewFailures().some(record =>
    record.reason === "camera_prepare_failed"), false);
  run.diagnostic();
});


for (const rate of [1, 8]) {
  test(`covered successor automatically recovers after one transient failure at ${rate}x`, async t => {
    const run = await createContinuationFailureExperiment(t, { rate, failure: "once" });
    const { controller, player, attempts, trace } = run;
    assert.equal(trace[3].cameraState, "failed");
    assert.equal(trace[3].participatingCount, 0);
    assert.equal(trace[3].heldFrameVisible, true);
    assert.equal(trace[3].badge, "Unavailable");
    assert.equal(trace[3].clockRunning, true);
    assert.equal(trace[3].playRequested, false);
    assert.equal(trace[3].recoveryAttempts, 1);
    const failureRecord = controller.getRecentReviewFailures().find(record =>
      record.reason === "camera_prepare_failed");
    assert.equal(failureRecord?.stage, "prepare");
    assert.equal(failureRecord?.coverage, "covered");
    assert.equal(failureRecord?.hasTimingMap, false);
    assert.equal(failureRecord?.play, "not_attempted");
    run.advanceWallClock(999);
    await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
    assert.equal(attempts.get("drive_up"), 2);
    assert.equal(controller.clock.absoluteTime, run.base + 20 + 0.999 * rate);
    run.advanceWallClock(1);
    await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
    await waitForCondition(() => player.lifecycleState === "participating" &&
      controller.clock.running && player.video.paused === false);
    run.snapshot("automatic_recovery");
    assert.equal(attempts.get("drive_up"), 3);
    // Reacquisition is probation: the attempt is kept until sustained progress (R-13 Phase 2).
    assert.equal(trace.at(-1).recoveryAttempts, 1);
    run.harness.mediaControls.filter(control => control.camera === "Drive Up")
      .at(-1).emitFrame();
    run.snapshot("first_successor_frame");
    assert.equal(trace.at(-1).heldFrameVisible, false);
    run.diagnostic();
  });
}
