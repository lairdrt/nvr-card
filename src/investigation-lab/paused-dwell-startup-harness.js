import { AnchoredPairSeamExperiment, ANCHORED_PAIR_SEAM_BUILD } from "./anchored-pair-seam-experiment.js";
import { RvfcFlightRecorder } from "./rvfc-flight-recorder.js";

const CAMERAS = ["drive_up", "drive_down"];
const RUN_MS = 65_000;
const CAPTURE_MS = 65_000;
const MAX_RECORDS = 4_096;
const MAX_AUDIT = 4_096;
const now = () => performance.now();
const number = value => Number.isFinite(value) ? value : null;

export function startupTrialPlan(trialId) {
  if (!["A1", "B1", "A2", "B2"].includes(trialId)) throw new Error("Unknown startup trial.");
  return Object.freeze({ trialId, condition: trialId[0] === "A" ? "prompt" : "long-dwell",
    dwellMs: trialId[0] === "A" ? 0 : 80_000, runMs: RUN_MS,
    captureMs: CAPTURE_MS, maxRecords: MAX_RECORDS });
}

// Release is in the same async continuation as preparation for A trials.
// A contaminated dwell ends without Play and is never retried here.
export async function releaseAfterPreparation(plan, { prepare, release, wait, clock, foreground, contaminated, onReady }) {
  await prepare();
  const readyAt = clock();
  onReady?.(readyAt);
  if (!foreground() || contaminated()) return { status: "contaminated", readyAt, releaseAt: null };
  if (plan.dwellMs) await wait(plan.dwellMs);
  const releaseAt = clock();
  if (!foreground() || contaminated()) return { status: "contaminated", readyAt, releaseAt: null };
  return { status: "released", readyAt, releaseAt, releaseResult: release() };
}

function ranges(value) {
  return Array.from({ length: value.length }, (_, i) => [value.start(i), value.end(i)]);
}

export function waitForInitialSeeks(peers) {
  const settled = () => peers.every(peer => peer.initialWrites === 1 &&
    peer.times.seeked !== undefined && peer.video && !peer.video.seeking);
  if (settled()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      for (const peer of peers) peer.video?.removeEventListener("seeked", check);
    };
    const check = () => { if (settled()) { cleanup(); resolve(); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Initial seek did not settle.")); }, 10_000);
    for (const peer of peers) peer.video?.addEventListener("seeked", check);
    check();
  });
}

function findLabCard() {
  const cards = [];
  let videos = 0;
  function walk(root) {
    videos += root.querySelectorAll("video").length;
    for (const element of root.querySelectorAll("*")) {
      if (element.localName === "investigation-playback-lab" && element._hass?.auth) cards.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  }
  walk(document);
  if (videos || cards.length !== 1 || window.__pausedDwellTrial && !window.__pausedDwellTrial.done) {
    throw new Error("Media isolation or Lab authentication is unavailable.");
  }
  return cards[0];
}

export async function runPausedDwellStartupTrial(prep, expectedBuild, trialId) {
  const plan = startupTrialPlan(trialId);
  if (ANCHORED_PAIR_SEAM_BUILD !== expectedBuild || window.Hls?.version !== "1.7.2") throw new Error("Lab build mismatch.");
  if (!Number.isFinite(prep?.target) || !Number.isFinite(prep?.start) ||
      !Number.isFinite(prep?.end) || prep.target - prep.start < 5 || prep.end - prep.target < 75) {
    throw new Error("Invalid retained source interval.");
  }
  if (document.visibilityState !== "visible" || !document.hasFocus()) throw new Error("Visible focused browser required.");
  const card = findLabCard();
  for (const prior of [window.__pausedDwellTrial, window.__correctedStartup,
    window.__anchoredPairSeam, window.__anchoredSeam]) {
    if (prior?.done && prior.experiment?.destroyed) prior.host?.remove();
  }

  const host = document.createElement("section");
  host.style.cssText = "position:fixed;inset:55px 0 0;background:#111;color:white;z-index:10000;display:flex;flex-direction:column;padding:10px;font:18px sans-serif;gap:8px";
  const title = document.createElement("div"), wall = document.createElement("div"), status = document.createElement("div");
  wall.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:10px;flex:1;min-height:0";
  status.style.cssText = "font:16px monospace;white-space:pre-wrap";
  host.append(title, wall, status); document.body.append(host);
  title.textContent = `${trialId} ${plan.condition}: preparing one mapped seek per camera`;

  let experiment;
  const audit = { cameras: [], visibility: [], focus: [], sources: [], auditOverflow: 0 };
  const state = window.__pausedDwellTrial = {
    trialId, plan, experiment: null, audit, host, done: false, status: "preparing",
    result: null, playReferenceMs: null, readyAt: null, contaminated: false,
    contaminationReasons: []
  };
  const retain = (array, item, cap = 128) => {
    if (array.length < cap) array.push(item); else audit.auditOverflow += 1;
  };
  const mark = reason => {
    state.contaminated = true;
    if (!state.contaminationReasons.includes(reason)) state.contaminationReasons.push(reason);
  };
  const visibility = () => {
    retain(audit.visibility, { at: now(), state: document.visibilityState });
    if (document.visibilityState !== "visible") mark("document-hidden");
  };
  const focus = () => {
    const focused = document.hasFocus();
    retain(audit.focus, { at: now(), focused });
    if (!focused) mark("focus-lost");
  };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("focus", focus); window.addEventListener("blur", focus);
  visibility(); focus();
  const removeListeners = () => {
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("focus", focus); window.removeEventListener("blur", focus);
  };
  const resourceStart = now();

  const createVideo = camera => {
    const cell = document.createElement("div"), label = document.createElement("div"), video = document.createElement("video");
    cell.style.cssText = "display:flex;flex-direction:column;min-height:0";
    label.textContent = camera;
    video.style.cssText = "width:100%;flex:1;min-height:0;object-fit:contain;background:black";
    cell.append(label, video); wall.append(cell);
    const a = { camera, events: [], currentTimeWrites: [], playbackRateWrites: [], srcWrites: [],
      playCalls: [], pauseCalls: [], callbackWork: [], eventOverflow: 0 };
    audit.cameras.push(a);
    const event = (type, extra = {}) => {
      if (a.events.length < 256) a.events.push({ type, at: now(), phase: experiment?.phase ?? "new", ...extra });
      else a.eventOverflow += 1;
    };
    for (const type of ["play", "playing", "seeking", "seeked", "waiting", "stalled", "pause", "ended",
      "ratechange", "error", "loadedmetadata", "loadeddata", "canplay", "canplaythrough", "durationchange"]) {
      video.addEventListener(type, () => event(type));
    }
    for (const property of ["currentTime", "playbackRate", "src"]) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, property);
      Object.defineProperty(video, property, { configurable: true,
        get() { return descriptor.get.call(this); },
        set(value) {
          retain(a[property + "Writes"], { at: now(), phase: experiment?.phase ?? "new",
            destroyed: Boolean(experiment?.destroyed), ...(property === "src" ? {} : { value }) }, 64);
          return descriptor.set.call(this, value);
        } });
    }
    const play = video.play.bind(video), pause = video.pause.bind(video);
    video.play = () => {
      retain(a.playCalls, { at: now(), phase: experiment.phase }, 16); event("Play-invocation");
      const promise = play();
      promise.then(() => event("Play-promise-resolved"), () => event("Play-promise-rejected"));
      return promise;
    };
    video.pause = () => {
      retain(a.pauseCalls, { at: now(), phase: experiment.phase, destroyed: experiment.destroyed }, 16);
      return pause();
    };
    const request = video.requestVideoFrameCallback.bind(video);
    video.requestVideoFrameCallback = callback => request((callbackNow, metadata) => {
      const entry = now(); callback(callbackNow, metadata); const exit = now();
      if (state.playReferenceMs !== null && entry >= state.playReferenceMs &&
          entry < state.playReferenceMs + CAPTURE_MS) {
        retain(a.callbackWork, { entry, exit }, MAX_AUDIT);
      }
    });
    return video;
  };
  class AuditedHls extends window.Hls {
    loadSource(path) {
      retain(audit.sources, { action: "loadSource", camera: path.includes("/drive_up/") ? "drive_up" : "drive_down",
        at: now(), phase: experiment.phase }, 64);
      return super.loadSource(path);
    }
    destroy() {
      retain(audit.sources, { action: "destroy", at: now(), destroyed: experiment.destroyed }, 64);
      return super.destroy();
    }
  }
  for (const camera of CAMERAS) {
    const presentation = prep.preparations?.find(value => value.camera === camera)?.observationPresentation;
    if (presentation?.selected_epoch !== prep.target || !Number.isFinite(presentation?.selected_media_position)) {
      removeListeners(); state.done = true; host.remove();
      throw new Error("Target media mapping is unavailable.");
    }
  }
  experiment = new AnchoredPairSeamExperiment({ ...prep,
    seamMediaTime: prep.preparations[0].observationPresentation.logical_media_end_position,
    Hls: AuditedHls, createVideo, getAuth: () => card._hass.auth, expectedOrigin: location.origin });
  state.experiment = experiment;
  for (const peer of experiment.peers) {
    const presentation = prep.preparations.find(value => value.camera === peer.camera)?.observationPresentation;
    peer.targetMediaTime = presentation.selected_media_position;
  }
  const originalObservation = experiment.onObservation.bind(experiment);
  experiment.onObservation = peer => {
    originalObservation(peer);
    if (experiment.phase === "positioning" && peer.initial && peer.landedObservedAt === undefined) {
      peer.landedObservedAt = now();
    }
  };

  const snapshot = peer => {
    const video = peer.video, quality = video.getVideoPlaybackQuality?.(), buffered = ranges(video.buffered), at = now();
    const containing = buffered.find(([start, end]) => start <= video.currentTime && video.currentTime <= end);
    return { camera: peer.camera, at, requestedT: prep.target, mappedSeekTarget: peer.targetMediaTime,
      anchor: peer.clock?.anchor ?? null, anchorObservedAt: peer.landedObservedAt ?? null,
      landingResidualSeconds: peer.clock ? peer.clock.anchor.absoluteTime - prep.target : null,
      currentTime: number(video.currentTime), readyState: number(video.readyState), networkState: number(video.networkState),
      paused: video.paused, seeking: video.seeking, ended: video.ended, buffered, seekable: ranges(video.seekable),
      bufferedAheadSeconds: containing ? containing[1] - video.currentTime : null,
      playbackRate: number(video.playbackRate), width: number(video.videoWidth), height: number(video.videoHeight),
      quality: { total: number(quality?.totalVideoFrames), dropped: number(quality?.droppedVideoFrames) },
      initialPresentedFrames: peer.initial?.presentedFrames ?? null,
      preparationHoldMs: peer.landedObservedAt === undefined ? null : at - peer.landedObservedAt,
      readyHoldMs: state.readyAt === null ? null : at - state.readyAt,
      hls: { currentLevel: number(peer.hls.currentLevel), loadLevel: number(peer.hls.loadLevel),
        levelCount: peer.hls.levels?.length ?? null, loadingEnabled: peer.hls.loadingEnabled,
        autoLevelEnabled: peer.hls.autoLevelEnabled, mediaOwned: peer.hls.media === video } };
  };
  const healthResources = () => ({ ...experiment.resources,
    activeVideos: experiment.resources.videosCreated - experiment.resources.videosDestroyed,
    activeHls: experiment.resources.hlsCreated - experiment.resources.hlsDestroyed });
  const finish = reason => {
    if (state.done) return;
    state.done = true; state.status = reason ?? "finished";
    if (state.timer) clearTimeout(state.timer);
    const finishedAt = now(); visibility(); focus();
    const traces = experiment.peers.map(peer => peer.rawRecorder?.snapshot() ?? null);
    const report = experiment.peers.every(peer => peer.video) ? experiment.report() : null;
    const end = experiment.peers.filter(peer => peer.video).map(snapshot);
    const http = performance.getEntriesByType("resource").filter(entry =>
      entry.startTime >= resourceStart && new URL(entry.name).pathname.includes("/api/frigate/vod/"))
      .map(entry => ({ camera: new URL(entry.name).pathname.includes("/drive_up/") ? "drive_up" : "drive_down",
        kind: new URL(entry.name).pathname.endsWith(".m3u8") ? "manifest" : "media",
        status: number(entry.responseStatus), durationMs: number(entry.duration) }));
    const ownership = experiment.peers.filter(peer => peer.video).map(peer => ({ camera: peer.camera,
      anchorUnchanged: peer.clock?.anchor === peer.anchorIdentity, anchorCount: peer.anchorCount,
      hlsUnchanged: peer.hls === peer.captureHls, videoUnchanged: peer.video === peer.captureVideo }));
    experiment.destroy(); removeListeners();
    state.result = { trialId, condition: plan.condition, status: state.status, build: expectedBuild,
      requestedT: prep.target, sourceStart: prep.start, sourceEnd: prep.end,
      playReferenceMs: state.playReferenceMs, readyAt: state.readyAt, finishedAt,
      laterAnchorToPlayMs: state.playReferenceMs === null ? null :
        state.playReferenceMs - Math.max(...experiment.peers.map(peer => peer.landedObservedAt)),
      actualRunDurationMs: state.playReferenceMs === null ? null : finishedAt - state.playReferenceMs,
      contaminated: state.contaminated, contaminationReasons: [...state.contaminationReasons],
      prePlay: state.prePlay ?? null, end, traces, report, audit, http, ownership,
      afterTeardownResources: healthResources() };
    title.textContent = `${trialId} ${state.status} — evidence retained`;
    status.textContent = "Trial evidence retained. No automatic retry or synchronization action.";
  };
  state.finish = finish;
  const start = () => {
    if (state.playReferenceMs !== null || experiment.phase !== "ready" ||
        document.visibilityState !== "visible" || !document.hasFocus() || state.contaminated) {
      throw new Error("Visible focused readiness required at Play.");
    }
    state.prePlay = experiment.peers.map(snapshot); visibility(); focus();
    const ref = state.playReferenceMs = now();
    for (const peer of experiment.peers) {
      peer.captureHls = peer.hls; peer.captureVideo = peer.video;
      const recorder = new RvfcFlightRecorder({ camera: peer.camera, recorderId: `${trialId}-${peer.camera}`,
        operationId: `paused-dwell-${trialId}`, sessionId: peer.id, presentationId: peer.id,
        timeOriginId: `document-${performance.timeOrigin}`,
        anchor: { id: `${trialId}-landed-${peer.camera}`, absoluteTime: peer.clock.anchor.absoluteTime,
          mediaTime: peer.clock.anchor.mediaTime }, playReferenceMs: ref,
        durationMs: CAPTURE_MS, maxRecords: MAX_RECORDS });
      experiment.setRawRecorder(peer.camera, recorder);
    }
    // The inherited play path must retain the same common reference and natural call order.
    const originalNow = experiment.now;
    experiment.now = () => { experiment.now = originalNow; return ref; };
    state.timer = setTimeout(() => finish("finished"), RUN_MS);
    state.status = "playing";
    experiment.play().catch(() => finish("play-failed"));
    title.textContent = `${trialId} playing — hands off`;
    status.textContent = "Keep both videos visible and this page foregrounded for at least 60 seconds.";
    return { playReferenceMs: ref, runMs: RUN_MS, captureMs: CAPTURE_MS };
  };

  try {
    const result = await releaseAfterPreparation(plan, {
      prepare: async () => { await experiment.prepare(); await waitForInitialSeeks(experiment.peers); },
      release: start,
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)), clock: now,
      foreground: () => document.visibilityState === "visible" && document.hasFocus(),
      contaminated: () => {
        if (state.readyAt !== null) {
          for (const camera of audit.cameras) {
            if (camera.currentTimeWrites.some(write => write.at >= state.readyAt) ||
                camera.playbackRateWrites.some(write => write.at >= state.readyAt) ||
                camera.srcWrites.some(write => write.at >= state.readyAt) ||
                camera.playCalls.some(call => call.at >= state.readyAt) ||
                camera.events.some(event => event.at >= state.readyAt && event.type === "seeking")) {
              mark("paused-dwell-media-mutation");
            }
          }
          if (audit.sources.some(source => source.at >= state.readyAt && source.action === "loadSource")) {
            mark("paused-dwell-source-reload");
          }
        }
        return state.contaminated;
      },
      onReady: readyAt => {
        state.readyAt = readyAt;
        state.status = plan.dwellMs ? "dwelling" : "ready";
        title.textContent = `${trialId} ${plan.condition} — both landed anchors established`;
        status.textContent = plan.dwellMs ? "Paused for about 80 seconds. Keep this page foregrounded." : "Releasing promptly.";
      }
    });
    if (result.status === "contaminated") finish("contaminated-before-play");
  } catch {
    finish(state.playReferenceMs === null ? "preparation-failed" : "play-failed");
  }
  return { trialId, status: state.status, readyAt: state.readyAt,
    playReferenceMs: state.playReferenceMs, done: state.done };
}
