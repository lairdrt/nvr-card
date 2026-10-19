// Shared helpers and fixtures for the ReviewController regression suites.
// Moved verbatim from the former test/review-controller.test.js, which exceeded Node's
// default heap because the test runner keeps finished tests reachable until the process
// exits. Each suite file runs in its own process and imports what it uses from here.
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
import {
  ReviewBlackboard, BLACKBOARD_CLOCK, BLACKBOARD_COVERAGE, BLACKBOARD_EVENT_CLASSES, BLACKBOARD_STATES
} from "../src/review/review-blackboard.js";

export function cameras() {
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


export function prepared(camera, origin, target = 1800000000) {
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


export function presentationPrepared(camera, origin, target = 1800000000, logicalEnd = target + 120,
  logicalStart = target - 15) {
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


export function setReviewTi(controller, epoch) {
  const running = controller.clock.running;
  controller.clock.setAbsolute(epoch);
  if (running) controller.clock.start();
}


// The calendar date that When, Timeline-day and initial-position tests are written against.
export const HARNESS_CALENDAR_WALL_CLOCK_MS = Date.parse("2026-09-10T12:00:00-07:00");

// A wall clock after every recording the playback tests prepare (targets near 1800000000).
export const HARNESS_PLAYBACK_WALL_CLOCK_MS = 1800100000 * 1000;


export function createHistoricalHarness({
  unavailable = new Set(), prepareGate = null, reviewEvents = [], reviewError = false,
  reviewResponder = null, availabilityResponder = null,
  presentationResponder = null,
  deferredSeek = new Set(), deferredPlayable = new Set(), deferredFrame = new Set(),
  frameOffsetByCamera = new Map(), noRvfc = new Set(), playResponder = null,
  scheduleInitialDeadline = null,
  mediaReadyTimeoutMs = 15000, preparationTimeoutMs = 0, now = () => performance.now(),
  // Simulated "now" follows the recordings tests play (RECOVERY_T-era targets): coverage is
  // only ever known for published time. Calendar tests pass HARNESS_CALENDAR_WALL_CLOCK_MS.
  wallClockMs = HARNESS_PLAYBACK_WALL_CLOCK_MS, initialReviewRange = null,
  recordingCoverage = true,
  // Production defaults to diagnostics OFF; only tests of diagnostic output opt in.
  debug = false,
  blackboard = true
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
    recordingCoverage,
    blackboard
  });
  controller.configure(cameras());
  controller.setSelectedCameraNames(["Drive Up", "Drive Down"]);
  controller.setDebug(debug);
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


export function recordingCoverageResponder(intervalsByCamera, onRequest = null) {
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


export async function enterEventAutoSnap(harness, target, when) {
  const controller = harness.controller;
  await controller.refreshReviewQuery();
  await controller.playHistorical(target, {
    autoplay: false, updateDisplayedRange: false, playbackRange: when
  });
  controller.setAutoSnapTo(true);
  return controller;
}

export function getWhenEditor(harness) {
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


export function changeWhenSelect(harness, select, value) {
  select.value = String(value);
  select.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
}


export function selectWhenDate(picker, year, month, day) {
  picker.select(new Date(year, month - 1, day));
}


export function assertWhenControls(editor, {
  fromDate, fromHour, fromMinute, toDate, toHour, toMinute
}) {
  assert.equal(editor.fromPicker.altInput.value, fromDate);
  assert.equal(editor.fromHour.value, String(fromHour));
  assert.equal(editor.fromMinute.value, String(fromMinute));
  assert.equal(editor.toPicker.altInput.value, toDate);
  assert.equal(editor.toHour.value, String(toHour));
  assert.equal(editor.toMinute.value, String(toMinute));
}


export function reviewMetadataCallCount(harness) {
  return harness.calls.filter(call => call.type === "frigate_max/v1/review/get").length;
}


export function whenDateLabel(epochSeconds, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(epochSeconds * 1000));
}


export async function waitForHistoricalMedia(harness, count) {
  for (let index = 0; index < 50 && harness.mediaControls.length < count; index += 1) {
    await Promise.resolve();
  }
  assert.equal(harness.mediaControls.length, count);
}


export function configureGarage(harness) {
  harness.controller._hass.states["camera.garage"] = {
    attributes: { camera_name: "garage" }
  };
  harness.controller.configure([
    ...cameras(),
    { name: "Garage", entity: "camera.garage", active: true }
  ]);
}


export async function waitForCalls(harness, type, count) {
  for (let index = 0; index < 100 &&
      harness.calls.filter(call => call.type === type).length < count; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.ok(harness.calls.filter(call => call.type === type).length >= count);
}


export async function waitForCondition(predicate, message = "condition was not reached") {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail(message);
}


// Go to Top / Go to Bottom always end paused: never Play, never resume after acquisition.
export async function edgeScene(t) {
  const when = { from: RECOVERY_T - 3600, to: RECOVERY_T + 3600 };
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE,
    harnessOptions: { initialReviewRange: when } });
  const { controller, harness } = scene;
  const plays = () => harness.playCalls.length;
  // Paused, nothing playing, nothing pending: the only acceptable end state.
  const expectPausedAt = async (epoch, message) => {
    for (let index = 0; index < 4; index += 1) {
      scene.advance(500);
      await scene.tick();
    }
    assert.equal(controller.clock.running, false, `${message}: the clock stays paused`);
    assert.equal(controller.playbackRequested, false, `${message}: no Play intent`);
    assert.equal(controller.clock.absoluteTime, epoch, `${message}: the chosen Review time is kept`);
    assert.equal(controller._presentationMode, "historical");
    assert.ok([...controller._historicalPlayers.values()].every(player => !player.video || player.video.paused),
      `${message}: no video plays`);
  };
  return { ...scene, when, plays, expectPausedAt };
}


export function configureFourSelectedCameras(harness) {
  const four = [...cameras().filter(camera => camera.active), {
    name: "Patio", entity: "camera.patio", active: true
  }];
  harness.controller._hass.states["camera.patio"] = {
    attributes: { camera_name: "patio" }
  };
  harness.controller.configure(four);
  harness.controller.setSelectedCameraNames(["Drive Up", "Drive Down", "Back", "Patio"]);
}


// Auto Snap navigates by event time only. Recording availability never selects an
// event or moves the TI past an event's actual start; the clock runs through
// unrecorded time and cameras rejoin when coverage begins.
export function createEventTimeHarness(t, { events, coverage, when, tick = { value: 1000 },
  onRequest = null } = {}) {
  const harness = createHistoricalHarness({ wallClockMs: when.to * 1000, now: () => tick.value,
    initialReviewRange: when, reviewEvents: events,
    availabilityResponder: recordingCoverageResponder(coverage, onRequest) });
  t.after(() => harness.close());
  return harness;
}


export function prepareTargets(harness) {
  return harness.calls.filter(call => call.type === "frigate_max/v2/vod/prepare")
    .map(call => call.target);
}


export function autoSnapOutcomes(controller) {
  return controller.getRecentAutoSnapDecisions().map(decision => decision.outcome);
}


export function createRejoinHarness(target, options = {}) {
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


// The availability queue is driven explicitly here: the real 500 ms heartbeat is
// stopped so that no unrelated evaluation can satisfy or perturb these contracts.
export async function createAvailabilityQueueHarness(t) {
  const harness = createHistoricalHarness({ now: () => 1000 });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.playHistorical(1800000000, { autoplay: false });
  harness.window.clearInterval(controller._diagnosticTimer);
  controller._diagnosticTimer = null;
  await controller._availabilityEvaluationPromise;
  assert.equal(controller._availabilityEvaluationPromise, null);
  let sequence = 0;
  const evaluations = [];
  const evaluate = controller.evaluateHistoricalAvailability.bind(controller);
  const recorder = { next: () => ++sequence, evaluations, controller, gate: null };
  controller.evaluateHistoricalAvailability = (target, options = {}) => {
    const entry = { start: ++sequence, end: null, reason: options.reason };
    evaluations.push(entry);
    const gate = recorder.gate;
    const result = (gate ? gate.then(() => evaluate(target, options)) : evaluate(target, options))
      .finally(() => { entry.end = ++sequence; });
    recorder.onEvaluation?.(result);
    return result;
  };
  return recorder;
}


// Availability requests are answered by hand; the shared coverage cache and the real
// 500 ms heartbeat are disabled so only the operations under test can touch a camera.
export async function createAvailabilityOwnershipHarness(t, { debug = false, autoplay = true } = {}) {
  const base = 1800000000;
  const outage = new Set(["drive_up"]);
  const requests = [];
  const harness = createHistoricalHarness({ debug, now: () => 1000, recordingCoverage: false,
    availabilityResponder: message => {
      if (outage.has(message.camera)) return Promise.reject(new Error("availability outage"));
      if (message.camera !== "drive_up" && !requests.manual?.has(message.camera)) {
        return Promise.resolve({ camera: message.camera, requested_start: message.start,
          requested_end: message.end, coverage: [{ start: message.start, end: message.end }] });
      }
      let settle;
      const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      requests.push({ camera: message.camera, message,
        succeed: () => settle.resolve({ camera: message.camera, requested_start: message.start,
          requested_end: message.end, coverage: [{ start: message.start, end: message.end }] }),
        fail: () => settle.reject(new Error("availability outage response")) });
      return promise;
    } });
  t.after(() => harness.close());
  const controller = harness.controller;
  await controller.playHistorical(base, { autoplay });
  harness.window.clearInterval(controller._diagnosticTimer);
  controller._diagnosticTimer = null;
  await controller._availabilityEvaluationPromise;
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  const up = controller._historicalPlayers.get("Drive Up");
  const down = controller._historicalPlayers.get("Drive Down");
  assert.equal(up.lifecycleState, "failed");
  assert.equal(up.boundaryReason, "availability_api_failure");
  assert.equal(down.lifecycleState, "participating");
  const lifecycles = [];
  const setLifecycle = controller.setCameraLifecycle.bind(controller);
  controller.setCameraLifecycle = (player, state, options = {}) => {
    lifecycles.push({ camera: player.camera.name, state, reason: options.boundaryReason ?? null });
    return setLifecycle(player, state, options);
  };
  // Counted at the call site: the ledger itself deduplicates and is only diagnostic.
  const failureRecords = [];
  const recordFailure = controller.recordReviewFailure.bind(controller);
  controller.recordReviewFailure = (player, details = {}) => {
    failureRecords.push({ camera: player?.camera?.name, reason: details.reason,
      outcome: details.outcome ?? "failure" });
    return recordFailure(player, details);
  };
  return { harness, controller, base, outage, requests, up, down, lifecycles, failureRecords,
    downBefore: { hls: down.hls, paused: down.video.paused, pauses: down.video.pauseCount,
      plays: harness.playCalls.filter(call => call.camera === "Drive Down").length } };
}


export function track(promise) {
  const tracked = { settled: false, value: undefined };
  tracked.promise = promise.then(value => {
    Object.assign(tracked, { settled: true, value });
    return value;
  });
  return tracked;
}


export async function flushMicrotasksUntil(predicate, message) {
  for (let index = 0; index < 50 && !predicate(); index += 1) await Promise.resolve();
  assert.ok(predicate(), message);
}


// Runs action synchronously in the first microtask where predicate holds; returning
// from an async helper first would let other queued work run past that ordering.
export async function atFirstMicrotask(predicate, action, message) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return action();
    await Promise.resolve();
  }
  assert.fail(message);
}


export function assertPeerUndisturbed(scene) {
  const { down, downBefore, harness } = scene;
  assert.equal(down.lifecycleState, "participating");
  assert.strictEqual(down.hls, downBefore.hls);
  assert.equal(down.video.paused, downBefore.paused);
  assert.equal(down.video.pauseCount, downBefore.pauses);
  assert.equal(harness.playCalls.filter(call => call.camera === "Drive Down").length, downBefore.plays);
}


export function manualInitialDeadlines() {
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


export const ACQUISITION_HISTORY_MODES = ["absent", "genuine", "empty", "full", "forged"];

export const ACQUISITION_STAGE_FIELDS = [
  "prepareStartMs", "prepareCompleteMs", "manifestSignedMs", "playerMountedMs",
  "manifestParsedMs", "seekableNonemptyMs", "seekIssuedMs", "seekingFalseMs",
  "targetToleranceMs", "readyStateThresholdMs", "barrierReadyMs"
];

export const ACQUISITION_PROGRESS_FLAGS = [
  "prepareMapped", "manifestSigned", "manifestParsed", "seekToleranceReached", "postSeekReady"
];


export function acquisitionProgress(...reached) {
  return Object.fromEntries(ACQUISITION_PROGRESS_FLAGS.map(flag => [flag, reached.includes(flag)]));
}


export function useAcquisitionHistory(controller, mode) {
  controller.setDebug(["genuine", "empty", "full"].includes(mode));
}


// Rewrites diagnostic history immediately before a classifier could consult it.
export function alterAcquisitionHistory(player, mode) {
  const name = player.camera.name;
  const camera = player.diagnosticReport?.cameras?.[name];
  if (mode === "empty" && camera) {
    camera.stages = {};
    delete camera.prepareSucceeded;
  } else if (mode === "full" && camera) {
    camera.stages = Object.fromEntries(ACQUISITION_STAGE_FIELDS.map(field => [field, 1]));
    camera.prepareSucceeded = true;
  } else if (mode === "forged") {
    // Seek tolerance without readiness: the shape both former classifiers trusted.
    player.diagnosticReport = { identityEvents: [], cameras: { [name]: {
      prepareSucceeded: true, boundaryEvents: [],
      stages: { manifestSignedMs: 1, manifestParsedMs: 1, targetToleranceMs: 1 }
    } } };
  }
}


export function recordCameraTransitions(controller) {
  const transitions = [];
  const begin = controller.beginCameraTransition.bind(controller);
  controller.beginCameraTransition = (player, ...rest) => {
    const transition = begin(player, ...rest);
    transitions.push({ camera: player.camera.name, transition });
    return transition;
  };
  return camera => transitions.filter(entry => entry.camera === camera).map(entry => entry.transition);
}


export function recordCameraClassifications(controller, camera) {
  const outcomes = [];
  const set = controller.setCameraLifecycle.bind(controller);
  controller.setCameraLifecycle = (player, state, options = {}) => {
    if (player.camera?.name === camera && (state === "failed" || state === "unavailable")) {
      outcomes.push({ state, boundaryReason: options.boundaryReason ?? null });
    }
    return set(player, state, options);
  };
  return outcomes;
}


export function acquisitionCommands(harness, frigateCamera) {
  return harness.calls.filter(call =>
    (call.type === "frigate_max/v2/vod/prepare" && call.camera === frigateCamera) ||
    (call.type === "auth/sign_path" && call.path.includes(`/${frigateCamera}/`)))
    .map(call => call.type === "auth/sign_path" ? `sign:${call.path}` : `prepare:${call.target}`);
}


export const INITIAL_ACQUISITION_FAILURES = [
  { name: "generic preparation rejection", fail: "prepare", expected: "camera_prepare_failed",
    state: "failed", progress: [], error: () => new Error("synthetic preparation failure") },
  { name: "preparation reports no recording", fail: "prepare",
    expected: "prepare_reported_no_recording", state: "unavailable", progress: [],
    error: () => new Error("No recording at requested time.") },
  { name: "signing rejection", fail: "sign", expected: "manifest_sign_failure", state: "failed",
    progress: ["prepareMapped"], error: () => new Error("synthetic sign failure") },
  { name: "no-recording precedence over reached milestones", fail: "sign",
    expected: "prepare_reported_no_recording", state: "unavailable", progress: ["prepareMapped"],
    error: () => new Error("No VOD for this interval.") },
  { name: "explicit failure precedence over no-recording and milestones", fail: "sign",
    expected: "authoritative_recording_gap", state: "unavailable", progress: ["prepareMapped"],
    error: () => Object.assign(new Error("No recording."),
      { rejoinFailure: "authoritative_recording_gap" }) },
  { name: "fatal manifest error", fail: "manifest", expected: "manifest_failure", state: "failed",
    progress: ["prepareMapped", "manifestSigned"] },
  { name: "seekable media timeout", fail: "seekable",
    expected: "seekable_or_media_readiness_failure", state: "failed",
    progress: ["prepareMapped", "manifestSigned", "manifestParsed"] }
];


export async function runInitialAcquisitionFailure(item, mode, autoplay) {
  const target = 1800000000;
  let harness = null;
  const down = () => harness.controller._historicalPlayers.get("Drive Down");
  harness = createHistoricalHarness({
    now: () => 1000,
    mediaReadyTimeoutMs: item.fail === "seekable" ? 50 : 15000,
    scheduleInitialDeadline: () => () => {},
    presentationResponder: message => {
      if (message.camera === "drive_down" && item.fail === "prepare") {
        alterAcquisitionHistory(down(), mode);
        return Promise.reject(item.error());
      }
      return Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target));
    }
  });
  try {
    const controller = harness.controller;
    useAcquisitionHistory(controller, mode);
    const transitionsFor = recordCameraTransitions(controller);
    const classifications = recordCameraClassifications(controller, "Drive Down");
    if (item.fail === "sign") {
      const sign = controller.signManifest.bind(controller);
      controller.signManifest = async (player, range) => {
        if (player.camera.name !== "Drive Down") return sign(player, range);
        alterAcquisitionHistory(player, mode);
        throw item.error();
      };
    }
    if (item.fail === "manifest" || item.fail === "seekable") {
      const Base = await controller._loadHls();
      const forDown = video => video.closest(".review-camera-panel")?.dataset.camera === "Drive Down";
      controller._loadHls = async () => class extends Base {
        attachMedia(video) {
          super.attachMedia(video);
          if (item.fail === "seekable" && forDown(video)) {
            alterAcquisitionHistory(down(), mode);
            Object.defineProperty(video, "seekable", { configurable: true, value: { length: 0 } });
          }
        }
        loadSource(source) {
          if (item.fail !== "manifest" || !forDown(this.video)) {
            super.loadSource(source);
            return;
          }
          alterAcquisitionHistory(down(), mode);
          for (const handler of this.handlers.get(Base.Events.ERROR) ?? []) {
            handler(Base.Events.ERROR, { fatal: true, type: "networkError",
              details: "manifestLoadError" });
          }
        }
      };
    }
    await controller.playHistorical(target, { autoplay });
    const attempts = transitionsFor("Drive Down");
    const up = controller._historicalPlayers.get("Drive Up");
    return {
      classification: classifications[0] ?? null,
      attempts: attempts.map(attempt => attempt.reason),
      progress: { ...attempts[0].acquisitionProgress },
      cleaned: attempts[0].cleaned === true,
      released: down().hls === null && down().transition === null,
      ledger: controller.getRecentReviewFailures()
        .filter(record => record.camera === "Drive Down")
        .map(record => `${record.reason}:${record.outcome}`),
      commands: acquisitionCommands(harness, "drive_down"),
      downPlays: harness.playCalls.filter(call => call.camera === "Drive Down").length,
      peer: up.lifecycleState,
      peerSeeks: [...up.video.currentTimeWrites],
      clock: controller.clock.absoluteTime,
      running: controller.clock.running,
      playbackRequested: controller.playbackRequested
    };
  } finally {
    harness.close();
  }
}


export const INITIAL_DEADLINE_SCENARIOS = [
  { name: "preparation", stage: "prepare", expected: "initial_preparation_deadline", progress: [],
    options: () => ({ presentationResponder: message => message.camera === "drive_down"
      ? new Promise(() => {})
      : Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target)) }) },
  { name: "pending RVFC landing", stage: "landing", expected: "initial_landing_deadline",
    progress: ["prepareMapped", "manifestSigned", "manifestParsed"],
    options: () => ({ deferredFrame: new Set(["Drive Down"]) }) },
  { name: "seek tolerance before readiness", stage: "seekable",
    expected: "post_seek_playability_failure",
    progress: ["prepareMapped", "manifestSigned", "manifestParsed", "seekToleranceReached"],
    options: () => ({ noRvfc: new Set(["Drive Down"]), deferredPlayable: new Set(["Drive Down"]) }) }
];


export async function runInitialDeadline(scenario, mode, autoplay) {
  const target = 1800000000;
  const deadlines = [];
  const harness = createHistoricalHarness({
    now: () => 1000,
    scheduleInitialDeadline: callback => {
      deadlines.push(callback);
      return () => {};
    },
    ...scenario.options()
  });
  try {
    const controller = harness.controller;
    useAcquisitionHistory(controller, mode);
    const transitionsFor = recordCameraTransitions(controller);
    const classifications = recordCameraClassifications(controller, "Drive Down");
    const down = () => controller._historicalPlayers.get("Drive Down");
    const operation = controller.playHistorical(target, { autoplay });
    await waitForCondition(() => down()?.reviewStage === scenario.stage &&
      (scenario.stage !== "seekable" || down().transition?.acquisitionProgress.seekToleranceReached));
    const attempt = down().transition;
    alterAcquisitionHistory(down(), mode);
    assert.equal(deadlines.length, 1);
    deadlines[0]();
    await operation;
    const settled = { state: down().lifecycleState, boundaryReason: down().boundaryReason };
    // Late media completions after deadline cleanup must not change the outcome.
    const control = harness.mediaControls.find(entry => entry.camera === "Drive Down");
    control?.makePlayable();
    control?.emitFrame();
    await new Promise(resolve => setTimeout(resolve, 0));
    const up = controller._historicalPlayers.get("Drive Up");
    return {
      classification: classifications[0] ?? null,
      lateOutcomeUnchanged: down().lifecycleState === settled.state &&
        down().boundaryReason === settled.boundaryReason,
      attempts: transitionsFor("Drive Down").map(entry => entry.reason),
      attemptOwned: transitionsFor("Drive Down")[0] === attempt,
      progress: { ...attempt.acquisitionProgress },
      cleaned: attempt.cleaned === true,
      timedOut: down().initialTimedOut === true,
      released: down().hls === null && down().transition === null,
      commands: acquisitionCommands(harness, "drive_down"),
      downPlays: harness.playCalls.filter(call => call.camera === "Drive Down").length,
      peer: up.lifecycleState,
      peerSeeks: [...up.video.currentTimeWrites],
      clock: controller.clock.absoluteTime,
      running: controller.clock.running,
      playbackRequested: controller.playbackRequested
    };
  } finally {
    harness.close();
  }
}


export async function flushManifestMicrotasksUntil(predicate) {
  for (let index = 0; index < 200 && !predicate(); index += 1) await Promise.resolve();
  assert.ok(predicate(), "controlled manifest work must reach the expected phase");
}


export async function createManifestIsolationHarness(debug, throwDiagnostic) {
  const harness = createHistoricalHarness({
    debug, now: () => 1000, deferredFrame: new Set(["Drive Up"]),
    scheduleInitialDeadline: () => () => {}
  });
  const controller = harness.controller;
  controller.setSelectedCameraNames(["Drive Up"]);
  const commands = [];
  const lifecycles = [];
  const manifests = [];
  const transitionsFor = recordCameraTransitions(controller);
  const setLifecycle = controller.setCameraLifecycle.bind(controller);
  controller.setCameraLifecycle = (player, state, options) => {
    lifecycles.push([state, options?.boundaryReason ?? null]);
    return setLifecycle(player, state, options);
  };
  const seek = controller.seekHistoricalPlayer.bind(controller);
  controller.seekHistoricalPlayer = (...args) => {
    commands.push("seek");
    return seek(...args);
  };
  const syncStage = controller.syncStage.bind(controller);
  const manifestObservations = [];
  let diagnosticFault = throwDiagnostic;
  controller.syncStage = (report, generation, player, stage) => {
    if (stage === "manifestParsedMs") {
      manifestObservations.push({
        current: controller.isCurrentCameraTransition(player, player.transition),
        parsed: player.transition?.acquisitionProgress.manifestParsed
      });
      if (diagnosticFault) throw new Error("synthetic manifest diagnostic failure");
    }
    return syncStage(report, generation, player, stage);
  };
  const internalExceptions = [];
  const Base = await controller._loadHls();
  controller._loadHls = async () => class extends Base {
    destroy() {
      super.destroy();
      // Match Hls.destroy(): listeners cannot remain active after destruction.
      this.handlers.clear();
    }
    attachMedia(video) {
      commands.push("attach");
      super.attachMedia(video);
      const play = video.play;
      video.play = () => { commands.push("play"); return play(); };
    }
    // Mirrors vendored hls.js 1.7.2 Hls.trigger() (config.debug false): a listener
    // exception stops that event's remaining listeners, is swallowed, and is re-emitted
    // as ERROR/internalException, fatal only when the failing event was ERROR itself.
    dispatch(event, data, listeners = [...(this.handlers.get(event) ?? [])]) {
      try {
        for (const listener of listeners) listener(event, data);
      } catch (error) {
        internalExceptions.push({ event, message: error.message });
        if (this.triggeringException) return;
        this.triggeringException = true;
        this.dispatch(Base.Events.ERROR, { type: "otherError", details: "internalException",
          fatal: event === Base.Events.ERROR, event, error });
        this.triggeringException = false;
      }
    }
    loadSource(source) {
      commands.push("source");
      this.source = source;
      const hls = this;
      manifests.push({
        hls,
        // Captured at load so a superseded attempt's in-flight callback can still be replayed.
        parsed: [...this.handlers.get(Base.Events.MANIFEST_PARSED)],
        emitParsed() {
          commands.push("manifest");
          hls.dispatch(Base.Events.MANIFEST_PARSED, {}, this.parsed);
        },
        emitFatal() {
          hls.dispatch(Base.Events.ERROR, {
            fatal: true, type: "networkError", details: "manifestLoadError"
          });
        }
      });
    }
  };
  return { ...harness, commands, lifecycles, manifests, transitionsFor,
    manifestObservations, internalExceptions, events: Base.Events,
    setDiagnosticFault(value) { diagnosticFault = value; } };
}


export function assertManifestIsolationCleanup(harness, player) {
  assert.equal(player.transition, null);
  assert.deepEqual(player.waitCancellations, []);
  assert.deepEqual(player.hlsListeners, []);
  assert.deepEqual(player.lifecycleListeners, []);
  assert.deepEqual(player.syncListeners, []);
  assert.equal(player.hls, null);
  assert.equal(harness.controller._diagnosticTimer, null);
  for (const hls of harness.instances) {
    assert.equal(hls.destroyCount, 1);
    assert.ok([...hls.handlers.values()].every(handlers => handlers.length === 0));
  }
  for (const media of harness.mediaControls) {
    assert.equal(media.pendingFrameCallbacks().length, 0);
  }
  for (const transition of harness.transitionsFor("Drive Up")) {
    assert.deepEqual(transition.cancellations, []);
  }
}


export async function runManifestIsolationSuccess(debug, autoplay, throwDiagnostic) {
  const harness = await createManifestIsolationHarness(debug, throwDiagnostic);
  const controller = harness.controller;
  const target = 1800000000;
  let operation;
  try {
    operation = controller.playHistorical(target, { autoplay });
    await flushManifestMicrotasksUntil(() => harness.manifests.length === 1);
    const player = controller._historicalPlayers.get("Drive Up");
    const transition = player.transition;
    const manifest = harness.manifests[0];
    assert.equal(transition.acquisitionProgress.manifestParsed, false);
    manifest.emitParsed();
    assert.equal(transition.acquisitionProgress.manifestParsed, true);
    assert.equal(manifest.hls.handlers.get(harness.events.MANIFEST_PARSED).length, 0);
    assert.equal(manifest.hls.handlers.get(harness.events.ERROR).length, 1);
    assert.deepEqual(transition.cancellations, []);
    // hls.js would swallow an escaped diagnostic exception and leave readiness pending,
    // so reaching the mapped seek is the operational proof that the manifest settled.
    await flushManifestMicrotasksUntil(() => player.video.currentTimeWrites.length === 1);
    const media = harness.mediaControls[0];
    assert.equal(media.pendingFrameCallbacks().length, 1);
    media.emitFrame();
    await operation;
    assert.equal(controller._historicalPreparing, false);
    assert.equal(player.lifecycleState, "participating");
    assert.equal(player.initialPlacement.verifiedFrame, true);
    assert.equal(player.initialPlacement.landedEpoch, target);
    assert.equal(player.requestId, controller._reviewRequestId);
    assert.equal(player.generation, controller._generation);
    assert.equal(controller.isCurrentCameraWork(player), true);
    assert.deepEqual(player.video.currentTimeWrites, [21]);
    assert.equal(controller.clock.absoluteTime, target);
    assert.equal(controller.clock.running, autoplay);
    assert.equal(controller.playbackRequested, autoplay);
    assert.equal(player.video.paused, !autoplay);
    assert.deepEqual(controller.getRecentReviewFailures(), []);
    assert.deepEqual(harness.internalExceptions, []);
    assert.deepEqual(harness.manifestObservations, [{ current: true, parsed: true }]);
    const report = controller.getLatestHistoricalSyncReport();
    if (debug) {
      assert.equal(report.cameras["Drive Up"].stages.manifestParsedMs,
        throwDiagnostic ? undefined : 1000);
    } else assert.equal(report, null);
    const result = {
      commands: harness.commands, lifecycles: harness.lifecycles,
      acquisition: acquisitionCommands(harness, "drive_up"),
      progress: { ...transition.acquisitionProgress },
      placement: { ...player.initialPlacement },
      clock: controller.clock.absoluteTime, requested: controller.playbackRequested,
      reviewPlay: player.reviewPlay, requestId: player.requestId,
      cameraWorkId: player.cameraWorkId, presentationId: player.presentationId
    };
    controller.returnToLive();
    assertManifestIsolationCleanup(harness, player);
    return result;
  } finally {
    harness.close();
    await operation;
  }
}


// Rejoin and continuation acquire without the initial-acquisition deadline, so a
// manifest that never settles would strand the camera in "preparing" indefinitely.
export async function runManifestIsolationRejoin(debug, autoplay, throwDiagnostic) {
  const harness = await createManifestIsolationHarness(debug, false);
  const controller = harness.controller;
  const target = 1800000000;
  let initial, join;
  try {
    initial = controller.playHistorical(target, { autoplay });
    await flushManifestMicrotasksUntil(() => harness.manifests.length === 1);
    harness.manifests[0].emitParsed();
    const player = controller._historicalPlayers.get("Drive Up");
    await flushManifestMicrotasksUntil(() => player.video.currentTimeWrites.length === 1);
    harness.mediaControls[0].emitFrame();
    await initial;
    assert.equal(player.lifecycleState, "participating");
    controller.leaveHistoricalCamera(player, "authoritative_recording_gap", target, target);
    assert.equal(player.lifecycleState, "unavailable");
    assert.equal(player.hls, null);
    harness.setDiagnosticFault(throwDiagnostic);
    join = controller.evaluateHistoricalAvailability(null, { reason: "manifest_rejoin" });
    await flushManifestMicrotasksUntil(() => harness.manifests.length === 2);
    const transition = player.transition;
    assert.equal(transition.reason, "availability_entry");
    assert.equal(controller._initialDeadlineCancel, null);
    assert.equal(transition.acquisitionProgress.manifestParsed, false);
    harness.manifests[1].emitParsed();
    assert.equal(transition.acquisitionProgress.manifestParsed, true);
    // Only manifest settlement can lead to the rejoin's mapped seek.
    await flushManifestMicrotasksUntil(() => player.video.currentTimeWrites.length === 1);
    const media = harness.mediaControls.at(-1);
    await flushManifestMicrotasksUntil(() => media.pendingFrameCallbacks().length === 1);
    media.emitFrame();
    const [outcome] = await join;
    assert.deepEqual(outcome, { camera: "Drive Up", result: "prepared" });
    assert.equal(player.lifecycleState, "participating");
    assert.equal(player.transition, null);
    assert.equal(player.initialPlacement.verifiedFrame, true);
    assert.equal(player.initialPlacement.landedEpoch, target);
    assert.equal(controller.clock.absoluteTime, target);
    assert.equal(controller.clock.running, autoplay);
    assert.equal(controller.playbackRequested, autoplay);
    assert.equal(player.video.paused, !autoplay);
    assert.deepEqual(harness.internalExceptions, []);
    assert.deepEqual(harness.manifestObservations.at(-1), { current: true, parsed: true });
    const result = {
      commands: harness.commands, lifecycles: harness.lifecycles,
      acquisition: acquisitionCommands(harness, "drive_up"),
      attempts: harness.transitionsFor("Drive Up").map(attempt => attempt.reason),
      progress: { ...transition.acquisitionProgress },
      placement: { ...player.initialPlacement },
      seeks: [...player.video.currentTimeWrites],
      ledger: controller.getRecentReviewFailures().map(record => `${record.reason}:${record.outcome}`),
      clock: controller.clock.absoluteTime, requested: controller.playbackRequested,
      reviewPlay: player.reviewPlay, requestId: player.requestId,
      cameraWorkId: player.cameraWorkId, presentationId: player.presentationId
    };
    controller.returnToLive();
    assertManifestIsolationCleanup(harness, player);
    return result;
  } finally {
    harness.close();
    await Promise.allSettled([initial, join]);
  }
}


export async function createContinuationFailureExperiment(t, {
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


// Review timeline recording gaps. Windows are aligned to absolute 2 h epochs and
// GAP_BASE is a multiple of 7200, so [base - 7200, base) and [base, base + 7200).
export const GAP_BASE = 1800000000;

export const GAP_WHEN = { from: GAP_BASE - 7200, to: GAP_BASE + 7200 };


export function createGapHarness(options = {}) {
  return createHistoricalHarness({
    wallClockMs: (GAP_BASE + 4 * 3600) * 1000,
    initialReviewRange: GAP_WHEN,
    ...options
  });
}


export function settleCoverage() {
  return new Promise(resolve => setImmediate(resolve));
}


export function timelineGaps(harness, camera) {
  return [...harness.root.querySelectorAll(
    `.review-timeline-lane[data-camera-id="${camera}"] .review-timeline-marker-gap`
  )].map(element => ({
    start: Number(element.dataset.startEpoch),
    end: Number(element.dataset.endEpoch),
    style: element.getAttribute("style")
  }));
}


export function gapRanges(harness, camera) {
  return timelineGaps(harness, camera).map(gap => [gap.start, gap.end]);
}


export function coverageCalls(harness) {
  return harness.calls.filter(call => call.type === "frigate_max/v1/recordings/availability");
}


export function assertGapGeometry(gap, top, height) {
  const percent = pattern => Number(gap.style.match(pattern)?.[1]);
  assert.ok(Math.abs(percent(/top:min\(([\d.]+)%/) - top * 100) < 1e-9, gap.style);
  assert.ok(Math.abs(percent(/height:max\(([\d.]+)%/) - height * 100) < 1e-9, gap.style);
}


// Characterization of the existing clock/coverage separation that Skip Recording
// Gaps will build on. These pin current behavior; they are not new behavior.
export const UNRECORDED_TARGET = Date.parse("2026-09-10T09:00:00-07:00") / 1000;


export function unrecordedGapCoverage(target = UNRECORDED_TARGET) {
  const intervals = [{ start: target - 30, end: target + 5 },
    { start: target + 20, end: target + 100 }];
  return recordingCoverageResponder({ drive_up: intervals, drive_down: intervals });
}


// Autoplay seeks advance independently of coverage; legacy opt-in callers behave identically.
export const FAR_GAP = UNRECORDED_TARGET + 5000;


export function createUnrecordedSeekHarness(t, { tick, coverage = null, onRequest = null } = {}) {
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



export function createReadinessHarness(t, options = {}) {
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


export const SKIP_BASE = 1800000000;


export async function captureRecordingSkipEvaluation(h) {
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


export async function createRecordingSkipHarness(t, {
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


export async function driveRecordingSkip(h, slices = 10) {
  for (let index = 0; index < slices; index += 1) {
    if (h.controller.evaluateRecordingGapSkip()) return true;
    await settleCoverage();
  }
  return false;
}


// R-14/R-13/R-15 Phase 1: bounded frame landing and one camera-owned recovery policy.
// Every media-readiness wait, frame landing included, shares one distinctive bound so the
// controlled view timers below can identify it. The existing 500 ms heartbeat and all
// view timeouts are captured and driven by hand; no assertion depends on wall time.
export const RECOVERY_TIMEOUT_MS = 4321;

export const RECOVERY_T = 1800000000;

export const RECOVERY_FULL_RUN = [{ start: RECOVERY_T - 7200, end: RECOVERY_T + 7200 }];

export const RECOVERY_FULL_COVERAGE = { drive_up: RECOVERY_FULL_RUN, drive_down: RECOVERY_FULL_RUN };

export const RECOVERY_REJOIN_COVERAGE = {
  drive_up: RECOVERY_FULL_RUN,
  drive_down: [{ start: RECOVERY_T + 5, end: RECOVERY_T + 7200 }]
};


export function manualViewTimers(window) {
  const timeouts = [];
  const intervals = [];
  let sequence = 0;
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  window.setTimeout = (callback, delay = 0, ...args) => {
    const job = { id: `view-timeout-${++sequence}`, callback, delay, args, active: true };
    timeouts.push(job);
    return job.id;
  };
  window.clearTimeout = id => {
    const job = timeouts.find(candidate => candidate.id === id);
    if (job) job.active = false;
    else nativeClearTimeout(id);
  };
  window.setInterval = (callback, delay = 0) => {
    const job = { id: `view-interval-${++sequence}`, callback, delay, active: true };
    intervals.push(job);
    return job.id;
  };
  window.clearInterval = id => {
    const job = intervals.find(candidate => candidate.id === id);
    if (job) job.active = false;
    else nativeClearInterval(id);
  };
  return {
    pending: (delay = null) => timeouts.filter(job =>
      job.active && (delay === null || job.delay === delay)),
    fire(job) {
      assert.ok(job?.active, "only an active view timeout can fire");
      job.active = false;
      job.callback(...job.args);
    },
    heartbeat() {
      const job = intervals.findLast(candidate => candidate.active && candidate.delay === 500);
      assert.ok(job, "the Review heartbeat must be active");
      job.callback();
    },
    heartbeatActive: () => intervals.some(job => job.active)
  };
}


export async function drainReview(controller) {
  for (let index = 0; index < 6; index += 1) {
    await controller._availabilityEvaluationPromise;
    await new Promise(resolve => setImmediate(resolve));
  }
}


export async function createRecoveryScene(t, {
  coverage = RECOVERY_REJOIN_COVERAGE, availabilityResponder = null, autoplay = true,
  debug = false, deferredFrame = new Set(), frameOffsetByCamera = new Map(),
  presentationResponder = null, playResponder = null, scheduleInitialDeadline = null,
  preparationTimeoutMs = 0, awaitInitial = true, recordingCoverage = false,
  mediaReadyTimeoutMs = RECOVERY_TIMEOUT_MS, harnessOptions = {}
} = {}) {
  const time = { ms: 1000 };
  const harness = createHistoricalHarness({
    now: () => time.ms, mediaReadyTimeoutMs, debug, recordingCoverage,
    availabilityResponder: availabilityResponder ?? recordingCoverageResponder(coverage),
    deferredFrame, frameOffsetByCamera, presentationResponder, playResponder,
    scheduleInitialDeadline, preparationTimeoutMs, ...harnessOptions
  });
  t.after(() => harness.close());
  const timers = manualViewTimers(harness.window);
  const controller = harness.controller;
  const scene = {
    harness, controller, timers, time, deferredFrame,
    // Cameras named here stop presenting frames; every other playing camera presents
    // one per heartbeat, as healthy playback does.
    stalled: new Set(),
    player: name => controller._historicalPlayers.get(name),
    media: name => harness.mediaControls.findLast(control => control.camera === name),
    prepares: camera => harness.calls.filter(call =>
      call.type === "frigate_max/v2/vod/prepare" && call.camera === camera),
    plays: name => harness.playCalls.filter(call => call.camera === name).length,
    advance(ms) { time.ms += ms; },
    presentFrames() {
      for (const player of controller._historicalPlayers.values()) {
        if (player.lifecycleState !== "participating" || player.transition ||
            player.video?.paused !== false || scene.stalled.has(player.camera.name)) continue;
        scene.media(player.camera.name)?.emitFrame();
      }
    },
    async tick() {
      scene.presentFrames();
      timers.heartbeat();
      await drainReview(controller);
    },
    landingDeadline(name) {
      const player = controller._historicalPlayers.get(name);
      assert.equal(player.reviewStage, "landing", `${name} must be waiting for frame landing`);
      const pending = timers.pending(RECOVERY_TIMEOUT_MS);
      assert.equal(pending.length, 1, `${name}'s landing attempt must own exactly one deadline`);
      return pending[0];
    },
    // Captures a healthy peer; the returned check proves nothing reacquired or disturbed it.
    peer(name = "Drive Up") {
      const player = controller._historicalPlayers.get(name);
      const before = { hls: player.hls, seeks: player.video.currentTimeWrites.length,
        pauses: player.video.pauseCount, plays: scene.plays(name), paused: player.video.paused };
      return () => {
        assert.equal(player.lifecycleState, "participating");
        assert.ok(player.hls === before.hls, `${name} keeps its presentation`);
        assert.equal(player.video.currentTimeWrites.length, before.seeks, `${name} is not reseeked`);
        assert.equal(player.video.pauseCount, before.pauses, `${name} is not paused`);
        assert.equal(scene.plays(name), before.plays, `${name} receives no extra Play`);
        assert.equal(player.video.paused, before.paused);
      };
    }
  };
  scene.run = controller.playHistorical(RECOVERY_T, { autoplay });
  if (awaitInitial) await scene.run;
  return scene;
}


// Drive Down enters coverage at T + 5; the heartbeat starts its rejoin with frames withheld.
export async function rejoinIntoLanding(scene, seconds = 6) {
  scene.deferredFrame.add("Drive Down");
  scene.advance(seconds * 1000);
  scene.timers.heartbeat();
  const down = scene.player("Drive Down");
  await waitForCondition(() => down.reviewStage === "landing" && down.lifecycleState === "preparing",
    "Drive Down must reach frame landing");
  return down;
}


export async function failRejoinLanding(scene) {
  const down = await rejoinIntoLanding(scene);
  scene.timers.fire(scene.landingDeadline("Drive Down"));
  await waitForCondition(() => down.lifecycleState === "failed", "the landing attempt must settle");
  return down;
}


export const rejectPlayFor = (camera, rejecting) => name => name === camera && rejecting()
  ? Promise.reject(new Error("synthetic Play rejection")) : Promise.resolve();


// R-13 Phase 2: frame-observer continuity, fatal media errors, silent stalls,
// outage-tolerant recovery and healthy-progress reset. Scenes reuse the Phase 1 recovery
// scene: controlled heartbeat and view timers, healthy cameras presenting one frame per
// heartbeat, and the stall bound taken from the scene's media-readiness timeout.
export const STALL_MS = 15000;


export function emitHlsError(player, data) {
  for (const handler of [...(player.hls.handlers.get(player.hls.constructor.Events.ERROR) ?? [])]) {
    handler("error", data);
  }
}


export function emitMediaError(scene, player, code) {
  Object.defineProperty(player.video, "error", {
    configurable: true, value: code === null ? null : { code }
  });
  player.video.dispatchEvent(new scene.harness.window.Event("error"));
}


export async function playFor(scene, ms, step = 500) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    scene.advance(step);
    await scene.tick();
  }
}


export async function expectPlaying(scene, name, message) {
  const player = scene.player(name);
  await waitForCondition(() => player.lifecycleState === "participating" &&
    player.video.paused === false, message);
  return player;
}


// Recovery after the 1 s first-attempt backoff, at the then-current Review time.
export async function expectRecoveryAtReviewTime(scene, name) {
  const player = scene.player(name);
  const camera = name === "Drive Up" ? "drive_up" : "drive_down";
  const prepares = scene.prepares(camera).length;
  scene.advance(999);
  await scene.tick();
  assert.equal(scene.prepares(camera).length, prepares, "the backoff holds the rebuild");
  scene.advance(1);
  await scene.tick();
  await expectPlaying(scene, name, `${name} must recover`);
  const reviewTime = scene.controller.clock.absoluteTime;
  assert.equal(scene.prepares(camera).at(-1).target, reviewTime, "rebuilt at current Review time");
  assert.equal(player.initialPlacement.landedEpoch, reviewTime);
}


export async function observerEvidence(scene, name) {
  const player = scene.player(name);
  const media = scene.media(name);
  const armed = media.pendingFrameCallbacks().length;
  scene.advance(1);
  const before = player.latestPresentedFrameAtMs;
  media.emitFrame();
  return { participating: player.lifecycleState === "participating", armed,
    recorded: player.latestPresentedFrameAtMs !== before };
}


export const PHASE2_TIMELINE = {
  wallClockMs: (RECOVERY_T + 3600) * 1000,
  initialReviewRange: { from: RECOVERY_T - 100, to: RECOVERY_T + 500 }
};


export const OBSERVER_ENTRY_PATHS = {
  "initial autoplay": async t => [await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE }), "Drive Up"],
  "initial paused, then Resume": async t => {
    const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE, autoplay: false });
    scene.controller.resumePlayback();
    await drainReview(scene.controller);
    return [scene, "Drive Up"];
  },
  "Pause, then Resume": async t => {
    const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
    scene.controller.pausePlayback();
    scene.controller.resumePlayback();
    await drainReview(scene.controller);
    return [scene, "Drive Up"];
  },
  "gap rejoin": async t => {
    const scene = await createRecoveryScene(t);
    scene.advance(6000);
    scene.timers.heartbeat();
    await expectPlaying(scene, "Drive Down", "the rejoin must complete");
    return [scene, "Drive Down"];
  },
  "VOD continuation": async t => {
    const counts = new Map();
    const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE,
      presentationResponder: message => {
        const count = (counts.get(message.camera) ?? 0) + 1;
        counts.set(message.camera, count);
        const end = message.camera === "drive_up" && count === 1 ? RECOVERY_T + 20 : message.target + 120;
        return Promise.resolve(presentationPrepared(message.camera, message.target - 21, message.target, end));
      } });
    const up = scene.player("Drive Up");
    scene.advance(20000);
    up.video.currentTime = up.timing.logical_media_end_position;
    scene.timers.heartbeat();
    await waitForCondition(() => scene.prepares("drive_up").length === 2 && up.lifecycleState === "participating");
    return [scene, "Drive Up"];
  },
  "Phase 1 recovery": async t => {
    let rejecting = true;
    const scene = await createRecoveryScene(t, { playResponder: rejectPlayFor("Drive Down", () => rejecting) });
    scene.advance(6000);
    scene.timers.heartbeat();
    await waitForCondition(() => scene.player("Drive Down").lifecycleState === "failed");
    rejecting = false;
    scene.advance(1000);
    scene.timers.heartbeat();
    await expectPlaying(scene, "Drive Down", "the recovery must complete");
    return [scene, "Drive Down"];
  },
  "±10 reusing the presentation": async t => {
    const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE });
    assert.equal(await scene.controller.seekHistoricalRelative(10), true);
    return [scene, "Drive Up"];
  },
  "±10 into a new presentation": async t => {
    const scene = await createRecoveryScene(t);
    assert.equal(await scene.controller.seekHistoricalRelative(30), true);
    return [scene, "Drive Down"];
  },
  "timeline navigation into a new presentation": async t => {
    const scene = await createRecoveryScene(t, { harnessOptions: PHASE2_TIMELINE });
    assert.equal(await scene.controller.selectTimelineTime(RECOVERY_T + 30), true);
    return [scene, "Drive Down"];
  },
  "Auto Snap navigation into a new presentation": async t => {
    const scene = await createRecoveryScene(t);
    const { controller } = scene;
    assert.equal(controller.seekAutoSnapInterval({ start: RECOVERY_T + 30, end: RECOVERY_T + 60 },
      RECOVERY_T + 30, controller._autoSnapDecisionToken, controller.clock.absoluteTime), true);
    await waitForCondition(() => !controller._historicalPreparing &&
      scene.player("Drive Down").lifecycleState === "participating");
    return [scene, "Drive Down"];
  },
  "Skip Deadspace navigation into a new presentation": async t => {
    const scene = await createRecoveryScene(t);
    assert.equal(await scene.controller.seekHistoricalToEpoch(RECOVERY_T + 30,
      { autoplay: true, source: "recording gap skip" }), true);
    return [scene, "Drive Down"];
  }
};


export const FATAL_FAILURES = {
  "fatal hls network error": (scene, player) => emitHlsError(player,
    { fatal: true, type: "networkError", details: "fragLoadError" }),
  "fatal hls decode error": (scene, player) => emitHlsError(player,
    { fatal: true, type: "mediaError", details: "bufferAppendError" }),
  "fatal hls stall after nudges": (scene, player) => emitHlsError(player,
    { fatal: true, type: "mediaError", details: "bufferStalledError" }),
  "video network error (2)": (scene, player) => emitMediaError(scene, player, 2),
  "video decode error (3)": (scene, player) => emitMediaError(scene, player, 3),
  "video unsupported source (4)": (scene, player) => emitMediaError(scene, player, 4)
};


export const OBSERVATIONAL_ERRORS = {
  "nonfatal hls fragment error": (scene, player) => emitHlsError(player,
    { fatal: false, type: "networkError", details: "fragLoadError" }),
  "nonfatal hls buffer stall": (scene, player) => emitHlsError(player,
    { fatal: false, type: "mediaError", details: "bufferStalledError" }),
  "video aborted (1)": (scene, player) => emitMediaError(scene, player, 1),
  "video error without a code": (scene, player) => emitMediaError(scene, player, null)
};


// R-20: optional diagnostic recorders observe playback; a recorder that throws can never
// stop an operational transition, strand a camera, move the ReviewClock or end the
// heartbeat. Every recorder is replaced with one that throws, with diagnostics off and on.
export const R20_RECORDERS = [
  "recordReviewFailure", "recordCameraBoundary", "recordSceneEvent", "recordIdentityEvent",
  "syncCamera", "syncStage", "syncUnavailable", "syncTick", "syncSnapshot", "updateSyncSummary",
  "startSyncReport", "endSyncReport", "recordAutoSnapDecision", "captureAutoSnapBoundary",
  "completeAutoSnapBoundaryCapture", "settleAutoSnapBoundaryCapture",
  "updateAvailabilityDiagnostic", "recordReviewNavigation"
];


export function injectRecorderFaults(controller) {
  const thrown = new Set();
  for (const name of R20_RECORDERS) {
    controller[name] = () => {
      thrown.add(name);
      throw new Error(`synthetic ${name} failure`);
    };
  }
  return thrown;
}


// Heartbeats must keep running: a throw escaping a tick fails the test here.
export async function heartbeatFor(scene, ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 500) {
    scene.advance(500);
    await scene.tick();
  }
}


// R-12/R-25: one recording-coverage authority. Frigate publishes finished segments up to
// wall-clock now - 10 s; coverage is known only inside a successfully queried window that
// ends at least 90 s before now; anything else is unknown, never a gap.
export function publishedCoverage(published, runsByCamera) {
  return message => {
    const limit = Math.min(message.end, published.s);
    const coverage = (runsByCamera[message.camera] ?? []).map(run => ({
      start: Math.max(run.start, message.start), end: Math.min(run.end, limit)
    })).filter(run => run.start < run.end);
    return Promise.resolve({ camera: message.camera, requested_start: message.start,
      requested_end: message.end, coverage });
  };
}


export const availabilityCalls = (harness, camera) => harness.calls.filter(call =>
  call.type === "frigate_max/v1/recordings/availability" && call.camera === camera);


export const falseGaps = controller => controller.getRecentReviewFailures()
  .filter(record => record.reason === "authoritative_recording_gap");


// Wall time and the media of every playing camera advance with Review time at 1x.
export async function playLive(scene, wall, ms, published = null) {
  for (let elapsed = 0; elapsed < ms; elapsed += 500) {
    scene.advance(500);
    wall.s += 0.5;
    if (published) published.s = wall.s - 10;
    for (const player of scene.controller._historicalPlayers.values()) {
      if (player.lifecycleState === "participating" && player.video?.paused === false) {
        player.video.currentTime += 0.5;
      }
    }
    await scene.tick();
  }
}


export function liveEdgeScene(t, { wallStart, runs, presentationResponder = null, recordingCoverage = false,
  published = null }) {
  const wall = { s: wallStart };
  const tail = published ?? { s: wallStart - 10 };
  return createRecoveryScene(t, {
    availabilityResponder: publishedCoverage(tail, { drive_up: runs, drive_down: runs }),
    presentationResponder: presentationResponder ?? (message => Promise.resolve(presentationPrepared(
      message.camera, message.target - 21, message.target, message.target + 3600))),
    recordingCoverage,
    harnessOptions: { wallClockMs: () => wall.s * 1000 }
  }).then(scene => ({ scene, wall, published: tail }));
}


export const R12_RUN = [{ start: RECOVERY_T - 7200, end: RECOVERY_T + 7200 }];


// Short-event hold: Auto Snap can leave a one-second event before the frame observer
// records any frame. The only frame that presentation put on screen is its verified
// landing, which is still displayed; the cell holds it instead of going black.
export const SHORT_T = 1800000000;


export async function shortAutoSnapScene(t, { next = 1000, nextCamera = "drive_up", upRuns = null,
  wallS = SHORT_T + 4 * 7200, noRvfc = new Set() } = {}) {
  const T = SHORT_T;
  const time = { ms: 1000 };
  const wall = { s: wallS };
  const when = { from: T - 100, to: T + 9000 };
  const deferredFrame = new Set();
  const harness = createHistoricalHarness({ now: () => time.ms, wallClockMs: () => wall.s * 1000,
    initialReviewRange: when, recordingCoverage: false, deferredFrame, noRvfc,
    availabilityResponder: recordingCoverageResponder({
      drive_up: upRuns ?? [{ start: T - 7200, end: T + 4 * 7200 }],
      drive_down: [{ start: T - 7200, end: T + 4 * 7200 }] }),
    reviewEvents: [{ camera_id: "drive_up", start_time: T + 100, end_time: T + 101 },
      { camera_id: nextCamera, start_time: T + next, end_time: T + next + 5 }] });
  t.after(() => harness.close());
  harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  const c = harness.controller;
  const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(r => setImmediate(r)); };
  await c.refreshReviewQuery();
  c.setPlaybackSpeed(8);
  await c.playHistorical(T + 50, { autoplay: false, updateDisplayedRange: false, playbackRange: when });
  const up = c._historicalPlayers.get("Drive Up");
  const media = () => harness.mediaControls.findLast(control => control.camera === "Drive Up");
  // Ordinary playback before the event presents (and captures) a frame at T + 50.
  c.resumePlayback(); await new Promise(r => setImmediate(r)); c.pausePlayback();
  if (!noRvfc.has("Drive Up")) media().emitFrame();
  const earlierFrame = up.heldFrameEpoch;
  // Auto Snap seeks the same presentation to the short event and verifies its landing.
  c.setAutoSnapTo(true);
  c.resumePlayback();
  await settle();
  const eventHls = up.hls;
  return { T, c, harness, up, media, time, wall, deferredFrame, settle, earlierFrame, eventHls,
    // Past the one-second event at 8x, before any frame of it is observed: Auto Snap moves on.
    async leaveEvent() {
      deferredFrame.add("Drive Up");
      deferredFrame.add("Drive Down");
      time.ms += 200;
      c.enforceAutoSnapBoundary();
      await settle();
    }
  };
}


export const heldFrame = player => player.heldCanvas?.hidden === false ? player.heldFrameEpoch : null;


// Review Blackboard: an observational flight recorder. These scenarios drive real Review
// playback and read only the Blackboard's report and aggregates; none asserts playback
// through the Blackboard.
export const board = scene => scene.controller._blackboard;

export const bbReport = scene => scene.controller.getBlackboardReport();

export const bbCamera = (scene, name) => board(scene).session.cameras.get(name);

export const bbLine = (report, prefix) => report.split("\n").find(line => line.startsWith(prefix)) ?? "";

// Wall time in one accounting cell; clock "any" sums clock-running and clock-stopped time.
export const bbState = (scene, name, coverage, state, clock = "any") => {
  const record = bbCamera(scene, name);
  const cell = index => record.matrix[(index * BLACKBOARD_COVERAGE.length +
    BLACKBOARD_COVERAGE.indexOf(coverage)) * BLACKBOARD_STATES.length + BLACKBOARD_STATES.indexOf(state)];
  return clock === "any" ? cell(0) + cell(1) : cell(BLACKBOARD_CLOCK.indexOf(clock));
};

// A camera's verdict block: headline, steady playback and short events.
export const bbVerdict = (report, name) => {
  const lines = report.split("\n");
  const start = lines.findIndex(line => line.startsWith(`- ${name}: `));
  return start < 0 ? "" : lines.slice(start, start + 3).join("\n");
};


// Emulated time travel into a gap (as setReviewTi): an intended jump, not a discontinuity.
export function bbSetReviewTi(controller, epoch) {
  setReviewTi(controller, epoch);
  controller.observe("test", recorder => recorder.clockJump());
}


export const bbCameraBlock = (report, name) => {
  const lines = report.split("\n");
  const cameras = lines.indexOf("== CAMERAS ==");
  const start = lines.findIndex((line, index) => index > cameras && line.startsWith(`${name}: `));
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length && lines[index].startsWith("  "); index += 1) {
    block.push(lines[index]);
  }
  return block.join("\n");
};


// Playing cameras advance their media with Review time and present frames, except those
// named frozen (nothing moves) or mediaOnly (media moves, no presented-frame callbacks).
export async function bbPlay(scene, ms, { frozen = [], mediaOnly = [], step = 500 } = {}) {
  const { controller } = scene;
  scene.stalled.clear();
  for (const name of [...frozen, ...mediaOnly]) scene.stalled.add(name);
  for (const name of scene.bbMediaOnly ?? []) {
    if (!mediaOnly.includes(name)) scene.deferredFrame.delete(name);
  }
  scene.bbMediaOnly = new Set(mediaOnly);
  for (const name of mediaOnly) scene.deferredFrame.add(name);
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    scene.advance(step);
    for (const player of controller._historicalPlayers.values()) {
      if (player.lifecycleState !== "participating" || player.video?.paused !== false ||
          frozen.includes(player.camera.name)) continue;
      player.video.currentTime += step / 1000 * controller.clock.rate;
    }
    await scene.tick();
  }
}


export const BLACKBOARD_METHODS = Object.getOwnPropertyNames(ReviewBlackboard.prototype)
  .filter(name => name !== "constructor");


export function throwingBlackboard(controller) {
  const instance = controller._blackboard;
  for (const name of BLACKBOARD_METHODS) {
    instance[name] = () => { throw new Error(`synthetic Blackboard ${name} failure`); };
  }
  return instance;
}


// Operational trace of one scenario: healthy playback, a fatal error, recovery, a manual
// seek and a Pause. It must be identical with the Blackboard enabled, disabled or throwing.
export async function operationalTrace(t, mode) {
  const scene = await createRecoveryScene(t, { coverage: RECOVERY_FULL_COVERAGE,
    harnessOptions: { blackboard: mode !== "disabled" } });
  const { controller, harness } = scene;
  if (mode === "throwing") throwingBlackboard(controller);
  else if (mode === "enabled") assert.ok(controller._blackboard);
  else assert.equal(controller._blackboard, null);
  const trace = [];
  const snap = label => trace.push([label, controller.clock.absoluteTime, controller.clock.running,
    ...[...controller._historicalPlayers.values()].flatMap(player => [player.lifecycleState,
      player.boundaryReason, harness.instances.indexOf(player.hls), player.video?.currentTime ?? null,
      player.continuationRecovery?.attempts ?? 0]),
    harness.playCalls.length, harness.calls.length]);
  for (let index = 0; index < 6; index += 1) {
    await bbPlay(scene, 500);
    snap(`play ${index}`);
  }
  emitHlsError(scene.player("Drive Up"), { fatal: true, type: "mediaError", details: "bufferAppendError" });
  await Promise.resolve();
  snap("failed");
  for (let index = 0; index < 8; index += 1) {
    await bbPlay(scene, 500);
    await drainReview(controller);
    snap(`recover ${index}`);
  }
  assert.equal(await controller.seekHistoricalToEpoch(RECOVERY_T + 900, { autoplay: true }), true);
  snap("seek");
  for (let index = 0; index < 4; index += 1) {
    await bbPlay(scene, 500);
    snap(`after seek ${index}`);
  }
  controller.pausePlayback();
  snap("paused");
  return trace;
}


// R-09 short events through the real Auto Snap path, with the heartbeat under test control.
export async function blackboardAutoSnapScene(t, { eventSeconds = 1, next = 1000, harnessOptions = {} } = {}) {
  const T = SHORT_T;
  const time = { ms: 1000 };
  const when = { from: T - 100, to: T + 9000 };
  const deferredFrame = new Set();
  const harness = createHistoricalHarness({ now: () => time.ms, wallClockMs: (T + 4 * 7200) * 1000,
    initialReviewRange: when, recordingCoverage: false, deferredFrame,
    availabilityResponder: recordingCoverageResponder({
      drive_up: [{ start: T - 7200, end: T + 4 * 7200 }],
      drive_down: [{ start: T - 7200, end: T + 4 * 7200 }] }),
    reviewEvents: [{ camera_id: "drive_up", start_time: T + 100, end_time: T + 100 + eventSeconds },
      { camera_id: "drive_up", start_time: T + next, end_time: T + next + 5 }], ...harnessOptions });
  t.after(() => harness.close());
  const timers = manualViewTimers(harness.window);
  harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  const c = harness.controller;
  const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(r => setImmediate(r)); };
  await c.refreshReviewQuery();
  c.setPlaybackSpeed(8);
  await c.playHistorical(T + 50, { autoplay: false, updateDisplayedRange: false, playbackRange: when });
  const media = name => harness.mediaControls.findLast(control => control.camera === name);
  const tick = async ms => {
    time.ms += ms;
    timers.heartbeat();
    await settle();
  };
  c.setAutoSnapTo(true);
  c.resumePlayback();
  await settle();
  await tick(100);
  return { T, c, harness, media, time, deferredFrame, settle, tick, timers,
    async leaveEvent(ms = 200) {
      deferredFrame.add("Drive Up");
      deferredFrame.add("Drive Down");
      time.ms += ms;
      c.enforceAutoSnapBoundary();
      await settle();
      await tick(100);
    } };
}


export const shortEventCounts = (controller, name) => {
  const record = controller._blackboard.session.cameras.get(name);
  const totals = Object.fromEntries(BLACKBOARD_EVENT_CLASSES.map(cls => [cls, 0]));
  record.events.forEach((count, index) => {
    totals[BLACKBOARD_EVENT_CLASSES[index % BLACKBOARD_EVENT_CLASSES.length]] += count;
  });
  return totals;
};
