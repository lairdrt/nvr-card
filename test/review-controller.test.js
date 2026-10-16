import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

import {
  VIEWER_LAYOUTS,
  REVIEW_PLAYBACK_SPEEDS,
  REVIEW_TIMELINE_CAMERA_COLORS,
  ReviewClock,
  formatNvrClockTime,
  ReviewController,
  buildReviewRange,
  calculateHistoricalSeek,
  buildRecordingAvailabilityWindow,
  getCivilDayBounds,
  getCivilDayKey,
  shiftCivilDayKey,
  normalizePreparedTiming,
  normalizeRecordingAvailability,
  inspectRecordingAvailability,
  normalizeReviewTimelineItems,
  reviewEventNavigationTimestamps,
  reviewEventNavigationTargets,
  buildReviewEventIntervals,
  planContinuousHandoffPrototype,
  planRecordingGapSkip,
  confirmedRecordingGaps,
  recordingGapIntersections,
  RecordingCoverageCache,
  reviewTimelineEpochFromCoordinate,
  reviewTimelineMarkerGeometry,
  reviewTimelineMarkerTop
} from "../src/review/review-controller.js";
import { createTestHarness } from "./helpers/nvr-card-harness.js";
import { epochToMedia, mediaToEpoch } from "../src/review/historical-presentation.js";

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

function presentationPrepared(camera, origin, target = 1800000000, logicalEnd = target + 120) {
  const logicalStart = target - 15;
  const mediaStart = logicalStart - origin;
  const mediaEnd = logicalEnd - origin;
  return {
    schema: 2,
    camera,
    selected_epoch: target,
    resolved_selected_epoch: target,
    requested_wall_start: logicalStart,
    requested_wall_end: logicalEnd,
    effective_wall_start: origin,
    logical_wall_start: logicalStart,
    logical_wall_end: logicalEnd,
    effective_absolute_origin: origin,
    media_start_position: mediaStart,
    selected_media_position: target - origin,
    logical_media_end_position: mediaEnd,
    coverage_run: {
      known_start: logicalStart,
      known_end: logicalEnd,
      continues_before: true,
      continues_after: true
    },
    time_map: {
      epoch_origin: origin,
      unit: "microseconds",
      spans: [[
        Math.round(mediaStart * 1e6), Math.round(mediaEnd * 1e6),
        Math.round(mediaStart * 1e6), Math.round(mediaEnd * 1e6)
      ]]
    }
  };
}

function setReviewTi(controller, epoch) {
  const running = controller.clock.running;
  controller.clock.setAbsolute(epoch);
  if (running) controller.clock.start();
}

test("deployed card cache-busts the Review controller with its build identifier", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  assert.match(
    source,
    /review-controller\.js\?v=__NVR_BUILD__/
  );
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

function createHistoricalHarness({
  unavailable = new Set(), prepareGate = null, reviewEvents = [], reviewError = false,
  reviewResponder = null, availabilityResponder = null,
  presentationResponder = null,
  deferredSeek = new Set(), deferredPlayable = new Set(), deferredFrame = new Set(),
  frameOffsetByCamera = new Map(), noRvfc = new Set(), playResponder = null,
  scheduleInitialDeadline = null,
  mediaReadyTimeoutMs = 15000, preparationTimeoutMs = 0, now = () => performance.now(),
  wallClockMs = Date.parse("2026-09-10T12:00:00-07:00"), initialReviewRange = null,
  recordingCoverage = true
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
    const calendarContainer = window.document.createElement("div");
    calendarContainer.className = "flatpickr-calendar";
    const calendarDay = window.document.createElement("button");
    calendarDay.type = "button";
    calendarDay.className = "flatpickr-day";
    calendarContainer.appendChild(calendarDay);
    options.appendTo.appendChild(calendarContainer);
    const normalize = value => value instanceof Date
      ? new Date(value.getTime())
      : new Date(value);
    const pad = value => String(value).padStart(2, "0");
    const display = value => {
      const date = normalize(value);
      if (!options.enableTime) {
        return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}`;
      }
      if (!options.time_24hr) {
        return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ` +
          `${pad(date.getHours() % 12 || 12)}:${pad(date.getMinutes())} ${date.getHours() < 12 ? "AM" : "PM"}`;
      }
      return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const canonical = value => {
      const date = normalize(value);
      const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      return options.enableTime
        ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
        : day;
    };
    const instance = {
      input,
      altInput,
      calendarContainer,
      config: options,
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
        calendarDay.dispatchEvent(new window.PointerEvent("pointerdown", {
          bubbles: true,
          composed: true
        }));
        this.setDate(value, true);
      },
      parseDate(value) {
        if (!options.enableTime) {
          const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value).trim());
          if (!match) return null;
          return new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]));
        }
        const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(
          String(value).trim()
        );
        if (!match) return null;
        return new Date(
          Number(match[3]), Number(match[1]) - 1, Number(match[2]),
          Number(match[4]), Number(match[5])
        );
      },
      open() {
        this.openCount += 1;
      },
      destroy() {
        this.destroyCount += 1;
        altInput.remove();
        calendarContainer.remove();
      }
    };
    instance.setDate(options.defaultDate);
    datePickerInstances.push(instance);
    return instance;
  };

  class MockHls {
    static Events = {
      MANIFEST_PARSED: "manifest",
      ERROR: "error",
      MEDIA_ATTACHING: "media-attaching",
      MEDIA_ATTACHED: "media-attached",
      MANIFEST_LOADING: "manifest-loading",
      DESTROYING: "destroying",
      MEDIA_DETACHING: "media-detaching",
      MEDIA_DETACHED: "media-detached"
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
      for (const handler of this.handlers.get(MockHls.Events.MEDIA_ATTACHING) ?? []) {
        handler(MockHls.Events.MEDIA_ATTACHING, {});
      }
      const camera = video.closest(".review-camera-panel")?.dataset.camera;
      let currentTime = Number(video.currentTime) || 0;
      let seeking = false;
      let readyState = deferredPlayable.has(camera) ? 2 : 3;
      video.currentTimeWrites = [];
      video.playbackRateWrites = [];
      let playbackRate = video.playbackRate;
      Object.defineProperty(video, "playbackRate", {
        configurable: true,
        get: () => playbackRate,
        set: value => {
          playbackRate = Number(value);
          video.playbackRateWrites.push(playbackRate);
        }
      });
      const frameCallbacks = new Map();
      let nextFrameId = 0;
      const emitFrame = (mediaTime = currentTime + (frameOffsetByCamera.get(camera) ?? 0),
        presentationTime = controller._now()) => {
        const pending = [...frameCallbacks.values()];
        frameCallbacks.clear();
        for (const callback of pending) callback(controller._now(), { mediaTime, presentationTime });
      };
      if (!noRvfc.has(camera)) {
        video.requestVideoFrameCallback = callback => {
          const id = ++nextFrameId;
          frameCallbacks.set(id, callback);
          return id;
        };
        video.cancelVideoFrameCallback = id => frameCallbacks.delete(id);
      }
      Object.defineProperty(video, "seekable", {
        configurable: true,
        value: { length: 1, start: () => 0, end: () => 135 }
      });
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => currentTime,
        set: value => {
          currentTime = Number(value);
          video.currentTimeWrites.push(currentTime);
          seeking = deferredSeek.has(camera);
          if (!deferredFrame.has(camera)) queueMicrotask(() => emitFrame());
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
          if (deferredFrame.delete(camera)) emitFrame();
        },
        emitFrame,
        pendingFrameCallbacks: () => [...frameCallbacks.values()]
      });
      video.pauseCount = 0;
      video.loadCount = 0;
      let paused = true;
      Object.defineProperty(video, "paused", {
        configurable: true,
        get: () => paused
      });
      video.pause = () => { video.pauseCount += 1; paused = true; };
      video.load = () => {
        video.loadCount += 1;
        video.dispatchEvent(new window.Event("emptied"));
      };
      video.play = () => {
        paused = false;
        starts.push(this.source);
        playCalls.push({
          camera,
          video,
          playbackRate: video.playbackRate,
          clockRunning: controller?.clock.running ?? false
        });
        video.dispatchEvent(new window.Event("playing"));
        return playResponder ? playResponder(camera, video) : Promise.resolve();
      };
      for (const handler of this.handlers.get(MockHls.Events.MEDIA_ATTACHED) ?? []) {
        handler(MockHls.Events.MEDIA_ATTACHED, {});
      }
    }

    loadSource(source) {
      this.source = source;
      for (const handler of this.handlers.get(MockHls.Events.MANIFEST_LOADING) ?? []) {
        handler(MockHls.Events.MANIFEST_LOADING, {});
      }
      for (const handler of this.handlers.get(MockHls.Events.MANIFEST_PARSED) ?? []) {
        handler(MockHls.Events.MANIFEST_PARSED, {});
      }
    }

    destroy() {
      for (const handler of this.handlers.get(MockHls.Events.DESTROYING) ?? []) {
        handler(MockHls.Events.DESTROYING, {});
      }
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
      if (message.type === "frigate_max/v2/vod/prepare") {
        // Keep legacy call-count assertions meaningful while the production
        // path migrates to the v2 contract.
        calls.push({ ...message, type: "frigate_max/v1/vod/prepare" });
        if (unavailable.has(message.camera)) {
          return Promise.reject(new Error("No recording at requested time."));
        }
        if (presentationResponder) return presentationResponder(message);
        const origin = message.camera === "drive_up"
          ? message.target - 21
          : message.target - 22;
        const result = presentationPrepared(message.camera, origin, message.target);
        return prepareGate ? prepareGate.then(() => result) : Promise.resolve(result);
      }
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
        return Promise.resolve({ schema: 2, complete: true, items: reviewEvents });
      }
      if (message.type === "frigate_max/v1/recordings/availability") {
        if (availabilityResponder) return availabilityResponder(message);
        return Promise.resolve({
          camera: message.camera,
          requested_start: message.start,
          requested_end: message.end,
          coverage: [{ start: message.start, end: message.end }]
        });
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
    wallClock: () => typeof wallClockMs === "function" ? wallClockMs() : wallClockMs,
    datePickerFactory,
    mediaReadyTimeoutMs,
    preparationTimeoutMs,
    ...(scheduleInitialDeadline ? { scheduleInitialDeadline } : {}),
    now,
    recordingCoverage
  });
  controller.configure(cameras());
  controller.setSelectedCameraNames(["Drive Up", "Drive Down"]);
  controller.setDebug(true);
  controller.setHass(hass);
  if (initialReviewRange) {
    controller._reviewRange = { ...initialReviewRange };
    controller._desiredReviewRange = { ...initialReviewRange };
    controller._desiredReviewQuery = controller.getDesiredReviewQuery();
    controller._displayedReviewQuery = controller.cloneReviewQuery(controller._desiredReviewQuery);
  }
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

function recordingCoverageResponder(intervalsByCamera, onRequest = null) {
  return message => {
    const override = onRequest?.(message);
    if (override !== undefined) return override;
    const coverage = (intervalsByCamera[message.camera] ?? [])
      .map(interval => ({
        start: Math.max(interval.start, message.start),
        end: Math.min(interval.end, message.end)
      }))
      .filter(interval => interval.start < interval.end);
    return Promise.resolve({
      camera: message.camera, requested_start: message.start,
      requested_end: message.end, coverage
    });
  };
}

async function enterEventAutoSnap(harness, target, when) {
  const controller = harness.controller;
  await controller.refreshReviewQuery();
  await controller.playHistorical(target, {
    autoplay: false, updateDisplayedRange: false, playbackRange: when
  });
  controller.setAutoSnapTo(true);
  return controller;
}
function getWhenEditor(harness) {
  const content = harness.root.querySelector(".review-when-controls");
  const field = endpoint => harness.root.querySelector(`.review-${endpoint}-picker`)
    .closest(".review-range-field").nextElementSibling;
  return {
    content,
    apply: content.querySelector(".review-when-apply"),
    minus: content.querySelectorAll(".review-when-shortcuts button")[0],
    today: content.querySelectorAll(".review-when-shortcuts button")[1],
    plus: content.querySelectorAll(".review-when-shortcuts button")[2],
    fromPicker: harness.controller._datePickers.from,
    toPicker: harness.controller._datePickers.to,
    fromHour: field("from").querySelector(".review-time-hour"),
    fromMinute: field("from").querySelector(".review-time-minute"),
    toHour: field("to").querySelector(".review-time-hour"),
    toMinute: field("to").querySelector(".review-time-minute")
  };
}

function changeWhenSelect(harness, select, value) {
  select.value = String(value);
  select.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
}

function selectWhenDate(picker, year, month, day) {
  picker.select(new Date(year, month - 1, day));
}

function assertWhenControls(editor, {
  fromDate, fromHour, fromMinute, toDate, toHour, toMinute
}) {
  assert.equal(editor.fromPicker.altInput.value, fromDate);
  assert.equal(editor.fromHour.value, String(fromHour));
  assert.equal(editor.fromMinute.value, String(fromMinute));
  assert.equal(editor.toPicker.altInput.value, toDate);
  assert.equal(editor.toHour.value, String(toHour));
  assert.equal(editor.toMinute.value, String(toMinute));
}

function reviewMetadataCallCount(harness) {
  return harness.calls.filter(call => call.type === "frigate_max/v1/review/get").length;
}

function whenDateLabel(epochSeconds, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(epochSeconds * 1000));
}

async function waitForHistoricalMedia(harness, count) {
  for (let index = 0; index < 50 && harness.mediaControls.length < count; index += 1) {
    await Promise.resolve();
  }
  assert.equal(harness.mediaControls.length, count);
}

function configureGarage(harness) {
  harness.controller._hass.states["camera.garage"] = {
    attributes: { camera_name: "garage" }
  };
  harness.controller.configure([
    ...cameras(),
    { name: "Garage", entity: "camera.garage", active: true }
  ]);
}

async function waitForCalls(harness, type, count) {
  for (let index = 0; index < 100 &&
      harness.calls.filter(call => call.type === type).length < count; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.ok(harness.calls.filter(call => call.type === type).length >= count);
}

async function waitForCondition(predicate, message = "condition was not reached") {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail(message);
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
    const harness = createHistoricalHarness({ initialReviewRange: range });
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
    const harness = createHistoricalHarness();
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
  const harness = createHistoricalHarness({
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
  const harness = createHistoricalHarness({ now: () => 1000 });
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
  const harness = createHistoricalHarness();
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
  const harness = createHistoricalHarness({ now: () => tick });
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
  const harness = createHistoricalHarness({
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
  const harness = createHistoricalHarness({
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
  const harness = createHistoricalHarness();
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
  const harness = createHistoricalHarness();
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
  const harness = createHistoricalHarness();
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
  const harness = createHistoricalHarness({ wallClockMs: wall * 1000, initialReviewRange: range });
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
  const harness = createHistoricalHarness({ reviewEvents: [
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

  const future = createHistoricalHarness();
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
  const harness = createHistoricalHarness({
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
      const harness = createHistoricalHarness({ availabilityResponder: message => Promise.resolve({
        camera: message.camera, requested_start: message.start, requested_end: message.end,
        coverage: gap ? [] : [{ start: message.start, end: message.end }]
      }) });
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

test("manual Timeline click pauses placement, prepares the target, and waits for explicit Play", async t => {
  const harness = createHistoricalHarness({ wallClockMs: 1800000000 * 1000 });
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
  const harness = createHistoricalHarness();
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

function configureFourSelectedCameras(harness) {
  const four = [...cameras().filter(camera => camera.active), {
    name: "Patio", entity: "camera.patio", active: true
  }];
  harness.controller._hass.states["camera.patio"] = {
    attributes: { camera_name: "patio" }
  };
  harness.controller.configure(four);
  harness.controller.setSelectedCameraNames(["Drive Up", "Drive Down", "Back", "Patio"]);
}

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
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_up"
        ? [{ start: target - 30, end: target + 5 },
          { start: target + 20, end: target + 100 }]
        : [{ start: message.start, end: message.end }]
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
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: [{ start: target - 30, end: target + 5 },
        { start: target + 20, end: target + 100 }]
    }),
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
  const harness = createHistoricalHarness({ now: () => 1000 });
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

// Auto Snap navigates by event time only. Recording availability never selects an
// event or moves the TI past an event's actual start; the clock runs through
// unrecorded time and cameras rejoin when coverage begins.
function createEventTimeHarness(t, { events, coverage, when, tick = { value: 1000 },
  onRequest = null } = {}) {
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000, now: () => tick.value,
    initialReviewRange: when, reviewEvents: events,
    availabilityResponder: recordingCoverageResponder(coverage, onRequest) });
  t.after(() => harness.close());
  return harness;
}

function prepareTargets(harness) {
  return harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare")
    .map(call => call.target);
}

function autoSnapOutcomes(controller) {
  return controller.getRecentAutoSnapDecisions().map(decision => decision.outcome);
}

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

function createRejoinHarness(target, options = {}) {
  return createHistoricalHarness({
    now: () => 0,
    availabilityResponder: message => Promise.resolve({
      camera: message.camera,
      requested_start: message.start,
      requested_end: message.end,
      coverage: message.camera === "drive_down"
        ? [{ start: target + 5, end: target + 100 }]
        : [{ start: message.start, end: message.end }]
    }),
    ...options
  });
}

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
  await harness.controller.ensureCameraAvailability(up, target + 3700, { reason: "cache_miss" });
  assert.equal(harness.calls.filter(call =>
    call.type === "frigate_max/v1/recordings/availability" && call.camera === "drive_up").length,
  availabilityBefore + 1);
  failDriveUp = true;
  const outcome = await harness.controller.reconcileHistoricalCamera(up, target + 7400, {
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
  const harness = createHistoricalHarness({ now: () => 0 });
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

function manualInitialDeadlines() {
  const jobs = [];
  return {
    jobs,
    schedule(callback, delay) {
      const job = {
        active: true, delay, callback,
        fire() {
          if (!this.active) return;
          this.active = false;
          callback();
        }
      };
      jobs.push(job);
      return () => { job.active = false; };
    },
    fireActive() {
      const job = jobs.findLast(candidate => candidate.active);
      assert.ok(job, "an initial deadline must be active");
      job.fire();
    }
  };
}

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

test("Review fatal Hls and media errors are observational and once per presentation", async t => {
  const harness = createHistoricalHarness();
  t.after(() => harness.close());
  harness.controller.setDebug(false);
  await harness.controller.playHistorical(1800000000);
  const player = harness.controller._historicalPlayers.get("Drive Up");
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
  const records = harness.controller.getRecentReviewFailures();
  assert.equal(records.filter(record => record.reason === "hls_fatal").length, 1);
  assert.equal(records.filter(record => record.reason === "media_error").length, 1);
  assert.equal(player.lifecycleState, "participating");
  assert.strictEqual(player.hls, hls);
  assert.strictEqual(player.video, video);
  assert.equal(harness.calls.length, calls);
  assert.equal(harness.playCalls.length, plays);
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
  up.availability = null;
  assert.equal(await harness.controller.reconcileHistoricalCamera(up, 1800000005),
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

async function createContinuationFailureExperiment(t, {
  rate = 1, failure = "none", cameras = ["Drive Up"], deferRecovery = false,
  coverageIntervals = null, autoSnap = false
} = {}) {
  const base = 1800000000;
  const when = { from: base - 30, to: base + 100 };
  let elapsedMs = 0;
  const attempts = new Map();
  const trace = [];
  let releaseRecovery;
  const recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });
  const harness = createHistoricalHarness({
    now: () => elapsedMs,
    wallClockMs: (base + 500) * 1000,
    initialReviewRange: when,
    ...(autoSnap ? { reviewEvents: [{ camera_id: "drive_up", start_time: base,
      end_time: when.to }] } : {}),
    ...(coverageIntervals ? { availabilityResponder: recordingCoverageResponder({
      drive_up: coverageIntervals, drive_down: coverageIntervals
    }) } : {}),
    presentationResponder: message => {
      const count = (attempts.get(message.camera) ?? 0) + 1;
      attempts.set(message.camera, count);
      if (message.camera === "drive_up" && count === 3 && deferRecovery) {
        return recoveryGate.then(() => Promise.reject(
          new Error("superseded recovery preparation")));
      }
      if (message.camera === "drive_up" && count > 1 &&
          (failure === "always" || (failure === "once" && count === 2))) {
        return Promise.reject(new Error("simulated successor VOD preparation failure"));
      }
      const end = message.camera === "drive_up" && count === 1
        ? base + 20 : when.to;
      return Promise.resolve(presentationPrepared(
        message.camera, message.target - 21, message.target, end
      ));
    }
  });
  t.after(() => harness.close());
  harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  const controller = harness.controller;
  controller.setSelectedCameraNames(cameras);
  await controller.refreshReviewQuery();
  controller.setPlaybackSpeed(rate);
  await controller.playHistorical(base, {
    autoplay: false, updateDisplayedRange: false,
    playbackRange: when, cameraNames: cameras
  });
  const player = controller._historicalPlayers.get("Drive Up");
  assert.equal(player.lifecycleState, "participating");
  assert.equal(player.timing.logical_wall_end, base + 20);
  if (autoSnap) controller.setAutoSnapTo(true);
  harness.mediaControls.find(control => control.camera === "Drive Up").emitFrame();
  assert.ok(player.heldCanvas && Number.isFinite(player.heldFrameEpoch));
  const snapshot = phase => {
    const failureRecord = controller.getRecentReviewFailures().find(record =>
      record.camera === "Drive Up" && record.outcome === "failure");
    const state = {
      phase,
      tiOffset: Number((controller.clock.absoluteTime - base).toFixed(3)),
      clockRunning: controller.clock.running,
      playRequested: controller._playRequested,
      cameraState: player.lifecycleState,
      participatingCount: [...controller._historicalPlayers.values()].filter(candidate =>
        candidate.lifecycleState === "participating").length,
      presentationEndOffset: Number((player.timing?.logical_wall_end ??
        player.lastTiming?.logical_wall_end ?? base) - base),
      prepareAttempts: attempts.get("drive_up") ?? 0,
      recoveryAttempts: player.continuationRecovery?.attempts ?? 0,
      recoveryExhausted: player.continuationRecovery?.exhausted ?? false,
      heldFrameVisible: player.heldCanvas?.hidden === false,
      badge: controller.reviewCameraStatusIndicator(player),
      failureReason: failureRecord?.reason ?? null
    };
    trace.push(state);
    return state;
  };
  snapshot("initial_paused");
  assert.equal(controller.resumePlayback(), true);
  await waitForCondition(() => player.lifecycleState === "participating" &&
    player.video.paused === false);
  snapshot("playing_initial");
  elapsedMs = 20000 / rate;
  player.video.currentTime = player.timing.logical_media_end_position;
  assert.equal(controller.enforceHistoricalPresentationBoundary(), true);
  snapshot("exhausted_preparing_successor");
  if (coverageIntervals) {
    await waitForCondition(() => player.lifecycleState === "unavailable");
    snapshot("recording_gap");
  } else {
    await waitForCondition(() => (attempts.get("drive_up") ?? 0) === 2 &&
      player.lifecycleState === (failure === "none" ? "participating" : "failed"));
    snapshot(failure === "none" ? "successor_playing" : "successor_failed");
  }
  return {
    base, when, harness, controller, player, attempts, trace, snapshot,
    advanceWallClock(ms) { elapsedMs += ms; },
    releaseRecovery,
    diagnostic() { t.diagnostic(JSON.stringify(trace)); }
  };
}

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
    assert.equal(trace.at(-1).recoveryAttempts, 0);
    run.harness.mediaControls.filter(control => control.camera === "Drive Up")
      .at(-1).emitFrame();
    run.snapshot("first_successor_frame");
    assert.equal(trace.at(-1).heldFrameVisible, false);
    run.diagnostic();
  });
}

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
  assert.equal(player.continuationRecovery, null);
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

// Review timeline recording gaps. Windows are aligned to absolute 2 h epochs and
// GAP_BASE is a multiple of 7200, so [base - 7200, base) and [base, base + 7200).
const GAP_BASE = 1800000000;
const GAP_WHEN = { from: GAP_BASE - 7200, to: GAP_BASE + 7200 };

function createGapHarness(options = {}) {
  return createHistoricalHarness({
    wallClockMs: (GAP_BASE + 4 * 3600) * 1000,
    initialReviewRange: GAP_WHEN,
    ...options
  });
}

function settleCoverage() {
  return new Promise(resolve => setImmediate(resolve));
}

function timelineGaps(harness, camera) {
  return [...harness.root.querySelectorAll(
    `.review-timeline-lane[data-camera-id="${camera}"] .review-timeline-marker-gap`
  )].map(element => ({
    start: Number(element.dataset.startEpoch),
    end: Number(element.dataset.endEpoch),
    style: element.getAttribute("style")
  }));
}

function gapRanges(harness, camera) {
  return timelineGaps(harness, camera).map(gap => [gap.start, gap.end]);
}

function coverageCalls(harness) {
  return harness.calls.filter(call => call.type === "frigate_max/v1/recordings/availability");
}

function assertGapGeometry(gap, top, height) {
  const percent = pattern => Number(gap.style.match(pattern)?.[1]);
  assert.ok(Math.abs(percent(/top:min\(([\d.]+)%/) - top * 100) < 1e-9, gap.style);
  assert.ok(Math.abs(percent(/height:max\(([\d.]+)%/) - height * 100) < 1e-9, gap.style);
}

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
  const harness = createGapHarness({
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
  const harness = createGapHarness({
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
  const harness = createGapHarness({
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
  const harness = createGapHarness({
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
  const harness = createGapHarness({
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

// Characterization of the existing clock/coverage separation that Skip Recording
// Gaps will build on. These pin current behavior; they are not new behavior.
const UNRECORDED_TARGET = Date.parse("2026-09-10T09:00:00-07:00") / 1000;

function unrecordedGapCoverage(target = UNRECORDED_TARGET) {
  const intervals = [{ start: target - 30, end: target + 5 },
    { start: target + 20, end: target + 100 }];
  return recordingCoverageResponder({ drive_up: intervals, drive_down: intervals });
}

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

// Autoplay seeks advance independently of coverage; legacy opt-in callers behave identically.
const FAR_GAP = UNRECORDED_TARGET + 5000;

function createUnrecordedSeekHarness(t, { tick, coverage = null, onRequest = null } = {}) {
  const intervals = coverage ?? [{ start: UNRECORDED_TARGET - 30, end: UNRECORDED_TARGET + 5 },
    { start: UNRECORDED_TARGET + 20, end: UNRECORDED_TARGET + 100 },
    { start: FAR_GAP + 20, end: FAR_GAP + 100 }];
  const harness = createHistoricalHarness({
    now: () => tick.value,
    availabilityResponder: recordingCoverageResponder(
      { drive_up: intervals, drive_down: intervals }, onRequest)
  });
  t.after(() => harness.close());
  return harness;
}

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
  assert.equal(await controller.seekHistoricalToEpoch(FAR_GAP,
    { autoplay: true, advanceThroughConfirmedGap: true }), true);
  const up = controller._historicalPlayers.get("Drive Up");
  const down = controller._historicalPlayers.get("Drive Down");
  assert.equal(up.boundaryReason, "authoritative_recording_gap");
  assert.equal(down.lifecycleState, "failed");
  assert.equal(controller.clock.running, true, "failed coverage cannot veto the clock");
  assert.equal(controller.clock.absoluteTime, FAR_GAP);
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
  await controller.playHistorical(base);
  now += 12000;
  fail = false;
  await controller.queueHistoricalAvailabilityEvaluation("queries_recovered");
  await waitForCondition(() => [...controller._historicalPlayers.values()].every(player =>
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


function createReadinessHarness(t, options = {}) {
  const tick = { value: 1000 };
  const deadlines = manualInitialDeadlines();
  const harness = createHistoricalHarness({ preparationTimeoutMs: 1500,
    now: () => tick.value, scheduleInitialDeadline: deadlines.schedule.bind(deadlines),
    ...options });
  t.after(() => harness.close());
  return { ...harness, tick, deadlines,
    releaseTimeout() {
      const job = deadlines.jobs.find(job => job.active && job.delay === 1500);
      assert.ok(job, "one readiness deadline must be active");
      job.fire();
    }
  };
}

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
    const h = createReadinessHarness(t, { initialReviewRange: when, wallClockMs: when.to * 1000,
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

const SKIP_BASE = 1800000000;

async function captureRecordingSkipEvaluation(h) {
  let evaluate;
  const setInterval = h.window.setInterval.bind(h.window);
  h.window.setInterval = (callback, delay, ...args) => {
    if (delay === 500) evaluate = callback;
    return setInterval(callback, delay, ...args);
  };
  await h.controller.playHistorical(h.when.from, {
    playbackRange: h.when, updateDisplayedRange: false
  });
  h.window.clearInterval(h.controller._diagnosticTimer);
  h.controller._diagnosticTimer = null;
  await settleCoverage();
  assert.equal(typeof evaluate, "function");
  return evaluate;
}

async function createRecordingSkipHarness(t, {
  coverage = { drive_up: [], drive_down: [] },
  when = { from: SKIP_BASE, to: SKIP_BASE + 200 },
  // Coverage/search fixtures exercise WHITE inside this explicit association.
  // BLACK fixtures must supply their actual sparse event list (or []).
  tick = { value: 1000 }, events = [{ camera_id: "drive_up", start_time: when.from, end_time: when.to }],
  onRequest = null, ...options
} = {}) {
  const h = createHistoricalHarness({ initialReviewRange: when,
    wallClockMs: (when.to + 86400) * 1000, now: () => tick.value,
    reviewEvents: events, availabilityResponder: recordingCoverageResponder(coverage, onRequest),
    ...options });
  t.after(() => h.close());
  await h.controller.refreshReviewQuery();
  await h.controller.playHistorical(when.from, { playbackRange: when, updateDisplayedRange: false });
  h.window.clearInterval(h.controller._diagnosticTimer);
  h.controller._diagnosticTimer = null;
  await settleCoverage();
  return { ...h, tick, when };
}

async function driveRecordingSkip(h, slices = 10) {
  for (let index = 0; index < slices; index += 1) {
    if (h.controller.evaluateRecordingGapSkip()) return true;
    await settleCoverage();
  }
  return false;
}

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
  const h = await createRecordingSkipHarness(t, { events: [
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
    const h = await createRecordingSkipHarness(t, { when, coverage: {
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
    if (supersession === "manual seek") await c.seekHistoricalToEpoch(SKIP_BASE + 80, { autoplay: true });
    if (supersession === "selection") c.setSelectedCameraNames(["Drive Up"]);
    if (supersession === "option") c.setSnapPastCrap(false);
    if (supersession === "event option") c.setAutoSnapTo(true);
    if (supersession === "View") c.restoreReviewView(c.captureReviewViewState());
    if (supersession === "Live") c.returnToLive();
    if (supersession === "teardown") c.deactivate();
    const position = c.reviewPosition;
    assert.notStrictEqual(c._recordingGapSkipSearch, search);
    release();
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
