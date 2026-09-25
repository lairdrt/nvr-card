import test from "node:test";
import assert from "node:assert/strict";

import {
  INVESTIGATION_PEER_SYNC_POLICY,
  InvestigationRvfcPeerCoordinator
} from "../src/investigation-lab/rvfc-peer-coordinator.js";

function fakeRenderer(camera, now, overrides = {}) {
  const calls = [];
  let reportCalls = 0;
  const state = {
    camera, requestedEpoch: null, resolvedEpoch: null, representedEpoch: null,
    representedObservedAtMs: null, positionKind: "empty", playing: false,
    playbackRate: 1, effectivePlaybackRate: 1, mediaCurrentTime: 0,
    activeSessionId: null, activePresentationId: null,
    successor: { state: "none" }, transition: { count: 0 },
    boundaryDeadline: { fireCount: 0 }, coverageBoundary: { state: "unknown" },
    droppedFrameCount: 0, waitingEvents: 0, stalledEvents: 0, status: "Idle"
  };
  return {
    camera, state, calls,
    get reportCalls() { return reportCalls; },
    async place(epoch) {
      calls.push(["place", epoch]);
      if (overrides.place) return overrides.place(epoch, state);
      Object.assign(state, {
        requestedEpoch: epoch, resolvedEpoch: epoch, representedEpoch: epoch,
        representedObservedAtMs: now(), positionKind: "covered", playing: false,
        activeSessionId: `${camera}-s1`, activePresentationId: `${camera}-p1`, status: "Placed"
      });
      return true;
    },
    async play() {
      calls.push(["play"]);
      if (overrides.play) return overrides.play(state);
      state.playing = true;
      return true;
    },
    async resume() { calls.push(["resume"]); state.playing = true; return true; },
    pause() { calls.push(["pause"]); state.playing = false; return true; },
    setPlaybackRate(rate) {
      calls.push(["rate", rate]); state.playbackRate = rate; state.effectivePlaybackRate = rate; return true;
    },
    setEffectivePlaybackRate(rate) {
      calls.push(["effective-rate", rate]); state.effectivePlaybackRate = rate; return true;
    },
    destroy() { calls.push(["destroy"]); },
    getDiagnosticReport() { reportCalls += 1; return { camera, state: { ...state } }; }
  };
}

function harness(options = {}) {
  let now = options.now ?? 1;
  const getNow = () => now;
  const a = options.a ?? fakeRenderer("drive_up", getNow, options.aOverrides);
  const b = options.b ?? fakeRenderer("drive_down", getNow, options.bOverrides);
  const scene = new InvestigationRvfcPeerCoordinator({
    renderers: [
      { camera: a.camera, renderer: a, ownerGeneration: 7 },
      { camera: b.camera, renderer: b, ownerGeneration: 7 }
    ],
    ownerGeneration: 7, now: getNow,
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
    getVisibilityState: () => "visible", syncPolicy: options.syncPolicy
  });
  const setNow = value => { now = value; };
  const observe = (renderer, representedEpoch, changes = {}) => {
    now = changes.now ?? now + 1;
    Object.assign(renderer.state, changes, {
      representedEpoch,
      representedObservedAtMs: changes.observedAtMs ?? now
    });
    return scene.observeCamera(renderer.camera, renderer.state, {
      ownerGeneration: changes.ownerGeneration ?? 7, emit: false
    });
  };
  return { scene, a, b, setNow, observe };
}

async function placedHarness(options = {}) {
  const value = harness(options);
  assert.equal(await value.scene.place(100), true);
  return value;
}

test("coordinator requires exactly two safe equal peers and assigns only experimental roles", () => {
  assert.throws(() => new InvestigationRvfcPeerCoordinator({ renderers: [] }), /exactly two/);
  const { scene } = harness();
  assert.deepEqual(scene.state.peers.map(peer => peer.role), ["clock-holder", "follower"]);
  assert.doesNotMatch(JSON.stringify(scene.state), /primary|secondary/i);
});

test("Place dispatches one absolute target and Play waits for both truthful placements", async () => {
  const { scene, a, b } = await placedHarness();
  assert.deepEqual(a.calls[0], ["place", 100]);
  assert.deepEqual(b.calls[0], ["place", 100]);
  assert.equal(scene.state.playbackEpoch, 100);
  assert.equal(scene.state.playing, false);
  assert.equal(await scene.play(), true);
  assert.equal(scene.state.playing, true);
  assert.equal(a.state.playing, true);
  assert.equal(b.state.playing, true);
});

test("an uncovered initial peer fails the bounded startup barrier without fabricated video", async () => {
  const unavailable = fakeRenderer("drive_down", () => 1, {
    place: (_epoch, state) => { state.positionKind = "uncovered"; return false; }
  });
  const value = harness({ b: unavailable });
  assert.equal(await value.scene.place(100), false);
  assert.equal(value.scene.state.operationDisposition, "initial-peer-unavailable");
  assert.equal(await value.scene.play(), false);
  assert.equal(value.scene.state.operationDisposition, "startup-barrier-not-ready");
});

test("playbackEpoch advances only from a current owned clock-holder RVFC", async () => {
  const { scene, a, setNow, observe } = await placedHarness();
  setNow(5000);
  assert.equal(scene.state.playbackEpoch, 100);
  a.state.mediaCurrentTime = 900;
  scene.observeCamera(a.camera, a.state, { ownerGeneration: 7, emit: false });
  assert.equal(scene.state.playbackEpoch, 100);
  observe(a, 101.25, { mediaCurrentTime: 901 });
  assert.equal(scene.state.playbackEpoch, 101.25);
});

test("follower error is follower representedEpoch minus playbackEpoch", async () => {
  const { scene, a, b, observe } = await placedHarness();
  observe(a, 102);
  observe(b, 101.25);
  assert.equal(scene.state.followerErrorSeconds, -0.75);
  observe(b, 102.5);
  assert.equal(scene.state.followerErrorSeconds, 0.5);
});

test("clock-holder artificial replacement preserves absolute clock continuity", async () => {
  const { scene, a, observe } = await placedHarness();
  observe(a, 159.95, { observedAtMs: 10 });
  observe(a, 160, {
    observedAtMs: 5,
    activeSessionId: "drive_up-s2",
    activePresentationId: "drive_up-p2",
    transition: { count: 1 }
  });
  assert.equal(scene.state.playbackEpoch, 160);
  assert.equal(scene.state.peers[0].sessionId, "drive_up-s2");
  assert.equal(observe(a, 999, {
    observedAtMs: 11,
    activeSessionId: "drive_up-s1",
    activePresentationId: "drive_up-p1"
  }), false);
});

test("follower artificial replacement preserves absolute error semantics", async () => {
  const { scene, a, b, observe } = await placedHarness();
  observe(a, 160.2);
  observe(b, 160, { activeSessionId: "drive_down-s2", activePresentationId: "drive_down-p2", transition: { count: 1 } });
  assert.ok(Math.abs(scene.state.followerErrorSeconds + 0.2) < 1e-9);
});

test("stale frames from retired identities and wrong generations are rejected", async () => {
  const { scene, a, observe } = await placedHarness();
  observe(a, 160, { activeSessionId: "drive_up-s2", activePresentationId: "drive_up-p2" });
  assert.equal(observe(a, 999, { activeSessionId: "drive_up-s1", activePresentationId: "drive_up-p1" }), false);
  assert.equal(scene.state.playbackEpoch, 160);
  assert.equal(observe(a, 1000, { ownerGeneration: 6 }), false);
  const report = scene.getDiagnosticReport();
  assert.equal(report.aggregate.staleObservationRejectCount, 1);
  assert.equal(report.aggregate.ownershipRejectCount, 1);
});

test("peer artificial boundaries are independent and separately diagnosed", async () => {
  const { scene, a, b, observe } = await placedHarness();
  observe(a, 160, { activeSessionId: "drive_up-s2", activePresentationId: "drive_up-p2", transition: { count: 1 } });
  let latest = scene.getDiagnosticReport().observations.at(-1);
  assert.equal(latest.clockHolderJustTransitioned, true);
  assert.equal(latest.followerJustTransitioned, false);
  observe(b, 160.1, { activeSessionId: "drive_down-s2", activePresentationId: "drive_down-p2", transition: { count: 1 } });
  latest = scene.getDiagnosticReport().observations.at(-1);
  assert.equal(latest.clockHolderJustTransitioned, false);
  assert.equal(latest.followerJustTransitioned, true);
});

test("16x lag stays observation-only and marks reacquisition candidates", async () => {
  const { scene, a, b, observe } = await placedHarness();
  scene.setPlaybackRate(16);
  observe(a, 110);
  observe(b, 104);
  const report = scene.getDiagnosticReport();
  assert.equal(scene.state.followerErrorBand, "reacquisition-candidate");
  assert.ok(report.aggregate.reacquisitionCandidateCount > 0);
  assert.equal(report.observations.at(-1).action, "observe-reacquisition-candidate");
  assert.equal(a.calls.some(call => call[0] === "effective-rate"), false);
  assert.equal(b.calls.some(call => call[0] === "effective-rate"), false);
  assert.equal(Math.max(a.state.effectivePlaybackRate, b.state.effectivePlaybackRate), 16);
});

test("explicit absolute error bands are independent of nominal rate", async () => {
  const { scene, a, b, observe } = await placedHarness();
  for (const rate of [0.25, 16]) {
    scene.setPlaybackRate(rate);
    observe(a, 110); observe(b, 110.4);
    assert.equal(scene.state.followerErrorBand, "in-band");
    observe(b, 111);
    assert.equal(scene.state.followerErrorBand, "mild-divergence");
    observe(b, 113);
    assert.equal(scene.state.followerErrorBand, "reacquisition-candidate");
  }
});

test("Pause and wall-time passage cannot synthesize progression", async () => {
  const { scene, setNow } = await placedHarness();
  await scene.play();
  assert.equal(scene.pause(), true);
  const frozen = scene.state.playbackEpoch;
  setNow(1_000_000);
  assert.equal(scene.state.playbackEpoch, frozen);
  assert.equal(scene.state.playing, false);
});

test("genuine clock-holder recording end freezes authority and stops the follower", async () => {
  const { scene, a, b, observe } = await placedHarness();
  await scene.play();
  observe(a, 120, { playing: false, coverageBoundary: { state: "genuine-recording-end" } });
  assert.equal(scene.state.playbackEpoch, 120);
  assert.equal(scene.state.playing, false);
  assert.equal(scene.state.authorityStatus, "authority-handoff-required");
  assert.equal(b.state.playing, false);
});

test("clock-holder terminal successor failure stops both peers and exposes its reason", async () => {
  const { scene, a, b } = await placedHarness();
  await scene.play();
  a.state.successor = {
    state: "failed",
    sourceSessionId: "drive_up-s1",
    sourcePresentationId: "drive_up-p1",
    boundaryEpoch: 120,
    error: "Historical presentation map endpoints were inconsistent."
  };
  scene.observeCamera(a.camera, a.state, { ownerGeneration: 7, emit: false });
  assert.equal(scene.state.playing, false);
  assert.equal(scene.state.authorityStatus, "clock-holder-successor-failed");
  assert.equal(scene.state.operationDisposition, "clock-holder-successor-failed");
  assert.equal(scene.state.clockHolderFailure.boundaryEpoch, 120);
  assert.match(scene.state.clockHolderFailure.reason, /map endpoints/);
  assert.equal(a.state.playing, false);
  assert.equal(b.state.playing, false);
  assert.equal(await scene.resume(), false);
  assert.equal(scene.state.operationDisposition, "clock-holder-failure-requires-new-place");
});

test("destroy cleans both peer engines and rejects stale callbacks", async () => {
  const { scene, a, b } = await placedHarness();
  scene.destroy();
  assert.equal(a.calls.filter(call => call[0] === "destroy").length, 1);
  assert.equal(b.calls.filter(call => call[0] === "destroy").length, 1);
  assert.equal(scene.observeCamera(a.camera, a.state, { ownerGeneration: 7 }), false);
});

test("synchronization observation ring is bounded while aggregate count is retained", async () => {
  const { scene, a, b, observe } = await placedHarness({ syncPolicy: { observationLimit: 5 } });
  for (let index = 1; index <= 10; index += 1) {
    observe(a, 100 + index / 10); observe(b, 100 + index / 10);
  }
  const report = scene.getDiagnosticReport();
  assert.equal(report.observations.length, 5);
  assert.ok(report.aggregate.observationCount > report.aggregate.retainedObservationCount);
});

test("full renderer diagnostics and percentile sorting occur only at report generation", async () => {
  const { scene, a, b, observe } = await placedHarness();
  for (let index = 1; index <= 5; index += 1) {
    observe(a, 100 + index); observe(b, 100 + index - 0.1 * index);
  }
  assert.equal(a.reportCalls, 0);
  assert.equal(b.reportCalls, 0);
  const report = scene.getDiagnosticReport();
  assert.equal(a.reportCalls, 1);
  assert.equal(b.reportCalls, 1);
  assert.ok(report.aggregate.p95AbsoluteErrorSeconds >= report.aggregate.p50AbsoluteErrorSeconds);
});

test("all eight nominal rates apply to both peers without changing playbackEpoch", async () => {
  const { scene, a, b } = await placedHarness();
  const initialEpoch = scene.state.playbackEpoch;
  const rates = [0.25, 0.5, 0.75, 1, 2, 4, 8, 16];
  for (const rate of rates) {
    assert.equal(scene.setPlaybackRate(rate), true);
    assert.equal(a.state.playbackRate, rate);
    assert.equal(b.state.playbackRate, rate);
    assert.equal(scene.state.playbackEpoch, initialEpoch);
  }
  assert.deepEqual(a.calls.filter(call => call[0] === "rate").map(call => call[1]), rates);
  assert.throws(() => scene.setPlaybackRate(3), /Unsupported/);
});

test("slow rates remain paused and advance only on clock-holder RVFC evidence", async () => {
  const { scene, a, observe } = await placedHarness();
  for (const rate of [0.25, 0.5, 0.75]) {
    scene.setPlaybackRate(rate);
    const before = scene.state.playbackEpoch;
    assert.equal(scene.state.playing, false);
    assert.equal(scene.state.playbackEpoch, before);
    observe(a, before + 0.05);
    assert.equal(scene.state.playbackEpoch, before + 0.05);
  }
  assert.equal(scene.getDiagnosticReport().mode, "two-peer-rvfc-clock-holder-observation");
});

test("rate changes preserve absolute identities and do not rebuild presentations", async () => {
  const { scene, a, b } = await placedHarness();
  const identities = scene.state.peers.map(peer => [peer.sessionId, peer.presentationId]);
  scene.setPlaybackRate(0.5); scene.setPlaybackRate(8);
  assert.deepEqual(scene.state.peers.map(peer => [peer.sessionId, peer.presentationId]), identities);
  assert.equal(a.calls.filter(call => call[0] === "place").length, 1);
  assert.equal(b.calls.filter(call => call[0] === "place").length, 1);
});

test("diagnostics retain transition, successor, quality, deadline, and visibility correlation", async () => {
  const { scene, a, b, observe } = await placedHarness();
  observe(a, 101, {
    successor: { state: "preparing" }, transition: { count: 2 },
    boundaryDeadline: { fireCount: 1 }, droppedFrameCount: 9, waitingEvents: 1
  });
  observe(b, 100.8, {
    successor: { state: "ready" }, transition: { count: 1 }, stalledEvents: 2, droppedFrameCount: 4
  });
  const item = scene.getDiagnosticReport().observations.at(-1);
  assert.equal(item.visibilityState, "visible");
  assert.equal(item.clockHolderSuccessorState, "preparing");
  assert.equal(item.followerSuccessorState, "ready");
  assert.equal(item.clockHolderDeadlineFireCount, 1);
  assert.equal(item.clockHolderDroppedFrameCount, 9);
  assert.equal(item.followerStalledEvents, 2);
  assert.equal(item.ownershipValid, true);
});

test("default diagnostic policy keeps several hundred observations and simple absolute bands", () => {
  assert.equal(INVESTIGATION_PEER_SYNC_POLICY.observationLimit, 512);
  assert.deepEqual([
    INVESTIGATION_PEER_SYNC_POLICY.inBandSeconds,
    INVESTIGATION_PEER_SYNC_POLICY.mildDivergenceSeconds
  ], [0.5, 2]);
});
