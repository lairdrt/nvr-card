import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "./helpers/nvr-card-harness.js";

const config = {
  enabled: true, timeout: 30, fade_duration: 8,
  normal_brightness: 180, dim_brightness: 0,
  notify_service: "notify.mobile_app_test_tablet"
};

function setup(t, overrides = {}, synchronous = false) {
  const h = createTestHarness();
  t.after(() => h.close());
  const logs = [];
  for (const level of ["log", "info", "warn"]) {
    h.window.console[level] = (...args) => logs.push({ level, args });
  }
  const connection = new h.window.EventTarget();
  connection.connected = true;
  const hass = { ...h.createHass(), connection };
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  hass.callService = (domain, service, payload) => {
    const call = { domain, service, payload, done: synchronous };
    calls.push(call);
    if (synchronous) return;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return { then(resolve, reject) {
      call.complete = failure => {
        assert.equal(call.done, false, "fixture settles each request once");
        call.done = true;
        inFlight -= 1;
        (failure ? reject : resolve)(failure ? new Error("offline") : undefined);
      };
      call.staleSuccess = resolve;
      call.staleFailure = reject;
    } };
  };
  const card = h.window.document.createElement("nvr-card");
  h.window.document.body.appendChild(card);
  card.setConfig({ cameras: h.defaultCameras ?? [
    { name: "Front", entity: "camera.front" }, { name: "Garage", entity: "camera.garage" }
  ], auto_dim: { ...config, ...overrides } });
  card.hass = hass;
  const complete = (failure = false) => {
    const call = calls.find(call => !call.done);
    assert.ok(call, "a request is in flight");
    call.complete(failure);
    return call;
  };
  const ready = () => { complete(); complete(); complete(); };
  const event = (type, properties = {}, target = card) => {
    const value = new h.window.Event(type, { bubbles: true, cancelable: true });
    for (const [key, entry] of Object.entries(properties)) Object.defineProperty(value, key, { value: entry });
    target.dispatchEvent(value);
    return value;
  };
  const lose = () => { connection.connected = false; connection.dispatchEvent(new h.window.Event("disconnected")); };
  const reconnect = () => { connection.connected = true; connection.dispatchEvent(new h.window.Event("ready")); };
  return { h, card, hass, calls, complete, ready, event, lose, reconnect, connection, logs,
    maxInFlight: () => maxInFlight };
}

function beginFade(x) { x.ready(); x.h.advanceTime(31000); }

test("auto-dim reliability: startup serializes ownership and waits for normal brightness", t => {
  const x = setup(t);
  assert.equal(x.calls.length, 1);
  assert.equal(x.calls[0].payload.message, "command_auto_screen_brightness");
  assert.equal(x.card._autoDimState, "initializing");
  assert.equal(x.card._idleTimer, null);
  x.card.hass = x.hass; x.card.hass = { ...x.hass };
  x.event("pointerdown");
  assert.equal(x.calls.length, 1);
  x.complete(); assert.equal(x.calls[1].payload.message, "command_screen_on");
  assert.equal(x.card._idleTimer, null);
  x.complete(); assert.equal(x.calls[2].payload.data.command, 180);
  assert.equal(x.card._idleTimer, null);
  assert.equal(x.card._displayOwnershipComplete, false);
  x.complete();
  assert.equal(x.card._autoDimState, "awake");
  assert.equal(x.card._displayOwnershipComplete, true);
  assert.notEqual(x.card._idleTimer, null);
  assert.equal(x.maxInFlight(), 1);
});

test("auto-dim reliability: fade steps wait for success and dimmed waits for final completion", t => {
  const x = setup(t); beginFade(x);
  for (let step = 1; step <= 8; step++) {
    assert.equal(x.calls.length, 3 + step);
    assert.equal(x.calls.at(-1).payload.data.command, Math.round(180 * (1 - step / 8)));
    assert.equal(x.card._autoDimState, "dimming");
    x.h.advanceTime(2000); // No next step while this command is unresolved.
    assert.equal(x.calls.length, 3 + step);
    x.complete();
    if (step < 8) {
      assert.equal(x.card._autoDimState, "dimming");
      x.h.advanceTime(999); assert.equal(x.calls.length, 3 + step);
      x.h.advanceTime(1);
    }
  }
  assert.equal(x.card._autoDimState, "dimmed");
  assert.equal(x.card._fadeTimer, null);
  assert.equal(x.maxInFlight(), 1);
});

for (const failure of [false, true]) test(`auto-dim reliability: wake supersedes in-flight fade even when obsolete command rejects (${failure})`, t => {
  const x = setup(t); beginFade(x);
  const dim = x.calls.at(-1);
  x.event("pointerdown", { pointerId: 1 });
  assert.equal(x.card._autoDimState, "restoring");
  assert.equal(x.card._idleTimer, null);
  assert.equal(x.card._fadeTimer, null);
  x.event("mousemove"); x.event("click"); x.event("dragover");
  assert.equal(x.calls.length, 4);
  x.complete(failure);
  assert.equal(x.calls.length, 5);
  assert.equal(x.calls.at(-1).payload.data.command, 180);
  dim.staleSuccess(); dim.staleFailure();
  assert.equal(x.card._autoDimState, "restoring");
  assert.equal(x.card._idleTimer, null);
  x.h.advanceTime(8000);
  assert.equal(x.calls.length, 5);
  x.complete();
  assert.equal(x.card._autoDimState, "awake");
  assert.notEqual(x.card._idleTimer, null);
  assert.equal(x.maxInFlight(), 1);
});

test("auto-dim reliability: wake cancels an unsent fade step", t => {
  const x = setup(t); x.ready(); x.h.advanceTime(30000);
  assert.equal(x.card._autoDimState, "dimming");
  assert.equal(x.calls.length, 3);
  x.event("mousemove");
  assert.equal(x.calls.length, 4);
  assert.equal(x.calls.at(-1).payload.data.command, 180);
  x.complete(); x.h.advanceTime(1000);
  assert.equal(x.calls.length, 4);
});

test("auto-dim reliability: detach retires ownership continuation and reattach initializes once", t => {
  const x = setup(t);
  const generation = x.card._autoDimGeneration;
  x.card.remove();
  assert.ok(x.card._autoDimGeneration > generation);
  assert.equal(x.card._autoDimState, "suspended");
  x.complete();
  assert.equal(x.calls.length, 1);
  assert.equal(x.card._idleTimer, null);
  x.h.window.document.body.appendChild(x.card);
  x.card.connectedCallback(); x.card.hass = { ...x.hass };
  assert.equal(x.calls.length, 2);
  x.ready();
  assert.equal(x.calls.length, 4);
  assert.equal(x.card._autoDimState, "awake");
});

test("auto-dim reliability: disconnect suspends and ready serializes restoration behind obsolete request", t => {
  const x = setup(t); beginFade(x);
  const old = x.calls.at(-1);
  x.lose();
  assert.equal(x.card._autoDimState, "suspended");
  assert.equal(x.card._fadeTimer, null);
  x.h.advanceTime(60000); assert.equal(x.calls.length, 4);
  x.reconnect(); x.reconnect(); x.card.hass = x.hass;
  assert.equal(x.calls.length, 4);
  x.complete(true);
  assert.equal(x.calls.length, 5);
  assert.equal(x.calls.at(-1).payload.message, "command_auto_screen_brightness");
  old.staleSuccess(); assert.equal(x.card._idleTimer, null);
  x.ready();
  assert.equal(x.card._autoDimState, "awake");
  assert.equal(x.maxInFlight(), 1);
});

test("auto-dim reliability: public connection boolean and replacement connection are respected", t => {
  const x = setup(t); x.ready();
  x.connection.connected = false; x.card.hass = x.hass;
  assert.equal(x.card._autoDimState, "suspended");
  x.connection.connected = true; x.card.hass = x.hass;
  x.ready(); assert.equal(x.calls.length, 6);
  const replacement = new x.h.window.EventTarget(); replacement.connected = true;
  x.card.hass = { ...x.hass, connection: replacement };
  assert.equal(x.calls.length, 7);
  x.lose(); assert.equal(x.card._autoDimState, "initializing"); // Retired listener cannot suspend.
  x.ready(); assert.equal(x.calls.length, 9);
});

test("auto-dim reliability: transient failure waits for deliberate recovery, never hass-update retries", t => {
  const x = setup(t); x.complete(true);
  assert.equal(x.card._autoDimState, "suspended");
  assert.equal(x.card._autoDimListenersInstalled, true);
  for (let i = 0; i < 5; i++) { x.card.hass = { ...x.hass }; x.event("mousemove"); }
  x.h.advanceTime(100000);
  assert.equal(x.calls.length, 1);
  x.event("pointerdown", { pointerId: 1 });
  x.ready(); assert.equal(x.card._autoDimState, "awake");
});

test("auto-dim reliability: command deadline suspends without releasing unresolved service barrier", t => {
  const x = setup(t); x.h.advanceTime(15000);
  assert.equal(x.card._autoDimState, "suspended");
  assert.equal(x.card._idleTimer, null);
  x.card.hass = x.hass; assert.equal(x.calls.length, 1);
  x.event("click"); assert.equal(x.calls.length, 1);
  x.complete(); // Old request settles; a current ownership request can now run.
  assert.equal(x.calls.length, 2);
  x.ready(); assert.equal(x.card._autoDimState, "awake");
  assert.equal(x.maxInFlight(), 1);
});

test("auto-dim reliability: config change retires pending work without replacing media", t => {
  const x = setup(t); x.ready();
  x.card.assignCamera("Front");
  const before = x.h.capturePlayerIdentity(x.card, "Front");
  const frame = before.player.parentElement;
  x.h.advanceTime(31000);
  x.card.render = () => assert.fail("auto_dim change must not render media");
  x.card.setConfig({ ...x.card.config, auto_dim: { ...config, normal_brightness: 200 } });
  assert.equal(x.card._autoDimState, "initializing");
  assert.equal(x.calls.length, 4);
  x.complete(true); x.complete(); x.complete();
  assert.equal(x.calls.at(-1).payload.data.command, 200);
  assert.equal(x.card._idleTimer, null);
  x.complete();
  assert.deepEqual(x.h.capturePlayerIdentity(x.card, "Front"), before);
  assert.equal(before.player.parentElement, frame);
  assert.equal(x.card._autoDimState, "awake");
});

test("auto-dim reliability: disable waits for old dim then best-effort restores using old config", t => {
  const x = setup(t); beginFade(x);
  x.card.setConfig({ ...x.card.config, auto_dim: { enabled: false } });
  assert.equal(x.card._autoDimState, "disabling");
  assert.equal(x.card._autoDimListenersInstalled, false);
  assert.equal(x.card._fadeTimer, null);
  x.card.hass = x.hass; // Ordinary hass updates must not cancel the final restoration.
  x.complete();
  assert.equal(x.calls.at(-1).payload.data.command, 180);
  assert.equal(x.calls.at(-1).service, "mobile_app_test_tablet");
  x.complete(); x.h.advanceTime(60000);
  assert.equal(x.card._autoDimState, "disabled");
  assert.equal(x.calls.length, 5);
  assert.equal(x.card._idleTimer, null);
});

test("auto-dim reliability: disable while disconnected issues no restoration commands", t => {
  const x = setup(t); x.ready(); x.lose();
  { const { auto_dim, ...withoutAutoDim } = x.card.config; x.card.setConfig(withoutAutoDim); }
  x.reconnect(); x.card.hass = x.hass;
  assert.equal(x.calls.length, 3);
  assert.equal(x.card._autoDimState, "disabled");
});

test("auto-dim reliability: best-effort disable restoration is bounded", t => {
  const x = setup(t); x.ready();
  { const { auto_dim, ...withoutAutoDim } = x.card.config; x.card.setConfig(withoutAutoDim); }
  x.h.advanceTime(15000);
  assert.equal(x.card._autoDimState, "disabled");
  assert.equal(x.card._autoDimCommandTimer, null);
  x.complete(); assert.equal(x.card._idleTimer, null);
});

for (const cancel of [false, true]) test(`auto-dim reliability: wake gesture clears on termination/cancellation (${cancel})`, t => {
  const x = setup(t, { fade_duration: 0 }, true); x.h.advanceTime(30000);
  const target = x.card.querySelector(".sidebar-toggle");
  const down = x.event("pointerdown", { pointerId: 7 }, target);
  assert.equal(down.defaultPrevented, true);
  assert.equal(x.card._autoDimState, "awake");
  x.event(cancel ? "pointercancel" : "pointerup", { pointerId: 7 }, x.h.window.document);
  if (!cancel) {
    const click = x.event("click", { pointerId: 7 }, target);
    assert.equal(click.defaultPrevented, true);
  }
  assert.equal(x.card._wakeGesture, null);
  assert.equal(x.event("click", { pointerId: 8 }, target).defaultPrevented, false);
});

test("auto-dim reliability: missing compatibility click expires and cannot swallow unrelated click", t => {
  const x = setup(t, { fade_duration: 0 }, true); x.h.advanceTime(30000);
  x.event("pointerdown", { pointerId: 3 });
  x.event("pointerup", { pointerId: 3 }, x.h.window.document);
  x.h.advanceTime(501);
  assert.equal(x.card._wakeGesture, null);
  assert.equal(x.event("click").defaultPrevented, false);
});

test("auto-dim reliability: missing pointer termination is bounded and new gesture clears suppression", t => {
  const x = setup(t, { fade_duration: 0 }, true); x.h.advanceTime(30000);
  x.event("pointerdown", { pointerId: 3 }); x.h.advanceTime(10001);
  assert.equal(x.card._wakeGesture, null);
  x.h.advanceTime(20000); // Dim again.
  x.event("pointerdown", { pointerId: 4 });
  x.event("pointerdown", { pointerId: 5 });
  assert.equal(x.event("click", { pointerId: 5 }).defaultPrevented, false);
});

for (const boundary of ["detach", "disconnect", "config", "disable"]) test(`auto-dim reliability: ${boundary} clears wake gesture`, t => {
  const x = setup(t, { fade_duration: 0 }, true); x.h.advanceTime(30000);
  x.event("pointerdown", { pointerId: 2 }); assert.ok(x.card._wakeGesture);
  if (boundary === "detach") x.card.remove();
  if (boundary === "disconnect") x.lose();
  if (boundary === "config") x.card.setConfig({ ...x.card.config, auto_dim: { ...config, timeout: 31 } });
  if (boundary === "disable") { const { auto_dim, ...withoutAutoDim } = x.card.config; x.card.setConfig(withoutAutoDim); }
  assert.equal(x.card._wakeGesture, null);
  assert.equal(x.card._wakeClickTimer, null);
});

test("auto-dim reliability: inverted/equal brightness and structural errors block configuration", t => {
  const x = setup(t, {}, true);
  for (const value of [null, [], "bad", { enabled: true }, { ...config, normal_brightness: 0 },
    { ...config, dim_brightness: 180 }, { ...config, dim_brightness: 200 }]) {
    const normalized = x.card.normalizeAutoDim(value);
    assert.equal(normalized.invalid, true);
    assert.equal(normalized.enabled, false);
  }
});

test("auto-dim reliability: brightness null/empty use defaults and numeric strings remain valid", t => {
  const x = setup(t, {}, true);
  for (const value of [null, "", "  ", false]) {
    const normalized = x.card.normalizeAutoDim({ ...config, normal_brightness: value });
    assert.equal(normalized.normalBrightness, 180);
    assert.equal(normalized.invalid, false);
  }
  const normalized = x.card.normalizeAutoDim({ ...config, timeout: "30", fade_duration: "5",
    normal_brightness: "200", dim_brightness: "10" });
  assert.equal(normalized.timeout, 30); assert.equal(normalized.fadeDuration, 5);
  assert.equal(normalized.normalBrightness, 200); assert.equal(normalized.dimBrightness, 10);
  const bounded = x.card.normalizeAutoDim({ ...config, timeout: 1e20, fade_duration: 1e20 });
  assert.equal(bounded.timeout, 86400); assert.equal(bounded.fadeDuration, 300);
});

test("auto-dim reliability: activity is quiet and separate instances do not share runtime state", t => {
  const x = setup(t, {}, true);
  const second = x.h.window.document.createElement("nvr-card");
  x.h.window.document.body.appendChild(second);
  second.setConfig({ ...x.card.config, auto_dim: { ...config, timeout: 60 } }); second.hass = x.hass;
  x.logs.length = 0;
  for (const type of ["pointerdown", "click", "mousemove", "dragstart", "dragover", "drop"]) x.event(type);
  assert.deepEqual(x.logs, []);
  x.h.advanceTime(38000);
  assert.equal(x.card._autoDimState, "dimmed");
  assert.equal(second._autoDimState, "awake");
  assert.equal(x.logs.filter(log => String(log.args[0]).includes("[NVR auto-dim]")).length, 1);
});

test("auto-dim reliability: stale inactivity/fade callbacks cannot override newer activity", t => {
  const x = setup(t, {}, true);
  const callbacks = [];
  const setTimeout = x.h.window.setTimeout;
  x.h.window.setTimeout = (cb, delay) => { callbacks.push({ cb, delay }); return setTimeout(cb, delay); };
  x.event("mousemove"); const idle = callbacks.find(c => c.delay === 30000).cb;
  x.event("mousemove"); idle(); assert.equal(x.card._autoDimState, "awake");
  x.h.advanceTime(30000);
  const fade = callbacks.find(c => c.delay === 1000).cb;
  x.event("click"); fade();
  assert.equal(x.card._autoDimState, "awake");
  assert.equal(x.calls.at(-1).payload.data.command, 180);
});

test("auto-dim reliability: disconnect cancels best-effort disabling intent", t => {
  const x = setup(t); x.ready();
  x.card.setConfig({ ...x.card.config, auto_dim: { enabled: false } });
  assert.equal(x.card._autoDimState, "disabling");
  x.lose();
  assert.equal(x.card._autoDimState, "disabled");
  assert.equal(x.card._autoDimCommandTimer, null);
  x.complete(); x.reconnect();
  assert.equal(x.calls.length, 4);
  assert.equal(x.card._idleTimer, null);
});

test("auto-dim reliability: maximize and restore count as activity without replacing players", t => {
  const x = setup(t, { fade_duration: 0 }, true);
  x.card.assignCamera("Front");
  const before = x.h.capturePlayerIdentity(x.card, "Front");
  x.h.advanceTime(29000); x.card.maximizeCameraSlot(0);
  x.h.advanceTime(29000); assert.equal(x.card._autoDimState, "awake");
  x.card.restoreMaximizedCamera();
  x.h.advanceTime(30000); assert.equal(x.card._autoDimState, "dimmed");
  x.card.maximizeCameraSlot(0);
  assert.equal(x.card._autoDimState, "awake");
  assert.equal(x.calls.at(-1).payload.data.command, 180);
  assert.deepEqual(x.h.capturePlayerIdentity(x.card, "Front"), before);
});

test("auto-dim reliability: service failure while waking suspends without stale gesture or permanent latch", t => {
  const x = setup(t, { fade_duration: 0 }, true); x.h.advanceTime(30000);
  x.hass.callService = () => { throw new Error("network unavailable"); };
  x.event("pointerdown", { pointerId: 9 });
  assert.equal(x.card._autoDimState, "suspended");
  assert.equal(x.card._wakeGesture, null);
  assert.equal(x.card._idleTimer, null);
  x.hass.callService = () => {};
  x.lose(); x.reconnect();
  assert.equal(x.card._autoDimState, "awake");
});

test("auto-dim reliability: native promise rejection after detach cannot continue ownership", async t => {
  const x = setup(t, { enabled: false });
  let reject;
  const promise = new Promise((_resolve, fail) => { reject = fail; });
  let count = 0;
  x.hass.callService = () => { count++; return promise; };
  x.card.setConfig({ ...x.card.config, auto_dim: config });
  assert.equal(count, 1);
  x.card.remove(); reject(new Error("disconnected"));
  await promise.catch(() => {});
  assert.equal(count, 1);
  assert.equal(x.card._autoDimState, "suspended");
  assert.equal(x.card._autoDimInFlight, null);
  assert.equal(x.card._idleTimer, null);
});
