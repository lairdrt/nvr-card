// Review views, When range, timeline and layouts.
import assert from "node:assert/strict";
import test from "node:test";
import {
  readFileSync
} from "node:fs";
import {
  Window
} from "happy-dom";
import {
  VIEWER_LAYOUTS,
  REVIEW_TIMELINE_CAMERA_COLORS,
  ReviewClock,
  formatNvrClockTime,
  ReviewController,
  calculateHistoricalSeek,
  getCivilDayBounds,
  shiftCivilDayKey,
  reviewTimelineEpochFromCoordinate,
  reviewTimelineMarkerGeometry,
  reviewTimelineMarkerTop
} from "../src/review/review-controller.js";
import {
  createTestHarness
} from "./helpers/nvr-card-harness.js";
import {
  cameras,
  prepared,
  presentationPrepared,
  setReviewTi,
  HARNESS_CALENDAR_WALL_CLOCK_MS,
  HARNESS_PLAYBACK_WALL_CLOCK_MS,
  createHistoricalHarness,
  getWhenEditor,
  changeWhenSelect,
  selectWhenDate,
  assertWhenControls,
  reviewMetadataCallCount,
  whenDateLabel,
  waitForHistoricalMedia,
  waitForCalls,
  waitForCondition,
  edgeScene,
  manualInitialDeadlines,
  RECOVERY_T,
  manualViewTimers,
  drainReview,
  bbPlay
} from "./review-controller-test-support.js";

test("deployed card cache-busts the Review controller with its build identifier", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(
    source,
    /review-controller\.js\?v=__NVR_BUILD__/
  );
});


test("deployment versions the Review Blackboard module with the same build identifier", () => {
  const controller = readFileSync(new URL("../src/review/review-controller.js", import.meta.url), "utf8");
  const deploy = readFileSync(new URL("../deploy-to-ha.ps1", import.meta.url), "utf8");
  assert.match(controller, /from "\.\/review-blackboard\.js\?v=__NVR_BUILD__";/);
  // Only the build placeholder in that import is substituted.
  assert.equal(controller.split("__NVR_BUILD__").length - 1, 1);
  const generated = controller.replaceAll("__NVR_BUILD__", "NVR test-build");
  assert.match(generated, /review-blackboard\.js\?v=NVR test-build/);
  assert.match(deploy, /\$ReviewControllerSourceContent\.Replace\(\$Placeholder, \$BuildIdentifier\)/);
  assert.match(deploy, /Generated Review controller still contains the build placeholder/);
});


test("wide layouts share rail widths while narrow Live navigation overlays full-width video", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(source, /--nvr-sidebar-width:\s*240px/);
  assert.match(source, /--nvr-sidebar-collapsed-width:\s*calc\(/);
  assert.match(source, /--nvr-sidebar-current-width:\s*var\(--nvr-sidebar-width\)/);
  assert.match(source, /\.nvr-shell\.sidebar-collapsed\s*{[\s\S]*?--nvr-sidebar-current-width:\s*var\(--nvr-sidebar-collapsed-width\)/);
  assert.match(source, /grid-template-columns:\s*var\(--nvr-sidebar-current-width\)\s*minmax\(0, 1fr\)/);
  assert.match(source, /grid-template-columns:\s*var\(--nvr-sidebar-current-width\) minmax\(360px, 1fr\)/);
  assert.match(source, /\.nvr-shell\.phone-layout\s*> \.camera-list\s*{[\s\S]*?width:\s*min\(var\(--nvr-sidebar-width\), 100%\)/);
  assert.match(source, /\.nvr-shell\.phone-layout\s*> \.sidebar-rail-top\s*{\s*display:\s*none/);
  assert.match(source, /\.nvr-shell\.phone-layout \.mobile-navigation-toggle\[hidden\]\s*{\s*display:\s*none !important/);
  assert.match(source, /\.nvr-shell\.phone-layout\s*> \.mobile-navigation-backdrop\s*{[\s\S]*?z-index:\s*99/);
  assert.match(source, /\.nvr-shell\.phone-layout\.mobile-navigation-open\s*> \.camera-list\s*{[\s\S]*?z-index:\s*100/);
});


test("rail shell shares large icons, clean rows, footer, and collapsed treatment", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(source, /grid-template-areas:\s*"rail-title title"\s*"cameras video"/);
  assert.match(source, /\.sidebar-rail-top\s*{[\s\S]*?border-right:\s*1px solid var\(--nvr-sidebar-divider\)/);
  assert.match(source, /\.camera-list\s*{[\s\S]*?border-right:\s*1px solid var\(--nvr-sidebar-divider\)/);
  assert.match(source, /--nvr-sidebar-icon-size:\s*26px/);
  assert.doesNotMatch(source, /--nvr-sidebar-collapsed-icon-size/);
  assert.match(source, /\.sidebar-toggle svg\s*{[\s\S]*?width:\s*var\(--nvr-sidebar-icon-size\)/);
  assert.match(source, /\.section-title ha-icon\s*{[\s\S]*?--mdc-icon-size:\s*var\(--nvr-sidebar-icon-size\)/);
  assert.match(source, /\.sidebar-section-header\s*{[\s\S]*?min-height:\s*var\(--nvr-sidebar-touch-target\)/);
  assert.match(source, /\.nvr-shell\.sidebar-collapsed\s+\.camera-list\s*{[\s\S]*?padding:\s*0 var\(--nvr-sidebar-collapsed-padding\) 0 5px/);
  assert.doesNotMatch(source, /\.nvr-shell\.sidebar-collapsed\s*> \.camera-list/);
  assert.match(source, /\.sidebar-rail-footer\s*{[\s\S]*?grid-column:\s*1;[\s\S]*?align-self:\s*end/);
  assert.match(source, /\.nvr-shell\.sidebar-collapsed \.sidebar-rail-footer\s*{\s*display:\s*none/);
  assert.doesNotMatch(source, /sidebar-rail-title/);
  assert.match(source, /\.nvr-shell\.sidebar-collapsed \.camera-list \.section-title > span,[\s\S]*?display:\s*none !important/);
});


test("Review wall reuses Live content padding and has no media toolbar row", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(source, /--nvr-content-padding:\s*4px/);
  assert.match(source, /\.review-media-workspace\s*{[\s\S]*?display:\s*block;[\s\S]*?padding:\s*var\(--nvr-content-padding\)/);
  assert.match(source, /\.main-area\s*{[\s\S]*?padding:\s*var\(--nvr-content-padding\)/);
  assert.match(source, /\.application-mode-control button\s*{[\s\S]*?width:\s*auto;[\s\S]*?min-height:\s*30px/);
});


test("Review date-time pickers retain the accepted dark field and selected-day contrast", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(source, /flatpickr-4\.6\.13\.min\.css/);
  assert.match(source, /\.review-range-field \.review-range-picker\s*{[\s\S]*?background:\s*#171f26;[\s\S]*?color:\s*#dce6ec;/);
  assert.match(source, /\.flatpickr-day\.selected,[\s\S]*?background:\s*#003a70;[\s\S]*?color:\s*#fff;/);
  assert.match(source, /\.flatpickr-time \.numInputWrapper > \.arrowUp,[\s\S]*?display:\s*none !important;/);
  assert.match(source, /\.review-direct-time\s*{[\s\S]*?grid-template-columns:\s*1fr 1fr/);
  assert.match(source, /\.review-direct-time select\s*{[\s\S]*?min-height:\s*44px/);
  assert.match(source, /\.review-when-controls\s*{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(source, /\.review-when-shortcuts\s*{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)[\s\S]*?margin-left:\s*var\(--review-when-control-offset\)[\s\S]*?width:\s*calc\(100% - var\(--review-when-control-offset\)\)/);
  assert.match(source, /\.review-when-apply\s*{[\s\S]*?margin-left:\s*var\(--review-when-control-offset\)[\s\S]*?width:\s*calc\(100% - var\(--review-when-control-offset\)\)/);
  assert.match(source, /\.review-section-content\s*{[\s\S]*?padding:\s*8px 6px 2px/);
  assert.match(source, /\.review-when-apply\s*{/);
});


test("mode switch and RHS selectors use compact tab styling", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(source, /\.application-mode-control button\s*{[\s\S]*?min-height:\s*30px;[\s\S]*?border-bottom:\s*2px solid transparent/);
  assert.match(source, /\.application-mode-control button\.selected\s*{[\s\S]*?border-bottom-color:\s*#6bbce9/);
  assert.match(source, /\.review-rhs-modes\s*{[\s\S]*?height:\s*34px/);
  assert.match(source, /\.review-rhs-modes button\s*{[\s\S]*?min-height:\s*34px;[\s\S]*?border-bottom:\s*2px solid transparent/);
  assert.doesNotMatch(source, /\.review-rhs-modes button\s*{[^}]*min-height:\s*44px/);
});


test("Review toolbar groups and every cell use one non-flow media geometry contract", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  const controller = readFileSync(
    new URL("../src/review/review-controller.js", import.meta.url), "utf8"
  );
  assert.match(source, /\.review-transport-controls\s*{[\s\S]*?--review-toolbar-group-gap:\s*8px;[\s\S]*?gap:\s*var\(--review-toolbar-group-gap\)/);
  assert.match(source, /\.review-toolbar-group\s*{[\s\S]*?gap:\s*2px/);
  assert.doesNotMatch(source, /\.review-transport \.review-now\s*{/);
  assert.doesNotMatch(source, /\.review-speed-select\s*{[^}]*margin-left/);
  assert.match(source, /\.review-layout-cell\s*{[\s\S]*?position:\s*relative;[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0/);
  assert.match(source, /\.review-camera-panel\s*{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?min-height:\s*0/);
  assert.match(source, /\.review-camera-media\s*{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?min-height:\s*0/);
  assert.match(source, /\.review-historical-video\s*{[\s\S]*?pointer-events:\s*none/);
  assert.match(source, /\.review-camera-status\s*{\s*display:\s*none\s*!important;\s*}/);
  assert.doesNotMatch(controller, /setPlayerStatus\([^\n]*["']Ready["']/);
  assert.doesNotMatch(controller, /review-camera-heading/);
});


test("ReviewClock remains an absolute clock independent of player currentTime", () => {
  let now = 1000;
  const clock = new ReviewClock(() => now);
  clock.setAbsolute(1800000000);
  clock.start();
  now = 2750;
  assert.equal(clock.absoluteTime, 1800000001.75);
  clock.setRate(4);
  now = 3750;
  assert.equal(clock.absoluteTime, 1800000005.75);
  clock.pause();
  now = 9000;
  assert.equal(clock.absoluteTime, 1800000005.75);
});


test("Review View capture is detached, versioned, and excludes transient state", t => {
  const harness = createHistoricalHarness({
    initialReviewRange: { from: 100, to: 200 }
  });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller._reviewLayout = "primary12";
  controller._reviewAssignments = [
    "Drive Up", null, "Drive Down", "Back", ...new Array(12).fill(null)
  ];
  controller.syncSelectionFromAssignments();
  controller._desiredReviewRange = { from: 100, to: 200 };
  controller._selectedFilters = new Set(["package", "person"]);
  controller._selectedReviewCamera = "Back";
  controller._selectedReviewLayout = "4x4";
  controller._reviewPosition = 150;
  controller.clock.setAbsolute(175);
  controller._rhsMode = "details";
  controller._sectionExpanded.filters = true;

  const snapshot = controller.captureReviewViewState();
  assert.deepEqual(snapshot, {
    version: 1,
    layout: "primary12",
    assignedCameras: [
      "camera.drive_up", null, "camera.drive_down", "camera.back",
      ...new Array(12).fill(null)
    ],
    when: { version: 1, kind: "absolute-range", from: 100, to: 200 },
    filters: ["person", "package"],
    options: { autoSnapTo: false, snapPastCrap: false }
  });
  assert.equal(snapshot.assignedCameras.length, 16);
  assert.equal(Object.hasOwn(snapshot, "_reviewPosition"), false);
  assert.equal(Object.hasOwn(snapshot, "reviewClockAbsolute"), false);
  assert.equal(Object.hasOwn(snapshot, "rhsMode"), false);
  assert.equal(Object.hasOwn(snapshot, "sectionExpanded"), false);
  snapshot.assignedCameras[0] = "camera.changed";
  assert.equal(controller._reviewAssignments[0], "Drive Up");
  assert.deepEqual(controller.getReviewViewCaptureResult(), {
    result: "valid", state: controller.captureReviewViewState()
  });
});


test("Review Options normalize old, unknown, and invalid containers without retaining references", t => {
  const harness = createHistoricalHarness({ initialReviewRange: { from: 100, to: 200 } });
  t.after(() => harness.close());
  const controller = harness.controller;
  const oldView = controller.captureReviewViewState();
  delete oldView.options;
  assert.equal(controller.normalizeReviewViewState(oldView).result, "restored");
  assert.deepEqual(controller.normalizeReviewViewState(oldView).state.options, { autoSnapTo: false, snapPastCrap: false });
  assert.equal(controller.restoreReviewView(oldView).result, "restored");
  assert.deepEqual(controller.state.reviewOptions, { autoSnapTo: false, snapPastCrap: false });
  assert.deepEqual(controller.captureReviewViewState().options, { autoSnapTo: false, snapPastCrap: false });

  const incomingOptions = { unknownPolicy: true };
  const unknownView = { ...oldView, options: incomingOptions };
  const normalized = controller.normalizeReviewViewState(unknownView);
  assert.equal(normalized.result, "partial");
  assert.deepEqual(normalized.state.options, { autoSnapTo: false, snapPastCrap: false });
  assert.equal(controller.restoreReviewView(unknownView).result, "partial");
  assert.notStrictEqual(controller._reviewOptions, incomingOptions);
  incomingOptions.unknownPolicy = false;
  assert.deepEqual(controller.state.reviewOptions, { autoSnapTo: false, snapPastCrap: false });
  const captured = controller.captureReviewViewState();
  captured.options.unknownPolicy = true;
  assert.deepEqual(controller.state.reviewOptions, { autoSnapTo: false, snapPastCrap: false });
  assert.deepEqual(controller.captureReviewViewState().options, { autoSnapTo: false, snapPastCrap: false });
  assert.deepEqual(unknownView.options, { unknownPolicy: false });

  for (const invalidOptions of [null, [], "on", false]) {
    const result = controller.normalizeReviewViewState({ ...oldView, options: invalidOptions });
    assert.equal(result.result, "partial");
    assert.deepEqual(result.state.options, { autoSnapTo: false, snapPastCrap: false });
  }
  assert.equal(Object.hasOwn(controller.captureReviewViewState(), "sectionExpanded"), false);
});


test("Auto Snap option is inert while paused and round-trips through Review Views", t => {
  const harness = createHistoricalHarness({ initialReviewRange: { from: 100, to: 200 } });
  t.after(() => harness.close());
  const controller = harness.controller;
  const input = harness.root.querySelector(".review-auto-snap-to");
  assert.ok(input);
  assert.equal(input.checked, false);
  assert.deepEqual(controller.getReviewOptions(), { autoSnapTo: false, snapPastCrap: false });
  const beforeTi = controller.reviewPosition;
  const beforeCalls = harness.calls.length;
  const beforeStarts = harness.starts.length;
  input.checked = true;
  input.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  assert.equal(controller.reviewPosition, beforeTi);
  assert.equal(harness.calls.length, beforeCalls);
  assert.equal(harness.starts.length, beforeStarts);
  assert.equal(controller._autoSnapArmed, false);
  const saved = controller.captureReviewViewState();
  assert.deepEqual(saved.options, { autoSnapTo: true, snapPastCrap: false });
  controller.setAutoSnapTo(false);
  assert.equal(controller.restoreReviewView(saved).result, "restored");
  assert.deepEqual(controller.getReviewOptions(), { autoSnapTo: true, snapPastCrap: false });
  assert.equal(harness.root.querySelector(".review-auto-snap-to").checked, true);
  assert.equal(controller._autoSnapArmed, false);
  assert.deepEqual(controller.normalizeReviewViewState({ ...saved, options: {} }).state.options,
    { autoSnapTo: false, snapPastCrap: false });
  assert.deepEqual(controller.normalizeReviewViewState({ ...saved, options: { autoSnapTo: false } }).state.options,
    { autoSnapTo: false, snapPastCrap: false });
  const invalid = controller.normalizeReviewViewState({
    ...saved, options: { autoSnapTo: "true", obsolete: true }
  });
  assert.equal(invalid.result, "partial");
  assert.deepEqual(invalid.state.options, { autoSnapTo: false, snapPastCrap: false });
});


test("Review View capture rejects an invalid desired range without using displayed range", t => {
  const harness = createHistoricalHarness({
    initialReviewRange: { from: 100, to: 200 }
  });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller._desiredReviewRange = { from: 300, to: 300 };
  controller._displayedReviewQuery.range = { from: 100, to: 200 };
  assert.equal(controller.captureReviewViewState(), null);
  assert.deepEqual(controller.getReviewViewCaptureResult(), {
    result: "invalid", state: null, reason: "invalid_when_range"
  });
});


test("Review View normalization maps entities, preserves slots, and canonicalizes partial data", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const result = harness.controller.normalizeReviewViewState({
    version: 1,
    layout: "primary12",
    assignedCameras: [
      "camera.drive_down", "camera.missing", "camera.drive_down", null,
      "camera.back"
    ],
    when: { version: 1, kind: "absolute-range", from: 10, to: 20 },
    filters: ["package", "person", "person", "unknown"]
  });
  assert.equal(result.result, "partial");
  assert.deepEqual(result.state.assignedCameras.slice(0, 5), [
    "Drive Down", null, null, null, "Back"
  ]);
  assert.deepEqual(result.state.filters, ["person", "package"]);
  assert.deepEqual(result.issues.staleCameras, ["camera.missing"]);
  assert.deepEqual(result.issues.duplicateCameras, ["camera.drive_down"]);
  assert.deepEqual(result.issues.unknownFilters, ["unknown"]);
  assert.equal(result.state.assignedCameras.length, 16);
});


test("Invalid Review View normalization rejects before any controller mutation", t => {
  const harness = createHistoricalHarness({
    initialReviewRange: { from: 100, to: 200 }
  });
  t.after(() => harness.close());
  const controller = harness.controller;
  const before = {
    layout: controller._reviewLayout,
    assignments: [...controller._reviewAssignments],
    range: { ...controller._desiredReviewRange },
    filters: [...controller._selectedFilters],
    position: controller.reviewPosition,
    query: controller.cloneReviewQuery(controller._desiredReviewQuery)
  };
  const result = controller.restoreReviewView({
    version: 1,
    layout: "not-a-layout",
    assignedCameras: new Array(16).fill(null),
    when: { version: 1, kind: "absolute-range", from: 10, to: 20 },
    filters: []
  });
  assert.equal(result.result, "invalid");
  assert.equal(controller._reviewLayout, before.layout);
  assert.deepEqual([...controller._reviewAssignments], before.assignments);
  assert.deepEqual(controller._desiredReviewRange, before.range);
  assert.deepEqual([...controller._selectedFilters], before.filters);
  assert.equal(controller.reviewPosition, before.position);
  assert.deepEqual(controller._desiredReviewQuery, before.query);
});


test("Review View normalization fails closed for version, When, and structure errors", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const base = {
    version: 1,
    layout: "primary12",
    assignedCameras: new Array(16).fill(null),
    when: { version: 1, kind: "absolute-range", from: 10, to: 20 },
    filters: []
  };
  for (const invalid of [
    { ...base, version: 2 },
    { ...base, when: { ...base.when, version: 2 } },
    { ...base, when: { ...base.when, kind: "relative" } },
    { ...base, when: { ...base.when, from: Infinity } },
    { ...base, when: { ...base.when, from: 20, to: 10 } },
    { ...base, assignedCameras: "camera.drive_up" },
    { ...base, filters: "person" }
  ]) {
    assert.equal(harness.controller.normalizeReviewViewState(invalid).result, "invalid");
  }
});


test("Review View restore round-trips layout, slots, absolute range, and filters", async t => {
  const harness = createHistoricalHarness({
    initialReviewRange: { from: 100, to: 200 }
  });
  t.after(() => harness.close());
  const controller = harness.controller;
  harness.calls.length = 0;
  const result = controller.restoreReviewView({
    version: 1,
    layout: "primary12",
    assignedCameras: [
      "camera.drive_down", null, "camera.back", ...new Array(13).fill(null)
    ],
    when: { version: 1, kind: "absolute-range", from: 300, to: 400 },
    filters: ["package", "person"]
  });
  assert.equal(result.result, "restored");
  assert.equal(result.criteriaChanged, true);
  assert.equal(controller._reviewLayout, "primary12");
  assert.deepEqual(controller._reviewAssignments.slice(0, 4), [
    "Drive Down", null, "Back", null
  ]);
  assert.equal(controller._primaryCameraName, "Drive Down");
  assert.deepEqual(controller._desiredReviewRange, { from: 300, to: 400 });
  assert.deepEqual([...controller._selectedFilters], ["person", "package"]);
  assert.equal(controller._selectedReviewCamera, null);
  assert.equal(controller._selectedReviewLayout, null);
  await controller.flushScheduledReviewQuery();
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/review/get").length, 1);
  assert.equal(harness.calls.some(call => call.type === "frigate_max/v1/vod/prepare"), false);
});


test("Review View restore changing only layout and slot order does not refresh metadata", async t => {
  const harness = createHistoricalHarness({
    initialReviewRange: { from: 100, to: 200 }
  });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller._reviewAssignments = [
    "Drive Up", "Drive Down", ...new Array(14).fill(null)
  ];
  controller.syncSelectionFromAssignments();
  controller._desiredReviewQuery = controller.getDesiredReviewQuery();
  harness.calls.length = 0;
  const result = controller.restoreReviewView({
    version: 1,
    layout: "primary12",
    assignedCameras: [
      "camera.drive_down", "camera.drive_up", ...new Array(14).fill(null)
    ],
    when: { version: 1, kind: "absolute-range", from: 100, to: 200 },
    filters: []
  });
  assert.equal(result.result, "restored");
  assert.equal(result.criteriaChanged, false);
  assert.equal(await controller.flushScheduledReviewQuery(), false);
  assert.equal(harness.calls.length, 0);
  assert.deepEqual(controller._reviewAssignments.slice(0, 2), ["Drive Down", "Drive Up"]);
});


test("Review View restore invalidates an in-flight pre-restore metadata response", async t => {
  const responses = [];
  const harness = createHistoricalHarness({
    initialReviewRange: { from: 100, to: 200 },
    reviewResponder: () => new Promise(resolve => responses.push(resolve))
  });
  t.after(() => harness.close());
  const controller = harness.controller;
  const oldRefresh = controller.refreshReviewQuery();
  await Promise.resolve();
  assert.equal(responses.length, 1);
  controller.restoreReviewView({
    version: 1,
    layout: "primary12",
    assignedCameras: ["camera.drive_up", ...new Array(15).fill(null)],
    when: { version: 1, kind: "absolute-range", from: 300, to: 400 },
    filters: ["person"]
  });
  assert.deepEqual(controller._desiredReviewQuery.range, { from: 300, to: 400 });
  responses[0]([]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(controller._desiredReviewQuery.range, { from: 300, to: 400 });
  assert.deepEqual(controller._displayedReviewQuery.range, { from: 100, to: 200 });
  await oldRefresh;
  controller.cancelScheduledReviewQuery();
});


test("Review View restore retires historical playback once and preserves the shared epoch", async t => {
  const target = Date.parse("2026-09-10T11:30:00-07:00") / 1000;
  const harness = createHistoricalHarness({
    initialReviewRange: { from: target - 1800, to: target + 1800 }
  });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.playHistorical(target, { autoplay: false });
  const before = harness.calls.length;
  let retireCount = 0;
  const originalReturnToLive = controller.returnToLive.bind(controller);
  controller.returnToLive = (...args) => {
    retireCount += 1;
    return originalReturnToLive(...args);
  };
  const result = controller.restoreReviewView({
    version: 1,
    layout: "primary12",
    assignedCameras: ["camera.drive_up", ...new Array(15).fill(null)],
    when: { version: 1, kind: "absolute-range", from: target - 900, to: target + 900 },
    filters: []
  });
  assert.equal(result.result, "restored");
  assert.equal(retireCount, 1);
  assert.equal(controller._presentationMode, "live");
  assert.equal(controller.clock.absoluteTime, null);
  assert.equal(controller._reviewPosition, target);
  assert.equal(harness.calls.slice(before).some(call => call.type === "frigate_max/v1/vod/prepare"), false);
});


test("Review View restore constrains the shared investigation position to saved boundaries", t => {
  const harness = createHistoricalHarness({
    initialReviewRange: { from: 100, to: 200 }
  });
  t.after(() => harness.close());
  const controller = harness.controller;
  const view = position => ({
    version: 1,
    layout: "primary12",
    assignedCameras: ["camera.drive_up", ...new Array(15).fill(null)],
    when: { version: 1, kind: "absolute-range", from: 300, to: 400 },
    filters: []
  });
  controller._reviewPosition = 250;
  controller.restoreReviewView(view());
  assert.equal(controller._reviewPosition, 300);
  controller._reviewPosition = 450;
  controller.restoreReviewView({ ...view(), when: { version: 1, kind: "absolute-range", from: 500, to: 600 } });
  assert.equal(controller._reviewPosition, 500);
});


test("one NVR clock formatter renders 12-hour and 24-hour boundary times", () => {
  const at = iso => Date.parse(iso) / 1000;
  assert.match(formatNvrClockTime(at("2026-09-10T00:05:00Z"), "UTC", "12-hour"), /^12:05 AM$/);
  assert.match(formatNvrClockTime(at("2026-09-10T12:05:00Z"), "UTC", "12-hour"), /^12:05 PM$/);
  assert.match(formatNvrClockTime(at("2026-09-10T19:05:00Z"), "UTC", "12-hour"), /^7:05 PM$/);
  assert.equal(formatNvrClockTime(at("2026-09-10T00:05:00Z"), "UTC"), "00:05");
  assert.equal(formatNvrClockTime(at("2026-09-10T19:05:00Z"), "UTC"), "19:05");
});


test("When, Timeline and footer share the selected time format without changing epochs", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const desired = controller.state.desiredReviewRange;
  const displayed = controller.state.displayedReviewQuery;
  const originalPanel = harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]');
  const originalImage = originalPanel.querySelector("hui-image");
  controller.setTimeFormat("12-hour");
  const fromPicker = harness.datePickerInstances.at(-2);
  assert.equal(fromPicker.options.enableTime, false);
  assert.equal(fromPicker.options.altFormat, "m/d/Y");
  assert.match(fromPicker.altInput.value, /^\d{2}\/\d{2}\/\d{4}$/);
  const hour = harness.root.querySelector(".review-time-hour");
  assert.equal(hour.options[0].textContent, "12 AM");
  assert.equal(hour.options[13].textContent, "1 PM");
  assert.doesNotMatch(hour.textContent, /\b00\b/);
  assert.match(harness.root.querySelector(".review-timeline-tick span").textContent, /(?:AM|PM)$/);
  assert.match(harness.root.querySelector(".review-clock-display").textContent, /(?:AM|PM)$/);
  assert.equal(harness.root.querySelector(".review-timeline").style.getPropertyValue("--review-timeline-time-gutter"), "72px");
  assert.deepEqual(controller.state.desiredReviewRange, desired);
  assert.deepEqual(controller.state.displayedReviewQuery, displayed);
  assert.strictEqual(harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]'), originalPanel);
  assert.strictEqual(originalPanel.querySelector("hui-image"), originalImage);

  controller.setTimeFormat("24-hour");
  assert.equal(harness.datePickerInstances.at(-2).options.enableTime, false);
  assert.equal(harness.root.querySelector(".review-time-hour").options[0].textContent, "00");
  assert.doesNotMatch(harness.root.querySelector(".review-timeline-tick span").textContent, /(?:AM|PM)$/);
  assert.doesNotMatch(harness.root.querySelector(".review-clock-display").textContent, /(?:AM|PM)$/);
  assert.equal(harness.root.querySelector(".review-timeline").style.getPropertyValue("--review-timeline-time-gutter"), "58px");
  assert.deepEqual(controller.state.desiredReviewRange, desired);

  controller.setTimeFormat("12-hour");
  const afternoonHour = harness.root.querySelector(".review-time-hour");
  const exactMinute = harness.root.querySelector(".review-time-minute");
  afternoonHour.value = "13";
  afternoonHour.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  exactMinute.value = "37";
  exactMinute.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  const changed = controller.state.whenDraftRange.from;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(changed * 1000));
  assert.equal(parts.find(part => part.type === "hour").value, "13");
  assert.equal(parts.find(part => part.type === "minute").value, "37");
  assert.deepEqual(controller.state.desiredReviewRange, desired);
  assert.deepEqual(controller.state.displayedReviewQuery, displayed);
});


test("initial Timeline cursor is presentation-only and shares exact axis endpoints", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const range = controller.state.displayedReviewQuery.range;
  const cursor = harness.root.querySelector(".review-timeline-cursor");
  const ticks = [...harness.root.querySelectorAll(".review-timeline-tick")];
  assert.equal(cursor.hidden, false);
  assert.equal(cursor.style.top, "0%");
  assert.equal(ticks[0].style.top, "0%");
  assert.equal(ticks.at(-1).style.top, "100%");
  assert.equal(ticks[0].textContent, formatNvrClockTime(range.to, "America/Los_Angeles"));
  assert.equal(ticks.at(-1).textContent, formatNvrClockTime(range.from, "America/Los_Angeles"));
  assert.equal(reviewTimelineEpochFromCoordinate(100, 100, 400, range), range.to);
  assert.equal(reviewTimelineEpochFromCoordinate(500, 100, 400, range), range.from);
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length, 0);
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(source, /\.review-timeline\s*{[^}]*padding:\s*0 8px 8px;/s);
  assert.match(source, /\.review-time-truth\s*{[^}]*justify-content:\s*center;/s);
  assert.match(source, /\.review-time-truth \.review-clock-display\s*{[^}]*font-weight:\s*600;/s);
  assert.match(source, /\.review-timeline-tick span\s*{[^}]*top:\s*-8px;/s);
  assert.match(source, /\.review-timeline-tick span\s*{[^}]*line-height:\s*14px;/s);
  assert.doesNotMatch(source, /\.review-timeline-tick:last-child/);
});


test("initial Review position constrains wall time and keeps cursor and footer identical", t => {
  const wall = Date.parse("2026-09-10T12:00:00-07:00") / 1000;
  for (const [name, range, expected, top] of [
    ["inside", { from: wall - 1800, to: wall + 1800 }, wall, "50%"],
    ["above", { from: wall - 7200, to: wall - 3600 }, wall - 3600, "0%"],
    ["below", { from: wall + 3600, to: wall + 7200 }, wall + 3600, "100%"]
  ]) {
    const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS, initialReviewRange: range });
    t.after(() => harness.close());
    const controller = harness.controller;
    const cursor = harness.root.querySelector(".review-timeline-cursor");
    const footer = harness.root.querySelector(".review-clock-display");
    assert.equal(controller.state.reviewPositionEpoch, expected, name);
    assert.equal(cursor.style.top, top, name);
    assert.equal(footer.dateTime, new Date(expected * 1000).toISOString(), name);
    assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length, 0, name);
  }
});


test("applied When changes constrain one Review position without VOD preparation", async t => {
  const wall = Date.parse("2026-09-10T12:00:00-07:00") / 1000;
  for (const [name, range, expected, top] of [
    ["preserved", { from: wall - 1800, to: wall + 1800 }, wall, "50%"],
    ["above", { from: wall - 7200, to: wall - 3600 }, wall - 3600, "0%"],
    ["below", { from: wall + 3600, to: wall + 7200 }, wall + 3600, "100%"]
  ]) {
    const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS });
    t.after(() => harness.close());
    const controller = harness.controller;
    const displayed = controller.state.reviewRange;
    controller.setReviewRangeEndpoint("from", range.from);
    controller.setReviewRangeEndpoint("to", range.to);
    assert.deepEqual(controller.state.reviewRange, displayed, name);
    assert.equal(controller.applyWhenDraft(), true, name);
    await controller.flushScheduledReviewQuery();
    assert.equal(controller.state.reviewPositionEpoch, expected, name);
    assert.equal(harness.root.querySelector(".review-timeline-cursor").style.top, top, name);
    assert.equal(harness.root.querySelector(".review-clock-display").dateTime,
      new Date(expected * 1000).toISOString(), name);
    assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length, 0, name);
  }
});


test("out-of-range historical time never appears as a false boundary cursor", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const range = controller.state.displayedReviewQuery.range;
  controller._presentationMode = "historical";
  controller.clock.setAbsolute(range.to + 1);
  controller.updateClockDisplay();
  assert.equal(harness.root.querySelector(".review-timeline-cursor").hidden, true);
  assert.equal(harness.root.querySelector(".review-clock-display").dateTime,
    new Date((range.to + 1) * 1000).toISOString());
});


test("When edits stay draft-only until Apply retires historical media", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const initial = controller.state.displayedReviewQuery.range;
  const selected = initial.from + 900;
  await controller.selectTimelineTime(selected);
  controller.pausePlayback();
  const position = controller.clock.absoluteTime;
  const prepareCount = harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length;
  controller.setReviewRangeEndpoint("to", initial.to + 600);
  assert.equal(controller.state.presentationMode, "historical");
  assert.equal(controller.clock.absoluteTime, position);
  assert.deepEqual(controller.state.reviewRange, initial);
  assert.deepEqual(controller.state.desiredReviewRange, initial);
  assert.deepEqual(controller.state.whenDraftRange, {
    from: initial.from, to: initial.to + 600
  });
  assert.equal(await controller.flushScheduledReviewQuery(), false);
  assert.equal(controller.state.presentationMode, "historical");
  assert.equal(controller.clock.absoluteTime, position);
  assert.equal(controller._queryRefreshCount, 1);
  assert.equal(controller.applyWhenDraft(), true);
  assert.equal(controller.state.presentationMode, "live");
  assert.equal(controller.clock.absoluteTime, null);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, {
    from: initial.from, to: initial.to + 600
  });
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length,
    prepareCount);
});


test("the first live Timeline drag owns the preview through move, release and later drags", async t => {
  let wall = Date.parse("2026-09-10T12:00:00-07:00");
  const harness = createHistoricalHarness({ wallClockMs: () => wall });
  t.after(() => harness.close());
  const controller = harness.controller;
  const range = controller.state.displayedReviewQuery.range;
  const axis = harness.root.querySelector(".review-timeline-axis");
  const handle = harness.root.querySelector(".review-timeline-handle");
  const cursor = harness.root.querySelector(".review-timeline-cursor");
  const footer = harness.root.querySelector(".review-clock-display");
  axis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  handle.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 41, button: 0, clientY: 100
  }));
  assert.equal(controller._timelineDrag.originalEpoch, range.to);
  assert.equal(controller._timelineDrag.previewEpoch, range.to);
  handle.dispatchEvent(new harness.window.PointerEvent("pointermove", {
    bubbles: true, pointerId: 41, clientY: 300
  }));
  const preview = reviewTimelineEpochFromCoordinate(300, 100, 400, range);
  assert.equal(cursor.style.top, "50%");
  assert.equal(controller.state.reviewPositionEpoch, preview);
  assert.equal(footer.dateTime, new Date(preview * 1000).toISOString());
  wall += 120000;
  controller.clock.setAbsolute(range.from);
  controller.updateClockDisplay();
  assert.equal(cursor.style.top, "50%");
  assert.equal(footer.dateTime, new Date(preview * 1000).toISOString());
  await controller.refreshReviewQuery();
  assert.strictEqual(harness.root.querySelector(".review-timeline-handle"), handle);
  assert.equal(cursor.style.top, "50%");
  assert.equal(footer.dateTime, new Date(preview * 1000).toISOString());
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length, 0);
  handle.dispatchEvent(new harness.window.PointerEvent("pointerup", {
    bubbles: true, pointerId: 41, button: 0, clientY: 300
  }));
  for (let index = 0; index < 20 && harness.calls.filter(call =>
    call.type === "frigate_max/v2/vod/prepare").length < 2; index += 1) {
    await new Promise(resolve => harness.window.setTimeout(resolve, 0));
  }
  const prepares = harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare");
  assert.equal(prepares.length, 2);
  assert.ok(prepares.every(call => call.target === preview));
  assert.equal(controller.state.presentationMode, "historical");
  assert.equal(controller.clock.running, false);
  assert.equal(harness.starts.length, 0);

  const secondHandle = harness.root.querySelector(".review-timeline-handle");
  const secondAxis = harness.root.querySelector(".review-timeline-axis");
  secondAxis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  secondHandle.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 42, button: 0, clientY: 300
  }));
  secondHandle.dispatchEvent(new harness.window.PointerEvent("pointermove", {
    bubbles: true, pointerId: 42, clientY: 400
  }));
  assert.equal(harness.root.querySelector(".review-timeline-cursor").style.top, "75%");
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length, 2);
  secondHandle.dispatchEvent(new harness.window.PointerEvent("pointercancel", {
    bubbles: true, pointerId: 42
  }));
});


test("cancelling the first live Timeline drag restores its position without VOD", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const original = controller.state.reviewPositionEpoch;
  const axis = harness.root.querySelector(".review-timeline-axis");
  const handle = harness.root.querySelector(".review-timeline-handle");
  axis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  handle.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 43, button: 0, clientY: 100
  }));
  handle.dispatchEvent(new harness.window.PointerEvent("pointermove", {
    bubbles: true, pointerId: 43, clientY: 300
  }));
  handle.dispatchEvent(new harness.window.PointerEvent("pointercancel", {
    bubbles: true, pointerId: 43
  }));
  assert.equal(controller.state.reviewPositionEpoch, original);
  assert.equal(harness.root.querySelector(".review-clock-display").dateTime,
    new Date(original * 1000).toISOString());
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length, 0);
});


test("Timeline coordinates map newest/top to oldest/bottom for any height", () => {
  const range = { from: 10 * 3600, to: 11 * 3600 };
  assert.equal(reviewTimelineEpochFromCoordinate(100, 100, 600, range), 11 * 3600);
  assert.equal(reviewTimelineEpochFromCoordinate(400, 100, 600, range), 10.5 * 3600);
  assert.equal(reviewTimelineEpochFromCoordinate(700, 100, 600, range), 10 * 3600);
  assert.equal(reviewTimelineEpochFromCoordinate(98, 100, 600, range), 11 * 3600);
  assert.equal(reviewTimelineEpochFromCoordinate(704, 100, 600, range), 10 * 3600);
  assert.equal(reviewTimelineEpochFromCoordinate(225, 25, 400, range), 10.5 * 3600);
  assert.equal(reviewTimelineEpochFromCoordinate(100, 100, 0, range), null);
});


test("timeline viewport initializes from displayed When and clamps duration and position", t => {
  const wall = 1800000000;
  for (const span of [120, 900, 24 * 3600, 48 * 3600]) {
    const when = { from: wall - span, to: wall };
    const harness = createHistoricalHarness({ wallClockMs: wall * 1000, initialReviewRange: when });
    t.after(() => harness.close());
    const controller = harness.controller;
    const expected = { from: wall - Math.min(span, 86400), to: wall };
    assert.deepEqual(controller.state.timelineViewport, expected);
    assert.equal(harness.root.querySelector(".review-timeline-zoom-input"), null);
    assert.equal(controller.setTimelineViewport({ from: wall - 10, to: wall }),
      span > 300);
    assert.deepEqual(controller.state.timelineViewport,
      span > 300 ? { from: wall - 300, to: wall } : expected);
    assert.deepEqual(controller.state.displayedReviewQuery.range, when);
  }
});


test("wheel zoom anchors the pointer and changes only the visible timeline", t => {
  const wall = 1800000000;
  const when = { from: wall - 48 * 3600, to: wall };
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    initialReviewRange: when });
  t.after(() => harness.close());
  const controller = harness.controller;
  const initial = { from: wall - 7200, to: wall - 3600 };
  controller.setTimelineViewport(initial);
  const ti = controller.reviewPosition;
  const queries = harness.calls.filter(call => call.type === "frigate_max/v1/review/get").length;
  const axis = harness.root.querySelector(".review-timeline-axis");
  axis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  const anchor = reviewTimelineEpochFromCoordinate(200, 100, 400, initial);
  const wheel = new harness.window.WheelEvent("wheel", {
    bubbles: true, cancelable: true, deltaY: -100, clientY: 200
  });
  Object.defineProperty(wheel, "clientY", { value: 200 });
  assert.equal(axis.dispatchEvent(wheel), false);
  const viewport = controller.state.timelineViewport;
  assert.ok(viewport.to - viewport.from < 3600);
  assert.ok(Math.abs(reviewTimelineEpochFromCoordinate(200, 100, 400, viewport) - anchor) < 0.001);
  assert.equal(controller.reviewPosition, ti);
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);
  assert.deepEqual(controller.state.desiredReviewQuery.range, when);
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/review/get").length,
    queries);
  const heading = harness.root.querySelector(".review-timeline-lane-headings");
  const outside = new harness.window.WheelEvent("wheel", {
    bubbles: true, cancelable: true, deltaY: -100, clientY: 200
  });
  Object.defineProperty(outside, "clientY", { value: 200 });
  assert.equal(heading.dispatchEvent(outside), true);
  assert.deepEqual(controller.state.timelineViewport, viewport);
});


test("wheel zoom obeys five-minute, When, and 24-hour limits with edge clamping", t => {
  const wall = 1800000000;
  const when = { from: wall - 48 * 3600, to: wall };
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    initialReviewRange: when });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller.setTimelineViewport({ from: when.from, to: when.from + 600 });
  const wheel = (deltaY, clientY) => {
    const axis = harness.root.querySelector(".review-timeline-axis");
    axis.getBoundingClientRect = () => ({ top: 100, height: 400 });
    const event = new harness.window.WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY, clientY
    });
    Object.defineProperty(event, "clientY", { value: clientY });
    axis.dispatchEvent(event);
  };
  wheel(-2000, 500);
  assert.deepEqual(controller.state.timelineViewport,
    { from: when.from, to: when.from + 300 });
  wheel(2000, 100);
  assert.ok(Math.abs(controller.state.timelineViewport.to - controller.state.timelineViewport.from -
    300 * Math.exp(1.2)) < 0.001);
  wheel(2000, 100);
  wheel(2000, 100);
  wheel(2000, 100);
  wheel(2000, 100);
  assert.equal(controller.state.timelineViewport.to - controller.state.timelineViewport.from,
    24 * 3600);
  assert.ok(controller.state.timelineViewport.from >= when.from);
  assert.ok(controller.state.timelineViewport.to <= when.to);

  const shortWhen = { from: wall - 120, to: wall };
  const short = createHistoricalHarness({ wallClockMs: wall * 1000,
    initialReviewRange: shortWhen });
  t.after(() => short.close());
  const shortAxis = short.root.querySelector(".review-timeline-axis");
  shortAxis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  const shortWheel = new short.window.WheelEvent("wheel", {
    bubbles: true, cancelable: true, deltaY: -100, clientY: 300
  });
  Object.defineProperty(shortWheel, "clientY", { value: 300 });
  shortAxis.dispatchEvent(shortWheel);
  assert.deepEqual(short.controller.state.timelineViewport, shortWhen);
});


test("background drag pans without seeking and suppresses its release click", t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall };
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    initialReviewRange: when });
  t.after(() => harness.close());
  const controller = harness.controller;
  const initial = { from: wall - 3600, to: wall - 1800 };
  controller.setTimelineViewport(initial);
  const content = harness.root.querySelector(".review-rhs-content");
  const selected = [];
  controller.selectTimelineTime = epoch => { selected.push(epoch); return Promise.resolve(true); };
  let captures = 0;
  let releases = 0;
  content.setPointerCapture = () => { captures += 1; };
  content.releasePointerCapture = () => { releases += 1; };
  const axis = harness.root.querySelector(".review-timeline-axis");
  axis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  axis.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 51, button: 0, clientY: 200
  }));
  content.dispatchEvent(new harness.window.PointerEvent("pointermove", {
    bubbles: true, pointerId: 51, clientY: 203
  }));
  assert.deepEqual(controller.state.timelineViewport, initial);
  content.dispatchEvent(new harness.window.PointerEvent("pointerup", {
    bubbles: true, pointerId: 51, clientY: 203
  }));
  axis.dispatchEvent(new harness.window.MouseEvent("click", {
    bubbles: true, button: 0, clientY: 203
  }));
  assert.equal(selected.length, 1);

  const secondAxis = harness.root.querySelector(".review-timeline-axis");
  secondAxis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  secondAxis.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 52, button: 0, clientY: 200
  }));
  content.dispatchEvent(new harness.window.PointerEvent("pointermove", {
    bubbles: true, pointerId: 52, clientY: 300
  }));
  assert.deepEqual(controller.state.timelineViewport,
    { from: initial.from + 450, to: initial.to + 450 });
  assert.equal(captures, 1);
  content.dispatchEvent(new harness.window.PointerEvent("pointerup", {
    bubbles: true, pointerId: 52, clientY: 300
  }));
  assert.equal(releases, 1);
  harness.root.querySelector(".review-timeline-axis").dispatchEvent(
    new harness.window.MouseEvent("click", { bubbles: true, button: 0, clientY: 300 }));
  assert.equal(selected.length, 1);
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);

  const backAxis = harness.root.querySelector(".review-timeline-axis");
  backAxis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  backAxis.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 53, button: 0, clientY: 300
  }));
  content.dispatchEvent(new harness.window.PointerEvent("pointermove", {
    bubbles: true, pointerId: 53, clientY: 200
  }));
  assert.deepEqual(controller.state.timelineViewport, initial);
  content.dispatchEvent(new harness.window.PointerEvent("pointerup", {
    bubbles: true, pointerId: 53, clientY: 200
  }));
  const edgeAxis = harness.root.querySelector(".review-timeline-axis");
  edgeAxis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  edgeAxis.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 54, button: 0, clientY: 200
  }));
  content.dispatchEvent(new harness.window.PointerEvent("pointermove", {
    bubbles: true, pointerId: 54, clientY: 2000
  }));
  assert.deepEqual(controller.state.timelineViewport,
    { from: when.to - 1800, to: when.to });
  content.dispatchEvent(new harness.window.PointerEvent("pointercancel", {
    bubbles: true, pointerId: 54
  }));
  assert.equal(controller._timelinePan, null);
  assert.equal(selected.length, 1);
});


test("TI drag stays separate from pan and playback follow waits for an active pan", t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall };
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    now: () => 1000, initialReviewRange: when });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller.setTimelineViewport({ from: wall - 3900, to: wall - 3600 });
  const axis = harness.root.querySelector(".review-timeline-axis");
  axis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  const handle = axis.querySelector(".review-timeline-handle");
  handle.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 61, button: 0, clientY: 100
  }));
  assert.equal(controller._timelinePan, null);
  assert.ok(controller._timelineDrag);
  handle.dispatchEvent(new harness.window.PointerEvent("pointercancel", {
    bubbles: true, pointerId: 61
  }));

  controller._presentationMode = "historical";
  controller.clock.setAbsolute(wall - 3700);
  controller.clock.start();
  const content = harness.root.querySelector(".review-rhs-content");
  const panAxis = harness.root.querySelector(".review-timeline-axis");
  panAxis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  panAxis.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 62, button: 0, clientY: 200
  }));
  content.dispatchEvent(new harness.window.PointerEvent("pointermove", {
    bubbles: true, pointerId: 62, clientY: 600
  }));
  const manualViewport = controller.state.timelineViewport;
  controller.updateClockDisplay();
  assert.deepEqual(controller.state.timelineViewport, manualViewport);
  content.dispatchEvent(new harness.window.PointerEvent("pointercancel", {
    bubbles: true, pointerId: 62
  }));
  assert.equal(controller._timelinePan, null);
  controller.updateClockDisplay();
  assert.notDeepEqual(controller.state.timelineViewport, manualViewport);
  assert.equal(harness.root.querySelector(".review-timeline-cursor").hidden, false);
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);
});


test("long When initializes a 24-hour viewport containing TI", t => {
  const wall = 1800000000;
  const when = { from: wall - 72 * 3600, to: wall };
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000, initialReviewRange: when });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller._reviewPosition = wall - 36 * 3600;
  controller.resetTimelineViewport();
  assert.deepEqual(controller.state.timelineViewport,
    { from: wall - 48 * 3600, to: wall - 24 * 3600 });
  controller.setTimelineViewport({ from: when.from - 1000, to: when.from + 200 });
  assert.deepEqual(controller.state.timelineViewport,
    { from: when.from, to: when.from + 1200 });
});


test("Snap uses full When events and reveals an out-of-viewport target", async t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall };
  const event = { camera_id: "drive_up", start_time: wall - 1800, type: "person" };
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    initialReviewRange: when, reviewEvents: [event] });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.refreshReviewQuery();
  controller._reviewPosition = wall - 3600;
  controller.setTimelineViewport({ from: wall - 3900, to: wall - 3600 });
  assert.equal(harness.root.querySelectorAll(".review-timeline-marker").length, 0);
  assert.equal(controller.getEventNavigationTargets().next, event.start_time);
  assert.equal(await controller.snapToNextEvent(), true);
  assert.deepEqual(controller.state.timelineViewport,
    { from: event.start_time - 270, to: event.start_time + 30 });
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);
  const axis = harness.root.querySelector(".review-timeline-axis");
  assert.ok(axis.classList.contains("review-timeline-snap-arrival"));
  assert.equal(axis.querySelector(".review-timeline-cursor").style.top, "10%");
  assert.equal(axis.querySelector(".review-timeline-tick span").textContent,
    formatNvrClockTime(controller.state.timelineViewport.to, controller.timeZone));
  assert.equal(axis.querySelector(".review-timeline-marker").style.top, "10%");
});


test("TI follow starts near either edge and shifts the viewport only as needed", t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall };
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    initialReviewRange: when });
  t.after(() => harness.close());
  const controller = harness.controller;
  const original = { from: wall - 3900, to: wall - 3600 };
  controller.setTimelineViewport(original);
  const queryCount = harness.calls.filter(call => call.type === "frigate_max/v1/review/get").length;
  assert.equal(controller.revealTimelinePosition(wall - 3869), false,
    "lower-edge times outside the 10% margin remain in place");
  assert.equal(controller.revealTimelinePosition(wall - 3631), false,
    "upper-edge times outside the 10% margin remain in place");
  assert.deepEqual(controller.state.timelineViewport, original);
  controller._reviewPosition = wall - 3615;
  assert.equal(controller.revealTimelinePosition(wall - 3615), true,
    "upper-edge times inside the 10% margin follow");
  assert.deepEqual(controller.state.timelineViewport,
    { from: wall - 3885, to: wall - 3585 });
  assert.equal(harness.root.querySelector(".review-timeline-cursor").hidden, false);
  assert.equal(harness.root.querySelector(".review-timeline-cursor").style.top, "10%");
  controller.setTimelineViewport(original);
  controller._reviewPosition = wall - 3885;
  assert.equal(controller.revealTimelinePosition(wall - 3885), true,
    "lower-edge times inside the 10% margin follow symmetrically");
  assert.deepEqual(controller.state.timelineViewport,
    { from: wall - 3915, to: wall - 3615 });
  assert.equal(harness.root.querySelector(".review-timeline-cursor").hidden, false);
  assert.equal(harness.root.querySelector(".review-timeline-cursor").style.top, "90%");
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/review/get").length,
    queryCount);
  assert.deepEqual(controller.state.desiredReviewRange, when);
  assert.equal(controller.clock.running, false);
});


test("running TI follows viewport edges without moving When or changing duration", t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall };
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    now: () => 1000, initialReviewRange: when });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller.setTimelineViewport({ from: wall - 3900, to: wall - 3600 });
  controller._presentationMode = "historical";
  controller.clock.setAbsolute(wall - 3500);
  controller.clock.start();
  controller.updateClockDisplay();
  assert.deepEqual(controller.state.timelineViewport,
    { from: wall - 3770, to: wall - 3470 });
  assert.equal(harness.root.querySelector(".review-timeline-cursor").hidden, false);
  assert.equal(harness.root.querySelector(".review-timeline-cursor").style.top, "10%");
  assert.equal(controller.state.timelineViewport.to - controller.state.timelineViewport.from, 300);
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);
});


test("a running clock cannot outrun its own viewport reveal during cursor rendering", t => {
  const wall = 1800000000;
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    initialReviewRange: { from: wall - 7200, to: wall } });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller.setTimelineViewport({ from: wall - 3900, to: wall - 3600 });
  let monotonic = 0;
  controller.clock._now = () => { monotonic += 250; return monotonic; };
  controller._presentationMode = "historical";
  controller.clock.setAbsolute(wall - 3590);
  controller.clock.start();
  controller.updateClockDisplay();
  const viewport = controller.state.timelineViewport;
  const ti = controller.reviewPosition;
  assert.ok(ti > viewport.from && ti < viewport.to);
  assert.equal(harness.root.querySelector(".review-timeline-cursor").hidden, false);
  assert.ok(Number.parseFloat(harness.root.querySelector(".review-timeline-cursor").style.top)
    >= 9 && Number.parseFloat(harness.root.querySelector(".review-timeline-cursor").style.top)
    <= 11);
});


test("rapid forward Snaps settle on the latest event and backward Snap keeps TI in view", async t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall };
  const events = [wall - 3600, wall - 1800].map(start_time => ({
    camera_id: "drive_up", start_time, type: "person"
  }));
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    initialReviewRange: when, reviewEvents: events });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.refreshReviewQuery();
  controller._reviewPosition = wall - 5400;
  controller.setTimelineViewport({ from: wall - 5700, to: wall - 5400 });
  const queries = harness.calls.filter(call => call.type === "frigate_max/v1/review/get").length;
  const first = controller.snapToNextEvent();
  const second = controller.snapToNextEvent();
  await Promise.all([first, second]);
  assert.equal(controller.reviewPosition, events[1].start_time);
  assert.deepEqual(controller.state.timelineViewport,
    { from: events[1].start_time - 270, to: events[1].start_time + 30 });
  assert.equal(await controller.snapToPreviousEvent(), true);
  assert.equal(controller.reviewPosition, events[0].start_time);
  assert.deepEqual(controller.state.timelineViewport,
    { from: events[0].start_time - 30, to: events[0].start_time + 270 });
  assert.equal(harness.root.querySelector(".review-timeline-cursor").hidden, false);
  assert.equal(harness.root.querySelector(".review-timeline-cursor").style.top, "90%");
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/review/get").length,
    queries);
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);
});


test("reduced motion keeps Snap viewport jumps immediate", async t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall };
  const event = { camera_id: "drive_up", start_time: wall - 1800, type: "person" };
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    initialReviewRange: when, reviewEvents: [event] });
  t.after(() => harness.close());
  harness.window.matchMedia = query => ({
    matches: query === "(prefers-reduced-motion: reduce)"
  });
  const controller = harness.controller;
  await controller.refreshReviewQuery();
  controller._reviewPosition = wall - 3600;
  controller.setTimelineViewport({ from: wall - 3900, to: wall - 3600 });
  assert.equal(await controller.snapToNextEvent(), true);
  assert.equal(harness.root.querySelector(".review-timeline-axis")
    .classList.contains("review-timeline-snap-arrival"), false);
  assert.equal(harness.root.querySelector(".review-timeline-cursor").hidden, false);
  const css = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(css, /review-timeline-snap-arrival 180ms ease-out/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /review-timeline-axis\.review-timeline-snap-arrival\s*{\s*animation:\s*none/);
});


test("When Apply retains the old viewport until the new displayed query succeeds", async t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall };
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    initialReviewRange: when });
  t.after(() => harness.close());
  const controller = harness.controller;
  const viewport = { from: wall - 3900, to: wall - 3600 };
  controller.setTimelineViewport(viewport);
  controller.setReviewRangeEndpoint("from", wall - 1800);
  assert.equal(controller.applyWhenDraft(), true);
  assert.deepEqual(controller.state.timelineViewport, viewport);
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.displayedReviewQuery.range,
    { from: wall - 1800, to: wall });
  assert.deepEqual(controller.state.timelineViewport,
    { from: wall - 1800, to: wall });
});


test("failed View refresh retains the displayed events and viewport", async t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall };
  let fail = false;
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    initialReviewRange: when,
    reviewResponder: () => fail ? Promise.reject(new Error("offline")) : Promise.resolve([]) });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.refreshReviewQuery();
  const viewport = { from: wall - 3900, to: wall - 3600 };
  controller.setTimelineViewport(viewport);
  const saved = controller.captureReviewViewState();
  saved.when = { ...saved.when, from: wall - 1800 };
  fail = true;
  controller.restoreReviewView(saved);
  assert.deepEqual(controller.state.timelineViewport, viewport);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);
  assert.deepEqual(controller.state.timelineViewport, viewport);
  fail = false;
  await controller.refreshReviewQuery();
  assert.deepEqual(controller.state.timelineViewport,
    { from: wall - 1800, to: wall });
});


test("timeline ticks, clipped markers, pointer, and TI share the viewport", async t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall + 7200 };
  const event = { camera_id: "drive_up", start_time: wall - 3900,
    end_time: wall - 3300, type: "person" };
  const outside = { camera_id: "drive_up", start_time: wall - 6000,
    end_time: wall - 5900, type: "person" };
  const harness = createHistoricalHarness({ debug: true,
    wallClockMs: wall * 1000, initialReviewRange: when, reviewEvents: [event, outside]
  });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.refreshReviewQuery();
  const viewport = { from: wall - 3600, to: wall };
  const queries = harness.calls.filter(call => call.type === "frigate_max/v1/review/get").length;
  controller.setTimelineViewport(viewport);
  assert.deepEqual(controller.state.timelineViewport, viewport);
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/review/get").length, queries);
  const ticks = [...harness.root.querySelectorAll(".review-timeline-tick")];
  assert.equal(ticks[0].textContent, formatNvrClockTime(viewport.to, controller.timeZone));
  assert.equal(ticks.at(-1).textContent, formatNvrClockTime(viewport.from, controller.timeZone));
  const markers = [...harness.root.querySelectorAll(".review-timeline-marker")];
  assert.equal(markers.length, 1);
  assert.equal(markers[0].dataset.startEpoch, String(event.start_time));
  assert.match(markers[0].getAttribute("style"), new RegExp(
    `top:min\\(${reviewTimelineMarkerGeometry(event, viewport).top * 100}%, calc\\(100% - 1px\\)\\)`
  ));
  assert.match(markers[0].getAttribute("style"), new RegExp(
    `height:max\\(${reviewTimelineMarkerGeometry(event, viewport).height * 100}%, 1px\\)`
  ));
  assert.equal(harness.root.querySelector(".review-timeline-cursor").style.top, "0%");
  controller._reviewPosition = wall - 5000;
  controller.updateClockDisplay();
  assert.equal(harness.root.querySelector(".review-timeline-cursor").hidden, true);
  const axis = harness.root.querySelector(".review-timeline-axis");
  axis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  const selected = [];
  controller.selectTimelineTime = epoch => { selected.push(epoch); return Promise.resolve(true); };
  axis.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true, button: 0, clientY: 200 }));
  assert.equal(selected[0], wall - 900);
  const handle = harness.root.querySelector(".review-timeline-handle");
  handle.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, pointerId: 88, button: 0, clientY: 100
  }));
  handle.dispatchEvent(new harness.window.PointerEvent("pointermove", {
    bubbles: true, pointerId: 88, clientY: 400
  }));
  assert.equal(controller.reviewPosition, wall - 2700);
  handle.dispatchEvent(new harness.window.PointerEvent("pointercancel", {
    bubbles: true, pointerId: 88
  }));
  assert.deepEqual(controller.state.displayedReviewQuery.range, when);
});


test("viewport movement preserves paused and playing Review transport", async t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall + 7200 };
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    now: () => 1000, initialReviewRange: when });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.selectTimelineTime(wall - 60);
  controller.pausePlayback();
  const players = [...controller._historicalPlayers.values()];
  const requestId = controller._reviewRequestId;
  const prepares = harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length;
  const pausedTi = controller.clock.absoluteTime;
  controller.setTimelineViewport({ from: wall - 3600, to: wall });
  assert.equal(controller.clock.absoluteTime, pausedTi);
  assert.equal(controller.clock.running, false);
  assert.deepEqual([...controller._historicalPlayers.values()], players);
  assert.equal(controller._reviewRequestId, requestId);
  assert.equal(controller.resumePlayback(), true);
  const starts = harness.starts.length;
  const playingTi = controller.clock.absoluteTime;
  controller.setTimelineViewport({ from: wall - 1800, to: wall });
  assert.equal(controller.clock.absoluteTime, playingTi);
  assert.equal(controller.clock.running, true);
  assert.equal(harness.starts.length, starts);
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare").length, prepares);
  assert.deepEqual(controller._historicalPlaybackRange, when);
});


test("Review Views save When alone and restore the transient viewport", t => {
  const wall = 1800000000;
  const when = { from: wall - 7200, to: wall + 7200 };
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000,
    initialReviewRange: when });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller.setTimelineViewport({ from: wall - 1800, to: wall });
  const saved = controller.captureReviewViewState();
  assert.deepEqual(saved.when, { version: 1, kind: "absolute-range", ...when });
  assert.equal(Object.hasOwn(saved, "timelineViewport"), false);
  controller._reviewPosition = wall - 1200;
  const result = controller.restoreReviewView(saved);
  assert.equal(result.result, "restored");
  assert.deepEqual(controller.state.timelineViewport, when);
  assert.equal(controller.reviewPosition, wall - 1200);
  assert.equal(Object.hasOwn(result.state, "timelineViewport"), false);
});

test("Review criteria update desired query and coalesce into one automatic refresh", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const initial = controller.state;
  const refreshes = controller._queryRefreshCount;
  assert.deepEqual(initial.desiredReviewQuery, initial.displayedReviewQuery);
  assert.equal(harness.root.querySelector(".review-query-go"), null);

  controller.setSelectedCameraNames(["Drive Up", "Back"]);
  assert.deepEqual(controller.state.desiredReviewQuery.cameraNames, ["Drive Up", "Back"]);
  assert.deepEqual(controller.state.displayedReviewQuery.cameraNames, ["Drive Up", "Drive Down"]);
  assert.equal(controller._queryRefreshCount, refreshes);

  controller.setReviewRangeEndpoint("from", initial.displayedReviewQuery.range.from - 600);
  assert.deepEqual(controller.state.displayedReviewQuery.range, initial.displayedReviewQuery.range);
  assert.equal(controller._queryRefreshCount, refreshes);
  controller.setFilter("person", true);
  assert.deepEqual(controller.state.desiredReviewQuery.filters, ["person"]);
  assert.deepEqual(controller.state.displayedReviewQuery.filters, []);
  assert.equal(controller._queryRefreshCount, refreshes);
  await controller.flushScheduledReviewQuery();
  assert.equal(controller._queryRefreshCount, refreshes + 1);
  assert.deepEqual(controller.state.displayedReviewQuery, controller.state.desiredReviewQuery);
  controller.setReviewLayout("2x2");
  assert.equal(controller.state.reviewLayout, "2x2");
  assert.equal(controller._queryRefreshCount, refreshes + 1);
});


test("automatic refresh sends the latest complete camera range and filter lifecycle", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const active = controller.state.displayedReviewQuery;
  controller.setSelectedCameraNames(["Drive Up", "Back"]);
  controller.setReviewRangeEndpoint("from", active.range.from - 600);
  controller.setReviewRangeEndpoint("to", active.range.to - 600);
  controller.setFilter("car", true);
  const desired = controller.state.desiredReviewQuery;
  const refreshes = controller._queryRefreshCount;
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.displayedReviewQuery, desired);
  assert.equal(controller._queryRefreshCount, refreshes + 1);
  const request = harness.calls.filter(call => call.type === "frigate_max/v1/review/get").at(-1);
  assert.deepEqual(request.cameras, ["drive_up", "back"]);
  assert.deepEqual({ from: request.from, to: request.to }, desired.range);
  assert.equal(Object.hasOwn(request, "filters"), false);
});


test("fresh Review starts empty and later selection is not capped at two", () => {
  const window = new Window();
  const controller = new ReviewController({ documentRef: window.document });
  controller.configure(cameras());
  assert.equal(JSON.stringify(controller.state.selectedCameraNames), "[]");
  assert.ok(controller.state.reviewAssignments.every(name => name === null));
  assert.equal(
    controller.setSelectedCameraNames(["Back", "Drive Down", "Drive Up"]),
    true
  );
  assert.deepEqual(
    controller.state.selectedCameraNames,
    ["Drive Up", "Drive Down", "Back"]
  );
  assert.equal(controller.setPrimaryCamera("Back"), true);
  assert.equal(controller.state.primaryCameraName, "Back");
  window.close();
});


test("Live and Review expose the same shared layouts with independent state", t => {
  const harness = createTestHarness();
  t.after(() => harness.close());
  const card = harness.createCard();
  card.assignCamera("Front");
  card.assignCamera("Garage");
  const liveLayout = card._layout;
  const liveAssignments = [...card._assignedCameras];
  card.setApplicationMode("review");
  const controller = card._reviewController;
  assert.equal(JSON.stringify(controller.state.selectedCameraNames), "[]");
  assert.ok(card.querySelector(".review-empty-state"));
  controller.setSelectedCameraNames(["Front", "Garage"]);

  const expectedLayouts = [
    "1x1", "2x2", "3x3", "4x4", "Large+3", "Large+5", "Large+7",
    "Top Wide", "Left Wide", "Primary+12"
  ];
  assert.strictEqual(card.layouts, harness.window.ReviewController.VIEWER_LAYOUTS);
  assert.deepEqual(Object.values(VIEWER_LAYOUTS).map(layout => layout.label), expectedLayouts);
  assert.equal(controller.state.reviewLayout, "primary12");
  const liveButtons = [...card.querySelectorAll(".nvr-shell > .camera-list .sidebar-layout-item")];
  const reviewButtons = [...card.querySelectorAll(".review-layout-controls .sidebar-layout-item")];
  assert.deepEqual(liveButtons.map(button => button.textContent.trim()), expectedLayouts);
  assert.deepEqual(reviewButtons.map(button => button.textContent.trim()), expectedLayouts);
  assert.equal(reviewButtons.at(-1).dataset.layout, "primary12");
  const image = card.querySelector("hui-image.review-live-camera");
  card.querySelector('.review-layout-controls [data-layout="2x2"]').click();
  assert.equal(
    card.querySelector('.review-layout-controls [data-layout="2x2"]').classList.contains("target-selected"),
    true
  );
  card.querySelector('[data-review-slot="0"]').click();
  assert.equal(controller.state.reviewLayout, "2x2");
  assert.equal(card.querySelectorAll(".review-layout-cell:not([hidden])").length, 4);
  assert.strictEqual(card.querySelector("hui-image.review-live-camera"), image);
  assert.equal(card._layout, liveLayout);
  assert.equal(JSON.stringify(card._assignedCameras), JSON.stringify(liveAssignments));

  const reviewState = controller.state;
  card.querySelector('.camera-list [data-layout="primary12"]').click();
  card.querySelector('[data-slot="0"]').click();
  assert.equal(card._layout, "primary12");
  assert.equal(controller.state.reviewLayout, reviewState.reviewLayout);
  assert.deepEqual(controller.state.reviewAssignments, reviewState.reviewAssignments);
});


test("Live and Review camera rows share one rendered structure with scoped hooks", t => {
  const harness = createTestHarness();
  t.after(() => harness.close());
  const card = harness.createCard({ hass: harness.createHass() });
  card.setApplicationMode("review");
  const liveRows = [...card.querySelectorAll(".camera-items .camera-item")];
  const reviewRows = [...card.querySelectorAll(".review-camera-controls .camera-item")];
  const signature = row => ({
    tag: row.tagName,
    camera: row.dataset.camera,
    baseClasses: [...row.classList].filter(name => !["assigned", "target-selected"].includes(name)),
    draggable: row.getAttribute("draggable"),
    children: [...row.children].map(child => `${child.tagName}.${child.className}`),
    icon: row.querySelector("ha-icon")?.getAttribute("icon"),
    label: row.querySelector(".camera-name")?.textContent,
    status: row.querySelector(".camera-status")?.getAttribute("aria-label")
  });
  assert.deepEqual(reviewRows.map(signature), liveRows.map(signature));
  assert.ok(reviewRows.every(row => row.querySelector('input[type="checkbox"]') === null));
});


test("Review target placement and drag/drop mutate only Review assignments", t => {
  const harness = createTestHarness();
  t.after(() => harness.close());
  const card = harness.createCard();
  card.assignCamera("Front");
  card.assignCamera("Garage");
  const liveLayout = card._layout;
  const liveAssignments = [...card._assignedCameras];
  card.setApplicationMode("review");
  const controller = card._reviewController;
  controller.setSelectedCameraNames(["Front", "Garage"]);
  controller.setReviewLayout("2x2");
  const frontPanel = card.querySelector('[data-camera="Front"].review-camera-panel');
  const frontImage = frontPanel.querySelector("hui-image");

  card.querySelector('.review-camera-controls [data-camera="Patio"]').click();
  card.querySelector('[data-review-slot="3"]').click();
  assert.equal(controller.state.reviewAssignments[3], "Patio");

  const data = new Map([["application/x-nvr-camera", "Front"]]);
  const transfer = {
    types: [...data.keys()],
    getData: type => data.get(type) ?? "",
    setData: (type, value) => data.set(type, value),
    effectAllowed: "", dropEffect: ""
  };
  const drop = new harness.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: transfer });
  card.querySelector('[data-review-slot="2"]').dispatchEvent(drop);
  assert.equal(controller.state.reviewAssignments[2], "Front");
  assert.strictEqual(card.querySelector('[data-review-slot="2"] .review-camera-panel'), frontPanel);
  assert.strictEqual(frontPanel.querySelector("hui-image"), frontImage);
  assert.equal(card._layout, liveLayout);
  assert.equal(JSON.stringify(card._assignedCameras), JSON.stringify(liveAssignments));

  const reviewState = controller.state;
  card.setApplicationMode("live");
  card.querySelector('.camera-items [data-camera="Patio"]').click();
  card.querySelector('[data-slot="3"]').click();
  assert.equal(card._assignedCameras[3], "Patio");
  assert.equal(controller.state.reviewLayout, reviewState.reviewLayout);
  assert.deepEqual(controller.state.reviewAssignments, reviewState.reviewAssignments);
  card.setApplicationMode("review");
  assert.equal(controller.state.reviewLayout, reviewState.reviewLayout);
  assert.deepEqual(controller.state.reviewAssignments, reviewState.reviewAssignments);
});


test("Live to Review to Live preserves exact Live workspace and player identity", t => {
  const harness = createTestHarness();
  t.after(() => harness.close());
  const hass = harness.createHass();
  const card = harness.createCard({ hass });
  card.assignCamera("Front");
  card.assignCamera("Garage");
  card.maximizeCameraSlot(0);
  const workspace = JSON.stringify(card.captureWorkspace());
  const cells = harness.getPhysicalCells(card);
  const front = harness.getPlayer(card, "Front");
  const garage = harness.getPlayer(card, "Garage");
  const saveCount = harness.userStateCalls.filter(
    call => call.type === "frontend/set_user_data"
  ).length;

  card.setApplicationMode("review");
  assert.equal(card.querySelector(".main-area").hidden, true);
  card._reviewController.setSelectedCameraNames(["Front", "Garage"]);
  const reviewImages = [...card.querySelectorAll("hui-image.review-live-camera")];
  assert.equal(reviewImages.length, 2);
  assert.deepEqual(reviewImages.map(image => image.cameraImage), [
    "camera.front",
    "camera.garage_sub"
  ]);

  card.setApplicationMode("live");
  assert.equal(card.querySelector(".main-area").hidden, false);
  assert.equal(JSON.stringify(card.captureWorkspace()), workspace);
  assert.deepEqual(harness.getPhysicalCells(card), cells);
  assert.strictEqual(harness.getPlayer(card, "Front"), front);
  assert.strictEqual(harness.getPlayer(card, "Garage"), garage);
  assert.equal(front.disconnectedCount, 0);
  assert.equal(garage.disconnectedCount, 0);
  assert.equal(
    harness.userStateCalls.filter(call => call.type === "frontend/set_user_data").length,
    saveCount
  );
});


test("one global sidebar state collapses and expands Live and Review without media recreation", t => {
  const harness = createTestHarness();
  t.after(() => harness.close());
  const card = harness.createCard();
  card.assignCamera("Front");
  card.assignCamera("Garage");
  const shell = card.querySelector(".nvr-shell");
  const toggle = card.querySelector(".sidebar-toggle");
  const livePlayer = harness.getPlayer(card, "Front");

  assert.equal(shell.classList.contains("sidebar-collapsed"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.click();
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  card.assignCamera("Patio");
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  const workspace = JSON.stringify(card.captureWorkspace());
  toggle.click();
  assert.equal(shell.classList.contains("sidebar-collapsed"), true);

  card.setApplicationMode("review");
  const reviewRail = card.querySelector(".review-control-rail");
  const reviewImage = card.querySelector('hui-image.review-live-camera[data-entity="camera.front"]');
  assert.equal(toggle.hidden, false);
  assert.equal(shell.classList.contains("sidebar-collapsed"), true);
  assert.equal(reviewRail.getAttribute("aria-hidden"), "false");

  toggle.click();
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(reviewRail.getAttribute("aria-hidden"), "false");
  assert.strictEqual(
    card.querySelector('hui-image.review-live-camera[data-entity="camera.front"]'),
    reviewImage
  );
  card.querySelector(".review-when-section .sidebar-section-header").click();
  assert.equal(card.querySelector(".review-when-section").classList.contains("expanded"), true);
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  toggle.click();
  assert.strictEqual(
    card.querySelector('hui-image.review-live-camera[data-entity="camera.front"]'),
    reviewImage
  );
  assert.equal(card.querySelector(".review-when-section").classList.contains("expanded"), true);

  card.setApplicationMode("live");
  assert.equal(shell.classList.contains("sidebar-collapsed"), true);
  assert.strictEqual(harness.getPlayer(card, "Front"), livePlayer);
  toggle.click();
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  card.setApplicationMode("review");
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(card.querySelector(".review-when-section").classList.contains("expanded"), true);
  assert.equal(JSON.stringify(card.captureWorkspace()), workspace);
});


test("rail toggle and native section titles retain one structure in both states", t => {
  const harness = createTestHarness();
  t.after(() => harness.close());
  const card = harness.createCard();
  const shell = card.querySelector(".nvr-shell");
  const top = card.querySelector(".sidebar-rail-top");
  const toggle = top.querySelector(".sidebar-toggle");
  const liveRail = card.querySelector(".nvr-sidebar");
  const liveHeaders = [...liveRail.querySelectorAll(".sidebar-section-header")];
  const liveState = { ...card._sidebarSections };

  assert.equal(top.querySelector(".sidebar-rail-title"), null);
  assert.strictEqual(top.firstElementChild, toggle);
  assert.strictEqual(top.lastElementChild, toggle);
  assert.equal(toggle.title, "Expand sidebar");
  assert.deepEqual(liveHeaders.map(header => header.getAttribute("aria-label")), [
    "Cameras", "Layouts", "Views"
  ]);
  assert.deepEqual(liveHeaders.map(header => header.title), [
    "Cameras", "Layouts", "Views"
  ]);
  assert.ok(liveHeaders.every(header => header.querySelector("ha-icon")));

  toggle.click();
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.title, "Collapse sidebar");
  assert.equal(liveRail.getAttribute("aria-hidden"), "false");
  assert.equal(
    JSON.stringify(card._sidebarSections),
    JSON.stringify(liveState)
  );

  card.setApplicationMode("review");
  const reviewRail = card.querySelector(".review-control-rail");
  const reviewHeaders = [...reviewRail.querySelectorAll(".sidebar-section-header")];
  assert.deepEqual(reviewHeaders.map(header => header.getAttribute("aria-label")), [
    "Cameras", "Layouts", "Views", "When", "Filters", "Options"
  ]);
  assert.deepEqual(reviewHeaders.map(header => header.title), [
    "Cameras", "Layouts", "Views", "When", "Filters", "Options"
  ]);
  assert.ok(reviewHeaders.every(header => header.querySelector("ha-icon")));

  toggle.click();
  assert.equal(shell.classList.contains("sidebar-collapsed"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.title, "Expand sidebar");
  assert.ok(reviewHeaders.every(header => header.querySelector(".section-title > span")));
});


test("fresh Review sections start closed and share the collapsed rail inset contract", t => {
  const harness = createTestHarness();
  t.after(() => harness.close());
  const card = harness.createCard();
  card.setApplicationMode("review");
  const sections = [...card.querySelectorAll(
    ".review-control-rail > .sidebar-section"
  )];

  assert.equal(sections.length, 6);
  for (const section of sections) {
    const header = section.querySelector(".sidebar-section-header");
    const body = section.querySelector(".sidebar-section-body");
    assert.equal(section.classList.contains("expanded"), false);
    assert.equal(header.getAttribute("aria-expanded"), "false");
    assert.equal(body.hidden, true);
    assert.equal(body.style.display, "none");
    assert.equal(body.getAttribute("aria-hidden"), "true");
  }

  card._reviewController.setSectionExpanded("cameras", true);
  card._reviewController.setSectionExpanded("layouts", true);
  card._reviewController.setSectionExpanded("filters", true);
  card.setApplicationMode("live");
  card.setApplicationMode("review");
  assert.equal(card.querySelector(".review-cameras-section").classList.contains("expanded"), true);
  assert.equal(card.querySelector(".review-layouts-section").classList.contains("expanded"), true);
  assert.equal(card.querySelector(".review-when-section").classList.contains("expanded"), false);
  assert.equal(card.querySelector(".review-filters-section").classList.contains("expanded"), true);
});


test("collapsed Live section activation expands the rail and ensures the target open", t => {
  const harness = createTestHarness();
  t.after(() => harness.close());
  const card = harness.createCard();
  card.assignCamera("Front");
  const shell = card.querySelector(".nvr-shell");
  const toggle = card.querySelector(".sidebar-toggle");
  const player = harness.getPlayer(card, "Front");
  const cameras = card.querySelector('.sidebar-section[data-section="cameras"]');
  const layouts = card.querySelector('.sidebar-section[data-section="layouts"]');
  const views = card.querySelector('.sidebar-section[data-section="views"]');

  card.setSidebarSectionExpanded("layouts", true);
  cameras.querySelector("ha-icon").click();

  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(cameras.classList.contains("expanded"), true);
  assert.equal(cameras.querySelector(".sidebar-section-body").hidden, false);
  assert.equal(layouts.classList.contains("expanded"), true);
  assert.equal(views.classList.contains("expanded"), false);
  assert.strictEqual(harness.getPlayer(card, "Front"), player);

  toggle.click();
  cameras.querySelector(".sidebar-section-header").click();
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(cameras.classList.contains("expanded"), true);
  assert.equal(cameras.querySelector(".sidebar-section-body").hidden, false);
  assert.strictEqual(harness.getPlayer(card, "Front"), player);
});


test("collapsed Review section activation ensures content open without media or clock changes", t => {
  const harness = createTestHarness();
  t.after(() => harness.close());
  const card = harness.createCard();
  card.setApplicationMode("review");
  const shell = card.querySelector(".nvr-shell");
  const toggle = card.querySelector(".sidebar-toggle");
  const controller = card._reviewController;
  const image = card.querySelector('hui-image.review-live-camera[data-entity="camera.front"]');
  const filters = card.querySelector(".review-filters-section");
  const cameras = card.querySelector(".review-cameras-section");
  const when = card.querySelector(".review-when-section");

  controller.clock.setAbsolute(1800000000);
  controller.clock.start();
  const clock = {
    absolute: controller.clock._absolute,
    startedAt: controller.clock._startedAt,
    running: controller.clock.running
  };
  filters.querySelector(".sidebar-section-header").click();

  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(filters.classList.contains("expanded"), true);
  assert.equal(filters.querySelector(".sidebar-section-body").hidden, false);
  assert.equal(filters.querySelector(".sidebar-section-body").style.display, "");
  assert.equal(cameras.classList.contains("expanded"), false);
  assert.equal(when.classList.contains("expanded"), false);
  assert.strictEqual(
    card.querySelector('hui-image.review-live-camera[data-entity="camera.front"]'),
    image
  );
  assert.deepEqual({
    absolute: controller.clock._absolute,
    startedAt: controller.clock._startedAt,
    running: controller.clock.running
  }, clock);

  toggle.click();
  filters.querySelector("ha-icon").click();
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(filters.classList.contains("expanded"), true);
  assert.strictEqual(
    card.querySelector('hui-image.review-live-camera[data-entity="camera.front"]'),
    image
  );

  card.setApplicationMode("live");
  card.setApplicationMode("review");
  assert.equal(card.querySelector(".review-filters-section").classList.contains("expanded"), true);
  assert.equal(card.querySelector(".review-cameras-section").classList.contains("expanded"), false);
  assert.equal(card.querySelector(".review-when-section").classList.contains("expanded"), false);
});


test("collapsed Layouts activation expands the shared rail and remembers the subsection", t => {
  const harness = createTestHarness();
  t.after(() => harness.close());
  const card = harness.createCard();
  card.setApplicationMode("review");
  const shell = card.querySelector(".nvr-shell");
  const layouts = card.querySelector(".review-layouts-section");
  const image = card.querySelector("hui-image.review-live-camera");
  layouts.querySelector("ha-icon").click();
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(layouts.classList.contains("expanded"), true);
  assert.strictEqual(card.querySelector("hui-image.review-live-camera"), image);
  card.setApplicationMode("live");
  card.setApplicationMode("review");
  assert.equal(card.querySelector(".review-layouts-section").classList.contains("expanded"), true);
});


test("compact text mode controls retain correct active semantics", t => {
  const harness = createTestHarness();
  t.after(() => harness.close());
  const card = harness.createCard();
  const live = card.querySelector('[data-application-mode="live"]');
  const review = card.querySelector('[data-application-mode="review"]');
  assert.equal(live.querySelector("span").textContent, "LIVE");
  assert.equal(review.querySelector("span").textContent, "REVIEW");
  assert.equal(live.querySelector("ha-icon"), null);
  assert.equal(review.querySelector("ha-icon"), null);
  assert.equal(live.getAttribute("aria-pressed"), "true");
  assert.equal(review.getAttribute("aria-pressed"), "false");
  review.click();
  assert.equal(live.getAttribute("aria-pressed"), "false");
  assert.equal(review.getAttribute("aria-pressed"), "true");
});


test("historical players use independent origins and start as one orchestration", async t => {
  const harness = createHistoricalHarness({ debug: true, now: () => 1000 });
  t.after(() => harness.close());
  const target = 1800000000;
  await harness.controller.playHistorical(target);
  const players = [...harness.controller._historicalPlayers.values()];
  assert.deepEqual(players.map(player => player.seek), [21, 22]);
  assert.deepEqual(players.map(player => player.video.currentTime), [21, 22]);
  assert.equal(harness.starts.length, 2);
  assert.equal(harness.controller.clock.running, true);
  assert.equal(harness.controller.state.presentationMode, "historical");
  assert.match(harness.root.querySelector(".review-diagnostic-output").textContent, /absolute delta=0\.000 s/);
  assert.equal(calculateHistoricalSeek(target, prepared("drive_up", target - 21)), 21);
});


test("initial historical playback uses v2 and seeks from its absolute map", async t => {
  const harness = createHistoricalHarness({ now: () => 1000 });
  t.after(() => harness.close());
  const target = 1800000000;
  await harness.controller.playHistorical(target);
  const prepares = harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare");
  assert.equal(prepares.length, 2);
  assert.ok(prepares.every(call => call.target === target &&
    Number.isFinite(call.bounds_start) && Number.isFinite(call.bounds_end)));
  assert.deepEqual(
    [...harness.controller._historicalPlayers.values()].map(player => player.video.currentTime),
    [21, 22]
  );
  assert.ok([...harness.controller._historicalPlayers.values()].every(player =>
    player.timing?.time_map?.unit === "microseconds"
  ));
});


test("a mapped seam resolves camera presentation without moving ReviewClock", async t => {
  const target = 1800000000;
  const harness = createHistoricalHarness({ now: () => 1000,
    presentationResponder: message => {
      const origin = message.target - 2;
      return {
        schema: 2, camera: message.camera, selected_epoch: message.target,
        resolved_selected_epoch: message.target + 1,
        requested_wall_start: message.target - 2, requested_wall_end: message.target + 8,
        effective_wall_start: origin, logical_wall_start: message.target - 2,
        logical_wall_end: message.target + 8, effective_absolute_origin: origin,
        media_start_position: 0, selected_media_position: 2,
        logical_media_end_position: 9,
        coverage_run: { known_start: message.target - 2, known_end: message.target + 8,
          continues_before: false, continues_after: false },
        time_map: { epoch_origin: origin, unit: "microseconds",
          spans: [[0, 2_000_000, 0, 2_000_000], [3_000_000, 10_000_000, 2_000_000, 9_000_000]] }
      };
    }
  });
  t.after(() => harness.close());
  harness.controller.setSelectedCameraNames(["Drive Up"]);
  await harness.controller.playHistorical(target, { cameraNames: ["Drive Up"] });
  const player = harness.controller._historicalPlayers.get("Drive Up");
  assert.equal(player.resolvedEpoch, target + 1);
  assert.equal(harness.controller.clock.absoluteTime, target);
  assert.equal(player.video.currentTime, 2);
});


test("in-range seeks reuse the v2 presentation without signing or replacing HLS", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  harness.controller.pausePlayback();
  const v2Before = harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare").length;
  const signBefore = harness.calls.filter(call => call.type === "auth/sign_path").length;
  const hlsBefore = harness.instances.length;
  await harness.controller.seekHistoricalRelative(-10);
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare").length, v2Before);
  assert.equal(harness.calls.filter(call => call.type === "auth/sign_path").length, signBefore);
  assert.equal(harness.instances.length, hlsBefore);
});


test("an explicit out-of-range seek prepares a fresh v2 presentation", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  harness.controller.pausePlayback();
  const before = harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare").length;
  await harness.controller.seekHistoricalRelative(-20);
  assert.equal(harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare").length, before + 2);
});


test("ordinary initial v2 preparation retains full Review When bounds", async t => {
  const target = 1800000000;
  const when = { from: target - 3600, to: target + 3600 };
  const harness = createHistoricalHarness({ now: () => 1000 });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target, {
    updateDisplayedRange: false,
    playbackRange: when,
    cameraNames: ["Drive Up"]
  });
  const prepare = harness.calls.find(call => call.type === "frigate_max/v2/vod/prepare");
  assert.equal(prepare.target, target);
  assert.equal(prepare.bounds_start, when.from);
  assert.equal(prepare.bounds_end, when.to);
});


test("mediaToEpoch is authoritative and provider look-ahead cannot advance the clock", async t => {
  const harness = createHistoricalHarness({ now: () => 1000 });
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  const player = harness.controller._historicalPlayers.get("Drive Up");
  const report = harness.controller.getLatestHistoricalSyncReport();
  player.video.currentTime = 30;
  const snapshot = harness.controller.syncSnapshot([player], report);
  assert.equal(snapshot.cameras["Drive Up"].reconstructedEpoch, 1800000009);
  const before = harness.controller.clock.absoluteTime;
  player.video.currentTime = 999;
  player.video.dispatchEvent(new harness.window.Event("timeupdate"));
  assert.equal(harness.controller.clock.absoluteTime, before);
});


test("a finite presentation inside continuous Review coverage prepares a successor", async t => {
  const target = 1800000000;
  const range = { from: target - 15, to: target + 300 };
  const harness = createHistoricalHarness({
    now: () => 0,
    presentationResponder: message => Promise.resolve(presentationPrepared(
      message.camera, message.target - 21, message.target,
      message.target < target + 120 ? target + 120 : range.to
    ))
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target, { playbackRange: range });
  const player = harness.controller._historicalPlayers.get("Drive Up");
  const peer = harness.controller._historicalPlayers.get("Drive Down");
  const logicalEnd = player.timing.logical_wall_end;
  const peerHls = peer.hls;
  Object.defineProperty(player.video, "duration", { configurable: true, value: 999 });
  player.video.currentTime = player.timing.logical_media_end_position;
  setReviewTi(harness.controller, logicalEnd);
  assert.equal(harness.controller.enforceHistoricalPresentationBoundary(), true);
  await waitForCondition(() => player.lifecycleState === "participating" &&
    player.timing.logical_wall_end === range.to);
  assert.equal(player.timing.selected_epoch, logicalEnd);
  assert.equal(player.lifecycleState, "participating");
  assert.notEqual(player.boundaryReason, "continuous_presentation_end_deferred_phase_c");
  assert.ok(harness.calls.some(call => call.type === "frigate_max/v2/vod/prepare" &&
    call.camera === "drive_up" && call.target === logicalEnd &&
    call.bounds_start === range.from && call.bounds_end === range.to));
  assert.equal(peer.lifecycleState, "participating");
  assert.strictEqual(peer.hls, peerHls);
  assert.equal(harness.controller.clock.running, true);
});


test("a finite presentation prepares its covered successor while Review is paused", async t => {
  const target = 1800000000;
  const range = { from: target - 15, to: target + 300 };
  const harness = createHistoricalHarness({
    presentationResponder: message => Promise.resolve(presentationPrepared(
      message.camera, message.target - 21, message.target,
      message.target < target + 120 ? target + 120 : range.to
    ))
  });
  t.after(() => harness.close());
  await harness.controller.playHistorical(target, {
    playbackRange: range, cameraNames: ["Drive Up"], autoplay: false
  });
  const player = harness.controller._historicalPlayers.get("Drive Up");
  player.video.currentTime = player.timing.logical_media_end_position;
  setReviewTi(harness.controller, target + 120);
  player.video.dispatchEvent(new harness.window.Event("ended"));
  await waitForCondition(() => player.lifecycleState === "participating" &&
    player.timing.logical_wall_end === range.to);
  assert.equal(harness.controller.clock.running, false);
  assert.equal(player.video.paused, true);
  assert.equal(harness.starts.length, 0);
});


test("an early physical ended event is treated as a historical failure", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  const player = harness.controller._historicalPlayers.get("Drive Up");
  player.video.currentTime = 10;
  player.video.dispatchEvent(new harness.window.Event("ended"));
  assert.equal(player.unavailable, true);
  assert.match(player.message, /unavailable/i);
});


test("gated historical sync report records origins, barrier, advancement and bounded samples", async t => {
  let tick = 1000;
  const harness = createHistoricalHarness({ debug: true, now: () => tick });
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000, { source: "timeline click" });
  let report = harness.controller.getLatestHistoricalSyncReport();
  assert.equal(report.selectedEpoch, 1800000000);
  assert.equal(report.source, "timeline click");
  assert.equal(report.cameras["Drive Up"].effectiveOriginEpoch, 1800000000 - 21);
  assert.equal(report.cameras["Drive Up"].requestedMediaTime, 21);
  assert.equal(report.cameras["Drive Up"].actualSeekTime, 21);
  assert.equal(report.cameras["Drive Up"].barrierReadyEpoch, 1800000000);
  assert.equal(report.summary.barrierDeltaSeconds, 0);
  assert.deepEqual(report.barrier.ready, ["Drive Up", "Drive Down"]);
  assert.equal(report.cameras["Drive Up"].play.outcome, "fulfilled");
  assert.equal(report.cameras["Drive Down"].play.issuedAtMs, report.cameras["Drive Up"].play.issuedAtMs);
  const player = harness.controller._historicalPlayers.get("Drive Up");
  tick = 1400;
  player.video.currentTime = 21.4;
  player.video.dispatchEvent(new harness.window.Event("timeupdate"));
  for (const second of [1, 5, 30]) {
    tick = 1000 + second * 1000;
    harness.controller.syncTick(harness.controller._syncSession, harness.controller._generation);
  }
  report = harness.controller.getLatestHistoricalSyncReport();
  assert.equal(report.cameras["Drive Up"].firstAdvance.delayMs, 400);
  assert.ok(report.samples[1]);
  assert.ok(report.samples[5]);
  assert.ok(report.samples[30]);
  assert.ok(Math.abs(report.summary.sampleDeltaSeconds[30] - 0.4) < 0.00001);
  assert.doesNotThrow(() => JSON.stringify(report));
  assert.equal(JSON.stringify(report).includes("signed/"), false);
  report.cameras["Drive Up"].status = "changed";
  assert.equal(harness.controller.getLatestHistoricalSyncReport().cameras["Drive Up"].status, "released");
});


test("sync reports distinguish preparation failure from post-seek readiness failure and stop on Now", async t => {
  const deadlines = manualInitialDeadlines();
  const harness = createHistoricalHarness({ debug: true,
    unavailable: new Set(["drive_up"]), deferredPlayable: new Set(["Drive Down"]),
    deferredFrame: new Set(["Drive Down"]),
    scheduleInitialDeadline: deadlines.schedule.bind(deadlines)
  });
  t.after(() => harness.close());
  const run = harness.controller.playHistorical(1800000000);
  await waitForHistoricalMedia(harness, 1);
  await waitForCondition(() => harness.mediaControls[0].video.currentTimeWrites.length === 1);
  deadlines.fireActive();
  await run;
  const report = harness.controller.getLatestHistoricalSyncReport();
  assert.equal(report.cameras["Drive Up"].prepareFailure, "prepare_reported_no_recording");
  assert.equal(report.cameras["Drive Down"].reason, "initial_landing_deadline");
  assert.equal(report.disposition, "all unavailable");
  harness.controller.returnToLive();
  assert.equal(harness.controller._syncSession, null);
});


test("sync diagnostics are disabled by default and history is bounded", async t => {
  const window = new Window({ url: "http://localhost/" });
  t.after(() => window.close());
  const controller = new ReviewController({ documentRef: window.document });
  assert.equal(controller.startSyncReport(1, 1800000000, [], "test"), null);
  assert.deepEqual(controller.getHistoricalSyncReports(), []);
  controller.setDebug(true);
  for (let id = 1; id <= 10; id += 1) {
    controller.startSyncReport(id, 1800000000 + id, [], "test");
  }
  const reports = controller.getHistoricalSyncReports();
  assert.equal(reports.length, 8);
  assert.equal(reports[0].id, 3);
  assert.equal(reports.at(-1).id, 10);
  assert.doesNotThrow(() => JSON.stringify(reports));
});


test("historical startup waits through seeked and post-seek playability for one common release", async t => {
  const deferredSeek = new Set(["Drive Down"]);
  const deferredPlayable = new Set(["Drive Up", "Drive Down"]);
  const harness = createHistoricalHarness({ debug: true,
    deferredSeek,
    deferredPlayable,
    deferredFrame: new Set(["Drive Up", "Drive Down"]),
    now: () => 1200
  });
  t.after(() => harness.close());
  let clockStarts = 0;
  const startClock = harness.controller.clock.start.bind(harness.controller.clock);
  harness.controller.clock.start = () => {
    clockStarts += 1;
    startClock();
  };
  harness.controller.setPlaybackSpeed(8);
  const run = harness.controller.playHistorical(1800000000);
  await waitForHistoricalMedia(harness, 2);
  const up = harness.mediaControls.find(control => control.camera === "Drive Up");
  const down = harness.mediaControls.find(control => control.camera === "Drive Down");
  const panels = [...harness.root.querySelectorAll(".review-camera-panel")];
  const cells = panels.map(panel => panel.parentElement);
  const media = panels.map(panel => panel.querySelector(":scope > .review-camera-media"));
  const videos = media.map(viewport => viewport.querySelector(":scope > video.review-historical-video"));

  up.makePlayable();
  await Promise.resolve();
  assert.equal(harness.starts.length, 0);
  assert.equal(harness.controller.clock.running, true);
  assert.equal(clockStarts, 1);
  assert.ok(media.every(viewport => viewport.querySelector(".review-camera-status").hidden));

  down.completeSeek();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.starts.length, 0);
  assert.equal(harness.controller.clock.running, true);

  down.makePlayable();
  await run;
  assert.equal(harness.starts.length, 2);
  assert.equal(clockStarts, 1);
  assert.equal(harness.controller.clock._startedAt, 1200);
  assert.equal(harness.controller.clock.running, true);
  assert.ok(harness.playCalls.every(call => call.playbackRate === 8 && call.clockRunning));
  assert.ok(media.every(viewport => viewport.querySelector(".review-camera-status").hidden));
  assert.deepEqual(
    cells.map(cell => cell.querySelector(":scope > .review-camera-panel")),
    panels
  );
  assert.deepEqual(
    panels.map(panel => panel.querySelector(":scope > .review-camera-media")),
    media
  );
  assert.deepEqual(
    media.map(viewport => viewport.querySelector(":scope > video.review-historical-video")),
    videos
  );
  assert.match(
    harness.root.querySelector(".review-diagnostic-output").textContent,
    /maximum reconstructed absolute delta=0\.000 s/
  );
});


test("partial availability excludes missing cameras while valid players share the barrier", async t => {
  const deferredPlayable = new Set(["Drive Up", "Back"]);
  const harness = createHistoricalHarness({
    unavailable: new Set(["drive_down"]),
    deferredPlayable,
    deferredFrame: new Set(["Drive Up", "Back"])
  });
  t.after(() => harness.close());
  harness.controller.setSelectedCameraNames(["Drive Up", "Drive Down", "Back"]);
  await harness.controller.flushScheduledReviewQuery();
  const run = harness.controller.playHistorical(1800000000, {
    cameraNames: ["Drive Up", "Drive Down", "Back"]
  });
  await waitForHistoricalMedia(harness, 2);
  const up = harness.mediaControls.find(control => control.camera === "Drive Up");
  const back = harness.mediaControls.find(control => control.camera === "Back");
  up.makePlayable();
  await Promise.resolve();
  assert.equal(harness.starts.length, 0);
  back.makePlayable();
  await run;
  assert.equal(harness.starts.length, 2);
  assert.equal(harness.controller.clock.running, true);
  const missing = harness.controller._historicalPlayers.get("Drive Down");
  assert.equal(missing.unavailable, true);
  assert.equal(missing.statusElement.textContent, "No recording at this time.");
});


test("a player stalled after seek is retired before remaining players release together", async t => {
  const deadlines = manualInitialDeadlines();
  const harness = createHistoricalHarness({
    deferredFrame: new Set(["Drive Down"]),
    scheduleInitialDeadline: deadlines.schedule.bind(deadlines)
  });
  t.after(() => harness.close());
  harness.controller.setSelectedCameraNames(["Drive Up", "Drive Down", "Back"]);
  await harness.controller.flushScheduledReviewQuery();
  const run = harness.controller.playHistorical(1800000000, {
    cameraNames: ["Drive Up", "Drive Down", "Back"]
  });
  await waitForHistoricalMedia(harness, 3);
  await Promise.resolve();
  assert.equal(harness.starts.length, 0);
  await waitForCondition(() => harness.mediaControls.every(control =>
    control.video.currentTimeWrites.length === 1));
  deadlines.fireActive();
  await run;
  assert.equal(harness.starts.length, 2);
  assert.deepEqual(harness.playCalls.map(call => call.camera), ["Drive Up", "Back"]);
  assert.equal(harness.controller._historicalPlayers.get("Drive Down").unavailable, true);
  assert.equal(harness.controller.clock.running, true);
});


test("a stale canplay completion cannot release players or anchor the old ReviewClock", async t => {
  const deferredPlayable = new Set(["Drive Up", "Drive Down"]);
  const deferredFrame = new Set(["Drive Up", "Drive Down"]);
  const harness = createHistoricalHarness({ deferredPlayable, deferredFrame });
  t.after(() => harness.close());
  const firstTarget = 1800000000;
  const secondTarget = firstTarget + 300;
  const first = harness.controller.playHistorical(firstTarget);
  await waitForHistoricalMedia(harness, 2);
  const obsoleteControls = [...harness.mediaControls];
  assert.equal(harness.starts.length, 0);
  assert.equal(harness.controller.clock.running, true);

  deferredPlayable.clear();
  deferredFrame.clear();
  const second = harness.controller.playHistorical(secondTarget);
  await waitForHistoricalMedia(harness, 4);
  await second;
  obsoleteControls.forEach(control => control.makePlayable());
  await first;

  assert.equal(harness.starts.length, 2);
  assert.ok(harness.playCalls.every(call => !obsoleteControls.some(control => control.camera === call.camera && control.video === call.video)));
  assert.equal(harness.controller.clock.running, true);
  assert.equal(harness.controller.clock._absolute, secondTarget);
  assert.ok(harness.instances.slice(0, 2).every(instance => instance.destroyCount === 1));
});


test("all Review sections start hidden and toggle open and closed without changing Review state", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller.setFilter("person", true);
  harness.controller.setReviewRangeEndpoint("from", Date.parse("2026-09-07T10:00:00-07:00") / 1000);
  assert.equal(harness.controller.applyWhenDraft(), true);
  const before = harness.controller.state;
  for (const name of ["cameras", "layouts", "views", "when", "filters"]) {
    const section = harness.root.querySelector(`.review-${name}-section`);
    const header = section.querySelector(".sidebar-section-header");
    const body = section.querySelector(".sidebar-section-body");
    assert.equal(section.classList.contains("expanded"), false);
    assert.equal(body.hidden, true);
    header.querySelector("ha-icon").click();
    assert.equal(section.classList.contains("expanded"), true);
    assert.equal(header.getAttribute("aria-expanded"), "true");
    assert.equal(body.hidden, false);
    assert.equal(body.style.display, "");
    assert.equal(body.getAttribute("aria-hidden"), "false");
    header.querySelector(".section-title span").click();
    assert.equal(section.classList.contains("expanded"), false);
    assert.equal(header.getAttribute("aria-expanded"), "false");
    assert.equal(body.hidden, true);
    assert.equal(body.style.display, "none");
    assert.equal(body.getAttribute("aria-hidden"), "true");
  }
  assert.deepEqual(harness.controller.state, before);
});


test("section collapse preserves historical clock and media identity", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  const panel = harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]');
  const video = panel.querySelector("video");
  const player = harness.controller._historicalPlayers.get("Drive Up");
  const clockState = {
    absolute: harness.controller.clock._absolute,
    startedAt: harness.controller.clock._startedAt,
    running: harness.controller.clock.running
  };
  harness.root.querySelector(".review-cameras-section .sidebar-section-header").click();
  assert.strictEqual(harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]'), panel);
  assert.strictEqual(panel.querySelector("video"), video);
  assert.strictEqual(harness.controller._historicalPlayers.get("Drive Up"), player);
  assert.deepEqual({
    absolute: harness.controller.clock._absolute,
    startedAt: harness.controller.clock._startedAt,
    running: harness.controller.clock.running
  }, clockState);
});


test("participation permits zero cameras and promotes the first remaining primary", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  assert.equal(harness.controller.setSelectedCameraNames(["Drive Down", "Back"]), true);
  assert.equal(harness.controller.state.primaryCameraName, "Drive Down");
  harness.controller.setPrimaryCamera("Back");
  harness.controller.setSelectedCameraNames(["Drive Down"]);
  assert.equal(harness.controller.state.primaryCameraName, "Drive Down");
  harness.controller.setSelectedCameraNames([]);
  assert.deepEqual(harness.controller.state.selectedCameraNames, []);
  assert.equal(harness.controller.state.primaryCameraName, null);
  assert.match(harness.root.querySelector(".review-empty-state").textContent, /cameras/);
});


test("Review camera rows reuse the Live presentation while assignments drive participation", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const rows = [...harness.root.querySelectorAll(".review-camera-controls .camera-item")];
  assert.deepEqual(rows.map(row => row.dataset.camera), ["Drive Up", "Drive Down", "Back"]);
  assert.ok(rows.every(row => row.querySelector("ha-icon.camera-row-icon")));
  assert.ok(rows.every(row => row.tagName === "BUTTON"));
  assert.ok(rows.every(row => row.getAttribute("draggable") === "true"));
  assert.ok(rows.every(row => row.querySelector(".camera-status")));
  assert.equal(harness.root.querySelectorAll('.review-camera-controls input[type="checkbox"]').length, 0);
  assert.equal(harness.root.querySelectorAll('.review-camera-controls input[type="radio"]').length, 0);
  assert.equal(harness.controller.state.primaryCameraName, "Drive Up");
});


test("current Primary survives unrelated participation changes", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller.setPrimaryCamera("Drive Down");
  harness.controller.setSelectedCameraNames(["Drive Up", "Drive Down", "Back"]);
  assert.equal(harness.controller.state.primaryCameraName, "Drive Down");
});


test("only double-click promotes a secondary and preserves historical identity/state", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller.setSelectedCameraNames(["Drive Up", "Drive Down", "Back"]);
  await harness.controller.flushScheduledReviewQuery();
  await harness.controller.playHistorical(1800000000);
  const beforeClock = {
    absolute: harness.controller.clock._absolute,
    startedAt: harness.controller.clock._startedAt
  };
  const before = harness.controller.state;
  const up = harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]');
  const down = harness.root.querySelector('.review-camera-panel[data-camera="Drive Down"]');
  const upVideo = up.querySelector("video");
  const downVideo = down.querySelector("video");
  down.click();
  assert.equal(harness.controller.state.primaryCameraName, "Drive Up");
  down.dispatchEvent(new harness.window.MouseEvent("dblclick", { bubbles: true }));
  assert.equal(harness.controller.state.primaryCameraName, "Drive Down");
  assert.strictEqual(harness.root.querySelector('[data-review-slot="0"] [data-camera="Drive Down"]'), down);
  assert.strictEqual(down.querySelector("video"), downVideo);
  assert.strictEqual(up.querySelector("video"), upVideo);
  assert.deepEqual({
    absolute: harness.controller.clock._absolute,
    startedAt: harness.controller.clock._startedAt
  }, beforeClock);
  assert.equal(harness.controller.clock.running, true);
  assert.deepEqual(
    [...harness.controller.state.selectedCameraNames].sort(),
    [...before.selectedCameraNames].sort()
  );
  assert.deepEqual(harness.controller.state.reviewRange, before.reviewRange);
  assert.deepEqual(
    [...harness.root.querySelectorAll('[data-review-slot]:not([data-review-slot="0"]) .review-camera-panel')]
      .map(panel => panel.dataset.camera),
    ["Drive Up", "Back"]
  );
});


test("movement-bounded double-tap promotes a secondary without handling one tap", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const down = harness.root.querySelector('.review-camera-panel[data-camera="Drive Down"]');
  const touch = (type, timeStamp) => {
    const event = new harness.window.Event(type, { bubbles: true });
    Object.defineProperties(event, {
      pointerType: { value: "touch" },
      clientX: { value: 20 },
      clientY: { value: 20 },
      timeStamp: { value: timeStamp }
    });
    down.dispatchEvent(event);
  };
  touch("pointerdown", 100);
  touch("pointerup", 150);
  assert.equal(harness.controller.state.primaryCameraName, "Drive Up");
  touch("pointerdown", 300);
  touch("pointerup", 350);
  assert.equal(harness.controller.state.primaryCameraName, "Drive Down");
});


test("ordinary grids keep slot zero as an internal primary without promotion chrome", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller.setReviewLayout("2x2");
  const down = harness.root.querySelector('.review-camera-panel[data-camera="Drive Down"]');
  down.dispatchEvent(new harness.window.MouseEvent("dblclick", { bubbles: true }));
  assert.equal(harness.controller.state.primaryCameraName, "Drive Up");
  assert.equal(harness.controller.state.reviewAssignments[0], "Drive Up");
});


test("occupied-cell overlay removes one Review assignment without reflow or propagation", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller.setReviewLayout("2x2");
  const wall = harness.root.querySelector(".review-camera-wall");
  const firstPanel = wall.querySelector('[data-review-slot="0"] .review-camera-panel');
  const secondCell = wall.querySelector('[data-review-slot="1"]');
  const secondPanel = secondCell.querySelector(".review-camera-panel");
  const close = secondPanel.querySelector(".review-camera-close");
  assert.equal(secondPanel.querySelector(".review-camera-name").textContent, "Drive Down");
  assert.equal(close.querySelector("ha-icon").getAttribute("icon"), "mdi:close");
  assert.match(close.getAttribute("aria-label"), /Remove Drive Down/);
  close.click();
  assert.equal(secondCell.querySelector(".review-camera-panel"), null);
  assert.equal(secondCell.childElementCount, 0);
  assert.strictEqual(wall.querySelector('[data-review-slot="0"] .review-camera-panel'), firstPanel);
  assert.deepEqual(harness.controller.state.reviewAssignments.slice(0, 2), ["Drive Up", null]);
  assert.equal(harness.controller.state.reviewLayout, "2x2");
  await harness.controller.flushScheduledReviewQuery();
  assert.deepEqual(harness.controller.state.displayedReviewQuery.cameraNames, ["Drive Up"]);
});


test("one touch tap exposes occupied-cell controls without triggering promotion", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const panel = harness.root.querySelector('.review-camera-panel[data-camera="Drive Down"]');
  const before = harness.controller.state.primaryCameraName;
  const touch = (type, timeStamp) => {
    const event = new harness.window.Event(type, { bubbles: true });
    Object.defineProperties(event, {
      pointerType: { value: "touch" }, clientX: { value: 20 },
      clientY: { value: 20 }, timeStamp: { value: timeStamp }
    });
    panel.dispatchEvent(event);
  };
  touch("pointerdown", 100);
  touch("pointerup", 150);
  assert.equal(panel.classList.contains("controls-visible"), true);
  assert.equal(harness.controller.state.primaryCameraName, before);
  assert.ok(panel.querySelector(".review-camera-close"));
});


test("camera changes during historical playback retire it and restore the edited live wall", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  const players = [...harness.controller._historicalPlayers.values()];
  harness.controller.setSelectedCameraNames(["Drive Up"]);
  assert.equal(harness.controller.state.presentationMode, "live");
  assert.equal(harness.controller.clock.absoluteTime, null);
  assert.equal(harness.controller._historicalPlayers.size, 0);
  assert.ok(players.every(player => player.hls === null));
  assert.deepEqual(harness.controller.state.desiredReviewQuery.cameraNames, ["Drive Up"]);
  assert.deepEqual(harness.controller.state.displayedReviewQuery.cameraNames, ["Drive Up", "Drive Down"]);
  assert.equal(harness.root.querySelectorAll("hui-image.review-live-camera").length, 1);
  await harness.controller.flushScheduledReviewQuery();
  assert.deepEqual(harness.controller.state.displayedReviewQuery.cameraNames, ["Drive Up"]);
});


test("drag/drop-equivalent assignment remains editable while historical playback is loading", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createHistoricalHarness({ prepareGate: gate });
  t.after(() => harness.close());
  const target = harness.controller.state.reviewRange.from + 600;
  const run = harness.controller.selectTimelineTime(target);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.controller.state.historicalPreparing, true);
  assert.equal(harness.controller.assignCameraToSlot("Back", 1), true);
  assert.equal(harness.controller.state.presentationMode, "live");
  assert.deepEqual(harness.controller.state.reviewAssignments.slice(0, 2), ["Drive Up", "Back"]);
  assert.equal(harness.root.querySelector('[data-review-slot="1"] .review-camera-panel')?.dataset.camera,
    "Back");
  release();
  await run;
  assert.equal(harness.controller.state.presentationMode, "live");
  assert.equal(harness.root.querySelectorAll("video.review-historical-video").length, 0);
  await harness.controller.flushScheduledReviewQuery();
  assert.deepEqual(harness.controller.state.displayedReviewQuery.cameraNames, ["Drive Up", "Back"]);
});


test("RHS switching is inert while a filter edit retires historical playback and refreshes", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  const video = harness.root.querySelector('[data-camera="Drive Up"] video');
  const before = harness.controller.state;
  const clockState = {
    absolute: harness.controller.clock._absolute,
    startedAt: harness.controller.clock._startedAt
  };
  const refreshes = harness.controller._queryRefreshCount;
  harness.controller.setRhsMode("events");
  assert.deepEqual(harness.controller.state.displayedReviewQuery, before.displayedReviewQuery);
  assert.equal(harness.controller._queryRefreshCount, refreshes);
  assert.strictEqual(harness.root.querySelector('[data-camera="Drive Up"] video'), video);
  harness.controller.setFilter("person", true);
  assert.equal(harness.root.querySelector('[data-camera="Drive Up"] video'), null);
  assert.equal(harness.controller.state.presentationMode, "live");
  assert.deepEqual(harness.controller.state.selectedCameraNames, before.selectedCameraNames);
  assert.equal(harness.controller.state.primaryCameraName, before.primaryCameraName);
  assert.equal(harness.controller.clock.absoluteTime, null);
  assert.equal(harness.controller.state.rhsMode, "events");
  assert.deepEqual(harness.controller.state.selectedFilters, ["person"]);
  assert.equal(harness.controller._queryRefreshCount, refreshes);
  await harness.controller.flushScheduledReviewQuery();
  assert.deepEqual(harness.controller.state.displayedReviewQuery.filters, ["person"]);
});


test("When day shortcuts are Minus, Today, Plus and repeated steps use the active civil day", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = { ...controller.state.reviewRange };
  const generation = controller._queryGeneration;
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);
  const buttons = [...editor.content.querySelectorAll(".review-when-shortcuts button")];
  const rangeFor = dayKey => {
    const bounds = getCivilDayBounds(dayKey, controller.timeZone);
    return { from: bounds.start / 1000, to: bounds.end / 1000 - 1 };
  };

  assert.deepEqual(buttons.map(button => button.textContent), ["-", "Today", "+"]);
  assert.equal(editor.content.textContent.includes("Yesterday"), false);
  assert.deepEqual(buttons.map(button => button.getAttribute("aria-label")), [
    "Previous day", "Today", "Next day"
  ]);

  editor.today.click();
  assert.deepEqual(controller.state.whenDraftRange, rangeFor(controller.todayKey));
  for (let days = 1; days <= 3; days += 1) {
    editor.minus.click();
    assert.deepEqual(
      controller.state.whenDraftRange,
      rangeFor(shiftCivilDayKey(controller.todayKey, -days))
    );
  }

  editor.today.click();
  for (let days = 1; days <= 3; days += 1) {
    editor.plus.click();
    assert.deepEqual(
      controller.state.whenDraftRange,
      rangeFor(shiftCivilDayKey(controller.todayKey, days))
    );
  }

  editor.today.click();
  editor.minus.click();
  editor.plus.click();
  assert.deepEqual(controller.state.whenDraftRange, rangeFor(controller.todayKey));
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.deepEqual(controller.state.reviewRange, committed);
  assert.equal(controller._queryGeneration, generation);
});


test("When day steps use a multi-day draft From date as their sole day authority", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = { ...controller.state.reviewRange };
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);
  const from = Date.parse("2026-09-10T18:30:00-07:00") / 1000;
  const to = Date.parse("2026-09-12T07:45:00-07:00") / 1000;
  const rangeFor = dayKey => {
    const bounds = getCivilDayBounds(dayKey, controller.timeZone);
    return { from: bounds.start / 1000, to: bounds.end / 1000 - 1 };
  };

  controller.setReviewRangeEndpoint("from", from);
  controller.setReviewRangeEndpoint("to", to);
  editor.minus.click();
  assert.deepEqual(controller.state.whenDraftRange, rangeFor("2026-09-09"));

  controller.setReviewRangeEndpoint("from", from);
  controller.setReviewRangeEndpoint("to", to);
  editor.plus.click();
  assert.deepEqual(controller.state.whenDraftRange, rangeFor("2026-09-11"));
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.deepEqual(controller.state.reviewRange, committed);
});


test("When day steps cross DST with civil 23-hour and 25-hour day bounds", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);

  controller.populateWhenDay("2026-03-09");
  editor.minus.click();
  let bounds = getCivilDayBounds("2026-03-08", controller.timeZone);
  assert.deepEqual(controller.state.whenDraftRange, {
    from: bounds.start / 1000, to: bounds.end / 1000 - 1
  });
  assert.equal(controller.state.whenDraftRange.to - controller.state.whenDraftRange.from + 1,
    23 * 3600);

  controller.populateWhenDay("2026-10-31");
  editor.plus.click();
  bounds = getCivilDayBounds("2026-11-01", controller.timeZone);
  assert.deepEqual(controller.state.whenDraftRange, {
    from: bounds.start / 1000, to: bounds.end / 1000 - 1
  });
  assert.equal(controller.state.whenDraftRange.to - controller.state.whenDraftRange.from + 1,
    25 * 3600);
});


test("When day stepping remains draft-only during historical playback", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = { ...controller.state.reviewRange };
  await controller.playHistorical(committed.from + 600, { autoplay: false });
  const clock = controller.clock.absoluteTime;
  const players = new Map(controller._historicalPlayers);
  const generation = controller._queryGeneration;
  const metadataCalls = reviewMetadataCallCount(harness);
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);

  editor.today.click();
  editor.minus.click();
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.deepEqual(controller.state.reviewRange, committed);
  assert.equal(controller.state.presentationMode, "historical");
  assert.equal(controller.clock.absoluteTime, clock);
  assert.equal(controller._queryGeneration, generation);
  assert.equal(reviewMetadataCallCount(harness), metadataCalls);
  for (const [name, player] of players) {
    assert.strictEqual(controller._historicalPlayers.get(name), player);
  }
});


test("When Plus then Enter commits the stepped full day exactly once", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const generation = controller._queryGeneration;
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);
  editor.today.click();
  editor.plus.click();
  const expected = { ...controller.state.whenDraftRange };

  editor.content.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
    bubbles: true, key: "Enter"
  }));
  assert.equal(controller._queryGeneration, generation + 1);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.desiredReviewRange, expected);
  assert.deepEqual(controller.state.reviewRange, expected);
  assert.equal(controller.state.whenDraftRange, null);
  const expectedDate = whenDateLabel(expected.from, controller.timeZone);
  assertWhenControls(editor, {
    fromDate: expectedDate, fromHour: 0, fromMinute: 0,
    toDate: expectedDate, toHour: 23, toMinute: 59
  });
});


test("When stepped drafts abort through Escape and outside click", t => {
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS });
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = { ...controller.state.reviewRange };
  const generation = controller._queryGeneration;
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);

  editor.today.click();
  editor.minus.click();
  editor.content.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
    bubbles: true, key: "Escape"
  }));
  assert.equal(controller.state.whenDraftRange, null);
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.deepEqual(controller.state.reviewRange, committed);

  editor.today.click();
  editor.plus.click();
  harness.window.document.body.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, composed: true
  }));
  assert.equal(controller.state.whenDraftRange, null);
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.deepEqual(controller.state.reviewRange, committed);
  assert.equal(controller._queryGeneration, generation);
  assertWhenControls(editor, {
    fromDate: "09/10/2026", fromHour: 11, fromMinute: 0,
    toDate: "09/10/2026", toHour: 12, toMinute: 0
  });
});


test("When stepped draft survives controller rerender", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = { ...controller.state.reviewRange };
  const generation = controller._queryGeneration;
  controller.setSectionExpanded("when", true);
  let editor = getWhenEditor(harness);
  editor.today.click();
  editor.minus.click();
  const draft = { ...controller.state.whenDraftRange };

  controller.render();
  controller.setHass(controller._hass);
  editor = getWhenEditor(harness);
  assert.deepEqual(controller.state.whenDraftRange, draft);
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.deepEqual(controller.state.reviewRange, committed);
  assert.equal(controller._queryGeneration, generation);
  const expectedDate = whenDateLabel(draft.from, controller.timeZone);
  assertWhenControls(editor, {
    fromDate: expectedDate, fromHour: 0, fromMinute: 0,
    toDate: expectedDate, toHour: 23, toMinute: 59
  });
});


test("When transaction 1: manual Apply commits all six accumulated selections exactly once", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = { ...controller.state.reviewRange };
  await controller.playHistorical(committed.from + 600, { autoplay: false });
  const clock = controller.clock.absoluteTime;
  const players = new Map(controller._historicalPlayers);
  const generation = controller._queryGeneration;
  const metadataCalls = reviewMetadataCallCount(harness);
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);

  selectWhenDate(editor.fromPicker, 2026, 9, 8);
  changeWhenSelect(harness, editor.fromHour, 10);
  changeWhenSelect(harness, editor.fromMinute, 38);
  selectWhenDate(editor.toPicker, 2026, 9, 9);
  changeWhenSelect(harness, editor.toHour, 14);
  changeWhenSelect(harness, editor.toMinute, 41);

  const expected = {
    from: Date.parse("2026-09-08T10:38:00-07:00") / 1000,
    to: Date.parse("2026-09-09T14:41:00-07:00") / 1000
  };
  assertWhenControls(editor, {
    fromDate: "09/08/2026", fromHour: 10, fromMinute: 38,
    toDate: "09/09/2026", toHour: 14, toMinute: 41
  });
  assert.deepEqual(controller.state.whenDraftRange, expected);
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.deepEqual(controller.state.reviewRange, committed);
  assert.equal(controller.state.presentationMode, "historical");
  assert.equal(controller.clock.absoluteTime, clock);
  assert.equal(controller._queryGeneration, generation);
  assert.equal(reviewMetadataCallCount(harness), metadataCalls);
  for (const [name, player] of players) {
    assert.strictEqual(controller._historicalPlayers.get(name), player);
  }

  editor.apply.click();
  assert.equal(controller._queryGeneration, generation + 1);
  assert.equal(controller.state.presentationMode, "live");
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, expected);
  assert.deepEqual(controller.state.desiredReviewRange, expected);
  assert.equal(controller.state.whenDraftRange, null);
  assert.equal(reviewMetadataCallCount(harness), metadataCalls + 1);
  assertWhenControls(editor, {
    fromDate: "09/08/2026", fromHour: 10, fromMinute: 38,
    toDate: "09/09/2026", toHour: 14, toMinute: 41
  });
});


test("When transaction 2: Today remains draft-only and Apply survives retargeted pointerdown", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = { ...controller.state.reviewRange };
  const generation = controller._queryGeneration;
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);
  const bounds = getCivilDayBounds(controller.todayKey, controller.timeZone);
  const expected = { from: bounds.start / 1000, to: bounds.end / 1000 - 1 };
  const expectedDate = whenDateLabel(expected.from, controller.timeZone);

  editor.today.click();
  assert.deepEqual(controller.state.whenDraftRange, expected);
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.deepEqual(controller.state.reviewRange, committed);
  assertWhenControls(editor, {
    fromDate: expectedDate, fromHour: 0, fromMinute: 0,
    toDate: expectedDate, toHour: 23, toMinute: 59
  });
  controller._whenOutsideClickHandler({
    target: harness.root,
    composedPath: () => [editor.apply, editor.content, harness.root, harness.window.document]
  });
  assert.deepEqual(controller.state.whenDraftRange, expected);
  editor.apply.click();
  assert.equal(controller._queryGeneration, generation + 1);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, expected);
  assert.deepEqual(controller.state.desiredReviewRange, expected);
  assert.equal(controller.state.whenDraftRange, null);
  assertWhenControls(editor, {
    fromDate: expectedDate, fromHour: 0, fromMinute: 0,
    toDate: expectedDate, toHour: 23, toMinute: 59
  });
});


test("When transaction 3: Minus from Today commits the previous local day without reverting", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = { ...controller.state.reviewRange };
  const generation = controller._queryGeneration;
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);
  const dayKey = shiftCivilDayKey(controller.todayKey, -1);
  const bounds = getCivilDayBounds(dayKey, controller.timeZone);
  const expected = { from: bounds.start / 1000, to: bounds.end / 1000 - 1 };
  const expectedDate = whenDateLabel(expected.from, controller.timeZone);

  editor.today.click();
  editor.minus.click();
  assert.deepEqual(controller.state.whenDraftRange, expected);
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assertWhenControls(editor, {
    fromDate: expectedDate, fromHour: 0, fromMinute: 0,
    toDate: expectedDate, toHour: 23, toMinute: 59
  });
  editor.apply.click();
  assert.equal(controller._queryGeneration, generation + 1);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, expected);
  assert.deepEqual(controller.state.desiredReviewRange, expected);
  assert.equal(controller.state.whenDraftRange, null);
  assertWhenControls(editor, {
    fromDate: expectedDate, fromHour: 0, fromMinute: 0,
    toDate: expectedDate, toHour: 23, toMinute: 59
  });
});


test("When transaction 4: Enter captures and commits the complete draft exactly once", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const generation = controller._queryGeneration;
  const metadataCalls = reviewMetadataCallCount(harness);
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);
  selectWhenDate(editor.fromPicker, 2026, 9, 8);
  changeWhenSelect(harness, editor.fromHour, 8);
  changeWhenSelect(harness, editor.fromMinute, 12);
  selectWhenDate(editor.toPicker, 2026, 9, 9);
  changeWhenSelect(harness, editor.toHour, 19);
  changeWhenSelect(harness, editor.toMinute, 44);
  const expected = {
    from: Date.parse("2026-09-08T08:12:00-07:00") / 1000,
    to: Date.parse("2026-09-09T19:44:00-07:00") / 1000
  };

  editor.content.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
    bubbles: true, key: "Enter"
  }));
  assert.equal(controller._queryGeneration, generation + 1);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, expected);
  assert.deepEqual(controller.state.desiredReviewRange, expected);
  assert.equal(controller.state.whenDraftRange, null);
  assert.equal(reviewMetadataCallCount(harness), metadataCalls + 1);
  assertWhenControls(editor, {
    fromDate: "09/08/2026", fromHour: 8, fromMinute: 12,
    toDate: "09/09/2026", toHour: 19, toMinute: 44
  });
});


test("When transaction 5: Escape discards all edits and restores committed controls", t => {
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS });
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = { ...controller.state.reviewRange };
  const generation = controller._queryGeneration;
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);
  selectWhenDate(editor.fromPicker, 2026, 9, 8);
  changeWhenSelect(harness, editor.fromHour, 7);
  changeWhenSelect(harness, editor.fromMinute, 21);
  selectWhenDate(editor.toPicker, 2026, 9, 9);
  changeWhenSelect(harness, editor.toHour, 18);
  changeWhenSelect(harness, editor.toMinute, 52);

  editor.content.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
    bubbles: true, key: "Escape"
  }));
  assert.deepEqual(controller.state.reviewRange, committed);
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.equal(controller.state.whenDraftRange, null);
  assert.equal(controller._queryGeneration, generation);
  assertWhenControls(editor, {
    fromDate: "09/10/2026", fromHour: 11, fromMinute: 0,
    toDate: "09/10/2026", toHour: 12, toMinute: 0
  });
});


test("When transaction 6: outside pointerdown aborts without a timeframe change", t => {
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS });
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = { ...controller.state.reviewRange };
  const generation = controller._queryGeneration;
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);
  editor.today.click();
  changeWhenSelect(harness, editor.fromHour, 6);
  changeWhenSelect(harness, editor.toMinute, 17);

  harness.window.document.body.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true, composed: true
  }));
  assert.deepEqual(controller.state.reviewRange, committed);
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.equal(controller.state.whenDraftRange, null);
  assert.equal(controller._queryGeneration, generation);
  assertWhenControls(editor, {
    fromDate: "09/10/2026", fromHour: 11, fromMinute: 0,
    toDate: "09/10/2026", toHour: 12, toMinute: 0
  });
});


test("When transaction 7: date input survives immediate movement to hour and minute", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = { ...controller.state.reviewRange };
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);

  editor.fromPicker.altInput.value = "09/08/2026";
  editor.fromPicker.altInput.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
  changeWhenSelect(harness, editor.fromHour, 10);
  changeWhenSelect(harness, editor.fromMinute, 38);

  assert.equal(editor.fromPicker.altInput.value, "09/08/2026");
  assert.equal(editor.fromHour.value, "10");
  assert.equal(editor.fromMinute.value, "38");
  assert.equal(
    controller.state.whenDraftRange.from,
    Date.parse("2026-09-08T10:38:00-07:00") / 1000
  );
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.deepEqual(controller.state.reviewRange, committed);
});


test("When transaction 8: reopen initializes from the newly committed range", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = {
    from: Date.parse("2026-09-08T10:38:00-07:00") / 1000,
    to: Date.parse("2026-09-09T14:41:00-07:00") / 1000
  };
  controller.setReviewRangeEndpoint("from", committed.from);
  controller.setReviewRangeEndpoint("to", committed.to);
  assert.equal(controller.applyWhenDraft(), true);
  controller.setSectionExpanded("when", true);
  controller.setSectionExpanded("when", false);
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);

  assert.deepEqual(controller.state.whenDraftRange, committed);
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assertWhenControls(editor, {
    fromDate: "09/08/2026", fromHour: 10, fromMinute: 38,
    toDate: "09/09/2026", toHour: 14, toMinute: 41
  });
});


test("When transaction 9: shortcut plus manual edits commits one mixed draft", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const generation = controller._queryGeneration;
  controller.setSectionExpanded("when", true);
  const editor = getWhenEditor(harness);
  const bounds = getCivilDayBounds(controller.todayKey, controller.timeZone);
  const expectedDate = whenDateLabel(bounds.start / 1000, controller.timeZone);

  editor.today.click();
  changeWhenSelect(harness, editor.fromHour, 6);
  changeWhenSelect(harness, editor.fromMinute, 30);
  changeWhenSelect(harness, editor.toHour, 20);
  changeWhenSelect(harness, editor.toMinute, 15);
  const expected = {
    from: bounds.start / 1000 + (6 * 60 + 30) * 60,
    to: bounds.start / 1000 + (20 * 60 + 15) * 60 + 59
  };
  assert.deepEqual(controller.state.whenDraftRange, expected);
  editor.apply.click();
  assert.equal(controller._queryGeneration, generation + 1);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, expected);
  assert.deepEqual(controller.state.desiredReviewRange, expected);
  assertWhenControls(editor, {
    fromDate: expectedDate, fromHour: 6, fromMinute: 30,
    toDate: expectedDate, toHour: 20, toMinute: 15
  });
});


test("When transaction 10: active draft survives controller rerender and state updates", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const committed = { ...controller.state.reviewRange };
  const generation = controller._queryGeneration;
  controller.setSectionExpanded("when", true);
  let editor = getWhenEditor(harness);
  selectWhenDate(editor.fromPicker, 2026, 9, 8);
  changeWhenSelect(harness, editor.fromHour, 9);
  changeWhenSelect(harness, editor.fromMinute, 27);
  selectWhenDate(editor.toPicker, 2026, 9, 9);
  changeWhenSelect(harness, editor.toHour, 17);
  changeWhenSelect(harness, editor.toMinute, 53);
  const draft = { ...controller.state.whenDraftRange };

  controller.render();
  controller.setHass(controller._hass);
  editor = getWhenEditor(harness);
  assert.deepEqual(controller.state.whenDraftRange, draft);
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.deepEqual(controller.state.reviewRange, committed);
  assert.equal(controller._queryGeneration, generation);
  assertWhenControls(editor, {
    fromDate: "09/08/2026", fromHour: 9, fromMinute: 27,
    toDate: "09/09/2026", toHour: 17, toMinute: 53
  });
});


test("When owns one valid From/To interval and explicit live return retains it", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  assert.equal(harness.root.querySelectorAll(".review-range-picker").length, 4);
  assert.equal(harness.root.querySelector(".review-day-picker"), null);
  const initial = harness.controller.state.reviewRange;
  assert.equal(initial.to - initial.from, 3600);
  await harness.controller.playHistorical(1800000000);
  const activeRange = harness.controller.state.reviewRange;
  assert.ok(activeRange.from <= 1800000000 && activeRange.to >= 1800000000);
  assert.equal(harness.controller.state.presentationMode, "historical");
  assert.equal(harness.root.querySelector(".review-now"), null);
  harness.controller.returnToLive();
  assert.equal(harness.controller.state.presentationMode, "live");
  assert.deepEqual(harness.controller.state.reviewRange, activeRange);
  assert.equal(harness.root.querySelectorAll("hui-image.review-live-camera").length, 2);
});


test("Review From/To edits remain draft-only until Apply", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const initial = controller.state.reviewRange;
  const clockValue = initial.from + 720;
  controller.clock.setAbsolute(clockValue);
  const from = initial.from + 600;
  const to = initial.to + 600;
  assert.equal(controller.setReviewRangeEndpoint("from", from), true);
  assert.equal(controller.setReviewRangeEndpoint("to", to), true);
  assert.deepEqual(controller.state.reviewRange, initial);
  assert.deepEqual(controller.state.desiredReviewRange, initial);
  assert.deepEqual(controller.state.whenDraftRange, { from, to });
  assert.equal(harness.starts.length, 0);
  assert.equal(await controller.flushScheduledReviewQuery(), false);
  assert.deepEqual(controller.state.reviewRange, initial);
  assert.deepEqual(controller.state.desiredReviewRange, initial);
  assert.deepEqual(controller.state.whenDraftRange, { from, to });
  assert.equal(controller._queryRefreshCount, 1);
  assert.equal(controller.clock.absoluteTime, clockValue);
  assert.equal(controller.applyWhenDraft(), true);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, { from, to });
  assert.equal(controller._queryRefreshCount, 2);
});


test("Review direct hour and minute selectors edit draft time until Apply", async t => {
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS });
  t.after(() => harness.close());
  const controller = harness.controller;
  const displayed = controller.state.reviewRange;
  const hour = harness.root.querySelector(".review-from-picker").closest(".review-range-field")
    .nextElementSibling.querySelector(".review-time-hour");
  const minute = harness.root.querySelector(".review-from-picker").closest(".review-range-field")
    .nextElementSibling.querySelector(".review-time-minute");
  assert.equal(harness.root.querySelectorAll(".review-direct-time select").length, 4);
  hour.value = "10";
  hour.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  minute.value = "38";
  minute.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  const desired = controller.state.whenDraftRange;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(desired.from * 1000));
  assert.equal(parts.find(part => part.type === "hour").value, "10");
  assert.equal(parts.find(part => part.type === "minute").value, "38");
  assert.deepEqual(controller.state.reviewRange, displayed);
  assert.equal(controller._queryRefreshCount, 1);
  assert.equal(await controller.flushScheduledReviewQuery(), false);
  assert.deepEqual(controller.state.reviewRange, displayed);
  assert.deepEqual(controller.state.desiredReviewRange, displayed);
  assert.equal(controller.applyWhenDraft(), true);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, desired);
});


test("When date drafts persist across time controls without changing committed playback", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  harness.root.querySelector(".review-when-section .sidebar-section-header").click();
  const committed = { ...controller.state.reviewRange };
  await controller.selectTimelineTime(committed.from + 600);
  controller.pausePlayback();
  const committedClock = controller.clock.absoluteTime;
  const refreshes = controller._queryRefreshCount;
  const players = new Map(controller._historicalPlayers);
  const fromPicker = controller._datePickers.from;
  const toPicker = controller._datePickers.to;
  const fromField = harness.root.querySelector(".review-from-picker")
    .closest(".review-range-field").nextElementSibling;
  const toField = harness.root.querySelector(".review-to-picker")
    .closest(".review-range-field").nextElementSibling;

  fromPicker.altInput.value = "09/08/2026";
  fromPicker.altInput.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
  const fromHour = fromField.querySelector(".review-time-hour");
  const fromMinute = fromField.querySelector(".review-time-minute");
  fromHour.value = "10";
  fromHour.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  assert.equal(fromPicker.altInput.value, "09/08/2026");
  fromMinute.value = "38";
  fromMinute.dispatchEvent(new harness.window.Event("change", { bubbles: true }));

  toPicker.altInput.value = "09/09/2026";
  toPicker.altInput.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
  const toHour = toField.querySelector(".review-time-hour");
  const toMinute = toField.querySelector(".review-time-minute");
  toHour.value = "14";
  toHour.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  assert.equal(toPicker.altInput.value, "09/09/2026");
  toMinute.value = "41";
  toMinute.dispatchEvent(new harness.window.Event("change", { bubbles: true }));

  const expected = {
    from: Date.parse("2026-09-08T10:38:00-07:00") / 1000,
    to: Date.parse("2026-09-09T14:41:00-07:00") / 1000
  };
  assert.deepEqual(controller.state.whenDraftRange, expected);
  assert.deepEqual(controller.state.desiredReviewRange, committed);
  assert.deepEqual(controller.state.reviewRange, committed);
  assert.equal(controller.state.presentationMode, "historical");
  assert.equal(controller.clock.absoluteTime, committedClock);
  assert.equal(controller._queryRefreshCount, refreshes);
  for (const [name, player] of players) {
    assert.strictEqual(controller._historicalPlayers.get(name), player);
  }
  assert.equal(fromPicker.altInput.value, "09/08/2026");
  assert.equal(fromHour.value, "10");
  assert.equal(fromMinute.value, "38");
  assert.equal(toPicker.altInput.value, "09/09/2026");
  assert.equal(toHour.value, "14");
  assert.equal(toMinute.value, "41");

  assert.equal(controller.applyWhenDraft(), true);
  assert.equal(controller.state.presentationMode, "live");
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, expected);
});


test("When supports Apply and Enter commit plus Escape, outside, and day draft aborts", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const content = harness.root.querySelector(".review-when-controls");
  const initial = { ...controller.state.reviewRange };
  const first = { from: initial.from + 60, to: initial.to + 60 };
  controller.setReviewRangeEndpoint("from", first.from);
  controller.setReviewRangeEndpoint("to", first.to);
  assert.deepEqual(controller.state.reviewRange, initial);
  content.querySelector(".review-when-apply").click();
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, first);

  const second = { from: first.from + 60, to: first.to + 60 };
  controller.setReviewRangeEndpoint("from", second.from);
  controller.setReviewRangeEndpoint("to", second.to);
  content.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
    bubbles: true, key: "Enter"
  }));
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, second);

  controller.setReviewRangeEndpoint("from", second.from - 60);
  content.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
    bubbles: true, key: "Escape"
  }));
  assert.deepEqual(controller.state.desiredReviewRange, second);
  assert.equal(controller.state.whenDraftRange, null);

  controller.setReviewRangeEndpoint("to", second.to + 60);
  harness.window.document.body.dispatchEvent(new harness.window.PointerEvent("pointerdown", {
    bubbles: true
  }));
  assert.deepEqual(controller.state.desiredReviewRange, second);
  assert.equal(controller.state.whenDraftRange, null);

  const refreshes = controller._queryRefreshCount;
  const todayBounds = getCivilDayBounds(controller.todayKey, controller.timeZone);
  const today = harness.root.querySelectorAll(".review-when-shortcuts button")[1];
  today.click();
  assert.deepEqual(controller.state.whenDraftRange, {
    from: todayBounds.start / 1000, to: todayBounds.end / 1000 - 1
  });
  assert.deepEqual(controller.state.desiredReviewRange, second);
  assert.deepEqual(controller.state.reviewRange, second);
  assert.equal(controller._queryRefreshCount, refreshes);

  const minus = harness.root.querySelectorAll(".review-when-shortcuts button")[0];
  minus.click();
  assert.notDeepEqual(controller.state.whenDraftRange, {
    from: todayBounds.start / 1000, to: todayBounds.end / 1000 - 1
  });
  assert.deepEqual(controller.state.desiredReviewRange, second);
  assert.deepEqual(controller.state.reviewRange, second);
  assert.equal(controller._queryRefreshCount, refreshes);

  const plus = harness.root.querySelectorAll(".review-when-shortcuts button")[2];
  plus.click();
  assert.deepEqual(controller.state.whenDraftRange, {
    from: todayBounds.start / 1000, to: todayBounds.end / 1000 - 1
  });
  assert.deepEqual(controller.state.desiredReviewRange, second);
  assert.deepEqual(controller.state.reviewRange, second);
  assert.equal(controller._queryRefreshCount, refreshes);
});


test("invalid intermediate range does not query or replace displayed results", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const displayed = controller.state.displayedReviewQuery;
  const refreshes = controller._queryRefreshCount;
  controller.setReviewRangeEndpoint("from", displayed.range.to);
  assert.equal(await controller.flushScheduledReviewQuery(), false);
  assert.deepEqual(controller.state.displayedReviewQuery, displayed);
  assert.equal(controller._queryRefreshCount, refreshes);
  controller.setReviewRangeEndpoint("to", displayed.range.to + 600);
  assert.deepEqual(controller.state.reviewRange, displayed.range);
  assert.equal(controller.applyWhenDraft(), true);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, {
    from: displayed.range.to, to: displayed.range.to + 600
  });
});


test("Review Timeline refresh queries desired range and renders newest at top", async t => {
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS, reviewEvents: [
    { camera_id: "drive_up", start_time: 1789065000, end_time: 1789065060, type: "person", labels: ["person"] },
    { camera_id: "drive_down", start_time: 1789066800, type: "car", labels: ["car"] }
  ] });
  t.after(() => harness.close());
  const controller = harness.controller;
  const displayed = controller.state.reviewRange;
  const desired = { from: displayed.from + 600, to: displayed.to };
  controller.setReviewRangeEndpoint("from", desired.from);
  controller.setReviewRangeEndpoint("to", desired.to);
  assert.deepEqual(controller.state.reviewRange, displayed);
  assert.equal(controller.applyWhenDraft(), true);
  await controller.flushScheduledReviewQuery();
  const request = harness.calls.filter(call => call.type === "frigate_max/v1/review/get").at(-1);
  assert.deepEqual(request.cameras, ["drive_up", "drive_down"]);
  assert.deepEqual({ from: request.from, to: request.to }, desired);
  assert.equal(controller.state.timeline.status, "loaded");
  assert.equal(controller.state.timeline.items.length, 2);
  const markers = [...harness.root.querySelectorAll(".review-timeline-marker")];
  const firstGeometry = reviewTimelineMarkerGeometry(controller.state.timeline.items[0], desired);
  assert.match(markers[0].getAttribute("style"),
    new RegExp(`top:min\\(${firstGeometry.top * 100}%, calc\\(100% - 1px\\)\\)`));
  assert.match(markers[0].getAttribute("style"),
    new RegExp(`height:max\\(${firstGeometry.height * 100}%, 1px\\)`));
  assert.match(markers[1].getAttribute("style"), /top:0%;height:0%/);
  assert.equal(harness.root.querySelector(".review-timeline-endpoints"), null);
});


test("Timeline epoch and marker geometry share one reversible plot transform", () => {
  const range = { from: 1000, to: 4600 };
  const top = 120;
  const height = 720;
  for (const [epoch, expectedY] of [[range.to, top], [range.from, top + height], [2800, top + height / 2]]) {
    const fraction = reviewTimelineMarkerTop(epoch, range);
    assert.equal(top + fraction * height, expectedY);
    assert.ok(Math.abs(reviewTimelineEpochFromCoordinate(expectedY, top, height, range) - epoch) < 1e-9);
  }
  const item = { camera_id: "drive_up", start_time: 1900, end_time: 3700 };
  const geometry = reviewTimelineMarkerGeometry(item, range);
  const markerTop = top + geometry.top * height;
  const markerBottom = markerTop + geometry.height * height;
  const cursorY = top + reviewTimelineMarkerTop(2800, range) * height;
  const selected = reviewTimelineEpochFromCoordinate(cursorY, top, height, range);
  assert.ok(cursorY >= markerTop && cursorY <= markerBottom);
  assert.ok(item.start_time <= selected && selected <= item.end_time);
});


test("06:53 selection does not intersect later activity or gain synthetic marker duration", () => {
  const range = { from: 1789048140, to: 1789049280 };
  const selected = 1789048380;
  const event = {
    camera_id: "drive_up",
    start_time: 1789048425.2805,
    end_time: 1789048427.290356
  };
  const geometry = reviewTimelineMarkerGeometry(event, range);
  const cursorTop = reviewTimelineMarkerTop(selected, range);
  assert.ok(selected < event.start_time);
  assert.ok(cursorTop > geometry.top + geometry.height);

  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.review-timeline-marker\s*{[^}]*min-height:\s*[1-9]/s);
  assert.doesNotMatch(source, /min-height:\s*18px/);
  assert.match(source, /\.review-timeline-marker\.point\s*{[^}]*height:\s*0\s*!important/s);
});


test("duration markers retain proportional height with a 1px display floor and clipped boundaries", t => {
  const wall = 1800000000;
  const range = { from: wall - 86400, to: wall };
  const harness = createHistoricalHarness({ debug: true, wallClockMs: wall * 1000, initialReviewRange: range });
  t.after(() => harness.close());
  const controller = harness.controller;
  const events = {
    long: { camera_id: "drive_up", start_time: wall - 8000, end_time: wall - 800 },
    above: { camera_id: "drive_up", start_time: wall - 5000, end_time: wall - 4700 },
    short: { camera_id: "drive_up", start_time: wall - 120, end_time: wall - 90 },
    clipped: { camera_id: "drive_up", start_time: range.from - 20, end_time: range.from + 10 },
    outside: { camera_id: "drive_up", start_time: range.from - 300, end_time: range.from - 10 },
    boundary: { camera_id: "drive_up", start_time: range.from, end_time: range.from }
  };
  controller._timeline = { status: "loaded", refreshing: false,
    items: Object.values(events), error: null, queryRange: { ...range } };
  controller.updateRhs();
  const markerFor = epoch => [...harness.root.querySelectorAll(".review-timeline-marker")]
    .find(marker => marker.dataset.startEpoch === String(epoch));
  const visiblePixels = marker => {
    const match = marker.getAttribute("style").match(/height:max\(([^%]+)%, 1px\)/);
    assert.ok(match);
    return Math.max(Number(match[1]) * 6, 1); // 600px axis: percent * 600 / 100.
  };
  assert.ok(Math.abs(visiblePixels(markerFor(events.long.start_time)) - 50) < 1e-9);
  assert.ok(Math.abs(visiblePixels(markerFor(events.above.start_time)) - 300 / 86400 * 600) < 1e-9);
  assert.equal(visiblePixels(markerFor(events.short.start_time)), 1);
  assert.equal(visiblePixels(markerFor(events.clipped.start_time)), 1);
  assert.match(markerFor(events.clipped.start_time).getAttribute("style"),
    /top:min\([^;]+%, calc\(100% - 1px\)\)/);
  assert.equal(markerFor(events.outside.start_time), undefined);
  assert.ok(markerFor(events.boundary.start_time).classList.contains("point"));
  assert.equal(markerFor(events.short.start_time).dataset.endEpoch, String(events.short.end_time));
  assert.ok(controller.getEventNavigationInventory().includes(events.short.start_time));
  assert.equal(controller.getEventNavigationTargets(wall - 121).next, events.short.start_time);

  controller.setTimelineViewport({ from: wall - 3600, to: wall });
  assert.ok(Math.abs(visiblePixels(markerFor(events.short.start_time)) - 5) < 1e-9);
  assert.equal(markerFor(events.short.start_time).dataset.startEpoch, String(events.short.start_time));
  assert.equal(markerFor(events.short.start_time).dataset.endEpoch, String(events.short.end_time));
  assert.ok(controller.getEventNavigationInventory().includes(events.short.start_time));
  assert.equal(controller.getEventNavigationTargets(wall - 121).next, events.short.start_time);
});


test("Timeline consumes all remaining RHS height between its tabs and time footer", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(source, /\.review-rhs\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  assert.match(source, /\.review-rhs-modes\s*{[^}]*flex:\s*0 0 34px;/s);
  assert.match(source, /\.review-rhs-content\s*{[^}]*display:\s*flex;[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(source, /\.review-time-truth\s*{[^}]*flex:\s*0 0 34px;/s);
  assert.match(source, /\.review-timeline\s*{[^}]*display:\s*flex;[^}]*flex:\s*1 1 auto;[^}]*flex-direction:\s*column;[^}]*min-height:\s*0;/s);
  assert.match(source, /\.review-timeline-lane-headings\s*{[^}]*flex:\s*0 0 28px;/s);
  assert.match(source, /\.review-timeline-axis\s*{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/s);
  assert.doesNotMatch(source, /\.review-timeline-endpoints\s*{/);
});


test("Timeline renders stable camera-colored lanes with one protected time gutter", async t => {
  const overlap = { start_time: 1789065000, end_time: 1789065600, type: "motion" };
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS, reviewEvents: [
    { ...overlap, camera_id: "drive_up" },
    { ...overlap, camera_id: "drive_down" }
  ] });
  t.after(() => harness.close());
  await harness.controller.refreshReviewQuery();

  const headings = [...harness.root.querySelectorAll(".review-timeline-lane-heading")];
  const lanes = [...harness.root.querySelectorAll(".review-timeline-lane")];
  const markers = [...harness.root.querySelectorAll(".review-timeline-marker")];
  assert.deepEqual(headings.map(node => node.textContent), ["Drive Up", "Drive Down"]);
  assert.equal(harness.root.querySelectorAll(".review-timeline-time-heading").length, 1);
  assert.equal(lanes.length, 2);
  assert.equal(markers.length, 2);
  assert.strictEqual(markers[0].parentElement, lanes[0]);
  assert.strictEqual(markers[1].parentElement, lanes[1]);
  assert.equal(markers[0].style.top, markers[1].style.top);
  assert.equal(markers[0].textContent, "");
  assert.equal(markers[1].textContent, "");
  assert.equal(markers[0].style.getPropertyValue("--review-camera-color"), REVIEW_TIMELINE_CAMERA_COLORS[0]);
  assert.equal(markers[1].style.getPropertyValue("--review-camera-color"), REVIEW_TIMELINE_CAMERA_COLORS[1]);
  assert.equal(harness.root.querySelector(".review-timeline-lanes .review-timeline-tick"), null);

  harness.controller.updateRhs();
  const rerendered = [...harness.root.querySelectorAll(".review-timeline-marker")];
  assert.equal(rerendered[0].style.getPropertyValue("--review-camera-color"), REVIEW_TIMELINE_CAMERA_COLORS[0]);
  assert.equal(rerendered[1].style.getPropertyValue("--review-camera-color"), REVIEW_TIMELINE_CAMERA_COLORS[1]);
});


test("the fixed RHS footer is the sole authoritative Review time in live, paused, and playing states", async t => {
  let now = 1000;
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS, now: () => now });
  t.after(() => harness.close());
  const controller = harness.controller;
  const footer = harness.root.querySelector(".review-time-truth");
  let output = footer.querySelector(".review-clock-display");
  assert.equal(harness.transportRoot.querySelector(".review-clock-display"), null);
  assert.equal(footer.querySelectorAll(".review-clock-display").length, 1);
  assert.strictEqual(footer.firstElementChild, output);
  assert.doesNotMatch(footer.textContent, /Review Time:/);
  assert.equal(output.dateTime, "2026-09-10T19:00:00.000Z");

  const range = controller.state.displayedReviewQuery.range;
  const target = range.from + (range.to - range.from) / 2;
  await controller.selectTimelineTime(target);
  controller.pausePlayback();
  output = harness.root.querySelector(".review-time-truth .review-clock-display");
  assert.equal(output.dateTime, new Date(target * 1000).toISOString());

  controller.resumePlayback();
  now += 2500;
  controller.updateClockDisplay();
  assert.equal(controller.clock.absoluteTime, target + 2.5);
  assert.equal(output.dateTime, new Date((target + 2.5) * 1000).toISOString());

  controller.returnToLive();
  controller.updateClockDisplay();
  output = harness.root.querySelector(".review-time-truth .review-clock-display");
  assert.equal(output.dateTime, "2026-09-10T19:00:00.000Z");
});


// Timeline footer: Go to Top / Go to Bottom move only the timeline viewport.
test("Timeline footer places Go to Top left, Review time centred, Go to Bottom right", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const footer = harness.root.querySelector(".review-time-truth");
  const [clock, top, bottom] = footer.children;
  assert.equal(footer.children.length, 3);
  assert.ok(clock.classList.contains("review-clock-display"), "the time display stays the first child");
  for (const [button, edge, icon, label] of [
    [top, "top", "mdi:arrow-collapse-up", "Go to top: newest time in the When range"],
    [bottom, "bottom", "mdi:arrow-collapse-down", "Go to bottom: earliest time in the When range"]
  ]) {
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.type, "button");
    assert.ok(button.classList.contains(`review-timeline-${edge}`));
    assert.equal(button.getAttribute("aria-label"), label);
    assert.equal(button.title, label);
    const symbol = button.querySelector("ha-icon");
    assert.equal(symbol.getAttribute("icon"), icon);
    assert.equal(symbol.getAttribute("aria-hidden"), "true");
  }
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  const rule = selector => source.match(new RegExp(`\\n\\s*${selector.replace(/[.]/g, "\\.")}\\s*{([^}]*)}`))?.[1] ?? "";
  const footerRule = rule(".review-time-truth");
  assert.match(footerRule, /display:\s*grid;/);
  assert.match(footerRule, /grid-template-columns:\s*minmax\(30px, 1fr\) auto minmax\(30px, 1fr\);/,
    "equal outer columns keep the time exactly centred");
  assert.match(footerRule, /align-items:\s*center;/);
  assert.match(footerRule, /flex:\s*0 0 34px;/, "footer height is unchanged");
  assert.match(rule(".review-time-truth .review-clock-display"), /grid-column:\s*2;[^]*grid-row:\s*1;/);
  assert.match(rule(".review-timeline-top"), /grid-column:\s*1;[^]*justify-self:\s*start;/);
  assert.match(rule(".review-timeline-bottom"), /grid-column:\s*3;[^]*justify-self:\s*end;/);
  const edgeRule = rule(".review-timeline-edge");
  assert.match(edgeRule, /grid-row:\s*1;/);
  assert.match(edgeRule, /height:\s*30px;/, "30 px controls fit the 34 px footer");
  assert.match(edgeRule, /background:\s*transparent;/);
});


test("Go to Top and Go to Bottom move the viewport and navigate Review time through the Timeline path", async t => {
  const T = 1800000000;
  const when = { from: T - 3 * 86400, to: T };
  const harness = createHistoricalHarness({ initialReviewRange: when, now: () => 1000 });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.playHistorical(T - 86400, { autoplay: false, updateDisplayedRange: false, playbackRange: when });
  await drainReview(controller);
  const top = harness.root.querySelector(".review-timeline-top");
  const bottom = harness.root.querySelector(".review-timeline-bottom");
  controller.resetTimelineViewport();
  const duration = controller._timelineViewport.to - controller._timelineViewport.from;
  assert.equal(top.disabled, false);
  assert.equal(bottom.disabled, false);
  const prepares = () => harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare").length;
  const prepared = prepares();
  const requestId = controller._reviewRequestId;

  assert.equal(await controller.goToTimelineEdge("top"), true);
  await drainReview(controller);
  assert.deepEqual(controller._timelineViewport, { from: when.to - duration, to: when.to });
  assert.equal(controller.clock.absoluteTime, when.to, "Review time is the newest end of When");
  assert.equal(controller.clock.running, false, "Pause intent is preserved");
  assert.equal(controller._presentationMode, "historical");
  assert.ok(controller._reviewRequestId > requestId, "an ordinary Review navigation request");
  assert.equal(controller._blackboard.session.navigation.bySource.timeline.requested, 1);
  assert.equal(top.disabled, true, "viewport and Review time are both at the top");
  assert.equal(bottom.disabled, false);

  bottom.click();
  await waitForCondition(() => controller.clock.absoluteTime === when.from);
  await drainReview(controller);
  assert.deepEqual(controller._timelineViewport, { from: when.from, to: when.from + duration });
  assert.ok(prepares() > prepared, "cameras are acquired at the endpoint by the normal path");
  assert.ok([...controller._historicalPlayers.values()].every(player =>
    player.lifecycleState === "participating" && player.video.paused));
  assert.equal(bottom.disabled, true);
  assert.equal(top.disabled, false);
});


test("Go to Top and Go to Bottom stay usable when the whole When range fits the viewport", async t => {
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS, now: () => 1000 });
  t.after(() => harness.close());
  manualViewTimers(harness.window);
  const controller = harness.controller;
  await controller.refreshReviewQuery();
  controller.updateRhs();
  const when = controller.state.displayedReviewQuery.range;
  assert.deepEqual(controller._timelineViewport, { from: when.from, to: when.to }, "the viewport is at both edges");
  const bottom = harness.root.querySelector(".review-timeline-bottom");
  const top = harness.root.querySelector(".review-timeline-top");
  assert.equal(bottom.disabled, false, "Review time is elsewhere, so Bottom still navigates");
  bottom.click();
  await waitForCondition(() => controller._presentationMode === "historical" &&
    controller.clock.absoluteTime === when.from);
  await drainReview(controller);
  assert.equal(bottom.disabled, true);
  assert.equal(top.disabled, false);
  assert.equal(await controller.goToTimelineEdge("top"), true);
  await drainReview(controller);
  assert.equal(controller.reviewPosition, Math.min(when.to, HARNESS_CALENDAR_WALL_CLOCK_MS / 1000));
  assert.equal(top.disabled, true);
  assert.equal(bottom.disabled, false);
});


test("Go to Top with a When range ending in the future navigates Review to now, never forcing Live", async t => {
  const wall = HARNESS_PLAYBACK_WALL_CLOCK_MS / 1000;
  const when = { from: wall - 1800, to: wall + 1800 };
  const harness = createHistoricalHarness({ initialReviewRange: when, now: () => 1000 });
  t.after(() => harness.close());
  manualViewTimers(harness.window);
  const controller = harness.controller;
  controller.updateRhs();
  assert.equal(await controller.goToTimelineEdge("top"), true);
  await drainReview(controller);
  assert.equal(controller._presentationMode, "historical", "an ordinary Review navigation, not Live");
  assert.equal(controller.clock.absoluteTime, wall, "the newest Review time that exists");
  assert.equal(controller._timelineViewport.to, when.to);
});


test("Go to Top and Go to Bottom are unavailable off the Timeline tab", async t => {
  const T = 1800000000;
  const when = { from: T - 3 * 86400, to: T };
  const harness = createHistoricalHarness({ initialReviewRange: when, now: () => 1000 });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.playHistorical(T - 86400, { autoplay: false, updateDisplayedRange: false, playbackRange: when });
  await drainReview(controller);
  controller.setRhsMode("events");
  const top = harness.root.querySelector(".review-timeline-top");
  const bottom = harness.root.querySelector(".review-timeline-bottom");
  assert.equal(top.disabled, true);
  assert.equal(bottom.disabled, true);
  const requestId = controller._reviewRequestId;
  assert.equal(await controller.goToTimelineEdge("top"), false);
  assert.equal(controller.clock.absoluteTime, T - 86400);
  assert.equal(controller._reviewRequestId, requestId);
  controller.setRhsMode("timeline");
  assert.equal(top.disabled, false);
});


test("Go to Top and Go to Bottom from Playing move viewport and Review time and end paused", async t => {
  const scene = await edgeScene(t);
  const { controller, when, plays } = scene;
  await bbPlay(scene, 2000);
  assert.equal(controller.clock.running, true, "playing before the click");
  for (const [edge, epoch] of [["top", when.to], ["bottom", when.from]]) {
    controller.resumePlayback();
    await drainReview(controller);
    const before = plays();
    assert.equal(await controller.goToTimelineEdge(edge), true);
    await drainReview(controller);
    await scene.expectPausedAt(epoch, edge);
    assert.equal(plays(), before, `${edge}: no Play command is issued`);
    const viewport = controller._timelineViewport;
    assert.equal(edge === "top" ? viewport.to : viewport.from, epoch);
  }
  // Normal Play still works afterwards.
  assert.equal(controller.resumePlayback(), true);
  await drainReview(controller);
  assert.equal(controller.clock.running, true);
});


test("rapid alternating Top/Bottom clicks while navigation is pending never start Play", async t => {
  const scene = await edgeScene(t);
  const { controller, harness, when, plays } = scene;
  controller.pausePlayback();
  await drainReview(controller);
  const before = plays();
  // Withhold every landing so each navigation is still pending when the next click lands.
  scene.deferredFrame.add("Drive Up");
  scene.deferredFrame.add("Drive Down");
  const top = harness.root.querySelector(".review-timeline-top");
  const bottom = harness.root.querySelector(".review-timeline-bottom");
  for (const button of [top, bottom, top, bottom, top, bottom]) {
    button.click();
    await Promise.resolve();
  }
  scene.deferredFrame.clear();
  for (const name of ["Drive Up", "Drive Down"]) scene.media(name)?.emitFrame();
  await drainReview(controller);
  await scene.expectPausedAt(when.from, "after the last (Bottom) click");
  assert.equal(plays(), before);
});


test("a superseded Play-intent seek completing late cannot resume playback after Go to Bottom", async t => {
  const scene = await edgeScene(t);
  const { controller, when, plays } = scene;
  await bbPlay(scene, 1000);
  // A Play-intent navigation whose acquisition is still pending.
  scene.deferredFrame.add("Drive Up");
  scene.deferredFrame.add("Drive Down");
  const stale = controller.seekHistoricalToEpoch(RECOVERY_T + 1800, { autoplay: true });
  await Promise.resolve();
  const before = plays();
  assert.equal(await controller.goToTimelineEdge("bottom"), true);
  // The superseded acquisition now completes.
  scene.deferredFrame.clear();
  for (const name of ["Drive Up", "Drive Down"]) scene.media(name)?.emitFrame();
  assert.equal(await stale, false, "the superseded seek reports supersession");
  await drainReview(controller);
  await scene.expectPausedAt(when.from, "after the late completion");
  assert.equal(plays(), before);
  // Other navigation keeps its own Play semantics.
  assert.equal(await controller.seekHistoricalToEpoch(RECOVERY_T + 600, { autoplay: true }), true);
  await drainReview(controller);
  assert.equal(controller.clock.running, true);
});


test("Copy Diagnostics sits apart from the playback options with quieter styling", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const options = harness.root.querySelector(".review-options-controls");
  const copy = options.querySelector(".review-copy-diagnostics");
  assert.ok(copy, "always available, without a setting");
  assert.strictEqual(options.lastElementChild, copy);
  assert.ok(copy.previousElementSibling.querySelector(".review-snap-past-crap"),
    "it follows the final playback option");
  assert.equal(copy.textContent, "Copy diagnostics");
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  const copyRule = source.match(/\n\s*\.review-copy-diagnostics\s*{([^}]*)}/)?.[1] ?? "";
  assert.match(copyRule, /margin-top:\s*16px;/);
  assert.match(copyRule, /background:\s*transparent;/);
  assert.match(copyRule, /color:\s*#9fb0ba;/);
  assert.match(copyRule, /min-height:\s*36px;/);
  assert.match(source, /\.review-copy-diagnostics:focus-visible\s*{[^}]*outline:\s*2px solid #6faed9;/);
  // No longer part of the prominent filled button style.
  const primary = source.match(/\.review-diagnostics button,\s*\n\s*\.review-transport button\s*{[^}]*}/)?.[0] ?? "";
  assert.match(primary, /min-height:\s*44px;/);
  assert.doesNotMatch(source, /\.review-copy-diagnostics,\s*\n\s*\.review-transport button/);
});


test("Review Timeline exposes clean empty and error states", async t => {
  const empty = createHistoricalHarness();
  t.after(() => empty.close());
  empty.controller.setReviewRangeEndpoint("to", empty.controller.state.reviewRange.to + 60);
  assert.equal(empty.controller.applyWhenDraft(), true);
  await empty.controller.flushScheduledReviewQuery();
  assert.match(empty.root.querySelector(".review-timeline-message").textContent, /No activity/);

  const failed = createHistoricalHarness({ reviewError: true });
  t.after(() => failed.close());
  failed.controller.setReviewRangeEndpoint("to", failed.controller.state.reviewRange.to + 60);
  assert.equal(failed.controller.applyWhenDraft(), true);
  await failed.controller.flushScheduledReviewQuery();
  assert.equal(failed.controller.state.timeline.status, "error");
  assert.match(failed.root.querySelector(".review-timeline-message").textContent, /Unable to load activity/);
});


test("failed automatic refresh preserves displayed query and existing Timeline results", async t => {
  const item = {
    camera_id: "drive_up", start_time: 1789065000, type: "person", labels: ["person"]
  };
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS, reviewEvents: [item] });
  t.after(() => harness.close());
  await harness.controller.refreshReviewQuery();
  const displayed = harness.controller.state.displayedReviewQuery;
  harness.controller._hass.callWS = message => {
    harness.calls.push(JSON.parse(JSON.stringify(message)));
    if (message.type === "frigate_max/v1/review/get") {
      return Promise.reject(new Error("synthetic later failure"));
    }
    return Promise.reject(new Error("Unexpected command"));
  };
  harness.controller.setReviewRangeEndpoint("from", displayed.range.from - 600);
  assert.equal(harness.controller.applyWhenDraft(), true);
  const pending = harness.controller.flushScheduledReviewQuery();
  assert.equal(harness.controller.state.timeline.refreshing, true);
  assert.equal(harness.root.querySelectorAll(".review-timeline-marker").length, 1);
  await pending;
  assert.deepEqual(harness.controller.state.displayedReviewQuery, displayed);
  assert.equal(harness.controller.state.timeline.items.length, 1);
  assert.match(harness.root.querySelector(".review-timeline-refresh.error").textContent,
    /Unable to load activity/);
});


test("Review metadata clamps only the query end while preserving full active Timeline range", async t => {
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS, reviewEvents: [
    { camera_id: "drive_up", start_time: 1789065000, type: "person", labels: ["person"] }
  ] });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller.setReviewRangeEndpoint("from", 1789063200);
  controller.setReviewRangeEndpoint("to", 1789070400);
  assert.equal(controller.applyWhenDraft(), true);
  await controller.flushScheduledReviewQuery();
  const request = harness.calls.filter(call => call.type === "frigate_max/v1/review/get").at(-1);
  assert.deepEqual({ from: request.from, to: request.to }, { from: 1789063200, to: 1789066800 });
  assert.deepEqual(controller.state.reviewRange, { from: 1789063200, to: 1789070400 });
  const marker = harness.root.querySelector(".review-timeline-marker");
  assert.match(marker.getAttribute("style"), /top:75%/);

  const future = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS });
  t.after(() => future.close());
  future.controller.setReviewRangeEndpoint("from", 1789070400);
  future.controller.setReviewRangeEndpoint("to", 1789074000);
  assert.equal(future.controller.applyWhenDraft(), true);
  const futureRequests = future.calls.filter(call => call.type === "frigate_max/v1/review/get").length;
  await future.controller.flushScheduledReviewQuery();
  assert.equal(future.calls.filter(call => call.type === "frigate_max/v1/review/get").length, futureRequests);
  assert.equal(future.controller.state.timeline.status, "loaded");
  assert.deepEqual(future.controller.state.reviewRange, { from: 1789070400, to: 1789074000 });
  assert.match(future.root.querySelector(".review-timeline-message").textContent, /No activity/);
});


test("a rendered Timeline marker click uses only the active range and starts one historical transition", async t => {
  const harness = createHistoricalHarness({ debug: true, reviewEvents: [{
    camera_id: "drive_up", start_time: Date.parse("2026-09-10T10:20:00-07:00") / 1000,
    end_time: Date.parse("2026-09-10T10:40:00-07:00") / 1000,
    type: "person", labels: ["person"]
  }] });
  t.after(() => harness.close());
  const from = Date.parse("2026-09-10T10:00:00-07:00") / 1000;
  const to = Date.parse("2026-09-10T11:00:00-07:00") / 1000;
  harness.controller.setReviewRangeEndpoint("from", from);
  harness.controller.setReviewRangeEndpoint("to", to);
  assert.equal(harness.controller.applyWhenDraft(), true);
  await harness.controller.flushScheduledReviewQuery();
  harness.controller.setReviewRangeEndpoint("from", from - 1800);
  const displayedBefore = harness.controller.state.reviewRange;
  const desiredBefore = harness.controller.state.desiredReviewRange;
  const axis = harness.root.querySelector(".review-timeline-axis");
  axis.getBoundingClientRect = () => ({ top: 100, height: 400 });
  const marker = harness.root.querySelector(".review-timeline-marker");
  marker.dispatchEvent(new harness.window.MouseEvent("click", {
    bubbles: true, button: 0, clientY: 300
  }));
  for (let index = 0; index < 10 && harness.controller.state.historicalPreparing; index += 1) {
    await new Promise(resolve => harness.window.setTimeout(resolve, 0));
  }
  const selected = from + 1800;
  const item = harness.controller.state.timeline.items[0];
  assert.ok(item.start_time <= selected && selected <= item.end_time);
  assert.equal(marker.dataset.cameraId, "drive_up");
  assert.equal(marker.dataset.startEpoch, String(item.start_time));
  assert.equal(marker.dataset.endEpoch, String(item.end_time));
  assert.equal(axis.dataset.selectedEpoch, String(selected));
  assert.equal(axis.dataset.displayedFrom, String(from));
  assert.equal(axis.dataset.displayedTo, String(to));
  const prepares = harness.calls.filter(call => call.type === "frigate_max/v1/vod/prepare");
  assert.deepEqual(prepares.map(call => call.camera), ["drive_up", "drive_down"]);
  assert.ok(prepares.some(call => call.camera === marker.dataset.cameraId));
  assert.ok(prepares.every(call => call.target === selected));
  assert.equal(harness.controller.clock.absoluteTime >= selected, true);
  assert.deepEqual(harness.controller.state.reviewRange, displayedBefore);
  assert.deepEqual(harness.controller.state.desiredReviewRange, desiredBefore);
  assert.equal(harness.controller.state.presentationMode, "historical");
  assert.equal(harness.starts.length, 0);
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.controller.resumePlayback(), true);
  assert.equal(harness.starts.length, 2);
});


test("pending metadata keeps old Timeline geometry but cannot authorize stale playback cameras", async t => {
  let release;
  let metadataCall = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const oldItem = {
    camera_id: "drive_up", start_time: 1789065000, type: "person", labels: ["person"]
  };
  const harness = createHistoricalHarness({ wallClockMs: HARNESS_CALENDAR_WALL_CLOCK_MS, now: () => 1000,
    reviewResponder: () => ++metadataCall === 1 ? Promise.resolve([oldItem]) : gate.then(() => [])
  });
  t.after(() => harness.close());
  const controller = harness.controller;
  await Promise.resolve();
  const displayed = controller.state.displayedReviewQuery;
  const desiredRange = { from: displayed.range.from - 3600, to: displayed.range.to - 3600 };
  controller.setSelectedCameraNames(["Drive Up", "Back"]);
  controller.setReviewRangeEndpoint("from", desiredRange.from);
  controller.setReviewRangeEndpoint("to", desiredRange.to);
  assert.equal(controller.applyWhenDraft(), true);
  const pending = controller.flushScheduledReviewQuery();
  assert.equal(controller.state.timeline.refreshing, true);
  assert.equal(harness.root.querySelectorAll(".review-timeline-marker").length, 1);
  const oldTicks = [...harness.root.querySelectorAll(".review-timeline-tick span")]
    .map(node => node.textContent);
  const expectedOldEndpoints = [displayed.range.to, displayed.range.from].map(epoch =>
    new Intl.DateTimeFormat(undefined, {
      timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(new Date(epoch * 1000))
  );
  assert.equal(oldTicks.length, 5);
  assert.deepEqual([oldTicks[0], oldTicks.at(-1)], expectedOldEndpoints);
  assert.equal(harness.root.querySelector(".review-timeline-endpoints"), null);

  const oldTarget = displayed.range.from + (displayed.range.to - displayed.range.from) / 2;
  assert.equal(await controller.selectTimelineTime(oldTarget), false);
  let prepares = harness.calls.filter(call =>
    call.type === "frigate_max/v1/vod/prepare" && call.target === oldTarget);
  assert.deepEqual(prepares, []);
  assert.equal(controller.state.historicalStatus, "Preparing...");
  assert.deepEqual(controller.state.displayedReviewQuery, displayed);

  controller.returnToLive();
  release();
  await pending;
  const newTarget = desiredRange.from + (desiredRange.to - desiredRange.from) / 2;
  await controller.selectTimelineTime(newTarget);
  prepares = harness.calls.filter(call =>
    call.type === "frigate_max/v1/vod/prepare" && call.target === newTarget);
  assert.deepEqual(prepares.map(call => call.camera), ["drive_up", "back"]);
  assert.deepEqual(controller.state.displayedReviewQuery.cameraNames, ["Drive Up", "Back"]);
  assert.deepEqual(controller.state.displayedReviewQuery.range, desiredRange);
});


test("Gate 1 rejects a wrong-camera v2 response before HLS attachment", async t => {
  const harness = createHistoricalHarness({
    presentationResponder: message => Promise.resolve(presentationPrepared(
      message.camera === "drive_up" ? "drive_down" : message.camera,
      message.target - 20,
      message.target
    ))
  });
  t.after(() => harness.close());
  const target = harness.controller.state.reviewRange.from + 300;

  await harness.controller.playHistorical(target);

  const up = harness.controller._historicalPlayers.get("Drive Up");
  const down = harness.controller._historicalPlayers.get("Drive Down");
  assert.equal(up.unavailable, true);
  assert.equal(up.hls, null);
  assert.equal(up.returnedCamera, "drive_down");
  assert.equal(down.unavailable, false);
  assert.equal(down.returnedCamera, "drive_down");
});


test("Gate 1 stale camera work cleans itself without mutating the newer request", async t => {
  const pending = [];
  const harness = createHistoricalHarness({ now: () => 1000,
    presentationResponder: message => new Promise(resolve => pending.push({ message, resolve }))
  });
  t.after(() => harness.close());
  harness.controller.setHistoricalSyncDiagnostics(true);
  const firstTarget = harness.controller.state.reviewRange.from + 300;
  const secondTarget = firstTarget + 60;

  const first = harness.controller.playHistorical(firstTarget);
  await waitForCalls(harness, "frigate_max/v2/vod/prepare", 2);
  const oldPlayers = new Map(harness.controller._historicalPlayers);
  const firstRequestId = harness.controller.state.reviewRequestId;
  const second = harness.controller.playHistorical(secondTarget);
  await waitForCalls(harness, "frigate_max/v2/vod/prepare", 4);
  const currentPlayers = new Map(harness.controller._historicalPlayers);
  const secondRequestId = harness.controller.state.reviewRequestId;
  assert.notEqual(secondRequestId, firstRequestId);

  for (const item of pending.filter(item => item.message.target === secondTarget)) {
    item.resolve(presentationPrepared(
      item.message.camera, item.message.target - 20, item.message.target
    ));
  }
  await second;
  const currentVideos = new Map([...currentPlayers].map(([name, player]) => [name, player.video]));
  for (const item of pending.filter(item => item.message.target === firstTarget)) {
    item.resolve(presentationPrepared(
      item.message.camera, item.message.target - 20, item.message.target
    ));
  }
  await first;

  assert.equal(harness.controller.state.reviewRequestId, secondRequestId);
  assert.equal(harness.controller.clock.absoluteTime >= secondTarget, true);
  for (const [name, player] of currentPlayers) {
    assert.strictEqual(harness.controller._historicalPlayers.get(name), player);
    assert.strictEqual(player.video, currentVideos.get(name));
    assert.equal(player.unavailable, false);
  }
  for (const player of oldPlayers.values()) {
    assert.equal(player.message, "Preparing…");
    assert.equal(player.hls, null);
  }
  await waitForCondition(() => harness.controller.getHistoricalSyncReports()
    .find(report => report.requestId === firstRequestId)?.identityEvents.some(event =>
    ["stale-transition-rejected", "stale-transition-cleaned"].includes(event.disposition) &&
      event.current === false));
  const staleReport = harness.controller.getHistoricalSyncReports()
    .find(report => report.requestId === firstRequestId);
  assert.ok(staleReport.identityEvents.some(event =>
    ["stale-transition-rejected", "stale-transition-cleaned"].includes(event.disposition) &&
      event.current === false));
});


test("Gate 1 historical panel ownership follows same-camera layout moves", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const target = harness.controller.state.reviewRange.from + 300;
  await harness.controller.playHistorical(target, { autoplay: false });
  const player = harness.controller._historicalPlayers.get("Drive Down");
  const video = player.video;
  const hls = player.hls;
  const presentationId = player.presentationId;

  harness.controller.setReviewLayout("2x2");
  harness.controller.setPrimaryCamera("Drive Down");

  const panel = harness.root.querySelector('.review-camera-panel[data-camera="Drive Down"]');
  assert.strictEqual(harness.controller._historicalPlayers.get("Drive Down"), player);
  assert.strictEqual(player.video, video);
  assert.strictEqual(player.hls, hls);
  assert.equal(player.presentationId, presentationId);
  assert.equal(panel.dataset.reviewSlot, "0");
  assert.equal(panel.dataset.presentationId, String(presentationId));
  assert.equal(harness.controller.state.reviewAssignments[0], "Drive Down");
});


test("Gate 1 replacing an assigned camera retires its historical rendered ownership", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const target = harness.controller.state.reviewRange.from + 300;
  await harness.controller.playHistorical(target, { autoplay: false });
  const oldPanel = harness.root.querySelector('.review-camera-panel[data-camera="Drive Down"]');
  const oldVideo = oldPanel.querySelector("video");

  harness.controller.assignCameraToSlot("Back", 1);

  assert.equal(harness.controller.state.presentationMode, "live");
  assert.equal(oldPanel.isConnected, false);
  assert.equal(oldVideo.isConnected, false);
  const replacement = harness.root.querySelector('[data-review-slot="1"] .review-camera-panel');
  assert.equal(replacement.dataset.camera, "Back");
  assert.equal(replacement.dataset.presentationMode, "live");
  assert.equal(replacement.querySelector(".review-camera-presentation-kind").textContent, "Live");
  assert.equal(replacement.querySelector("video"), null);
});


test("Gate 1 historical ownership never renders a Review-live image", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const livePanels = [...harness.root.querySelectorAll(".review-camera-panel")];
  assert.ok(livePanels.every(panel =>
    panel.dataset.presentationMode === "live" &&
    panel.querySelector(".review-camera-presentation-kind").textContent === "Live"));

  await harness.controller.playHistorical(
    harness.controller.state.reviewRange.from + 300,
    { autoplay: false }
  );

  const historicalPanels = [...harness.root.querySelectorAll(".review-camera-panel")];
  assert.ok(historicalPanels.length > 0);
  assert.ok(historicalPanels.every(panel =>
    panel.dataset.presentationMode === "historical" &&
    panel.querySelector("hui-image.review-live-camera") === null &&
    panel.querySelector(".review-camera-presentation-kind").textContent === ""));
});


test("normal Review playback hides the indicator and preserves its configured corner", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller.setVideoStateBadgePosition("top-right");
  const liveBadge = harness.root.querySelector(".review-camera-presentation-kind");
  assert.equal(liveBadge.textContent, "Live");
  assert.equal(liveBadge.style.top, "6px");
  assert.equal(liveBadge.style.right, "6px");
  await harness.controller.playHistorical(1800000000);
  const badge = harness.root.querySelector(".review-camera-presentation-kind");
  assert.equal(badge.textContent, "");
  assert.equal(badge.hidden, true);
  assert.equal(badge.style.top, "6px");
  assert.equal(badge.style.right, "6px");
  assert.equal(badge.style.bottom, "auto");
  assert.equal(badge.style.left, "auto");
  assert.equal(harness.controller.clock.running, true);
});


test("Review uses lifecycle and current coverage for exceptions, independently of retained frames", async t => {
  const target = 1800000000;
  const harness = createHistoricalHarness({
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_down" ? [] :
        [{ start: message.start, end: message.end }]
    })
  });
  t.after(() => harness.close());
  harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  const badge = name => harness.root.querySelector(
    `.review-camera-panel[data-camera="${name}"] .review-camera-presentation-kind`
  );
  assert.equal(badge("Drive Up").textContent, "Live");
  assert.equal(badge("Drive Up").hidden, false);

  await harness.controller.playHistorical(target, { autoplay: false });
  const missing = harness.controller._historicalPlayers.get("Drive Down");
  assert.equal(missing.statusElement.textContent, "No recording at this time.");
  assert.equal(missing.statusElement.hidden, true);
  assert.equal(badge("Drive Down").textContent, "No recording");
  assert.equal(badge("Drive Down").hidden, false);
  assert.equal(badge("Drive Up").textContent, "");
  assert.equal(badge("Drive Up").hidden, true);

  const up = harness.controller._historicalPlayers.get("Drive Up");
  harness.mediaControls.find(control => control.camera === "Drive Up").emitFrame();
  harness.controller.leaveHistoricalCamera(up, "authoritative_recording_gap", target + 10);
  assert.equal(up.statusElement.hidden, true);
  assert.equal(badge("Drive Up").textContent, "");
  assert.equal(badge("Drive Up").hidden, true, "a camera boundary cannot override covered investigation time");

  harness.controller.returnToLive();
  assert.equal(badge("Drive Up").textContent, "Live");
  assert.equal(badge("Drive Up").hidden, false);
});


for (const exception of ["gap", "failure"]) {
  for (const retainedFrame of [false, true]) {
    test(`Review ${exception} uses one accessible corner indicator (retained frame=${retainedFrame})`, async t => {
      const target = 1800000000;
      let gap = false;
      // A verified landing is a presented frame, so "no retained frame" means a camera
      // that could not verify one.
      const harness = createHistoricalHarness({ availabilityResponder: message => Promise.resolve({
        camera: message.camera, requested_start: message.start, requested_end: message.end,
        coverage: gap ? [] : [{ start: message.start, end: message.end }]
      }), noRvfc: new Set(retainedFrame ? [] : ["Drive Up"]) });
      t.after(() => harness.close());
      harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
      await harness.controller.playHistorical(target, { autoplay: false });
      const controller = harness.controller;
      const player = controller._historicalPlayers.get("Drive Up");
      if (retainedFrame) harness.mediaControls.find(control => control.camera === "Drive Up").emitFrame();
      const frameEpoch = player.heldFrameEpoch;
      const assignments = [...controller.state.reviewAssignments];
      if (exception === "gap") {
        gap = true;
        await controller.ensureCameraAvailability(player, target, { force: true });
      }
      controller.leaveHistoricalCamera(player,
        exception === "gap" ? "authoritative_recording_gap" : "play_rejected",
        target, target, exception === "gap" ? "unavailable" : "failed");
      const panel = harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]');
      const indicator = panel.querySelector(".review-camera-presentation-kind");
      const text = exception === "gap" ? "No recording" : "Unavailable";
      assert.equal(indicator.textContent, text);
      assert.equal(indicator.hidden, false);
      assert.equal(indicator.getAttribute("role"), "status");
      assert.equal(indicator.getAttribute("aria-live"), "polite");
      assert.equal(indicator.getAttribute("aria-atomic"), "true");
      assert.equal(indicator.getAttribute("aria-label"), `Drive Up: ${text}`);
      assert.equal(panel.querySelectorAll('.review-camera-presentation-kind:not([hidden])').length, 1);
      assert.equal(panel.querySelectorAll('.review-camera-status:not([hidden])').length, 0);
      assert.equal(player.statusElement.getAttribute("aria-hidden"), "true");
      assert.equal(player.heldCanvas?.hidden === false, retainedFrame);
      assert.equal(player.heldFrameEpoch, frameEpoch);
      assert.deepEqual(controller.state.reviewAssignments, assignments);
      assert.equal(controller.clock.absoluteTime, target);
      assert.equal(controller.clock.running, false);
      assert.equal(player.lifecycleState, exception === "gap" ? "unavailable" : "failed");
    });
  }
}
