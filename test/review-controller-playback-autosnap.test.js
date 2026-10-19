// Review indicators, playback controls, relative seek and Auto Snap.
import assert from "node:assert/strict";
import test from "node:test";
import {
  Window
} from "happy-dom";
import {
  REVIEW_PLAYBACK_SPEEDS,
  ReviewClock,
  ReviewController,
  buildReviewRange,
  buildRecordingAvailabilityWindow,
  getCivilDayBounds,
  getCivilDayKey,
  normalizePreparedTiming,
  normalizeRecordingAvailability,
  inspectRecordingAvailability,
  normalizeReviewTimelineItems,
  reviewEventNavigationTimestamps,
  reviewEventNavigationTargets,
  buildReviewEventIntervals,
  planContinuousHandoffPrototype,
  reviewTimelineEpochFromCoordinate
} from "../src/review/review-controller.js";
import {
  epochToMedia,
  mediaToEpoch
} from "../src/review/historical-presentation.js";
import {
  cameras,
  prepared,
  presentationPrepared,
  setReviewTi,
  HARNESS_CALENDAR_WALL_CLOCK_MS,
  createHistoricalHarness,
  recordingCoverageResponder,
  enterEventAutoSnap,
  configureGarage,
  waitForCalls,
  waitForCondition,
  configureFourSelectedCameras,
  createEventTimeHarness,
  prepareTargets,
  autoSnapOutcomes,
  createRejoinHarness,
  createAvailabilityQueueHarness,
  UNRECORDED_TARGET,
  availabilityCalls
} from "./review-controller-test-support.js";

test("Review indicators ignore messages, held canvases and non-authoritative gap reasons", async t => {
  const target = 1800000000;
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(target, { autoplay: false });
  const controller = harness.controller;
  const player = controller._historicalPlayers.get("Drive Up");
  const indicator = harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"] .review-camera-presentation-kind');
  const coverage = player.availability;
  const hls = player.hls;
  const video = player.video;
  const callCount = harness.calls.length;
  const playCount = harness.playCalls.length;
  const mediaTime = video.currentTime;
  const assignments = [...controller.state.reviewAssignments];
  for (const [state, reason, availability] of [
    ["participating", "initial_selection", coverage],
    ["preparing", "explicit_seek", { ...coverage, coverage: [] }],
    ["unavailable", "superseded_by_explicit_seek", { ...coverage, coverage: [] }],
    ["unavailable", "continuous_presentation_exhausted", { ...coverage, coverage: [] }],
    ["unavailable", "availability_unknown", null],
    ["unavailable", "authoritative_recording_gap", null],
    ["unavailable", "authoritative_recording_gap", coverage],
    ["unavailable", "prepare_reported_no_recording_suppressed", coverage]
  ]) {
    player.availability = availability;
    controller.setCameraLifecycle(player, state, { boundaryReason: reason, targetEpoch: target });
    controller.setPlayerStatus(player, "No recording at this time.", true);
    assert.equal(indicator.textContent, "", `${state}/${reason}`);
    assert.equal(indicator.hidden, true);
    assert.equal(player.statusElement.hidden, true);
  }
  player.availability = null;
  controller.setCameraLifecycle(player, "failed", { boundaryReason: "availability_api_failure" });
  assert.equal(indicator.textContent, "Unavailable", "unknown coverage must not disguise a failed state as a gap");
  assert.equal(indicator.hidden, false);
  assert.strictEqual(player.video, video);
  assert.strictEqual(player.hls, hls);
  assert.equal(video.currentTime, mediaTime);
  assert.equal(harness.calls.length, callCount);
  assert.equal(harness.playCalls.length, playCount);
  assert.equal(controller.clock.absoluteTime, target);
  assert.equal(controller.clock.running, false);
  assert.deepEqual(controller.state.reviewAssignments, assignments);
});


test("Review gap indication follows investigation time without waiting for camera acquisition", async t => {
  const target = 1800000000;
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(target, { autoplay: false });
  const controller = harness.controller;
  const player = controller._historicalPlayers.get("Drive Up");
  player.availability = { camera: player.frigateCamera,
    requested_start: target - 10, requested_end: target + 20,
    coverage: [{ start: target + 5, end: target + 20 }] };
  controller.setCameraLifecycle(player, "unavailable", { boundaryReason: "authoritative_recording_gap" });
  const indicator = harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"] .review-camera-presentation-kind');
  assert.equal(indicator.textContent, "No recording");
  for (const epoch of [target + 5, target + 25]) {
    setReviewTi(controller, epoch);
    controller.updateClockDisplay();
    assert.equal(indicator.textContent, "", "covered or unanswered TI cannot retain a stale gap indication");
    assert.equal(indicator.hidden, true);
    assert.equal(player.lifecycleState, "unavailable");
    assert.equal(player.boundaryReason, "authoritative_recording_gap");
    assert.equal(controller.clock.absoluteTime, epoch);
  }
});


test("Live, No recording and Unavailable share all configured corners and one renderer", async t => {
  const target = 1800000000;
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const assertIndicator = (indicator, text, corner) => {
    const [vertical, horizontal] = corner.split("-");
    assert.equal(indicator.textContent, text);
    assert.equal(indicator.hidden, false);
    assert.equal(indicator.getAttribute("role"), "status");
    for (const side of ["top", "right", "bottom", "left"]) {
      assert.equal(indicator.style[side], side === vertical || side === horizontal ? "6px" : "auto");
    }
  };
  for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    controller.setVideoStateBadgePosition(corner);
    assertIndicator(harness.root.querySelector(".review-camera-presentation-kind"), "Live", corner);
  }
  await controller.playHistorical(target, { autoplay: false });
  const player = controller._historicalPlayers.get("Drive Up");
  player.availability = { ...player.availability, coverage: [] };
  const indicator = harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"] .review-camera-presentation-kind');
  const hls = player.hls;
  const video = player.video;
  for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    controller.setVideoStateBadgePosition(corner);
    controller.setCameraLifecycle(player, "unavailable", { boundaryReason: "authoritative_recording_gap" });
    assertIndicator(indicator, "No recording", corner);
    controller.setCameraLifecycle(player, "failed", { boundaryReason: "play_rejected" });
    assertIndicator(indicator, "Unavailable", corner);
  }
  assert.strictEqual(player.video, video);
  assert.strictEqual(player.hls, hls);
  assert.equal(controller.clock.absoluteTime, target);
});


for (const rate of [4, 8]) {
  test(`covered short Snap scenes remain silent through navigation at ${rate}x`, async t => {
    const base = 1800000000;
    const when = { from: base - 100, to: base + 200 };
    let now = 1000;
    const harness = createHistoricalHarness({ now: () => now,
      wallClockMs: when.to * 1000, initialReviewRange: when, reviewEvents: [
        { camera_id: "drive_up", start_time: base, end_time: base + 2 },
        { camera_id: "drive_up", start_time: base + 100, end_time: base + 102 }
      ] });
    t.after(() => harness.close());
    const controller = await enterEventAutoSnap(harness, base + 0.25, when);
    controller.setPlaybackSpeed(rate);
    const player = controller._historicalPlayers.get("Drive Up");
    const video = player.video;
    const hls = player.hls;
    const assignments = [...controller.state.reviewAssignments];
    const assertSilent = () => {
      assert.ok([...harness.root.querySelectorAll(".review-camera-presentation-kind")]
        .every(indicator => indicator.hidden && indicator.textContent === ""));
      assert.equal(harness.root.querySelectorAll('.review-camera-status:not([hidden])').length, 0);
    };
    assertSilent();
    assert.equal(controller.resumePlayback(), true);
    await waitForCondition(() => player.lifecycleState === "participating");
    now += (2 - 0.25) * 1000 / rate;
    assert.equal(controller.enforceAutoSnapBoundary(), true);
    assert.equal(controller.clock.absoluteTime, base + 100);
    assertSilent();
    await waitForCondition(() => !controller._historicalPreparing &&
      player.lifecycleState === "participating");
    assertSilent();
    assert.equal(controller.clock.running, true);
    assert.equal(controller.clock.rate, rate);
    assert.strictEqual(player.video, video);
    assert.strictEqual(player.hls, hls);
    assert.deepEqual(controller.state.reviewAssignments, assignments);
  });
}


test("Gate 1 identity diagnostics are bounded to sanitized stable identifiers", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller.setHistoricalSyncDiagnostics(true);
  const target = harness.controller.state.reviewRange.from + 300;
  await harness.controller.playHistorical(target, { autoplay: false });
  const report = harness.controller.getLatestHistoricalSyncReport();
  const up = report.cameras["Drive Up"];

  assert.equal(up.requestId, report.requestId);
  assert.equal(Number.isInteger(up.cameraWorkId), true);
  assert.equal(Number.isInteger(up.presentationId), true);
  assert.equal(up.frigateCamera, "drive_up");
  assert.equal(up.returnedCamera, "drive_up");
  assert.match(up.playerId, /^player-/);
  assert.match(up.hlsId, /^hls-/);
  assert.match(up.videoId, /^video-/);
  assert.match(up.panelId, /^panel-/);
  assert.equal(up.panelCamera, "Drive Up");
  assert.equal(up.renderedSlot, 0);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("auth/sign_path"), false);
  assert.equal(serialized.includes(".m3u8"), false);
  assert.equal(serialized.includes('"path"'), false);
  assert.equal(serialized.includes('"hls"'), false);
  assert.equal(serialized.includes('"video"'), false);
});


test("Gate 1 cleanup of stale camera work cannot destroy newer owned resources", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller._presentationMode = "historical";
  const camera = harness.controller._cameras[0];
  const oldPlayer = harness.controller.createHistoricalPlayer(camera);
  const currentPlayer = harness.controller.createHistoricalPlayer(camera);
  let oldDestroyed = 0;
  let currentDestroyed = 0;
  oldPlayer.hls = { destroy: () => { oldDestroyed += 1; } };
  currentPlayer.hls = { destroy: () => { currentDestroyed += 1; } };
  harness.controller._historicalPlayers.set(camera.name, currentPlayer);

  harness.controller.cleanupHistoricalPlayer(oldPlayer);

  assert.equal(oldDestroyed, 1);
  assert.equal(currentDestroyed, 0);
  assert.strictEqual(harness.controller._historicalPlayers.get(camera.name), currentPlayer);
  assert.notEqual(oldPlayer.cameraWorkId, currentPlayer.cameraWorkId);
});


test("Gate 1 rapid assignment changes leave only final valid slot identities renderable", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller.setReviewLayout("2x2");
  harness.controller.assignCameraToSlot("Back", 1);
  harness.controller.assignCameraToSlot("Drive Down", 1);
  harness.controller.assignCameraToSlot("Back", 1);

  const panels = [...harness.root.querySelectorAll(".review-camera-panel")];
  const slotOne = harness.root.querySelector('[data-review-slot="1"] .review-camera-panel');
  assert.equal(slotOne.dataset.camera, "Back");
  assert.equal(slotOne.dataset.reviewSlot, "1");
  assert.equal(panels.filter(panel => panel.dataset.camera === "Drive Down").length, 0);
  assert.equal(harness.controller.state.reviewAssignments[1], "Back");
});


test("a stale metadata generation cannot overwrite the newest displayed query", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.refreshReviewQuery();
  let resolveFirst;
  let resolveSecond;
  const firstGate = new Promise(resolve => { resolveFirst = resolve; });
  const secondGate = new Promise(resolve => { resolveSecond = resolve; });
  let request = 0;
  harness.controller._hass.callWS = message => {
    harness.calls.push(JSON.parse(JSON.stringify(message)));
    if (message.type !== "frigate_max/v1/review/get") {
      return Promise.reject(new Error("Unexpected command"));
    }
    request += 1;
    return request === 1 ? firstGate : secondGate;
  };
  const original = harness.controller.state.reviewRange;
  harness.controller.setReviewRangeEndpoint("from", original.from - 600);
  assert.equal(harness.controller.applyWhenDraft(), true);
  const first = harness.controller.flushScheduledReviewQuery();
  harness.controller.setReviewRangeEndpoint("to", original.to - 600);
  assert.equal(harness.controller.applyWhenDraft(), true);
  const newest = harness.controller.state.desiredReviewQuery;
  const second = harness.controller.flushScheduledReviewQuery();
  resolveSecond([{ camera_id: "drive_down", start_time: newest.range.to, type: "car" }]);
  await second;
  resolveFirst([{ camera_id: "drive_up", start_time: original.to, type: "person" }]);
  await first;
  assert.deepEqual(harness.controller.state.displayedReviewQuery, newest);
  assert.equal(harness.controller.state.timeline.items[0].camera_id, "drive_down");
});


test("Timeline cursor follows ReviewClock without rebuilding metadata markers", async t => {
  const target = Date.parse("2026-09-10T11:30:00-07:00") / 1000;
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS, reviewEvents: [{
    camera_id: "drive_up", start_time: target - 60, type: "person", labels: ["person"]
  }] });
  t.after(() => harness.close());
  await harness.controller.refreshReviewQuery();
  await harness.controller.selectTimelineTime(target);
  const cursor = harness.root.querySelector(".review-timeline-cursor");
  const marker = harness.root.querySelector(".review-timeline-marker");
  const before = cursor.style.top;
  assert.equal(cursor.hidden, false);
  harness.controller.clock.pause();
  harness.controller.clock.setAbsolute(target + 10);
  harness.controller.updateClockDisplay();
  assert.notEqual(cursor.style.top, before);
  assert.strictEqual(harness.root.querySelector(".review-timeline-cursor"), cursor);
  assert.strictEqual(harness.root.querySelector(".review-timeline-marker"), marker);
});


test("manual Timeline click pauses placement, prepares the target, and waits for explicit Play", async t => {
  // One hour after the target, so its recording lies outside the unpublished live tail.
  const harness = createHistoricalHarness({ wallClockMs: (1800000000 + 3600) * 1000 });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.playHistorical(1800000060);
  const startsBefore = harness.starts.length;
  const range = controller.state.displayedReviewQuery.range;
  const target = 1800000000;
  await controller.selectTimelineTime(target, "timeline click", false);
  assert.equal(controller.clock.absoluteTime, target);
  assert.equal(controller.clock.running, false);
  assert.equal(harness.starts.length, startsBefore);
  assert.ok([...controller._historicalPlayers.values()].every(player =>
    player.lifecycleState === "participating" && player.video.paused));
  assert.equal(controller.resumePlayback(), true);
  assert.equal(controller.clock.running, true);
  assert.equal(harness.starts.length, startsBefore + 2);
});


test("manual upper/lower edge click and drag preserve TI epoch and viewport through acquisition and seek", async t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall };
  const viewport = { from: wall - 3900, to: wall - 3600 };
  const cases = [
    { input: "click", lifecycle: "initial", y: 105 },
    { input: "click", lifecycle: "initial", y: 395 },
    { input: "drag", lifecycle: "seek", y: 105 },
    { input: "drag", lifecycle: "seek", y: 395 }
  ];
  for (const scenario of cases) {
    const harness = createHistoricalHarness({
      wallClockMs: wall * 1000, initialReviewRange: when
    });
    t.after(() => harness.close());
    const { controller } = harness;
    if (scenario.lifecycle === "seek") {
      await controller.playHistorical(wall - 3750, {
        autoplay: false, updateDisplayedRange: false, playbackRange: when
      });
    }
    controller.setTimelineViewport(viewport);
    const axis = harness.root.querySelector(".review-timeline-axis");
    axis.getBoundingClientRect = () => ({ top: 100, height: 300 });
    const selected = controller.getTimelinePointerEpoch(axis, scenario.y);
    assert.ok(selected >= when.from && selected <= when.to);
    const requestBefore = controller._reviewRequestId;
    if (scenario.input === "click") {
      axis.dispatchEvent(new harness.window.MouseEvent("click", {
        bubbles: true, button: 0, clientY: scenario.y
      }));
    } else {
      const handle = axis.querySelector(".review-timeline-handle");
      handle.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
        bubbles: true, pointerId: 31, button: 0, clientY: 250
      }));
      handle.dispatchEvent(new harness.window.PointerEvent("pointermove", {
        bubbles: true, pointerId: 31, button: 0, clientY: scenario.y
      }));
      handle.dispatchEvent(new harness.window.PointerEvent("pointerup", {
        bubbles: true, pointerId: 31, button: 0, clientY: scenario.y
      }));
    }
    await waitForCondition(() => controller._reviewRequestId !== requestBefore &&
      !controller._historicalPreparing && controller.clock.absoluteTime === selected);
    assert.deepEqual(controller.state.timelineViewport, viewport,
      `${scenario.input} ${scenario.lifecycle} placement must retain viewport bounds`);
    assert.equal(controller.clock.absoluteTime, selected,
      `${scenario.input} ${scenario.lifecycle} placement must retain its exact epoch`);
    assert.equal(controller.clock.running, false);
  }
});


test("repeated paused Timeline placements keep the newest target and cannot autoplay a stale request", async t => {
  const harness = createHistoricalHarness();
  const firstTarget = harness.controller.state.reviewRange.from + 600;
  const secondTarget = firstTarget + 300;
  const pendingFirst = [];
  harness.controller._hass.callWS = ((originalCallWS) => message => {
    if (message.type === "frigate_max/v2/vod/prepare" && message.target === firstTarget) {
      harness.calls.push(JSON.parse(JSON.stringify(message)));
      return new Promise(resolve => pendingFirst.push(() => resolve(
        presentationPrepared(message.camera, message.target - 20, message.target)
      )));
    }
    return originalCallWS(message);
  })(harness.controller._hass.callWS.bind(harness.controller._hass));
  t.after(() => harness.close());
  const first = harness.controller.selectTimelineTime(firstTarget, "timeline click", false);
  await waitForCalls(harness, "frigate_max/v2/vod/prepare", 2);
  const second = harness.controller.selectTimelineTime(secondTarget, "timeline click", false);
  await second;
  assert.equal(harness.controller.clock.absoluteTime, secondTarget);
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.starts.length, 0);
  pendingFirst.splice(0).forEach(resolve => resolve());
  await first;
  assert.equal(harness.controller.clock.absoluteTime, secondTarget);
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.starts.length, 0);
});


test("manual placement does not alter ordinary explicit Play behavior", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000, { autoplay: false });
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.controller.resumePlayback(), true);
  assert.equal(harness.controller.clock.running, true);
  assert.equal(harness.starts.length, 2);
});


test("dragging the yellow cursor previews clamped time and selects historical VOD exactly once on release", async t => {
  let now = 1000;
  const harness = createHistoricalHarness({ now: () => now });
  t.after(() => harness.close());
  const controller = harness.controller;
  const range = controller.state.displayedReviewQuery.range;
  const initial = range.from + (range.to - range.from) / 2;
  await controller.selectTimelineTime(initial);
  assert.equal(controller.clock.running, true);

  const axis = harness.root.querySelector(".review-timeline-axis");
  const handle = harness.root.querySelector(".review-timeline-handle");
  const output = harness.root.querySelector(".review-time-truth .review-clock-display");
  axis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  const prepareBefore = harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length;
  const startsBefore = harness.starts.length;

  handle.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 7, button: 0, clientY: 300
  }));
  assert.equal(controller.clock.running, false);
  handle.dispatchEvent(new harness.window.PointerEvent("pointermove", {
    bubbles: true, pointerId: 7, clientY: -200
  }));
  assert.equal(controller.clock.absoluteTime, range.to);
  assert.equal(output.dateTime, new Date(range.to * 1000).toISOString());
  handle.dispatchEvent(new harness.window.PointerEvent("pointermove", {
    bubbles: true, pointerId: 7, clientY: 900
  }));
  assert.equal(controller.clock.absoluteTime, range.from);
  assert.equal(output.dateTime, new Date(range.from * 1000).toISOString());
  assert.equal(
    harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length,
    prepareBefore
  );
  assert.equal(harness.starts.length, startsBefore);

  const releaseY = 200;
  const releasedEpoch = reviewTimelineEpochFromCoordinate(releaseY, 100, 400, range);
  handle.dispatchEvent(new harness.window.PointerEvent("pointerup", {
    bubbles: true, pointerId: 7, button: 0, clientY: releaseY
  }));
  axis.dispatchEvent(new harness.window.MouseEvent("click", {
    bubbles: true, button: 0, clientY: releaseY
  }));
  for (let index = 0; index < 20 && harness.calls.filter(call =>
    call.type === "frigate_max/v2/vod/prepare").length < 4; index += 1) {
    await new Promise(resolve => harness.window.setTimeout(resolve, 0));
  }
  const releasePrepares = harness.calls
    .filter(call => call.type === "frigate_max/v1/vod/prepare")
    .slice(prepareBefore);
  assert.equal(releasePrepares.length, 2);
  assert.deepEqual(releasePrepares.map(call => call.camera), ["drive_up", "drive_down"]);
  assert.ok(releasePrepares.every(call => call.target === releasedEpoch));
  assert.equal(harness.starts.length, startsBefore);
  assert.equal(controller.state.presentationMode, "historical");
  assert.equal(controller.clock.running, false);
  assert.equal(controller.resumePlayback(), true);
  assert.equal(controller.clock.running, true);
  assert.equal(harness.starts.length, startsBefore + 2);
});


test("pointer cancellation restores the paused Review time without a VOD request or playback start", async t => {
  const harness = createHistoricalHarness({ now: () => 1000 });
  t.after(() => harness.close());
  const controller = harness.controller;
  const range = controller.state.displayedReviewQuery.range;
  const original = range.from + (range.to - range.from) / 2;
  await controller.selectTimelineTime(original);
  controller.pausePlayback();
  const prepareBefore = harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length;
  const startsBefore = harness.starts.length;
  const axis = harness.root.querySelector(".review-timeline-axis");
  const handle = harness.root.querySelector(".review-timeline-handle");
  axis.getBoundingClientRect = () => ({ top: 100, height: 400 });

  handle.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 9, button: 0, clientY: 300
  }));
  handle.dispatchEvent(new harness.window.PointerEvent("pointermove", {
    bubbles: true, pointerId: 9, clientY: 100
  }));
  assert.equal(controller.clock.absoluteTime, range.to);
  handle.dispatchEvent(new harness.window.PointerEvent("pointercancel", {
    bubbles: true, pointerId: 9
  }));

  assert.equal(controller.clock.absoluteTime, original);
  assert.equal(controller.clock.running, false);
  assert.equal(controller._timelineDrag, null);
  assert.equal(
    harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length,
    prepareBefore
  );
  assert.equal(harness.starts.length, startsBefore);
});


test("a future Timeline selection stays in Review live without requesting VOD", async t => {
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS });
  t.after(() => harness.close());
  const future = harness.controller.state.reviewRange.to + 30;
  harness.controller._reviewRange = {
    from: future - 3600,
    to: future + 3600
  };
  harness.controller._desiredReviewRange = { ...harness.controller._reviewRange };
  harness.controller._displayedReviewQuery.range = { ...harness.controller._reviewRange };
  const liveImages = [...harness.root.querySelectorAll("hui-image.review-live-camera")];
  const before = harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length;
  assert.equal(await harness.controller.selectTimelineTime(future), false);
  assert.equal(harness.controller.state.presentationMode, "live");
  assert.equal(
    harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length,
    before
  );
  assert.match(harness.controller._historicalStatus, /No recording/);
  assert.equal(harness.root.querySelector(".review-historical-state"), null);
  assert.deepEqual([...harness.root.querySelectorAll("hui-image.review-live-camera")], liveImages);
});


test("committed From/To survive a mode round trip and both picker instances are destroyed", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const from = Date.parse("2026-09-07T10:15:00-07:00") / 1000;
  const to = Date.parse("2026-09-07T11:45:00-07:00") / 1000;
  assert.equal(harness.controller.setReviewRangeEndpoint("from", from), true);
  assert.equal(harness.controller.setReviewRangeEndpoint("to", to), true);
  assert.equal(harness.controller.applyWhenDraft(), true);
  assert.deepEqual(harness.controller.state.desiredReviewRange, { from, to });
  const previousPickers = harness.datePickerInstances.slice(-2);
  harness.controller.deactivate();
  assert.ok(previousPickers.every(picker => picker.destroyCount === 1));
  harness.controller.activate();
  assert.deepEqual(harness.controller.state.desiredReviewRange, { from, to });
  assert.equal(harness.datePickerInstances.at(-2).altInput.value, "09/07/2026");
  assert.equal(harness.datePickerInstances.at(-1).altInput.value, "09/07/2026");
  assert.equal(harness.root.querySelectorAll(".review-time-hour")[0].value, "10");
  assert.equal(harness.root.querySelectorAll(".review-time-minute")[0].value, "15");
  assert.equal(harness.root.querySelectorAll(".review-time-hour")[1].value, "11");
  assert.equal(harness.root.querySelectorAll(".review-time-minute")[1].value, "45");
});


test("flatpickr permits an invalid intermediate range and preserves live media identity", t => {
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS });
  t.after(() => harness.close());
  const panel = harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]');
  const image = panel.querySelector("hui-image");
  const [fromPicker, toPicker] = harness.datePickerInstances.slice(-2);
  for (const picker of [fromPicker, toPicker]) {
    assert.equal(picker.options.enableTime, false);
    assert.equal(picker.options.altFormat, "m/d/Y");
    assert.equal(picker.options.dateFormat, "Y-m-d");
    assert.equal(picker.options.allowInput, true);
    assert.equal(picker.options.disableMobile, true);
  }
  fromPicker.select(new Date(2026, 8, 11));
  assert.ok(harness.controller.state.whenDraftRange.from >=
    harness.controller.state.whenDraftRange.to);
  assert.deepEqual(harness.controller.state.desiredReviewRange,
    harness.controller.state.displayedReviewQuery.range);
  assert.deepEqual(harness.controller.state.reviewRange,
    harness.controller.state.displayedReviewQuery.range);
  assert.strictEqual(
    harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]'),
    panel
  );
  assert.strictEqual(panel.querySelector("hui-image"), image);
});


test("When exposes direct controls and keeps edits draft-only until Apply", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const range = harness.controller.state.reviewRange;
  await harness.controller.selectTimelineTime(range.from + 600);
  assert.equal(harness.controller.state.presentationMode, "historical");
  harness.controller.setReviewRangeEndpoint("to", range.to + 60);
  assert.equal(harness.controller.state.presentationMode, "historical");
  assert.notEqual(harness.controller.clock.absoluteTime, null);
  assert.deepEqual(harness.controller.state.reviewRange, range);
  assert.equal(harness.controller.applyWhenDraft(), true);
  assert.equal(harness.controller.state.presentationMode, "live");
  assert.equal(harness.controller.clock.absoluteTime, null);
  assert.ok(harness.root.querySelectorAll(".review-range-field").length >= 2);
  assert.equal(harness.root.querySelectorAll(".review-when-shortcuts button").length, 3);
  assert.equal(harness.root.querySelector(".review-when-apply").textContent, "Apply");
  assert.equal(harness.root.textContent.includes("T12:00:00"), false);
});


test("event navigation inventory sorts, deduplicates, and ignores unselected cameras", () => {
  const items = [
    { camera_id: "drive_up", start_time: 300 },
    { camera_id: "drive_down", start_time: 100 },
    { camera_id: "drive_up", start_time: 100 },
    { camera_id: "garage", start_time: 200 },
    { camera_id: "back", start_time: 400 }
  ];
  const inventory = reviewEventNavigationTimestamps(items,
    ["drive_up", "drive_down"], { from: 100, to: 350 });
  assert.deepEqual(inventory, [100, 300]);
  assert.deepEqual(reviewEventNavigationTargets(inventory, 100), {
    previous: null, next: 300
  });
  assert.deepEqual(reviewEventNavigationTargets(inventory, 300), {
    previous: 100, next: null
  });
  assert.deepEqual(reviewEventNavigationTargets(inventory, 200), {
    previous: 100, next: 300
  });
});


test("event retrieval paging leaves timeline start boundaries and strict Snap starts unchanged", () => {
  const range = { from: 100, to: 200 };
  const items = normalizeReviewTimelineItems([
    { camera_id: "drive_up", start_time: 99, end_time: 150 },
    { camera_id: "drive_up", start_time: 100, end_time: 110 },
    { camera_id: "drive_up", start_time: 150, end_time: 175 },
    { camera_id: "drive_up", start_time: 200 },
    { camera_id: "drive_up", start_time: 201 }
  ], range);
  assert.deepEqual(items.map(item => item.start_time), [100, 150, 200]);
  const starts = reviewEventNavigationTimestamps(items, ["drive_up"], range);
  assert.deepEqual(starts, [100, 150, 200]);
  assert.deepEqual(reviewEventNavigationTargets(starts, 150), {
    previous: 100, next: 200
  });
});


test("Snap Forward uses selected-camera event starts across the full Review range and preserves cameras", async t => {
  const target = Date.parse("2026-09-10T09:00:00-07:00") / 1000;
  const range = { from: target - 60, to: target + 2000 };
  const events = [
    { camera_id: "drive_up", start_time: target, end_time: target + 5 },
    { camera_id: "drive_down", start_time: target, end_time: target + 10 },
    { camera_id: "garage", start_time: target + 10, end_time: target + 15 },
    { camera_id: "back", start_time: target + 20, end_time: target + 25 },
    { camera_id: "drive_up", start_time: target + 720, end_time: target + 730 }
  ];
  const harness = createHistoricalHarness({ reviewEvents: events, initialReviewRange: range });
  t.after(() => harness.close());
  configureFourSelectedCameras(harness);
  await harness.controller.flushScheduledReviewQuery();
  const selected = [...harness.controller.state.reviewAssignments];
  const queryCount = harness.controller._queryRefreshCount;
  assert.deepEqual(harness.controller.getEventNavigationInventory(),
    [target, target + 20, target + 720]);
  assert.ok(harness.calls.some(call => call.type === "frigate_max/v1/review/get" &&
    call.from === range.from && call.to === Math.min(range.to,
      harness.controller._wallClock() / 1000) &&
    call.cameras.join(",") === "drive_up,drive_down,back,patio"));
  harness.controller._reviewPosition = target - 1;

  assert.equal(await harness.controller.snapToNextEvent(), true);
  assert.equal(harness.controller.clock.absoluteTime, target);
  assert.equal(harness.controller.clock.running, false);
  assert.deepEqual(harness.controller.state.reviewAssignments, selected);
  assert.deepEqual(harness.controller.state.displayedReviewQuery.cameraNames,
    ["Drive Up", "Drive Down", "Back", "Patio"]);
  assert.deepEqual(harness.controller.getTimelineLanes().map(lane => lane.name),
    ["Drive Up", "Drive Down", "Back", "Patio"]);
  assert.equal(harness.controller._queryRefreshCount, queryCount);
  assert.equal(harness.root.querySelector(".review-play").disabled, false);
  assert.deepEqual([...harness.controller._historicalPlayers.keys()],
    ["Drive Up", "Drive Down", "Back", "Patio"]);
  assert.ok([...harness.controller._historicalPlayers.values()].every(player =>
    player.lifecycleState === "participating" && player.initialPlacement?.requestedEpoch === target));
  const prepares = harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare");
  assert.equal(prepares.length, 4);
  assert.ok(prepares.every(call => call.target === target));
  assert.ok(prepares.every(call => call.bounds_start === range.from &&
    call.bounds_end === range.to));
  assert.deepEqual(harness.controller._historicalPlaybackRange, range);
  assert.equal(prepares.some(call => call.camera === "patio"), true,
    "selected Patio remains eligible despite having no event at T");

  harness.controller._reviewPosition = target;
  assert.equal(await harness.controller.snapToNextEvent(), true);
  assert.equal(harness.controller.clock.absoluteTime, target + 20);
  assert.deepEqual(harness.controller.state.reviewAssignments, selected);
  assert.equal(harness.root.querySelector(".review-play").disabled, false);
  harness.controller._reviewPosition = target + 21;
  assert.equal(await harness.controller.snapToNextEvent(), true,
    "navigation reaches an event more than ten minutes ahead");
  assert.equal(harness.controller.clock.absoluteTime, target + 720);
  assert.deepEqual(harness.controller.state.reviewAssignments, selected);
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.starts.length, 0);
  assert.equal(harness.controller.resumePlayback(), true);
  assert.equal(harness.controller.clock.running, true);
  assert.equal(harness.starts.length, 4);
});


test("Snap Reverse walks strict previous event starts and preserves selected cameras", async t => {
  const target = Date.parse("2026-09-10T09:00:00-07:00") / 1000;
  const range = { from: target - 60, to: target + 300 };
  const events = [
    { camera_id: "drive_up", start_time: target },
    { camera_id: "drive_down", start_time: target + 20 },
    { camera_id: "back", start_time: target + 40 },
    { camera_id: "garage", start_time: target + 45 }
  ];
  const harness = createHistoricalHarness({ reviewEvents: events, initialReviewRange: range });
  t.after(() => harness.close());
  configureFourSelectedCameras(harness);
  await harness.controller.flushScheduledReviewQuery();
  const selected = [...harness.controller.state.reviewAssignments];
  harness.controller._reviewPosition = target + 50;
  assert.equal(await harness.controller.snapToPreviousEvent(), true);
  assert.equal(harness.controller.clock.absoluteTime, target + 40);
  assert.deepEqual(harness.controller.state.reviewAssignments, selected);
  assert.equal(harness.root.querySelector(".review-play").disabled, false);
  harness.controller._reviewPosition = target + 40;
  assert.equal(await harness.controller.snapToPreviousEvent(), true);
  assert.equal(harness.controller.clock.absoluteTime, target + 20);
  assert.deepEqual(harness.controller.state.reviewAssignments, selected);
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.root.querySelector(".review-play").disabled, false);
  const prepares = harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare");
  assert.equal(prepares.length, 8);
  assert.ok(prepares.every(call =>
    call.target === target + 40 || call.target === target + 20));
});


test("Snap availability uses the same selected event inventory in both directions", t => {
  const target = Date.parse("2026-09-10T09:00:00-07:00") / 1000;
  const range = { from: target - 60, to: target + 100 };
  const harness = createHistoricalHarness({
    initialReviewRange: range,
    reviewEvents: [
      { camera_id: "drive_up", start_time: target },
      { camera_id: "drive_down", start_time: target + 20 },
      { camera_id: "drive_up", start_time: target + 20 },
      { camera_id: "garage", start_time: target + 40 }
    ]
  });
  t.after(() => harness.close());
  harness.controller._timeline.items = normalizeReviewTimelineItems([
    { camera_id: "drive_up", start_time: target },
    { camera_id: "drive_down", start_time: target + 20 },
    { camera_id: "drive_up", start_time: target + 20 },
    { camera_id: "garage", start_time: target + 40 }
  ], range);
  harness.controller._timeline.status = "loaded";
  for (const [position, previousDisabled, nextDisabled] of [
    [target - 1, true, false], [target, true, false],
    [target + 20, false, true], [target + 40, false, true]
  ]) {
    harness.controller._reviewPosition = position;
    harness.controller.updateTransport();
    assert.equal(harness.root.querySelector(".review-previous-event").disabled,
      previousDisabled);
    assert.equal(harness.root.querySelector(".review-next-event").disabled, nextDisabled);
  }
});


test("ordinary Review holds a presented frame through a recording gap and clears it on a fresh frame", async t => {
  const target = Date.parse("2026-09-10T09:00:00-07:00") / 1000;
  const selected = ["Drive Up", "Drive Down"];
  const harness = createHistoricalHarness({
    reviewEvents: [
      { camera_id: "drive_down", start_time: target, end_time: target + 5 },
      { camera_id: "drive_up", start_time: target + 1, end_time: target + 5 }
    ],
    availabilityResponder: recordingCoverageResponder({
      drive_up: [{ start: target - 30, end: target + 5 }, { start: target + 20, end: target + 100 }],
      drive_down: [{ start: target - 7200, end: target + 7200 }]
    }),
    initialReviewRange: { from: target - 60, to: target + 300 }
  });
  t.after(() => harness.close());
  harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  await harness.controller.playHistorical(target, { autoplay: false });
  const player = harness.controller._historicalPlayers.get("Drive Up");
  const badge = harness.root.querySelector(
    '.review-camera-panel[data-camera="Drive Up"] .review-camera-presentation-kind'
  );
  assert.equal(player.heldCanvas, undefined);
  harness.mediaControls.find(control => control.camera === "Drive Up").emitFrame();
  assert.ok(player.heldCanvas);
  assert.equal(badge.textContent, "");
  const representedEpoch = player.heldFrameEpoch;
  assert.equal(player.heldCanvas.hidden, true);
  harness.controller.leaveHistoricalCamera(player, "authoritative_recording_gap", target + 10);
  assert.equal(player.heldCanvas.hidden, false);
  assert.equal(badge.textContent, "");
  assert.equal(player.heldFrameEpoch, representedEpoch);
  assert.equal(player.statusElement.hidden, true);
  assert.equal(player.message, "No recording at this time.");
  assert.equal(harness.controller.inspectPlayerAvailability(player, target + 10).containing, null);
  assert.deepEqual(harness.controller.state.reviewAssignments.slice(0, 2), selected);
  assert.deepEqual([...harness.root.querySelectorAll(".review-camera-panel")]
    .map(panel => panel.dataset.camera), selected);
  assert.equal(harness.controller.clock.absoluteTime, target);
  const oldVideo = player.video;
  harness.mediaControls.find(control => control.video === oldVideo).emitFrame(target + 20);
  assert.equal(player.heldFrameEpoch, representedEpoch);
  setReviewTi(harness.controller, target + 25);
  assert.equal(await harness.controller.reconcileHistoricalCamera(player, target + 25,
    { explicit: true, autoplay: false }), "prepared");
  assert.equal(player.heldCanvas.hidden, true, "fresh owned rejoin RVFC replaces the held frame");
  assert.equal(badge.textContent, "");
  harness.mediaControls.filter(control => control.camera === "Drive Up").at(-1).emitFrame();
  assert.equal(player.heldCanvas.hidden, true);
  assert.equal(badge.textContent, "");
  assert.equal(player.holdStartedAtMs, null);
  assert.equal(player.statusElement.hidden, true);
  assert.deepEqual(harness.controller.state.reviewAssignments.slice(0, 2), selected);
  assert.equal(harness.controller.clock.absoluteTime, target + 25);
});


test("ending event annotations do not remove recorded Review video or selected cameras", async t => {
  const target = Date.parse("2026-09-10T09:00:00-07:00") / 1000;
  const selected = ["Drive Up", "Drive Down"];
  const harness = createHistoricalHarness({
    reviewEvents: [
      { camera_id: "drive_up", start_time: target, end_time: target + 5 },
      { camera_id: "drive_down", start_time: target, end_time: target + 5 }
    ],
    initialReviewRange: { from: target - 60, to: target + 300 }
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target, { autoplay: false });
  for (const player of harness.controller._historicalPlayers.values()) {
    player.video.currentTime = target + 6 - player.timing.effective_absolute_origin;
  }
  await harness.controller.evaluateHistoricalAvailability(null, { reason: "past_event_end" });
  assert.deepEqual(harness.controller.state.reviewAssignments.slice(0, 2), selected);
  assert.deepEqual([...harness.root.querySelectorAll(".review-camera-panel")]
    .map(panel => panel.dataset.camera), selected);
  assert.ok([...harness.controller._historicalPlayers.values()]
    .every(player => player.lifecycleState === "participating" &&
      player.statusElement.hidden && (player.heldCanvas == null || player.heldCanvas.hidden)));
  assert.ok([...harness.root.querySelectorAll(".review-camera-presentation-kind")]
    .every(badge => badge.textContent === ""));
  assert.equal(harness.controller.clock.running, false);
});


test("explicit Play continues through an all-camera recording gap and resumes selected cameras", async t => {
  const target = Date.parse("2026-09-10T09:00:00-07:00") / 1000;
  let tick = 1000;
  const harness = createHistoricalHarness({
    now: () => tick,
    availabilityResponder: recordingCoverageResponder(Object.fromEntries(["drive_up", "drive_down"]
      .map(camera => [camera, [{ start: target - 30, end: target + 5 },
        { start: target + 20, end: target + 100 }]]))),
    initialReviewRange: { from: target - 60, to: target + 300 }
  });
  t.after(() => harness.close());
  harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  await harness.controller.playHistorical(target, { autoplay: false });
  const players = [...harness.controller._historicalPlayers.values()];
  const selected = [...harness.controller.state.reviewAssignments];
  for (const control of harness.mediaControls) control.emitFrame();
  assert.ok(players.every(player => player.heldCanvas?.hidden));
  assert.equal(harness.controller.resumePlayback(), true);
  tick = 11000;
  for (const player of players) {
    harness.controller.leaveHistoricalCamera(player, "authoritative_recording_gap", target + 10);
  }
  assert.equal(harness.controller.clock.running, true);
  assert.equal(harness.root.querySelector(".review-pause").disabled, false);
  assert.ok(players.every(player => player.holdStartedAtMs != null &&
    player.heldCanvas.hidden === false && player.statusElement.hidden));
  assert.ok(players.every(player => player.lifecycleState === "unavailable"));
  assert.ok([...harness.root.querySelectorAll(".review-camera-presentation-kind")]
    .every(badge => badge.textContent === "No recording" && !badge.hidden));
  assert.deepEqual(harness.controller.state.reviewAssignments, selected);
  assert.equal(harness.controller.reviewPosition, target + 10);
  assert.equal(harness.controller.pausePlayback(), true);
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.root.querySelector(".review-play").disabled, false);
  assert.equal(harness.controller.resumePlayback(), true);
  assert.equal(harness.controller.clock.running, true);
  tick = 26000;
  await harness.controller.evaluateHistoricalAvailability(null, { reason: "past_gap" });
  assert.ok(players.every(player => player.lifecycleState === "participating"));
  assert.equal(harness.controller.clock.running, true);
  assert.equal(harness.starts.length, 4);
  assert.ok([...harness.root.querySelectorAll(".review-camera-presentation-kind")]
    .every(badge => badge.textContent === ""));
  for (const control of harness.mediaControls.slice(2)) control.emitFrame();
  assert.ok(players.every(player => player.heldCanvas.hidden &&
    player.holdStartedAtMs == null && player.statusElement.hidden));
  assert.ok([...harness.root.querySelectorAll(".review-camera-presentation-kind")]
    .every(badge => badge.textContent === ""));
  assert.deepEqual(harness.controller.state.reviewAssignments, selected);
  assert.equal(harness.controller.getSceneExperimentReport(), null);
});


test("transport is in the shell header above one uninterrupted camera wall", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const workspace = harness.root.querySelector(".review-media-workspace");
  assert.equal(workspace.children.length, 1);
  assert.equal(workspace.children[0].className, "review-camera-wall");
  assert.equal(workspace.querySelector(".review-transport"), null);
  assert.strictEqual(
    harness.root.querySelector(".review-transport").parentElement,
    harness.transportRoot
  );
  assert.deepEqual(
    [...workspace.querySelector(".review-camera-wall").children]
      .map(child => child.classList.contains("review-layout-cell")),
    new Array(16).fill(true)
  );
  assert.equal(harness.root.querySelector(".review-previous-event").disabled, true);
  assert.equal(harness.root.querySelector(".review-next-event").disabled, true);
  assert.equal(harness.root.querySelectorAll(".review-query-go").length, 0);
  assert.equal(harness.root.querySelector(".review-when-apply").textContent, "Apply");
  for (const [selector, label] of [
    [".review-previous-event", "Snap to previous event"],
    [".review-back-ten", "Back 10 seconds"],
    [".review-pause", "Pause"],
    [".review-play", "Play"],
    [".review-forward-ten", "Forward 10 seconds"],
    [".review-next-event", "Snap to next event"]
  ]) {
    assert.equal(harness.root.querySelector(selector).getAttribute("aria-label"), label);
  }
  assert.equal(harness.root.querySelector(".review-now"), null);
  assert.equal(harness.root.querySelector(".review-return-live"), null);
  const controls = harness.root.querySelector(".review-transport-controls");
  const speed = harness.root.querySelector(".review-speed-select");
  assert.strictEqual(speed.parentElement, controls.querySelector(".review-speed-group"));
  assert.equal(controls.querySelector(".review-vcr-group").children.length, 6);
  assert.deepEqual([...controls.children].map(child => child.className), [
    "review-toolbar-group review-vcr-group",
    "review-toolbar-group review-speed-group"
  ]);
  assert.deepEqual([...speed.options].map(option => option.textContent), [
    "0.25x", "0.50x", "0.75x", "1x", "2x", "4x", "8x"
  ]);
  assert.equal(harness.root.querySelectorAll(".review-transport-controls button").length, 6);
  assert.equal(workspace.querySelectorAll(".review-layout-cell:not([hidden])").length, 13);
  assert.equal(harness.root.textContent.includes("Review live"), false);
});


test("Review exposes speeds through 8x and rejects 16x without changing playback", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  assert.deepEqual(REVIEW_PLAYBACK_SPEEDS, [0.25, 0.5, 0.75, 1, 2, 4, 8]);
  assert.deepEqual([...harness.root.querySelector(".review-speed-select").options]
    .map(option => option.textContent), ["0.25x", "0.50x", "0.75x", "1x", "2x", "4x", "8x"]);
  assert.equal(controller.setPlaybackSpeed(8), true);
  const initialClockRate = controller.clock.rate;
  assert.equal(controller.setPlaybackSpeed(16), false);
  assert.equal(controller.state.playbackSpeed, 8);
  assert.equal(controller.clock.rate, initialClockRate);
  assert.equal(harness.root.querySelector(".review-speed-select").value, "8");
});


test("historical speed is shared, rate-aware, and retained through live return and re-entry", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  assert.deepEqual(REVIEW_PLAYBACK_SPEEDS, [0.25, 0.5, 0.75, 1, 2, 4, 8]);
  assert.equal(harness.controller.state.playbackSpeed, 1);
  const assignments = [...harness.controller.state.reviewAssignments];
  await harness.controller.playHistorical(1800000000);
  const before = harness.controller.clock.absoluteTime;
  assert.equal(harness.controller.setPlaybackSpeed(8), true);
  const after = harness.controller.clock.absoluteTime;
  assert.ok(after >= before && after - before < 0.1);
  assert.equal(harness.controller.clock.rate, 8);
  assert.ok([...harness.controller._historicalPlayers.values()].every(
    player => player.video.playbackRate === 8
  ));
  harness.controller.returnToLive();
  assert.equal(harness.controller.state.playbackSpeed, 8);
  assert.deepEqual(harness.controller.state.reviewAssignments, assignments);
  assert.ok([...harness.root.querySelectorAll("hui-image.review-live-camera")].every(
    image => !Object.hasOwn(image, "playbackRate")
  ));
  harness.controller.deactivate();
  harness.controller.activate();
  assert.equal(harness.controller.state.playbackSpeed, 8);
  assert.equal(harness.root.querySelector(".review-speed-select").value, "8");
});


test("Review speed stays enabled before acquisition and disables after Review deactivation", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const { controller } = harness;
  const speed = harness.root.querySelector(".review-speed-select");
  assert.equal(controller._presentationMode, "live");
  assert.equal(controller._historicalPlayers.size, 0);
  assert.equal(speed.disabled, false);
  assert.equal(controller.setPlaybackSpeed(4), true);
  assert.equal(controller.state.playbackSpeed, 4);
  assert.equal(controller.clock.rate, 4);
  assert.equal(speed.disabled, false);
  controller.deactivate();
  controller.updateTransport();
  assert.equal(controller._active, false);
  assert.equal(harness.root.querySelector(".review-speed-select"), null);
  assert.equal(harness.transportRoot.querySelector(".review-speed-select"), null);
});


test("Review speed eligibility is independent of playback and camera lifecycle state", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const { controller } = harness;
  const speed = harness.root.querySelector(".review-speed-select");
  const player = {
    lifecycleState: "unavailable",
    video: null,
    hls: null,
    heldCanvas: { hidden: false },
    heldFrameEpoch: 1800000000
  };
  controller._historicalPlayers = new Map([["Drive Up", player]]);
  for (const presentationMode of ["live", "historical"]) {
    controller._presentationMode = presentationMode;
    for (const preparing of [false, true]) {
      controller._historicalPreparing = preparing;
      for (const lifecycleState of ["preparing", "participating", "unavailable", "failed"]) {
        player.lifecycleState = lifecycleState;
        controller.updateTransport();
        assert.equal(speed.disabled, false,
          `${presentationMode}, preparing=${preparing}, camera=${lifecycleState}`);
      }
    }
  }
});


test("speed stays enabled during owned pending Play and changes clock and existing media in place", async t => {
  let releasePlay;
  const playGate = new Promise(resolve => { releasePlay = resolve; });
  const harness = createHistoricalHarness({ playResponder: () => playGate });
  t.after(() => {
    releasePlay();
    harness.close();
  });
  const target = 1800000000;
  const run = harness.controller.playHistorical(target);
  await waitForCondition(() => !harness.controller._historicalPreparing &&
    [...harness.controller._historicalPlayers.values()].length > 0 &&
    [...harness.controller._historicalPlayers.values()].every(player =>
      player.transition?.reason === "play_release" && player.transition.playPending));
  const players = [...harness.controller._historicalPlayers.values()];
  const videos = players.map(player => player.video);
  const hls = players.map(player => player.hls);
  assert.equal(harness.controller.clock.running, true);
  assert.ok(players.every(player => player.lifecycleState === "preparing" &&
    player.transition?.reason === "play_release" && player.transition.playPending &&
    harness.controller.isCurrentCameraTransition(player, player.transition)));

  const speed = harness.root.querySelector(".review-speed-select");
  assert.equal(speed.disabled, false);
  const clockBefore = harness.controller.clock.absoluteTime;
  const pauseCounts = videos.map(video => video.pauseCount);
  const seeks = videos.map(video => [...video.currentTimeWrites]);
  const playCount = harness.playCalls.length;
  const hlsCount = harness.instances.length;

  let availabilityEvaluations = 0;
  harness.controller.queueHistoricalAvailabilityEvaluation = () => {
    availabilityEvaluations += 1;
    return Promise.resolve([]);
  };
  harness.controller._autoSnapArmed = true;
  harness.controller._autoSnapActiveEnd = clockBefore + 60;
  speed.value = "4";
  speed.dispatchEvent(new harness.window.Event("change"));

  assert.equal(harness.controller.clock.rate, 4);
  assert.ok(Math.abs(harness.controller.clock.absoluteTime - clockBefore) < 0.1);
  assert.ok(players.every(player => player.video.playbackRate === 4));
  assert.ok(players.every((player, index) => player.video === videos[index] &&
    player.hls === hls[index]));
  assert.deepEqual(videos.map(video => video.pauseCount), pauseCounts);
  assert.deepEqual(videos.map(video => video.currentTimeWrites), seeks);
  assert.equal(harness.playCalls.length, playCount);
  assert.equal(harness.instances.length, hlsCount);
  assert.equal(availabilityEvaluations, 0);
  assert.notEqual(harness.controller._historicalBoundaryTimer, null);

  releasePlay();
  await run;
  assert.ok(players.every(player =>
    player.lifecycleState === "participating" && player.transition === null));
});


test("speed remains enabled without qualifying stale or cancelled Play transitions", async t => {
  for (const disposition of ["stale", "cancelled"]) {
    let releasePlay;
    const playGate = new Promise(resolve => { releasePlay = resolve; });
    const harness = createHistoricalHarness({ playResponder: () => playGate });
    t.after(() => {
      releasePlay();
      harness.close();
    });
    harness.controller.setSelectedCameraNames(["Drive Up"]);
    await harness.controller.flushScheduledReviewQuery();
    const run = harness.controller.playHistorical(1800000000);
    await waitForCondition(() => !harness.controller._historicalPreparing &&
      harness.controller._historicalPlayers.get("Drive Up")?.transition?.reason === "play_release" &&
      harness.controller._historicalPlayers.get("Drive Up")?.transition?.playPending);
    const player = harness.controller._historicalPlayers.get("Drive Up");
    const transition = player.transition;
    assert.equal(harness.root.querySelector(".review-speed-select").disabled, false);

    if (disposition === "stale") {
      transition.requestId += 1;
    } else {
      transition.hls = null;
      harness.controller.cancelCameraTransition(player);
    }
    harness.controller.updateTransport();
    assert.equal(harness.root.querySelector(".review-speed-select").disabled, false,
      `${disposition} transition does not determine Review speed availability`);
    const pauseCount = player.video.pauseCount;
    const seekWrites = [...player.video.currentTimeWrites];
    const playbackAttempts = harness.playCalls.length;
    assert.equal(harness.controller.setPlaybackSpeed(2), true);
    assert.equal(player.video.pauseCount, pauseCount);
    assert.deepEqual(player.video.currentTimeWrites, seekWrites);
    assert.equal(harness.playCalls.length, playbackAttempts);
    releasePlay();
    await run;
  }
});


test("slow Review speeds use the existing shared control through seek, pause, and reacquisition", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const target = 1800000000;
  await harness.controller.playHistorical(target);
  const players = [...harness.controller._historicalPlayers.values()];
  const videos = players.map(player => player.video);
  const hls = players.map(player => player.hls);
  const initialSeeks = videos.map(video => video.currentTimeWrites.length);
  const instanceCount = harness.instances.length;
  const speed = harness.root.querySelector(".review-speed-select");

  for (const rate of [0.75, 0.5, 0.25]) {
    speed.value = String(rate);
    speed.dispatchEvent(new harness.window.Event("change"));
    assert.equal(harness.controller.state.playbackSpeed, rate);
    assert.equal(harness.controller.clock.rate, rate);
    assert.ok(players.every(player => player.video.playbackRate === rate));
    assert.deepEqual(videos.map(video => video.currentTimeWrites.length), initialSeeks);
    assert.deepEqual(players.map(player => player.video), videos);
    assert.deepEqual(players.map(player => player.hls), hls);
    assert.equal(harness.instances.length, instanceCount);
  }

  harness.controller.pausePlayback();
  assert.equal(harness.controller.clock.running, false);
  assert.ok(players.every(player => player.video.paused && player.video.playbackRate === 0.25));
  harness.controller.resumePlayback();
  assert.equal(harness.controller.clock.running, true);
  assert.ok(players.every(player => !player.video.paused && player.video.playbackRate === 0.25));

  await harness.controller.seekHistoricalToEpoch(target + 5, { autoplay: true });
  assert.ok(players.every((player, index) =>
    player.video === videos[index] && player.hls === hls[index] &&
    player.video.playbackRate === 0.25));

  harness.controller.returnToLive();
  assert.equal(harness.controller.state.playbackSpeed, 0.25);
  assert.ok([...harness.root.querySelectorAll("hui-image.review-live-camera")].every(
    image => !Object.hasOwn(image, "playbackRate")
  ));
  await harness.controller.playHistorical(target + 60);
  const replacements = [...harness.controller._historicalPlayers.values()];
  assert.ok(replacements.every((player, index) =>
    player.video !== videos[index] && player.video.playbackRate === 0.25));
  const replacementSeeks = replacements.map(player => player.video.currentTimeWrites.length);
  const replacementHls = replacements.map(player => player.hls);
  const replacementCount = harness.instances.length;

  const currentSpeed = harness.root.querySelector(".review-speed-select");
  currentSpeed.value = "1";
  currentSpeed.dispatchEvent(new harness.window.Event("change"));
  assert.equal(harness.controller.state.playbackSpeed, 1);
  assert.equal(harness.controller.clock.rate, 1);
  assert.ok(replacements.every(player => player.video.playbackRate === 1));
  assert.deepEqual(replacements.map(player => player.video.currentTimeWrites.length), replacementSeeks);
  assert.deepEqual(replacements.map(player => player.hls), replacementHls);
  assert.equal(harness.instances.length, replacementCount);
});


test("ReviewClock advances at the selected historical speed", () => {
  let now = 1000;
  const clock = new ReviewClock(() => now);
  clock.setAbsolute(100);
  clock.setRate(16);
  clock.start();
  now = 2250;
  assert.equal(clock.absoluteTime, 120);
  clock.setRate(0.25);
  now = 4250;
  assert.equal(clock.absoluteTime, 120.5);
});


test("historical Pause and Play preserve and resume the shared ReviewClock", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  await harness.controller.playHistorical(1800000000);
  for (const control of harness.mediaControls) control.emitFrame();
  const players = [...harness.controller._historicalPlayers.values()];
  assert.ok(players.every(player => player.heldCanvas?.hidden));
  const pause = harness.root.querySelector(".review-pause");
  const play = harness.root.querySelector(".review-play");
  assert.equal(pause.disabled, false);
  assert.equal(play.disabled, true);
  pause.click();
  const pausedAt = harness.controller.clock.absoluteTime;
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.controller.clock.absoluteTime, pausedAt);
  assert.ok(players.every(player => player.lifecycleState === "participating" &&
    player.heldCanvas.hidden && player.holdStartedAtMs == null));
  assert.ok([...harness.root.querySelectorAll(".review-camera-presentation-kind")]
    .every(badge => badge.textContent === ""));
  assert.equal(pause.disabled, true);
  assert.equal(play.disabled, false);
  play.click();
  assert.equal(harness.controller.clock.running, true);
  assert.equal(pause.disabled, false);
  assert.equal(play.disabled, true);
});


for (const enabled of [false, true]) {
  for (const history of ["missing", "empty", "full", "modified"]) {
    test(`relative seek isolation: diagnostics=${enabled}, history=${history}`, async t => {
      const base = 1800000000;
      const h = createHistoricalHarness({ now: () => 1000 });
      t.after(() => h.close());
      const c = h.controller;
      c.setHistoricalSyncDiagnostics(enabled);
      await c.playHistorical(base, { autoplay: false });
      const players = [...c._historicalPlayers.values()];
      const videos = players.map(p => p.video);
      const request = c._reviewRequestId;
      c._navigationDiagnostics = history === "missing" ? undefined : history === "empty" ? [] :
        Array.from({ length: history === "full" ? 32 : 1 }, () => ({
          requestedEpoch: base - 1000, selectedEpoch: base + 1000, outcome: "completed"
        }));
      const operation = c.seekHistoricalRelative("10");
      assert.equal(c.clock.absoluteTime, base + 10, "navigation commits before awaiting acquisition");
      assert.equal(c._reviewRequestId, request + 1);
      assert.equal(await operation, true);
      assert.equal(c.clock.absoluteTime, base + 10);
      assert.equal(c.playbackRequested, false);
      assert.deepEqual(players.map(p => p.video), videos);
      assert.deepEqual(videos.map(v => v.currentTime), [31, 32]);
    });
  }
}


for (const playing of [false, true]) {
  test(`relative seek isolation: throwing recorder preserves real seek and Pause (playing=${playing})`, async t => {
    const base = 1800000000;
    const h = createHistoricalHarness({ now: () => 1000 });
    t.after(() => h.close());
    const c = h.controller;
    await c.playHistorical(base, { autoplay: playing });
    const request = c._reviewRequestId;
    const starts = h.starts.length;
    const trace = [];
    const seek = c.seekHistoricalToEpoch.bind(c);
    c.seekHistoricalToEpoch = (target, options) => {
      trace.push(["seek", target, options.autoplay, options.source]);
      return seek(target, options);
    };
    c.recordReviewNavigation = (diagnostic, completed) => {
      trace.push(["record", diagnostic.ownerRequestId, completed]);
      throw new Error("optional recorder failed");
    };
    const operation = c.seekHistoricalRelative(10);
    assert.deepEqual(trace, [["seek", base + 10, playing, "VCR seek"]]);
    assert.equal(c.clock.absoluteTime, base + 10);
    assert.equal(c._reviewRequestId, request + 1);
    if (playing) assert.equal(c.pausePlayback(), true);
    const result = await operation;
    assert.equal(result, true);
    assert.equal(trace.length, 2);
    assert.equal(trace[1][0], "record");
    assert.equal(trace[1][1], request + 1);
    assert.equal(trace[1][2], result);
    assert.equal(c.clock.absoluteTime, base + 10);
    assert.equal(c.clock.running, false);
    assert.equal(c.playbackRequested, false);
    assert.equal(c._playbackPreparation, null);
    assert.equal(h.starts.length, starts);
  });
}


for (const synchronous of [false, true]) {
  test(`relative seek isolation: recorder cannot replace original rejection (sync=${synchronous})`, async t => {
    const h = createHistoricalHarness({ now: () => 1000 });
    t.after(() => h.close());
    const c = h.controller;
    await c.playHistorical(1800000000, { autoplay: false });
    const original = new Error("original seek failure");
    let calls = 0;
    let cleaned = false;
    c.seekHistoricalToEpoch = () => {
      calls += 1;
      if (synchronous) { cleaned = true; throw original; }
      return Promise.reject(original).finally(() => { cleaned = true; });
    };
    c.recordReviewNavigation = () => { throw new Error("recorder failure"); };
    await assert.rejects(c.seekHistoricalRelative(10), error => error === original);
    assert.equal(calls, 1);
    assert.equal(cleaned, true);
    assert.equal(c.clock.absoluteTime, 1800000000);
    assert.equal(c.playbackRequested, false);
  });
}


test("relative seek isolation: diagnostic construction failure cannot prevent navigation", async t => {
  const h = createHistoricalHarness({ now: () => 1000 });
  t.after(() => h.close());
  const c = h.controller;
  await c.playHistorical(1800000000, { autoplay: false });
  Object.defineProperty(c, "_navigationDiagnosticSequence", {
    get() { throw new Error("diagnostic construction failed"); }
  });
  assert.equal(await c.seekHistoricalRelative(-10), true);
  assert.equal(c.clock.absoluteTime, 1799999990);
  assert.equal(c.playbackRequested, false);
});


for (const scenario of [
  { name: "lower clamp", from: -20, to: 20, delta: -100, expected: -20 },
  { name: "upper clamp", from: -20, to: 20, delta: 100, expected: 20 },
  { name: "future range before now", from: -20, to: 60, delta: 5, expected: 5 },
  { name: "live edge", from: -20, to: 60, delta: 10, live: true }
]) {
  test(`relative seek isolation: ${scenario.name} survives recorder failure`, async t => {
    const base = 1800000000;
    const h = createHistoricalHarness({ now: () => 1000,
      wallClockMs: (base + (scenario.to <= 20 ? 100 : 10)) * 1000 });
    t.after(() => h.close());
    const c = h.controller;
    await c.playHistorical(base, { autoplay: false, playbackRange: {
      from: base + scenario.from, to: base + scenario.to
    } });
    c.recordReviewNavigation = () => { throw new Error("recorder failure"); };
    assert.equal(await c.seekHistoricalRelative(scenario.delta), true);
    assert.equal(c._presentationMode, scenario.live ? "live" : "historical");
    if (!scenario.live) assert.equal(c.clock.absoluteTime, base + scenario.expected);
    assert.equal(c.playbackRequested, false);
  });
}


test("relative seek isolation: supersession preserves the newer request despite recorder failure", async t => {
  const base = 1800000000;
  const h = createHistoricalHarness({ now: () => 1000 });
  t.after(() => h.close());
  const c = h.controller;
  await c.playHistorical(base, { autoplay: false });
  const request = c._reviewRequestId;
  const recordedOwners = [];
  c.recordReviewNavigation = diagnostic => {
    recordedOwners.push(diagnostic.ownerRequestId);
    throw new Error("recorder failure");
  };
  const first = c.seekHistoricalRelative(10);
  const second = c.seekHistoricalRelative(20);
  assert.equal(c._reviewRequestId, request + 2);
  assert.equal(c.clock.absoluteTime, base + 30);
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.deepEqual(recordedOwners.sort((a, b) => a - b), [request + 1, request + 2]);
  assert.equal(c.clock.absoluteTime, base + 30);
  assert.equal(c.playbackRequested, false);
  assert.ok([...c._historicalPlayers.values()].every(p => p.requestId === request + 2));
});


test("minus and plus ten derive coordinated player positions from ReviewClock", async t => {
  const harness = createHistoricalHarness({ debug: true, now: () => 1000 });
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  harness.controller.pausePlayback();
  const pausedAt = harness.controller.clock.absoluteTime;
  const instanceCount = harness.instances.length;
  await harness.controller.seekHistoricalRelative(-10);
  const backTarget = pausedAt - 10;
  const vcrReport = harness.controller.getLatestHistoricalSyncReport();
  assert.equal(vcrReport.source, "VCR seek");
  assert.equal(vcrReport.selectedEpoch, backTarget);
  assert.equal(vcrReport.summary.barrierDeltaSeconds, 0);
  assert.equal(vcrReport.cameras["Drive Up"].requestedMediaTime, backTarget - (1800000000 - 21));
  assert.equal(harness.controller.clock.absoluteTime, backTarget);
  assert.deepEqual(
    [...harness.controller._historicalPlayers.values()].map(player => player.video.currentTime),
    [backTarget - (1800000000 - 21), backTarget - (1800000000 - 22)]
  );
  await harness.controller.seekHistoricalRelative(10);
  assert.equal(harness.controller.getHistoricalSyncReports().length, 3);
  assert.equal(harness.controller.clock.absoluteTime, pausedAt);
  assert.deepEqual(
    [...harness.controller._historicalPlayers.values()].map(player => player.video.currentTime),
    [pausedAt - (1800000000 - 21), pausedAt - (1800000000 - 22)]
  );
  assert.equal(harness.instances.length, instanceCount);
  assert.equal(harness.controller.clock.running, false);
});


test("skip crossing the prepared range uses the existing VOD preparation path", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  harness.controller.pausePlayback();
  const pausedAt = harness.controller.clock.absoluteTime;
  const previousInstances = harness.instances.length;
  await harness.controller.seekHistoricalRelative(-20);
  assert.equal(harness.controller.clock.absoluteTime, pausedAt - 20);
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.instances.length, previousInstances + 2);
  assert.equal(
    harness.calls.filter(call =>
      call.type === "frigate_max/v1/vod/prepare" && call.target === pausedAt - 20
    ).length,
    2
  );
});


test("Primary+12 physical cells retain legitimate blanks", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const wall = harness.root.querySelector(".review-camera-wall");
  assert.equal(wall.querySelectorAll(".review-layout-cell:not([hidden])").length, 13);
  assert.strictEqual(
    wall.querySelector('[data-review-slot="1"] .review-camera-panel').dataset.camera,
    "Drive Down"
  );
  assert.equal(wall.querySelectorAll(".review-layout-cell:not([hidden]):empty").length, 11);
  harness.controller.setSelectedCameraNames(["Drive Up"]);
  assert.equal(wall.querySelectorAll('[data-review-slot]:not([data-review-slot="0"]) .review-camera-panel').length, 0);
  assert.equal(wall.querySelectorAll(".review-layout-cell:not([hidden]):empty").length, 12);
  harness.controller.setSelectedCameraNames([]);
  assert.ok(harness.root.querySelector(".review-empty-state"));
  assert.equal(wall.querySelectorAll(".review-camera-panel").length, 0);
});


test("civil days use the requested timezone and retain DST day lengths", () => {
  assert.equal(getCivilDayKey(Date.parse("2026-09-08T02:00:00Z"), "America/Los_Angeles"), "2026-09-07");
  assert.equal(getCivilDayBounds("2026-03-08", "America/Los_Angeles").durationHours, 23);
  assert.equal(getCivilDayBounds("2026-11-01", "America/Los_Angeles").durationHours, 25);
  assert.equal(getCivilDayBounds("2026-09-08", "America/Los_Angeles").durationHours, 24);
});


test("diagnostics and raw timestamp controls are gated out by default", () => {
  const window = new Window();
  const root = window.document.createElement("section");
  const controller = new ReviewController({
    documentRef: window.document,
    datePickerFactory: null
  });
  controller.configure(cameras());
  controller.mount(root);
  controller.activate();
  assert.equal(root.querySelector(".review-diagnostics"), null);
  assert.equal(root.querySelectorAll("input.review-range-picker").length, 2);
  assert.equal(root.querySelector(".review-target"), null);
  assert.equal(root.textContent.includes("2026-09-08T14:00:00-07:00"), false);
  controller.setDebug(true);
  assert.ok(root.querySelector(".review-known-target"));
  controller.deactivate();
  window.close();
});


test("one unavailable recording does not guess or block another camera", async t => {
  const harness = createHistoricalHarness({ unavailable: new Set(["drive_up"]) });
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  assert.equal(up.unavailable, true);
  assert.equal(up.message, "No recording at this time.");
  assert.equal(up.statusElement.hidden, true);
  assert.match(up.statusElement.textContent, /No recording/);
  assert.equal(down.unavailable, false);
  assert.equal(harness.starts.length, 1);
  assert.match(harness.controller._historicalStatus, /Some cameras/);
  assert.equal(harness.root.querySelector(".review-historical-state"), null);
  assert.deepEqual(harness.controller.state.reviewAssignments.slice(0, 2), ["Drive Up", "Drive Down"]);
});


test("all unavailable cameras retain cells while the investigation clock advances", async t => {
  const harness = createHistoricalHarness({ now: () => 1000, unavailable: new Set(["drive_up", "drive_down"]) });
  t.after(() => harness.close());
  const assignments = [...harness.controller.state.reviewAssignments];
  const target = harness.controller.state.reviewRange.from + 1200;
  await harness.controller.selectTimelineTime(target);
  assert.equal(harness.starts.length, 0);
  assert.equal(harness.controller.clock.running, true);
  assert.equal(harness.controller.state.presentationMode, "historical");
  assert.match(harness.controller._historicalStatus, /No recording/);
  assert.equal(harness.root.querySelector(".review-historical-state"), null);
  assert.equal(harness.root.querySelectorAll(".review-camera-panel").length, 2);
  const badges = [...harness.root.querySelectorAll(".review-camera-presentation-kind")];
  assert.equal(badges.length, 2);
  assert.ok(badges.every(badge => badge.textContent === "" && badge.hidden));
  assert.deepEqual(harness.controller.state.reviewAssignments, assignments);
  assert.equal(harness.root.querySelector(".review-back-ten").disabled, true);
  assert.equal(harness.root.querySelector(".review-play").disabled, true);
  assert.equal(harness.root.querySelector(".review-speed-select").disabled, false);
  const evaluations = [];
  harness.controller.queueHistoricalAvailabilityEvaluation = reason => {
    evaluations.push(reason);
    return Promise.resolve([]);
  };
  assert.equal(harness.controller.setPlaybackSpeed(2), true);
  assert.equal(harness.controller.state.playbackSpeed, 2);
  assert.equal(harness.controller.clock.rate, 2);
  assert.equal(harness.controller.clock.absoluteTime, target);
  assert.deepEqual(evaluations, []);
});


test("zero participating cameras produce no VOD request or layout mutation", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller.setSelectedCameraNames([]);
  await harness.controller.flushScheduledReviewQuery();
  const assignments = [...harness.controller.state.reviewAssignments];
  const target = harness.controller.state.reviewRange.from + 1200;
  await harness.controller.selectTimelineTime(target);
  assert.equal(harness.calls.some(call => call.type === "frigate_max/v1/vod/prepare"), false);
  assert.equal(harness.controller.clock.running, true);
  assert.notEqual(harness.controller._diagnosticTimer, null);
  assert.match(harness.controller._historicalStatus, /No recording/);
  assert.equal(harness.root.querySelector(".review-historical-state"), null);
  assert.deepEqual(harness.controller.state.reviewAssignments, assignments);
  assert.ok(harness.root.querySelector(".review-empty-state"));
});


test("historical loading and VCR states are compact and keep event controls disabled", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createHistoricalHarness({ prepareGate: gate });
  t.after(() => harness.close());
  const target = harness.controller.state.reviewRange.from + 1200;
  const run = harness.controller.selectTimelineTime(target, "timeline click", false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.controller.state.historicalPreparing, true);
  assert.match(harness.controller._historicalStatus, /Preparing playback/);
  assert.ok([...harness.root.querySelectorAll(".review-camera-status")]
    .every(status => status.hidden));
  assert.equal(harness.root.querySelector(".review-speed-select").disabled, false);
  assert.equal(harness.root.querySelector(".review-historical-state"), null);
  assert.ok([...harness.root.querySelectorAll(".review-camera-presentation-kind")]
    .every(badge => badge.textContent === ""));
  assert.equal(harness.root.querySelector(".review-pause").disabled, true);
  release();
  await run;
  assert.equal(harness.root.querySelector(".review-back-ten").disabled, false);
  assert.equal(harness.root.querySelector(".review-pause").disabled, true);
  assert.equal(harness.root.querySelector(".review-play").disabled, false);
  assert.equal(harness.root.querySelector(".review-forward-ten").disabled, false);
  assert.equal(harness.root.querySelector(".review-speed-select").disabled, false);
  assert.equal(harness.root.querySelector(".review-now"), null);
  assert.equal(harness.root.querySelector(".review-previous-event").disabled, true);
  assert.equal(harness.root.querySelector(".review-next-event").disabled, true);
});


test("explicit Play intent during preparation releases through the normal path", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createHistoricalHarness({ prepareGate: gate });
  t.after(() => harness.close());
  const target = harness.controller.state.reviewRange.from + 1200;
  const run = harness.controller.selectTimelineTime(target, "timeline click", false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.controller.state.historicalPreparing, true);
  assert.equal(harness.root.querySelector(".review-play").disabled, false);
  harness.root.querySelector(".review-play").click();
  assert.equal(harness.controller.clock.running, true);
  release();
  await run;
  assert.equal(harness.starts.length, 2);
  assert.equal(harness.controller.clock.running, true);
  assert.equal(harness.root.querySelector(".review-play").disabled, true);
  assert.equal(harness.root.querySelector(".review-pause").disabled, false);
});


test("four historical players in 2x2 keep identical per-cell viewport structure without Ready flow", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const four = [...cameras().filter(camera => camera.active), {
    name: "Side", entity: "camera.side", active: true
  }];
  harness.controller._hass.states["camera.side"] = { attributes: { camera_name: "side" } };
  harness.controller.configure(four);
  harness.controller.setReviewLayout("2x2");
  harness.controller.setSelectedCameraNames(["Drive Up", "Drive Down", "Back", "Side"]);
  await harness.controller.flushScheduledReviewQuery();
  await harness.controller.selectTimelineTime(harness.controller.state.reviewRange.from + 1200);
  const cells = [...harness.root.querySelectorAll('.review-layout-cell:not([hidden])')];
  assert.equal(cells.length, 4);
  assert.equal(harness.root.querySelectorAll("video.review-historical-video").length, 4);
  for (const cell of cells) {
    const panel = cell.querySelector(":scope > .review-camera-panel");
    const media = panel.querySelector(":scope > .review-camera-media");
    const video = media.querySelector(":scope > video.review-historical-video");
    const status = media.querySelector(":scope > .review-camera-status");
    assert.strictEqual(panel.parentElement, cell);
    assert.strictEqual(video.parentElement, media);
    assert.equal(status.hidden, true);
    assert.equal(status.textContent, "");
    assert.strictEqual(panel.querySelector(":scope > .review-camera-overlay").parentElement, panel);
  }
  assert.equal(harness.root.textContent.includes("Ready"), false);
});


test("a rapid second Timeline selection retires the first request and wins", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const firstTarget = harness.controller.state.reviewRange.from + 600;
  const secondTarget = firstTarget + 300;
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const originalCallWS = harness.controller._hass.callWS.bind(harness.controller._hass);
  harness.controller._hass.callWS = message => {
    if (message.type === "frigate_max/v1/vod/prepare" && message.target === firstTarget) {
      harness.calls.push(JSON.parse(JSON.stringify(message)));
      const origin = message.camera === "drive_up" ? message.target - 21 : message.target - 22;
      return firstGate.then(() => prepared(message.camera, origin, message.target));
    }
    return originalCallWS(message);
  };
  const first = harness.controller.selectTimelineTime(firstTarget);
  for (let index = 0; index < 10 && harness.calls.filter(call =>
    call.type === "frigate_max/v1/vod/prepare" && call.target === firstTarget).length < 2; index += 1) {
    await Promise.resolve();
  }
  const second = harness.controller.selectTimelineTime(secondTarget);
  await second;
  releaseFirst();
  await first;
  assert.equal(harness.controller.clock.absoluteTime >= secondTarget, true);
  assert.equal(harness.controller.clock.absoluteTime < secondTarget + 1, true);
  assert.equal(harness.starts.length, 2);
  assert.ok(harness.starts.every(path => path.startsWith("/signed/")));
  assert.equal(harness.controller._historicalPlayers.size, 2);
});


test("Timeline historical playback stops at a past active To and returns live at now", async t => {
  const past = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS });
  t.after(() => past.close());
  await past.controller.refreshReviewQuery();
  const now = Date.parse("2026-09-10T12:00:00-07:00") / 1000;
  past.controller._reviewRange = { from: now - 120, to: now - 60 };
  past.controller._desiredReviewRange = { ...past.controller._reviewRange };
  past.controller._displayedReviewQuery.range = { ...past.controller._reviewRange };
  await past.controller.selectTimelineTime(now - 90);
  past.controller.clock.pause();
  past.controller.clock.setAbsolute(now - 60);
  past.controller.clock.start();
  assert.equal(past.controller.enforceHistoricalPlaybackBoundary(), true);
  assert.equal(past.controller.state.presentationMode, "historical");
  assert.equal(past.controller.clock.running, false);
  assert.equal(past.controller.clock.absoluteTime, now - 60);

  past.controller.clock.setAbsolute(now - 65);
  past.controller.clock.start();
  await past.controller.seekHistoricalRelative(10);
  assert.equal(past.controller.clock.absoluteTime, now - 60);
  assert.equal(past.controller.clock.running, false);

  const straddling = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS });
  t.after(() => straddling.close());
  await straddling.controller.refreshReviewQuery();
  straddling.controller._reviewRange = { from: now - 120, to: now + 60 };
  straddling.controller._desiredReviewRange = { ...straddling.controller._reviewRange };
  straddling.controller._displayedReviewQuery.range = { ...straddling.controller._reviewRange };
  await straddling.controller.selectTimelineTime(now - 30);
  straddling.controller.clock.pause();
  straddling.controller.clock.setAbsolute(now);
  straddling.controller.clock.start();
  assert.equal(straddling.controller.enforceHistoricalPlaybackBoundary(), true);
  assert.equal(straddling.controller.state.presentationMode, "live");
  assert.equal(straddling.root.querySelectorAll("hui-image.review-live-camera").length, 2);

  await straddling.controller.selectTimelineTime(now - 5);
  await straddling.controller.seekHistoricalRelative(10);
  assert.equal(straddling.controller.state.presentationMode, "live");
});


test("returning to Review live destroys historical resources", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  const videos = harness.instances.map(instance => instance.video);
  harness.controller.returnToLive();
  assert.equal(harness.controller.state.presentationMode, "live");
  assert.equal(harness.root.querySelectorAll("hui-image.review-live-camera").length, 2);
  assert.ok(harness.instances.every(instance => instance.destroyCount === 1));
  assert.ok(videos.every(video => video.pauseCount >= 1 && video.loadCount >= 1));
});


test("returning live during timing preparation prevents late HLS resources", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createHistoricalHarness({ prepareGate: gate });
  t.after(() => harness.close());
  const run = harness.controller.playHistorical(1800000000);
  await Promise.resolve();
  harness.controller.returnToLive();
  release();
  await run;
  assert.equal(harness.instances.length, 0);
  assert.equal(harness.controller._historicalPlayers.size, 0);
  assert.equal(harness.controller.state.presentationMode, "live");
});


test("Review uses only HA WebSocket routes and normalized timing cannot leak internals", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  assert.ok(harness.calls.some(call => call.type === "frigate_max/v1/vod/prepare"));
  assert.ok(harness.calls.some(call => call.type === "auth/sign_path"));
  assert.ok(harness.calls.every(call => !JSON.stringify(call).includes("http://192.168")));
  const safe = normalizePreparedTiming({
    ...prepared("drive_up", 1799999979),
    path: "/media/private.mp4",
    password: "synthetic-secret"
  }, "drive_up");
  assert.equal(Object.hasOwn(safe, "path"), false);
  assert.equal(Object.hasOwn(safe, "password"), false);
  assert.equal(JSON.stringify(safe).includes("synthetic-secret"), false);
});


test("continuous handoff prototype planning requires one coverage interval across the full successor range", () => {
  const active = prepared("garage", 1799999978);
  const successor = buildReviewRange(active.requested_end);
  const continuous = normalizeRecordingAvailability({
    camera: "garage",
    requested_start: successor.start,
    requested_end: successor.end,
    coverage: [{ start: successor.start, end: successor.end }]
  }, "garage");
  const gap = normalizeRecordingAvailability({
    camera: "garage",
    requested_start: successor.start,
    requested_end: successor.end,
    coverage: [
      { start: successor.start, end: active.requested_end },
      { start: active.requested_end + 10, end: successor.end }
    ]
  }, "garage");
  assert.equal(planContinuousHandoffPrototype(active, continuous).allowed, true);
  assert.equal(planContinuousHandoffPrototype(active, gap).allowed, false);
});


test("Garage prototype replaces one HLS source on the same video with absolute timing and rate intact", async t => {
  let tick = 0;
  const harness = createHistoricalHarness({ now: () => tick });
  t.after(() => harness.close());
  configureGarage(harness);
  const target = 1800000000;
  const run = harness.controller.runContinuousHandoffPrototype({ targetEpoch: target, rate: 1 });
  await waitForCalls(harness, "frigate_max/v1/vod/prepare", 2);
  const player = harness.controller._historicalPlayers.get("Garage");
  const video = player.video;
  const firstHls = player.hls;
  const boundary = target + 120;
  tick = 120000;
  video.currentTime = boundary - player.timing.effective_absolute_origin;
  video.dispatchEvent(new harness.window.Event("ended"));
  const report = await run;

  assert.equal(report.outcome, "completed");
  assert.strictEqual(harness.controller._historicalPlayers.get("Garage").video, video);
  assert.equal(firstHls.destroyCount, 1);
  assert.equal(report.handoff.sameVideoElement, true);
  assert.equal(report.handoff.reviewClockBefore, boundary);
  assert.equal(report.handoff.reconstructedSuccessorEpoch, boundary);
  assert.equal(report.handoff.playbackRateBefore, 1);
  assert.equal(report.handoff.playbackRateAfterAttachment, 1);
  assert.equal(report.handoff.playbackRateAfterHandoff, 1);
  assert.equal(report.handoff.actualPausedAfterHandoff, false);
  assert.equal(harness.playCalls.length, 2);
  assert.equal(JSON.stringify(report).includes("/signed/"), false);
  assert.equal(JSON.stringify(report).includes("authSig"), false);
});


test("Garage prototype preserves 0.25x across one successor handoff", async t => {
  let tick = 0;
  const harness = createHistoricalHarness({ now: () => tick });
  t.after(() => harness.close());
  configureGarage(harness);
  const target = 1800000000;
  const run = harness.controller.runContinuousHandoffPrototype({ targetEpoch: target, rate: 0.25 });
  await waitForCalls(harness, "frigate_max/v1/vod/prepare", 2);
  const player = harness.controller._historicalPlayers.get("Garage");
  const boundary = target + 120;
  tick = 480000;
  player.video.currentTime = boundary - player.timing.effective_absolute_origin;
  player.video.dispatchEvent(new harness.window.Event("ended"));
  const report = await run;

  assert.equal(report.outcome, "completed");
  assert.equal(report.handoff.reviewClockBefore, boundary);
  assert.equal(report.handoff.reconstructedSuccessorEpoch, boundary);
  assert.equal(report.handoff.playbackRateBefore, 0.25);
  assert.equal(report.handoff.playbackRateAfterAttachment, 0.25);
  assert.equal(report.handoff.playbackRateAfterHandoff, 0.25);
  assert.equal(harness.controller.clock.rate, 0.25);
});


test("Garage prototype keeps paused intent through successor readiness", async t => {
  let tick = 0;
  const harness = createHistoricalHarness({ now: () => tick });
  t.after(() => harness.close());
  configureGarage(harness);
  const target = 1800000000;
  const run = harness.controller.runContinuousHandoffPrototype({ targetEpoch: target, rate: 1 });
  await waitForCalls(harness, "frigate_max/v1/vod/prepare", 2);
  const player = harness.controller._historicalPlayers.get("Garage");
  const boundary = target + 120;
  harness.controller.pausePlayback();
  harness.controller.clock.setAbsolute(boundary);
  player.video.currentTime = boundary - player.timing.effective_absolute_origin;
  player.video.dispatchEvent(new harness.window.Event("ended"));
  const report = await run;

  assert.equal(report.handoff.playIntentBefore, "paused");
  assert.equal(report.handoff.actualPausedAfterHandoff, true);
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.playCalls.length, 1);
});


test("Garage prototype rejects a successor made stale by a context change", async t => {
  let releaseAvailability;
  const availabilityGate = new Promise(resolve => { releaseAvailability = resolve; });
  const harness = createHistoricalHarness({
    availabilityResponder: message => availabilityGate.then(() => ({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: [{ start: message.start, end: message.end }]
    }))
  });
  t.after(() => harness.close());
  configureGarage(harness);
  const run = harness.controller.runContinuousHandoffPrototype({
    targetEpoch: 1800000000,
    rate: 1
  });
  await waitForCalls(harness, "frigate_max/v1/recordings/availability", 1);
  harness.controller.returnToLive();
  releaseAvailability();
  await assert.rejects(run, /cancelled|stale/i);
  assert.equal(harness.controller.getContinuousHandoffPrototypeReport().outcome, "stale");
  assert.equal(harness.controller.state.presentationMode, "live");
});


test("Garage prototype stops planning when normalized coverage contains a genuine gap", async t => {
  let availabilityCalls = 0;
  const harness = createHistoricalHarness({
    // The responder counts playback lookups; keep timeline coverage out of the order.
    recordingCoverage: false,
    availabilityResponder: message => {
      availabilityCalls += 1;
      return Promise.resolve({
        camera: message.camera,
        requested_start: message.start,
        requested_end: message.end,
        coverage: [{
          start: message.start,
          end: availabilityCalls === 1 ? message.end : message.start + 15
        }]
      });
    }
  });
  t.after(() => harness.close());
  configureGarage(harness);
  const report = await harness.controller.runContinuousHandoffPrototype({
    targetEpoch: 1800000000,
    rate: 1
  });
  assert.equal(report.outcome, "blocked-by-recording-gap");
  assert.equal(report.availability.permitsSuccessor, false);
  assert.equal(
    harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length,
    1
  );
});


test("recording availability cache uses bounded windows and half-open interval truth", () => {
  const target = 1800000000;
  const window = buildRecordingAvailabilityWindow(target);
  assert.deepEqual(window, { start: target - 3600, end: target + 3600 });
  const availability = normalizeRecordingAvailability({
    camera: "front_entry",
    requested_start: window.start,
    requested_end: window.end,
    coverage: [
      { start: target + 20, end: target + 50 },
      { start: target - 10, end: target }
    ]
  }, "front_entry");
  assert.deepEqual(availability.coverage, [
    { start: target - 10, end: target },
    { start: target + 20, end: target + 50 }
  ]);
  assert.equal(inspectRecordingAvailability(availability, target - 0.001).containing.end, target);
  assert.equal(inspectRecordingAvailability(availability, target).containing, null);
  assert.equal(inspectRecordingAvailability(availability, target).previousEnd, target);
  assert.equal(inspectRecordingAvailability(availability, target).nextStart, target + 20);
  assert.equal(inspectRecordingAvailability(availability, window.end).insideWindow, false);
});


test("completed events form one selected-camera union with original times and ongoing uncertainty", () => {
  const when = { from: 100, to: 200 };
  const items = normalizeReviewTimelineItems([
    { camera_id: "drive_up", start_time: 110, end_time: 130 },
    { camera_id: "drive_down", start_time: 125, end_time: 150 },
    { camera_id: "drive_up", start_time: 150, end_time: 230 },
    { camera_id: "drive_down", start_time: 170 },
    { camera_id: "back", start_time: 175, end_time: 180 },
    { camera_id: "drive_up", start_time: 90, end_time: 120 }
  ], when);
  assert.equal(items.find(item => item.start_time === 150).end_time, 230);
  assert.deepEqual(buildReviewEventIntervals(items, ["drive_up", "drive_down"], when), {
    intervals: [{ start: 110, end: 200 }], ongoingStarts: [170]
  });
  assert.deepEqual(buildReviewEventIntervals(items, ["drive_up"], when), {
    intervals: [{ start: 110, end: 130 }, { start: 150, end: 200 }], ongoingStarts: []
  });
});


test("Auto Snap plays from TI, merges camera intervals, advances, then stops without wrapping", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000, now: () => 1000,
    initialReviewRange: when, reviewEvents: [
      { camera_id: "drive_up", start_time: base, end_time: base + 20 },
      { camera_id: "drive_down", start_time: base + 15, end_time: base + 30 },
      { camera_id: "drive_up", start_time: base + 30, end_time: base + 40 },
      { camera_id: "drive_down", start_time: base + 100, end_time: base + 120 }
    ] });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  controller.setTimelineViewport({ from: base - 100, to: base + 200 });
  assert.equal(controller.resumePlayback(), true);
  assert.equal(controller.clock.running, true);
  assert.equal(controller._autoSnapActiveEnd, base + 40);
  assert.equal(controller.clock.absoluteTime, base + 5);
  controller.clock.setAbsolute(base + 40);
  controller.clock.start();
  assert.equal(controller.enforceAutoSnapBoundary(), true);
  await waitForCondition(() => controller.getRecentAutoSnapDecisions()[0]?.outcome === "advanced");
  assert.equal(controller.clock.absoluteTime, base + 100);
  assert.equal(controller._autoSnapActiveEnd, base + 120);
  assert.equal(controller.clock.running, true);
  controller.clock.setAbsolute(base + 120);
  controller.clock.start();
  assert.equal(controller.enforceAutoSnapBoundary(), true);
  assert.equal(controller.clock.running, false);
  assert.equal(controller.clock.absoluteTime, base + 120);
  assert.equal(controller.getRecentAutoSnapDecisions()[0].outcome, "finished");
  assert.equal(controller.resumePlayback(), false);
  assert.equal(controller.clock.absoluteTime, base + 120);
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);
});


// Diagnostic experiments: media progress is deliberately controlled separately
// from monotonic ReviewClock time. They demonstrate a possible mechanism, not
// browser decoder behavior or the cause of a particular runtime observation.
for (const rate of [1, 2, 4]) {
  for (const scenario of ["aligned", "presented frame trails by 2.5s", "Play settles after 750ms"]) {
    test(`Auto Snap event-end timing experiment at ${rate}x: ${scenario}`, async t => {
      const base = 1800000000;
      const start = base + 5;
      const end = base + 20;
      const when = { from: base - 100, to: base + 500 };
      let now = 1000;
      let releasePlay;
      const delayed = scenario === "Play settles after 750ms";
      const gate = delayed ? new Promise(resolve => { releasePlay = resolve; }) : null;
      const harness = createHistoricalHarness({
        now: () => now, wallClockMs: when.to * 1000, initialReviewRange: when,
        reviewEvents: [
          { camera_id: "drive_up", start_time: base, end_time: base + 12 },
          { camera_id: "drive_up", start_time: base + 10, end_time: end }
        ],
        playResponder: delayed ? () => gate : null
      });
      t.after(() => harness.close());
      harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
      harness.controller.setSelectedCameraNames(["Drive Up"]);
      const controller = await enterEventAutoSnap(harness, start, when);
      controller.setPlaybackSpeed(rate);
      const player = controller._historicalPlayers.get("Drive Up");
      const control = harness.mediaControls.find(item => item.video === player.video);
      const snapshots = [];
      let lastRvfc = null;
      const capture = phase => ({
        phase, eventStart: base, eventEnd: end, atMs: now,
        clockEpoch: controller.clock.absoluteTime, clockRate: controller.clock.rate,
        frameEpoch: player.heldFrameEpoch ?? null,
        rvfc: lastRvfc,
        currentTime: player.video?.currentTime ?? null,
        playbackRate: player.video?.playbackRate ?? null,
        participation: player.lifecycleState,
        heldFrameVisible: player.heldCanvas?.hidden === false,
        holdStartedAtMs: player.holdStartedAtMs ?? null,
        decision: controller.getRecentAutoSnapDecisions()[0] ?? null,
        targetEpoch: player.transition?.targetEpoch ?? player.lastTargetEpoch ?? null
      });
      const record = controller.recordAutoSnapDecision;
      controller.recordAutoSnapDecision = function (...args) {
        const result = record.apply(this, args);
        if (args[0] === "interval_end") snapshots.push(capture("interval_end"));
        return result;
      };
      assert.equal(controller.resumePlayback(), true);
      assert.equal(controller._autoSnapActiveEnd, end);
      if (delayed) {
        await waitForCondition(() => player.transition?.playPending === true);
        now += 750;
        assert.equal(controller.clock.absoluteTime, start + 0.75 * rate);
        snapshots.push(capture("pending_Play"));
        releasePlay();
      }
      await waitForCondition(() => player.lifecycleState === "participating" &&
        player.reviewPlay === "fulfilled");
      assert.equal(player.video.playbackRate, rate);
      const lag = delayed ? 0.75 * rate : scenario === "aligned" ? 0 : 2.5;

      // Capture the actual production boundary timer; fire it with controlled
      // monotonic time instead of waiting real seconds or forcing the clock.
      let scheduled;
      const setTimeout = harness.window.setTimeout;
      harness.window.setTimeout = (callback, delay) => {
        scheduled = { callback, delay };
        return 987654;
      };
      try { controller.scheduleHistoricalBoundaryTimer(); }
      finally { harness.window.setTimeout = setTimeout; }
      assert.equal(scheduled.delay, Math.ceil(((end - start) / rate -
        (delayed ? 0.75 : 0)) * 1000));
      now = 1000 + (end - start - 0.01) * 1000 / rate;
      assert.equal(controller.enforceAutoSnapBoundary(), false);
      now = 1000 + (end - start) * 1000 / rate;

      // Advance fake media naturally to a chosen presented epoch. No controller
      // seek or media replacement is used to produce the boundary decision.
      const frameEpoch = end - lag;
      player.video.requestVideoFrameCallback((atMs, metadata) => {
        lastRvfc = { atMs, mediaTime: metadata.mediaTime,
          epoch: mediaToEpoch(player.timing, metadata.mediaTime).epoch };
      });
      player.video.currentTime = epochToMedia(player.timing, frameEpoch).mediaTime;
      await Promise.resolve();
      control.emitFrame(player.video.currentTime);
      assert.equal(mediaToEpoch(player.timing, player.video.currentTime).epoch, frameEpoch);
      assert.equal(player.heldFrameEpoch, frameEpoch);
      const video = player.video;
      const hls = player.hls;
      const pauses = video.pauseCount;
      const seekWrites = video.currentTimeWrites.length;
      const plays = harness.playCalls.length;
      const failures = controller.getRecentReviewFailures().length;

      snapshots.push(capture("before_boundary"));
      scheduled.callback();

      assert.equal(controller.clock.absoluteTime, end);
      assert.equal(controller.clock.running, false);
      assert.equal(controller.getRecentAutoSnapDecisions()[0].outcome, "finished");
      const boundary = snapshots.find(item => item.phase === "interval_end");
      assert.equal(boundary.clockEpoch, end);
      assert.equal(boundary.eventEnd - boundary.frameEpoch, lag);
      assert.equal(boundary.rvfc.epoch, boundary.frameEpoch);
      assert.equal(boundary.rvfc.atMs, boundary.atMs);
      assert.equal(boundary.decision.outcome, "interval_end");
      assert.equal(boundary.participation, "participating");
      assert.equal(boundary.heldFrameVisible, false);
      assert.equal(player.video, video);
      assert.equal(player.hls, hls);
      assert.ok(video.pauseCount > pauses);
      assert.equal(video.currentTimeWrites.length, seekWrites);
      assert.equal(harness.playCalls.length, plays);
      assert.equal(controller.getRecentReviewFailures().length, failures);
      t.diagnostic(JSON.stringify({ rate, scenario, lagRecordingSeconds: lag,
        scheduledDelayMs: scheduled.delay, snapshots }));
    });
  }
}


test("Auto Snap boundary capture samples RVFC before clamping and includes the next decision", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  let now = 1000;
  const harness = createHistoricalHarness({ now: () => now,
    wallClockMs: when.to * 1000, initialReviewRange: when,
    reviewEvents: [
      { camera_id: "drive_up", start_time: base, end_time: base + 20 },
      { camera_id: "drive_up", start_time: base + 100, end_time: base + 120 }
    ] });
  t.after(() => harness.close());
  harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  const player = controller._historicalPlayers.get("Drive Up");
  assert.equal(controller.resumePlayback(), true);
  await waitForCondition(() => player.lifecycleState === "participating");
  const control = harness.mediaControls.find(item => item.video === player.video);
  control.emitFrame();
  let presentedAt = player.latestPresentedFrameAtMs;
  now = 1000 + (20 - 5) * 1000 + 250;
  player.video.currentTime = epochToMedia(player.timing, base + 6).mediaTime;
  control.emitFrame();
  presentedAt = player.latestPresentedFrameAtMs;
  assert.equal(controller.clock.absoluteTime, base + 20.25);
  const decisionsBefore = controller.getRecentAutoSnapDecisions();
  assert.equal(controller.enforceAutoSnapBoundary(), true);
  const capture = controller.getLastAutoSnapBoundaryCapture();
  assert.equal(capture.reviewClock.epoch, base + 20.25);
  assert.equal(controller.clock.absoluteTime, base + 100);
  assert.equal(capture.event.startEpoch, base);
  assert.equal(capture.event.endEpoch, base + 20);
  assert.equal(capture.cameras.length, 2);
  const driveUp = capture.cameras.find(camera => camera.camera === "Drive Up");
  assert.equal(driveUp.frame.status, "current");
  assert.equal(driveUp.frame.epoch, base + 6);
  assert.equal(driveUp.frame.ageMs, now - presentedAt);
  assert.equal(driveUp.frame.presentationId, player.presentationId);
  assert.equal(driveUp.frame.secondsBehindEventEnd, 14);
  assert.equal(driveUp.lifecycleState, "participating");
  assert.equal(driveUp.video.playbackRate, 1);
  assert.equal(driveUp.play.outcome, "fulfilled");
  assert.equal(Number.isFinite(driveUp.play.issueAtMs), true);
  assert.equal(Number.isFinite(driveUp.play.settlementAtMs), true);
  assert.equal(driveUp.play.firstPresentedAdvance.epoch, base + 6);
  assert.equal(capture.boundaryDecision.outcome, "interval_end");
  assert.equal(capture.nextDecision.outcome, "advanced");
  assert.equal(capture.nextTargetEpoch, base + 100);
  assert.ok(decisionsBefore.some(({ outcome }) => outcome === "playing_interval"));
  assert.ok(decisionsBefore.some(({ outcome }) => outcome === "play_requested"));
  assert.equal(Number.isFinite(capture.settlementAtMs), true);
  await waitForCondition(() => controller.getRecentAutoSnapDecisions()[0]?.outcome === "advanced");
  assert.equal(controller.getLastAutoSnapBoundaryCapture().nextDecision.outcome, "advanced");
  assert.equal(controller.getLastAutoSnapBoundaryCapture().settlementAtMs, now);
  assert.equal(controller.clock.running, true);
  assert.equal(controller.clock.absoluteTime >= base + 100, true);
});


test("Auto Snap boundary capture identifies missing and stale RVFC samples", async t => {
  for (const mode of ["missing", "stale"]) {
    const base = mode === "missing" ? 1800000000 : 1800001000;
    const when = { from: base - 100, to: base + 500 };
    let now = 1000;
    const harness = createHistoricalHarness({ now: () => now,
      wallClockMs: when.to * 1000, initialReviewRange: when,
      reviewEvents: [{ camera_id: "drive_up", start_time: base, end_time: base + 10 }] });
    t.after(() => harness.close());
    harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
    const controller = await enterEventAutoSnap(harness, base + 1, when);
    const player = controller._historicalPlayers.get("Drive Up");
    controller.resumePlayback();
    await waitForCondition(() => player.lifecycleState === "participating");
    if (mode === "missing") {
      player.latestPresentedFrameEpoch = null;
      player.latestPresentedFrameAtMs = null;
      player.latestPresentedFramePresentationId = null;
    } else {
      player.latestPresentedFrameEpoch = base + 1;
      player.latestPresentedFrameAtMs = now;
      player.latestPresentedFramePresentationId = player.presentationId;
    }
    now = mode === "stale" ? 2201 : 1200;
    assert.equal(controller.enforceAutoSnapBoundary(), false);
    now += 9000;
    assert.equal(controller.enforceAutoSnapBoundary(), true);
    const frame = controller.getLastAutoSnapBoundaryCapture().cameras
      .find(camera => camera.camera === "Drive Up").frame;
    assert.equal(frame.status, mode);
    assert.equal(frame.epoch, mode === "stale" ? base + 1 : null);
    assert.equal(frame.ageMs, mode === "stale" ? 10201 : null);
  }
});


test("Auto Snap boundary capture is bounded, detached, and sanitized", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  let now = 1000;
  const harness = createHistoricalHarness({ now: () => now,
    wallClockMs: when.to * 1000, initialReviewRange: when,
    reviewEvents: [{ camera_id: "drive_up", start_time: base, end_time: base + 10 }] });
  t.after(() => harness.close());
  harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  const controller = await enterEventAutoSnap(harness, base + 1, when);
  const player = controller._historicalPlayers.get("Drive Up");
  controller.resumePlayback();
  await waitForCondition(() => player.lifecycleState === "participating");
  assert.equal(controller.getLastAutoSnapBoundaryCapture(), null);
  controller.recordReviewFailure(player, { reason: "media_error", targetEpoch: base + 10 });
  controller.clock.setAbsolute(base + 10);
  controller.clock.start();
  assert.equal(controller.enforceAutoSnapBoundary(), true);
  const first = controller.getLastAutoSnapBoundaryCapture();
  first.cameras.find(camera => camera.camera === "Drive Up").camera = "mutated";
  first.nextDecision.outcome = "mutated";
  const detached = controller.getLastAutoSnapBoundaryCapture();
  assert.equal(detached.cameras.find(camera => camera.camera === "Drive Up").camera, "Drive Up");
  assert.notEqual(detached.nextDecision.outcome, "mutated");
  assert.equal(detached.cameras.some(camera => Object.hasOwn(camera, "hls")), false);
  assert.equal(/password|token|url|path|manifest/i.test(JSON.stringify(detached)), false);
  assert.equal(detached.nextDecision.outcome, "finished");
  assert.equal(detached.matchingFailures.length, 1);
  assert.equal(detached.matchingFailures[0].reason, "media_error");
  assert.deepEqual(Object.keys(detached.matchingFailures[0]).sort(),
    ["camera", "coverage", "outcome", "reason", "stage", "targetEpoch"]);
  const retainedAtMs = detached.capturedAtMs;
  controller._autoSnapArmed = true;
  controller._autoSnapActiveStart = base + 20;
  controller._autoSnapActiveEnd = base + 30;
  controller.clock.setAbsolute(base + 20);
  controller.clock.start();
  now += 10000;
  assert.equal(controller.enforceAutoSnapBoundary(), true);
  assert.notEqual(controller.getLastAutoSnapBoundaryCapture().capturedAtMs, retainedAtMs);
});


test("Auto Snap starts at the next event instead of playing recorded inactive time", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000, now: () => 1000,
    initialReviewRange: when, reviewEvents: [
      { camera_id: "drive_up", start_time: base + 100, end_time: base + 120, type: "motion" },
      { camera_id: "drive_down", start_time: base + 200, end_time: base + 230, type: "car" }
    ] });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base, when);
  controller.setTimelineViewport({ from: base - 100, to: base + 100 });
  assert.equal(controller.resumePlayback(), true);
  await waitForCondition(() => controller.getRecentAutoSnapDecisions()[0]?.outcome === "advanced");
  assert.equal(controller.clock.absoluteTime, base + 100);
  assert.equal(controller._autoSnapActiveEnd, base + 120);
  assert.equal(controller.clock.running, true);
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);
  assert.deepEqual(controller.state.timelineViewport.to - controller.state.timelineViewport.from, 300);
});


test("future When permits verified event playback but cannot prove a final event", async t => {
  const base = 1800000000;
  const now = base + 200;
  const when = { from: base - 100, to: base + 500 };
  const harness = createHistoricalHarness({ wallClockMs: now * 1000,
    initialReviewRange: when, reviewEvents: [
      { camera_id: "drive_up", start_time: base + 100, end_time: base + 120 },
      { camera_id: "drive_down", start_time: base + 150, end_time: base + 170 }
    ] });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  const queries = harness.calls.filter(call => call.type === "frigate_max/v1/review/get");
  assert.equal(queries.at(-1).to, now);
  assert.deepEqual(controller.state.timeline.queryRange, { from: when.from, to: now });
  assert.equal(controller.state.timeline.complete, true);
  assert.equal(controller.getRecentAutoSnapDecisions().length, 0);
  assert.equal(controller.resumePlayback(), true);
  assert.ok(controller.getRecentAutoSnapDecisions().some(decision =>
    decision.outcome === "play_requested"));
  assert.ok(controller.getRecentAutoSnapDecisions().some(decision =>
    decision.outcome === "seek_requested" && decision.targetEpoch === base + 100));
  await waitForCondition(() => controller.getRecentAutoSnapDecisions()[0]?.outcome === "advanced");
  assert.ok(controller.clock.absoluteTime >= base + 100 &&
    controller.clock.absoluteTime < base + 101);
  controller.clock.setAbsolute(base + 120);
  controller.clock.start();
  assert.equal(controller.enforceAutoSnapBoundary(), true);
  await waitForCondition(() => controller.getRecentAutoSnapDecisions().some(decision =>
    decision.outcome === "advanced" && decision.targetEpoch === base + 150));
  assert.ok(controller.clock.absoluteTime >= base + 150 &&
    controller.clock.absoluteTime < base + 151);
  controller.clock.setAbsolute(base + 170);
  controller.clock.start();
  assert.equal(controller.enforceAutoSnapBoundary(), true);
  assert.equal(controller.clock.running, false);
  assert.equal(controller.getRecentAutoSnapDecisions()[0].outcome, "awaiting_future_events");
  assert.equal(controller.getRecentAutoSnapDecisions().some(decision =>
    decision.outcome === "finished"), false);
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/review/get").length,
    queries.length);
});


test("future When query eligibility expires when its endpoint becomes historical", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  let now = base + 200;
  const harness = createHistoricalHarness({ wallClockMs: () => now * 1000,
    initialReviewRange: when, reviewEvents: [
      { camera_id: "drive_up", start_time: base + 100, end_time: base + 120 }
    ] });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  assert.equal(controller.getAutoSnapInventory()?.reachesWhenEnd, false);
  now = when.to + 1;
  assert.equal(controller.resumePlayback(), false);
  assert.equal(controller.getRecentAutoSnapDecisions()[0].outcome, "blocked_incomplete");
  await controller.refreshReviewQuery();
  assert.equal(controller.getAutoSnapInventory()?.reachesWhenEnd, true);
  assert.equal(controller.resumePlayback(), true);
  await waitForCondition(() => controller.getRecentAutoSnapDecisions()[0]?.outcome === "advanced");
});


test("future When still blocks incomplete event responses", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const harness = createHistoricalHarness({ wallClockMs: (base + 200) * 1000,
    initialReviewRange: when, reviewResponder: () => Promise.resolve([
      { camera_id: "drive_up", start_time: base + 100, end_time: base + 120 }
    ]) });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  assert.equal(controller.state.timeline.complete, false);
  assert.equal(controller.resumePlayback(), false);
  assert.deepEqual(controller.getRecentAutoSnapDecisions().slice(0, 2)
    .map(decision => decision.outcome), ["blocked_incomplete", "play_requested"]);
});


test("Auto Snap Play navigates immediately while camera preparation is pending", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000,
    initialReviewRange: when, reviewEvents: [
      { camera_id: "drive_up", start_time: base + 100, end_time: base + 120 }
    ] });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  controller._historicalPreparing = true;
  assert.equal(controller.resumePlayback(), true);
  assert.deepEqual(controller.getRecentAutoSnapDecisions().slice(0, 2)
    .map(decision => decision.outcome), ["advanced", "seek_requested"]);
  assert.equal(controller.clock.running, true);
});


test("ongoing events block skips and prevent a false final-event conclusion", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000, now: () => 1000,
    initialReviewRange: when, reviewEvents: [
      { camera_id: "drive_up", start_time: base, end_time: base + 20 },
      { camera_id: "drive_down", start_time: base + 10 },
      { camera_id: "drive_up", start_time: base + 100, end_time: base + 110 }
    ] });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  assert.equal(controller.resumePlayback(), true);
  controller.clock.setAbsolute(base + 20);
  controller.clock.start();
  assert.equal(controller.enforceAutoSnapBoundary(), true);
  assert.equal(controller.clock.running, false);
  assert.equal(controller.getRecentAutoSnapDecisions()[0].outcome, "blocked_ongoing");
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare" &&
    call.target === base + 100).length, 0);
  assert.equal(controller.resumePlayback(), false);
});


test("legacy, refreshing, and failed Review queries block automatic progression", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const event = { camera_id: "drive_up", start_time: base, end_time: base + 20 };
  let response = [event];
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000,
    initialReviewRange: when, reviewResponder: () => Promise.resolve(response) });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  assert.equal(controller.state.timeline.complete, false);
  assert.equal(controller.resumePlayback(), false);
  assert.equal(controller.getRecentAutoSnapDecisions()[0].outcome, "blocked_incomplete");
  response = { schema: 2, complete: true, items: [event] };
  await controller.refreshReviewQuery();
  assert.equal(controller.state.timeline.complete, true);
  controller._desiredReviewQuery = {
    ...controller._desiredReviewQuery,
    range: { from: when.from, to: when.to + 1 }
  };
  assert.equal(controller.resumePlayback(), false);
  assert.equal(controller.getRecentAutoSnapDecisions()[0].outcome, "blocked_incomplete");
  controller._desiredReviewQuery = {
    ...controller._desiredReviewQuery, range: { ...when }
  };
  let release;
  const originalCallWS = controller._hass.callWS.bind(controller._hass);
  controller._hass.callWS = message => message.type === "frigate_max/v1/review/get"
    ? new Promise(resolve => { release = resolve; }) : originalCallWS(message);
  const pending = controller.refreshReviewQuery();
  assert.equal(controller.state.timeline.refreshing, true);
  assert.equal(controller.resumePlayback(), false);
  release(response);
  await pending;
  assert.equal(controller.state.timeline.complete, true);
  controller._hass.callWS = message => message.type === "frigate_max/v1/review/get"
    ? Promise.reject(new Error("synthetic timeline failure")) : originalCallWS(message);
  await controller.refreshReviewQuery();
  assert.equal(controller.state.timeline.complete, false);
  assert.equal(controller.resumePlayback(), false);
  assert.equal(controller.getRecentAutoSnapDecisions()[0].outcome, "blocked_incomplete");
});


test("Auto Snap enters every event at its actual start, including fully unrecorded events", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const first = { start: base - 20, end: base + 30 };
  const last = { start: base + 200, end: base + 230 };
  const harness = createEventTimeHarness(t, { when,
    events: [0, 100, 200].map(offset => ({
      camera_id: "drive_up", start_time: base + offset, end_time: base + offset + 20 })),
    coverage: { drive_up: [first, last], drive_down: [first, last] } });
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  assert.equal(controller.resumePlayback(), true);
  setReviewTi(controller, base + 20);
  assert.equal(controller.enforceAutoSnapBoundary(), true);
  await waitForCondition(() => controller.getRecentAutoSnapDecisions()[0]?.outcome === "advanced");
  assert.equal(controller.clock.absoluteTime, base + 100, "the unrecorded event is not skipped");
  assert.equal(controller.clock.running, true, "the clock runs through unrecorded time");
  assert.equal(controller._autoSnapActiveEnd, base + 120);
  const players = [...controller._historicalPlayers.values()];
  assert.ok(players.every(player => player.lifecycleState === "unavailable" &&
    player.boundaryReason === "authoritative_recording_gap"), "absence is not failure");
  assert.equal(prepareTargets(harness).includes(base + 100), false);
  assert.equal(autoSnapOutcomes(controller).includes("skipped_unrecorded"), false);

  setReviewTi(controller, base + 120);
  assert.equal(controller.enforceAutoSnapBoundary(), true);
  await waitForCondition(() => controller.clock.absoluteTime === base + 200 &&
    controller.getRecentAutoSnapDecisions()[0]?.outcome === "advanced");
  assert.equal(controller.clock.running, true);
  await waitForCondition(() => players.every(player => player.lifecycleState === "participating"));
  assert.ok(players.every(player => player.lifecycleState === "participating"),
    "recorded video resumes at the next recorded event");
  assert.equal(controller._autoSnapActiveEnd, base + 220);

  setReviewTi(controller, base + 220);
  assert.equal(controller.enforceAutoSnapBoundary(), true);
  await waitForCondition(() => controller.getRecentAutoSnapDecisions()[0]?.outcome === "finished");
  assert.equal(controller.clock.absoluteTime, base + 220, "no wrap or rewind after the last event");
  assert.equal(controller.clock.running, false);
});


test("Auto Snap enters an event whose recording starts late and rejoins video as the clock advances", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const tick = { value: 1000 };
  const covered = [{ start: base + 8, end: base + 30 }];
  const harness = createEventTimeHarness(t, { when, tick,
    events: [{ camera_id: "drive_up", start_time: base, end_time: base + 30 }],
    coverage: { drive_up: covered, drive_down: covered } });
  const controller = await enterEventAutoSnap(harness, base - 50, when);
  assert.equal(controller.resumePlayback(), true);
  await waitForCondition(() => controller.getRecentAutoSnapDecisions()[0]?.outcome === "advanced");
  assert.equal(controller.clock.absoluteTime, base);
  assert.equal(controller.clock.running, true);
  assert.equal(controller._autoSnapActiveStart, base);
  const players = [...controller._historicalPlayers.values()];
  assert.ok(players.every(player => player.lifecycleState === "unavailable"));
  tick.value += 9000;
  assert.equal(controller.clock.absoluteTime, base + 9);
  await controller.queueHistoricalAvailabilityEvaluation("shared_interval");
  await waitForCondition(() => players.every(player => player.lifecycleState === "participating"),
    "cameras did not rejoin once recording began");
  assert.equal(controller.clock.running, true);
  assert.equal(controller.clock.absoluteTime, base + 9, "rejoin never moves the TI");
  assert.equal(controller._autoSnapActiveEnd, base + 30);
});


test("Auto Snap Play from an unrecorded TI inside an event plays in place", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const tick = { value: 1000 };
  const covered = [{ start: base + 8, end: base + 30 }];
  const harness = createEventTimeHarness(t, { when, tick,
    events: [{ camera_id: "drive_up", start_time: base, end_time: base + 30 }],
    coverage: { drive_up: covered, drive_down: covered } });
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  const prepares = prepareTargets(harness).length;
  assert.equal(controller.resumePlayback(), true);
  assert.equal(controller.getRecentAutoSnapDecisions()[0].outcome, "playing_interval");
  assert.equal(controller.clock.absoluteTime, base + 5, "the TI is not moved to coverage");
  assert.equal(controller.clock.running, true);
  assert.equal(controller._autoSnapActiveEnd, base + 30);
  assert.equal(prepareTargets(harness).length, prepares, "no seek to later coverage");
  tick.value += 4000;
  assert.equal(controller.clock.absoluteTime, base + 9);
});


test("Auto Snap continues through a recording gap inside an event", async t => {
  const target = UNRECORDED_TARGET;
  const when = { from: target - 60, to: target + 300 };
  const tick = { value: 1000 };
  const intervals = [{ start: target - 30, end: target + 5 },
    { start: target + 20, end: target + 100 }];
  const harness = createEventTimeHarness(t, { when, tick,
    events: [{ camera_id: "drive_up", start_time: target - 10, end_time: target + 60 }],
    coverage: { drive_up: intervals, drive_down: intervals } });
  const controller = await enterEventAutoSnap(harness, target, when);
  assert.equal(controller.resumePlayback(), true);
  assert.equal(controller.getRecentAutoSnapDecisions()[0].outcome, "playing_interval");
  const players = [...controller._historicalPlayers.values()];
  tick.value += 10000;
  for (const player of players) {
    controller.leaveHistoricalCamera(player, "authoritative_recording_gap", target + 10);
  }
  assert.equal(controller.clock.running, true);
  assert.equal(controller._autoSnapActiveEnd, target + 60, "Auto Snap keeps the same event");
  const decisions = controller.getRecentAutoSnapDecisions().length;
  tick.value += 11000;
  await controller.queueHistoricalAvailabilityEvaluation("shared_interval");
  await waitForCondition(() => players.every(player => player.lifecycleState === "participating"),
    "cameras did not rejoin after the in-event gap");
  assert.equal(controller.clock.absoluteTime, target + 21);
  assert.equal(controller.getRecentAutoSnapDecisions().length, decisions,
    "the gap produced no Auto Snap navigation");
});


test("Auto Snap merges overlapping events across cameras and rejoins only recorded cameras", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const tick = { value: 1000 };
  const harness = createEventTimeHarness(t, { when, tick,
    events: [
      { camera_id: "drive_up", start_time: base, end_time: base + 30 },
      { camera_id: "drive_down", start_time: base + 20, end_time: base + 60 }
    ],
    coverage: { drive_up: [], drive_down: [{ start: base + 20, end: base + 60 }] } });
  const controller = await enterEventAutoSnap(harness, base - 50, when);
  assert.equal(controller.resumePlayback(), true);
  await waitForCondition(() => controller.getRecentAutoSnapDecisions()[0]?.outcome === "advanced");
  assert.equal(controller.clock.absoluteTime, base, "the merged interval's actual start");
  assert.equal(controller._autoSnapActiveEnd, base + 60);
  assert.equal(controller.clock.running, true);
  tick.value += 21000;
  await controller.queueHistoricalAvailabilityEvaluation("shared_interval");
  const up = controller._historicalPlayers.get("Drive Up");
  const down = controller._historicalPlayers.get("Drive Down");
  await waitForCondition(() => down.lifecycleState === "participating",
    "the recorded camera did not rejoin");
  assert.equal(up.lifecycleState, "unavailable", "no peer coverage is claimed");
  assert.equal(controller.clock.absoluteTime, base + 21);
});


for (const speed of [1, 8]) {
  test(`Auto Snap event boundaries advance without rewind at ${speed}x`, async t => {
    const base = 1800000000;
    const when = { from: base - 100, to: base + 500 };
    const tick = { value: 1000 };
    const covered = [{ start: base - 20, end: base + 130 }];
    const harness = createEventTimeHarness(t, { when, tick,
      events: [
        { camera_id: "drive_up", start_time: base, end_time: base + 20 },
        { camera_id: "drive_down", start_time: base + 100, end_time: base + 120 }
      ],
      coverage: { drive_up: covered, drive_down: covered } });
    harness.controller.setPlaybackSpeed(speed);
    const controller = await enterEventAutoSnap(harness, base + 5, when);
    assert.equal(controller.resumePlayback(), true);
    tick.value += Math.ceil(16000 / speed);
    assert.ok(controller.clock.absoluteTime >= base + 20, "the clock passed the event end");
    assert.equal(controller.enforceAutoSnapBoundary(), true);
    assert.equal(controller.getLastAutoSnapBoundaryCapture().event.endEpoch, base + 20);
    await waitForCondition(() => controller.getRecentAutoSnapDecisions()[0]?.outcome === "advanced");
    assert.equal(controller.clock.absoluteTime, base + 100);
    assert.equal(controller.clock.running, true);
    tick.value += Math.ceil(5000 / speed);
    assert.equal(controller.clock.absoluteTime, base + 105, "selected speed is preserved");
    assert.equal(controller.enforceAutoSnapBoundary(), false, "no boundary inside the event");
  });
}


test("Auto Snap advances without inventing a gap or rewinding when event-start availability fails", async t => {
  const base = 1800000000;
  const eventStart = base + 8000;
  const when = { from: base - 100, to: base + 10000 };
  const first = { start: base - 20, end: base + 30 };
  const harness = createEventTimeHarness(t, { when,
    events: [
      { camera_id: "drive_up", start_time: base, end_time: base + 20 },
      { camera_id: "drive_up", start_time: eventStart, end_time: eventStart + 20 }
    ],
    coverage: { drive_up: [first], drive_down: [first] },
    onRequest: message => message.start > base + 1000
      ? Promise.reject(new Error("coverage failed")) : undefined });
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  assert.equal(controller.resumePlayback(), true);
  setReviewTi(controller, base + 20);
  assert.equal(controller.enforceAutoSnapBoundary(), true);
  await waitForCondition(() => [...controller._historicalPlayers.values()].every(player =>
    player.lifecycleState === "failed"));
  assert.equal(controller.clock.absoluteTime, eventStart, "literal event start despite lookup failure");
  assert.equal(controller.clock.running, true, "unknown coverage cannot stop the clock");
  assert.ok([...controller._historicalPlayers.values()].every(player =>
    player.boundaryReason !== "authoritative_recording_gap"), "no gap is inferred");
  assert.equal(prepareTargets(harness).some(epoch => epoch >= eventStart), false);
});


for (const supersession of ["Pause", "manual TI", "camera selection"]) {
  test(`Auto Snap ignores a stale event acquisition after ${supersession}`, async t => {
    const base = 1800000000;
    const eventStart = base + 8000;
    const when = { from: base - 100, to: base + 10000 };
    let releaseLookup;
    const lookup = new Promise(resolve => { releaseLookup = resolve; });
    const first = { start: base - 20, end: base + 30 };
    const harness = createEventTimeHarness(t, { when,
      events: [
        { camera_id: "drive_up", start_time: base, end_time: base + 20 },
        { camera_id: "drive_up", start_time: eventStart, end_time: eventStart + 20 }
      ],
      coverage: { drive_up: [first], drive_down: [first] },
      onRequest: message => message.start > base + 1000 ? lookup.then(() => ({
        camera: message.camera, requested_start: message.start,
        requested_end: message.end,
        coverage: [{ start: eventStart, end: eventStart + 20 }]
      })) : undefined });
    const controller = await enterEventAutoSnap(harness, base + 5, when);
    assert.equal(controller.resumePlayback(), true);
    setReviewTi(controller, base + 20);
    assert.equal(controller.enforceAutoSnapBoundary(), true);
    assert.equal(controller.getLastAutoSnapBoundaryCapture().nextDecision.outcome,
      "advanced");
    await waitForCondition(() => harness.calls.some(call =>
      call.type === "frigate_max/v1/recordings/availability" && call.start > base + 1000));
    if (supersession === "Pause") assert.equal(controller.pausePlayback(), true);
    let manual = null;
    if (supersession === "manual TI") {
      manual = controller.selectTimelineTime(base + 50, "manual TI", false);
    }
    if (supersession === "camera selection") {
      assert.equal(controller.setSelectedCameraNames(["Drive Up"]), true);
    }
    releaseLookup();
    await manual;
    await new Promise(resolve => setImmediate(resolve));
    // Navigation commits the TI at the boundary; Pause cancels only play intent,
    // so video may still be prepared, paused, at the event start the user sees.
    if (supersession !== "Pause") {
      assert.equal(prepareTargets(harness).includes(eventStart), false);
    }
    assert.equal(controller.getRecentAutoSnapDecisions().some(decision =>
      decision.outcome === "advanced" && decision.targetEpoch === eventStart), true);
    assert.equal(controller.clock.running, false);
    if (supersession === "Pause") {
      assert.equal(controller._playRequested, false);
      assert.equal(controller.clock.absoluteTime, eventStart, "Pause holds the event-start TI");
    }
    if (supersession === "manual TI") assert.equal(controller.clock.absoluteTime, base + 50);
  });
}


test("manual Snap and TI retain literal epochs when Auto Snap would choose later coverage", async t => {
  const base = 1800000000;
  const eventStart = base + 100;
  const when = { from: base - 100, to: base + 500 };
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000, now: () => 1000,
    initialReviewRange: when, reviewEvents: [
      { camera_id: "drive_up", start_time: base, end_time: base + 20 },
      { camera_id: "drive_up", start_time: eventStart, end_time: eventStart + 30 }
    ], availabilityResponder: recordingCoverageResponder({
      drive_up: [{ start: base - 20, end: base + 30 },
        { start: eventStart + 5, end: eventStart + 30 }],
      drive_down: [{ start: base - 20, end: base + 30 }]
    }) });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  assert.equal(await controller.snapToNextEvent(), true);
  assert.equal(controller.clock.absoluteTime, eventStart);
  assert.equal(controller.clock.running, false);
  assert.equal(harness.calls.some(call => call.type === "frigate_max/v2/vod/prepare" &&
    call.target === eventStart + 5), false);
  assert.equal(await controller.selectTimelineTime(eventStart + 1, "manual TI", false), true);
  assert.equal(controller.clock.absoluteTime, eventStart + 1);
  assert.equal(controller.clock.running, false);
});


test("Pause, manual Snap, and literal ten-second seeks supersede Auto Snap", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000, now: () => 1000,
    initialReviewRange: when, reviewEvents: [
      { camera_id: "drive_up", start_time: base, end_time: base + 20 },
      { camera_id: "drive_down", start_time: base + 100, end_time: base + 120 }
    ] });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  assert.equal(controller.resumePlayback(), true);
  assert.equal(controller.pausePlayback(), true);
  assert.equal(controller._autoSnapArmed, false);
  controller.clock.setAbsolute(base + 20);
  assert.equal(controller.enforceAutoSnapBoundary(), false);
  assert.equal(await controller.snapToNextEvent(), true);
  assert.equal(controller.clock.absoluteTime, base + 100);
  assert.equal(controller.clock.running, false);
  assert.equal(controller.resumePlayback(), true);
  assert.equal(controller._autoSnapActiveEnd, base + 120);
  assert.equal(await controller.seekHistoricalRelative(10), true);
  assert.equal(controller.clock.absoluteTime, base + 110);
  assert.equal(controller._autoSnapArmed, false);
  assert.equal(await controller.seekHistoricalRelative(-10), true);
  assert.equal(controller.clock.absoluteTime, base + 100);
});


test("manual TI placement disarms event progression until explicit Play", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000, now: () => 1000,
    initialReviewRange: when, reviewEvents: [
      { camera_id: "drive_up", start_time: base, end_time: base + 20 },
      { camera_id: "drive_down", start_time: base + 100, end_time: base + 120 }
    ] });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base + 5, when);
  assert.equal(controller.resumePlayback(), true);
  assert.equal(await controller.selectTimelineTime(base + 50, "manual TI", false), true);
  assert.equal(controller._autoSnapArmed, false);
  assert.equal(controller.clock.running, false);
  assert.equal(controller.clock.absoluteTime, base + 50);
  assert.equal(controller.resumePlayback(), true);
  await waitForCondition(() => controller.getRecentAutoSnapDecisions()[0]?.outcome === "advanced");
  assert.equal(controller.clock.absoluteTime, base + 100);
});


test("Pause supersedes pending automatic event acquisition", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const deferredSeek = new Set();
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000, now: () => 1000,
    deferredSeek, initialReviewRange: when, reviewEvents: [
      { camera_id: "drive_up", start_time: base + 100, end_time: base + 120 }
    ] });
  t.after(() => harness.close());
  const controller = await enterEventAutoSnap(harness, base, when);
  deferredSeek.add("Drive Up"); deferredSeek.add("Drive Down");
  assert.equal(controller.resumePlayback(), true);
  assert.ok(controller.getRecentAutoSnapDecisions().some(decision =>
    decision.outcome === "seek_requested"));
  await waitForCondition(() => harness.mediaControls.every(control =>
    control.video.currentTimeWrites.length >= 2));
  assert.equal(controller.pausePlayback(), true);
  for (const control of harness.mediaControls) control.completeSeek();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(controller._autoSnapArmed, false);
  assert.equal(controller.clock.running, false);
  assert.equal(controller.getRecentAutoSnapDecisions().some(decision =>
    decision.outcome === "advanced"), true);
});


test("Auto Snap diagnostics stay bounded and return detached records", () => {
  const harness = createHistoricalHarness();
  const controller = harness.controller;
  try {
    for (let index = 0; index < 100; index += 1) {
      controller.recordAutoSnapDecision("blocked_incomplete", 1800000000 + index);
    }
    const decisions = controller.getRecentAutoSnapDecisions();
    assert.ok(decisions.length > 0 && decisions.length < 100);
    decisions[0].outcome = "changed";
    assert.equal(controller.getRecentAutoSnapDecisions()[0].outcome, "blocked_incomplete");
    assert.equal(JSON.stringify(decisions).includes("password"), false);
  } finally {
    harness.close();
  }
});


test("Review navigation diagnostics remain bounded, detached, and sanitized", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 300 };
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000,
    initialReviewRange: when });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.playHistorical(base, {
    autoplay: false, updateDisplayedRange: false, playbackRange: when
  });
  const player = controller._historicalPlayers.get("Drive Up");
  player.camera.password = "fixture-only-password";
  player.camera.auth = { token: "fixture-token" };
  assert.equal(await controller.seekHistoricalRelative(10), true);
  const snapshot = controller.getReviewNavigationDiagnostics();
  assert.equal(snapshot.recent[0].selectedEpoch, base + 10);
  assert.equal(JSON.stringify(snapshot).includes("fixture-only-password"), false);
  assert.equal(JSON.stringify(snapshot).includes("fixture-token"), false);
  assert.equal(JSON.stringify(snapshot).includes('"hls"'), false);
  snapshot.recent[0].coverageDecision = "mutated";
  assert.notEqual(controller.getReviewNavigationDiagnostics().recent[0].coverageDecision, "mutated");
  for (let index = 0; index < 40; index += 1) {
    controller.recordReviewNavigation({
      id: index, selectedEpoch: base + 10, ownerRequestId: controller._reviewRequestId
    }, true);
  }
  assert.equal(controller.getReviewNavigationDiagnostics().recent.length, 32);
});


test("unchecked Auto Snap retains continuous playback across event boundaries", async t => {
  const base = 1800000000;
  const when = { from: base - 100, to: base + 500 };
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000, now: () => 1000,
    initialReviewRange: when, reviewEvents: [
      { camera_id: "drive_up", start_time: base, end_time: base + 20 }
    ] });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.playHistorical(base + 5, {
    autoplay: false, updateDisplayedRange: false, playbackRange: when
  });
  assert.equal(controller.resumePlayback(), true);
  controller.clock.setAbsolute(base + 50);
  controller.clock.start();
  assert.equal(controller.enforceAutoSnapBoundary(), false);
  assert.equal(controller.clock.running, true);
  assert.equal(controller._autoSnapActiveEnd, null);
});

test("an initially unavailable camera joins at Review TI without disturbing its peer", async t => {
  const target = 1800000000;
  const harness = createHistoricalHarness({ debug: true,
    now: () => 0,
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_down"
        ? [{ start: target + 5, end: target + 15 }]
        : [{ start: message.start, end: message.end }]
    })
  });
  t.after(() => harness.close());
  harness.controller.setPlaybackSpeed(8);
  await harness.controller.playHistorical(target);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const upHls = up.hls;
  const upPauseCount = up.video.pauseCount;
  const upSeekWrites = [...up.video.currentTimeWrites];
  const upRateWrites = [...up.video.playbackRateWrites];
  const upPlayCalls = harness.playCalls.filter(call => call.camera === "Drive Up").length;
  const upSource = upHls.source;
  assert.equal(down.lifecycleState, "unavailable");

  up.video.currentTime = target + 6 - up.timing.effective_absolute_origin;
  setReviewTi(harness.controller, target + 10);
  up.video.dispatchEvent(new harness.window.Event("timeupdate"));
  await waitForCondition(() => down.lifecycleState === "participating", "late join did not complete");

  assert.strictEqual(up.hls, upHls);
  assert.equal(upHls.source, upSource);
  assert.equal(up.video.pauseCount, upPauseCount);
  assert.equal(up.lifecycleState, "participating");
  assert.deepEqual(up.video.currentTimeWrites, [...upSeekWrites,
    target + 6 - up.timing.effective_absolute_origin]);
  assert.deepEqual(up.video.playbackRateWrites, upRateWrites);
  assert.equal(harness.playCalls.filter(call => call.camera === "Drive Up").length, upPlayCalls);
  assert.equal(down.video.playbackRate, 8);
  assert.equal(down.video.paused, false);
  const downPrepare = harness.calls.filter(call =>
    call.type === "frigate_max/v2/vod/prepare" && call.camera === "drive_down");
  assert.equal(downPrepare.length, 1);
  assert.equal(downPrepare[0].target, target + 10);
  assert.equal(down.resolvedEpoch, target + 10);
  const diagnostic = harness.controller.getLatestHistoricalSyncReport().cameras["Drive Down"];
  assert.equal(diagnostic.lifecycleState, "participating");
  assert.equal(diagnostic.transition.outcome, "participating");
  assert.deepEqual(diagnostic.availability.containing, { start: target + 5, end: target + 15 });
  assert.ok(diagnostic.boundaryEvents.some(event => event.kind === "join-complete"));
  assert.doesNotMatch(JSON.stringify(diagnostic), /authSig|\/signed\//);
});


test("a late join honors paused intent", async t => {
  const target = 1800000000;
  const harness = createHistoricalHarness({
    now: () => 0,
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_down"
        ? [{ start: target + 5, end: target + 15 }]
        : [{ start: message.start, end: message.end }]
    })
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  harness.controller.pausePlayback();
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  up.video.currentTime = target + 6 - up.timing.effective_absolute_origin;
  setReviewTi(harness.controller, target + 6);
  const starts = harness.starts.length;
  await harness.controller.evaluateHistoricalAvailability(null, {
    reason: "paused_boundary_test", autoplay: false
  });
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.video.paused, true);
  assert.equal(harness.starts.length, starts);
  assert.equal(harness.controller.clock.running, false);
});


test("rejoin stays preparing until a fresh owned RVFC frame lands", async t => {
  const target = 1800000000;
  const harness = createRejoinHarness(target, {
    deferredFrame: new Set(["Drive Down"])
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  setReviewTi(harness.controller, target + 6);
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const join = harness.controller.evaluateHistoricalAvailability(null, { reason: "rvfc_rejoin" });
  await waitForCondition(() => down.video?.currentTimeWrites?.length === 1);
  const control = harness.mediaControls.find(item => item.camera === "Drive Down");
  assert.equal(down.lifecycleState, "preparing");
  assert.equal(down.initialPlacement, null);
  assert.equal(harness.playCalls.filter(call => call.camera === "Drive Down").length, 0);
  control.video.dispatchEvent(new harness.window.Event("seeked"));
  control.video.dispatchEvent(new harness.window.Event("canplay"));
  assert.equal(down.lifecycleState, "preparing");
  control.emitFrame(control.video.currentTime, -1);
  assert.equal(down.lifecycleState, "preparing");
  control.emitFrame();
  await join;
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.initialPlacement.verifiedFrame, true);
  assert.equal(down.initialPlacement.requestId, down.requestId);
  assert.equal(down.initialPlacement.presentationId, down.presentationId);
  assert.equal(down.initialPlacement.landedEpoch, target + 6);
});


test("an obsolete rejoin RVFC callback cannot admit a newer presentation", async t => {
  const target = 1800000000;
  const harness = createRejoinHarness(target, {
    deferredFrame: new Set(["Drive Down"])
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  setReviewTi(harness.controller, target + 6);
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const oldJoin = harness.controller.evaluateHistoricalAvailability(null, { reason: "old_rejoin" });
  await waitForCondition(() => down.video?.currentTimeWrites?.length === 1);
  const oldControl = harness.mediaControls.find(item => item.camera === "Drive Down");
  const oldCallback = oldControl.pendingFrameCallbacks()[0];
  assert.ok(oldCallback);
  const newer = harness.controller.playHistorical(target + 30, { autoplay: false });
  await waitForCondition(() => harness.mediaControls.filter(item =>
    item.camera === "Drive Down").length === 2);
  const newControl = harness.mediaControls.findLast(item => item.camera === "Drive Down");
  await waitForCondition(() => newControl.video.currentTimeWrites.length === 1);
  const currentDown = harness.controller._historicalPlayers.get("Drive Down");
  oldCallback(0, { mediaTime: oldControl.video.currentTime,
    presentationTime: harness.controller._now() });
  assert.equal(currentDown.lifecycleState, "preparing");
  assert.equal(currentDown.initialPlacement, null);
  newControl.emitFrame();
  await Promise.all([oldJoin, newer]);
  assert.equal(currentDown.lifecycleState, "participating");
  assert.equal(currentDown.initialPlacement.requestedEpoch, target + 30);
  assert.equal(currentDown.initialPlacement.verifiedFrame, true);
});


test("rejoin refreshes its final seek from TI and obeys Pause during preparation", async t => {
  const target = 1800000000;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createRejoinHarness(target, {
    presentationResponder: message => message.camera === "drive_down"
      ? gate.then(() => presentationPrepared(message.camera, message.target - 20, message.target))
      : Promise.resolve(presentationPrepared(message.camera, message.target - 20, message.target))
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  setReviewTi(harness.controller, target + 6);
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const join = harness.controller.evaluateHistoricalAvailability(null, { reason: "moving_ti" });
  await waitForCondition(() => harness.calls.some(call =>
    call.type === "frigate_max/v2/vod/prepare" && call.camera === "drive_down"));
  setReviewTi(harness.controller, target + 9);
  assert.equal(harness.controller.pausePlayback(), true);
  release();
  await join;
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.resolvedEpoch, target + 9);
  assert.equal(down.initialPlacement.requestedEpoch, target + 9);
  assert.equal(down.video.paused, true);
  assert.equal(harness.playCalls.filter(call => call.camera === "Drive Down").length, 0);
});


test("rejoin uses current Play intent after Pause then Play during preparation", async t => {
  const target = 1800000000;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createRejoinHarness(target, {
    presentationResponder: message => message.camera === "drive_down"
      ? gate.then(() => presentationPrepared(message.camera, message.target - 20, message.target))
      : Promise.resolve(presentationPrepared(message.camera, message.target - 20, message.target))
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  setReviewTi(harness.controller, target + 6);
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const join = harness.controller.evaluateHistoricalAvailability(null, { reason: "intent_change" });
  await waitForCondition(() => down.lifecycleState === "preparing");
  assert.equal(harness.controller.pausePlayback(), true);
  assert.equal(harness.controller.resumePlayback(), true);
  release();
  await join;
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.video.paused, false);
  assert.equal(harness.playCalls.filter(call => call.camera === "Drive Down").length, 1);
});


test("rejoin follows the committed clock during an uncommitted Timeline preview", async t => {
  const target = 1800000000;
  const harness = createRejoinHarness(target);
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  setReviewTi(harness.controller, target + 6);
  harness.controller._timelineDrag = { previewEpoch: target + 50 };
  assert.equal(harness.controller.reviewPosition, target + 50);
  const down = harness.controller._historicalPlayers.get("Drive Down");
  await harness.controller.evaluateHistoricalAvailability(null, { reason: "timeline_preview" });
  harness.controller._timelineDrag = null;
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.resolvedEpoch, target + 6);
  assert.equal(down.initialPlacement.requestedEpoch, target + 6);
});


test("Pause interrupts an in-flight rejoin Play without admitting it early", async t => {
  const target = 1800000000;
  let resolvePlay;
  const pending = new Promise(resolve => { resolvePlay = resolve; });
  const harness = createRejoinHarness(target, {
    playResponder: camera => camera === "Drive Down" ? pending : Promise.resolve()
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  setReviewTi(harness.controller, target + 6);
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const join = harness.controller.evaluateHistoricalAvailability(null, { reason: "pending_play" });
  await waitForCondition(() => harness.playCalls.some(call => call.camera === "Drive Down"));
  assert.equal(down.lifecycleState, "preparing");
  assert.equal(harness.controller.pausePlayback(), true);
  await join;
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.video.paused, true);
  resolvePlay();
  await Promise.resolve();
  assert.equal(down.video.paused, true);
});


test("Play after interrupting a pending rejoin Play retries before admission", async t => {
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
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const join = harness.controller.evaluateHistoricalAvailability(null, { reason: "play_retry" });
  await waitForCondition(() => down.transition?.playPending === true);
  assert.equal(harness.controller.pausePlayback(), true);
  assert.equal(harness.controller.resumePlayback(), true);
  await join;
  assert.equal(downPlayCount, 2);
  assert.equal(down.lifecycleState, "participating");
  assert.equal(down.video.paused, false);
  resolveOldPlay();
});


test("a pending rejoin Play does not block healthy camera evaluation", async t => {
  const target = 1800000000;
  let resolvePlay;
  const pending = new Promise(resolve => { resolvePlay = resolve; });
  const harness = createRejoinHarness(target, {
    playResponder: camera => camera === "Drive Down" ? pending : Promise.resolve()
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target);
  setReviewTi(harness.controller, target + 6);
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const upHls = up.hls;
  const upPauseCount = up.video.pauseCount;
  const upPlayCount = harness.playCalls.filter(call => call.camera === "Drive Up").length;
  const join = harness.controller.evaluateHistoricalAvailability(null, { reason: "slow_camera_play" });
  await waitForCondition(() => down.transition?.playPending === true);
  const second = await harness.controller.evaluateHistoricalAvailability(null, {
    reason: "healthy_camera_progress"
  });
  assert.equal(second.find(item => item.camera === "Drive Up").result, "participating");
  assert.equal(second.find(item => item.camera === "Drive Down").result, "preparing");
  assert.equal(down.lifecycleState, "preparing");
  assert.strictEqual(up.hls, upHls);
  assert.equal(up.video.pauseCount, upPauseCount);
  assert.equal(harness.playCalls.filter(call => call.camera === "Drive Up").length, upPlayCount);
  resolvePlay();
  await join;
  assert.equal(down.lifecycleState, "participating");
});


test("queued availability lets a second camera rejoin while the first prepares", async t => {
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
        : message.camera === "back"
          ? [{ start: target + 10, end: target + 100 }]
          : [{ start: message.start, end: message.end }]
    }),
    presentationResponder: message => message.camera === "drive_down"
      ? downGate.then(() => presentationPrepared(message.camera, message.target - 20,
        message.target))
      : Promise.resolve(presentationPrepared(message.camera, message.target - 20,
        message.target))
  });
  t.after(() => harness.close());
  harness.controller.setSelectedCameraNames(["Drive Up", "Drive Down", "Back"]);
  await harness.controller.playHistorical(target, {
    cameraNames: ["Drive Up", "Drive Down", "Back"]
  });
  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  const back = harness.controller._historicalPlayers.get("Back");
  const upHls = up.hls;
  setReviewTi(harness.controller, target + 6);
  await harness.controller.queueHistoricalAvailabilityEvaluation("first_rejoin");
  await waitForCondition(() => down.lifecycleState === "preparing");
  setReviewTi(harness.controller, target + 11);
  await harness.controller.queueHistoricalAvailabilityEvaluation("second_rejoin");
  await waitForCondition(() => back.lifecycleState === "participating");
  assert.equal(down.lifecycleState, "preparing");
  assert.strictEqual(up.hls, upHls);
  assert.equal(up.lifecycleState, "participating");
  releaseDown();
  await waitForCondition(() => down.lifecycleState === "participating");
  assert.equal(down.initialPlacement.requestedEpoch, target + 11);
});


for (const offset of [0, 1, 2, 3, 4, 5, 6]) {
  test(`availability queue: a request ${offset} microtasks after an evaluation settles is never lost`, async t => {
    const queue = await createAvailabilityQueueHarness(t);
    const { controller, evaluations } = queue;
    let late = null;
    queue.onEvaluation = result => {
      queue.onEvaluation = null;
      late = (async () => {
        await result.catch(() => {});
        for (let index = 0; index < offset; index += 1) await Promise.resolve();
        const requestedAt = queue.next();
        await controller.queueHistoricalAvailabilityEvaluation("late_request");
        return requestedAt;
      })();
    };
    await controller.queueHistoricalAvailabilityEvaluation("first_request");
    const requestedAt = await late;
    const answering = evaluations.filter(entry => entry.start > requestedAt);
    assert.ok(answering.length >= 1, "the late request must cause a later evaluation");
    assert.ok(answering.every(entry => entry.end !== null),
      "the requester's promise settles only after its evaluation completes");
    assert.ok(evaluations.length <= 2, "one request causes at most one extra evaluation");
    assert.equal(controller._availabilityEvaluationPending, false);
    assert.equal(controller._availabilityEvaluationPromise, null);
  });
}
