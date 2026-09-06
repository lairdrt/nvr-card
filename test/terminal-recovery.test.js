import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "./helpers/nvr-card-harness.js";

function setup(t, recovery = { enabled: true, reconnect_after: 60 }, maximized = false) {
  const h = createTestHarness();
  t.after(() => h.close());
  const card = h.createCard();
  card.setConfig({ ...card.config, live_recovery: recovery });
  card.assignCamera("Garage");
  card.assignCameraToSlot("Front", 1);
  if (maximized) card.maximizeCameraSlot(0);
  const image = h.getPlayer(card, "Garage");
  const state = card._reconnectPresentationDiagnostics.get(image);
  const video = attach(h, card, image);
  // The unaffected camera is healthy throughout the recovery scenarios.
  const otherVideo = attach(h, card, h.getPlayer(card, "Front"));
  h.window.setInterval(() => otherVideo.frame(), 1000);
  card.captureReconnectSnapshot = () => {};
  const events = [];
  card.logReconnect = (event, details) => events.push({ event, details });
  return { h, card, image, state, video, events };
}
function attach(h, card, image) {
  const root = image.shadowRoot ?? image.attachShadow({ mode: "open" });
  const video = h.window.document.createElement("video");
  video.requestVideoFrameCallback = cb => { video.frame = cb; return 1; };
  video.cancelVideoFrameCallback = () => {};
  root.appendChild(video);
  card.inspectReconnectPresentation(card._reconnectPresentationDiagnostics.get(image));
  return video;
}
function stall(x) { x.video.frame(); x.h.advanceTime(10000); }
function current(x) { return x.h.getPlayer(x.card, "Garage"); }

for (const [name, input, enabled, seconds] of [
  ["omission disables recovery", undefined, false, 360],
  ["enabled defaults to 360 seconds", { enabled: true }, true, 360],
  ["strict true required", { enabled: "true", reconnect_after: 90 }, false, 90],
  ["positive range is clamped", { enabled: true, reconnect_after: 1 }, true, 60],
  ["upper range is clamped", { enabled: true, reconnect_after: 999999 }, true, 86400],
  ["numeric strings accepted", { enabled: true, reconnect_after: "120" }, true, 120]
]) test(`terminal recovery: ${name}`, t => {
  const x = setup(t, input === undefined ? null : input);
  if (input === undefined) x.card.setConfig({ ...x.card.config, live_recovery: undefined });
  assert.equal(x.card._liveRecovery.enabled, enabled);
  assert.equal(x.card._liveRecovery.reconnectAfter, seconds);
  if (!enabled) { stall(x); x.h.advanceTime(400000); assert.equal(current(x), x.image); }
});

test("terminal recovery: invalid durations safely default", t => {
  const x = setup(t);
  for (const value of [null, false, true, "", "bad", 0, -1, NaN, Infinity, {}, []]) {
    x.card.setConfig({ ...x.card.config, live_recovery: { enabled: true, reconnect_after: value } });
    assert.equal(x.card._liveRecovery.reconnectAfter, 360);
    assert.equal(current(x), x.image);
  }
});

test("terminal recovery: STALLED arms from transition, never first-frame timeout", t => {
  const x = setup(t);
  stall(x);
  assert.equal(x.state.stallStartedAt, x.h.window.performance.now());
  assert.notEqual(x.state.terminalTimer, null);
  assert.equal(x.state.visualState, "stalled");
  x.h.advanceTime(59999);
  assert.equal(current(x), x.image);
  x.h.advanceTime(1);
  assert.notEqual(current(x), x.image);
});

test("terminal recovery: frame before deadline cancels replacement", t => {
  const x = setup(t); stall(x); x.h.advanceTime(59000); x.video.frame();
  assert.equal(x.state.terminalTimer, null);
  x.h.advanceTime(1000);
  assert.equal(current(x), x.image);
  assert.ok(x.events.some(e => e.event === "terminal-recovery-cancelled"));
});

for (const maximized of [false, true]) test(`terminal recovery: replaces one image preserving source and UI (maximized=${maximized})`, t => {
  const x = setup(t, { enabled: true, reconnect_after: 60 }, maximized);
  const { card, h, image, state } = x;
  const cell = image.closest(".video-cell"), frame = image.parentElement;
  const ui = [...cell.children];
  const other = h.capturePlayerIdentity(card, "Front");
  const indicator = state.statusElement;
  const source = state.cameraImage;
  image.style.width = "320px"; image.style.height = "180px";
  image.style.transform = maximized ? "scale(2)" : "";
  if (maximized) card._maximizedPlayerFit = { image, width: 320, height: 180 };
  const oldFrame = x.video.frame;
  Object.defineProperty(image, "cameraImage", { get() { assert.fail("source readback"); } });
  card.renderSlot = () => assert.fail("recovery must not renderSlot");
  stall(x); h.advanceTime(60000);
  const next = current(x), nextState = card._reconnectPresentationDiagnostics.get(next);
  assert.notEqual(next, image);
  assert.equal(next.parentElement, frame);
  assert.equal(frame.parentElement, cell);
  assert.deepEqual([...cell.children], ui);
  assert.equal(nextState.statusElement, indicator);
  assert.equal(nextState.visualState, "reconnecting");
  assert.equal(indicator.querySelector("ha-icon").getAttribute("icon"), "mdi:sync");
  assert.equal(next.cameraImage, source);
  assert.equal(next.cameraView, "live");
  assert.equal(next.hass, card._hass);
  assert.equal(next.dataset.entity, image.dataset.entity);
  assert.equal(next.style.cssText, image.style.cssText);
  assert.equal(card._assignedCameras[0], "Garage");
  assert.equal(h.capturePlayerIdentity(card, "Front").player, other.player);
  assert.equal(h.getPlayer(card, "Front"), other.player);
  assert.equal(state.active, false);
  assert.equal(state.firstFrameTimer, null);
  oldFrame(); assert.equal(nextState.frameCount, 0);
  const video = attach(h, card, next);
  video.dispatchEvent(new h.window.Event("playing"));
  assert.equal(nextState.visualState, "reconnecting");
  h.advanceTime(500000);
  assert.equal(current(x), next);
  assert.equal(x.events.filter(e => e.event === "terminal-recovery-start").length, 1);
  if (maximized) {
    assert.equal(card._maximizedPlayerFit.image, next);
    assert.equal(card._maximizedSlot, 0);
    card.restoreMaximizedCamera();
    assert.equal(next.style.transform, "");
  }
});

test("terminal recovery: real current frame resets latch for future independent stall", t => {
  const x = setup(t); stall(x); x.h.advanceTime(60000);
  const next = current(x), state = x.card._reconnectPresentationDiagnostics.get(next);
  const video = attach(x.h, x.card, next);
  video.frame();
  assert.equal(state.visualState, "live"); assert.equal(state.statusElement.hidden, true);
  assert.equal(state.recoveryAttempted, false);
  assert.equal(x.events.filter(e => e.event === "terminal-recovery-complete").length, 1);
  x.h.advanceTime(70000);
  assert.notEqual(current(x), next);
  assert.equal(x.events.filter(e => e.event === "terminal-recovery-start").length, 2);
});

test("terminal recovery: source change cancels old generation", t => {
  const x = setup(t); stall(x);
  const oldFrame = x.video.frame;
  x.card._maximizedSlot = 0;
  x.card.updateCameraViewForCell(x.image.closest(".video-cell"));
  const next = x.card._reconnectPresentationDiagnostics.get(x.image);
  assert.notEqual(next.cameraImage, x.state.cameraImage);
  assert.equal(x.state.terminalTimer, null);
  oldFrame(); x.h.advanceTime(9999);
  assert.equal(next.frameCount, 0); assert.equal(current(x), x.image);
  assert.equal(next.stallLogged, false);
  x.h.advanceTime(1);
  assert.equal(next.stallLogged, true);
  assert.notEqual(next.terminalTimer, null);
  x.h.advanceTime(59999); assert.equal(current(x), x.image);
  x.h.advanceTime(1); assert.notEqual(current(x), x.image);
});

test("terminal recovery: hidden time cancelled and visible stall gets fresh deadline", t => {
  const x = setup(t); stall(x); x.h.advanceTime(59000);
  x.h.setDocumentVisibility("hidden"); x.h.advanceTime(500000);
  assert.equal(current(x), x.image); assert.equal(x.state.terminalTimer, null);
  x.h.setDocumentVisibility("visible"); x.h.advanceTime(9999);
  assert.equal(x.state.terminalTimer, null);
  x.h.advanceTime(60000); assert.equal(current(x), x.image);
  x.h.advanceTime(1); assert.notEqual(current(x), x.image);
});

test("terminal recovery: disconnect cancels and reattach starts a fresh silence window", t => {
  const x = setup(t); stall(x); x.card.remove();
  assert.equal(x.state.terminalTimer, null);
  x.h.advanceTime(500000); x.h.window.document.body.appendChild(x.card);
  x.h.advanceTime(9999); assert.equal(current(x), x.image);
  const next = x.card._reconnectPresentationDiagnostics.get(x.image);
  assert.equal(next.stallLogged, false); assert.equal(next.terminalTimer, null);
  x.h.advanceTime(1);
  assert.equal(next.stallLogged, true); assert.notEqual(next.terminalTimer, null);
});

test("terminal recovery: reconnecting latch and indication survive visibility and reattach", t => {
  const x = setup(t); stall(x); x.h.advanceTime(60000);
  const image = current(x);
  x.h.setDocumentVisibility("hidden"); x.h.setDocumentVisibility("visible");
  x.card.remove(); x.h.window.document.body.appendChild(x.card);
  const state = x.card._reconnectPresentationDiagnostics.get(image);
  assert.equal(state.visualState, "reconnecting"); assert.equal(state.statusElement.hidden, false);
  x.h.advanceTime(500000); assert.equal(current(x), image);
});

test("terminal recovery: config changes preserve media and original stall timestamp", t => {
  const x = setup(t); stall(x); x.h.advanceTime(30000);
  const at = x.state.stallStartedAt;
  x.card.setConfig({ ...x.card.config, live_recovery: { enabled: true, reconnect_after: 90 } });
  assert.equal(current(x), x.image); assert.equal(x.state.stallStartedAt, at);
  x.h.advanceTime(59999); assert.equal(current(x), x.image);
  x.h.advanceTime(1); assert.notEqual(current(x), x.image);
});

test("terminal recovery: disable cancels pending timer without media rebuild", t => {
  const x = setup(t); stall(x);
  x.card.setConfig({ ...x.card.config, live_recovery: { enabled: false } });
  assert.equal(x.state.terminalTimer, null);
  x.h.advanceTime(400000); assert.equal(current(x), x.image);
});

test("terminal recovery: stalled spinner and configured corner retained through replacement", t => {
  const x = setup(t);
  x.card.setConfig({ ...x.card.config, live_status: { position: "top-right" } });
  stall(x);
  const indicator = x.state.statusElement;
  assert.equal(indicator.querySelector("ha-icon").getAttribute("icon"), "mdi:loading");
  assert.equal(indicator.style.top, "8px"); assert.equal(indicator.style.right, "8px");
  x.h.advanceTime(60000);
  assert.equal(x.card._reconnectPresentationDiagnostics.get(current(x)).statusElement, indicator);
  assert.equal(indicator.style.top, "8px"); assert.equal(indicator.style.right, "8px");
  assert.equal(indicator.hidden, false);
});

test("terminal recovery: cancelled timer callback cannot recover a later generation or episode", t => {
  const x = setup(t);
  const callbacks = [];
  const setTimeout = x.h.window.setTimeout;
  x.h.window.setTimeout = (callback, delay) => {
    if (delay === 60000) callbacks.push(callback);
    return setTimeout(callback, delay);
  };
  stall(x);
  const stale = callbacks[0];
  assert.equal(typeof stale, "function");
  x.video.frame(); x.h.advanceTime(10000);
  stale(); assert.equal(current(x), x.image);
  assert.notEqual(x.state.terminalTimer, null);
  x.h.advanceTime(60000); const next = current(x);
  stale(); assert.equal(current(x), next);
});

test("terminal recovery: bounded maximize sampling retires with the affected image", t => {
  const x = setup(t, { enabled: true, reconnect_after: 60 }, true);
  stall(x); x.h.advanceTime(59000);
  x.card.startMaximizeMediaSession(0, x.image);
  const session = x.card._activeMaximizeMediaSession;
  assert.ok(session);
  x.h.advanceTime(1000);
  assert.notEqual(current(x), x.image);
  assert.equal(x.card._activeMaximizeMediaSession, null);
  assert.equal(session.eventState.activeSession, null);
});

test("terminal recovery: indicator-only changes share footprint and never mutate media", t => {
  const x = setup(t);
  const { card, h, image, state } = x;
  const indicator = state.statusElement;
  const frame = image.parentElement;
  const cell = frame.parentElement;
  const other = h.capturePlayerIdentity(card, "Front");
  const imageStyle = image.style.cssText;
  const frameChildren = [...frame.children];
  const cellChildren = [...cell.children];
  const source = state.cameraImage;
  Object.defineProperty(image, "cameraImage", {
    get: () => assert.fail("indicator must not read media source"),
    set: () => assert.fail("indicator must not write media source")
  });
  card.renderSlot = () => assert.fail("indicator must not render slot");
  card.replaceTerminallyStalledImage = () => assert.fail("indicator must not replace media");
  const footprint = () => {
    const css = h.window.getComputedStyle(indicator);
    const iconCss = h.window.getComputedStyle(indicator.querySelector("ha-icon"));
    return [css.width, css.height, css.position, css.pointerEvents,
      css.backgroundColor, css.borderRadius, css.opacity, css.top, css.right,
      css.bottom, css.left, iconCss.animation];
  };
  for (const position of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    card.setConfig({ ...card.config, live_status: { position } });
    state.recoveryAttempted = false;
    card.setReconnectPresentationVisualState(state, true);
    assert.equal(indicator.querySelector("ha-icon").getAttribute("icon"), "mdi:loading");
    assert.equal(h.window.getComputedStyle(indicator).color, "rgba(255, 255, 255, 0.9)");
    const stalled = footprint();
    assert.equal(stalled[0], "24px"); assert.equal(stalled[1], "24px");
    assert.equal(stalled[2], "absolute"); assert.equal(stalled[3], "none");
    assert.equal(stalled[11], "nvr-live-state-spin 1s linear infinite");
    for (const side of ["top", "right", "bottom", "left"]) {
      assert.equal(indicator.style[side], position.split("-").includes(side) ? "8px" : "auto");
    }
    state.recoveryAttempted = true;
    card.setReconnectPresentationVisualState(state, true);
    assert.equal(indicator.querySelector("ha-icon").getAttribute("icon"), "mdi:sync");
    assert.equal(h.window.getComputedStyle(indicator).color, "rgba(255, 255, 255, 0.9)");
    assert.deepEqual(footprint(), stalled);
    assert.equal(indicator.hidden, false);
    x.video.frame();
    assert.equal(indicator.hidden, true);
    assert.equal(current(x), image);
    assert.equal(image.style.cssText, imageStyle);
    assert.equal(state.cameraImage, source);
    assert.deepEqual([...frame.children], frameChildren);
    assert.deepEqual([...cell.children], cellChildren);
    assert.deepEqual(h.capturePlayerIdentity(card, "Front"), other);
  }
});

test("initial no-frame: ten seconds enters existing STALLED and arms terminal recovery", t => {
  const x = setup(t);
  assert.equal(x.state.lastFrameTime, null);
  assert.equal(x.state.frameLivenessStarted, false);
  x.h.advanceTime(9999);
  assert.equal(x.state.visualState, "live");
  assert.equal(x.state.statusElement.hidden, true);
  assert.equal(x.state.terminalTimer, null);
  x.h.advanceTime(1);
  assert.equal(x.state.visualState, "stalled");
  assert.equal(x.state.statusElement.hidden, false);
  assert.equal(x.state.statusElement.querySelector("ha-icon").getAttribute("icon"), "mdi:loading");
  assert.equal(x.state.stallStartedAt, 10000);
  assert.notEqual(x.state.terminalTimer, null);
  assert.equal(x.state.frameCount, 0);
  assert.equal(x.state.lastFrameTime, null);
  assert.equal(current(x), x.image);
});

test("initial no-frame: first genuine frame before threshold stays LIVE", t => {
  const x = setup(t);
  x.h.advanceTime(9999); x.video.frame(); x.h.advanceTime(1);
  assert.equal(x.state.frameCount, 1);
  assert.equal(x.state.visualState, "live");
  assert.equal(x.state.statusElement.hidden, true);
  assert.equal(x.state.terminalTimer, null);
  assert.equal(x.events.some(e => e.event === "frame-stall-detected"), false);
  assert.equal(x.events.some(e => e.event === "terminal-recovery-armed"), false);
  assert.equal(current(x), x.image);
});

test("initial no-frame: first frame during STALLED cancels recovery and returns LIVE", t => {
  const x = setup(t);
  x.h.advanceTime(69999);
  assert.equal(x.state.visualState, "stalled");
  assert.notEqual(x.state.terminalTimer, null);
  x.video.frame(); x.h.advanceTime(1);
  assert.equal(x.state.visualState, "live");
  assert.equal(x.state.statusElement.hidden, true);
  assert.equal(x.state.terminalTimer, null);
  assert.equal(x.state.stallStartedAt, null);
  assert.equal(current(x), x.image);
  assert.equal(x.events.some(e => e.event === "terminal-recovery-start"), false);
});

test("initial no-frame: continuous absence replaces once, remains RECONNECTING until real frame", t => {
  const x = setup(t);
  const oldFrame = x.video.frame;
  x.h.advanceTime(69999); assert.equal(current(x), x.image);
  x.h.advanceTime(1);
  const image = current(x), state = x.card._reconnectPresentationDiagnostics.get(image);
  assert.notEqual(image, x.image);
  assert.equal(state.visualState, "reconnecting");
  assert.equal(state.statusElement.querySelector("ha-icon").getAttribute("icon"), "mdi:sync");
  oldFrame();
  assert.equal(state.frameCount, 0);
  x.h.advanceTime(500000);
  assert.equal(current(x), image);
  assert.equal(state.visualState, "reconnecting");
  assert.equal(state.terminalTimer, null);
  assert.equal(x.events.filter(e => e.event === "terminal-recovery-start").length, 1);
  const video = attach(x.h, x.card, image);
  video.dispatchEvent(new x.h.window.Event("playing"));
  assert.equal(state.visualState, "reconnecting");
  video.frame();
  assert.equal(state.visualState, "live");
  assert.equal(state.statusElement.hidden, true);
});

test("initial no-frame: hidden initial attachment waits for full visible observation window", t => {
  const x = setup(t);
  x.h.setDocumentVisibility("hidden");
  x.card.remove(); x.h.window.document.body.appendChild(x.card);
  const state = x.card._reconnectPresentationDiagnostics.get(x.image);
  assert.equal(state.silenceTimer, null);
  x.h.advanceTime(500000);
  assert.equal(state.visualState, "live");
  assert.equal(state.terminalTimer, null);
  x.h.setDocumentVisibility("visible"); x.h.advanceTime(9999);
  assert.equal(state.stallLogged, false);
  x.h.advanceTime(1);
  assert.equal(state.stallLogged, true);
  assert.notEqual(state.terminalTimer, null);
});

test("initial no-frame: visibility rebases a partially elapsed initial window", t => {
  const x = setup(t);
  x.h.advanceTime(9000); x.h.setDocumentVisibility("hidden");
  assert.equal(x.state.silenceTimer, null);
  x.h.advanceTime(500000);
  assert.equal(current(x), x.image);
  x.h.setDocumentVisibility("visible"); x.h.advanceTime(9999);
  assert.equal(x.state.stallLogged, false);
  assert.equal(x.state.lastFrameTime, null);
  x.h.advanceTime(1);
  assert.equal(x.state.stallLogged, true);
  assert.equal(x.state.stallStartedAt, x.h.window.performance.now());
});

test("initial no-frame: detach cancels initial window and stale callbacks cannot affect reattach", t => {
  const x = setup(t);
  const oldFrame = x.video.frame;
  x.h.advanceTime(9000); x.card.remove();
  assert.equal(x.state.silenceTimer, null);
  assert.equal(x.state.active, false);
  x.h.advanceTime(500000); oldFrame();
  x.h.window.document.body.appendChild(x.card);
  const state = x.card._reconnectPresentationDiagnostics.get(x.image);
  oldFrame(); x.h.advanceTime(9999);
  assert.equal(state.frameCount, 0);
  assert.equal(state.stallLogged, false);
  x.h.advanceTime(1);
  assert.equal(state.stallLogged, true);
  assert.equal(current(x), x.image);
});

test("initial no-frame: source change invalidates initial timer and old frame callbacks", t => {
  const x = setup(t);
  const oldFrame = x.video.frame;
  x.h.advanceTime(9000);
  x.card._maximizedSlot = 0;
  x.card.updateCameraViewForCell(x.image.closest(".video-cell"));
  const state = x.card._reconnectPresentationDiagnostics.get(x.image);
  assert.equal(x.state.silenceTimer, null);
  assert.notEqual(state.cameraImage, x.state.cameraImage);
  oldFrame(); x.h.advanceTime(9999);
  assert.equal(state.frameCount, 0);
  assert.equal(state.stallLogged, false);
  x.h.advanceTime(1);
  assert.equal(state.stallLogged, true);
  assert.notEqual(state.terminalTimer, null);
});

test("initial no-frame: cancelled silence callback cannot stall after a frame or visibility rebase", t => {
  const x = setup(t);
  const callbacks = [];
  const setTimeout = x.h.window.setTimeout;
  x.h.window.setTimeout = (callback, delay) => {
    if (delay === 10000) callbacks.push(callback);
    return setTimeout(callback, delay);
  };
  x.card.remove(); x.h.window.document.body.appendChild(x.card);
  const stale = callbacks[0];
  const state = x.card._reconnectPresentationDiagnostics.get(x.image);
  x.video.frame(); stale();
  assert.equal(state.stallLogged, false);
  assert.notEqual(state.silenceTimer, null);
  const beforeHidden = callbacks.at(-1);
  x.h.setDocumentVisibility("hidden"); x.h.setDocumentVisibility("visible");
  beforeHidden();
  assert.equal(state.stallLogged, false);
  assert.notEqual(state.silenceTimer, null);
});

test("initial no-frame: presentation constructed detached starts observation only on attachment", t => {
  const x = setup(t);
  x.card.remove();
  x.card.renderSlot(0);
  const image = current(x), state = x.card._reconnectPresentationDiagnostics.get(image);
  assert.equal(image.isConnected, false);
  assert.equal(state.video, null);
  assert.equal(state.silenceTimer, null);
  x.h.advanceTime(500000);
  assert.equal(state.stallLogged, false);
  x.h.window.document.body.appendChild(x.card);
  assert.equal(x.card._reconnectPresentationDiagnostics.get(image), state);
  assert.notEqual(state.silenceTimer, null);
  x.h.advanceTime(9999);
  assert.equal(state.stallLogged, false);
  x.h.advanceTime(1);
  assert.equal(state.stallLogged, true);
  assert.equal(state.statusElement.hidden, false);
  assert.notEqual(state.terminalTimer, null);
});

for (const [name, value, expected] of [
  ["omitted defaults to ten seconds", undefined, 10],
  ["numeric value accepted", 20, 20],
  ["numeric string accepted", "25", 25],
  ["below minimum clamps to five", 1, 5],
  ["above maximum clamps to three hundred", 500, 300]
]) test(`stall_after: ${name}`, t => {
  const x = setup(t, { enabled: true, stall_after: value });
  assert.equal(x.card._liveRecovery.stallAfter, expected);
  assert.equal(x.card._liveRecovery.reconnectAfter, 360);
});

test("stall_after: invalid values safely default to ten", t => {
  const x = setup(t);
  for (const value of [null, false, true, "", "  ", "bad", 0, -1, NaN, Infinity, {}, []]) {
    x.card.setConfig({ ...x.card.config, live_recovery: { enabled: true, stall_after: value } });
    assert.equal(x.card._liveRecovery.stallAfter, 10);
    assert.equal(x.card._liveRecovery.reconnectAfter, 360);
    assert.equal(current(x), x.image);
  }
});

for (const initiallyLive of [false, true]) test(`stall_after: shared configured threshold and additional recovery delay (initiallyLive=${initiallyLive})`, t => {
  const x = setup(t, { enabled: true, stall_after: 20, reconnect_after: 60 });
  if (initiallyLive) x.video.frame();
  x.h.advanceTime(19999);
  assert.equal(x.state.stallLogged, false);
  assert.equal(x.state.terminalTimer, null);
  assert.equal(x.state.statusElement.hidden, true);
  x.h.advanceTime(1);
  assert.equal(x.state.stallLogged, true);
  assert.equal(x.state.stallStartedAt, 20000);
  assert.notEqual(x.state.terminalTimer, null);
  x.h.advanceTime(59999); assert.equal(current(x), x.image);
  x.h.advanceTime(1); assert.notEqual(current(x), x.image);
});

test("stall_after: genuine frame resets configured window and cancels pending recovery", t => {
  const x = setup(t, { enabled: true, stall_after: 20, reconnect_after: 60 });
  x.h.advanceTime(19000); x.video.frame(); x.h.advanceTime(19999);
  assert.equal(x.state.stallLogged, false);
  assert.equal(x.state.terminalTimer, null);
  x.h.advanceTime(1);
  assert.equal(x.state.stallLogged, true);
  assert.equal(x.state.stallStartedAt, 39000);
  x.h.advanceTime(59000); x.video.frame(); x.h.advanceTime(1000);
  assert.equal(x.state.visualState, "live");
  assert.equal(x.state.terminalTimer, null);
  assert.equal(current(x), x.image);
});

for (const initiallyLive of [false, true]) test(`stall_after: timing-only config preserves media and observation start (initiallyLive=${initiallyLive})`, t => {
  const x = setup(t, { enabled: true, stall_after: 20, reconnect_after: 60 });
  if (initiallyLive) x.video.frame();
  const before = x.h.capturePlayerIdentity(x.card, "Garage");
  const frame = x.image.parentElement;
  const indicator = x.state.statusElement;
  x.card.render = () => assert.fail("timing config must not render");
  x.card.renderSlot = () => assert.fail("timing config must not render slots");
  Object.defineProperty(x.image, "cameraImage", {
    get: () => assert.fail("timing config must not read source"),
    set: () => assert.fail("timing config must not write source")
  });
  x.h.advanceTime(9000);
  x.card.setConfig({ ...x.card.config, live_recovery: { enabled: true, stall_after: 30, reconnect_after: 90 } });
  assert.deepEqual(x.h.capturePlayerIdentity(x.card, "Garage"), before);
  assert.equal(x.image.parentElement, frame);
  assert.equal(x.card._reconnectPresentationDiagnostics.get(x.image), x.state);
  assert.equal(x.state.video, x.video);
  assert.equal(x.state.statusElement, indicator);
  assert.equal(x.state.silenceStartedAt, 0);
  x.h.advanceTime(20999); assert.equal(x.state.stallLogged, false);
  x.h.advanceTime(1); assert.equal(x.state.stallStartedAt, 30000);
  x.h.advanceTime(89999); assert.equal(current(x), x.image);
  x.h.advanceTime(1); assert.notEqual(current(x), x.image);
});

test("stall_after: changing threshold while STALLED retains the recovery episode", t => {
  const x = setup(t, { enabled: true, stall_after: 5, reconnect_after: 60 });
  x.h.advanceTime(5000);
  const at = x.state.stallStartedAt;
  x.card.setConfig({ ...x.card.config, live_recovery: { enabled: true, stall_after: 300, reconnect_after: 60 } });
  assert.equal(x.state.stallStartedAt, at);
  assert.equal(x.state.visualState, "stalled");
  x.h.advanceTime(59999); assert.equal(current(x), x.image);
  x.h.advanceTime(1); assert.notEqual(current(x), x.image);
});

test("stall_after: visibility return rebases to configured threshold", t => {
  const x = setup(t, { enabled: true, stall_after: 20, reconnect_after: 60 });
  x.h.advanceTime(19000); x.h.setDocumentVisibility("hidden");
  x.h.advanceTime(500000);
  x.card.setConfig({ ...x.card.config, live_recovery: { enabled: true, stall_after: 30, reconnect_after: 60 } });
  assert.equal(x.state.silenceTimer, null);
  x.h.setDocumentVisibility("visible"); x.h.advanceTime(29999);
  assert.equal(x.state.stallLogged, false);
  x.h.advanceTime(1);
  assert.equal(x.state.stallLogged, true);
  assert.equal(x.state.stallStartedAt, x.h.window.performance.now());
});
