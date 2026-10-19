// Review recovery basics, clock ownership, readiness and Skip Deadspace.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ReviewController,
  planRecordingGapSkip,
  confirmedRecordingGaps,
  recordingGapIntersections,
  RecordingCoverageCache
} from "../src/review/review-controller.js";
import {
  createTestHarness
} from "./helpers/nvr-card-harness.js";
import {
  cameras,
  presentationPrepared,
  setReviewTi,
  createHistoricalHarness,
  recordingCoverageResponder,
  enterEventAutoSnap,
  waitForHistoricalMedia,
  configureGarage,
  waitForCalls,
  waitForCondition,
  prepareTargets,
  manualInitialDeadlines,
  createContinuationFailureExperiment,
  GAP_BASE,
  createGapHarness,
  settleCoverage,
  timelineGaps,
  gapRanges,
  coverageCalls,
  assertGapGeometry,
  UNRECORDED_TARGET,
  unrecordedGapCoverage,
  FAR_GAP,
  createUnrecordedSeekHarness,
  createReadinessHarness,
  SKIP_BASE,
  captureRecordingSkipEvaluation,
  createRecordingSkipHarness,
  driveRecordingSkip
} from "./review-controller-test-support.js";

test("persistent covered successor recovery exhausts after three attempts while the clock advances", async t => {
  const run = await createContinuationFailureExperiment(t, { failure: "always" });
  const { controller, player, attempts, trace } = run;
  assert.equal(controller.clock.running, true);
  assert.equal(controller._playRequested, false);
  run.advanceWallClock(1000);
  await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
  await waitForCondition(() => player.lifecycleState === "failed" &&
    player.continuationRecovery?.attempts === 2);
  run.snapshot("second_failure");
  run.advanceWallClock(2000);
  await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
  await waitForCondition(() => player.lifecycleState === "failed" &&
    player.continuationRecovery?.exhausted);
  run.snapshot("recovery_exhausted");
  assert.equal(attempts.get("drive_up"), 4);
  assert.equal(player.lifecycleState, "failed");
  assert.equal(trace.at(-1).participatingCount, 0);
  assert.equal(trace.at(-1).clockRunning, true);
  assert.equal(trace.at(-1).playRequested, false);
  assert.equal(trace.at(-1).recoveryAttempts, 3);
  assert.equal(controller.resumePlayback(), false);
  run.advanceWallClock(10000);
  await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
  assert.equal(attempts.get("drive_up"), 4);
  assert.equal(controller.clock.absoluteTime, run.base + 33);
  assert.equal(trace.at(-1).heldFrameVisible, true);
  run.diagnostic();
});


test("experiment: one failed successor leaves a selected peer participating", async t => {
  const run = await createContinuationFailureExperiment(t, {
    failure: "always", cameras: ["Drive Up", "Drive Down"]
  });
  const { controller, player, attempts, trace } = run;
  const peer = controller._historicalPlayers.get("Drive Down");
  assert.equal(player.lifecycleState, "failed");
  assert.equal(peer.lifecycleState, "participating");
  assert.equal(peer.video.paused, false);
  assert.equal(controller.clock.running, true);
  assert.equal(trace.at(-1).participatingCount, 1);
  assert.equal(attempts.get("drive_up"), 2);
  assert.equal(attempts.get("drive_down"), 1);
  run.advanceWallClock(1000);
  await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
  await waitForCondition(() => player.continuationRecovery?.attempts === 2);
  assert.equal(peer.lifecycleState, "participating");
  assert.equal(controller.clock.running, true);
  assert.equal(attempts.get("drive_down"), 1);
  run.diagnostic();
});


test("a selected peer keeps playing while its failed camera recovers", async t => {
  const run = await createContinuationFailureExperiment(t, {
    failure: "once", cameras: ["Drive Up", "Drive Down"]
  });
  const { controller, player, attempts } = run;
  const peer = controller._historicalPlayers.get("Drive Down");
  assert.equal(controller.clock.running, true);
  assert.equal(controller._playRequested, false);
  run.advanceWallClock(1000);
  await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
  await waitForCondition(() => player.lifecycleState === "participating" &&
    player.video.paused === false);
  assert.equal(peer.lifecycleState, "participating");
  assert.equal(peer.video.paused, false);
  assert.equal(controller.clock.running, true);
  assert.equal(attempts.get("drive_up"), 3);
  assert.equal(attempts.get("drive_down"), 1);
  run.diagnostic();
});


test("Pause cancels pending continuation recovery", async t => {
  const run = await createContinuationFailureExperiment(t, { failure: "once" });
  const { controller, player, attempts } = run;
  assert.equal(controller.pausePlayback(), true);
  run.advanceWallClock(5000);
  await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
  assert.equal(attempts.get("drive_up"), 2);
  assert.equal(player.lifecycleState, "failed");
  assert.equal(controller.clock.running, false);
  assert.equal(controller._playRequested, false);
  run.diagnostic();
});


test("Pause during in-flight recovery cannot restart playback", async t => {
  const run = await createContinuationFailureExperiment(t, {
    failure: "once", deferRecovery: true
  });
  const { controller, player, attempts } = run;
  run.advanceWallClock(1000);
  await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
  await waitForCondition(() => attempts.get("drive_up") === 3 &&
    player.lifecycleState === "preparing");
  assert.equal(controller.pausePlayback(), true);
  assert.equal(player.transition, null);
  assert.equal(player.lifecycleState, "failed");
  assert.equal(player.continuationRecovery.attempts, 1);
  run.releaseRecovery();
  await waitForCondition(() => player.lifecycleState === "failed");
  assert.equal(controller.clock.running, false);
  assert.equal(controller._playRequested, false);
  run.advanceWallClock(5000);
  await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
  assert.equal(attempts.get("drive_up"), 3);
  run.diagnostic();
});


test("Play after cancelling recovery owns the replacement before the stale request settles", async t => {
  const run = await createContinuationFailureExperiment(t, {
    failure: "once", deferRecovery: true
  });
  const { controller, player, attempts } = run;
  run.advanceWallClock(1000);
  await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
  await waitForCondition(() => attempts.get("drive_up") === 3 &&
    player.lifecycleState === "preparing");
  assert.equal(controller.pausePlayback(), true);
  assert.equal(player.transition, null);
  assert.equal(controller.resumePlayback(), true);
  await waitForCondition(() => attempts.get("drive_up") === 4 &&
    player.lifecycleState === "participating" && controller.clock.running &&
    player.video.paused === false);
  const ownedHls = player.hls;
  const ownedPresentation = player.presentationId;
  run.releaseRecovery();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player.hls, ownedHls);
  assert.equal(player.presentationId, ownedPresentation);
  assert.equal(player.lifecycleState, "participating");
  assert.equal(player.video.paused, false);
  assert.equal(controller.clock.running, true);
  // The cancelled attempt was not counted; the original failure stays on probation.
  assert.equal(player.continuationRecovery.attempts, 1);
});


test("Auto Snap keeps advancing its event interval through covered successor recovery", async t => {
  const run = await createContinuationFailureExperiment(t, {
    failure: "once", autoSnap: true
  });
  const { controller, player } = run;
  assert.equal(controller._autoSnapArmed, true);
  assert.equal(controller.clock.running, true);
  run.advanceWallClock(1000);
  await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
  await waitForCondition(() => player.lifecycleState === "participating" &&
    controller.clock.running && player.video.paused === false);
  assert.equal(controller._autoSnapArmed, true);
  assert.equal(controller._autoSnapActiveEnd, run.when.to);
  run.diagnostic();
});


test("authoritative recording gap keeps ordinary clock advancement", async t => {
  const base = 1800000000;
  const run = await createContinuationFailureExperiment(t, {
    coverageIntervals: [{ start: base - 30, end: base + 20 },
      { start: base + 40, end: base + 100 }]
  });
  const { controller, player, attempts } = run;
  assert.equal(player.lifecycleState, "unavailable");
  assert.equal(player.boundaryReason, "authoritative_recording_gap");
  assert.equal(player.continuationRecovery, null);
  assert.equal(controller.clock.running, true);
  run.advanceWallClock(1000);
  assert.equal(controller.clock.absoluteTime, base + 21);
  assert.equal(attempts.get("drive_up"), 1);
  run.diagnostic();
});


test("manual TI supersedes a pending continuation recovery", async t => {
  const run = await createContinuationFailureExperiment(t, {
    failure: "once", deferRecovery: true
  });
  const { base, controller, player, attempts } = run;
  run.advanceWallClock(1000);
  await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
  await waitForCondition(() => attempts.get("drive_up") === 3 &&
    player.lifecycleState === "preparing");
  assert.equal(await controller.selectTimelineTime(base + 25, "manual TI", false), true);
  assert.equal(player.lifecycleState, "participating");
  assert.equal(controller.clock.running, false);
  run.releaseRecovery();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player.lifecycleState, "participating");
  assert.equal(controller._playRequested, false);
  assert.equal(attempts.get("drive_up"), 4);
  run.diagnostic();
});


test("camera deselection supersedes a pending continuation recovery", async t => {
  const run = await createContinuationFailureExperiment(t, {
    failure: "once", deferRecovery: true, cameras: ["Drive Up", "Drive Down"]
  });
  const { controller, player, attempts } = run;
  run.advanceWallClock(1000);
  await controller.queueHistoricalAvailabilityEvaluation("continuation_experiment");
  await waitForCondition(() => attempts.get("drive_up") === 3 &&
    player.lifecycleState === "preparing");
  controller.setSelectedCameraNames(["Drive Down"]);
  run.releaseRecovery();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(controller._selectedCameraNames, ["Drive Down"]);
  assert.equal(controller._historicalPlayers.has("Drive Up"), false);
  run.diagnostic();
});


test("confirmed recording gaps come only from queried windows and merge across boundaries", () => {
  const windows = [
    { start: 0, end: 100, coverage: [{ start: 0, end: 40 }, { start: 60, end: 90 }] },
    { start: 100, end: 200, coverage: [{ start: 120, end: 200 }] },
    { start: 300, end: 400, coverage: [] }
  ];
  assert.deepEqual(confirmedRecordingGaps(windows, 0, 400), [
    { start: 40, end: 60 }, { start: 90, end: 120 }, { start: 300, end: 400 }
  ]);
  assert.deepEqual(confirmedRecordingGaps(windows, 50, 350), [
    { start: 50, end: 60 }, { start: 90, end: 120 }, { start: 300, end: 350 }
  ], "gaps clip to the viewport; unqueried [200, 300) is not a gap");
  assert.deepEqual(confirmedRecordingGaps([], 0, 400), []);
});


test("recording coverage cache bounds requests, concurrency, and failure retries", async () => {
  let now = 100000;
  const requests = [];
  const cache = new RecordingCoverageCache({
    now: () => now,
    request: (camera, start, end) => new Promise((resolve, reject) =>
      requests.push({ camera, start, end, resolve, reject }))
  });
  const want = () => cache.want(["a", "b"], 72000 - 1, 72000 + 7200 * 2);
  want();
  assert.equal(requests.length, 3, "at most three requests in flight");
  assert.ok(requests.every(request => request.end - request.start <= 7200));
  assert.ok(requests.every(request => request.start % 7200 === 0), "windows are epoch-aligned");
  const failed = requests[0];
  failed.done = true;
  failed.reject(new Error("synthetic"));
  await settleCoverage();
  assert.equal(requests.length, 4, "a settled request releases a slot");
  const resolveAll = async () => {
    while (requests.some(request => !request.done)) {
      for (const request of requests.filter(candidate => !candidate.done)) {
        request.done = true;
        request.resolve({ camera: request.camera, requested_start: request.start,
          requested_end: request.end, coverage: [] });
      }
      await settleCoverage();
    }
  };
  await resolveAll();
  assert.equal(requests.length, 6, "each camera window is requested once");
  const isFailed = request => request.camera === failed.camera && request.start === failed.start;
  want();
  assert.equal(requests.length, 6, "loaded windows are reused and failures wait to retry");
  assert.deepEqual(cache.gapsFor(failed.camera, failed.start, failed.end), [],
    "a failed window produces no gap");
  assert.deepEqual(cache.gapsFor("a", 72000, 79200), [{ start: 72000, end: 79200 }]);
  const loaded = requests.length;
  now += 31;
  want();
  assert.ok(requests.slice(loaded).some(isFailed),
    "a failed window is retried after the retry delay");
});


test("Review timeline recolors only the unrecorded part of a partly recorded event", async t => {
  const event = { camera_id: "drive_up", start_time: GAP_BASE + 1000,
    end_time: GAP_BASE + 3000, type: "person" };
  const harness = createGapHarness({ debug: true,
    reviewEvents: [event],
    availabilityResponder: recordingCoverageResponder({
      drive_up: [{ start: GAP_BASE - 7200, end: GAP_BASE + 1500 },
        { start: GAP_BASE + 2000, end: GAP_BASE + 7200 }],
      drive_down: [{ start: GAP_BASE - 7200, end: GAP_BASE + 7200 }]
    })
  });
  t.after(() => harness.close());
  await harness.controller.refreshReviewQuery();
  await settleCoverage();
  const segments = timelineGaps(harness, "drive_up");
  assert.deepEqual(segments.map(gap => [gap.start, gap.end]),
    [[GAP_BASE + 1500, GAP_BASE + 2000]], "only the intersection of event and gap");
  // The viewport is the full When: top = (to - end) / span, height = 500 / span.
  assertGapGeometry(segments[0], 5200 / 14400, 500 / 14400);
  const markers = harness.root.querySelectorAll(
    '.review-timeline-lane[data-camera-id="drive_up"] .review-timeline-marker');
  assert.equal(markers.length, 1, "the original pink marker is untouched and complete");
  assert.equal(Number(markers[0].dataset.startEpoch), event.start_time);
  assert.equal(Number(markers[0].dataset.endEpoch), event.end_time);
  assert.deepEqual(gapRanges(harness, "drive_down"), []);
});


test("Review timeline leaves a fully recorded event in its original colour", async t => {
  const event = { camera_id: "drive_up", start_time: GAP_BASE + 1000,
    end_time: GAP_BASE + 3000, type: "person" };
  const harness = createGapHarness({
    reviewEvents: [event],
    availabilityResponder: recordingCoverageResponder({
      drive_up: [{ start: GAP_BASE - 7200, end: GAP_BASE + 900 },
        { start: GAP_BASE + 900, end: GAP_BASE + 3100 },
        { start: GAP_BASE + 3100, end: GAP_BASE + 7200 }],
      drive_down: []
    })
  });
  t.after(() => harness.close());
  await harness.controller.refreshReviewQuery();
  await settleCoverage();
  assert.deepEqual(gapRanges(harness, "drive_up"), []);
  assert.equal(harness.root.querySelectorAll(".review-timeline-marker").length, 1);
});


test("Review timeline recolors an entirely unrecorded event and never empty regions", async t => {
  const event = { camera_id: "drive_up", start_time: GAP_BASE + 1000,
    end_time: GAP_BASE + 3000, type: "person" };
  const harness = createGapHarness({ debug: true,
    reviewEvents: [event],
    availabilityResponder: recordingCoverageResponder({ drive_up: [], drive_down: [] })
  });
  t.after(() => harness.close());
  await harness.controller.refreshReviewQuery();
  await settleCoverage();
  assert.deepEqual(gapRanges(harness, "drive_up"), [[GAP_BASE + 1000, GAP_BASE + 3000]]);
  assert.deepEqual(gapRanges(harness, "drive_down"), [],
    "a camera with no events gets nothing, even though all of it is unrecorded");
  assert.equal(harness.root.querySelectorAll(".review-timeline-gap").length, 0);
});


test("Review timeline draws nothing for a gap outside every event", async t => {
  const event = { camera_id: "drive_up", start_time: GAP_BASE + 1000,
    end_time: GAP_BASE + 3000, type: "person" };
  const harness = createGapHarness({
    reviewEvents: [event],
    availabilityResponder: recordingCoverageResponder({
      drive_up: [{ start: GAP_BASE - 7200, end: GAP_BASE - 3600 },
        { start: GAP_BASE - 3000, end: GAP_BASE + 7200 }],
      drive_down: [{ start: GAP_BASE - 7200, end: GAP_BASE + 7200 }]
    })
  });
  t.after(() => harness.close());
  await harness.controller.refreshReviewQuery();
  await settleCoverage();
  assert.ok(coverageCalls(harness).length > 0);
  assert.deepEqual(gapRanges(harness, "drive_up"), []);
  assert.equal(harness.root.querySelectorAll(".review-timeline-marker-gap").length, 0);
});


test("Review timeline recolors a point event inside a gap", async t => {
  const event = { camera_id: "drive_up", start_time: GAP_BASE + 1000, type: "person" };
  const harness = createGapHarness({ debug: true,
    reviewEvents: [event],
    availabilityResponder: recordingCoverageResponder({ drive_up: [], drive_down: [] })
  });
  t.after(() => harness.close());
  await harness.controller.refreshReviewQuery();
  await settleCoverage();
  assert.deepEqual(gapRanges(harness, "drive_up"), [[GAP_BASE + 1000, GAP_BASE + 1000]]);
  assert.ok(harness.root.querySelector(".review-timeline-marker-gap.point"));
});


test("Review timeline keeps events unchanged while coverage is pending or failed", async t => {
  const held = [];
  const event = { camera_id: "drive_up", start_time: GAP_BASE - 1000,
    end_time: GAP_BASE + 1000, type: "person" };
  const harness = createGapHarness({ debug: true,
    reviewEvents: [event],
    availabilityResponder: recordingCoverageResponder({ drive_up: [], drive_down: [] },
      message => new Promise((resolve, reject) => held.push({ message, resolve, reject })))
  });
  t.after(() => harness.close());
  await harness.controller.refreshReviewQuery();
  await settleCoverage();
  assert.ok(held.length > 0);
  assert.deepEqual(gapRanges(harness, "drive_up"), [], "pending coverage");
  assert.equal(harness.root.querySelectorAll(".review-timeline-marker").length, 1);

  // Only one of the event's two windows answers: the unanswered half is unknown.
  const early = held.find(call => call.message.camera === "drive_up" &&
    call.message.start === GAP_BASE - 7200);
  early.resolve({ camera: "drive_up", requested_start: early.message.start,
    requested_end: early.message.end, coverage: [] });
  await settleCoverage();
  assert.deepEqual(gapRanges(harness, "drive_up"), [[GAP_BASE - 1000, GAP_BASE]],
    "only the confirmed window recolors its half of the event");

  for (const call of held) if (call !== early) call.reject(new Error("synthetic outage"));
  await settleCoverage();
  assert.deepEqual(gapRanges(harness, "drive_up"), [[GAP_BASE - 1000, GAP_BASE]],
    "a failed window adds nothing");
  assert.equal(harness.root.querySelector(".review-timeline-refresh"), null,
    "no error or unknown state is introduced");
  const failedCalls = coverageCalls(harness).length;
  harness.controller.updateRhs();
  await settleCoverage();
  assert.equal(coverageCalls(harness).length, failedCalls, "failures are not retried in a loop");
});


test("Review timeline event gaps follow camera changes and pan/zoom", async t => {
  const events = [
    { camera_id: "drive_up", start_time: GAP_BASE + 1000, end_time: GAP_BASE + 3000, type: "person" },
    { camera_id: "drive_down", start_time: GAP_BASE + 1000, end_time: GAP_BASE + 3000, type: "car" }
  ];
  const harness = createGapHarness({ debug: true,
    reviewEvents: events,
    availabilityResponder: recordingCoverageResponder({
      drive_up: [{ start: GAP_BASE - 7200, end: GAP_BASE + 1800 },
        { start: GAP_BASE + 2400, end: GAP_BASE + 7200 }],
      drive_down: [{ start: GAP_BASE - 7200, end: GAP_BASE + 7200 }]
    })
  });
  t.after(() => harness.close());
  await harness.controller.refreshReviewQuery();
  await settleCoverage();
  const loaded = coverageCalls(harness).length;
  const expectGap = (start, end, top, height) => {
    const segments = timelineGaps(harness, "drive_up");
    assert.deepEqual(segments.map(gap => [gap.start, gap.end]), [[start, end]]);
    assertGapGeometry(segments[0], top, height);
  };
  harness.controller.setTimelineViewport({ from: GAP_BASE, to: GAP_BASE + 3600 });
  expectGap(GAP_BASE + 1800, GAP_BASE + 2400, 1200 / 3600, 600 / 3600);
  harness.controller.setTimelineViewport({ from: GAP_BASE + 1800, to: GAP_BASE + 2700 });
  expectGap(GAP_BASE + 1800, GAP_BASE + 2400, 300 / 900, 600 / 900);
  harness.controller.setTimelineViewport({ from: GAP_BASE + 2100, to: GAP_BASE + 3000 });
  expectGap(GAP_BASE + 2100, GAP_BASE + 2400, 600 / 900, 300 / 900);
  harness.controller.setTimelineViewport({ from: GAP_BASE + 3000, to: GAP_BASE + 3900 });
  assert.deepEqual(gapRanges(harness, "drive_up"), [],
    "no recolor where only the recorded part of the event shows");
  await settleCoverage();
  assert.equal(coverageCalls(harness).length, loaded, "pan and zoom reuse cached windows");

  harness.controller.setTimelineViewport({ from: GAP_BASE, to: GAP_BASE + 3600 });
  harness.controller.setSelectedCameraNames(["Drive Down"]);
  await harness.controller.flushScheduledReviewQuery();
  await settleCoverage();
  assert.equal(harness.root.querySelector('.review-timeline-lane[data-camera-id="drive_up"]'), null);
  assert.deepEqual(gapRanges(harness, "drive_down"), [], "a fully recorded camera stays unchanged");
  harness.controller.setSelectedCameraNames(["Drive Up", "Drive Down"]);
  await harness.controller.flushScheduledReviewQuery();
  await settleCoverage();
  assert.deepEqual(gapRanges(harness, "drive_up"), [[GAP_BASE + 1800, GAP_BASE + 2400]]);
  assert.equal(coverageCalls(harness).length, loaded, "camera changes reuse cached windows");
});


test("recording gap intersections clip events to confirmed gaps only", () => {
  const gaps = [{ start: 10, end: 20 }, { start: 30, end: 40 }];
  assert.deepEqual(recordingGapIntersections({ start_time: 15, end_time: 35 }, gaps),
    [{ start: 15, end: 20 }, { start: 30, end: 35 }]);
  assert.deepEqual(recordingGapIntersections({ start_time: 20, end_time: 30 }, gaps), []);
  assert.deepEqual(recordingGapIntersections({ start_time: 12 }, gaps), [{ start: 12, end: 12 }]);
  assert.deepEqual(recordingGapIntersections({ start_time: 25 }, gaps), []);
  assert.deepEqual(recordingGapIntersections({ start_time: 15, end_time: 35 }, []), []);
});


test("characterization: Auto Snap OFF Play inside a confirmed gap runs the clock and rejoins video", async t => {
  const target = UNRECORDED_TARGET;
  let tick = 1000;
  const harness = createHistoricalHarness({
    now: () => tick, availabilityResponder: unrecordedGapCoverage()
  });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.playHistorical(target + 10, { autoplay: false });
  const players = [...controller._historicalPlayers.values()];
  assert.ok(players.every(player => player.lifecycleState === "unavailable" &&
    player.boundaryReason === "authoritative_recording_gap"));
  assert.equal(controller.clock.running, false);
  assert.equal(controller.resumePlayback(), true);
  assert.equal(controller.clock.running, true);
  assert.equal(controller.clock.absoluteTime, target + 10, "Play does not move the TI");
  tick = 6000;
  assert.equal(controller.clock.absoluteTime, target + 15, "the no-video clock advances");
  assert.ok(players.every(player => player.lifecycleState === "unavailable"));
  tick = 12000;
  // The shared 500 ms tick uses this coalescing queue; Play already queued one.
  await controller.queueHistoricalAvailabilityEvaluation("shared_interval");
  await waitForCondition(() => players.every(player => player.lifecycleState === "participating"));
  assert.ok(players.every(player => player.lifecycleState === "participating"),
    "recorded video rejoins once coverage resumes");
  assert.equal(controller.clock.running, true);
  assert.equal(controller.clock.absoluteTime, target + 21);
});


test("an Auto Snap event start is planned and entered from events, not coverage", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000, now: () => 1000,
    initialReviewRange: when, reviewEvents: [
      { camera_id: "drive_up", start_time: base, end_time: base + 30 }
    ], availabilityResponder: recordingCoverageResponder({
      drive_up: [{ start: base + 8, end: base + 30 }], drive_down: []
    }) });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base - 50, when);
  const calls = harness.calls.length;
  const plan = controller.planAutoSnapAt(base - 50, controller.getAutoSnapInventory());
  assert.deepEqual(plan, { kind: "seek", interval: { start: base, end: base + 30 } });
  assert.equal(harness.calls.length, calls, "the literal event start needs no coverage lookup");
  assert.equal(controller.resumePlayback(), true);
  await waitForCondition(() => controller.getRecentAutoSnapDecisions()[0]?.outcome === "advanced");
  assert.equal(controller.clock.absoluteTime, base, "the actual event start, not first coverage");
  assert.equal(controller.clock.running, true);
  assert.equal(controller._autoSnapActiveStart, base);
});


test("a confirmed-gap autoplay seek advances without an opt-in", async t => {
  const tick = { value: 1000 };
  const harness = createUnrecordedSeekHarness(t, { tick });
  const controller = harness.controller;
  await controller.playHistorical(UNRECORDED_TARGET, { autoplay: false });
  assert.equal(await controller.seekHistoricalToEpoch(UNRECORDED_TARGET + 10,
    { autoplay: true }), true);
  assert.ok([...controller._historicalPlayers.values()].every(player =>
    player.lifecycleState === "unavailable"));
  assert.equal(controller.clock.running, true);
  assert.equal(controller.clock.absoluteTime, UNRECORDED_TARGET + 10);
});


test("an opted-in confirmed-gap seek runs the clock at the selected speed and rejoins video", async t => {
  const tick = { value: 1000 };
  const harness = createUnrecordedSeekHarness(t, { tick });
  const controller = harness.controller;
  controller.setPlaybackSpeed(4);
  await controller.playHistorical(UNRECORDED_TARGET, { autoplay: false });
  assert.equal(await controller.seekHistoricalToEpoch(UNRECORDED_TARGET + 10,
    { autoplay: true, advanceThroughConfirmedGap: true }), true);
  const players = [...controller._historicalPlayers.values()];
  assert.ok(players.every(player => player.lifecycleState === "unavailable" &&
    player.boundaryReason === "authoritative_recording_gap"),
    "recording absence is unavailable, not failed");
  assert.equal(controller.clock.running, true);
  assert.equal(controller.clock.absoluteTime, UNRECORDED_TARGET + 10, "the TI is literal");
  assert.equal(controller._playRequested, false);
  assert.equal(harness.root.querySelector(".review-pause").disabled, false);
  tick.value += 1000;
  assert.equal(controller.clock.absoluteTime, UNRECORDED_TARGET + 14, "4x selected speed");
  tick.value += 1000;
  await controller.queueHistoricalAvailabilityEvaluation("shared_interval");
  assert.ok(players.every(player => player.lifecycleState === "unavailable"),
    "still inside the gap at TI + 18");
  tick.value += 1000;
  await controller.queueHistoricalAvailabilityEvaluation("shared_interval");
  await waitForCondition(() => players.every(player => player.lifecycleState === "participating"),
    "cameras did not rejoin after the gap");
  assert.equal(controller.clock.running, true);
  assert.equal(controller.clock.absoluteTime, UNRECORDED_TARGET + 22);
});


test("a gap autoplay seek advances even when a camera availability query fails", async t => {
  const tick = { value: 1000 };
  const harness = createUnrecordedSeekHarness(t, { tick, onRequest: message =>
    message.camera === "drive_down" && message.start > UNRECORDED_TARGET + 1000
      ? Promise.reject(new Error("synthetic availability outage")) : undefined });
  const controller = harness.controller;
  await controller.playHistorical(UNRECORDED_TARGET + 10, { autoplay: false });
  // A gap in the next aligned window, which the seek must query (and which fails for Drive Down).
  const farGap = FAR_GAP + 7200;
  assert.equal(await controller.seekHistoricalToEpoch(farGap,
    { autoplay: true, advanceThroughConfirmedGap: true }), true);
  const up = controller._historicalPlayers.get("Drive Up");
  const down = controller._historicalPlayers.get("Drive Down");
  assert.equal(up.boundaryReason, "authoritative_recording_gap");
  assert.equal(down.lifecycleState, "failed");
  assert.equal(controller.clock.running, true, "failed coverage cannot veto the clock");
  assert.equal(controller.clock.absoluteTime, farGap);
});


for (const supersession of ["Pause", "manual seek", "camera change"]) {
  test(`${supersession} supersedes a pending opted-in gap seek`, async t => {
    const tick = { value: 1000 };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const harness = createUnrecordedSeekHarness(t, { tick, onRequest: message =>
      message.start > UNRECORDED_TARGET + 1000 ? gate.then(() => ({
        camera: message.camera, requested_start: message.start,
        requested_end: message.end, coverage: []
      })) : undefined });
    const controller = harness.controller;
    await controller.playHistorical(UNRECORDED_TARGET + 10, { autoplay: false });
    const seek = controller.seekHistoricalToEpoch(FAR_GAP,
      { autoplay: true, advanceThroughConfirmedGap: true });
    await waitForCondition(() => harness.calls.some(call =>
      call.type === "frigate_max/v1/recordings/availability" &&
      call.start > UNRECORDED_TARGET + 1000), "the far lookup was not issued");
    let manual = null;
    if (supersession === "Pause") assert.equal(controller.pausePlayback(), true);
    if (supersession === "manual seek") {
      manual = controller.seekHistoricalToEpoch(UNRECORDED_TARGET + 12, { autoplay: false });
    }
    if (supersession === "camera change") controller.setSelectedCameraNames(["Drive Up"]);
    release();
    await seek;
    await manual;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.clock.running, false);
    assert.equal(controller._playRequested, false, "no deferred Play survives cancellation");
    if (supersession === "manual seek") {
      assert.equal(controller.clock.absoluteTime, UNRECORDED_TARGET + 12);
    }
    if (supersession === "camera change") {
      assert.equal(controller.state.presentationMode, "live");
    }
  });
}



// Investigation time belongs to transport, including while every camera is pending.
for (const speed of [1, 8]) {
  for (const state of ["gap", "failed", "unknown"]) {
    test(`clock ownership: initial Play advances through ${state} availability at ${speed}x`, async t => {
      const base = 1800000000;
      let now = 1000;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const harness = createHistoricalHarness({ now: () => now,
        availabilityResponder: message => {
          const response = { camera: message.camera, requested_start: message.start,
            requested_end: message.end, coverage: [] };
          return state === "unknown" ? gate.then(() => response) : state === "failed"
            ? Promise.reject(new Error("availability outage")) : Promise.resolve(response);
        } });
      t.after(() => harness.close());
      const controller = harness.controller;
      controller.setPlaybackSpeed(speed);
      const acquisition = controller.playHistorical(base);
      assert.equal(controller.clock.running, true);
      now += 2000;
      assert.equal(controller.clock.absoluteTime, base + 2 * speed);
      if (state === "unknown") release();
      await acquisition;
      assert.equal(controller.clock.running, true);
      assert.equal(controller.clock.absoluteTime, base + 2 * speed);
      assert.equal([...controller._historicalPlayers.values()].some(player =>
        player.lifecycleState === "participating"), false);
      assert.equal(controller.pausePlayback(), true);
      now += 1000;
      assert.equal(controller.clock.absoluteTime, base + 2 * speed);
    });
  }
}


for (const autoplay of [true, false]) {
  test(`clock ownership: Pause wins over initial acquisition with autoplay=${autoplay}`, async t => {
    const base = 1800000000;
    let now = 1000;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const harness = createHistoricalHarness({ now: () => now, prepareGate: gate });
    t.after(() => harness.close());
    const controller = harness.controller;
    const acquisition = controller.playHistorical(base, { autoplay });
    await waitForCondition(() => harness.calls.some(call => call.type === "frigate_max/v2/vod/prepare"));
    if (!autoplay) assert.equal(controller.resumePlayback(), true);
    now += 3000;
    assert.equal(controller.pausePlayback(), true);
    const pausedEpoch = controller.clock.absoluteTime;
    release();
    await acquisition;
    now += 3000;
    assert.equal(controller.clock.running, false);
    assert.equal(controller.clock.absoluteTime, pausedEpoch);
    assert.ok([...controller._historicalPlayers.values()].every(player =>
      player.video.paused && player.resolvedEpoch === pausedEpoch));
    assert.equal(harness.playCalls.length, 0);
  });
}


for (const failure of [true, false]) {
  test(`clock ownership: pending manual seek retains Pause and epoch after lookup failure=${failure}`, async t => {
    const base = 1800000000;
    const target = base + 8000;
    let now = 1000;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const harness = createHistoricalHarness({ now: () => now,
      availabilityResponder: message => message.start > base + 1000
        ? gate.then(() => {
          if (failure) throw new Error("availability outage");
          return { camera: message.camera, requested_start: message.start,
            requested_end: message.end, coverage: [{ start: message.start, end: message.end }] };
        }) : Promise.resolve({ camera: message.camera, requested_start: message.start,
          requested_end: message.end, coverage: [{ start: message.start, end: message.end }] }) });
    t.after(() => harness.close());
    const controller = harness.controller;
    await controller.playHistorical(base, { autoplay: false });
    const seek = controller.seekHistoricalToEpoch(target, { autoplay: true });
    assert.equal(controller.clock.absoluteTime, target);
    now += 4000;
    assert.equal(controller.clock.absoluteTime, target + 4);
    assert.equal(controller.pausePlayback(), true);
    release();
    await seek;
    now += 4000;
    assert.equal(controller.clock.absoluteTime, target + 4);
    assert.equal(controller.clock.running, false);
  });
}


for (const failedCamera of ["both", "drive_up"]) {
  test(`clock ownership: failed ${failedCamera} lookup cannot reanchor a running explicit seek`, async t => {
    const base = 1800000000;
    let now = 1000;
    let fail = false;
    const harness = createHistoricalHarness({ now: () => now,
      availabilityResponder: message => fail && (failedCamera === "both" || message.camera === failedCamera)
        ? Promise.reject(new Error("availability outage"))
        : Promise.resolve({ camera: message.camera, requested_start: message.start,
          requested_end: message.end, coverage: [{ start: message.start, end: message.end }] }) });
    t.after(() => harness.close());
    const controller = harness.controller;
    await controller.playHistorical(base, { autoplay: false });
    fail = true;
    await controller.seekHistoricalToEpoch(base + 8000, { autoplay: true });
    now += 2000;
    assert.equal(controller.clock.absoluteTime, base + 8002);
    assert.equal(controller.clock.running, true);
    if (failedCamera !== "both") {
      assert.equal(controller._historicalPlayers.get("Drive Down").resolvedEpoch, base + 8000);
    }
    assert.equal(controller._historicalPlayers.get("Drive Up").lifecycleState, "failed");
    const failed = controller._historicalPlayers.get("Drive Up");
    assert.equal(failed.statusElement.hidden, true);
    assert.match(failed.statusElement.textContent, /Historical playback unavailable/);
    const indicator = harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"] .review-camera-presentation-kind');
    assert.equal(indicator.textContent, "Unavailable");
    assert.equal(indicator.hidden, false);
  });
}


test("clock ownership: obsolete availability cannot authorize a newer same-player seek", async t => {
  const base = 1800000000;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createHistoricalHarness({ now: () => 1000,
    availabilityResponder: message => {
      const response = { camera: message.camera, requested_start: message.start,
        requested_end: message.end, coverage: [{ start: message.start, end: message.end }] };
      return message.start > base + 1000 && message.start < base + 10000
        ? gate.then(() => response) : Promise.resolve(response);
    } });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.playHistorical(base, { autoplay: false });
  const player = controller._historicalPlayers.get("Drive Up");
  const obsolete = controller.ensureCameraAvailability(player, base + 8000);
  const rejected = assert.rejects(obsolete, /superseded/);
  await controller.seekHistoricalToEpoch(base + 16000, { autoplay: true });
  const currentCoverage = player.availability;
  release();
  await rejected;
  assert.strictEqual(player.availability, currentCoverage);
  assert.equal(controller.clock.absoluteTime, base + 16000);
  assert.equal(controller.clock.running, true);
});


for (const mismatch of ["start", "end"]) {
  test(`clock ownership: mismatched availability ${mismatch} cannot establish a gap`, async t => {
    const base = 1800000000;
    const harness = createHistoricalHarness({ now: () => 1000,
      availabilityResponder: message => Promise.resolve({ camera: message.camera,
        requested_start: message.start + (mismatch === "start" ? 1 : 0),
        requested_end: message.end - (mismatch === "end" ? 1 : 0), coverage: [] }) });
    t.after(() => harness.close());
    await harness.controller.playHistorical(base);
    assert.ok([...harness.controller._historicalPlayers.values()].every(player =>
      player.lifecycleState === "failed" && player.boundaryReason === "availability_api_failure"));
    assert.equal(harness.controller.clock.running, true);
    assert.equal(harness.controller.clock.absoluteTime, base);
  });
}


test("clock ownership: failed availability camera rejoins at current TI when queries recover", async t => {
  const base = 1800000000;
  let now = 1000;
  let fail = true;
  const harness = createHistoricalHarness({ now: () => now,
    availabilityResponder: message => fail ? Promise.reject(new Error("availability outage"))
      : Promise.resolve({ camera: message.camera, requested_start: message.start,
        requested_end: message.end, coverage: [{ start: message.start, end: message.end }] }) });
  t.after(() => harness.close());
  const controller = harness.controller;
  // Rejoin work is fire-and-forget from the queue, so observe each reconcile's own settlement.
  const reconciles = [];
  const reconcile = controller.reconcileHistoricalCamera.bind(controller);
  controller.reconcileHistoricalCamera = (...args) => {
    const operation = reconcile(...args);
    reconciles.push(operation);
    return operation;
  };
  await controller.playHistorical(base);
  // Recovery here is driven explicitly, not by a later heartbeat.
  harness.window.clearInterval(controller._diagnosticTimer);
  controller._diagnosticTimer = null;
  // Outage-era requests must finish their failure path before connectivity returns;
  // otherwise recovery would legitimately join an in-flight failing request.
  await controller._availabilityEvaluationPromise;
  await Promise.allSettled(reconciles);
  const players = [...controller._historicalPlayers.values()];
  assert.equal(controller._availabilityEvaluationPromise, null);
  assert.ok(players.every(player => player.availabilityPromise === null &&
    player.lifecycleState === "failed" && player.boundaryReason === "availability_api_failure"));
  now += 12000;
  fail = false;
  const recoveryStart = reconciles.length;
  await controller.queueHistoricalAvailabilityEvaluation("queries_recovered");
  const recovery = reconciles.slice(recoveryStart);
  assert.equal(recovery.length, players.length, "recovery reconciles every failed camera");
  assert.deepEqual(await Promise.all(recovery), players.map(() => "prepared"));
  assert.ok([...controller._historicalPlayers.values()].every(player =>
    player.lifecycleState === "participating"));
  assert.equal(controller.clock.absoluteTime, base + 12);
  assert.ok([...controller._historicalPlayers.values()].every(player =>
    player.resolvedEpoch === base + 12 && player.video.paused === false));
});


for (const change of ["repeat Play", "disable", "disable then enable"]) {
  test(`clock ownership: ${change} during pending Auto Snap acquisition preserves transport`, async t => {
    const base = 1800000000;
    const when = { from: base - 100, to: base + 10000 };
    let now = 1000;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const harness = createHistoricalHarness({ now: () => now,
      wallClockMs: when.to * 1000, initialReviewRange: when, reviewEvents: [
        { camera_id: "drive_up", start_time: base + 8000, end_time: base + 8020 }
      ], availabilityResponder: message => {
        const answer = { camera: message.camera, requested_start: message.start,
          requested_end: message.end, coverage: [] };
        return message.start > base + 1000 ? gate.then(() => answer) : Promise.resolve(answer);
      } });
    t.after(() => harness.close());
    const controller = await enterEventAutoSnap(harness, base, when);
    assert.equal(controller.resumePlayback(), true);
    assert.equal(controller.clock.absoluteTime, base + 8000);
    if (change === "repeat Play") assert.equal(controller.resumePlayback(), false);
    else {
      controller.setAutoSnapTo(false);
      if (change === "disable then enable") controller.setAutoSnapTo(true);
    }
    now += 3000;
    assert.equal(controller.clock.absoluteTime, base + 8003);
    release();
    await waitForCondition(() => !controller._historicalPreparing);
    assert.equal(controller.clock.running, true);
    assert.equal(controller.clock.absoluteTime, base + 8003);
    assert.equal(controller._autoSnapArmed, change === "repeat Play");
  });
}



for (const speed of [1, 8]) {
  test(`clock ownership: event boundary navigates while availability remains pending at ${speed}x`, async t => {
    const base = 1800000000;
    const when = { from: base - 100, to: base + 10000 };
    let now = 1000;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const harness = createHistoricalHarness({ now: () => now, wallClockMs: when.to * 1000,
      initialReviewRange: when, reviewEvents: [
        { camera_id: "drive_up", start_time: base + 8000, end_time: base + 8020 },
        { camera_id: "drive_up", start_time: base + 8100, end_time: base + 8120 }
      ], availabilityResponder: message => {
        const response = { camera: message.camera, requested_start: message.start,
          requested_end: message.end, coverage: [] };
        return message.start > base + 1000 ? gate.then(() => response) : Promise.resolve(response);
      } });
    t.after(() => harness.close());
    const controller = await enterEventAutoSnap(harness, base, when);
    controller.setPlaybackSpeed(speed);
    controller.resumePlayback();
    assert.equal(controller.clock.absoluteTime, base + 8000);
    now += 20000 / speed;
    assert.equal(controller.enforceAutoSnapBoundary(), true);
    assert.equal(controller.clock.absoluteTime, base + 8100);
    assert.equal(controller.clock.running, true);
    assert.equal(controller._autoSnapActiveEnd, base + 8120);
    now += 1000;
    release();
    await waitForCondition(() => !controller._historicalPreparing);
    assert.equal(controller.clock.absoluteTime, base + 8100 + speed);
    assert.equal(controller.clock.running, true);
    controller.pausePlayback();
  });
}


test("clock ownership: one pending seek lookup cannot hold a healthy camera's Play", async t => {
  const base = 1800000000;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createHistoricalHarness({ now: () => 1000,
    availabilityResponder: message => {
      const response = { camera: message.camera, requested_start: message.start,
        requested_end: message.end, coverage: [{ start: message.start, end: message.end }] };
      return message.camera === "drive_up" && message.start > base + 1000
        ? gate.then(() => response) : Promise.resolve(response);
    } });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.playHistorical(base, { autoplay: false });
  const seek = controller.seekHistoricalToEpoch(base + 8000, { autoplay: true });
  const down = controller._historicalPlayers.get("Drive Down");
  await waitForCondition(() => down.lifecycleState === "participating" && !down.video.paused);
  assert.equal(controller.clock.absoluteTime, base + 8000);
  assert.equal(controller.clock.running, true);
  assert.equal(controller._historicalPreparing, true);
  release();
  await seek;
  assert.equal(controller.clock.absoluteTime, base + 8000);
});


test("clock ownership: a pending participating-camera refresh cannot hold another camera's rejoin", async t => {
  const base = 1800000000;
  let pending = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createHistoricalHarness({ now: () => 1000,
    availabilityResponder: message => {
      const response = { camera: message.camera, requested_start: message.start,
        requested_end: message.end, coverage: [{ start: message.start, end: message.end }] };
      return pending && message.camera === "drive_up"
        ? gate.then(() => response) : Promise.resolve(response);
    } });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.playHistorical(base);
  const up = controller._historicalPlayers.get("Drive Up");
  const down = controller._historicalPlayers.get("Drive Down");
  controller.leaveHistoricalCamera(down, "authoritative_recording_gap", base);
  up.availability = null;
  pending = true;
  await controller.queueHistoricalAvailabilityEvaluation("peer_pending");
  await waitForCondition(() => down.lifecycleState === "participating" && !down.video.paused);
  assert.equal(controller.clock.running, true);
  assert.equal(controller.clock.absoluteTime, base);
  release();
});



for (const prototype of [false, true]) {
  test(`clock ownership: Pause survives late native Play settlement (prototype=${prototype})`, async t => {
    const base = 1800000000;
    let now = 0;
    let release;
    let pendingVideo;
    let plays = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const harness = createHistoricalHarness({ now: () => now,
      playResponder: (_camera, video) => {
        plays += 1;
        if (plays !== (prototype ? 2 : 1)) return Promise.resolve();
        pendingVideo = video;
        let nativePaused = false;
        const pause = video.pause;
        video.pause = () => { nativePaused = true; pause(); };
        Object.defineProperty(video, "paused", { configurable: true, get: () => nativePaused });
        return gate.then(() => { nativePaused = false; });
      } });
    t.after(() => harness.close());
    const controller = harness.controller;
    let acquisition;
    if (prototype) {
      configureGarage(harness);
      acquisition = controller.runContinuousHandoffPrototype({ targetEpoch: base, rate: 1 });
      await waitForCalls(harness, "frigate_max/v1/vod/prepare", 2);
      const player = controller._historicalPlayers.get("Garage");
      now = 120000;
      player.video.currentTime = base + 120 - player.timing.effective_absolute_origin;
      player.video.dispatchEvent(new harness.window.Event("ended"));
    } else {
      controller.setSelectedCameraNames(["Drive Up"]);
      acquisition = controller.playHistorical(base);
    }
    await waitForCondition(() => Boolean(pendingVideo));
    assert.equal(controller.pausePlayback(), true);
    const epoch = controller.clock.absoluteTime;
    release();
    await acquisition;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pendingVideo.paused, true);
    now += 1000;
    assert.equal(controller.clock.absoluteTime, epoch);
    assert.equal(controller.clock.running, false);
  });
}



test("clock ownership: obsolete initial deadline cannot retire a newer same-player seek", async t => {
  const base = 1800000000;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const deadlines = manualInitialDeadlines();
  const harness = createHistoricalHarness({ now: () => 1000,
    scheduleInitialDeadline: deadlines.schedule.bind(deadlines),
    presentationResponder: message => message.target === base
      ? gate.then(() => presentationPrepared(message.camera, base - 21, base))
      : Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target)) });
  t.after(() => harness.close());
  const controller = harness.controller;
  const initial = controller.playHistorical(base);
  await waitForCalls(harness, "frigate_max/v2/vod/prepare", 2);
  const oldDeadline = deadlines.jobs.findLast(job => job.active);
  assert.ok(oldDeadline);
  await controller.seekHistoricalToEpoch(base + 10, { autoplay: true });
  const players = [...controller._historicalPlayers.values()];
  const sources = players.map(player => player.hls);
  assert.ok(players.every(player => player.lifecycleState === "participating"),
    JSON.stringify(players.map(p => ({ state: p.lifecycleState, reason: p.boundaryReason, stage: p.reviewStage }))));
  oldDeadline.fire();
  await initial;
  assert.deepEqual(players.map(player => player.hls), sources);
  assert.ok(players.every(player => player.lifecycleState === "participating" && !player.initialTimedOut));
  assert.equal(controller.clock.absoluteTime, base + 10);
  assert.equal(controller.clock.running, true);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(players.map(player => player.hls), sources);
});



test("clock ownership: manual event Snap completion cannot rewind a later Pause", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  let now = 1000;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createHistoricalHarness({ now: () => now, wallClockMs: when.to * 1000,
    initialReviewRange: when, prepareGate: gate,
    reviewEvents: [{ camera_id: "drive_up", start_time: base + 100, end_time: base + 120 }] });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.refreshReviewQuery();
  controller._reviewPosition = base;
  const snap = controller.snapToNextEvent();
  await waitForCalls(harness, "frigate_max/v2/vod/prepare", 2);
  assert.equal(controller.clock.absoluteTime, base + 100);
  controller.resumePlayback();
  now += 3000;
  controller.pausePlayback();
  release();
  assert.equal(await snap, true);
  assert.equal(controller.clock.absoluteTime, base + 103);
  assert.equal(controller.clock.running, false);
});


for (const speed of [1, 8]) {
  test(`readiness hold: RVFC-ready peers release together before timeout at ${speed}x`, async t => {
    const base = 1800000000;
    const h = createReadinessHarness(t, { deferredFrame: new Set(["Drive Up", "Drive Down"]) });
    h.controller.setPlaybackSpeed(speed);
    const run = h.controller.playHistorical(base);
    await waitForHistoricalMedia(h, 2);
    await waitForCondition(() => h.mediaControls.every(c => c.video.currentTimeWrites.length === 1));
    assert.equal(h.calls.filter(c => c.type === "frigate_max/v2/vod/prepare").length, 2);
    assert.equal(h.controller.clock.running, false);
    assert.equal(h.root.querySelector(".review-pause").disabled, false);
    h.tick.value += 600;
    h.mediaControls[0].emitFrame();
    await waitForCondition(() => h.controller._historicalPlayers.get(h.mediaControls[0].camera).lifecycleState === "participating");
    assert.equal(h.playCalls.length, 0);
    assert.equal(h.controller.clock.absoluteTime, base);
    h.mediaControls[1].emitFrame();
    await run;
    assert.equal(h.controller.clock.running, true);
    assert.equal(h.controller.clock.absoluteTime, base);
    assert.equal(h.playCalls.length, 2);
    assert.ok(h.playCalls.every(c => c.clockRunning && c.playbackRate === speed));
    assert.ok(!h.deadlines.jobs.some(job => job.active));
    h.tick.value += 1000;
    assert.equal(h.controller.clock.absoluteTime, base + speed);
  });
}


test("readiness hold: timeout releases a ready peer and late availability joins at current TI", async t => {
  const base = 1800000000;
  let resolveDown;
  const gate = new Promise(resolve => { resolveDown = resolve; });
  const h = createReadinessHarness(t, { availabilityResponder: message => {
    const result = { camera: message.camera, requested_start: message.start,
      requested_end: message.end, coverage: [{ start: message.start, end: message.end }] };
    return message.camera === "drive_down" ? gate.then(() => result) : Promise.resolve(result);
  } });
  const run = h.controller.playHistorical(base);
  await waitForCondition(() => h.controller._historicalPlayers.get("Drive Up")?.lifecycleState === "participating");
  const healthy = h.controller._historicalPlayers.get("Drive Up");
  const source = healthy.hls;
  assert.equal(h.playCalls.length, 0);
  h.tick.value += 1500;
  assert.equal(h.controller.clock.absoluteTime, base);
  h.releaseTimeout();
  assert.equal(h.controller.clock.running, true);
  assert.deepEqual(h.playCalls.map(c => c.camera), ["Drive Up"]);
  h.tick.value += 2000;
  assert.equal(h.controller.clock.absoluteTime, base + 2);
  resolveDown();
  await run;
  const down = h.controller._historicalPlayers.get("Drive Down");
  assert.equal(down.timing.selected_epoch, base + 2);
  assert.equal(down.initialPlacement.landedEpoch, base + 2);
  assert.equal(down.lifecycleState, "participating");
  assert.strictEqual(healthy.hls, source);
  assert.equal(healthy.video.currentTimeWrites.length, 1);
  assert.equal(h.controller.clock.absoluteTime, base + 2);
});


test("readiness hold: confirmed gaps do not consume the window and playback keeps advancing", async t => {
  const base = 1800000000;
  const h = createReadinessHarness(t, { availabilityResponder: message => Promise.resolve({
    camera: message.camera, requested_start: message.start, requested_end: message.end, coverage: []
  }) });
  await h.controller.playHistorical(base);
  assert.equal(h.controller.clock.running, true);
  assert.equal(h.controller._playbackPreparation, null);
  assert.equal(h.playCalls.length, 0);
  assert.ok(!h.deadlines.jobs.some(job => job.active));
  h.tick.value += 3000;
  assert.equal(h.controller.clock.absoluteTime, base + 3);
});


for (const state of ["failed", "pending", "mismatched"]) {
  test(`readiness hold: ${state} availability consumes only the bounded window`, async t => {
    const base = 1800000000;
    let resolve;
    const gate = new Promise(r => { resolve = r; });
    const h = createReadinessHarness(t, { availabilityResponder: message => {
      if (state === "failed") return Promise.reject(new Error("outage"));
      const result = { camera: message.camera, requested_start: message.start,
        requested_end: message.end + (state === "mismatched" ? 1 : 0), coverage: [] };
      return state === "pending" ? gate.then(() => result) : Promise.resolve(result);
    } });
    const run = h.controller.playHistorical(base);
    await waitForCalls(h, "frigate_max/v1/recordings/availability", 2);
    if (state !== "pending") await run;
    assert.equal(h.controller.clock.running, false);
    h.tick.value += 1500;
    assert.equal(h.controller.clock.absoluteTime, base);
    h.releaseTimeout();
    h.tick.value += 1000;
    assert.equal(h.controller.clock.absoluteTime, base + 1);
    if (state === "pending") { resolve(); await run; }
    assert.equal(h.controller.clock.running, true);
  });
}


test("readiness hold: Pause cancels release and stale deadline or frames cannot restart playback", async t => {
  const base = 1800000000;
  const h = createReadinessHarness(t, { deferredFrame: new Set(["Drive Up", "Drive Down"]) });
  const run = h.controller.playHistorical(base);
  await waitForHistoricalMedia(h, 2);
  await waitForCondition(() => h.mediaControls.every(c => c.video.currentTimeWrites.length === 1));
  const deadline = h.deadlines.jobs.find(job => job.delay === 1500);
  assert.equal(h.controller.pausePlayback(), true);
  deadline.callback();
  h.tick.value += 3000;
  h.mediaControls.forEach(c => c.emitFrame());
  await run;
  assert.equal(h.controller.clock.running, false);
  assert.equal(h.controller.clock.absoluteTime, base);
  assert.equal(h.playCalls.length, 0);
  assert.equal(h.controller._playbackPreparation, null);
});


test("readiness hold: Play after Pause during acquisition releases early when owned cameras become ready", async t => {
  const base = 1800000000;
  const h = createReadinessHarness(t, { deferredFrame: new Set(["Drive Up", "Drive Down"]) });
  const run = h.controller.playHistorical(base);
  await waitForHistoricalMedia(h, 2);
  await waitForCondition(() => h.mediaControls.every(c => c.video.currentTimeWrites.length === 1));
  h.controller.pausePlayback();
  h.controller.resumePlayback();
  assert.equal(h.controller.clock.running, false);
  h.mediaControls.forEach(c => c.emitFrame());
  await run;
  await waitForCondition(() => h.playCalls.length === 2);
  assert.equal(h.controller.clock.running, true);
  assert.equal(h.controller.clock.absoluteTime, base);
});


test("readiness hold: manual navigation supersedes the old epoch, deadline, and acquisition", async t => {
  const base = 1800000000;
  let resolveOld;
  const gate = new Promise(resolve => { resolveOld = resolve; });
  const h = createReadinessHarness(t, { presentationResponder: message => message.target === base
    ? gate.then(() => presentationPrepared(message.camera, base - 21, base))
    : Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target)) });
  const old = h.controller.playHistorical(base);
  await waitForCalls(h, "frigate_max/v2/vod/prepare", 2);
  const deadline = h.deadlines.jobs.find(job => job.delay === 1500);
  const next = h.controller.seekHistoricalToEpoch(base + 10);
  assert.equal(h.controller.clock.absoluteTime, base + 10);
  assert.equal(h.controller.clock.running, false);
  deadline.callback();
  assert.equal(h.controller.clock.running, false);
  await next;
  resolveOld();
  await old;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.controller.clock.absoluteTime, base + 10);
  assert.equal(h.controller.clock.running, true);
  assert.equal(h.playCalls.length, 2);
});


for (const speed of [1, 8]) {
  test(`readiness hold: Auto Snap enters literal event starts and waits for RVFC at ${speed}x`, async t => {
    const base = 1800000000;
    const when = { from: base - 100, to: base + 100 };
    const frames = new Set();
    // Beyond the 90 s live margin, so both events' recordings are published.
    const h = createReadinessHarness(t, { initialReviewRange: when, wallClockMs: (when.to + 200) * 1000,
      deferredFrame: frames, reviewEvents: [
        { id: "one", camera_id: "drive_up", start_time: base + 10, end_time: base + 12 },
        { id: "two", camera_id: "drive_up", start_time: base + 30, end_time: base + 32 }
      ] });
    const controller = await enterEventAutoSnap(h, base, when);
    controller.setPlaybackSpeed(speed);
    frames.add("Drive Up"); frames.add("Drive Down");
    controller.resumePlayback();
    assert.equal(controller.clock.absoluteTime, base + 10);
    assert.equal(controller.clock.running, false);
    await waitForCondition(() => h.mediaControls.every(c => c.video.currentTimeWrites.length === 2));
    h.tick.value += 700;
    assert.equal(controller.clock.absoluteTime, base + 10);
    h.mediaControls.forEach(c => c.emitFrame());
    await waitForCondition(() => controller.clock.running);
    assert.equal(controller.clock.absoluteTime, base + 10);
    h.tick.value += 2000 / speed;
    assert.equal(controller.enforceAutoSnapBoundary(), true);
    assert.equal(controller.clock.absoluteTime, base + 30);
    assert.equal(controller.clock.running, false);
    await waitForCondition(() => h.mediaControls.every(c => c.video.currentTimeWrites.length === 3));
    h.mediaControls.forEach(c => c.emitFrame());
    await waitForCondition(() => controller.clock.running);
    assert.equal(controller.clock.absoluteTime, base + 30);
  });
}


test("readiness hold: zero timeout releases immediately while cameras acquire", async t => {
  const base = 1800000000;
  let resolve;
  const gate = new Promise(r => { resolve = r; });
  const h = createReadinessHarness(t, { preparationTimeoutMs: 0, prepareGate: gate });
  const run = h.controller.playHistorical(base);
  assert.equal(h.controller.clock.running, true);
  assert.equal(h.controller._playbackPreparation, null);
  h.tick.value += 1000;
  assert.equal(h.controller.clock.absoluteTime, base + 1);
  resolve(); await run;
});


test("readiness hold: configuration is bounded, defaults to 1500, and stays outside Saved Views", t => {
  const h = createReadinessHarness(t);
  const controller = new ReviewController();
  assert.equal(controller._preparationTimeoutMs, 1500);
  for (const [value, expected] of [[0, 0], [5001, 5000], [-1, 0], [2500, 2500],
    [NaN, 1500], ["500", 1500], [null, 1500], [undefined, 1500]]) {
    controller.setPreparationTimeout(value);
    assert.equal(controller._preparationTimeoutMs, expected);
  }
  assert.deepEqual(h.controller.getReviewOptions(), { autoSnapTo: false, snapPastCrap: false });
  const cardHarness = createTestHarness();
  t.after(() => cardHarness.close());
  const card = cardHarness.createCard();
  card.setConfig({ ...card.config, review_preparation_timeout_ms: 500 });
  assert.equal(card._reviewController._preparationTimeoutMs, 500);
  assert.equal(card._applicationMode, "live");
  assert.equal(card._reviewController._playbackPreparation, null);
});


test("readiness hold: returning to Live cancels the release without disturbing Live media", async t => {
  const base = 1800000000;
  const h = createReadinessHarness(t, { prepareGate: new Promise(() => {}) });
  const run = h.controller.playHistorical(base);
  const deadline = h.deadlines.jobs.find(job => job.delay === 1500);
  h.controller.returnToLive();
  const images = [...h.root.querySelectorAll("hui-image")];
  deadline.callback();
  h.tick.value += 3000;
  await run;
  assert.equal(h.controller.state.presentationMode, "live");
  assert.equal(h.controller.clock.running, false);
  assert.equal(h.controller._playbackPreparation, null);
  assert.deepEqual([...h.root.querySelectorAll("hui-image")], images);
});



for (const path of ["initial", "reused seek"]) {
  test(`readiness hold: late RVFC admission remaps ${path} to current TI after timeout`, async t => {
    const base = 1800000000;
    const frames = new Set();
    const h = createReadinessHarness(t, { deferredFrame: frames });
    let run;
    if (path === "initial") {
      frames.add("Drive Down");
      run = h.controller.playHistorical(base);
    } else {
      await h.controller.playHistorical(base, { autoplay: false });
      frames.add("Drive Down");
      run = h.controller.seekHistoricalToEpoch(base + 10, { autoplay: true });
    }
    const target = path === "initial" ? base : base + 10;
    await waitForCondition(() => h.controller._historicalPlayers.get("Drive Up")?.lifecycleState === "participating");
    const down = h.controller._historicalPlayers.get("Drive Down");
    await waitForCondition(() => down.video?.currentTimeWrites.length === (path === "initial" ? 1 : 2));
    h.tick.value += 1500; h.releaseTimeout();
    h.tick.value += 2000;
    const control = h.mediaControls.find(c => c.camera === "Drive Down");
    control.emitFrame();
    await waitForCondition(() => down.video.currentTimeWrites.length === (path === "initial" ? 2 : 3));
    assert.equal(down.resolvedEpoch, target + 2);
    control.emitFrame();
    await run;
    assert.equal(down.initialPlacement.landedEpoch, target + 2);
    assert.equal(down.lifecycleState, "participating");
    assert.equal(h.controller.clock.absoluteTime, target + 2);
    assert.equal(h.controller.clock.running, true);
  });
}


test("readiness hold: Timeline drag cancels scheduled release before moving TI", async t => {
  const base = 1800000000;
  const range = { from: base - 100, to: base + 100 };
  const h = createReadinessHarness(t, { initialReviewRange: range,
    wallClockMs: range.to * 1000, prepareGate: new Promise(() => {}) });
  const run = h.controller.playHistorical(base);
  const deadline = h.deadlines.jobs.find(job => job.delay === 1500);
  const axis = h.root.querySelector(".review-timeline-axis");
  const handle = h.root.querySelector(".review-timeline-handle");
  axis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  handle.dispatchEvent(new h.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 99, button: 0, clientY: 300
  }));
  assert.equal(h.controller._playbackPreparation, null);
  deadline.callback();
  h.tick.value += 3000;
  assert.equal(h.controller.clock.running, false);
  assert.equal(h.playCalls.length, 0);
  h.controller.returnToLive();
  await run;
});


for (const recorded of [false, true]) {
  test(`Skip Deadspace white contract: BLACK time with recording=${recorded} plays continuously`, async t => {
    const h = await createRecordingSkipHarness(t, { coverage: {
      drive_up: recorded ? [{ start: SKIP_BASE, end: SKIP_BASE + 200 }] :
        [{ start: SKIP_BASE + 100, end: SKIP_BASE + 110 }], drive_down: []
    }, events: [{ camera_id: "drive_up", start_time: SKIP_BASE + 100, end_time: SKIP_BASE + 110 }] });
    const c = h.controller;
    c.setSnapPastCrap(true);
    const requestId = c._reviewRequestId;
    assert.equal(await driveRecordingSkip(h), false);
    assert.equal(c.clock.absoluteTime, SKIP_BASE);
    h.tick.value += 5000;
    assert.equal(await driveRecordingSkip(h), false);
    assert.equal(c.clock.absoluteTime, SKIP_BASE + 5);
    assert.equal(c.clock.running, true);
    assert.equal(c._reviewRequestId, requestId);
    assert.equal(c._recordingGapSkipSearch, null);
  });
}


test("Skip Deadspace white contract: hours of empty BLACK between events never jump to the next event", async t => {
  const when = { from: SKIP_BASE, to: SKIP_BASE + 14400 };
  const h = await createRecordingSkipHarness(t, { when, events: [
    { camera_id: "drive_up", start_time: SKIP_BASE, end_time: SKIP_BASE + 10 },
    { camera_id: "drive_up", start_time: SKIP_BASE + 10800, end_time: SKIP_BASE + 10820 }
  ], coverage: { drive_up: [{ start: SKIP_BASE, end: SKIP_BASE + 10 },
    { start: SKIP_BASE + 10800, end: SKIP_BASE + 10820 }], drive_down: [] } });
  const c = h.controller;
  c.setSnapPastCrap(true); c.setPlaybackSpeed(4);
  const origin = h.tick.value;
  for (const elapsed of [10, 3600, 7200, 10799]) {
    h.tick.value = origin + elapsed * 1000 / 4;
    assert.equal(await driveRecordingSkip(h), false);
    assert.equal(c.clock.absoluteTime, SKIP_BASE + elapsed);
    assert.equal(c.clock.running, true);
    assert.equal(c._recordingGapSkipSearch, null);
  }
  assert.deepEqual(c.getRecentAutoSnapDecisions(), []);
});


test("Skip Deadspace white contract: WHITE PURPLE WHITE skips both whites and resumes BLACK", async t => {
  const h = await createRecordingSkipHarness(t, { debug: true, events: [
    { camera_id: "drive_up", start_time: SKIP_BASE + 10, end_time: SKIP_BASE + 100 },
    { camera_id: "drive_up", start_time: SKIP_BASE + 150, end_time: SKIP_BASE + 170 }
  ], coverage: { drive_up: [{ start: SKIP_BASE + 30, end: SKIP_BASE + 70 },
    { start: SKIP_BASE + 150, end: SKIP_BASE + 170 }], drive_down: [] } });
  const c = h.controller;
  assert.deepEqual(gapRanges(h, "drive_up"), [
    [SKIP_BASE + 10, SKIP_BASE + 30], [SKIP_BASE + 70, SKIP_BASE + 100]
  ]);
  await c.seekHistoricalToEpoch(SKIP_BASE + 10, { autoplay: true });
  c.setSnapPastCrap(true);
  assert.equal(await driveRecordingSkip(h), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 30);
  await waitForCondition(() => !c._historicalPreparing);
  h.tick.value += 10000;
  assert.equal(await driveRecordingSkip(h), false);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 40);
  h.tick.value += 30000;
  assert.equal(await driveRecordingSkip(h), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 100, "trailing white stops at the associated end, not the next event");
  await waitForCondition(() => !c._historicalPreparing);
  const requestId = c._reviewRequestId;
  h.tick.value += 1000;
  assert.equal(await driveRecordingSkip(h), false);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 101);
  assert.equal(c._reviewRequestId, requestId);
  assert.deepEqual(c.getRecentAutoSnapDecisions(), []);
});


test("Skip Deadspace white contract: staggered cameras play every recorded portion of one association", async t => {
  const h = await createRecordingSkipHarness(t, { events: [
    { camera_id: "drive_up", start_time: SKIP_BASE, end_time: SKIP_BASE + 100 }
  ], coverage: {
    drive_up: [{ start: SKIP_BASE + 10, end: SKIP_BASE + 20 },
      { start: SKIP_BASE + 30, end: SKIP_BASE + 40 }, { start: SKIP_BASE + 50, end: SKIP_BASE + 60 }],
    drive_down: [{ start: SKIP_BASE + 5, end: SKIP_BASE + 15 },
      { start: SKIP_BASE + 25, end: SKIP_BASE + 35 }, { start: SKIP_BASE + 45, end: SKIP_BASE + 55 }]
  } });
  const c = h.controller;
  c.setSnapPastCrap(true);
  for (const [from, to] of [[0, 5], [20, 25], [40, 45], [60, 100]]) {
    setReviewTi(c, SKIP_BASE + from);
    assert.equal(await driveRecordingSkip(h), true);
    assert.equal(c.clock.absoluteTime, SKIP_BASE + to);
    await waitForCondition(() => !c._historicalPreparing);
    assert.equal(await driveRecordingSkip(h), false, "recording or BLACK after the association prevents repeated seeks");
  }
  assert.deepEqual(c.getRecentAutoSnapDecisions(), []);
});


test("Skip Deadspace white contract: point and ongoing markers do not authorize a duration skip", async t => {
  const h = await createRecordingSkipHarness(t, { events: [
    { camera_id: "drive_up", start_time: SKIP_BASE, end_time: SKIP_BASE },
    { camera_id: "drive_down", start_time: SKIP_BASE, end_time: null }
  ], coverage: { drive_up: [{ start: SKIP_BASE + 20, end: SKIP_BASE + 40 }], drive_down: [] } });
  h.controller.setSnapPastCrap(true);
  assert.equal(await driveRecordingSkip(h), false);
  assert.equal(h.controller.clock.absoluteTime, SKIP_BASE);
});


test("Skip Deadspace white contract: a wholly WHITE association crosses windows but stops before BLACK", async t => {
  const end = SKIP_BASE + 7205;
  const h = await createRecordingSkipHarness(t, { when: { from: SKIP_BASE, to: end + 100 },
    events: [{ camera_id: "drive_up", start_time: SKIP_BASE, end_time: end }],
    coverage: { drive_up: [{ start: end + 5, end: end + 50 }], drive_down: [] }
  });
  const c = h.controller;
  c.setSnapPastCrap(true);
  assert.equal(await driveRecordingSkip(h), true);
  assert.equal(c.clock.absoluteTime, end);
  await waitForCondition(() => !c._historicalPreparing);
  h.tick.value += 1000;
  assert.equal(await driveRecordingSkip(h), false);
  assert.equal(c.clock.absoluteTime, end + 1);
  assert.equal(c.clock.running, true);
});


test("Skip Deadspace white contract: event time determines association bounds independently of viewport", async t => {
  const h = await createRecordingSkipHarness(t, { when: { from: SKIP_BASE, to: SKIP_BASE + 1000 }, events: [
    { camera_id: "drive_up", start_time: SKIP_BASE, end_time: SKIP_BASE + 400 }
  ], coverage: { drive_up: [{ start: SKIP_BASE + 100, end: SKIP_BASE + 200 }], drive_down: [] } });
  const c = h.controller;
  c.setTimelineViewport({ from: SKIP_BASE + 300, to: SKIP_BASE + 600 });
  c.setSnapPastCrap(true);
  assert.equal(await driveRecordingSkip(h), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 100);
  await waitForCondition(() => !c._historicalPreparing);
  setReviewTi(c, SKIP_BASE + 200);
  assert.equal(await driveRecordingSkip(h), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 400);
  await waitForCondition(() => !c._historicalPreparing);
});


test("Skip Deadspace white contract: intersections below the timeline tolerance are not WHITE duration", async t => {
  const target = SKIP_BASE + 19.9995;
  const h = await createRecordingSkipHarness(t, { events: [
    { camera_id: "drive_up", start_time: SKIP_BASE, end_time: SKIP_BASE + 20 }
  ], coverage: { drive_up: [{ start: SKIP_BASE, end: target },
    { start: SKIP_BASE + 30, end: SKIP_BASE + 50 }], drive_down: [] } });
  const c = h.controller;
  assert.deepEqual(gapRanges(h, "drive_up"), []);
  setReviewTi(c, target); c.setSnapPastCrap(true);
  assert.equal(await driveRecordingSkip(h), false);
  assert.equal(c.clock.absoluteTime, target);
});


for (const change of ["leaves association", "event inventory replaced", "displayed query mismatch"]) {
  test(`Skip Deadspace white contract: pending coverage cannot navigate after ${change}`, async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await createRecordingSkipHarness(t, { events: [
      { camera_id: "drive_up", start_time: SKIP_BASE, end_time: SKIP_BASE + 20 }
    ], coverage: { drive_up: [{ start: SKIP_BASE + 40, end: SKIP_BASE + 50 }], drive_down: [] },
    onRequest: message => message.camera === "drive_down" && message.end - message.start === 7200
      ? gate.then(() => ({ camera: message.camera, requested_start: message.start,
        requested_end: message.end, coverage: [] })) : undefined });
    const c = h.controller;
    c.setSnapPastCrap(true);
    assert.equal(c.evaluateRecordingGapSkip(), false);
    assert.ok(c._recordingGapSkipSearch);
    if (change === "leaves association") h.tick.value += 30000;
    if (change === "event inventory replaced") c._timeline.items = [];
    if (change === "displayed query mismatch") {
      c._displayedReviewQuery = { ...c._displayedReviewQuery,
        range: { from: SKIP_BASE + 1, to: SKIP_BASE + 200 } };
    }
    const before = c.clock.absoluteTime;
    const requestId = c._reviewRequestId;
    release(); await settleCoverage();
    assert.equal(await driveRecordingSkip(h), false);
    assert.equal(c.clock.absoluteTime, before);
    assert.equal(c._reviewRequestId, requestId);
    assert.equal(c._recordingGapSkipSearch, null);
    assert.equal(c.clock.running, true);
  });
}


test("Skip Deadspace diagnosis: sparse events never skip continuous recording across availability windows", async t => {
  const when = { from: SKIP_BASE, to: SKIP_BASE + 14400 };
  const h = await createRecordingSkipHarness(t, { when, coverage: {
    drive_up: [{ start: when.from, end: when.to }], drive_down: []
  }, events: [
    { camera_id: "drive_up", start_time: SKIP_BASE + 900, end_time: SKIP_BASE + 920 },
    { camera_id: "drive_up", start_time: SKIP_BASE + 12600, end_time: SKIP_BASE + 12620 }
  ] });
  const evaluate = await captureRecordingSkipEvaluation(h);
  const c = h.controller;
  const seeks = [];
  const seek = c.seekHistoricalToEpoch.bind(c);
  c.seekHistoricalToEpoch = (...args) => { seeks.push(args); return seek(...args); };
  c.getAutoSnapInventory = () => assert.fail("Skip Deadspace alone must never query event navigation");
  c.setPlaybackSpeed(4);
  const input = h.root.querySelector(".review-snap-past-crap");
  input.checked = true;
  input.dispatchEvent(new h.window.Event("change"));
  assert.deepEqual(c.getReviewOptions(), { autoSnapTo: false, snapPastCrap: true });
  const origin = h.tick.value;
  for (const elapsed of [0, 900, 920, 3600, 7199.5, 7200, 12600, 12620, 14399]) {
    h.tick.value = origin + elapsed * 1000 / 4;
    evaluate();
    await settleCoverage();
    assert.equal(c.clock.absoluteTime, SKIP_BASE + elapsed);
    assert.equal(c.clock.running, true);
    assert.equal(c._autoSnapArmed, false);
    assert.deepEqual(c._recordingCoverage.gapsFor("drive_up", when.from, when.to), []);
  }
  assert.deepEqual(seeks, []);
  assert.deepEqual(gapRanges(h, "drive_up"), []);
  assert.deepEqual(c.getRecentAutoSnapDecisions(), []);
});


for (const eventOverlapsGap of [false, true]) {
  test(`Skip Deadspace diagnosis: actual gap skips only with event overlap=${eventOverlapsGap}`, async t => {
    const when = { from: SKIP_BASE, to: SKIP_BASE + 14400 };
    const h = await createRecordingSkipHarness(t, { debug: true, when, coverage: {
      drive_up: [{ start: when.from, end: SKIP_BASE + 3600 },
        { start: SKIP_BASE + 3900, end: when.to }], drive_down: []
    }, events: [
      { camera_id: "drive_up", start_time: SKIP_BASE + 900, end_time: SKIP_BASE + 920 },
      { camera_id: "drive_up", start_time: SKIP_BASE + 12600, end_time: SKIP_BASE + 12620 },
      ...(eventOverlapsGap ? [{ camera_id: "drive_up", start_time: SKIP_BASE + 3500,
        end_time: SKIP_BASE + 4000 }] : [])
    ] });
    const evaluate = await captureRecordingSkipEvaluation(h);
    const c = h.controller;
    const seeks = [];
    const seek = c.seekHistoricalToEpoch.bind(c);
    c.seekHistoricalToEpoch = (target, options) => {
      seeks.push({ target, source: options.source }); return seek(target, options);
    };
    c.getAutoSnapInventory = () => assert.fail("Events must not select the next recording");
    c.setSnapPastCrap(true);
    assert.deepEqual(c._recordingCoverage.gapsFor("drive_up", when.from, when.to), [
      { start: SKIP_BASE + 3600, end: SKIP_BASE + 3900 }
    ]);
    assert.deepEqual(gapRanges(h, "drive_up"), eventOverlapsGap
      ? [[SKIP_BASE + 3600, SKIP_BASE + 3900]] : [], "white bars clip gaps to event markers");
    h.tick.value += 3599500;
    evaluate(); await settleCoverage();
    assert.equal(c.clock.absoluteTime, SKIP_BASE + 3599.5);
    assert.deepEqual(seeks, [], "covered time before the gap plays normally");
    h.tick.value += 500;
    evaluate();
    assert.equal(c.clock.absoluteTime, SKIP_BASE + (eventOverlapsGap ? 3900 : 3600));
    if (eventOverlapsGap) await waitForCondition(() => !c._historicalPreparing);
    h.tick.value += 500;
    evaluate(); await settleCoverage();
    assert.equal(c.clock.absoluteTime, SKIP_BASE + (eventOverlapsGap ? 3900.5 : 3600.5),
      "WHITE seeks to recording; BLACK advances nominally");
    assert.deepEqual(seeks, eventOverlapsGap
      ? [{ target: SKIP_BASE + 3900, source: "recording gap skip" }] : []);
    assert.equal(c.clock.running, true);
    assert.deepEqual(c.getRecentAutoSnapDecisions(), []);
  });
}


test("Skip Deadspace diagnosis: disabling armed Auto Snap retires its event boundary callback", async t => {
  const when = { from: SKIP_BASE, to: SKIP_BASE + 200 };
  const h = await createRecordingSkipHarness(t, { when, coverage: {
    drive_up: [{ start: when.from, end: when.to }], drive_down: []
  }, events: [
    { camera_id: "drive_up", start_time: SKIP_BASE, end_time: SKIP_BASE + 10 },
    { camera_id: "drive_up", start_time: SKIP_BASE + 150, end_time: SKIP_BASE + 160 }
  ] });
  const evaluate = await captureRecordingSkipEvaluation(h);
  const c = h.controller;
  c.pausePlayback();
  let boundary;
  const setTimeout = h.window.setTimeout.bind(h.window);
  h.window.setTimeout = (callback, delay, ...args) => {
    if (delay === 10000) boundary = callback;
    return setTimeout(callback, delay, ...args);
  };
  c.setAutoSnapTo(true); c.setSnapPastCrap(true); c.resumePlayback();
  assert.equal(c._autoSnapArmed, true);
  assert.equal(typeof boundary, "function");
  const input = h.root.querySelector(".review-auto-snap-to");
  input.checked = false;
  input.dispatchEvent(new h.window.Event("change"));
  const requestId = c._reviewRequestId;
  const decisionCount = c.getRecentAutoSnapDecisions().length;
  h.tick.value += 20000;
  boundary(); evaluate(); await settleCoverage();
  assert.deepEqual(c.getReviewOptions(), { autoSnapTo: false, snapPastCrap: true });
  assert.equal(c._autoSnapActiveEnd, null);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 20);
  assert.equal(c.clock.running, true);
  assert.equal(c._reviewRequestId, requestId);
  assert.equal(c.getRecentAutoSnapDecisions().length, decisionCount);
});


test("Snap Past Crap: planner distinguishes coverage, unknown, and half-open boundaries", () => {
  const answer = coverage => ({ requested_start: 0, requested_end: 7200, coverage });
  assert.deepEqual(planRecordingGapSkip([], 10, 100), { kind: "unknown" });
  assert.deepEqual(planRecordingGapSkip([answer([]), null], 10, 100), { kind: "unknown" });
  assert.deepEqual(planRecordingGapSkip([answer([{ start: 10, end: 20 }]), null], 10, 100),
    { kind: "covered" });
  assert.deepEqual(planRecordingGapSkip([answer([{ start: 0, end: 10 }, { start: 30, end: 40 }]),
    answer([{ start: 25, end: 35 }])], 10, 100), { kind: "recording", target: 25 });
  assert.deepEqual(planRecordingGapSkip([answer([{ start: 30, end: 40 }])], 10, 30),
    { kind: "empty", end: 30 });
  assert.deepEqual(planRecordingGapSkip([answer([])], 7200, 8000), { kind: "unknown" });
});


test("Snap Past Crap: UI setters are independent, paused, and legacy Views restore OFF", t => {
  const h = createHistoricalHarness();
  t.after(() => h.close());
  const c = h.controller;
  const before = c.reviewPosition;
  const gapInput = h.root.querySelector(".review-snap-past-crap");
  assert.equal(gapInput.checked, false);
  gapInput.checked = true;
  gapInput.dispatchEvent(new h.window.Event("change"));
  c.setAutoSnapTo(true);
  assert.deepEqual(c.getReviewOptions(), { autoSnapTo: true, snapPastCrap: true });
  c.setAutoSnapTo(false);
  assert.equal(c.getReviewOptions().snapPastCrap, true);
  c.setSnapPastCrap(false);
  assert.equal(c.getReviewOptions().autoSnapTo, false);
  assert.equal(c.reviewPosition, before);
  for (const autoSnapTo of [false, true]) for (const snapPastCrap of [false, true]) {
    c.setAutoSnapTo(autoSnapTo);
    c.setSnapPastCrap(snapPastCrap);
    const saved = c.captureReviewViewState();
    c.setSnapPastCrap(!snapPastCrap);
    assert.equal(c.restoreReviewView(saved).result, "restored");
    assert.deepEqual(c.getReviewOptions(), { autoSnapTo, snapPastCrap });
    assert.equal(h.root.querySelector(".review-snap-past-crap").checked, snapPastCrap);
  }
  const saved = c.captureReviewViewState();
  saved.options = { autoSnapTo: true };
  assert.equal(c.restoreReviewView(saved).result, "restored");
  assert.deepEqual(c.getReviewOptions(), { autoSnapTo: true, snapPastCrap: false });
  saved.options.snapPastCrap = "true";
  assert.equal(c.restoreReviewView(saved).result, "partial");
  assert.equal(c.getReviewOptions().snapPastCrap, false);
});


for (const autoSnap of [false, true]) for (const skip of [false, true]) {
  test(`Snap Past Crap: event=${autoSnap} gap=${skip} keeps independent navigation`, async t => {
    const h = await createRecordingSkipHarness(t, {
      coverage: { drive_up: [{ start: SKIP_BASE + 30, end: SKIP_BASE + 80 }], drive_down: [] },
      events: [{ camera_id: "drive_up", start_time: SKIP_BASE, end_time: SKIP_BASE + 100 }]
    });
    const c = h.controller;
    c.pausePlayback();
    c.setAutoSnapTo(autoSnap);
    c.setSnapPastCrap(skip);
    c.resumePlayback();
    assert.equal(c.clock.absoluteTime, SKIP_BASE, "event entry remains literal");
    assert.equal(await driveRecordingSkip(h), skip);
    assert.equal(c.clock.absoluteTime, SKIP_BASE + (skip ? 30 : 0));
    if (skip) await waitForCondition(() => !c._historicalPreparing);
    assert.equal(c.clock.running, true);
    assert.equal(c._autoSnapArmed, autoSnap);
    if (autoSnap) assert.equal(c._autoSnapActiveEnd, SKIP_BASE + 100);
  });
}


for (const speed of [1, 4]) {
  test(`Snap Past Crap: staggered coverage picks any camera's earliest start at ${speed}x`, async t => {
    const h = await createRecordingSkipHarness(t, { coverage: {
      drive_up: [{ start: SKIP_BASE + 60, end: SKIP_BASE + 100 }],
      drive_down: [{ start: SKIP_BASE + 20, end: SKIP_BASE + 50 }]
    } });
    const c = h.controller;
    const originalWindows = [...c._historicalPlayers.values()].map(p => p.availability);
    c.setPlaybackSpeed(speed);
    c.setSnapPastCrap(true);
    assert.equal(await driveRecordingSkip(h), true);
    assert.equal(c.clock.absoluteTime, SKIP_BASE + 20);
    await waitForCondition(() => !c._historicalPreparing);
    assert.equal(c.clock.rate, speed);
    assert.equal(c.clock.running, true);
    assert.ok([...c._historicalPlayers.values()].every((p, index) => p.availability === originalWindows[index]),
      "lookahead does not replace active availability windows");
    assert.equal(await driveRecordingSkip(h), false, "one covered camera prevents repeated navigation");
    h.tick.value += 1000;
    assert.equal(c.clock.absoluteTime, SKIP_BASE + 20 + speed);
  });
}


test("Snap Past Crap: one selected camera skips a short gap using timeline evidence without another lookup", async t => {
  const h = await createRecordingSkipHarness(t, { coverage: {
    drive_up: [{ start: SKIP_BASE, end: SKIP_BASE + 10 }, { start: SKIP_BASE + 12, end: SKIP_BASE + 100 }]
  } });
  const c = h.controller;
  c.setSelectedCameraNames(["Drive Up"]);
  await c.flushScheduledReviewQuery();
  await c.playHistorical(SKIP_BASE + 10, { playbackRange: h.when, updateDisplayedRange: false });
  await settleCoverage();
  c.setSnapPastCrap(true);
  const before = h.calls.filter(call => call.type === "frigate_max/v1/recordings/availability").length;
  assert.equal(c.evaluateRecordingGapSkip(), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 12);
  await waitForCondition(() => !c._historicalPreparing);
  assert.equal(h.calls.filter(call => call.type === "frigate_max/v1/recordings/availability").length, before);
});


for (const destination of [7200, 14420, 28820]) {
  test(`Snap Past Crap: long gap reaches ${destination}s across two-hour windows`, async t => {
    const h = await createRecordingSkipHarness(t, {
      when: { from: SKIP_BASE, to: SKIP_BASE + destination + 100 },
      coverage: { drive_up: [], drive_down: [{ start: SKIP_BASE + destination, end: SKIP_BASE + destination + 50 }] }
    });
    h.controller.setSnapPastCrap(true);
    assert.equal(await driveRecordingSkip(h), true);
    assert.equal(h.controller.clock.absoluteTime, SKIP_BASE + destination);
    await waitForCondition(() => !h.controller._historicalPreparing);
    assert.ok(h.calls.filter(call => call.type === "frigate_max/v1/recordings/availability")
      .every(call => call.end - call.start <= 7200));
  });
}


for (const state of ["pending", "failed", "malformed", "mismatched", "wrong-camera", "out-of-window"]) {
  test(`Snap Past Crap: ${state} coverage is unknown and keeps the clock advancing`, async t => {
    const h = await createRecordingSkipHarness(t, {
      coverage: { drive_up: [{ start: SKIP_BASE + 20, end: SKIP_BASE + 50 }], drive_down: [] },
      onRequest: message => {
        if (message.camera !== "drive_down" || message.end - message.start !== 7200) return;
        if (state === "pending") return new Promise(() => {});
        if (state === "failed") return Promise.reject(new Error("synthetic"));
        if (state === "malformed") return Promise.resolve({});
        return Promise.resolve({ camera: state === "wrong-camera" ? "wrong" : message.camera,
          requested_start: state === "out-of-window" ? message.start + 7200 : message.start,
          requested_end: message.end + (state === "out-of-window" ? 7200 : state === "mismatched" ? 1 : 0),
          coverage: [] });
      }
    });
    h.controller.setSnapPastCrap(true);
    assert.equal(await driveRecordingSkip(h), false);
    assert.equal(h.controller.clock.absoluteTime, SKIP_BASE);
    h.tick.value += 1000;
    assert.equal(h.controller.clock.absoluteTime, SKIP_BASE + 1);
    assert.equal(h.controller.clock.running, true);
  });
}


test("Snap Past Crap: covered acquisition failure and held frames do not become recording gaps", async t => {
  const h = await createRecordingSkipHarness(t, { unavailable: new Set(["drive_up"]),
    coverage: { drive_up: [{ start: SKIP_BASE, end: SKIP_BASE + 100 }], drive_down: [] } });
  const c = h.controller;
  const up = c._historicalPlayers.get("Drive Up");
  assert.notEqual(up.lifecycleState, "participating");
  up.holdStartedAtMs = 0;
  c.setSnapPastCrap(true);
  assert.equal(await driveRecordingSkip(h), false);
  assert.equal(c.clock.absoluteTime, SKIP_BASE);
});


test("Snap Past Crap: missing mapping and no selected cameras never authorize a skip", async t => {
  const h = await createRecordingSkipHarness(t, { coverage: {
    drive_up: [{ start: SKIP_BASE + 20, end: SKIP_BASE + 50 }], drive_down: [] } });
  const c = h.controller;
  c.setSnapPastCrap(true);
  delete c._hass.states["camera.drive_down"].attributes.camera_name;
  assert.equal(c.evaluateRecordingGapSkip(), false);
  c._selectedCameraNames = [];
  assert.equal(c.evaluateRecordingGapSkip(), false);
  assert.equal(c.clock.absoluteTime, SKIP_BASE);
});


test("Snap Past Crap: empty events are visited literally, tails complete, and gaps stay inside merged events", async t => {
  const h = await createRecordingSkipHarness(t, { events: [
    { camera_id: "drive_up", start_time: SKIP_BASE + 10, end_time: SKIP_BASE + 11 },
    { camera_id: "drive_up", start_time: SKIP_BASE + 30, end_time: SKIP_BASE + 60 },
    { camera_id: "drive_down", start_time: SKIP_BASE + 50, end_time: SKIP_BASE + 90 },
    { camera_id: "drive_up", start_time: SKIP_BASE + 120, end_time: SKIP_BASE + 140 }
  ], coverage: { drive_up: [{ start: SKIP_BASE + 55, end: SKIP_BASE + 70 },
    { start: SKIP_BASE + 120, end: SKIP_BASE + 140 }], drive_down: [] } });
  const c = h.controller;
  c.pausePlayback(); c.setAutoSnapTo(true); c.setSnapPastCrap(true); c.resumePlayback();
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 10);
  await waitForCondition(() => !c._historicalPreparing);
  assert.equal(await driveRecordingSkip(h), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 30, "the next event enters at its literal start");
  assert.equal(c._autoSnapActiveEnd, SKIP_BASE + 90, "overlapping event intervals remain merged");
  await waitForCondition(() => !c._historicalPreparing);
  assert.equal(await driveRecordingSkip(h), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 55);
  await waitForCondition(() => !c._historicalPreparing);
  setReviewTi(c, SKIP_BASE + 70);
  assert.equal(await driveRecordingSkip(h), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 120, "empty tail completes before the next event is chosen");
  await waitForCondition(() => !c._historicalPreparing);
  const visits = c.getRecentAutoSnapDecisions().filter(d => d.outcome === "advanced").reverse().map(d => d.targetEpoch);
  assert.deepEqual(visits, [SKIP_BASE + 10, SKIP_BASE + 30, SKIP_BASE + 120]);
});


test("Snap Past Crap: recording exactly at event end belongs to the next event", async t => {
  const h = await createRecordingSkipHarness(t, { events: [
    { camera_id: "drive_up", start_time: SKIP_BASE, end_time: SKIP_BASE + 20 },
    { camera_id: "drive_up", start_time: SKIP_BASE + 40, end_time: SKIP_BASE + 60 }
  ], coverage: { drive_up: [{ start: SKIP_BASE + 20, end: SKIP_BASE + 60 }], drive_down: [] } });
  const c = h.controller;
  c.pausePlayback(); c.setAutoSnapTo(true); c.setSnapPastCrap(true); c.resumePlayback();
  assert.equal(await driveRecordingSkip(h), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 40);
  assert.equal(prepareTargets(h).includes(SKIP_BASE + 20), false);
});


for (const supersession of ["Pause", "manual seek", "selection", "option", "event option", "View", "Live", "teardown"]) {
  test(`Snap Past Crap: ${supersession} retires pending search authority`, async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await createRecordingSkipHarness(t, {
      coverage: { drive_up: [{ start: SKIP_BASE + 20, end: SKIP_BASE + 120 }], drive_down: [] },
      onRequest: message => message.camera === "drive_down" && message.end - message.start === 7200
        ? gate.then(() => ({ camera: message.camera, requested_start: message.start,
          requested_end: message.end, coverage: [] })) : undefined
    });
    const c = h.controller;
    c.setSnapPastCrap(true);
    assert.equal(c.evaluateRecordingGapSkip(), false);
    const search = c._recordingGapSkipSearch;
    assert.ok(search);
    if (supersession === "Pause") c.pausePlayback();
    // The seek joins the held shared lookup; it retires the search synchronously.
    const seek = supersession === "manual seek"
      ? c.seekHistoricalToEpoch(SKIP_BASE + 80, { autoplay: true }) : null;
    if (supersession === "selection") c.setSelectedCameraNames(["Drive Up"]);
    if (supersession === "option") c.setSnapPastCrap(false);
    if (supersession === "event option") c.setAutoSnapTo(true);
    if (supersession === "View") c.restoreReviewView(c.captureReviewViewState());
    if (supersession === "Live") c.returnToLive();
    if (supersession === "teardown") c.deactivate();
    const position = c.reviewPosition;
    assert.notStrictEqual(c._recordingGapSkipSearch, search);
    release();
    if (seek) assert.equal(await seek, true);
    await settleCoverage();
    assert.equal(c.reviewPosition, position, "settling a lookup never navigates on its own");
    assert.equal(c.evaluateRecordingGapSkip(), false);
    assert.equal(c.reviewPosition, position);
  });
}


test("Snap Past Crap: clock overtakes pending destination without a backward navigation", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await createRecordingSkipHarness(t, {
    coverage: { drive_up: [{ start: SKIP_BASE + 20, end: SKIP_BASE + 100 }], drive_down: [] },
    onRequest: message => message.camera === "drive_down" && message.end - message.start === 7200
      ? gate.then(() => ({ camera: message.camera, requested_start: message.start,
        requested_end: message.end, coverage: [] })) : undefined
  });
  const c = h.controller;
  c.setPlaybackSpeed(4); c.setSnapPastCrap(true);
  assert.equal(c.evaluateRecordingGapSkip(), false);
  h.tick.value += 10000;
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 40);
  release(); await settleCoverage();
  assert.equal(await driveRecordingSkip(h), false);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 40);
});


test("Snap Past Crap: repeated evaluations and reordered responses commit exactly one seek", async t => {
  const pending = [];
  const h = await createRecordingSkipHarness(t, { onRequest: message => {
    if (message.end - message.start !== 7200) return;
    return new Promise(resolve => pending.push({ message, resolve }));
  } });
  const c = h.controller;
  c.setSnapPastCrap(true);
  let seeks = 0;
  const seek = c.seekHistoricalToEpoch.bind(c);
  c.seekHistoricalToEpoch = (...args) => { seeks += 1; return seek(...args); };
  for (let i = 0; i < 10; i++) assert.equal(c.evaluateRecordingGapSkip(), false);
  assert.equal(pending.length, 2, "deduplicated shared timeline/skip requests");
  const down = pending.find(job => job.message.camera === "drive_down");
  down.resolve({ camera: down.message.camera, requested_start: down.message.start,
    requested_end: down.message.end, coverage: [{ start: SKIP_BASE + 10, end: SKIP_BASE + 100 }] });
  await settleCoverage();
  assert.equal(c.evaluateRecordingGapSkip(), false, "unknown peer could have earlier recording");
  const up = pending.find(job => job.message.camera === "drive_up");
  up.resolve({ camera: up.message.camera, requested_start: up.message.start,
    requested_end: up.message.end, coverage: [{ start: SKIP_BASE + 30, end: SKIP_BASE + 100 }] });
  await settleCoverage();
  assert.equal(c.evaluateRecordingGapSkip(), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 10);
  await waitForCondition(() => !c._historicalPreparing);
  for (let i = 0; i < 10; i++) c.evaluateRecordingGapSkip();
  assert.equal(seeks, 1);
});


test("Snap Past Crap: event boundary proceeds while lookahead is pending", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await createRecordingSkipHarness(t, { events: [
    { camera_id: "drive_up", start_time: SKIP_BASE, end_time: SKIP_BASE + 20 },
    { camera_id: "drive_up", start_time: SKIP_BASE + 40, end_time: SKIP_BASE + 80 }
  ], coverage: { drive_up: [{ start: SKIP_BASE + 50, end: SKIP_BASE + 80 }], drive_down: [] },
  onRequest: message => message.end - message.start === 7200
    ? gate.then(() => ({ camera: message.camera, requested_start: message.start,
      requested_end: message.end, coverage: [] })) : undefined });
  const c = h.controller;
  c.pausePlayback(); c.setAutoSnapTo(true); c.setSnapPastCrap(true); c.resumePlayback();
  assert.equal(c.evaluateRecordingGapSkip(), false);
  const oldSearch = c._recordingGapSkipSearch;
  setReviewTi(c, SKIP_BASE + 20);
  assert.equal(c.enforceAutoSnapBoundary(), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 40);
  assert.notStrictEqual(c._recordingGapSkipSearch, oldSearch);
  release(); await settleCoverage();
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 40);
  await waitForCondition(() => !c._historicalPreparing);
});


test("Snap Past Crap: shared cache bounds canceled requests and ignores failed retained evidence", async () => {
  let wall = SKIP_BASE + 10000;
  const pending = [];
  let active = 0;
  let peak = 0;
  const cache = new RecordingCoverageCache({ now: () => wall,
    request: (camera, start, end) => {
      active += 1; peak = Math.max(peak, active);
      return new Promise((resolve, reject) => pending.push({ camera, start, end,
        resolve: coverage => { active -= 1; resolve({ camera, requested_start: start, requested_end: end, coverage }); },
        reject: () => { active -= 1; reject(new Error("synthetic")); } }));
    } });
  cache.requirePlaybackWindows(["a", "b", "c", "d"], SKIP_BASE);
  assert.equal(pending.length, 3);
  cache.clearPlaybackDemand();
  cache.requirePlaybackWindows(["a", "b", "c", "d"], SKIP_BASE + 7200);
  assert.equal(pending.length, 3, "canceled physical requests still occupy slots");
  pending[0].resolve([]);
  await settleCoverage();
  assert.equal(pending.length, 4);
  assert.equal(peak, 3);
  assert.ok(cache.availabilityAt("a", SKIP_BASE));
  // A partial window expires under the existing 60-second policy.
  const partial = pending[3];
  partial.resolve([]); await settleCoverage();
  wall += 61;
  assert.equal(cache.availabilityAt(partial.camera, SKIP_BASE + 7200), null);
  cache.requirePlaybackWindows([partial.camera], SKIP_BASE + 7200);
  const draining = pending.slice(1).filter(job => job !== partial);
  for (const job of draining) job.reject();
  await settleCoverage();
  const retry = pending.findLast(job => job.camera === partial.camera);
  retry.reject(); await settleCoverage();
  assert.equal(cache.availabilityAt(partial.camera, SKIP_BASE + 7200), null,
    "retained old shading cannot authorize skips after refresh failure");
});


test("Snap Past Crap: a long confirmed prefix survives ordinary cache eviction", async t => {
  const h = await createRecordingSkipHarness(t, {
    when: { from: SKIP_BASE, to: SKIP_BASE + 28850 },
    coverage: { drive_up: [{ start: SKIP_BASE + 28820, end: SKIP_BASE + 28850 }], drive_down: [] }
  });
  const c = h.controller;
  c.setSnapPastCrap(true);
  assert.equal(c.evaluateRecordingGapSkip(), false, "only two cached windows examined per slice");
  assert.equal(c._recordingGapSkipSearch.cursor, SKIP_BASE + 14400);
  for (const camera of ["drive_up", "drive_down"]) {
    c._recordingCoverage._entries.delete(c._recordingCoverage.key(camera, SKIP_BASE));
  }
  assert.equal(await driveRecordingSkip(h), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 28820);
});


test("Snap Past Crap: BLACK before investigation end and unpublished horizon continue normally", async t => {
  const h = await createRecordingSkipHarness(t, { events: [] });
  const c = h.controller;
  c.setSnapPastCrap(true);
  assert.equal(await driveRecordingSkip(h), false);
  h.tick.value += 200000;
  assert.equal(c.enforceHistoricalPlaybackBoundary(), true);
  assert.equal(c.clock.absoluteTime, h.when.to);
  assert.equal(c.clock.running, false);
  const future = await createRecordingSkipHarness(t, {
    when: { from: SKIP_BASE, to: SKIP_BASE + 1000 }, wallClockMs: (SKIP_BASE + 50) * 1000
  });
  future.controller.setSnapPastCrap(true);
  assert.equal(await driveRecordingSkip(future), false, "unpublished tail remains unknown");
  assert.equal(future.controller.clock.running, true);
  future.tick.value += 50000;
  assert.equal(future.controller.enforceHistoricalPlaybackBoundary(), true);
  assert.equal(future.controller.state.presentationMode, "live");
});


test("Snap Past Crap: deliberate skip retains bounded preparation, hidden status, and current speed", async t => {
  const deferredFrame = new Set();
  const deadlines = manualInitialDeadlines();
  const h = await createRecordingSkipHarness(t, { deferredFrame, preparationTimeoutMs: 1500,
    scheduleInitialDeadline: deadlines.schedule.bind(deadlines), coverage: {
      drive_up: [{ start: SKIP_BASE + 20, end: SKIP_BASE + 80 }], drive_down: [] }
  });
  const c = h.controller;
  c.setPlaybackSpeed(4); c.setSnapPastCrap(true);
  deferredFrame.add("Drive Up");
  assert.equal(await driveRecordingSkip(h), true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 20);
  assert.equal(c.clock.running, false);
  assert.ok(c._playbackPreparation);
  assert.equal(c.evaluateRecordingGapSkip(), false, "no second skip during preparation");
  await waitForCondition(() => h.mediaControls.some(control => control.camera === "Drive Up"));
  const up = c._historicalPlayers.get("Drive Up");
  assert.equal(up.statusElement.hidden, true);
  const indicator = h.root.querySelector('.review-camera-panel[data-camera="Drive Up"] .review-camera-presentation-kind');
  assert.equal(indicator.textContent, "");
  assert.equal(indicator.hidden, true);
  h.tick.value += 600;
  h.mediaControls.findLast(control => control.camera === "Drive Up").emitFrame();
  await waitForCondition(() => !c._historicalPreparing);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 20);
  assert.equal(c.clock.running, true);
  assert.equal(c.clock.rate, 4);
  assert.equal(c._playbackPreparation, null);
  assert.equal(indicator.textContent, "");
  assert.equal(indicator.hidden, true);
  h.tick.value += 1000;
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 24);
});


test("Snap Past Crap: existing 500 ms evaluation performs the navigation", async t => {
  const h = await createRecordingSkipHarness(t, { coverage: {
    drive_up: [{ start: SKIP_BASE + 20, end: SKIP_BASE + 80 }], drive_down: [] } });
  let tick;
  const setInterval = h.window.setInterval.bind(h.window);
  h.window.setInterval = (callback, delay, ...args) => {
    if (delay === 500) tick = callback;
    return setInterval(callback, delay, ...args);
  };
  await h.controller.playHistorical(SKIP_BASE, { playbackRange: h.when, updateDisplayedRange: false });
  h.window.clearInterval(h.controller._diagnosticTimer);
  h.controller._diagnosticTimer = null;
  h.controller.setSnapPastCrap(true);
  assert.ok(tick);
  tick();
  assert.equal(h.controller.clock.absoluteTime, SKIP_BASE + 20);
  await waitForCondition(() => !h.controller._historicalPreparing);
});


test("Snap Past Crap: preparation timeout releases the clock after a committed skip", async t => {
  const deferredFrame = new Set(["Drive Up"]);
  const deadlines = manualInitialDeadlines();
  const h = await createRecordingSkipHarness(t, { deferredFrame, preparationTimeoutMs: 1500,
    scheduleInitialDeadline: deadlines.schedule.bind(deadlines), coverage: {
      drive_up: [{ start: SKIP_BASE + 20, end: SKIP_BASE + 80 }], drive_down: [] } });
  const c = h.controller;
  c.setSnapPastCrap(true); c.setPlaybackSpeed(4);
  assert.equal(await driveRecordingSkip(h), true);
  await waitForCondition(() => h.mediaControls.some(control => control.video.currentTimeWrites.length === 1));
  assert.equal(c.clock.running, false);
  h.tick.value += 1500;
  deadlines.jobs.find(job => job.active && job.delay === 1500).fire();
  assert.equal(c.clock.running, true);
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 20);
  h.tick.value += 1000;
  assert.equal(c.clock.absoluteTime, SKIP_BASE + 24);
  c.pausePlayback();
  assert.equal(c.evaluateRecordingGapSkip(), false);
});
