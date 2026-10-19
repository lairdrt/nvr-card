// Review R-12..R-20 recovery and isolation, short events and the Blackboard.
import assert from "node:assert/strict";
import test from "node:test";
import {
  readFileSync
} from "node:fs";
import {
  BLACKBOARD_CLOCK,
  BLACKBOARD_COVERAGE,
  BLACKBOARD_STATES
} from "../src/review/review-blackboard.js";
import {
  cameras,
  presentationPrepared,
  setReviewTi,
  createHistoricalHarness,
  recordingCoverageResponder,
  waitForCondition,
  createAvailabilityOwnershipHarness,
  track,
  assertPeerUndisturbed,
  manualInitialDeadlines,
  RECOVERY_TIMEOUT_MS,
  RECOVERY_T,
  RECOVERY_FULL_RUN,
  RECOVERY_FULL_COVERAGE,
  RECOVERY_REJOIN_COVERAGE,
  manualViewTimers,
  drainReview,
  createRecoveryScene,
  rejoinIntoLanding,
  failRejoinLanding,
  rejectPlayFor,
  STALL_MS,
  emitHlsError,
  playFor,
  expectPlaying,
  expectRecoveryAtReviewTime,
  observerEvidence,
  PHASE2_TIMELINE,
  OBSERVER_ENTRY_PATHS,
  FATAL_FAILURES,
  OBSERVATIONAL_ERRORS,
  injectRecorderFaults,
  heartbeatFor,
  availabilityCalls,
  falseGaps,
  playLive,
  liveEdgeScene,
  R12_RUN,
  SHORT_T,
  shortAutoSnapScene,
  heldFrame,
  board,
  bbReport,
  bbCamera,
  bbLine,
  bbState,
  bbVerdict,
  bbSetReviewTi,
  bbCameraBlock,
  bbPlay,
  BLACKBOARD_METHODS,
  throwingBlackboard,
  operationalTrace,
  blackboardAutoSnapScene,
  shortEventCounts
} from "./review-controller-test-support.js";

test("R-14 landing deadline: a gap rejoin without a presented frame fails only that camera", async t => {
  const scene = await createRecoveryScene(t);
  const { controller, timers } = scene;
  const down = scene.player("Drive Down");
  assert.equal(down.lifecycleState, "unavailable");
  const untouched = scene.peer();
  await rejoinIntoLanding(scene);
  const deadline = scene.landingDeadline("Drive Down");
  const media = scene.media("Drive Down");
  timers.fire(deadline);
  await waitForCondition(() => down.lifecycleState === "failed", "the landing attempt must settle");
  // A media failure inside recorded time is never presented as a recording gap.
  assert.notEqual(down.boundaryReason, "authoritative_recording_gap");
  assert.equal(controller.reviewCameraStatusIndicator(down), "Unavailable");
  const record = controller.getRecentReviewFailures().find(item =>
    item.camera === "Drive Down" && item.outcome === "failure");
  assert.equal(record.reason, "initial_landing_failed");
  assert.equal(record.coverage, "covered");
  assert.equal(down.continuationRecovery.attempts, 1);
  assert.equal(down.continuationRecovery.exhausted, false);
  assert.equal(down.continuationRecovery.nextEligibleAtMs, scene.time.ms + 1000);
  assert.equal(down.transition, null);
  assert.equal(down.hls, null);
  assert.equal(media.pendingFrameCallbacks().length, 0, "no RVFC callback survives the attempt");
  assert.equal(timers.pending().length, 0, "no landing timer survives the attempt");
  assert.equal(controller.clock.running, true);
  untouched();
});


test("R-13 recovery: a failed rejoin reacquires at the current Review time after its backoff", async t => {
  const scene = await createRecoveryScene(t);
  const { controller, timers } = scene;
  const untouched = scene.peer();
  const down = await failRejoinLanding(scene);
  scene.deferredFrame.delete("Drive Down");
  scene.advance(999);
  await scene.tick();
  assert.equal(scene.prepares("drive_down").length, 1, "the backoff holds the retry");
  assert.equal(down.lifecycleState, "failed");
  scene.advance(1);
  timers.heartbeat();
  await waitForCondition(() => down.lifecycleState === "participating" && down.video.paused === false,
    "the heartbeat must recover the camera");
  assert.equal(scene.prepares("drive_down").length, 2);
  // Drive Up's media still reports T; the Review clock alone chooses the rejoin time.
  assert.equal(scene.player("Drive Up").video.currentTime, 21);
  assert.equal(scene.prepares("drive_down").at(-1).target, RECOVERY_T + 7);
  assert.equal(down.initialPlacement.verifiedFrame, true);
  assert.equal(down.initialPlacement.landedEpoch, RECOVERY_T + 7);
  assert.equal(controller.clock.absoluteTime, RECOVERY_T + 7);
  assert.equal(down.continuationRecovery.attempts, 1, "recovery stays on probation");
  assert.equal(timers.pending().length, 0);
  untouched();
});


test("R-14 landing deadline: repeated unmappable frames at a coverage start cannot hold an explicit seek", async t => {
  const T = RECOVERY_T;
  const downRuns = [{ start: T - 1000, end: T + 10 }, { start: T + 20, end: T + 2000 }];
  const scene = await createRecoveryScene(t, {
    autoplay: false,
    coverage: { drive_up: RECOVERY_FULL_RUN, drive_down: downRuns },
    frameOffsetByCamera: new Map([["Drive Down", -0.021]]),
    presentationResponder: message => {
      if (message.camera !== "drive_down") {
        return Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target));
      }
      // As build_presentation_window: the logical start never precedes its coverage run.
      const run = downRuns.find(item => item.start <= message.target && message.target < item.end);
      return Promise.resolve(presentationPrepared(message.camera, message.target - 22, message.target,
        Math.min(run.end, message.target + 120), Math.max(run.start, message.target - 15)));
    }
  });
  const { controller, timers, harness } = scene;
  const up = scene.player("Drive Up");
  const down = scene.player("Drive Down");
  assert.equal(down.lifecycleState, "participating");
  const seek = track(controller.seekHistoricalToEpoch(T + 20, { autoplay: false }));
  await waitForCondition(() => down.reviewStage === "landing" && down.reviewLanding === "unmapped_frame",
    "the first frame lands 21 ms before the presentation's media start");
  const deadline = scene.landingDeadline("Drive Down");
  const media = scene.media("Drive Down");
  for (let index = 0; index < 3; index += 1) media.emitFrame();
  assert.equal(down.reviewLanding, "unmapped_frame");
  assert.deepEqual(timers.pending(RECOVERY_TIMEOUT_MS), [deadline],
    "unmappable frames neither extend nor re-arm the attempt's deadline");
  assert.equal(seek.settled, false);
  assert.equal(controller.state.historicalPreparing, true);
  // While the seek is held, any transport render disables relative seeking.
  controller.updateTransport();
  assert.equal(harness.transportRoot.querySelector(".review-back-ten").disabled, true);
  timers.fire(deadline);
  assert.equal(await seek.promise, true, "the explicit seek settles");
  assert.equal(controller.state.historicalPreparing, false);
  assert.equal(controller.clock.absoluteTime, T + 20);
  assert.equal(up.lifecycleState, "participating");
  assert.equal(up.initialPlacement.landedEpoch, T + 20);
  assert.equal(down.lifecycleState, "failed");
  assert.equal(controller.reviewCameraStatusIndicator(down), "Unavailable");
  assert.equal(down.continuationRecovery.attempts, 1);
  assert.equal(media.pendingFrameCallbacks().length, 0);
  assert.equal(timers.pending().length, 0);
  for (const selector of [".review-back-ten", ".review-forward-ten"]) {
    assert.equal(harness.transportRoot.querySelector(selector).disabled, false);
  }
  // Pause is authoritative: no automatic reacquisition while paused.
  const prepares = scene.prepares("drive_down").length;
  scene.advance(10000);
  await scene.tick();
  await scene.tick();
  assert.equal(scene.prepares("drive_down").length, prepares);
  assert.equal(down.lifecycleState, "failed");
});


test("R-14 landing deadline: VOD continuation without a frame fails, then recovers at current Review time", async t => {
  const T = RECOVERY_T;
  const counts = new Map();
  const scene = await createRecoveryScene(t, {
    coverage: RECOVERY_FULL_COVERAGE,
    presentationResponder: message => {
      const count = (counts.get(message.camera) ?? 0) + 1;
      counts.set(message.camera, count);
      const end = message.camera === "drive_up" && count === 1 ? T + 20 : message.target + 120;
      return Promise.resolve(presentationPrepared(message.camera, message.target - 21,
        message.target, end));
    }
  });
  const { timers } = scene;
  const up = scene.player("Drive Up");
  assert.equal(up.timing.logical_wall_end, T + 20);
  const untouched = scene.peer("Drive Down");
  scene.deferredFrame.add("Drive Up");
  scene.advance(20000);
  up.video.currentTime = up.timing.logical_media_end_position;
  timers.heartbeat();
  await waitForCondition(() => up.reviewStage === "landing" && scene.prepares("drive_up").length === 2,
    "the successor presentation must reach frame landing");
  timers.fire(scene.landingDeadline("Drive Up"));
  await waitForCondition(() => up.lifecycleState === "failed", "the successor landing must settle");
  assert.equal(up.continuationRecovery.attempts, 1);
  assert.equal(timers.pending().length, 0);
  scene.deferredFrame.delete("Drive Up");
  scene.advance(1000);
  timers.heartbeat();
  await waitForCondition(() => up.lifecycleState === "participating" && up.video.paused === false,
    "the continuation must recover");
  assert.equal(scene.prepares("drive_up").length, 3);
  assert.equal(scene.prepares("drive_up").at(-1).target, T + 21);
  assert.equal(up.initialPlacement.landedEpoch, T + 21);
  assert.equal(up.continuationRecovery.attempts, 1, "recovery stays on probation");
  assert.equal(timers.pending().length, 0);
  untouched();
});


test("R-14 explicit seek: one camera without frames settles within bounded landing deadlines", async t => {
  const T = RECOVERY_T;
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE, autoplay: false });
  const { controller, timers, harness } = scene;
  const up = scene.player("Drive Up");
  const down = scene.player("Drive Down");
  scene.deferredFrame.add("Drive Down");
  const seek = track(controller.seekHistoricalToEpoch(T + 30, { autoplay: false }));
  await waitForCondition(() => down.reviewStage === "landing" &&
    up.initialPlacement?.requestedEpoch === T + 30, "the reused presentation must reach landing");
  const back = harness.transportRoot.querySelector(".review-back-ten");
  // The reused presentation never presents a frame; neither does the fresh fallback.
  for (const attempt of [1, 2]) {
    const deadline = scene.landingDeadline("Drive Down");
    assert.equal(seek.settled, false);
    assert.equal(controller.state.historicalPreparing, true);
    // While the seek is held, any transport render disables relative seeking.
    controller.updateTransport();
    assert.equal(back.disabled, true);
    timers.fire(deadline);
    if (attempt === 1) {
      await waitForCondition(() => scene.prepares("drive_down").length === 2 &&
        down.reviewStage === "landing" && timers.pending(RECOVERY_TIMEOUT_MS).length === 1,
      "the explicit seek falls back to a fresh presentation");
    }
  }
  assert.equal(await seek.promise, true, "the explicit seek settles");
  assert.equal(controller.state.historicalPreparing, false);
  assert.equal(back.disabled, false);
  assert.equal(controller.clock.absoluteTime, T + 30);
  assert.equal(controller.clock.running, false);
  assert.equal(up.lifecycleState, "participating");
  assert.equal(up.initialPlacement.landedEpoch, T + 30);
  assert.equal(up.video.currentTimeWrites.length, 2, "the healthy camera seeks once for the operation");
  assert.equal(down.lifecycleState, "failed");
  assert.equal(down.continuationRecovery.attempts, 1);
  assert.equal(timers.pending().length, 0);
});


test("R-13 recovery: a camera retired by the initial landing deadline recovers while playback runs", async t => {
  const deadlines = manualInitialDeadlines();
  const scene = await createRecoveryScene(t, {
    coverage: RECOVERY_FULL_COVERAGE, awaitInitial: false, preparationTimeoutMs: 1500,
    deferredFrame: new Set(["Drive Down"]), scheduleInitialDeadline: deadlines.schedule.bind(deadlines)
  });
  const { timers } = scene;
  await waitForCondition(() => scene.player("Drive Up")?.lifecycleState === "participating" &&
    scene.player("Drive Down")?.reviewStage === "landing", "initial acquisition must reach landing");
  deadlines.jobs.find(job => job.active && job.delay === 1500).fire();
  deadlines.fireActive();
  await scene.run;
  const down = scene.player("Drive Down");
  assert.equal(down.lifecycleState, "failed");
  assert.equal(down.boundaryReason, "initial_landing_deadline");
  assert.equal(down.continuationRecovery.attempts, 1);
  assert.equal(timers.pending().length, 0, "the retired landing released its deadline");
  const untouched = scene.peer();
  scene.deferredFrame.delete("Drive Down");
  scene.advance(1000);
  timers.heartbeat();
  await waitForCondition(() => down.lifecycleState === "participating" && down.video.paused === false,
    "the initially failed camera must recover");
  assert.equal(scene.prepares("drive_down").at(-1).target, RECOVERY_T + 1);
  assert.equal(down.initialPlacement.landedEpoch, RECOVERY_T + 1);
  untouched();
});


test("R-13 recovery: obsolete initial availability work cannot hold or disturb a recovered camera", async t => {
  const deadlines = manualInitialDeadlines();
  const answer = recordingCoverageResponder(RECOVERY_FULL_COVERAGE);
  let releaseInitial = null;
  const scene = await createRecoveryScene(t, {
    awaitInitial: false, preparationTimeoutMs: 1500,
    scheduleInitialDeadline: deadlines.schedule.bind(deadlines),
    availabilityResponder: message => {
      if (message.camera !== "drive_down" || releaseInitial) return answer(message);
      return new Promise(resolve => { releaseInitial = () => resolve(answer(message)); });
    }
  });
  const { harness, timers } = scene;
  await waitForCondition(() => scene.player("Drive Up")?.lifecycleState === "participating" &&
    releaseInitial !== null, "the initial availability request must be in flight");
  deadlines.jobs.find(job => job.active && job.delay === 1500).fire();
  deadlines.fireActive();
  await scene.run;
  const down = scene.player("Drive Down");
  assert.equal(down.boundaryReason, "initial_availability_deadline");
  assert.equal(down.continuationRecovery.attempts, 1);
  scene.advance(1000);
  timers.heartbeat();
  await waitForCondition(() => down.lifecycleState === "participating" && down.video.paused === false,
    "recovery must not wait on the retired initial request");
  const hls = down.hls;
  releaseInitial();
  await drainReview(scene.controller);
  assert.equal(scene.prepares("drive_down").length, 1, "the obsolete initial work never acquires");
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/recordings/availability" &&
    call.camera === "drive_down").length, 2);
  assert.ok(down.hls === hls, "the recovered presentation is retained");
  assert.equal(down.lifecycleState, "participating");
});


test("R-13 recovery: a manifest failure during rejoin recovers after backoff", async t => {
  const scene = await createRecoveryScene(t);
  const { controller, timers } = scene;
  const Base = scene.harness.instances[0].constructor;
  let failManifest = true;
  controller._loadHls = async () => class extends Base {
    loadSource(source) {
      const camera = this.video?.closest(".review-camera-panel")?.dataset.camera;
      if (!failManifest || camera !== "Drive Down") return super.loadSource(source);
      this.source = source;
      for (const handler of [...(this.handlers.get(Base.Events.ERROR) ?? [])]) {
        handler(Base.Events.ERROR, { fatal: true, type: "networkError", details: "manifestLoadError" });
      }
    }
  };
  const down = scene.player("Drive Down");
  const untouched = scene.peer();
  scene.advance(6000);
  timers.heartbeat();
  await waitForCondition(() => down.lifecycleState === "failed", "the manifest failure must settle");
  assert.equal(down.boundaryReason, "manifest_failure");
  assert.equal(down.continuationRecovery.attempts, 1);
  failManifest = false;
  scene.advance(1000);
  timers.heartbeat();
  await waitForCondition(() => down.lifecycleState === "participating" && down.video.paused === false,
    "the manifest failure must recover");
  assert.equal(scene.prepares("drive_down").at(-1).target, RECOVERY_T + 7);
  assert.equal(down.continuationRecovery.attempts, 1, "recovery stays on probation");
  untouched();
});


test("R-13 recovery: rejoin Play rejection recovers after backoff", async t => {
  let rejecting = true;
  const scene = await createRecoveryScene(t, {
    playResponder: rejectPlayFor("Drive Down", () => rejecting)
  });
  const { timers } = scene;
  const down = scene.player("Drive Down");
  const untouched = scene.peer();
  scene.advance(6000);
  timers.heartbeat();
  await waitForCondition(() => down.lifecycleState === "failed", "the rejected Play must settle");
  assert.equal(down.boundaryReason, "rejoin_play_rejected");
  assert.equal(down.continuationRecovery.attempts, 1);
  assert.equal(down.video.paused, true);
  rejecting = false;
  scene.advance(1000);
  timers.heartbeat();
  await waitForCondition(() => down.lifecycleState === "participating" && down.video.paused === false,
    "the rejected Play must recover");
  assert.equal(scene.prepares("drive_down").at(-1).target, RECOVERY_T + 7);
  untouched();
});


test("R-13 recovery: a rejected Play on Resume recovers the camera at the current Review time", async t => {
  let rejecting = true;
  const scene = await createRecoveryScene(t, {
    coverage: RECOVERY_FULL_COVERAGE, autoplay: false,
    playResponder: rejectPlayFor("Drive Down", () => rejecting)
  });
  const { controller, timers } = scene;
  const down = scene.player("Drive Down");
  assert.equal(controller.resumePlayback(), true);
  await waitForCondition(() => down.lifecycleState === "failed", "the rejected Play must settle");
  assert.equal(down.boundaryReason, "play_rejected");
  assert.equal(down.continuationRecovery.attempts, 1);
  const untouched = scene.peer();
  rejecting = false;
  scene.advance(1000);
  timers.heartbeat();
  await waitForCondition(() => down.lifecycleState === "participating" && down.video.paused === false,
    "the rejected Play must recover");
  assert.equal(scene.prepares("drive_down").at(-1).target, RECOVERY_T + 1);
  untouched();
});


test("R-14 cancellation: removing a camera during landing releases its deadline and frame callback", async t => {
  const scene = await createRecoveryScene(t);
  const { controller, timers } = scene;
  const untouched = scene.peer();
  await rejoinIntoLanding(scene);
  const deadline = scene.landingDeadline("Drive Down");
  const media = scene.media("Drive Down");
  // As D6: shrinking the layout retires Drive Down while Drive Up keeps playing.
  controller.setReviewLayout("1x1");
  assert.equal(controller._historicalPlayers.has("Drive Down"), false);
  assert.equal(deadline.active, false, "cancellation releases the landing deadline");
  assert.equal(media.pendingFrameCallbacks().length, 0, "cancellation releases the frame callback");
  deadline.callback();
  await drainReview(controller);
  assert.equal(scene.prepares("drive_down").length, 1);
  assert.equal(timers.pending(RECOVERY_TIMEOUT_MS).length, 0, "no media-readiness timer remains");
  untouched();
});


test("R-14 Pause: an ordinary rejoin landing still settles, and Resume recovers it", async t => {
  const scene = await createRecoveryScene(t);
  const { controller, timers } = scene;
  const down = await rejoinIntoLanding(scene);
  assert.equal(controller.pausePlayback(), true);
  assert.equal(down.lifecycleState, "preparing", "Pause keeps preparatory rejoin work");
  timers.fire(scene.landingDeadline("Drive Down"));
  await waitForCondition(() => down.lifecycleState === "failed", "the paused landing must settle");
  assert.equal(down.continuationRecovery.attempts, 1);
  scene.deferredFrame.delete("Drive Down");
  scene.advance(5000);
  await scene.tick();
  await scene.tick();
  assert.equal(scene.prepares("drive_down").length, 1, "no automatic retry while paused");
  assert.equal(controller.clock.running, false);
  assert.equal(controller.resumePlayback(), true);
  await waitForCondition(() => down.lifecycleState === "participating" && down.video.paused === false,
    "Resume must recover the camera");
  assert.equal(scene.prepares("drive_down").at(-1).target, RECOVERY_T + 6,
    "Resume recovers at the paused Review time");
  assert.equal(controller.clock.running, true);
  assert.equal(timers.pending().length, 0);
});


test("R-14 Pause: an in-flight recovery landing is cancelled without consuming an attempt, and Resume retries", async t => {
  const scene = await createRecoveryScene(t);
  const { controller, timers } = scene;
  const down = await failRejoinLanding(scene);
  scene.advance(1000);
  timers.heartbeat();
  await waitForCondition(() => down.reviewStage === "landing" && down.lifecycleState === "preparing" &&
    scene.prepares("drive_down").length === 2, "the recovery attempt must reach landing");
  const deadline = scene.landingDeadline("Drive Down");
  const media = scene.media("Drive Down");
  assert.equal(controller.pausePlayback(), true);
  assert.equal(down.lifecycleState, "failed");
  assert.equal(down.transition, null);
  assert.equal(deadline.active, false);
  assert.equal(media.pendingFrameCallbacks().length, 0);
  assert.equal(down.continuationRecovery.attempts, 1, "cancelled work is not a failed attempt");
  scene.deferredFrame.delete("Drive Down");
  scene.advance(5000);
  await scene.tick();
  assert.equal(scene.prepares("drive_down").length, 2);
  assert.equal(controller.resumePlayback(), true);
  await waitForCondition(() => down.lifecycleState === "participating" && down.video.paused === false,
    "Resume must retry the cancelled recovery");
  assert.equal(scene.prepares("drive_down").length, 3);
  assert.equal(scene.prepares("drive_down").at(-1).target, RECOVERY_T + 7);
});


test("R-14 leaving Review: pending recovery and its landing leave no timer or later work", async t => {
  const scene = await createRecoveryScene(t);
  const { controller, timers, harness } = scene;
  const down = await failRejoinLanding(scene);
  scene.advance(1000);
  timers.heartbeat();
  await waitForCondition(() => down.reviewStage === "landing" && scene.prepares("drive_down").length === 2,
    "the recovery attempt must reach landing");
  const deadline = scene.landingDeadline("Drive Down");
  const media = scene.media("Drive Down");
  controller.returnToLive();
  assert.equal(controller._historicalPlayers.size, 0);
  assert.equal(timers.pending().length, 0, "no Review timeout survives leaving Review");
  assert.equal(timers.heartbeatActive(), false, "the heartbeat stops");
  assert.equal(media.pendingFrameCallbacks().length, 0);
  deadline.callback();
  const mediaCalls = () => harness.calls.filter(call => call.type.startsWith("frigate_max/")).length;
  const calls = mediaCalls();
  scene.advance(60000);
  await drainReview(controller);
  assert.equal(mediaCalls(), calls, "no recovery work runs after leaving Review");
});


test("R-14 explicit seek supersedes an in-flight recovery and its obsolete deadline", async t => {
  const scene = await createRecoveryScene(t);
  const { controller, timers } = scene;
  const down = await failRejoinLanding(scene);
  scene.advance(1000);
  timers.heartbeat();
  await waitForCondition(() => down.reviewStage === "landing" && scene.prepares("drive_down").length === 2,
    "the recovery attempt must reach landing");
  const stale = scene.landingDeadline("Drive Down");
  scene.deferredFrame.delete("Drive Down");
  const seek = controller.seekHistoricalToEpoch(RECOVERY_T + 40, { autoplay: false });
  assert.equal(stale.active, false, "the explicit seek cancels the obsolete landing");
  assert.equal(await seek, true);
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.initialPlacement.requestedEpoch, RECOVERY_T + 40);
  assert.equal(down.continuationRecovery, null);
  const hls = down.hls;
  stale.callback();
  await drainReview(controller);
  assert.equal(down.lifecycleState, "participating");
  assert.ok(down.hls === hls, "the recovered presentation is retained");
  assert.equal(timers.pending().length, 0);
});


test("R-15 recovery budget: backoff, exhaustion without retry storms, then a fresh explicit attempt", async t => {
  let rejecting = true;
  const scene = await createRecoveryScene(t, {
    playResponder: rejectPlayFor("Drive Down", () => rejecting)
  });
  const { controller, timers } = scene;
  const down = scene.player("Drive Down");
  const untouched = scene.peer();
  scene.advance(6000);
  timers.heartbeat();
  await waitForCondition(() => down.lifecycleState === "failed" &&
    down.continuationRecovery?.attempts === 1, "the first failure must be recorded");
  // [elapsed ms, attempts afterwards]: 1 s then 2 s backoff, three failures in total.
  for (const [ms, attempts] of [[999, 1], [1, 2], [1999, 2], [1, 3]]) {
    scene.advance(ms);
    // Several heartbeats inside one backoff window cannot add an attempt.
    await scene.tick();
    await scene.tick();
    await waitForCondition(() => down.lifecycleState === "failed" &&
      down.continuationRecovery?.attempts === attempts, `attempt ${attempts} must settle`);
    assert.equal(scene.prepares("drive_down").length, attempts);
    assert.equal(timers.pending().length, 0, "the policy owns no timer; the heartbeat schedules retries");
  }
  assert.equal(down.continuationRecovery.exhausted, true);
  for (let index = 0; index < 10; index += 1) {
    scene.advance(10000);
    await scene.tick();
  }
  assert.equal(scene.prepares("drive_down").length, 3, "an exhausted camera is not retried");
  assert.equal(down.lifecycleState, "failed");
  assert.equal(controller.reviewCameraStatusIndicator(down), "Unavailable");
  untouched();
  rejecting = false;
  assert.equal(await controller.seekHistoricalToEpoch(controller.clock.absoluteTime, {
    autoplay: true
  }), true);
  await waitForCondition(() => down.lifecycleState === "participating" && down.video.paused === false,
    "an explicit seek must start a fresh attempt");
  assert.equal(scene.prepares("drive_down").length, 4);
  assert.equal(down.continuationRecovery, null);
});


test("R-21 recovery eligibility: a presentation label cannot grant an acquisition retry", async t => {
  const scene = await createRecoveryScene(t, { playResponder: rejectPlayFor("Drive Down", () => true) });
  const down = scene.player("Drive Down");
  scene.advance(6000);
  scene.timers.heartbeat();
  await waitForCondition(() => down.lifecycleState === "failed", "the rejected Play must settle");
  down.boundaryReason = "availability_api_failure";
  await scene.tick();
  await scene.tick();
  assert.equal(scene.prepares("drive_down").length, 1, "the backoff, not the label, governs");
});


test("R-21 recovery eligibility: an availability failure retries without reading its label", async t => {
  const scene = await createAvailabilityOwnershipHarness(t);
  const { controller, base, outage, requests, up } = scene;
  outage.delete("drive_up");
  up.boundaryReason = "renamed_presentation_label";
  const attempt = track(controller.reconcileHistoricalCamera(up, base, { reason: "relabeled" }));
  assert.equal(requests.length, 1, "the failed availability query is retried");
  requests[0].succeed();
  assert.equal(await attempt.promise, "prepared");
  assert.equal(up.lifecycleState, "participating");
  assert.equal(up.continuationRecovery, null);
  assertPeerUndisturbed(scene);
});


test("R-15 recovery waits while the document is hidden and resumes when it can present frames", async t => {
  const scene = await createRecoveryScene(t);
  const { timers } = scene;
  let hidden = true;
  Object.defineProperty(scene.harness.window.document, "visibilityState", {
    configurable: true, get: () => hidden ? "hidden" : "visible"
  });
  const down = await failRejoinLanding(scene);
  scene.deferredFrame.delete("Drive Down");
  for (let index = 0; index < 5; index += 1) {
    scene.advance(2000);
    await scene.tick();
  }
  assert.equal(scene.prepares("drive_down").length, 1, "no reacquisition while frames cannot present");
  assert.equal(down.continuationRecovery.attempts, 1, "hidden time does not consume the budget");
  hidden = false;
  timers.heartbeat();
  await waitForCondition(() => down.lifecycleState === "participating" && down.video.paused === false,
    "the camera must recover once visible");
  assert.equal(scene.prepares("drive_down").at(-1).target, RECOVERY_T + 16);
});


for (const debug of [false, true]) {
  for (const failure of ["rejoin Play", "rejoin landing", "resume Play"]) {
    test(`R-14 diagnostic isolation: throwing recorders cannot strand a ${failure} failure or its recovery (debug=${debug})`, async t => {
      let rejecting = failure.endsWith("Play");
      const resume = failure === "resume Play";
      const scene = await createRecoveryScene(t, {
        debug, autoplay: !resume, coverage: resume ? RECOVERY_FULL_COVERAGE : RECOVERY_REJOIN_COVERAGE,
        playResponder: rejectPlayFor("Drive Down", () => rejecting)
      });
      const { controller, timers } = scene;
      const thrown = new Set();
      const fault = name => {
        thrown.add(name);
        throw new Error(`synthetic ${name} failure`);
      };
      controller.recordReviewFailure = () => fault("recordReviewFailure");
      controller.syncUnavailable = () => fault("syncUnavailable");
      const boundary = controller.recordCameraBoundary.bind(controller);
      controller.recordCameraBoundary = (player, kind, details) =>
        ["transition-started", "join-failed", "leave-complete"].includes(kind)
          ? fault(`recordCameraBoundary:${kind}`) : boundary(player, kind, details);
      const down = scene.player("Drive Down");
      if (resume) {
        assert.equal(controller.resumePlayback(), true);
      } else {
        if (failure === "rejoin landing") scene.deferredFrame.add("Drive Down");
        scene.advance(6000);
        timers.heartbeat();
        if (failure === "rejoin landing") {
          await waitForCondition(() => down.reviewStage === "landing", "the rejoin must reach landing");
          timers.fire(scene.landingDeadline("Drive Down"));
        }
      }
      await waitForCondition(() => down.lifecycleState === "failed", "failure handling must complete");
      assert.ok(thrown.has("recordReviewFailure"), "the failure recorder fault was exercised");
      assert.ok(thrown.has(resume ? "recordCameraBoundary:leave-complete" : "syncUnavailable"));
      assert.equal(down.transition, null);
      assert.equal(down.hls, null);
      assert.equal(down.continuationRecovery.attempts, 1);
      assert.equal(timers.pending().length, 0);
      const untouched = scene.peer();
      rejecting = false;
      scene.deferredFrame.delete("Drive Down");
      scene.advance(1000);
      timers.heartbeat();
      await waitForCondition(() => down.lifecycleState === "participating" && down.video.paused === false,
        "recovery must not depend on diagnostics");
      assert.ok(thrown.has("recordCameraBoundary:transition-started"));
      untouched();
    });
  }
}


for (const [label, enter] of Object.entries(OBSERVER_ENTRY_PATHS)) {
  test(`R-13 frame observer: armed and recording after ${label}`, async t => {
    const [scene, name] = await enter(t);
    assert.equal(scene.player(name).video.paused, false, `${name} plays`);
    assert.deepEqual(await observerEvidence(scene, name),
      { participating: true, armed: 1, recorded: true });
  });
}


test("R-13 held frame: a gap after a new-presentation seek holds a post-navigation frame", async t => {
  const T = RECOVERY_T;
  const runs = [{ start: T - 100, end: T + 10 }, { start: T + 30, end: T + 60 }];
  const scene = await createRecoveryScene(t, { coverage: { drive_up: RECOVERY_FULL_RUN, drive_down: runs },
    presentationResponder: message => {
      const run = message.camera === "drive_down"
        ? runs.find(item => item.start <= message.target && message.target < item.end) : null;
      return Promise.resolve(presentationPrepared(message.camera, message.target - 22, message.target,
        run ? Math.min(run.end, message.target + 120) : message.target + 120,
        run ? Math.max(run.start, message.target - 15) : message.target - 15));
    } });
  scene.harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  const { controller } = scene;
  const down = scene.player("Drive Down");
  scene.media("Drive Down").emitFrame();
  assert.equal(down.heldFrameEpoch, T, "a frame before navigation was captured");
  await controller.seekHistoricalToEpoch(T + 40, { autoplay: true });
  const media = scene.media("Drive Down");
  media.emitFrame(down.timing.logical_media_end_position - 1);
  const presented = down.latestPresentedFrameEpoch;
  assert.ok(presented > T + 40, "playback after navigation presented a frame");
  down.video.currentTime = down.timing.logical_media_end_position;
  scene.advance(20000);
  scene.timers.heartbeat();
  await drainReview(controller);
  assert.equal(down.lifecycleState, "unavailable");
  assert.equal(down.heldCanvas.hidden, false, "the gap holds a frame");
  assert.equal(down.heldFrameEpoch, presented, "the held frame is the latest presented frame");
});


test("R-13 held frame: a seek within the presentation never holds the pre-navigation frame", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  scene.harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  const { controller } = scene;
  const up = scene.player("Drive Up");
  scene.media("Drive Up").emitFrame();
  assert.equal(up.heldFrameEpoch, RECOVERY_T);
  assert.equal(await controller.seekHistoricalToEpoch(RECOVERY_T + 30, { autoplay: false }), true);
  controller.leaveHistoricalCamera(up, "authoritative_recording_gap", RECOVERY_T + 30);
  // Only the seek's own verified landing may be held, never the frame from before it.
  assert.equal(up.heldCanvas.hidden, false);
  assert.equal(up.heldFrameEpoch, RECOVERY_T + 30, "no frame from before the navigation is shown");
});


for (const [label, fail] of Object.entries(FATAL_FAILURES)) {
  test(`R-13 fatal media: ${label} rebuilds only that camera at current Review time`, async t => {
    const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
    const up = scene.player("Drive Up");
    const untouched = scene.peer("Drive Down");
    await playFor(scene, 2000);
    const hls = up.hls;
    fail(scene, up);
    fail(scene, up);
    assert.equal(hls.destroyCount, 0, "never destroyed inside its own dispatch");
    await Promise.resolve();
    assert.equal(up.lifecycleState, "failed");
    assert.equal(hls.destroyCount, 1);
    assert.equal(up.continuationRecovery.attempts, 1, "duplicate events consume one attempt");
    assert.equal(scene.controller.reviewCameraStatusIndicator(up), "Unavailable");
    await expectRecoveryAtReviewTime(scene, "Drive Up");
    untouched();
  });
}


for (const [label, emit] of Object.entries(OBSERVATIONAL_ERRORS)) {
  test(`R-13 fatal media: ${label} stays observational`, async t => {
    const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
    const untouched = scene.peer("Drive Up");
    emit(scene, scene.player("Drive Up"));
    await playFor(scene, 30000);
    untouched();
    assert.equal(scene.prepares("drive_up").length, 1);
  });
}


test("R-13 fatal media: a stale presentation's fatal error cannot fail its successor", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const up = scene.player("Drive Up");
  const oldHls = up.hls;
  const staleHandlers = [...oldHls.handlers.get(oldHls.constructor.Events.ERROR)];
  emitHlsError(up, { fatal: true, type: "networkError", details: "fragLoadError" });
  await Promise.resolve();
  await expectRecoveryAtReviewTime(scene, "Drive Up");
  const successor = up.hls;
  assert.ok(successor !== oldHls);
  for (const handler of staleHandlers) handler("error", { fatal: true, type: "networkError" });
  await Promise.resolve();
  await playFor(scene, 2000);
  assert.equal(up.lifecycleState, "participating");
  assert.ok(up.hls === successor, "the successor presentation is kept");
  assert.equal(up.continuationRecovery.attempts, 1, "no attempt was consumed");
});


for (const rate of [1, 4, 8]) {
  test(`R-13 stall: frames and media position frozen for 15 s rebuild only that camera at ${rate}x`, async t => {
    const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE, mediaReadyTimeoutMs: STALL_MS });
    scene.controller.setPlaybackSpeed(rate);
    const up = scene.player("Drive Up");
    const untouched = scene.peer("Drive Down");
    scene.stalled.add("Drive Up");
    await playFor(scene, 15000);
    assert.equal(up.lifecycleState, "participating", "14.5 s without progress is not a stall");
    await playFor(scene, 500);
    assert.equal(up.lifecycleState, "failed");
    assert.equal(up.boundaryReason, "media_stalled");
    assert.equal(up.continuationRecovery.attempts, 1);
    assert.equal(scene.controller.getRecentReviewFailures().find(record =>
      record.camera === "Drive Up" && record.reason === "media_stalled")?.coverage, "covered");
    scene.stalled.delete("Drive Up");
    await expectRecoveryAtReviewTime(scene, "Drive Up");
    untouched();
  });
}


test("R-13 stall: presented frames alone, or advancing media position alone, prove progress", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE, mediaReadyTimeoutMs: STALL_MS });
  const up = scene.player("Drive Up");
  const down = scene.player("Drive Down");
  const untouchedUp = scene.peer("Drive Up");
  // Drive Up presents frames at a frozen media position; Drive Down presents no frames
  // while its media position advances.
  scene.stalled.add("Drive Down");
  scene.deferredFrame.add("Drive Down");
  const downHls = down.hls;
  for (let elapsed = 0; elapsed < 60000; elapsed += 500) {
    down.video.currentTime += 0.5;
    scene.advance(500);
    await scene.tick();
  }
  untouchedUp();
  assert.equal(down.lifecycleState, "participating");
  assert.ok(down.hls === downHls);
  assert.equal(scene.prepares("drive_down").length, 1);
  assert.equal(up.presentedFrameCount > 100, true);
});


test("R-13 stall: Pause never stalls and Resume starts a fresh grace period", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE, mediaReadyTimeoutMs: STALL_MS });
  const { controller } = scene;
  const up = scene.player("Drive Up");
  scene.stalled.add("Drive Up");
  await playFor(scene, 10000);
  controller.pausePlayback();
  await playFor(scene, 60000);
  assert.equal(up.lifecycleState, "participating", "a paused camera is never stalled");
  controller.resumePlayback();
  // Grace begins at the first heartbeat after Resume's Play has settled.
  await drainReview(controller);
  await playFor(scene, 15000);
  assert.equal(up.lifecycleState, "participating", "Resume restarts the grace period");
  await playFor(scene, 500);
  assert.equal(up.boundaryReason, "media_stalled");
});


test("R-13 stall: a hidden document never stalls and its return starts a fresh grace period", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE, mediaReadyTimeoutMs: STALL_MS });
  let hidden = false;
  Object.defineProperty(scene.harness.window.document, "visibilityState", {
    configurable: true, get: () => hidden ? "hidden" : "visible"
  });
  const up = scene.player("Drive Up");
  scene.stalled.add("Drive Up");
  await playFor(scene, 10000);
  hidden = true;
  await playFor(scene, 60000);
  assert.equal(up.lifecycleState, "participating", "frames cannot be judged while hidden");
  hidden = false;
  await playFor(scene, 15000);
  assert.equal(up.lifecycleState, "participating", "returning restarts the grace period");
  await playFor(scene, 500);
  assert.equal(up.boundaryReason, "media_stalled");
});


test("R-13 stall: a frozen camera whose Review time reaches a recording gap leaves as a gap", async t => {
  const T = RECOVERY_T;
  const scene = await createRecoveryScene(t, { mediaReadyTimeoutMs: STALL_MS,
    coverage: { drive_up: [{ start: T - 100, end: T + 10 }], drive_down: RECOVERY_FULL_RUN } });
  const { controller } = scene;
  const up = scene.player("Drive Up");
  const untouched = scene.peer("Drive Down");
  scene.stalled.add("Drive Up");
  await playFor(scene, 15500);
  assert.equal(up.lifecycleState, "unavailable");
  assert.equal(up.boundaryReason, "authoritative_recording_gap");
  assert.equal(up.continuationRecovery, null, "a recording gap is not a media failure");
  assert.equal(controller.reviewCameraStatusIndicator(up), "No recording");
  untouched();
});


test("R-13 stall: logical presentation end and rejoin preparation are never stalls", async t => {
  const T = RECOVERY_T;
  const scene = await createRecoveryScene(t, { mediaReadyTimeoutMs: STALL_MS,
    harnessOptions: PHASE2_TIMELINE,
    presentationResponder: message => Promise.resolve(presentationPrepared(message.camera,
      message.target - 21, message.target, message.camera === "drive_up" ? T + 20 : message.target + 120)) });
  const { controller } = scene;
  const up = scene.player("Drive Up");
  // The investigation ends where this presentation ends: no continuation applies.
  controller._historicalPlaybackRange = { from: T - 100, to: T + 20 };
  scene.stalled.add("Drive Up");
  up.video.currentTime = up.timing.logical_media_end_position;
  // Drive Down rejoins and waits for a frame that never lands.
  const down = await rejoinIntoLanding(scene);
  await playFor(scene, 13000);
  assert.equal(up.lifecycleState, "participating", "the logical end belongs to boundary handling");
  assert.equal(down.lifecycleState, "preparing", "landing has its own deadline");
  assert.equal(controller.getRecentReviewFailures().some(record => record.reason === "media_stalled"), false);
});


test("R-15 outage: a stalled camera waits through an outage without rebuilding, then recovers", async t => {
  let outage = false;
  const answer = recordingCoverageResponder(RECOVERY_FULL_COVERAGE);
  const scene = await createRecoveryScene(t, { mediaReadyTimeoutMs: STALL_MS,
    availabilityResponder: message => outage ? Promise.reject(new Error("synthetic outage")) : answer(message),
    presentationResponder: message => outage ? Promise.reject(new Error("synthetic outage"))
      : Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target)) });
  const { harness } = scene;
  const up = scene.player("Drive Up");
  const untouched = scene.peer("Drive Down");
  const availabilityCalls = () => harness.calls.filter(call =>
    call.type === "frigate_max/v1/recordings/availability" && call.camera === "drive_up").length;
  scene.stalled.add("Drive Up");
  outage = true;
  await playFor(scene, 15500);
  assert.equal(up.boundaryReason, "media_stalled");
  scene.stalled.delete("Drive Up");
  const before = availabilityCalls();
  await playFor(scene, 30000);
  assert.equal(scene.prepares("drive_up").length, 1, "no presentation is rebuilt while unreachable");
  assert.ok(availabilityCalls() > before, "availability is rechecked");
  assert.equal(up.continuationRecovery.attempts, 1, "the outage consumes no media attempt");
  assert.equal(up.continuationRecovery.exhausted, false);
  outage = false;
  scene.advance(500);
  await scene.tick();
  const reviewTime = scene.controller.clock.absoluteTime;
  await expectPlaying(scene, "Drive Up", "connectivity return must recover without navigation");
  assert.equal(scene.prepares("drive_up").at(-1).target, reviewTime);
  untouched();
});


test("R-15 outage: a rejoin failing during an outage is not stranded once connectivity returns", async t => {
  let outage = false;
  const answer = recordingCoverageResponder(RECOVERY_REJOIN_COVERAGE);
  const scene = await createRecoveryScene(t, {
    availabilityResponder: message => outage ? Promise.reject(new Error("synthetic outage")) : answer(message),
    presentationResponder: message => outage ? Promise.reject(new Error("synthetic outage"))
      : Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target)) });
  const down = scene.player("Drive Down");
  const untouched = scene.peer("Drive Up");
  outage = true;
  scene.advance(6000);
  await scene.tick();
  await waitForCondition(() => down.lifecycleState === "failed", "the rejoin fails during the outage");
  await playFor(scene, 30000);
  assert.equal(down.continuationRecovery.exhausted, false, "the outage cannot exhaust the budget");
  outage = false;
  await playFor(scene, 1000);
  await expectPlaying(scene, "Drive Down", "connectivity return must recover without navigation");
  untouched();
});


test("R-15 probation: a camera that fails after every reacquisition cannot renew its budget", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const { controller } = scene;
  const up = scene.player("Drive Up");
  const untouched = scene.peer("Drive Down");
  for (let failure = 1; failure <= 3; failure += 1) {
    // What a detected stall or confirmed fatal error does to a playing camera.
    assert.equal(controller.leaveHistoricalCamera(up, "unexpected_media_end",
      controller.clock.absoluteTime, null, "failed"), true);
    controller.recordCameraAcquisitionFailure(up);
    assert.equal(up.continuationRecovery.attempts, failure);
    if (failure === 3) break;
    scene.advance(1000 * failure);
    await scene.tick();
    await expectPlaying(scene, "Drive Up", `reacquisition ${failure} must succeed`);
  }
  assert.equal(up.continuationRecovery.exhausted, true);
  await playFor(scene, 60000);
  assert.equal(up.lifecycleState, "failed", "an exhausted camera is not rebuilt endlessly");
  assert.equal(scene.prepares("drive_up").length, 3);
  untouched();
});


test("R-15 probation: fatal errors after every reacquisition stop at the budget", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const up = scene.player("Drive Up");
  for (let failure = 1; failure <= 3; failure += 1) {
    emitHlsError(up, { fatal: true, type: "networkError", details: "fragLoadError" });
    await Promise.resolve();
    assert.equal(up.continuationRecovery.attempts, failure);
    if (failure === 3) break;
    scene.advance(1000 * failure);
    await scene.tick();
    await expectPlaying(scene, "Drive Up", `reacquisition ${failure} must succeed`);
  }
  await playFor(scene, 60000);
  assert.equal(up.lifecycleState, "failed");
  assert.equal(scene.prepares("drive_up").length, 3);
});


test("R-15 probation: only 60 s of verified playback progress clears recovery history", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const { controller } = scene;
  const up = scene.player("Drive Up");
  emitHlsError(up, { fatal: true, type: "networkError", details: "fragLoadError" });
  await Promise.resolve();
  await expectRecoveryAtReviewTime(scene, "Drive Up");
  controller.pausePlayback();
  await playFor(scene, 120000);
  assert.equal(up.continuationRecovery?.attempts, 1, "paused wall time is not progress");
  controller.resumePlayback();
  await drainReview(controller);
  await playFor(scene, 60000);
  assert.equal(up.continuationRecovery?.attempts, 1, "59.5 s of credited progress is not enough");
  await playFor(scene, 500);
  assert.equal(up.continuationRecovery, null, "sustained progress clears the history");
});


for (const debug of [false, true]) {
  for (const failure of ["fatal error", "stall"]) {
    test(`R-13 diagnostic isolation: throwing recorders cannot strand a ${failure} or its recovery (debug=${debug})`, async t => {
      const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE, debug,
        mediaReadyTimeoutMs: STALL_MS });
      const { controller } = scene;
      const thrown = new Set();
      const fault = name => {
        thrown.add(name);
        throw new Error(`synthetic ${name} failure`);
      };
      controller.recordReviewFailure = () => fault("recordReviewFailure");
      controller.syncUnavailable = () => fault("syncUnavailable");
      const boundary = controller.recordCameraBoundary.bind(controller);
      controller.recordCameraBoundary = (player, kind, details) =>
        ["transition-started", "leave-complete", "held-frame-started", "held-frame-ended"].includes(kind)
          ? fault(`recordCameraBoundary:${kind}`) : boundary(player, kind, details);
      const up = scene.player("Drive Up");
      const untouched = scene.peer("Drive Down");
      if (failure === "stall") {
        scene.stalled.add("Drive Up");
        await playFor(scene, 15500);
        scene.stalled.delete("Drive Up");
      } else {
        emitHlsError(up, { fatal: true, type: "networkError", details: "fragLoadError" });
        await Promise.resolve();
      }
      assert.equal(up.lifecycleState, "failed");
      assert.equal(up.hls, null);
      assert.equal(up.continuationRecovery.attempts, 1);
      assert.ok(thrown.has("recordReviewFailure") && thrown.has("recordCameraBoundary:leave-complete"));
      await expectRecoveryAtReviewTime(scene, "Drive Up");
      assert.ok(thrown.has("recordCameraBoundary:transition-started"));
      untouched();
    });
  }
}


for (const debug of [false, true]) {
  for (const failure of ["stall", "fatal error"]) {
    test(`R-20 isolation: a throwing hold recorder cannot strand a ${failure} leave (debug=${debug})`, async t => {
      const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE, debug,
        mediaReadyTimeoutMs: STALL_MS });
      scene.harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
      const up = scene.player("Drive Up");
      const untouched = scene.peer("Drive Down");
      scene.media("Drive Up").emitFrame();
      const thrown = injectRecorderFaults(scene.controller);
      if (failure === "stall") {
        scene.stalled.add("Drive Up");
        await heartbeatFor(scene, 15500);
        scene.stalled.delete("Drive Up");
      } else {
        emitHlsError(up, { fatal: true, type: "networkError", details: "fragLoadError" });
        await Promise.resolve();
      }
      assert.ok(thrown.has("recordCameraBoundary"), "the hold recorder fault was exercised");
      assert.equal(up.lifecycleState, "failed");
      assert.equal(up.hls, null, "cleanup completed");
      assert.equal(up.heldCanvas.hidden, false, "the held frame is shown");
      assert.equal(up.continuationRecovery.attempts, 1, "recovery ownership was recorded");
      await expectRecoveryAtReviewTime(scene, "Drive Up");
      assert.equal(up.heldCanvas.hidden, true);
      untouched();
    });
  }

  test(`R-20 isolation: throwing Auto Snap recorders cannot stop interval completion or navigation (debug=${debug})`, async t => {
    const T = RECOVERY_T;
    const time = { ms: 1000 };
    const when = { from: T - 100, to: T + 500 };
    const harness = createHistoricalHarness({ now: () => time.ms, wallClockMs: (T + 3600) * 1000, debug,
      initialReviewRange: when, recordingCoverage: false,
      reviewEvents: [{ camera_id: "drive_up", start_time: T, end_time: T + 10 },
        { camera_id: "drive_up", start_time: T + 100, end_time: T + 110 }] });
    t.after(() => harness.close());
    const timers = manualViewTimers(harness.window);
    const controller = harness.controller;
    await controller.refreshReviewQuery();
    await controller.playHistorical(T + 1, { autoplay: false, updateDisplayedRange: false, playbackRange: when });
    controller.setAutoSnapTo(true);
    const thrown = injectRecorderFaults(controller);
    assert.equal(controller.resumePlayback(), true);
    await drainReview(controller);
    for (let index = 0; index < 20; index += 1) {
      time.ms += 500;
      timers.heartbeat();
      await drainReview(controller);
    }
    assert.ok(thrown.has("captureAutoSnapBoundary") && thrown.has("recordAutoSnapDecision"));
    assert.equal(controller._autoSnapActiveEnd, T + 110, "the next event became active");
    // Without completion the clock would run on through the gap after T + 10.
    assert.ok(controller.clock.absoluteTime >= T + 100 && controller.clock.absoluteTime < T + 110,
      "the clock completed the interval at its end and moved to the next event");
    assert.equal(controller.clock.running, true);
  });

  test(`R-20 isolation: throwing availability recorders cannot fail a refresh or rejoin (debug=${debug})`, async t => {
    const scene = await createRecoveryScene(t, { debug });
    const down = scene.player("Drive Down");
    const untouched = scene.peer("Drive Up");
    const thrown = injectRecorderFaults(scene.controller);
    // Force a real request, so the refreshed-answer recorders run.
    down.availability = null;
    scene.advance(6000);
    await scene.tick();
    await expectPlaying(scene, "Drive Down", "the rejoin must complete");
    assert.ok(thrown.has("updateAvailabilityDiagnostic"));
    assert.equal(down.continuationRecovery, null, "no availability or acquisition failure was recorded");
    untouched();
  });

  test(`R-20 isolation: a throwing lifecycle recorder cannot prevent a recording-gap leave (debug=${debug})`, async t => {
    const T = RECOVERY_T;
    const scene = await createRecoveryScene(t, { debug,
      coverage: { drive_up: [{ start: T - 100, end: T + 10 }], drive_down: RECOVERY_FULL_RUN } });
    const { controller } = scene;
    const up = scene.player("Drive Up");
    const untouched = scene.peer("Drive Down");
    const thrown = injectRecorderFaults(controller);
    // Review time and the camera's media both reach the camera's recording gap.
    up.video.currentTime = T + 12 - up.timing.effective_absolute_origin;
    setReviewTi(controller, T + 12);
    await heartbeatFor(scene, 500);
    assert.ok(thrown.has("recordReviewFailure"), "the gap ledger fault was exercised");
    assert.equal(up.lifecycleState, "unavailable");
    assert.equal(up.boundaryReason, "authoritative_recording_gap");
    assert.equal(up.hls, null);
    assert.equal(controller.reviewCameraStatusIndicator(up), "No recording");
    untouched();
  });

  test(`R-20 isolation: throwing acquisition stamps cannot mask a reported missing recording (debug=${debug})`, async t => {
    const scene = await createRecoveryScene(t, { debug,
      presentationResponder: message => message.camera === "drive_down"
        ? Promise.reject(new Error("No recording at requested time."))
        : Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target)) });
    const down = scene.player("Drive Down");
    const untouched = scene.peer("Drive Up");
    const thrown = injectRecorderFaults(scene.controller);
    scene.advance(6000);
    await scene.tick();
    await waitForCondition(() => down.lifecycleState === "unavailable" &&
      down.boundaryReason === "prepare_reported_no_recording", "the preparation's own outcome must apply");
    assert.ok(thrown.has("syncStage") || thrown.has("syncCamera"));
    assert.equal(down.continuationRecovery, null, "no media failure was invented");
    assert.equal(down.transition, null);
    untouched();
  });

  test(`R-20 isolation: throwing reports cannot prevent the initial playback release (debug=${debug})`, async t => {
    const harness = createHistoricalHarness({ now: () => 1000, debug });
    t.after(() => harness.close());
    const controller = harness.controller;
    const thrown = injectRecorderFaults(controller);
    await controller.playHistorical(RECOVERY_T);
    assert.ok(thrown.has("startSyncReport") && thrown.has("recordIdentityEvent"));
    for (const player of controller._historicalPlayers.values()) {
      assert.equal(player.lifecycleState, "participating");
      assert.equal(player.video.paused, false);
    }
    assert.equal(controller.clock.running, true);
    assert.equal(controller.clock.absoluteTime, RECOVERY_T);
    assert.equal(controller.state.historicalPreparing, false);
  });

  test(`R-20 isolation: throwing reports cannot prevent an explicit seek from settling (debug=${debug})`, async t => {
    const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE, debug });
    const { controller } = scene;
    const thrown = injectRecorderFaults(controller);
    assert.equal(await controller.seekHistoricalToEpoch(RECOVERY_T + 30, { autoplay: true }), true);
    assert.ok(thrown.has("startSyncReport") || thrown.has("endSyncReport"));
    assert.equal(controller.state.historicalPreparing, false);
    assert.equal(controller.clock.absoluteTime, RECOVERY_T + 30);
    assert.equal(controller.clock.running, true);
    for (const name of ["Drive Up", "Drive Down"]) {
      const player = scene.player(name);
      assert.equal(player.lifecycleState, "participating");
      assert.equal(player.initialPlacement.landedEpoch, RECOVERY_T + 30);
      assert.equal(player.video.paused, false);
    }
    await heartbeatFor(scene, 2000);
  });

  test(`R-20 isolation: throwing recorders cannot interrupt transition cleanup or supersession (debug=${debug})`, async t => {
    const scene = await createRecoveryScene(t, { debug });
    const { controller, timers, harness } = scene;
    const down = await rejoinIntoLanding(scene);
    const stale = scene.landingDeadline("Drive Down");
    const thrown = injectRecorderFaults(controller);
    scene.deferredFrame.delete("Drive Down");
    assert.equal(await controller.seekHistoricalToEpoch(RECOVERY_T + 40, { autoplay: false }), true);
    assert.equal(stale.active, false, "the superseded landing was cleaned up");
    assert.equal(down.lifecycleState, "participating");
    assert.equal(down.initialPlacement.requestedEpoch, RECOVERY_T + 40);
    const presentations = harness.instances.slice();
    controller.returnToLive();
    assert.ok(thrown.has("recordSceneEvent") || thrown.has("endSyncReport") ||
      thrown.has("recordIdentityEvent"));
    assert.equal(controller._historicalPlayers.size, 0);
    assert.ok(presentations.every(hls => hls.destroyCount >= 1), "every presentation was destroyed");
    assert.equal(timers.pending(RECOVERY_TIMEOUT_MS).length, 0);
    assert.equal(timers.heartbeatActive(), false);
  });
}


test("R-12 live edge: recordings published after the first fetch keep playing and are never gaps", async t => {
  const T = RECOVERY_T;
  const { scene, wall, published } = await liveEdgeScene(t, { wallStart: T + 300, runs: R12_RUN });
  const { controller, harness } = scene;
  for (const name of ["Drive Up", "Drive Down"]) {
    assert.equal(scene.player(name).lifecycleState, "participating");
  }
  // Five minutes at 1x: Review time passes everything published when the camera joined.
  await playLive(scene, wall, 300000, published);
  for (const name of ["Drive Up", "Drive Down"]) {
    const player = scene.player(name);
    assert.equal(player.lifecycleState, "participating", `${name} keeps playing recorded time`);
    assert.equal(controller.reviewCameraStatusIndicator(player), "");
    assert.ok(controller.cameraEpochFromMedia(player) > T + 290, "past the first fetch's published end");
  }
  assert.deepEqual(falseGaps(controller), [], "published recording is never reported missing");
  for (const camera of ["drive_up", "drive_down"]) {
    assert.ok(availabilityCalls(harness, camera).length <= 7,
      "open windows refresh on the cache's 60 s expiry, not every heartbeat");
  }
});


test("R-12 live edge: an explicit seek to newly published time acquires it", async t => {
  const T = RECOVERY_T;
  const { scene, wall, published } = await liveEdgeScene(t, { wallStart: T + 300, runs: R12_RUN });
  const { controller } = scene;
  controller.pausePlayback();
  wall.s += 600;
  published.s = wall.s - 10;
  assert.equal(await controller.seekHistoricalToEpoch(T + 700, { autoplay: false }), true);
  for (const name of ["Drive Up", "Drive Down"]) {
    const player = scene.player(name);
    assert.equal(player.lifecycleState, "participating", `${name} acquires the published time`);
    assert.equal(player.initialPlacement.landedEpoch, T + 700);
  }
  assert.deepEqual(falseGaps(controller), []);
});


test("R-12 unknown tail: a presentation ending past known coverage waits instead of reporting a gap", async t => {
  const T = RECOVERY_T;
  const counts = new Map();
  const { scene, wall, published } = await liveEdgeScene(t, { wallStart: T + 300, runs: R12_RUN,
    presentationResponder: message => {
      const count = (counts.get(message.camera) ?? 0) + 1;
      counts.set(message.camera, count);
      const end = message.camera === "drive_up" && count === 1 ? T + 310 : message.target + 120;
      return Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target, end));
    } });
  const { controller } = scene;
  const up = scene.player("Drive Up");
  wall.s += 30;
  published.s = wall.s - 10;
  // Drive Up reaches the end of its presentation, beyond the 90 s-margin known coverage.
  up.video.currentTime = up.timing.logical_media_end_position;
  setReviewTi(controller, T + 310);
  await scene.tick();
  await scene.tick();
  assert.equal(up.lifecycleState, "participating", "unknown coverage is never a gap");
  assert.equal(controller.reviewCameraStatusIndicator(up), "");
  assert.deepEqual(falseGaps(controller), []);
  assert.equal(scene.prepares("drive_up").length, 1);
  // Once the open window expires, the refreshed answer covers the boundary: continue.
  wall.s += 100;
  published.s = wall.s - 10;
  await scene.tick();
  await waitForCondition(() => scene.prepares("drive_up").length === 2 &&
    up.lifecycleState === "participating", "the presentation must continue once coverage is known");
  assert.ok(up.timing.logical_wall_end > T + 310);
  assert.deepEqual(falseGaps(controller), []);
});


test("R-25 one authority: timeline and playback agree on a real gap, and the camera rejoins after it", async t => {
  const T = RECOVERY_T;
  const runs = [{ start: T - 7200, end: T + 100 }, { start: T + 160, end: T + 7200 }];
  const { scene } = await liveEdgeScene(t, { wallStart: T + 4 * 3600, runs, recordingCoverage: true,
    published: { s: T + 4 * 3600 } });
  const { controller } = scene;
  const up = scene.player("Drive Up");
  up.video.currentTime = T + 105 - up.timing.effective_absolute_origin;
  setReviewTi(controller, T + 105);
  await scene.tick();
  assert.equal(up.lifecycleState, "unavailable");
  assert.equal(up.boundaryReason, "authoritative_recording_gap");
  assert.equal(controller.reviewCameraStatusIndicator(up), "No recording");
  // The timeline reads the very same answer playback acted on.
  assert.deepEqual(controller._recordingCoverage.gapsFor("drive_up", T, T + 300)
    .map(gap => [gap.start - T, gap.end - T]), [[100, 160]]);
  setReviewTi(controller, T + 165);
  await scene.tick();
  await waitForCondition(() => up.lifecycleState === "participating", "the camera must rejoin after the gap");
  assert.equal(up.initialPlacement.landedEpoch, T + 165);
});


test("R-25 one authority: timeline and playback requests for a window coalesce", async t => {
  const T = RECOVERY_T;
  const gates = new Map();
  const held = new Set([T + 7200, T + 14400]);
  const answer = recordingCoverageResponder(RECOVERY_FULL_COVERAGE);
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE, recordingCoverage: true,
    availabilityResponder: message => message.camera === "drive_up" && held.has(message.start)
      ? new Promise(resolve => gates.set(message.start, () => resolve(answer(message))))
      : answer(message) });
  const { controller, harness } = scene;
  const up = scene.player("Drive Up");
  const windowCalls = start => availabilityCalls(harness, "drive_up").filter(call => call.start === start).length;
  // Timeline first, playback joins.
  controller._recordingCoverage.want(["drive_up"], T + 7200, T + 14400);
  const joined = controller.ensureCameraAvailability(up, T + 7300, { reason: "coalesce" });
  await Promise.resolve();
  assert.equal(windowCalls(T + 7200), 1, "playback joins the pending timeline query");
  gates.get(T + 7200)();
  const first = await joined;
  assert.ok(first === controller._recordingCoverage.availabilityAt("drive_up", T + 7300),
    "playback holds the shared answer itself");
  // Playback first, the timeline does not repeat it.
  const pending = controller.ensureCameraAvailability(up, T + 14500, { reason: "coalesce" });
  await Promise.resolve();
  controller._recordingCoverage.want(["drive_up"], T + 14400, T + 21600);
  assert.equal(windowCalls(T + 14400), 1, "the timeline reuses the pending playback query");
  gates.get(T + 14400)();
  await pending;
  // A loaded answer is reused without any request.
  await controller.ensureCameraAvailability(up, T + 7400, { reason: "coalesce" });
  assert.equal(windowCalls(T + 7200), 1);
});


test("R-25 failure is not a gap: a failed shared query leaves coverage unknown and the camera unavailable, not missing", async t => {
  const T = RECOVERY_T;
  const recorded = [{ start: T - 7200, end: T + 4 * 7200 }];
  const answer = recordingCoverageResponder({ drive_up: recorded, drive_down: recorded });
  const scene = await createRecoveryScene(t, { recordingCoverage: true,
    availabilityResponder: message => message.camera === "drive_up" && message.start === T + 7200
      ? Promise.reject(new Error("synthetic availability failure")) : answer(message) });
  const { controller } = scene;
  controller._recordingCoverage.want(["drive_up"], T + 7200, T + 14400);
  await drainReview(controller);
  assert.deepEqual(controller._recordingCoverage.gapsFor("drive_up", T + 7200, T + 14400), [],
    "a failed query never draws a gap");
  assert.equal(await controller.seekHistoricalToEpoch(T + 7300, { autoplay: false }), true);
  const up = scene.player("Drive Up");
  assert.equal(up.lifecycleState, "failed");
  assert.equal(up.boundaryReason, "availability_api_failure");
  assert.equal(up.continuationRecovery.availabilityFailed, true, "kept eligible for a recheck");
  assert.equal(controller.reviewCameraStatusIndicator(up), "Unavailable");
  assert.deepEqual(falseGaps(controller), []);
});


test("R-25 forced refresh: recovery re-queries instead of reusing a fresh but stale shared answer", async t => {
  const T = RECOVERY_T;
  // Frigate lagged: at the first query only T + 150 was published inside the known window.
  const published = { s: T + 150 };
  const { scene, wall } = await liveEdgeScene(t, { wallStart: T + 300, runs: R12_RUN, published });
  const { controller, harness } = scene;
  const up = scene.player("Drive Up");
  setReviewTi(controller, T + 180);
  assert.equal(controller.leaveHistoricalCamera(up, "media_stalled", T + 180, null, "failed"), true);
  controller.recordCameraAcquisitionFailure(up);
  published.s = T + 290;
  const before = availabilityCalls(harness, "drive_up").length;
  scene.advance(1000);
  wall.s += 1;
  await scene.tick();
  await expectPlaying(scene, "Drive Up", "recovery must use a freshly queried answer");
  assert.equal(availabilityCalls(harness, "drive_up").length, before + 1, "one forced query");
  assert.equal(up.initialPlacement.landedEpoch, controller.clock.absoluteTime);
});


test("short-event hold: the event's verified landing is its only frame, and it was not observed", async t => {
  const scene = await shortAutoSnapScene(t);
  const { T, up } = scene;
  assert.equal(scene.earlierFrame, T + 50, "the frame observed before the event");
  assert.equal(up.lifecycleState, "participating");
  assert.equal(up.initialPlacement.verifiedFrame, true);
  assert.equal(up.initialPlacement.landedEpoch, T + 100);
  assert.ok(up.hls === scene.eventHls && up.heldFrameHls === null,
    "nothing this event presented has been observed yet");
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(up.initialPlacement))).sort(),
    ["cameraWorkId", "landedEpoch", "landedMediaTime", "offsetSeconds", "presentationId",
      "requestId", "requestedEpoch", "requestedMediaTime", "verifiedFrame"],
    "the placement serializes exactly as before");
});


test("short-event hold: a new-presentation Auto Snap transition holds the event's landing frame", async t => {
  const scene = await shortAutoSnapScene(t);
  const { T, c, up } = scene;
  await scene.leaveEvent();
  assert.equal(c.clock.absoluteTime, T + 1000);
  assert.equal(up.lifecycleState, "preparing", "the next event needs a new presentation");
  assert.ok(up.hls !== scene.eventHls);
  assert.equal(heldFrame(up), T + 100, "the cell holds the short event's frame, not black");
  assert.notEqual(heldFrame(up), scene.earlierFrame, "never the frame of an earlier seek");
  // The new presentation's own landing replaces the hold.
  scene.deferredFrame.delete("Drive Up");
  scene.media().emitFrame();
  await scene.settle();
  await waitForCondition(() => up.lifecycleState === "participating");
  assert.equal(up.initialPlacement.landedEpoch, T + 1000);
});


test("short-event hold: a recording-gap transition holds the event's landing frame", async t => {
  const T = SHORT_T;
  const scene = await shortAutoSnapScene(t, { nextCamera: "drive_down",
    upRuns: [{ start: T - 7200, end: T + 900 }, { start: T + 1100, end: T + 4 * 7200 }] });
  const { c, up } = scene;
  await scene.leaveEvent();
  assert.equal(c.clock.absoluteTime, T + 1000);
  assert.equal(up.lifecycleState, "unavailable");
  assert.equal(up.boundaryReason, "authoritative_recording_gap");
  assert.equal(c.reviewCameraStatusIndicator(up), "No recording");
  assert.equal(heldFrame(up), T + 100, "the gap holds the short event's frame, not black");
});


test("short-event hold: a camera without a verified landing never fabricates a hold", async t => {
  const scene = await shortAutoSnapScene(t, { noRvfc: new Set(["Drive Up"]) });
  const { T, up } = scene;
  assert.equal(up.initialPlacement.verifiedFrame, false);
  await scene.leaveEvent();
  assert.equal(scene.c.clock.absoluteTime, T + 1000);
  assert.equal(heldFrame(up), null, "nothing verified, so nothing is held");
  assert.equal(up.holdStartedAtMs ?? null, null);
});


test("short-event hold: a frame of an earlier presentation or an earlier seek is never held", async t => {
  const scene = await shortAutoSnapScene(t);
  const { T, c, up } = scene;
  const eventPlacement = up.initialPlacement;
  // Earlier seek: a same-presentation seek is pending, so the event landing no longer
  // describes the displayed frame.
  scene.deferredFrame.add("Drive Up");
  c.pausePlayback();
  const pending = c.seekHistoricalToEpoch(T + 150, { autoplay: false });
  await scene.settle();
  assert.ok(up.hls === scene.eventHls && up.initialPlacement === eventPlacement,
    "the reuse seek has not landed");
  c.holdHistoricalFrame(up, "probe");
  assert.equal(heldFrame(up), null, "the landing of an earlier seek is not held");
  scene.deferredFrame.delete("Drive Up");
  scene.media().emitFrame();
  assert.equal(await pending, true);
  assert.equal(up.initialPlacement.landedEpoch, T + 150);
  // Earlier presentation: a new presentation lands; the event's placement is not its own.
  assert.equal(await c.seekHistoricalToEpoch(T + 1000, { autoplay: false }), true);
  assert.ok(up.hls !== scene.eventHls);
  assert.equal(up.lifecycleState, "participating");
  const ownPlacement = up.initialPlacement;
  up.heldFrameHls = null;
  up.initialPlacement = eventPlacement;
  c.holdHistoricalFrame(up, "probe");
  assert.equal(heldFrame(up), null, "a placement of an earlier presentation is not held");
  up.initialPlacement = ownPlacement;
  c.holdHistoricalFrame(up, "probe");
  assert.equal(heldFrame(up), T + 1000, "the presentation's own landing is held");
});


test("short-event hold: a same-presentation Auto Snap seek keeps playing its own video", async t => {
  const scene = await shortAutoSnapScene(t, { next: 150 });
  const { T, c, up } = scene;
  await scene.leaveEvent();
  assert.equal(c.clock.absoluteTime, T + 150);
  assert.ok(up.hls === scene.eventHls, "the presentation is reused");
  assert.equal(heldFrame(up), null, "a reuse seek does not hold a frame");
  scene.deferredFrame.delete("Drive Up");
  scene.media().emitFrame();
  await scene.settle();
  assert.equal(up.lifecycleState, "participating");
  assert.ok(up.hls === scene.eventHls);
  assert.equal(up.initialPlacement.landedEpoch, T + 150);
});


// Near Live: coverage within 90 s of now is unknown. An explicit navigation there cannot
// keep a presentation positioned at the previous time; unknown is never a gap.
test("near Live: an explicit seek into unknown coverage releases the previous presentation", async t => {
  const T = RECOVERY_T;
  const { scene, wall, published } = await liveEdgeScene(t, { wallStart: T + 300, runs: R12_RUN });
  const { controller } = scene;
  wall.s = T + 1300;
  published.s = wall.s - 10;
  const before = Object.fromEntries(["Drive Up", "Drive Down"].map(name =>
    [name, scene.prepares(name === "Drive Up" ? "drive_up" : "drive_down").length]));
  assert.equal(await controller.seekHistoricalToEpoch(T + 1250, { autoplay: true }), true);
  assert.equal(controller.clock.running, true);
  for (const name of ["Drive Up", "Drive Down"]) {
    const player = scene.player(name);
    assert.equal(player.lifecycleState, "unavailable", `${name} cannot keep playing earlier time`);
    assert.equal(player.boundaryReason, "availability_unknown");
    assert.equal(player.hls, null);
    assert.equal(controller.reviewCameraStatusIndicator(player), "", "unknown is not No recording");
    assert.equal(player.message, "");
    assert.equal(player.continuationRecovery, null, "no recovery attempt is consumed");
    assert.notEqual(heldFrame(player), null, "the departing presentation's frame is held");
  }
  assert.deepEqual(falseGaps(controller), []);
  // Coverage at Review time becomes known once the cache's open window refreshes.
  wall.s += 200;
  published.s = wall.s - 10;
  await playLive(scene, wall, 1000, published);
  for (const [name, camera] of [["Drive Up", "drive_up"], ["Drive Down", "drive_down"]]) {
    const player = scene.player(name);
    await waitForCondition(() => player.lifecycleState === "participating", `${name} must rejoin`);
    assert.equal(scene.prepares(camera).length, before[name] + 1, `${name} joins once`);
    assert.ok(Math.abs(player.initialPlacement.landedEpoch - (T + 1250)) <= 2,
      `${name} joins at Review time`);
    assert.equal(player.continuationRecovery, null);
  }
  assert.deepEqual(falseGaps(controller), []);
});


test("near Live: Auto Snap into unknown coverage releases the camera, holds its event frame and rejoins", async t => {
  const T = SHORT_T;
  const scene = await shortAutoSnapScene(t, { wallS: T + 1030 });
  const { c, up, wall } = scene;
  await scene.leaveEvent();
  assert.equal(c.clock.absoluteTime, T + 1000);
  assert.equal(up.lifecycleState, "unavailable", "not playing the short event's time");
  assert.equal(up.boundaryReason, "availability_unknown");
  assert.equal(up.hls, null);
  assert.equal(c.reviewCameraStatusIndicator(up), "");
  assert.equal(up.continuationRecovery, null);
  assert.equal(heldFrame(up), T + 100, "the short event's frame is held, not black");
  assert.deepEqual(falseGaps(c), []);
  c.pausePlayback();
  wall.s += 200;
  scene.deferredFrame.clear();
  await c.evaluateHistoricalAvailability(c.clock.absoluteTime, { reason: "coverage_known" });
  await scene.settle();
  await waitForCondition(() => up.lifecycleState === "participating", "Drive Up must rejoin");
  assert.equal(up.initialPlacement.landedEpoch, c.clock.absoluteTime);
  assert.deepEqual(falseGaps(c), []);
});


test("Blackboard healthy multi-camera progression: verified presentation for both cameras", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  await bbPlay(scene, 60000);
  const report = bbReport(scene);
  assert.match(report, /^Session: HEALTHY$/m);
  assert.match(bbVerdict(report, "Drive Up"),
    /^- Drive Up: HEALTHY\n {4}Steady playback: HEALTHY - verified 100\.0% of steady expected playback; acquiring or held 0\.0% of observed expected time\n {4}Short events: no expected Auto Snap events$/);
  assert.match(bbVerdict(report, "Drive Down"), /^- Drive Down: HEALTHY\n/);
  assert.match(bbLine(report, "- Progression:"), /HEALTHY/);
  assert.match(report, /Status: RUNNING \(copied while the session is open\)/);
  assert.ok(bbState(scene, "Drive Up", "recorded", "verified") >= 59000);
  for (const name of ["Drive Up", "Drive Down"]) {
    const acquisitions = bbCamera(scene, name).acquisitions;
    assert.equal(acquisitions.attempted, 1, `${name}: the initial acquisition, begun before observation`);
    assert.equal(acquisitions.landed, 1);
    assert.equal(acquisitions.verified, 1);
  }
  assert.equal(board(scene).session.incidents.total, 0);
  assert.equal(board(scene).faults, 0);
  // Copying is read-only: the session continues and keeps accumulating.
  const before = board(scene).session.observation.ticks;
  await bbPlay(scene, 1000);
  assert.equal(board(scene).session.observation.ticks, before + 2);
});


test("Blackboard fatal media error then recovery: recorded as a recovered camera failure", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  await bbPlay(scene, 5000);
  const up = scene.player("Drive Up");
  emitHlsError(up, { fatal: true, type: "networkError", details: "fragLoadError" });
  await Promise.resolve();
  assert.equal(up.lifecycleState, "failed");
  await expectRecoveryAtReviewTime(scene, "Drive Up");
  await bbPlay(scene, 5000);
  const report = bbReport(scene);
  assert.match(bbVerdict(report, "Drive Up"),
    /^- Drive Up: PROBLEM DETECTED \(recovered\)\n {4}Steady playback: PROBLEM DETECTED \(recovered\) - 1 problem incident/);
  assert.match(bbVerdict(report, "Drive Down"), /^- Drive Down: HEALTHY/);
  assert.match(report, /^Session: PROBLEM DETECTED \(recovered\)$/m);
  assert.match(report, /Recovery: 1 episode\(s\): recovered 1, superseded 0, ended by gap 0, persistent 0/);
  assert.match(report, /Failures: hls_fatal 1 \| fatal media 1, stalls 0/);
  assert.match(report, /camera_failure \[problem\]: 1x/);
  assert.match(report, /#\d+ camera_failure Drive Up: recovered; trigger hls_fatal/);
  const acquisitions = bbCamera(scene, "Drive Up").acquisitions;
  assert.equal(acquisitions.byTrigger.recovery, 1, "the rebuild is an automatic recovery join");
});


test("Blackboard persistent failure with an exhausted budget stays unresolved, then persistent at exit", async t => {
  const scene = await createRecoveryScene(t, { playResponder: rejectPlayFor("Drive Down", () => true) });
  const { controller } = scene;
  const down = scene.player("Drive Down");
  scene.advance(6000);
  await scene.tick();
  await waitForCondition(() => down.continuationRecovery?.attempts === 1);
  for (const ms of [1000, 2000]) {
    scene.advance(ms);
    await scene.tick();
    await scene.tick();
  }
  await waitForCondition(() => down.continuationRecovery?.exhausted === true);
  await bbPlay(scene, 3000);
  let report = bbReport(scene);
  assert.match(bbVerdict(report, "Drive Down"), /^- Drive Down: PROBLEM DETECTED \(unresolved\)/);
  assert.match(bbVerdict(report, "Drive Down"), /recovery budget exhausted 1x/);
  assert.match(report, /Open now:\n {2}#\d+ camera_failure Drive Down: open; trigger \w*play_rejected;.* attempts 3; BUDGET EXHAUSTED/);
  assert.match(report, /^Session: PROBLEM DETECTED \(unresolved\)$/m);
  controller.returnToLive();
  report = bbReport(scene);
  assert.match(report, /Status: ENDED: RETURNED_TO_LIVE/);
  assert.match(report, /camera_failure Drive Down: persistent/);
  assert.equal(bbCamera(scene, "Drive Down").recovery.persistent, 1);
});


test("Blackboard gap versus unknown coverage: a confirmed gap is not a failure and unknown is never a gap", async t => {
  const T = RECOVERY_T;
  const runs = [{ start: T - 7200, end: T + 100 }, { start: T + 160, end: T + 7200 }];
  const { scene } = await liveEdgeScene(t, { wallStart: T + 4 * 3600, runs, recordingCoverage: true,
    published: { s: T + 4 * 3600 } });
  const { controller } = scene;
  const up = scene.player("Drive Up");
  up.video.currentTime = T + 105 - up.timing.effective_absolute_origin;
  bbSetReviewTi(controller, T + 105);
  await scene.tick();
  assert.equal(up.boundaryReason, "authoritative_recording_gap");
  for (let index = 0; index < 10; index += 1) {
    scene.advance(500);
    await scene.tick();
  }
  assert.ok(bbState(scene, "Drive Up", "gap", "held") + bbState(scene, "Drive Up", "gap", "empty") >= 4500);
  assert.ok(bbCamera(scene, "Drive Up").gapLeaves >= 1);
  assert.equal(board(scene).session.incidents.total, 0, "a confirmed gap is not an incident");
  const report = bbReport(scene);
  assert.match(bbCameraBlock(report, "Drive Up"),
    /Coverage at Review time \(wall, clock running or stopped\): recorded [^,]+, confirmed gap [1-9]/);
  assert.doesNotMatch(bbVerdict(report, "Drive Up"), /PROBLEM/);

  // Near Live: coverage inside the 90 s margin is unknown, never a gap or a failure.
  const near = await liveEdgeScene(t, { wallStart: T + 300, runs: R12_RUN });
  near.wall.s = T + 1300;
  near.published.s = near.wall.s - 10;
  assert.equal(await near.scene.controller.seekHistoricalToEpoch(T + 1250, { autoplay: true }), true);
  for (let index = 0; index < 10; index += 1) {
    near.scene.advance(500);
    await near.scene.tick();
  }
  const unknown = bbState(near.scene, "Drive Up", "unknown", "held") + bbState(near.scene, "Drive Up", "unknown", "empty");
  assert.ok(unknown >= 4500, "the released camera's time is unknown coverage");
  assert.equal(bbState(near.scene, "Drive Up", "gap", "held") + bbState(near.scene, "Drive Up", "gap", "empty"), 0);
  assert.equal(board(near.scene).session.incidents.total, 0);
  assert.doesNotMatch(bbVerdict(bbReport(near.scene), "Drive Up"), /PROBLEM/);
});


test("Blackboard Pause and Resume: paused time is attributed to the operator, never a stall or stuck", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const { controller } = scene;
  await bbPlay(scene, 5000);
  assert.equal(controller.pausePlayback(), true);
  for (let index = 0; index < 120; index += 1) {
    scene.advance(500);
    await scene.tick();
  }
  assert.equal(controller.resumePlayback(), true);
  await drainReview(controller);
  await bbPlay(scene, 5000);
  const session = board(scene).session;
  assert.ok(session.clock.pausedMs.operator >= 59000);
  assert.equal(session.clock.pausedMs.unexplained, 0);
  assert.equal(session.incidents.total, 0, "no freeze, stall or stuck incident while paused");
  assert.ok(bbState(scene, "Drive Up", "recorded", "paused", "stopped") >= 59000);
  assert.equal(bbState(scene, "Drive Up", "recorded", "paused", "running"), 0);
  assert.match(bbReport(scene), /^Session: HEALTHY$/m);
});


test("Blackboard Play intent with a stopped clock and no explanation is reported as stuck", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const { controller } = scene;
  await bbPlay(scene, 2000);
  // Simulated defect: the clock stops behind Review's back while Play is intended.
  controller.clock.pause();
  for (let index = 0; index < 70; index += 1) {
    scene.advance(500);
    await scene.tick();
  }
  let report = bbReport(scene);
  assert.match(report, /Status: STUCK/);
  assert.match(bbLine(report, "- Progression:"), /PROBLEM DETECTED \(unresolved\)/);
  controller.clock.start();
  await bbPlay(scene, 2000);
  report = bbReport(scene);
  assert.match(bbLine(report, "- Progression:"), /PROBLEM DETECTED \(recovered\) - 1 stuck episode/);
});


test("Blackboard Skip Deadspace and manual navigation are intentional jumps, not discontinuities", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const { controller } = scene;
  await bbPlay(scene, 3000);
  const from = controller.clock.absoluteTime;
  assert.equal(await controller.seekHistoricalToEpoch(from + 600,
    { autoplay: true, source: "recording gap skip" }), true);
  await bbPlay(scene, 3000);
  assert.equal(await controller.selectTimelineTime(RECOVERY_T + 1200, "timeline click", true), true);
  await bbPlay(scene, 3000);
  assert.equal(await controller.seekHistoricalToEpoch(RECOVERY_T + 1800, { autoplay: true }), true);
  await bbPlay(scene, 3000);
  const session = board(scene).session;
  assert.equal(session.clock.discontinuities, 0);
  assert.equal(session.skip.count, 1);
  assert.ok(Math.abs(session.skip.seconds - 600) < 1);
  for (const source of ["skip_deadspace", "timeline", "manual"]) {
    const counts = session.navigation.bySource[source];
    assert.equal(counts.requested, 1, source);
    assert.equal(counts.outcomes.settled_observed, 1, source);
    assert.equal(counts.landed, 1, `${source}: every acquisition landed`);
    assert.equal(counts.presented, 1, `${source}: and presented an advancing frame`);
  }
  const report = bbReport(scene);
  assert.match(report, /Skip Deadspace: 1 skips, 10m 0s skipped/);
  assert.match(report, /Unexplained clock discontinuities: 0/);
  assert.match(report, /RECENT NAVIGATION/);
});


test("Blackboard unexplained clock movement is a discontinuity incident", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const { controller } = scene;
  await bbPlay(scene, 2000);
  // Nothing in Review requested this jump.
  setReviewTi(controller, controller.clock.absoluteTime + 900);
  await bbPlay(scene, 1000);
  assert.equal(board(scene).session.clock.discontinuities, 1);
  assert.match(bbLine(bbReport(scene), "- Progression:"), /1 unexplained clock discontinuity/);
});


test("Blackboard clock/media divergence: frames still presented but media 20 s behind Review time", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  // playFor presents frames without advancing media: cameras fall behind the clock.
  await playFor(scene, 20000);
  const record = bbCamera(scene, "Drive Up");
  assert.ok(record.maxDrift >= 19, `drift ${record.maxDrift}`);
  assert.equal(record.incidentCounts.clock_media_divergence, 1);
  const report = bbReport(scene);
  assert.match(bbVerdict(report, "Drive Up"), /warnings: clock_media_divergence x1/);
  assert.match(report, /\|media - clock\|: .*>=15s/);
  // Healthy alignment never reports divergence.
  const healthy = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  await bbPlay(healthy, 20000);
  assert.equal(bbCamera(healthy, "Drive Up").incidentCounts.clock_media_divergence, undefined);
  assert.ok(bbCamera(healthy, "Drive Up").maxDrift < 0.6);
});


test("Blackboard hidden tab and late heartbeats are unobserved: no fabricated failure or success", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  await bbPlay(scene, 5000);
  let hidden = true;
  Object.defineProperty(scene.harness.window.document, "visibilityState", {
    configurable: true, get: () => hidden ? "hidden" : "visible"
  });
  // Hidden for 60 s: media keeps playing but no frame callbacks arrive (no rendering).
  await bbPlay(scene, 60000, { mediaOnly: ["Drive Up", "Drive Down"] });
  hidden = false;
  // One throttled heartbeat 30 s late (media kept playing), then normal playback.
  scene.advance(30000);
  for (const player of scene.controller._historicalPlayers.values()) player.video.currentTime += 30;
  await scene.tick();
  await bbPlay(scene, 10000);
  const session = board(scene).session;
  assert.ok(session.observation.hiddenMs >= 59000);
  assert.equal(session.observation.lateTicks, 1);
  assert.ok(session.observation.longestGapMs >= 30000);
  assert.equal(session.incidents.total, 0, "nothing judged across unobserved time");
  assert.ok(bbState(scene, "Drive Up", "recorded", "unobserved", "running") >= 89000);
  const report = bbReport(scene);
  assert.match(bbVerdict(report, "Drive Up"),
    /^- Drive Up: INCONCLUSIVE\n {4}Steady playback: INCONCLUSIVE - only \d+\.\d% of expected time was observable/);
  assert.match(report, /OBSERVATION GAPS/);
  assert.match(report, /late heartbeats 1/);
});


test("Blackboard missing presented-frame callbacks: media-only playback is never reported healthy", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  await bbPlay(scene, 30000, { mediaOnly: ["Drive Down"] });
  const down = scene.player("Drive Down");
  assert.equal(down.lifecycleState, "participating", "operational playback is unaffected");
  const report = bbReport(scene);
  assert.match(bbVerdict(report, "Drive Down"),
    /^- Drive Down: INCONCLUSIVE\n {4}Steady playback: INCONCLUSIVE - presented-frame evidence missing/);
  assert.match(bbVerdict(report, "Drive Down"), /frames_unconfirmed x1/);
  assert.match(bbVerdict(report, "Drive Up"), /^- Drive Up: HEALTHY/);
});


test("Blackboard frozen camera: an observational freeze before the operational stall deadline", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE, mediaReadyTimeoutMs: STALL_MS });
  await bbPlay(scene, 3000);
  await bbPlay(scene, 5000, { frozen: ["Drive Up"] });
  await bbPlay(scene, 3000);
  const record = bbCamera(scene, "Drive Up");
  assert.equal(record.incidentCounts.presentation_freeze, 1);
  assert.equal(scene.player("Drive Up").lifecycleState, "participating", "no operational decision was made");
  assert.match(bbReport(scene), /presentation_freeze Drive Up: resolved/);
});


test("Blackboard held frame and empty presentation during a recording gap", async t => {
  const T = RECOVERY_T;
  const runs = [{ start: T - 7200, end: T + 100 }, { start: T + 160, end: T + 7200 }];
  for (const retained of [true, false]) {
    const { scene } = await liveEdgeScene(t, { wallStart: T + 4 * 3600, runs, recordingCoverage: true,
      published: { s: T + 4 * 3600 } });
    // happy-dom shares element prototypes across windows: set, then restore, capture support.
    const prototype = scene.harness.window.HTMLCanvasElement.prototype;
    const original = prototype.getContext;
    t.after(() => { prototype.getContext = original; });
    prototype.getContext = retained ? () => ({ drawImage() {} }) : () => null;
    const { controller } = scene;
    const up = scene.player("Drive Up");
    up.video.currentTime = T + 105 - up.timing.effective_absolute_origin;
    bbSetReviewTi(controller, T + 105);
    await scene.tick();
    for (let index = 0; index < 10; index += 1) {
      scene.advance(500);
      await scene.tick();
    }
    const held = bbState(scene, "Drive Up", "gap", "held");
    const empty = bbState(scene, "Drive Up", "gap", "empty");
    if (retained) {
      assert.ok(held >= 4500 && empty === 0, `held ${held} empty ${empty}`);
      assert.equal(bbCamera(scene, "Drive Up").held, 1);
    } else {
      assert.ok(empty >= 4500 && held === 0, `held ${held} empty ${empty}`);
    }
  }
});


test("Blackboard session completion, early interruption and a new investigation", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const { controller } = scene;
  await bbPlay(scene, 2000);
  const first = board(scene).session.id;
  await controller.playHistorical(RECOVERY_T, { autoplay: true,
    playbackRange: { from: RECOVERY_T - 10, to: RECOVERY_T + 20 } });
  await drainReview(controller);
  assert.notEqual(board(scene).session.id, first, "a different range is a new investigation");
  assert.match(board(scene).previous, /^#\d+ ended \(new_investigation\)/);
  await bbPlay(scene, 25000);
  let report = bbReport(scene);
  assert.equal(controller.clock.running, false);
  assert.match(report, /Status: REACHED_END/);
  assert.match(report, /PREVIOUS SESSION/);
  // Re-placement inside the same investigation continues the same session.
  const id = board(scene).session.id;
  await controller.playHistorical(RECOVERY_T + 5, { autoplay: false,
    playbackRange: { from: RECOVERY_T - 10, to: RECOVERY_T + 20 }, source: "event snap next" });
  assert.equal(board(scene).session.id, id);
  assert.equal(board(scene).session.navigation.bySource.event_snap.requested, 1);
  controller.suspend();
  report = bbReport(scene);
  assert.match(report, /Status: ENDED: CARD_SUSPENDED/);
});


test("Blackboard Copy Diagnostics: one visible control, clipboard success and selectable fallback", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const { controller, harness } = scene;
  await bbPlay(scene, 5000);
  const buttons = harness.root.querySelectorAll(".review-copy-diagnostics");
  assert.equal(buttons.length, 1, "always present, without debug mode");
  assert.equal(buttons[0].textContent, "Copy diagnostics");
  const writes = [];
  Object.defineProperty(harness.window.navigator, "clipboard", { configurable: true,
    value: { writeText: text => { writes.push(text); return Promise.resolve(); } } });
  buttons[0].click();
  await waitForCondition(() => writes.length === 1);
  assert.match(writes[0], /^FrigateMax Review Blackboard report v1\nBuild: development/);
  assert.match(writes[0], /^Session: HEALTHY$/m);
  await waitForCondition(() => buttons[0].textContent === "Diagnostics copied");
  // Clipboard refused: a selectable read-only text fallback, playback undisturbed.
  Object.defineProperty(harness.window.navigator, "clipboard", { configurable: true,
    value: { writeText: () => Promise.reject(new Error("denied")) } });
  assert.equal(await controller.copyDiagnostics(), "fallback");
  const fallback = harness.root.querySelector(".review-diagnostics-fallback");
  assert.equal(fallback.hidden, false);
  assert.equal(fallback.readOnly, true);
  assert.match(fallback.value, /^FrigateMax Review Blackboard report v1/);
  Object.defineProperty(harness.window.navigator, "clipboard", { configurable: true, value: undefined });
  assert.equal(await controller.copyDiagnostics(), "fallback");
  const session = board(scene).session;
  assert.equal(session.status, "running", "copying never ends or resets the session");
  await bbPlay(scene, 2000);
  assert.equal(scene.player("Drive Up").lifecycleState, "participating");
  assert.match(bbReport(scene), /^Session: HEALTHY$/m);
});


test("Blackboard report sanitization: no provider mapping, URLs, paths or tokens", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  await bbPlay(scene, 3000);
  const up = scene.player("Drive Up");
  emitHlsError(up, { fatal: true, type: "networkError", details: "fragLoadError",
    response: { code: 403, url: "https://frigate.local/vod/drive_up/master.m3u8?authSig=SECRET" } });
  await Promise.resolve();
  await bbPlay(scene, 3000);
  const report = bbReport(scene);
  for (const forbidden of ["drive_up", "drive_down", "http", "authSig", "SECRET", "token", "/vod/",
    "/media/", "m3u8", "frigate_max/"]) {
    assert.ok(!report.includes(forbidden), `report must not contain ${forbidden}`);
  }
  assert.ok(report.length < 64 * 1024);
});


test("Blackboard methods deliberately throwing never interrupt playback, recovery or cleanup", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const { controller } = scene;
  const instance = throwingBlackboard(controller);
  await bbPlay(scene, 5000);
  const up = scene.player("Drive Up");
  emitHlsError(up, { fatal: true, type: "networkError", details: "fragLoadError" });
  await Promise.resolve();
  assert.equal(up.lifecycleState, "failed");
  await expectRecoveryAtReviewTime(scene, "Drive Up");
  await bbPlay(scene, 3000);
  assert.ok(instance.disabled, "repeated faults disable collection");
  assert.ok(Object.getOwnPropertyNames(instance).length >= BLACKBOARD_METHODS.length);
  assert.match(controller.getBlackboardReport(), /^FrigateMax Review Blackboard: report unavailable/);
  controller.returnToLive();
  assert.equal(controller._presentationMode, "live");
});


test("Blackboard faults are counted, reported and disable collection without affecting Review", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const instance = board(scene);
  instance.sample = () => { throw new TypeError("synthetic sample failure"); };
  await bbPlay(scene, 15000);
  assert.equal(instance.disabled, true);
  assert.equal(instance.faults, 20);
  const report = bbReport(scene);
  assert.match(report, /BLACKBOARD FAULTS: 20 - collection DISABLED/);
  assert.match(report, /first sample\/TypeError/);
  assert.match(report, /^Session: INCONCLUSIVE$/m);
  assert.equal(scene.player("Drive Up").lifecycleState, "participating");
});


test("Blackboard enabled, disabled and throwing produce identical operational behaviour", async t => {
  const enabled = await operationalTrace(t, "enabled");
  const disabled = await operationalTrace(t, "disabled");
  const throwing = await operationalTrace(t, "throwing");
  assert.ok(enabled.some(entry => entry.includes("failed")), "the scenario exercises a failure");
  assert.deepEqual(disabled, enabled);
  assert.deepEqual(throwing, enabled);
});


test("Blackboard structural rule: operational code never reads Blackboard state", () => {
  const source = readFileSync(new URL("../src/review/review-controller.js", import.meta.url), "utf8");
  const lines = source.split("\n");
  const reads = lines.map((line, index) => [index + 1, line]).filter(([, line]) => line.includes("_blackboard"));
  const allowed = [
    /^ {4}this\._blackboard = blackboard \? new ReviewBlackboard\(\) : null;$/,
    /^ {4}const board = this\._blackboard;$/,
    /^ {6}if \(!this\._blackboard\) return "FrigateMax Review Blackboard: disabled\.";$/,
    /^ {6}return this\._blackboard\.report\(\{$/,
    /^ {6}try \{ this\._blackboard\?\.fault\(error, "report"\); \} catch \{\}$/
  ];
  for (const [number, line] of reads) {
    assert.ok(allowed.some(pattern => pattern.test(line)), `line ${number} reads the Blackboard: ${line.trim()}`);
  }
  assert.equal(reads.length, allowed.length);
  // Observation is a statement: its result is never used.
  assert.doesNotMatch(source, /[=(!&|?]\s*this\.observe\(/);
  assert.doesNotMatch(source, /return this\.observe\(/);
  const module = readFileSync(new URL("../src/review/review-blackboard.js", import.meta.url), "utf8");
  assert.doesNotMatch(module, /^import /m, "the Blackboard module depends on nothing");
  for (const forbidden of [/\b(window|document|globalThis|navigator)\s*\./, /\bsetTimeout\(/,
    /\bsetInterval\(/, /\bfetch\(/, /localStorage|sessionStorage|indexedDB/, /requestVideoFrameCallback/,
    /currentTime\s*=/, /\.(play|pause|seek)\(/]) {
    assert.doesNotMatch(module, forbidden, `the Blackboard module must not use ${forbidden}`);
  }
});


test("Blackboard short event: a verified landing with no further frames is LANDED_ONLY, never played", async t => {
  const scene = await blackboardAutoSnapScene(t);
  const { T, c } = scene;
  assert.equal(c._historicalPlayers.get("Drive Up").initialPlacement.landedEpoch, T + 100);
  await scene.leaveEvent();
  assert.ok(c.clock.absoluteTime >= T + 1000 && c.clock.absoluteTime < T + 1005,
    "Auto Snap moved on to the next event");
  const counts = shortEventCounts(c, "Drive Up");
  assert.equal(counts.landed_only, 1);
  assert.equal(counts.played, 0);
  const report = c.getBlackboardReport();
  assert.match(bbLine(report, "- Short events (Auto Snap):"),
    /PROBLEM DETECTED \(R-09 short events\) - 2 of 2 expected camera-events lacked visible playback/);
  assert.match(report, /^Drive Up: 1-2s 0\/0\/1\/0\/0\/0$/m);
  // In this harness the preparation deadline is 0, so the clock runs while cameras acquire:
  // that is expected time without presentation, never healthy playback.
  assert.match(bbVerdict(report, "Drive Up"),
    /^- Drive Up: PROBLEM DETECTED \(recovered; R-09 short events\)\n {4}Steady playback: PROBLEM DETECTED \(recovered\) - not presenting/,
    "a visited short event is never evidence of healthy playback");
  assert.match(bbVerdict(report, "Drive Up"), /\n {4}Short events: 1\/1 below visible-playback criterion \(flash 0, landed_only 1, nothing 0\)$/);
  assert.match(report, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{2} \S+ \[1800000100\.00\] Drive Up 1\.00s LANDED_ONLY: frames 0, span 0\.00s; landing verified \(\+0\.00s from event start\); acquisition [^;]+; exit held; next event reached/);
});


test("Blackboard short event: frames presented across the event are PLAYED", async t => {
  const scene = await blackboardAutoSnapScene(t, { eventSeconds: 5 });
  const { T, c, media } = scene;
  // The event plays: media advances 0.5 s per presented frame across 2.5 s of the event.
  for (let index = 0; index < 5; index += 1) {
    for (const name of ["Drive Up", "Drive Down"]) {
      const player = c._historicalPlayers.get(name);
      player.video.currentTime += 0.5;
    }
    await scene.settle();
  }
  assert.ok(c._historicalPlayers.get("Drive Up").latestPresentedFrameEpoch >= T + 102.4);
  // 5 s of event time at 8x is 625 ms of wall time.
  await scene.leaveEvent(700);
  const counts = shortEventCounts(c, "Drive Up");
  assert.equal(counts.played, 1, JSON.stringify(counts));
  assert.match(bbLine(c.getBlackboardReport(), "- Short events (Auto Snap):"), /HEALTHY/);
  assert.match(c.getBlackboardReport(), /Drive Up: 5-30s 1\/0\/0\/0\/0\/0/);
});


// ---- Accounting corrections (October 18 runtime report), through the real controller ----

test("Blackboard navigation outcomes: observed, settled between heartbeats, and unsettled when replaced", async t => {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
  const { controller } = scene;
  const up = scene.player("Drive Up");
  await bbPlay(scene, 2000);
  // Settled, and a heartbeat observes it.
  assert.equal(await controller.seekHistoricalToEpoch(RECOVERY_T + 100, { autoplay: true }), true);
  await bbPlay(scene, 1000);
  // Settled, but the next request begins before any heartbeat.
  assert.equal(await controller.seekHistoricalToEpoch(RECOVERY_T + 200, { autoplay: true }), true);
  // Still acquiring (landing withheld) when the next request supersedes it.
  scene.deferredFrame.add("Drive Up");
  const unsettled = controller.seekHistoricalToEpoch(RECOVERY_T + 300, { autoplay: true });
  await waitForCondition(() => up.lifecycleState === "preparing" && up.reviewStage === "landing");
  scene.deferredFrame.delete("Drive Up");
  assert.equal(await controller.seekHistoricalToEpoch(RECOVERY_T + 400, { autoplay: true }), true);
  assert.equal(await unsettled, false);
  await bbPlay(scene, 2000);
  const counts = board(scene).session.navigation.bySource.manual;
  assert.equal(counts.requested, 4);
  assert.deepEqual(counts.outcomes, { settled_observed: 2, settled_unsampled: 1, unsettled_replaced: 1,
    unsettled_window: 0, indeterminate: 0 });
  assert.equal(counts.notLanded, 1, "the superseded request never claims a landing");
  assert.equal(counts.frameNotSampled, 1, "no first-frame latency for the request no heartbeat saw");
  const record = bbCamera(scene, "Drive Up");
  assert.deepEqual(record.acquisitions.abandonedByReason, { superseded_by_explicit_seek: 1 });
  assert.deepEqual(record.acquisitions.abandonedLinked, {}, "no Auto Snap interval started that acquisition");
  const report = bbReport(scene);
  assert.match(report, /manual: requested 4; settled_observed 2, settled_unsampled 1, unsettled_replaced 1/);
  assert.match(report, /: unsettled_replaced; acquisitions 1\/2 landed, 1 unfinished; landing --, first frame not sampled/);
});


test("Blackboard Auto Snap transitions held while the clock is stopped are not Expected time", async t => {
  // As in production, the preparation hold keeps the clock stopped until cameras land.
  const scene = await blackboardAutoSnapScene(t, { harnessOptions: {
    preparationTimeoutMs: 1500, scheduleInitialDeadline: () => () => {} } });
  const { c } = scene;
  await scene.leaveEvent();
  const up = c._historicalPlayers.get("Drive Up");
  assert.equal(c.clock.running, false, "the next event's acquisition holds the clock");
  assert.equal(up.heldCanvas?.hidden, false);
  for (let index = 0; index < 8; index += 1) await scene.tick(500);
  const record = c._blackboard.session.cameras.get("Drive Up");
  const cell = (clock, state) => record.matrix[(BLACKBOARD_CLOCK.indexOf(clock) * BLACKBOARD_COVERAGE.length) *
    BLACKBOARD_STATES.length + BLACKBOARD_STATES.indexOf(state)];
  assert.ok(cell("stopped", "held") >= 4000, `held while stopped ${cell("stopped", "held")}`);
  assert.equal(cell("running", "held"), 0);
  const conserved = Array.from(record.matrix).reduce((sum, value) => sum + value, 0);
  assert.equal(conserved, record.sampledMs);
  const report = c.getBlackboardReport();
  assert.match(bbCameraBlock(report, "Drive Up"),
    /Clock stopped with recording at Review time [^:]+: navigation transitions [1-9][^(]*\(acquiring [^,]+, held [1-9]/);
  assert.doesNotMatch(bbVerdict(report, "Drive Up"), /Steady playback: PROBLEM/,
    "clock-stopped holds are not a steady-playback deficit");
});


test("Blackboard reports Auto Snap FINISHED as event traversal, never as recording reviewed", async t => {
  const scene = await blackboardAutoSnapScene(t, { eventSeconds: 5 });
  const { T, c, media } = scene;
  await scene.leaveEvent(700);
  scene.deferredFrame.clear();
  for (const name of ["Drive Up", "Drive Down"]) media(name).emitFrame();
  await scene.settle();
  await scene.tick(700);
  c.enforceAutoSnapBoundary();
  await scene.settle();
  await scene.tick(500);
  assert.equal(c.clock.running, false);
  const report = c.getBlackboardReport();
  assert.match(report, /^Session #\d+ \| Status: AUTO_SNAP_STOPPED: FINISHED \(copied while the session is open\)/m);
  assert.match(report, /^Completion: Auto Snap event traversal finished — no further events through the investigation range end\. This is event traversal, not continuous review of recording through the range end; stopped since then 500ms\.$/m);
  assert.match(report, new RegExp(`intended end [^;\n]*\[${T + 9000}\]`));
  assert.match(report, /^Review time traversed continuously: .*ReviewClock motion only: not proof that recording was reviewed or presented\.$/m);
  assert.match(report, /Auto Snap: 2 intervals completed, 0 interrupted; stops: finished 1/);
});
