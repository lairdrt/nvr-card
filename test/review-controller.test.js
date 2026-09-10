import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

import {
  ReviewClock,
  ReviewController,
  calculateHistoricalSeek,
  getCivilDayBounds,
  getCivilDayKey,
  normalizePreparedTiming
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

test("Review date picker retains the accepted dark field and selected-day contrast", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(source, /flatpickr-4\.6\.13\.min\.css/);
  assert.match(source, /\.review-date-picker-field \.review-day-picker\s*{[\s\S]*?background:\s*#171f26;[\s\S]*?color:\s*#dce6ec;/);
  assert.match(source, /\.flatpickr-day\.selected,[\s\S]*?background:\s*#003a70;[\s\S]*?color:\s*#fff;/);
});

function createHistoricalHarness({ unavailable = new Set(), prepareGate = null } = {}) {
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
    const display = dayKey => {
      const [year, month, day] = dayKey.split("-");
      return `${month}/${day}/${year}`;
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
      setDate(dayKey, triggerChange = false) {
        this.current = dayKey;
        input.value = dayKey;
        altInput.value = display(dayKey);
        if (triggerChange) options.onChange([], dayKey, this);
      },
      select(dayKey) {
        this.setDate(dayKey, true);
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
  clock.pause();
  now = 9000;
  assert.equal(clock.absoluteTime, 1800000001.75);
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
    "Cameras", "When", "Filters"
  ]);
  assert.deepEqual(reviewHeaders.map(header => header.title), [
    "Cameras", "When", "Filters"
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

  assert.equal(sections.length, 3);
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
  card._reviewController.setSectionExpanded("filters", true);
  card.setApplicationMode("live");
  card.setApplicationMode("review");
  assert.equal(card.querySelector(".review-cameras-section").classList.contains("expanded"), true);
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
  harness.controller.setSelectedDay("2026-09-07");
  const before = harness.controller.state;
  for (const name of ["cameras", "when", "filters"]) {
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
  assert.match(harness.root.querySelector(".review-empty-state").textContent, /Select cameras/);
});

test("Review camera rows match logical order and expose participation only", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const rows = [...harness.root.querySelectorAll(".review-camera-controls .camera-item")];
  assert.deepEqual(rows.map(row => row.dataset.camera), ["Drive Up", "Drive Down", "Back"]);
  assert.ok(rows.every(row => row.querySelector("ha-icon.camera-row-icon")));
  assert.ok(rows.every(row => row.querySelector('input[type="checkbox"].review-participation')));
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
  assert.strictEqual(harness.root.querySelector('.review-primary [data-camera="Drive Down"]'), down);
  assert.strictEqual(down.querySelector("video"), downVideo);
  assert.strictEqual(up.querySelector("video"), upVideo);
  assert.equal(harness.controller.clock.absoluteTime, beforeClock);
  assert.equal(harness.controller.clock.running, true);
  assert.deepEqual(harness.controller.state.selectedCameraNames, before.selectedCameraNames);
  assert.equal(harness.controller.state.selectedDay, before.selectedDay);
  assert.deepEqual(
    [...harness.root.querySelectorAll(".review-mini-grid .review-camera-panel")]
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

test("When omits Today while preserving a selected day and Now returns live", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  assert.equal(harness.root.querySelector(".review-day-today"), null);
  assert.equal(harness.datePickerInstances.at(-1).current, harness.controller.todayKey);
  harness.controller.setSelectedDay("2026-09-07");
  await harness.controller.playHistorical(1800000000);
  assert.equal(harness.controller.state.selectedDay, "2026-09-07");
  assert.equal(harness.controller.state.presentationMode, "historical");
  harness.root.querySelector(".review-now").click();
  assert.equal(harness.controller.state.presentationMode, "live");
  assert.equal(harness.root.querySelectorAll("hui-image.review-live-camera").length, 2);
});

test("first Review entry uses local today and a chosen day survives a mode round trip", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  assert.equal(harness.controller.state.selectedDay, harness.controller.todayKey);
  const chosen = "2026-09-07";
  assert.equal(harness.controller.setSelectedDay(chosen), true);
  const previousPicker = harness.datePickerInstances.at(-1);
  harness.controller.deactivate();
  assert.equal(previousPicker.destroyCount, 1);
  harness.controller.activate();
  assert.equal(harness.controller.state.selectedDay, chosen);
  assert.equal(harness.datePickerInstances.at(-1).current, chosen);
  assert.equal(harness.datePickerInstances.at(-1).altInput.value, "09/07/2026");
  assert.equal(harness.root.querySelector(".review-day-today"), null);
});

test("Review date picker integration keeps canonical state and media identity", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller.setSelectedDay("2024-03-01");
  const panel = harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]');
  const image = panel.querySelector("hui-image");
  const picker = harness.datePickerInstances.at(-1);
  assert.deepEqual(
    {
      altInput: picker.options.altInput,
      altFormat: picker.options.altFormat,
      dateFormat: picker.options.dateFormat,
      allowInput: picker.options.allowInput,
      disableMobile: picker.options.disableMobile,
      maxDate: picker.options.maxDate
    },
    {
      altInput: true,
      altFormat: "m/d/Y",
      dateFormat: "Y-m-d",
      allowInput: true,
      disableMobile: true,
      maxDate: harness.controller.todayKey
    }
  );
  harness.root.querySelector(".review-day-previous").click();
  assert.equal(harness.controller.state.selectedDay, "2024-02-29");
  assert.equal(picker.current, "2024-02-29");
  assert.equal(picker.altInput.value, "02/29/2024");
  harness.root.querySelector(".review-day-next").click();
  assert.equal(harness.controller.state.selectedDay, "2024-03-01");
  picker.select("2024-04-02");
  assert.equal(harness.controller.state.selectedDay, "2024-04-02");
  assert.equal(picker.altInput.value, "04/02/2024");
  harness.root.querySelector(".review-calendar-button").click();
  assert.equal(picker.openCount, 1);
  assert.strictEqual(
    harness.root.querySelector('.review-camera-panel[data-camera="Drive Up"]'),
    panel
  );
  assert.strictEqual(panel.querySelector("hui-image"), image);
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
      .map(child => child.className),
    ["review-primary", "review-mini-grid"]
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
  const now = harness.root.querySelector(".review-now");
  assert.strictEqual(now.parentElement, controls);
  assert.equal(now.textContent, "");
  assert.equal(now.querySelector("ha-icon").getAttribute("icon"), "mdi:clock-fast");
  assert.equal(workspace.querySelector(".review-mini-grid").children.length, 12);
  assert.equal(harness.root.textContent.includes("Review live"), false);
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

test("mini wall occupancy and blanks remain stable for zero and one participant", t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  const mini = harness.root.querySelector(".review-mini-grid");
  assert.deepEqual(
    [...mini.querySelectorAll(".review-camera-panel")].map(panel => panel.dataset.camera),
    ["Drive Down"]
  );
  assert.equal(mini.querySelectorAll(".review-mini-blank").length, 11);
  harness.controller.setSelectedCameraNames(["Drive Up"]);
  assert.equal(mini.querySelectorAll(".review-camera-panel").length, 0);
  assert.equal(mini.querySelectorAll(".review-mini-blank").length, 12);
  harness.controller.setSelectedCameraNames([]);
  assert.ok(harness.root.querySelector(".review-empty-state"));
  assert.equal(mini.querySelectorAll(".review-mini-blank").length, 12);
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
  assert.ok(root.querySelector("input.review-day-picker"));
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
