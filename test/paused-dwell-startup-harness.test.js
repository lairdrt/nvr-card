import test from "node:test";
import assert from "node:assert/strict";
import { releaseAfterPreparation, startupTrialPlan, waitForInitialSeeks } from
  "../src/investigation-lab/paused-dwell-startup-harness.js";

test("prompt trials release in the preparation continuation without a timer", async () => {
  const events = [];
  let clockValue = 10;
  const result = await releaseAfterPreparation(startupTrialPlan("A1"), {
    prepare: async () => { events.push("prepared"); clockValue = 12; },
    onReady: () => events.push("ready"),
    wait: () => { throw new Error("Prompt release must not wait."); },
    clock: () => clockValue,
    foreground: () => true,
    contaminated: () => false,
    release: () => { events.push("released"); return "play-dispatched"; }
  });
  assert.deepEqual(events, ["prepared", "ready", "released"]);
  assert.deepEqual(result, { status: "released", readyAt: 12, releaseAt: 12,
    releaseResult: "play-dispatched" });
});

test("long dwell starts only after readiness and releases after the configured hold", async () => {
  const events = [];
  let clockValue = 100;
  const result = await releaseAfterPreparation(startupTrialPlan("B1"), {
    prepare: async () => { events.push("prepared"); },
    onReady: () => events.push("ready"),
    wait: async ms => { events.push(`wait-${ms}`); clockValue += ms; },
    clock: () => clockValue,
    foreground: () => true,
    contaminated: () => false,
    release: () => { events.push("released"); }
  });
  assert.deepEqual(events, ["prepared", "ready", "wait-80000", "released"]);
  assert.equal(result.releaseAt - result.readyAt, 80_000);
  assert.equal(startupTrialPlan("B2").runMs, 65_000);
  assert.equal(startupTrialPlan("B2").captureMs, 65_000);
  assert.equal(startupTrialPlan("B2").maxRecords, 4_096);
});

test("focus loss during dwell prevents Play and does not retry", async () => {
  let focused = true, releases = 0, waits = 0;
  const result = await releaseAfterPreparation(startupTrialPlan("B2"), {
    prepare: async () => {},
    wait: async () => { waits++; focused = false; },
    clock: () => 1,
    foreground: () => focused,
    contaminated: () => !focused,
    release: () => { releases++; }
  });
  assert.equal(result.status, "contaminated");
  assert.equal(result.releaseAt, null);
  assert.equal(releases, 0);
  assert.equal(waits, 1);
});

test("invalid trial IDs are rejected before preparation", () => {
  assert.throws(() => startupTrialPlan("A3"), /Unknown startup trial/);
});

test("a landed RVFC alone does not release until both initial seeks settle", async () => {
  const peers = [0, 1].map(() => ({ initialWrites: 1, times: {}, video: Object.assign(new EventTarget(), { seeking: true }) }));
  let released = false;
  const completion = waitForInitialSeeks(peers).then(() => { released = true; });
  peers[0].times.seeked = 1; peers[0].video.seeking = false;
  peers[0].video.dispatchEvent(new Event("seeked"));
  await Promise.resolve();
  assert.equal(released, false);
  peers[1].times.seeked = 2; peers[1].video.seeking = false;
  peers[1].video.dispatchEvent(new Event("seeked"));
  await completion;
  assert.equal(released, true);
});
