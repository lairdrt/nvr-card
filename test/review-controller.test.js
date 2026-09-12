import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

import {
  VIEWER_LAYOUTS,
  REVIEW_PLAYBACK_SPEEDS,
  REVIEW_TIMELINE_CAMERA_COLORS,
  ReviewClock,
  ReviewController,
  calculateHistoricalSeek,
  getCivilDayBounds,
  getCivilDayKey,
  normalizePreparedTiming,
  normalizeReviewTimelineItems,
  reviewTimelineEpochFromCoordinate,
  reviewTimelineMarkerGeometry,
  reviewTimelineMarkerTop
} from "../src/review/review-controller.js";
import { createTestHarness } from "./helpers/nvr-card-harness.js";

function cameras() {
  return [
    {
      name: "Drive Up",
      entity: "camera.drive_up",
      active: true,
      live: { substream: "camera.drive_up_sub", mainstream: "camera.drive_up_main" }
    },
    {
      name: "Drive Down",
      entity: "camera.drive_down",
      active: true,
      live: { substream: "camera.drive_down_sub", mainstream: "camera.drive_down_main" }
    },
    { name: "Back", entity: "camera.back", active: true },
    { name: "Disabled", entity: "camera.disabled", active: false }
  ];
}

function prepared(camera, origin, target = 1800000000) {
  return {
    camera,
    requested_start: target - 15,
    requested_end: target + 120,
    recording_start: origin - 10,
    requested_clip_from_ms: 7000,
    adjusted_clip_from_ms: 0,
    effective_absolute_origin: origin,
    calculated_target_seek: target - origin
  };
}

test("deployed card cache-busts the Review controller with its build identifier", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(
    source,
    /review-controller\.js\?v=__NVR_BUILD__/
  );
});

test("Live and Review consume centralized expanded and collapsed rail widths", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(source, /--nvr-sidebar-width:\s*240px/);
  assert.match(source, /--nvr-sidebar-collapsed-width:\s*calc\(/);
  assert.match(source, /--nvr-sidebar-current-width:\s*var\(--nvr-sidebar-width\)/);
  assert.match(source, /\.nvr-shell\.sidebar-collapsed\s*{[\s\S]*?--nvr-sidebar-current-width:\s*var\(--nvr-sidebar-collapsed-width\)/);
  assert.match(source, /grid-template-columns:\s*var\(--nvr-sidebar-current-width\)\s*minmax\(0, 1fr\)/);
  assert.match(source, /grid-template-columns:\s*var\(--nvr-sidebar-current-width\) minmax\(360px, 1fr\)/);
  assert.match(source, /\.nvr-shell\.phone-layout[\s\S]*?width:\s*var\(--nvr-sidebar-current-width\)/);
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
  assert.match(source, /\.review-section-content\s*{[\s\S]*?padding:\s*8px 6px 2px/);
  assert.doesNotMatch(source, /\.review-when-apply\s*{/);
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
  assert.doesNotMatch(source, /\.review-transport \.review-now\s*{[^}]*margin-left/);
  assert.doesNotMatch(source, /\.review-speed-select\s*{[^}]*margin-left/);
  assert.match(source, /\.review-layout-cell\s*{[\s\S]*?position:\s*relative;[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0/);
  assert.match(source, /\.review-camera-panel\s*{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?min-height:\s*0/);
  assert.match(source, /\.review-camera-media\s*{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?min-height:\s*0/);
  assert.match(source, /\.review-historical-video\s*{[\s\S]*?pointer-events:\s*none/);
  assert.match(source, /\.review-camera-status\s*{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?pointer-events:\s*none/);
  assert.doesNotMatch(controller, /setPlayerStatus\([^\n]*["']Ready["']/);
  assert.doesNotMatch(controller, /review-camera-heading/);
});

function createHistoricalHarness({
  unavailable = new Set(), prepareGate = null, reviewEvents = [], reviewError = false,
  reviewResponder = null, deferredSeek = new Set(), deferredPlayable = new Set(),
  mediaReadyTimeoutMs = 15000, now = () => performance.now()
} = {}) {
  const window = new Window({ url: "http://localhost/" });
  const starts = [];
  const playCalls = [];
  const instances = [];
  const mediaControls = [];
  const calls = [];
  const datePickerInstances = [];
  let controller = null;

  const datePickerFactory = (input, options) => {
    const altInput = window.document.createElement("input");
    altInput.type = "text";
    altInput.className = options.altInputClass;
    input.type = "hidden";
    input.after(altInput);
    const normalize = value => value instanceof Date
      ? new Date(value.getTime())
      : new Date(value);
    const pad = value => String(value).padStart(2, "0");
    const display = value => {
      const date = normalize(value);
      return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const canonical = value => {
      const date = normalize(value);
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const instance = {
      input,
      altInput,
      options,
      current: null,
      destroyCount: 0,
      openCount: 0,
      set(name, value) {
        options[name] = value;
      },
      setDate(value, triggerChange = false) {
        this.current = normalize(value);
        input.value = canonical(this.current);
        altInput.value = display(this.current);
        if (triggerChange) options.onChange([this.current], input.value, this);
      },
      select(value) {
        this.setDate(value, true);
      },
      open() {
        this.openCount += 1;
      },
      destroy() {
        this.destroyCount += 1;
        altInput.remove();
      }
    };
    instance.setDate(options.defaultDate);
    datePickerInstances.push(instance);
    return instance;
  };

  class MockHls {
    static Events = {
      MANIFEST_PARSED: "manifest",
      ERROR: "error"
    };

    static isSupported() {
      return true;
    }

    constructor() {
      this.handlers = new Map();
      this.destroyCount = 0;
      instances.push(this);
    }

    on(event, handler) {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    off(event, handler) {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter(candidate => candidate !== handler)
      );
    }

    attachMedia(video) {
      this.video = video;
      const camera = video.closest(".review-camera-panel")?.dataset.camera;
      let currentTime = Number(video.currentTime) || 0;
      let seeking = false;
      let readyState = deferredPlayable.has(camera) ? 2 : 3;
      Object.defineProperty(video, "seekable", {
        configurable: true,
        value: { length: 1, start: () => 0, end: () => 135 }
      });
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => currentTime,
        set: value => {
          currentTime = Number(value);
          seeking = deferredSeek.has(camera);
        }
      });
      Object.defineProperty(video, "seeking", {
        configurable: true,
        get: () => seeking
      });
      Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => readyState
      });
      mediaControls.push({
        camera,
        video,
        completeSeek() {
          deferredSeek.delete(camera);
          seeking = false;
          video.dispatchEvent(new window.Event("seeked"));
        },
        makePlayable() {
          readyState = 3;
          video.dispatchEvent(new window.Event("canplay"));
        }
      });
      video.pauseCount = 0;
      video.loadCount = 0;
      video.pause = () => { video.pauseCount += 1; };
      video.load = () => { video.loadCount += 1; };
      video.play = () => {
        starts.push(this.source);
        playCalls.push({
          camera,
          video,
          playbackRate: video.playbackRate,
          clockRunning: controller?.clock.running ?? false
        });
        return Promise.resolve();
      };
    }

    loadSource(source) {
      this.source = source;
      for (const handler of this.handlers.get(MockHls.Events.MANIFEST_PARSED) ?? []) {
        handler();
      }
    }

    destroy() {
      this.destroyCount += 1;
    }
  }

  const hass = {
    config: { time_zone: "America/Los_Angeles" },
    states: {
      "camera.drive_up": { attributes: { camera_name: "drive_up" } },
      "camera.drive_down": { attributes: { camera_name: "drive_down" } },
      "camera.back": { attributes: { camera_name: "back" } }
    },
    callWS(message) {
      calls.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "frigate_max/v1/vod/prepare") {
        if (unavailable.has(message.camera)) {
          return Promise.reject(new Error("No recording at requested time."));
        }
        const origin = message.camera === "drive_up"
          ? message.target - 21
          : message.target - 22;
        const result = prepared(message.camera, origin, message.target);
        return prepareGate ? prepareGate.then(() => result) : Promise.resolve(result);
      }
      if (message.type === "frigate_max/v1/review/get") {
        if (reviewResponder) return reviewResponder(message);
        if (reviewError) return Promise.reject(new Error("synthetic timeline failure"));
        return Promise.resolve(reviewEvents);
      }
      if (message.type === "auth/sign_path") {
        return Promise.resolve({ path: `/signed/${calls.length}.m3u8` });
      }
      return Promise.reject(new Error("Unexpected WebSocket command."));
    }
  };
  const root = window.document.createElement("div");
  const transportRoot = window.document.createElement("header");
  transportRoot.className = "review-header-transport";
  const surface = window.document.createElement("section");
  surface.className = "review-surface";
  root.append(transportRoot, surface);
  window.document.body.appendChild(root);
  controller = new ReviewController({
    documentRef: window.document,
    loadHls: () => Promise.resolve(MockHls),
    wallClock: () => Date.parse("2026-09-10T12:00:00-07:00"),
    datePickerFactory,
    mediaReadyTimeoutMs,
    now
  });
  controller.configure(cameras());
  controller.setSelectedCameraNames(["Drive Up", "Drive Down"]);
  controller.setDebug(true);
  controller.setHass(hass);
  controller.mount(surface, transportRoot);
  controller.activate();
  return {
    window,
    root,
    surface,
    transportRoot,
    controller,
    calls,
    starts,
    playCalls,
    instances,
    mediaControls,
    datePickerInstances,
    close() {
      controller.deactivate();
      window.close();
    }
  };
}

async function waitForHistoricalMedia(harness, count) {
  for (let index = 0; index < 50 && harness.mediaControls.length < count; index += 1) {
    await Promise.resolve();
  }
  assert.equal(harness.mediaControls.length, count);
}

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

  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  toggle.click();
  assert.equal(shell.classList.contains("sidebar-collapsed"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

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
  assert.equal(toggle.title, "Collapse sidebar");
  assert.deepEqual(liveHeaders.map(header => header.getAttribute("aria-label")), [
    "Cameras", "Layouts", "Views"
  ]);
  assert.deepEqual(liveHeaders.map(header => header.title), [
    "Cameras", "Layouts", "Views"
  ]);
  assert.ok(liveHeaders.every(header => header.querySelector("ha-icon")));

  toggle.click();
  assert.equal(shell.classList.contains("sidebar-collapsed"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.title, "Expand sidebar");
  assert.equal(liveRail.getAttribute("aria-hidden"), "false");
  assert.equal(
    JSON.stringify(card._sidebarSections),
    JSON.stringify(liveState)
  );

  card.setApplicationMode("review");
  const reviewRail = card.querySelector(".review-control-rail");
  const reviewHeaders = [...reviewRail.querySelectorAll(".sidebar-section-header")];
  assert.deepEqual(reviewHeaders.map(header => header.getAttribute("aria-label")), [
    "Cameras", "Layouts", "When", "Filters"
  ]);
  assert.deepEqual(reviewHeaders.map(header => header.title), [
    "Cameras", "Layouts", "When", "Filters"
  ]);
  assert.ok(reviewHeaders.every(header => header.querySelector("ha-icon")));

  toggle.click();
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.title, "Collapse sidebar");
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

  assert.equal(sections.length, 4);
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
  toggle.click();
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
  toggle.click();
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
  card.querySelector(".sidebar-toggle").click();
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
  const harness = createHistoricalHarness();
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

test("historical startup waits through seeked and post-seek playability for one common release", async t => {
  const deferredSeek = new Set(["Drive Down"]);
  const deferredPlayable = new Set(["Drive Up", "Drive Down"]);
  const harness = createHistoricalHarness({
    deferredSeek,
    deferredPlayable,
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
  assert.equal(harness.controller.clock.running, false);
  assert.equal(clockStarts, 0);
  assert.ok(media.every(viewport => !viewport.querySelector(".review-camera-status").hidden));

  down.completeSeek();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.starts.length, 0);
  assert.equal(harness.controller.clock.running, false);

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
    deferredPlayable
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
  const harness = createHistoricalHarness({
    deferredPlayable: new Set(["Drive Down"]),
    mediaReadyTimeoutMs: 25
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
  await run;
  assert.equal(harness.starts.length, 2);
  assert.deepEqual(harness.playCalls.map(call => call.camera), ["Drive Up", "Back"]);
  assert.equal(harness.controller._historicalPlayers.get("Drive Down").unavailable, true);
  assert.equal(harness.controller.clock.running, true);
});

test("a stale canplay completion cannot release players or anchor the old ReviewClock", async t => {
  const deferredPlayable = new Set(["Drive Up", "Drive Down"]);
  const harness = createHistoricalHarness({ deferredPlayable });
  t.after(() => harness.close());
  const firstTarget = 1800000000;
  const secondTarget = firstTarget + 300;
  const first = harness.controller.playHistorical(firstTarget);
  await waitForHistoricalMedia(harness, 2);
  const obsoleteControls = [...harness.mediaControls];
  assert.equal(harness.starts.length, 0);
  assert.equal(harness.controller.clock.running, false);

  deferredPlayable.clear();
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
  const before = harness.controller.state;
  for (const name of ["cameras", "layouts", "when", "filters"]) {
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

test("When owns one valid From/To interval and Now retains it", async t => {
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
  harness.root.querySelector(".review-now").click();
  assert.equal(harness.controller.state.presentationMode, "live");
  assert.deepEqual(harness.controller.state.reviewRange, activeRange);
  assert.equal(harness.root.querySelectorAll("hui-image.review-live-camera").length, 2);
});

test("Review From/To edits update desired state and coalesce before display replacement", async t => {
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
  assert.deepEqual(controller.state.desiredReviewRange, { from, to });
  assert.equal(harness.starts.length, 0);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, { from, to });
  assert.deepEqual(controller.state.desiredReviewRange, { from, to });
  assert.equal(controller._queryRefreshCount, 2);
  assert.equal(controller.clock.absoluteTime, clockValue);
});

test("Review direct hour and minute selectors edit desired time and coalesce", async t => {
  const harness = createHistoricalHarness();
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
  const desired = controller.state.desiredReviewRange;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(desired.from * 1000));
  assert.equal(parts.find(part => part.type === "hour").value, "10");
  assert.equal(parts.find(part => part.type === "minute").value, "38");
  assert.deepEqual(controller.state.reviewRange, displayed);
  assert.equal(controller._queryRefreshCount, 1);
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, desired);
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
  await controller.flushScheduledReviewQuery();
  assert.deepEqual(controller.state.reviewRange, {
    from: displayed.range.to, to: displayed.range.to + 600
  });
});

test("Review Timeline refresh queries desired range and renders newest at top", async t => {
  const harness = createHistoricalHarness({ reviewEvents: [
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
  await controller.flushScheduledReviewQuery();
  const request = harness.calls.filter(call => call.type === "frigate_max/v1/review/get").at(-1);
  assert.deepEqual(request.cameras, ["drive_up", "drive_down"]);
  assert.deepEqual({ from: request.from, to: request.to }, desired);
  assert.equal(controller.state.timeline.status, "loaded");
  assert.equal(controller.state.timeline.items.length, 2);
  const markers = [...harness.root.querySelectorAll(".review-timeline-marker")];
  const firstGeometry = reviewTimelineMarkerGeometry(controller.state.timeline.items[0], desired);
  assert.match(markers[0].getAttribute("style"), new RegExp(`top:${firstGeometry.top * 100}%`));
  assert.match(markers[0].getAttribute("style"), new RegExp(`height:${firstGeometry.height * 100}%`));
  assert.match(markers[1].getAttribute("style"), /top:0%/);
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
  const harness = createHistoricalHarness({ reviewEvents: [
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
  const harness = createHistoricalHarness({ now: () => now });
  t.after(() => harness.close());
  const controller = harness.controller;
  const footer = harness.root.querySelector(".review-time-truth");
  let output = footer.querySelector(".review-clock-display");
  assert.equal(harness.transportRoot.querySelector(".review-clock-display"), null);
  assert.match(footer.textContent, /^Review Time:/);
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

test("Review Timeline exposes clean empty and error states", async t => {
  const empty = createHistoricalHarness();
  t.after(() => empty.close());
  empty.controller.setReviewRangeEndpoint("to", empty.controller.state.reviewRange.to + 60);
  await empty.controller.flushScheduledReviewQuery();
  assert.match(empty.root.querySelector(".review-timeline-message").textContent, /No activity/);

  const failed = createHistoricalHarness({ reviewError: true });
  t.after(() => failed.close());
  failed.controller.setReviewRangeEndpoint("to", failed.controller.state.reviewRange.to + 60);
  await failed.controller.flushScheduledReviewQuery();
  assert.equal(failed.controller.state.timeline.status, "error");
  assert.match(failed.root.querySelector(".review-timeline-message").textContent, /Unable to load activity/);
});

test("failed automatic refresh preserves displayed query and existing Timeline results", async t => {
  const item = {
    camera_id: "drive_up", start_time: 1789065000, type: "person", labels: ["person"]
  };
  const harness = createHistoricalHarness({ reviewEvents: [item] });
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
  const harness = createHistoricalHarness({ reviewEvents: [
    { camera_id: "drive_up", start_time: 1789065000, type: "person", labels: ["person"] }
  ] });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller.setReviewRangeEndpoint("from", 1789063200);
  controller.setReviewRangeEndpoint("to", 1789070400);
  await controller.flushScheduledReviewQuery();
  const request = harness.calls.filter(call => call.type === "frigate_max/v1/review/get").at(-1);
  assert.deepEqual({ from: request.from, to: request.to }, { from: 1789063200, to: 1789066800 });
  assert.deepEqual(controller.state.reviewRange, { from: 1789063200, to: 1789070400 });
  const marker = harness.root.querySelector(".review-timeline-marker");
  assert.match(marker.getAttribute("style"), /top:75%/);

  const future = createHistoricalHarness();
  t.after(() => future.close());
  future.controller.setReviewRangeEndpoint("from", 1789070400);
  future.controller.setReviewRangeEndpoint("to", 1789074000);
  const futureRequests = future.calls.filter(call => call.type === "frigate_max/v1/review/get").length;
  await future.controller.flushScheduledReviewQuery();
  assert.equal(future.calls.filter(call => call.type === "frigate_max/v1/review/get").length, futureRequests);
  assert.equal(future.controller.state.timeline.status, "loaded");
  assert.deepEqual(future.controller.state.reviewRange, { from: 1789070400, to: 1789074000 });
  assert.match(future.root.querySelector(".review-timeline-message").textContent, /No activity/);
});

test("a rendered Timeline marker click uses only the active range and starts one historical transition", async t => {
  const harness = createHistoricalHarness({ reviewEvents: [{
    camera_id: "drive_up", start_time: Date.parse("2026-09-10T10:20:00-07:00") / 1000,
    end_time: Date.parse("2026-09-10T10:40:00-07:00") / 1000,
    type: "person", labels: ["person"]
  }] });
  t.after(() => harness.close());
  const from = Date.parse("2026-09-10T10:00:00-07:00") / 1000;
  const to = Date.parse("2026-09-10T11:00:00-07:00") / 1000;
  harness.controller.setReviewRangeEndpoint("from", from);
  harness.controller.setReviewRangeEndpoint("to", to);
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
  for (let index = 0; index < 10 && harness.starts.length < 2; index += 1) {
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
  assert.equal(harness.starts.length, 2);
});

test("pending metadata keeps old displayed Timeline geometry and playback cameras authoritative", async t => {
  let release;
  let metadataCall = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const oldItem = {
    camera_id: "drive_up", start_time: 1789065000, type: "person", labels: ["person"]
  };
  const harness = createHistoricalHarness({
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
  await controller.selectTimelineTime(oldTarget);
  let prepares = harness.calls.filter(call =>
    call.type === "frigate_max/v1/vod/prepare" && call.target === oldTarget);
  assert.deepEqual(prepares.map(call => call.camera), ["drive_up", "drive_down"]);
  assert.equal(prepares.some(call => call.camera === "back"), false);
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
  const first = harness.controller.flushScheduledReviewQuery();
  harness.controller.setReviewRangeEndpoint("to", original.to - 600);
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
  const harness = createHistoricalHarness({ reviewEvents: [{
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
  for (let index = 0; index < 20 && harness.starts.length < startsBefore + 2; index += 1) {
    await new Promise(resolve => harness.window.setTimeout(resolve, 0));
  }
  const releasePrepares = harness.calls
    .filter(call => call.type === "frigate_max/v1/vod/prepare")
    .slice(prepareBefore);
  assert.equal(releasePrepares.length, 2);
  assert.deepEqual(releasePrepares.map(call => call.camera), ["drive_up", "drive_down"]);
  assert.ok(releasePrepares.every(call => call.target === releasedEpoch));
  assert.equal(harness.starts.length, startsBefore + 2);
  assert.equal(controller.state.presentationMode, "historical");
  assert.equal(controller.clock.running, true);
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
  const harness = createHistoricalHarness();
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
  assert.match(harness.root.querySelector(".review-historical-state").textContent, /No recording/);
  assert.deepEqual([...harness.root.querySelectorAll("hui-image.review-live-camera")], liveImages);
});

test("From/To survive a mode round trip and both picker instances are destroyed", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const from = Date.parse("2026-09-07T10:15:00-07:00") / 1000;
  const to = Date.parse("2026-09-07T11:45:00-07:00") / 1000;
  assert.equal(harness.controller.setReviewRangeEndpoint("from", from), true);
  assert.equal(harness.controller.setReviewRangeEndpoint("to", to), true);
  assert.deepEqual(harness.controller.state.desiredReviewRange, { from, to });
  const previousPickers = harness.datePickerInstances.slice(-2);
  harness.controller.deactivate();
  assert.ok(previousPickers.every(picker => picker.destroyCount === 1));
  harness.controller.activate();
  assert.deepEqual(harness.controller.state.desiredReviewRange, { from, to });
  assert.equal(harness.datePickerInstances.at(-2).altInput.value, "09/07/2026 10:15");
  assert.equal(harness.datePickerInstances.at(-1).altInput.value, "09/07/2026 11:45");
});

test("flatpickr permits an invalid intermediate range and preserves live media identity", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const panel = harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]');
  const image = panel.querySelector("hui-image");
  const [fromPicker, toPicker] = harness.datePickerInstances.slice(-2);
  for (const picker of [fromPicker, toPicker]) {
    assert.equal(picker.options.enableTime, true);
    assert.equal(picker.options.time_24hr, true);
    assert.equal(picker.options.altFormat, "m/d/Y H:i");
    assert.equal(picker.options.dateFormat, "Y-m-d H:i");
    assert.equal(picker.options.allowInput, true);
    assert.equal(picker.options.disableMobile, true);
  }
  fromPicker.select(new Date((harness.controller.state.reviewRange.to + 60) * 1000));
  assert.ok(harness.controller.state.desiredReviewRange.from >=
    harness.controller.state.desiredReviewRange.to);
  assert.deepEqual(harness.controller.state.reviewRange,
    harness.controller.state.displayedReviewQuery.range);
  assert.strictEqual(
    harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]'),
    panel
  );
  assert.strictEqual(panel.querySelector("hui-image"), image);
});

test("When editing retires historical playback without exposing ISO input", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const range = harness.controller.state.reviewRange;
  await harness.controller.selectTimelineTime(range.from + 600);
  assert.equal(harness.controller.state.presentationMode, "historical");
  harness.controller.setReviewRangeEndpoint("to", range.to + 60);
  assert.equal(harness.controller.state.presentationMode, "live");
  assert.equal(harness.controller.clock.absoluteTime, null);
  assert.ok(harness.root.querySelectorAll(".review-range-field").length >= 2);
  assert.equal(harness.root.querySelector(".review-day-previous"), null);
  assert.equal(harness.root.querySelector(".review-day-next"), null);
  assert.equal(harness.root.querySelector(".review-day-picker"), null);
  assert.equal(harness.root.textContent.includes("T12:00:00"), false);
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
  assert.equal(harness.root.querySelector(".review-when-apply"), null);
  for (const [selector, label] of [
    [".review-previous-event", "Previous event"],
    [".review-back-ten", "Back 10 seconds"],
    [".review-pause", "Pause"],
    [".review-play", "Play"],
    [".review-forward-ten", "Forward 10 seconds"],
    [".review-next-event", "Next event"],
    [".review-now", "Now"]
  ]) {
    assert.equal(harness.root.querySelector(selector).getAttribute("aria-label"), label);
  }
  assert.equal(harness.root.querySelector(".review-return-live"), null);
  const controls = harness.root.querySelector(".review-transport-controls");
  const speed = harness.root.querySelector(".review-speed-select");
  const now = harness.root.querySelector(".review-now");
  assert.strictEqual(now.parentElement, controls.querySelector(".review-now-group"));
  assert.strictEqual(speed.parentElement, controls.querySelector(".review-speed-group"));
  assert.equal(controls.querySelector(".review-vcr-group").children.length, 6);
  assert.deepEqual([...controls.children].map(child => child.className), [
    "review-toolbar-group review-vcr-group",
    "review-toolbar-group review-speed-group",
    "review-toolbar-group review-now-group"
  ]);
  assert.deepEqual([...speed.options].map(option => option.textContent), [
    "1x", "2x", "4x", "8x", "16x"
  ]);
  assert.equal(now.textContent, "");
  assert.equal(now.disabled, false);
  assert.equal(harness.root.querySelectorAll(".review-transport-controls button").length, 7);
  assert.equal(now.querySelector("ha-icon").getAttribute("icon"), "mdi:clock-fast");
  assert.equal(workspace.querySelectorAll(".review-layout-cell:not([hidden])").length, 13);
  assert.equal(harness.root.textContent.includes("Review live"), false);
});

test("historical speed is shared, rate-aware, and retained through Now and re-entry", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  assert.deepEqual(REVIEW_PLAYBACK_SPEEDS, [1, 2, 4, 8, 16]);
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

test("ReviewClock advances at the selected historical speed", () => {
  let now = 1000;
  const clock = new ReviewClock(() => now);
  clock.setAbsolute(100);
  clock.setRate(16);
  clock.start();
  now = 2250;
  assert.equal(clock.absoluteTime, 120);
});

test("historical Pause and Play preserve and resume the shared ReviewClock", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  const pause = harness.root.querySelector(".review-pause");
  const play = harness.root.querySelector(".review-play");
  assert.equal(pause.disabled, false);
  assert.equal(play.disabled, true);
  pause.click();
  const pausedAt = harness.controller.clock.absoluteTime;
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.controller.clock.absoluteTime, pausedAt);
  assert.equal(pause.disabled, true);
  assert.equal(play.disabled, false);
  play.click();
  assert.equal(harness.controller.clock.running, true);
  assert.equal(pause.disabled, false);
  assert.equal(play.disabled, true);
});

test("minus and plus ten derive coordinated player positions from ReviewClock", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  harness.controller.pausePlayback();
  const pausedAt = harness.controller.clock.absoluteTime;
  const instanceCount = harness.instances.length;
  await harness.controller.seekHistoricalRelative(-10);
  const backTarget = pausedAt - 10;
  assert.equal(harness.controller.clock.absoluteTime, backTarget);
  assert.deepEqual(
    [...harness.controller._historicalPlayers.values()].map(player => player.video.currentTime),
    [backTarget - (1800000000 - 21), backTarget - (1800000000 - 22)]
  );
  await harness.controller.seekHistoricalRelative(10);
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
  assert.equal(down.unavailable, false);
  assert.equal(harness.starts.length, 1);
  assert.match(harness.root.querySelector(".review-historical-state").textContent, /Some cameras/);
  assert.deepEqual(harness.controller.state.reviewAssignments.slice(0, 2), ["Drive Up", "Drive Down"]);
});

test("all unavailable cameras retain cells and never start an empty historical clock", async t => {
  const harness = createHistoricalHarness({ unavailable: new Set(["drive_up", "drive_down"]) });
  t.after(() => harness.close());
  const assignments = [...harness.controller.state.reviewAssignments];
  const target = harness.controller.state.reviewRange.from + 1200;
  await harness.controller.selectTimelineTime(target);
  assert.equal(harness.starts.length, 0);
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.controller.state.presentationMode, "historical");
  assert.match(harness.root.querySelector(".review-historical-state").textContent, /No recording/);
  assert.equal(harness.root.querySelectorAll(".review-camera-panel").length, 2);
  assert.deepEqual(harness.controller.state.reviewAssignments, assignments);
  assert.equal(harness.root.querySelector(".review-back-ten").disabled, true);
  assert.equal(harness.root.querySelector(".review-play").disabled, true);
  assert.equal(harness.root.querySelector(".review-speed-select").disabled, true);
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
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.controller._diagnosticTimer, null);
  assert.match(harness.root.querySelector(".review-historical-state").textContent, /No recording/);
  assert.deepEqual(harness.controller.state.reviewAssignments, assignments);
  assert.ok(harness.root.querySelector(".review-empty-state"));
});

test("historical loading and VCR states are compact and keep event controls disabled", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createHistoricalHarness({ prepareGate: gate });
  t.after(() => harness.close());
  const target = harness.controller.state.reviewRange.from + 1200;
  const run = harness.controller.selectTimelineTime(target);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.controller.state.historicalPreparing, true);
  assert.match(harness.root.querySelector(".review-historical-state").textContent, /Preparing playback/);
  assert.equal(harness.root.querySelector(".review-pause").disabled, true);
  release();
  await run;
  assert.equal(harness.root.querySelector(".review-back-ten").disabled, false);
  assert.equal(harness.root.querySelector(".review-pause").disabled, false);
  assert.equal(harness.root.querySelector(".review-play").disabled, true);
  assert.equal(harness.root.querySelector(".review-forward-ten").disabled, false);
  assert.equal(harness.root.querySelector(".review-speed-select").disabled, false);
  assert.equal(harness.root.querySelector(".review-now").disabled, false);
  assert.equal(harness.root.querySelector(".review-previous-event").disabled, true);
  assert.equal(harness.root.querySelector(".review-next-event").disabled, true);
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
  const past = createHistoricalHarness();
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

  const straddling = createHistoricalHarness();
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
