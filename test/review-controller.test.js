import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

import {
  VIEWER_LAYOUTS,
  REVIEW_PLAYBACK_SPEEDS,
  ReviewClock,
  ReviewController,
  calculateHistoricalSeek,
  getCivilDayBounds,
  getCivilDayKey,
  normalizePreparedTiming,
  normalizeReviewTimelineItems,
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
  assert.match(source, /\.application-mode-control button\s*{[\s\S]*?width:\s*92px/);
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
  assert.match(source, /\.review-when-apply\s*{/);
});

function createHistoricalHarness({ unavailable = new Set(), prepareGate = null, reviewEvents = [], reviewError = false } = {}) {
  const window = new Window({ url: "http://localhost/" });
  const starts = [];
  const instances = [];
  const calls = [];
  const datePickerInstances = [];

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
      Object.defineProperty(video, "seekable", {
        configurable: true,
        value: { length: 1, start: () => 0, end: () => 135 }
      });
      Object.defineProperty(video, "seeking", {
        configurable: true,
        value: false
      });
      video.pauseCount = 0;
      video.loadCount = 0;
      video.pause = () => { video.pauseCount += 1; };
      video.load = () => { video.loadCount += 1; };
      video.play = () => {
        starts.push(this.source);
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
  const controller = new ReviewController({
    documentRef: window.document,
    loadHls: () => Promise.resolve(MockHls),
    wallClock: () => Date.parse("2026-09-10T12:00:00-07:00"),
    datePickerFactory
  });
  controller.configure(cameras());
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
    instances,
    datePickerInstances,
    close() {
      controller.deactivate();
      window.close();
    }
  };
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

test("Review selection defaults to enabled order and is not capped at two", () => {
  const window = new Window();
  const controller = new ReviewController({ documentRef: window.document });
  controller.configure(cameras());
  assert.deepEqual(controller.state.selectedCameraNames, ["Drive Up", "Drive Down"]);
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
  const liveLayout = card._layout;
  const liveAssignments = [...card._assignedCameras];
  card.setApplicationMode("review");
  const controller = card._reviewController;

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

test("mode controls are equal-class icon labels with correct active semantics", t => {
  const harness = createTestHarness();
  t.after(() => harness.close());
  const card = harness.createCard();
  const live = card.querySelector('[data-application-mode="live"]');
  const review = card.querySelector('[data-application-mode="review"]');
  assert.equal(live.querySelector("span").textContent, "Live");
  assert.equal(review.querySelector("span").textContent, "Review");
  assert.equal(live.querySelector("ha-icon").getAttribute("icon"), "mdi:cctv");
  assert.equal(review.querySelector("ha-icon").getAttribute("icon"), "mdi:history");
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
  await harness.controller.playHistorical(1800000000);
  const beforeClock = harness.controller.clock.absoluteTime;
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
  assert.equal(harness.controller.clock.absoluteTime, beforeClock);
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

test("historical participation removal retires only the removed player", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  const upPlayer = harness.controller._historicalPlayers.get("Drive Up");
  const downPlayer = harness.controller._historicalPlayers.get("Drive Down");
  const upVideo = upPlayer.video;
  harness.controller.setSelectedCameraNames(["Drive Up"]);
  assert.strictEqual(harness.controller._historicalPlayers.get("Drive Up"), upPlayer);
  assert.strictEqual(upPlayer.video, upVideo);
  assert.equal(upPlayer.hls.destroyCount, 0);
  assert.equal(downPlayer.hls, null);
  assert.equal(harness.controller.clock.running, true);
});

test("RHS and provisional filters preserve clock, media, cameras, and primary", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  const video = harness.root.querySelector('[data-camera="Drive Up"] video');
  const before = harness.controller.state;
  harness.controller.setRhsMode("events");
  harness.controller.setFilter("person", true);
  assert.strictEqual(harness.root.querySelector('[data-camera="Drive Up"] video'), video);
  assert.deepEqual(harness.controller.state.selectedCameraNames, before.selectedCameraNames);
  assert.equal(harness.controller.state.primaryCameraName, before.primaryCameraName);
  assert.equal(harness.controller.state.reviewClockAbsolute, before.reviewClockAbsolute);
  assert.equal(harness.controller.state.rhsMode, "events");
  assert.deepEqual(harness.controller.state.selectedFilters, ["person"]);
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

test("Review From/To edits stay draft-only until one atomic Apply", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const initial = controller.state.activeReviewRange;
  const clockValue = initial.from + 720;
  controller.clock.setAbsolute(clockValue);
  const from = initial.from + 600;
  const to = initial.to + 600;
  assert.equal(controller.state.reviewRangeDirty, false);
  assert.equal(harness.root.querySelector(".review-when-apply").disabled, true);
  assert.equal(controller.setReviewRangeEndpoint("from", from), true);
  assert.equal(controller.setReviewRangeEndpoint("to", to), true);
  assert.deepEqual(controller.state.activeReviewRange, initial);
  assert.deepEqual(controller.state.reviewRange, initial);
  assert.deepEqual(controller.state.draftReviewRange, { from, to });
  assert.equal(controller.state.reviewRangeDirty, true);
  assert.equal(harness.root.querySelector(".review-when-apply").disabled, false);
  assert.equal(harness.starts.length, 0);
  assert.equal(controller.applyReviewRange(), true);
  assert.deepEqual(controller.state.activeReviewRange, { from, to });
  assert.deepEqual(controller.state.draftReviewRange, { from, to });
  assert.equal(controller.state.reviewRangeDirty, false);
  assert.equal(controller._rangeRefreshCount, 1);
  assert.equal(controller.clock.absoluteTime, clockValue);
  assert.equal(controller.applyReviewRange(), false);
  assert.equal(controller._rangeRefreshCount, 1);
});

test("Review direct hour and minute selectors edit exact draft time only", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const active = controller.state.activeReviewRange;
  const hour = harness.root.querySelector(".review-from-picker").closest(".review-range-field")
    .nextElementSibling.querySelector(".review-time-hour");
  const minute = harness.root.querySelector(".review-from-picker").closest(".review-range-field")
    .nextElementSibling.querySelector(".review-time-minute");
  assert.equal(harness.root.querySelectorAll(".review-direct-time select").length, 4);
  hour.value = "12";
  hour.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  minute.value = "38";
  minute.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  const draft = controller.state.draftReviewRange;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(draft.from * 1000));
  assert.equal(parts.find(part => part.type === "hour").value, "12");
  assert.equal(parts.find(part => part.type === "minute").value, "38");
  assert.deepEqual(controller.state.activeReviewRange, active);
  assert.equal(controller.state.reviewRangeDirty, true);
  assert.equal(controller._rangeRefreshCount, 0);
  assert.equal(controller.applyReviewRange(), true);
  assert.equal(controller.state.reviewRangeDirty, false);
});

test("Apply clamps ReviewClock to the active range without starting playback", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const controller = harness.controller;
  const initial = controller.state.activeReviewRange;
  const from = initial.from + 1200;
  const to = initial.to + 1200;
  controller.clock.setAbsolute(initial.from - 60);
  controller.setReviewRangeEndpoint("from", from);
  controller.setReviewRangeEndpoint("to", to);
  assert.equal(controller.applyReviewRange(), true);
  assert.equal(controller.clock.absoluteTime, from);
  assert.equal(harness.starts.length, 0);
  controller.clock.setAbsolute(to + 60);
  controller.setReviewRangeEndpoint("from", from + 60);
  controller.setReviewRangeEndpoint("to", to + 60);
  assert.equal(controller.applyReviewRange(), true);
  assert.equal(controller.clock.absoluteTime, to + 60);
  assert.equal(controller._rangeRefreshCount, 2);
});

test("Review Timeline refresh queries active range and renders newest at top", async t => {
  const harness = createHistoricalHarness({ reviewEvents: [
    { camera_id: "drive_up", start_time: 1789065000, end_time: 1789065060, type: "person", labels: ["person"] },
    { camera_id: "drive_down", start_time: 1789066800, type: "car", labels: ["car"] }
  ] });
  t.after(() => harness.close());
  const controller = harness.controller;
  const active = controller.state.activeReviewRange;
  const draft = { from: active.from + 600, to: active.to };
  controller.setReviewRangeEndpoint("from", draft.from);
  controller.setReviewRangeEndpoint("to", draft.to);
  assert.deepEqual(controller.state.activeReviewRange, active);
  controller.applyReviewRange();
  await new Promise(resolve => setTimeout(resolve, 0));
  const request = harness.calls.find(call => call.type === "frigate_max/v1/review/get");
  assert.deepEqual(request.cameras, ["drive_up", "drive_down"]);
  assert.deepEqual({ from: request.from, to: request.to }, draft);
  assert.equal(controller.state.timeline.status, "loaded");
  assert.equal(controller.state.timeline.items.length, 2);
  const markers = [...harness.root.querySelectorAll(".review-timeline-marker")];
  assert.match(markers[0].getAttribute("style"), new RegExp(`top:${reviewTimelineMarkerTop(1789065000, draft) * 100}%`));
  assert.match(markers[1].getAttribute("style"), /top:0%/);
  assert.equal(harness.root.querySelector(".review-timeline-endpoints").firstElementChild.textContent,
    new Intl.DateTimeFormat(undefined, { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(draft.to * 1000)));
});

test("Review Timeline exposes clean empty and error states", async t => {
  const empty = createHistoricalHarness();
  t.after(() => empty.close());
  empty.controller.setReviewRangeEndpoint("to", empty.controller.state.activeReviewRange.to + 60);
  empty.controller.applyReviewRange();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(empty.root.querySelector(".review-timeline-message").textContent, /No activity/);

  const failed = createHistoricalHarness({ reviewError: true });
  t.after(() => failed.close());
  failed.controller.setReviewRangeEndpoint("to", failed.controller.state.activeReviewRange.to + 60);
  failed.controller.applyReviewRange();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(failed.controller.state.timeline.status, "error");
  assert.match(failed.root.querySelector(".review-timeline-message").textContent, /Unable to load activity/);
});

test("Review metadata clamps only the query end while preserving full active Timeline range", async t => {
  const harness = createHistoricalHarness({ reviewEvents: [
    { camera_id: "drive_up", start_time: 1789065000, type: "person", labels: ["person"] }
  ] });
  t.after(() => harness.close());
  const controller = harness.controller;
  controller.setReviewRangeEndpoint("from", 1789063200);
  controller.setReviewRangeEndpoint("to", 1789070400);
  controller.applyReviewRange();
  await new Promise(resolve => setTimeout(resolve, 0));
  const request = harness.calls.find(call => call.type === "frigate_max/v1/review/get");
  assert.deepEqual({ from: request.from, to: request.to }, { from: 1789063200, to: 1789066800 });
  assert.deepEqual(controller.state.activeReviewRange, { from: 1789063200, to: 1789070400 });
  const marker = harness.root.querySelector(".review-timeline-marker");
  assert.match(marker.getAttribute("style"), /top:75%/);

  const future = createHistoricalHarness();
  t.after(() => future.close());
  future.controller.setReviewRangeEndpoint("from", 1789070400);
  future.controller.setReviewRangeEndpoint("to", 1789074000);
  future.controller.applyReviewRange();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(future.calls.some(call => call.type === "frigate_max/v1/review/get"), false);
  assert.equal(future.controller.state.timeline.status, "loaded");
  assert.deepEqual(future.controller.state.activeReviewRange, { from: 1789070400, to: 1789074000 });
  assert.match(future.root.querySelector(".review-timeline-message").textContent, /No activity/);
});

test("From/To survive a mode round trip and both picker instances are destroyed", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const from = Date.parse("2026-09-07T10:15:00-07:00") / 1000;
  const to = Date.parse("2026-09-07T11:45:00-07:00") / 1000;
  assert.equal(harness.controller.setReviewRangeEndpoint("from", from), true);
  assert.equal(harness.controller.setReviewRangeEndpoint("to", to), true);
  assert.deepEqual(harness.controller.state.activeReviewRange, harness.controller.state.reviewRange);
  assert.deepEqual(harness.controller.state.draftReviewRange, { from, to });
  const previousPickers = harness.datePickerInstances.slice(-2);
  harness.controller.deactivate();
  assert.ok(previousPickers.every(picker => picker.destroyCount === 1));
  harness.controller.activate();
  assert.deepEqual(harness.controller.state.draftReviewRange, { from, to });
  assert.deepEqual(harness.controller.state.activeReviewRange, harness.controller.state.reviewRange);
  assert.equal(harness.datePickerInstances.at(-2).altInput.value, "09/07/2026 10:15");
  assert.equal(harness.datePickerInstances.at(-1).altInput.value, "09/07/2026 11:45");
});

test("flatpickr From/To integration enforces order and preserves media identity", t => {
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
  const oldDuration = harness.controller.state.reviewRange.to -
    harness.controller.state.reviewRange.from;
  fromPicker.select(new Date((harness.controller.state.reviewRange.to + 60) * 1000));
  const adjusted = harness.controller.state.reviewRange;
  assert.ok(adjusted.from < adjusted.to);
  assert.equal(adjusted.to - adjusted.from, oldDuration);
  toPicker.select(new Date((adjusted.from - 60) * 1000));
  assert.ok(harness.controller.state.reviewRange.from < harness.controller.state.reviewRange.to);
  assert.strictEqual(
    harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]'),
    panel
  );
  assert.strictEqual(panel.querySelector("hui-image"), image);
});

test("Review range clamps its absolute clock without exposing ISO input", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const range = harness.controller.state.reviewRange;
  harness.controller.clock.setAbsolute(range.from - 300);
  harness.controller.setReviewRangeEndpoint("from", range.from);
  assert.equal(harness.controller.clock.absoluteTime, range.from - 300);
  harness.controller.setReviewRangeEndpoint("to", range.to + 60);
  harness.controller.applyReviewRange();
  assert.equal(harness.controller.clock.absoluteTime, range.from);
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
  assert.strictEqual(now.parentElement, controls);
  assert.strictEqual(speed.nextElementSibling, now);
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
  const instanceCount = harness.instances.length;
  await harness.controller.seekHistoricalRelative(-10);
  assert.equal(harness.controller.clock.absoluteTime, 1799999990);
  assert.deepEqual(
    [...harness.controller._historicalPlayers.values()].map(player => player.video.currentTime),
    [11, 12]
  );
  await harness.controller.seekHistoricalRelative(10);
  assert.equal(harness.controller.clock.absoluteTime, 1800000000);
  assert.deepEqual(
    [...harness.controller._historicalPlayers.values()].map(player => player.video.currentTime),
    [21, 22]
  );
  assert.equal(harness.instances.length, instanceCount);
  assert.equal(harness.controller.clock.running, false);
});

test("skip crossing the prepared range uses the existing VOD preparation path", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  await harness.controller.playHistorical(1800000000);
  harness.controller.pausePlayback();
  const previousInstances = harness.instances.length;
  await harness.controller.seekHistoricalRelative(-20);
  assert.equal(harness.controller.clock.absoluteTime, 1799999980);
  assert.equal(harness.controller.clock.running, false);
  assert.equal(harness.instances.length, previousInstances + 2);
  assert.equal(
    harness.calls.filter(call =>
      call.type === "frigate_max/v1/vod/prepare" && call.target === 1799999980
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
  assert.match(up.message, /^Unavailable:/);
  assert.equal(down.unavailable, false);
  assert.equal(harness.starts.length, 1);
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
