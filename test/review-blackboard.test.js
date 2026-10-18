import assert from "node:assert/strict";
import test from "node:test";
import {
  ReviewBlackboard, BLACKBOARD_CLOCK, BLACKBOARD_COVERAGE, BLACKBOARD_EVENT_CLASSES, BLACKBOARD_STATES,
  BLACKBOARD_THRESHOLDS
} from "../src/review/review-blackboard.js";

// Synthetic heartbeat streams drive the Blackboard module directly: no DOM, no playback.
const DAY = 86400;
const T0 = 1800000000 - (1800000000 % DAY);

function simulation({ cameras = ["Drive Up", "Drive Down"], days = 1, rate = 8, from = T0 } = {}) {
  const board = new ReviewBlackboard();
  const state = { nowMs: 0, wallMs: Date.parse("2026-10-18T00:00:00Z"), epoch: from, visible: true,
    running: true, rate, frames: Object.fromEntries(cameras.map(name => [name, 0])),
    media: Object.fromEntries(cameras.map(name => [name, from])),
    lifecycle: Object.fromEntries(cameras.map(name => [name, "participating"])),
    coverage: Object.fromEntries(cameras.map(name => [name, "recorded"])),
    presenting: Object.fromEntries(cameras.map(name => [name, true])),
    presentation: Object.fromEntries(cameras.map(name => [name, { name }])),
    frozen: {}, behind: {} };
  board.open({ nowMs: 0, wallMs: state.wallMs, range: { from, to: from + days * DAY }, startEpoch: from,
    rate, autoSnap: false, skipDeadspace: false, cameras, visible: true, autoplay: true });
  const sample = () => ({
    nowMs: state.nowMs, wallMs: state.wallMs, epoch: state.epoch, running: state.running, rate: state.rate,
    visible: state.visible, preparing: false, navigationPreparing: false, requestId: null, rvfc: true,
    cameras: cameras.map(name => ({
      name, lifecycle: state.lifecycle[name], reason: null, transition: false, waiting: false,
      presentation: state.presentation[name], frames: state.frames[name],
      mediaEpoch: state.lifecycle[name] === "participating" ? state.media[name] : null,
      frameEpoch: state.media[name], held: false, coverage: state.coverage[name], recovery: null
    }))
  });
  const tick = (ms = 500) => {
    state.nowMs += ms;
    state.wallMs += ms;
    if (state.running) {
      state.epoch += state.rate * ms / 1000;
      for (const name of cameras) {
        if (state.lifecycle[name] !== "participating" || state.frozen[name]) continue;
        state.media[name] = state.epoch - (state.behind[name] ?? 0);
        if (state.presenting[name] && state.visible) state.frames[name] += 1;
      }
    }
    board.sample(sample());
  };
  // Advance to a Review epoch at the simulation's rate.
  const runUntil = epoch => { while (state.epoch < epoch) tick(); };
  board.sample(sample());
  return { board, state, tick, runUntil, cameras };
}

const failure = (sim, camera, reason) => sim.board.failure({ camera, reason, outcome: "failure",
  stage: "media", targetEpoch: sim.state.epoch, nowMs: sim.state.nowMs, wallMs: sim.state.wallMs });

test("Blackboard multi-day run: failures on different days, a hidden interval, and health strips", () => {
  const sim = simulation({ cameras: ["Drive Up", "Drive Down", "Garage", "Porch"], days: 5 });
  const { board, state } = sim;
  // Day 2: Drive Up fails and recovers 30 s later.
  sim.runUntil(T0 + DAY + 6 * 3600);
  failure(sim, "Drive Up", "hls_fatal");
  board.recovery("Drive Up", { attempts: 1 });
  state.lifecycle["Drive Up"] = "failed";
  for (let index = 0; index < 60; index += 1) sim.tick();
  state.lifecycle["Drive Up"] = "participating";
  state.presentation["Drive Up"] = { rebuilt: true };
  sim.tick();
  sim.tick();
  // Day 3: the tab is hidden for two hours of recording time.
  sim.runUntil(T0 + 2 * DAY + 10 * 3600);
  state.visible = false;
  sim.runUntil(T0 + 2 * DAY + 12 * 3600);
  state.visible = true;
  // Day 4: Garage fails and never recovers.
  sim.runUntil(T0 + 3 * DAY + 18 * 3600);
  failure(sim, "Garage", "media_stalled");
  for (const attempts of [1, 2, 3]) board.recovery("Garage", { attempts, exhausted: attempts === 3 });
  state.lifecycle.Garage = "failed";
  sim.runUntil(T0 + 5 * DAY - 10);

  const session = board.session;
  const up = session.cameras.get("Drive Up");
  const garage = session.cameras.get("Garage");
  assert.equal(up.recovery.recovered, 1);
  assert.equal(garage.recovery.exhausted, 1);
  assert.equal(session.incidents.byType.camera_failure.count, 2);
  const report = board.report({ wallMs: state.wallMs, nowMs: state.nowMs });
  assert.match(report, /^- Drive Up: PROBLEM DETECTED \(recovered\)/m);
  assert.match(report, /^- Garage: PROBLEM DETECTED \(unresolved\)/m);
  assert.match(report, /^- Porch: HEALTHY/m);
  assert.match(report, /^Session: PROBLEM DETECTED \(unresolved\)$/m);
  const strip = (name, day) => report.split("\n").filter(line => line.startsWith(name.padEnd(14).slice(0, 14)))[day]
    .split("|")[1];
  assert.equal(strip("Drive Up", 0), ".".repeat(24));
  assert.equal(strip("Drive Up", 1)[6], "!", "the day-2 failure is visible at its hour");
  assert.equal(strip("Porch", 2).slice(10, 12), "??", "hidden hours are unobserved, not failures");
  assert.equal(strip("Porch", 2).replace(/\?/g, ""), ".".repeat(22));
  assert.equal(strip("Garage", 3)[18], "!");
  assert.match(strip("Garage", 4), /^x+$/, "after the persistent failure the camera shows nothing");
  assert.ok(report.length < 64 * 1024);
  // Ending the session turns the open failure persistent.
  board.end("returned_to_live", { nowMs: state.nowMs, wallMs: state.wallMs });
  assert.equal(garage.recovery.persistent, 1);
});

test("Blackboard incident history rotates while session-wide counters stay exact", () => {
  const sim = simulation();
  const { board } = sim;
  for (let index = 0; index < 500; index += 1) {
    failure(sim, "Drive Up", index % 2 ? "media_error" : "hls_fatal");
    sim.state.presentation["Drive Up"] = { index };
    sim.tick();
    sim.tick();
  }
  const session = board.session;
  const camera = session.cameras.get("Drive Up");
  assert.equal(session.incidents.byType.camera_failure.count, 500);
  assert.equal(camera.recovery.episodes, 500);
  assert.equal(camera.recovery.recovered, 500);
  assert.equal(camera.failures.hls_fatal, 250);
  assert.equal(camera.failures.media_error, 250);
  assert.equal(session.incidents.first.length, 16);
  assert.equal(session.incidents.recent.length, 48);
  assert.equal(session.incidents.dropped, 500 - 16 - 48);
  const report = board.report({ wallMs: sim.state.wallMs });
  assert.match(report, /camera_failure \[problem\]: 500x/);
  assert.match(report, /\[436 older incident details omitted; counts above are complete\]/);
  assert.match(report, /Recovery: 500 episode\(s\): recovered 500/);
});

test("Blackboard memory stays bounded for 16 cameras over a 7-day investigation", () => {
  const cameras = Array.from({ length: 16 }, (_, index) => `Camera ${index + 1}`);
  const sim = simulation({ cameras, days: 7, rate: 32 });
  const { board } = sim;
  sim.runUntil(T0 + DAY);
  const afterDay = board.retainedBytes();
  for (let index = 0; index < 3000; index += 1) {
    const name = cameras[index % 16];
    failure(sim, name, "media_stalled");
    board.autoSnapStart({ nowMs: sim.state.nowMs, start: sim.state.epoch, end: sim.state.epoch + 1 },
      cameras.map(camera => ({ name: camera, frames: sim.state.frames[camera] })));
    sim.state.presentation[name] = { index };
    sim.tick();
    board.autoSnapEnd({ nowMs: sim.state.nowMs }, cameras.map(camera => ({ name: camera,
      frames: sim.state.frames[camera], coverage: "recorded", verifiedLanding: true,
      landedEpoch: sim.state.epoch - 1, frameEpoch: sim.state.epoch })));
    sim.tick();
  }
  sim.runUntil(T0 + 7 * DAY - 10);
  const session = board.session;
  const bytes = board.retainedBytes();
  assert.ok(bytes < 250 * 1024, `retained ${bytes} bytes`);
  assert.ok(bytes - afterDay < 40 * 1024, "growth is limited to the bounded rings");
  assert.equal(session.bins.count, 168);
  assert.ok(session.incidents.first.length + session.incidents.recent.length <= 64);
  assert.ok(session.autoSnap.examples.first.length + session.autoSnap.examples.recent.length <= 24);
  assert.equal(session.autoSnap.intervals, 3000);
  const report = board.report({ wallMs: sim.state.wallMs });
  assert.ok(report.length <= 64 * 1024, `report ${report.length} bytes`);
  assert.match(report, /^- Camera 16: /m, "every camera keeps its summary under truncation");
  assert.match(report, /camera_failure \[problem\]: 3000x/);
});

test("Blackboard report: the size target truncates detail but never the summary", () => {
  const cameras = Array.from({ length: 16 }, (_, index) => `A very long camera display name ${index}`);
  const sim = simulation({ cameras, days: 14, rate: 64 });
  const { board, state } = sim;
  for (let day = 0; day < 13; day += 1) {
    sim.runUntil(T0 + day * DAY + 3600);
    for (const name of cameras) {
      failure(sim, name, "hls_fatal");
      state.presentation[name] = { day };
      board.autoSnapStart({ nowMs: state.nowMs, start: state.epoch, end: state.epoch + 1 },
        cameras.map(camera => ({ name: camera, frames: state.frames[camera] })));
      board.autoSnapEnd({ nowMs: state.nowMs }, cameras.map(camera => ({ name: camera,
        frames: state.frames[camera], coverage: "recorded", verifiedLanding: true, landedEpoch: state.epoch })));
      sim.tick();
    }
  }
  sim.runUntil(T0 + 13 * DAY);
  const report = board.report({ wallMs: state.wallMs });
  assert.ok(report.length <= 64 * 1024, `report ${report.length} bytes`);
  assert.ok(report.length <= 41 * 1024, "the 40 KB target governs detail");
  assert.match(report, /\[report detail truncated at the size target; summary counts above are complete\]/);
  assert.match(report, /^- A very long camera display name 15: PROBLEM DETECTED \(recovered; R-09 short events\)$/m);
  assert.match(report, /camera_failure \[problem\]: 208x/);
  assert.match(report, /== INCIDENTS ==/);
});

test("Blackboard sanitization: names, reasons and builds are allowlisted", () => {
  const board = new ReviewBlackboard();
  board.open({ nowMs: 0, wallMs: 0, range: { from: T0, to: T0 + 3600 }, startEpoch: T0, rate: 1,
    cameras: ["<img src=x onerror=alert(1)>", "Drive Up"], visible: true });
  board.failure({ camera: "Drive Up", reason: "https://frigate.local/api/vod?token=SECRET",
    outcome: "failure", stage: "/media/frigate/recordings", targetEpoch: T0, nowMs: 0, wallMs: 0 });
  const report = board.report({ build: "build\"<script>/../token", wallMs: 0 });
  for (const forbidden of ["<", "onerror=", "https", "token=", "SECRET", "/media/", "/../", "\""]) {
    assert.ok(!report.includes(forbidden), `report must not contain ${forbidden}`);
  }
  assert.match(report, /Failures: other 1/);
  assert.match(report, /^Build: buildscript\.\.token \|/m);
  assert.match(report, /^- img srcx onerroralert\(1\): /m);
});

test("Blackboard unknown coverage is never a gap and never an incident", () => {
  const sim = simulation();
  sim.state.coverage["Drive Up"] = "unknown";
  sim.state.lifecycle["Drive Up"] = "unavailable";
  for (let index = 0; index < 200; index += 1) sim.tick();
  const record = sim.board.session.cameras.get("Drive Up");
  const report = sim.board.report({ wallMs: sim.state.wallMs });
  assert.equal(sim.board.session.incidents.total, 0);
  assert.match(report, /Coverage at Review time \(wall, clock running or stopped\): recorded 0ms, confirmed gap 0ms, unknown 1m 40s/);
  assert.match(report, /^ {4}Steady playback: INCONCLUSIVE - no recorded time was traversed/m);
  assert.equal(record.bins.reduce((sum, value) => sum + value, 0) > 0, true);
});

test("Blackboard thresholds: brief freezes are ignored and divergence tolerance scales with rate", () => {
  const sim = simulation({ rate: 8 });
  const { state } = sim;
  // A 1.5 s freeze is below the 2 s observation threshold; a 3 s freeze is not.
  for (const [ticks, expected] of [[3, undefined], [6, 1]]) {
    state.frozen["Drive Up"] = true;
    for (let index = 0; index < ticks; index += 1) sim.tick();
    state.frozen["Drive Up"] = false;
    sim.tick();
    assert.equal(sim.board.session.cameras.get("Drive Up").incidentCounts.presentation_freeze, expected,
      `${ticks * 0.5} s frozen`);
  }
  // 5 s behind at 8x is inside the 2 + 0.5 x 8 = 6 s tolerance; 7 s behind is not.
  for (const [behind, expected] of [[5, undefined], [7, 1]]) {
    state.behind["Drive Down"] = behind;
    for (let index = 0; index < 25; index += 1) sim.tick();
    assert.equal(sim.board.session.cameras.get("Drive Down").incidentCounts.clock_media_divergence, expected,
      `${behind} s behind at 8x`);
  }
  assert.equal(BLACKBOARD_THRESHOLDS.freezeMs, 2000);
});

test("Blackboard short-event classes follow presented-frame evidence", () => {
  const sim = simulation({ cameras: ["A", "B", "C", "D", "E", "F"] });
  const { board, state } = sim;
  const start = state.epoch + 4;
  const frames0 = { ...state.frames };
  board.autoSnapStart({ nowMs: state.nowMs, start, end: start + 1 },
    sim.cameras.map(name => ({ name, frames: frames0[name] })));
  sim.tick();
  const end = (name, delta, extra = {}) => ({ name, frames: frames0[name] + delta, coverage: "recorded",
    verifiedLanding: true, landedEpoch: start, frameEpoch: start + 0.9, ...extra });
  board.autoSnapEnd({ nowMs: state.nowMs }, [
    end("A", 5),
    end("B", 1, { frameEpoch: start + 0.1 }),
    end("C", 0),
    end("D", 0, { verifiedLanding: false }),
    end("E", 0, { coverage: "gap" }),
    end("F", 5, { visible: false })
  ]);
  const classOf = name => {
    const events = board.session.cameras.get(name).events;
    return BLACKBOARD_EVENT_CLASSES[events.findIndex(Boolean) % BLACKBOARD_EVENT_CLASSES.length];
  };
  assert.deepEqual(["A", "B", "C", "D", "E", "F"].map(classOf),
    ["played", "flash", "landed_only", "nothing", "not_expected", "unobserved"]);
  // Only expected events without visible playback are problems (B, C, D).
  const report = board.report({ wallMs: state.wallMs });
  assert.match(report, /Short events \(Auto Snap\): PROBLEM DETECTED \(R-09 short events\) - 3 of 4 expected/);
});

// ---- Accounting corrections (October 18 runtime report) ----

const CELL_OF = (clock, coverage, state) =>
  (BLACKBOARD_CLOCK.indexOf(clock) * BLACKBOARD_COVERAGE.length + BLACKBOARD_COVERAGE.indexOf(coverage)) *
    BLACKBOARD_STATES.length + BLACKBOARD_STATES.indexOf(state);

// One camera driven tick by tick: the caller sets clock, lifecycle and hold per tick.
function singleCamera({ rate = 4 } = {}) {
  const board = new ReviewBlackboard();
  const st = { nowMs: 0, epoch: T0, running: true, rate, frames: 0, lifecycle: "participating", held: false,
    presenting: true, preparing: false, visible: true, presentation: { id: 1 }, requestId: null };
  board.open({ nowMs: 0, wallMs: 0, range: { from: T0, to: T0 + 7 * DAY }, startEpoch: T0, rate,
    cameras: ["Drive Up"], visible: true, autoplay: true });
  const sample = () => board.sample({ nowMs: st.nowMs, wallMs: st.nowMs, epoch: st.epoch, running: st.running,
    rate: st.rate, visible: st.visible, preparing: st.preparing, navigationPreparing: st.preparing,
    requestId: st.requestId, rvfc: true, cameras: [{ name: "Drive Up", lifecycle: st.lifecycle, reason: null,
      transition: false, waiting: false, presentation: st.presentation, frames: st.frames,
      mediaEpoch: st.lifecycle === "participating" ? st.epoch : null, frameEpoch: st.epoch, held: st.held,
      coverage: "recorded", recovery: null, firstAdvanceAtMs: st.firstAdvanceAtMs ?? null,
      playIssuedAtMs: st.playIssuedAtMs ?? null }] });
  const tick = (count = 1, ms = 500) => {
    for (let index = 0; index < count; index += 1) {
      st.nowMs += ms;
      if (st.running) st.epoch += st.rate * ms / 1000;
      if (st.running && st.lifecycle === "participating" && st.presenting && st.visible) st.frames += 1;
      sample();
    }
  };
  sample();
  return { board, st, tick, record: () => board.session.cameras.get("Drive Up") };
}

test("Blackboard Expected excludes clock-stopped held and acquiring time; every millisecond is accounted once", () => {
  const { board, st, tick, record } = singleCamera();
  tick(20);                                  // 10 s verified playback
  st.running = false;                        // navigation: clock stopped, exit frame held
  st.lifecycle = "preparing";
  st.held = true;
  st.preparing = true;
  tick(8);
  st.lifecycle = "participating";            // landed; the clock resumes
  st.held = false;
  st.preparing = false;
  st.running = true;
  tick(10);
  const camera = record();
  const cell = (clock, state) => camera.matrix[CELL_OF(clock, "recorded", state)];
  assert.equal(cell("running", "verified"), 14500);
  assert.equal(cell("running", "held") + cell("running", "acquiring"), 0, "no clock-stopped time in Expected");
  assert.equal(cell("stopped", "held"), 4000);
  assert.equal(cell("stopped", "acquiring"), 500, "the boundary interval after the restart is clock-stopped");
  const conserved = Array.from(camera.matrix).reduce((sum, value) => sum + value, 0);
  assert.equal(conserved, camera.sampledMs);
  assert.equal(conserved, 38 * 500, "every sampled interval is in exactly one cell");
  const report = board.report({ wallMs: st.nowMs, nowMs: st.nowMs });
  assert.match(report, /^ {4}Steady playback: HEALTHY - verified 100\.0% of steady expected playback; acquiring or held 0\.0% of observed expected time$/m);
  assert.match(report, /^ {2}Expected \(recording \+ clock running\) 14\.5s wall; observable 100\.0%; unobserved 0ms$/m);
  assert.match(report, /^ {2}Clock stopped with recording at Review time 4\.5s: navigation transitions 4\.5s \(acquiring 500ms, held 4\.0s\), paused 0ms, other 0ms$/m);
});

test("Blackboard acquiring or holding while the clock runs is not presentation and is bounded", () => {
  const { board, st, tick } = singleCamera();
  tick(20);
  st.lifecycle = "preparing";                // the clock keeps running while the camera reacquires
  tick(40);
  const report = board.report({ wallMs: st.nowMs, nowMs: st.nowMs });
  assert.match(report, /^- Drive Up: PROBLEM DETECTED \(unresolved\)$/m);
  assert.match(report, /Steady playback: PROBLEM DETECTED \(unresolved\) - 1 open problem incident\(s\): expected_transition_prolonged/);
  assert.match(report, /Not presenting while expected: acquiring 66\.7%, held 0\.0% of observed expected time/);
});

test("Blackboard camera headline carries R-09 short events separately from steady playback", () => {
  const { board, st, tick } = singleCamera();
  tick(20);
  for (const [frames, landed] of [[5, true], [1, true], [0, true], [0, false]]) {
    const start = st.epoch;
    board.autoSnapStart({ nowMs: st.nowMs, start, end: start + 1 }, [{ name: "Drive Up", frames: st.frames }]);
    board.autoSnapEnd({ nowMs: st.nowMs, epoch: start + 1 }, [{ name: "Drive Up", frames: st.frames + frames,
      coverage: "recorded", verifiedLanding: landed, landedEpoch: start, frameEpoch: start + 0.9 }]);
  }
  const report = board.report({ wallMs: st.nowMs, nowMs: st.nowMs });
  assert.match(report, /^- Drive Up: PROBLEM DETECTED \(R-09 short events\)\n {4}Steady playback: HEALTHY - verified 100\.0%[^\n]*\n {4}Short events: 3\/4 below visible-playback criterion \(flash 1, landed_only 1, nothing 1\)$/m);
});

test("Blackboard first heartbeat after a navigation credits traversal from the navigation target", () => {
  const { board, st, tick } = singleCamera({ rate: 4 });
  tick(4);
  const before = board.session.clock.continuousS;
  board.navigationStart({ nowMs: st.nowMs, source: "timeline click", target: T0 + 3600, fromEpoch: st.epoch,
    previousSettled: true });
  st.epoch = T0 + 3600;
  tick(1, 400);                              // 400 ms at 4x: 1.6 s of Review time since the target
  assert.ok(Math.abs(board.session.clock.continuousS - before - 1.6) < 1e-6);
  assert.equal(board.session.clock.discontinuities, 0);
  // The jump itself is never traversal.
  assert.ok(board.session.clock.continuousS < before + 2);
  assert.equal(board.session.clock.jumps.timeline.seconds, 3600 - 8);
});

test("Blackboard traversal is never credited as observed across hidden or late-heartbeat time", () => {
  const { board, st, tick } = singleCamera({ rate: 4 });
  tick(4);
  const clock = board.session.clock;
  const observed = clock.continuousS;
  tick(1, 3000);                             // a heartbeat 3 s late
  assert.equal(clock.continuousS, observed);
  assert.ok(Math.abs(clock.unobservedS - 12) < 1e-6);
  st.visible = false;
  tick(2);
  st.visible = true;
  tick(1);                                   // the boundary interval is still unobserved
  assert.equal(clock.continuousS, observed);
  assert.ok(Math.abs(clock.unobservedS - 18) < 1e-6);
  // An interval end reached while hidden is credited as unobserved too.
  const start = st.epoch;
  board.navigationStart({ nowMs: st.nowMs, source: "auto snap event", target: start, fromEpoch: st.epoch,
    previousSettled: true });
  board.autoSnapStart({ nowMs: st.nowMs, start, end: start + 0.8 }, [{ name: "Drive Up", frames: st.frames }]);
  board.autoSnapEnd({ nowMs: st.nowMs + 200, epoch: start + 0.8, visible: false },
    [{ name: "Drive Up", frames: st.frames, coverage: "recorded", visible: false }]);
  assert.equal(clock.continuousS, observed);
  assert.ok(Math.abs(clock.unobservedS - 18.8) < 1e-6);
});

test("Blackboard first-frame latency keeps its precision: observer-timed or heartbeat upper bound", () => {
  const { board, st, tick } = singleCamera();
  tick(2);
  for (const exact of [true, false]) {
    st.requestId = (st.requestId ?? 0) + 1;
    board.navigationStart({ nowMs: st.nowMs, source: "timeline click", target: st.epoch, fromEpoch: st.epoch,
      requestId: st.requestId, previousSettled: true });
    const started = st.nowMs;
    board.cameraEvent("Drive Up", "lifecycle", { nowMs: started, state: "preparing", previousState: "participating" });
    board.cameraEvent("Drive Up", "lifecycle", { nowMs: started + 120, state: "participating",
      previousState: "preparing", verified: true });
    if (exact) {
      st.playIssuedAtMs = started + 130;
      st.firstAdvanceAtMs = started + 310;
    } else {
      st.playIssuedAtMs = null;
      st.firstAdvanceAtMs = null;
    }
    tick(2);
  }
  const counts = board.session.navigation.bySource.timeline;
  assert.equal(counts.outcomes.settled_observed, 2);
  assert.equal(counts.landed, 2);
  assert.equal(counts.landingHist[0], 2, "landing 120 ms, from lifecycle timestamps");
  assert.equal(counts.presentedExact, 1);
  assert.equal(counts.frameHist[1], 1, "first advance 310 ms, from the frame observer");
  assert.equal(counts.frameBoundHist[2], 1, "otherwise only the heartbeat bound (<= 500 ms) is claimed");
  const report = board.report({ wallMs: st.nowMs, nowMs: st.nowMs });
  assert.match(report, /first frame <=500ms \(heartbeat\)/);
  assert.match(report, /first frame 310ms/);
});

// Synthetic reproduction of the October 18 seven-day Auto Snap report: 645 intervals at 4x,
// 4 events without coverage, 18 flashes, 2 landings only, 8 acquisitions superseded by the next
// event. The heartbeat runs every 500 ms of wall time throughout; short events fall between beats.
test("Blackboard reproduces the 645-interval Auto Snap report with corrected accounting", () => {
  const board = new ReviewBlackboard();
  const range = { from: T0, to: T0 + 7 * DAY };
  const st = { nowMs: 0, epoch: T0 + 383, running: false, frames: 0, lifecycle: "participating", held: false,
    preparing: false, requestId: 0, presentation: { id: 0 }, nextTick: 500, frameEpoch: T0 };
  board.open({ nowMs: 0, wallMs: 0, range, startEpoch: st.epoch, rate: 4, autoSnap: true, skipDeadspace: true,
    cameras: ["Drive Up"], visible: true, autoplay: true });
  const sample = () => board.sample({ nowMs: st.nowMs, wallMs: st.nowMs, epoch: st.epoch, running: st.running,
    rate: 4, visible: true, preparing: st.preparing && !st.running, navigationPreparing: st.preparing,
    requestId: st.requestId, rvfc: true, cameras: [{ name: "Drive Up", lifecycle: st.lifecycle, reason: null,
      transition: false, waiting: false, presentation: st.presentation, frames: st.frames,
      mediaEpoch: st.lifecycle === "participating" ? st.epoch : null, frameEpoch: st.frameEpoch, held: st.held,
      coverage: "recorded", recovery: null, firstAdvanceAtMs: null, playIssuedAtMs: null }] });
  // Wall time in 10 ms steps; frames every 100 ms while playing; a heartbeat every 500 ms.
  const advance = (ms, { frames = false } = {}) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 10) {
      st.nowMs += 10;
      if (st.running) st.epoch += 0.04;
      if (frames && st.lifecycle === "participating" && st.nowMs % 100 === 0) {
        st.frames += 1;
        st.frameEpoch = st.epoch;
      }
      if (st.nowMs >= st.nextTick) {
        st.nextTick += 500;
        sample();
      }
    }
  };
  // Short events spread through the run, never adjacent; four played events have no coverage.
  const shorts = [...Array(8).fill("nothing"), ...Array(2).fill("landed_only"), ...Array(18).fill("flash")];
  const plan = Array.from({ length: 645 }, (_, index) => ({ index, gap: [10, 200, 400, 600].includes(index),
    kind: index % 20 === 5 && index < 565 ? shorts[(index - 5) / 20] : "played" }));
  let eventStart = T0 + 383;
  let traversed = 0;
  for (const item of plan) {
    const short = item.kind !== "played";
    const duration = short ? 1 : 20;
    if (short) advance(st.nextTick - st.nowMs + 10);   // start just after a heartbeat
    const start = eventStart;
    const end = start + duration;
    eventStart += 900;
    board.autoSnapStart({ nowMs: st.nowMs, start, end }, [{ name: "Drive Up", frames: st.frames, visible: true }]);
    const previousSettled = !st.preparing;
    st.requestId += 1;
    board.navigationStart({ nowMs: st.nowMs, wallMs: st.nowMs, source: "auto snap event", target: start,
      fromEpoch: st.epoch, autoplay: true, requestId: st.requestId, previousSettled });
    if (st.lifecycle === "preparing") {
      // The controller supersedes an acquisition still in flight when the next seek begins.
      board.cameraEvent("Drive Up", "lifecycle", { nowMs: st.nowMs, state: "unavailable",
        previousState: "preparing", boundaryReason: "superseded_by_explicit_seek" });
      st.lifecycle = "unavailable";
    }
    st.running = false;
    st.preparing = true;
    st.epoch = start;
    st.held = st.lifecycle === "participating";
    board.cameraEvent("Drive Up", "lifecycle", { nowMs: st.nowMs, state: "preparing", previousState: st.lifecycle,
      boundaryReason: "explicit_seek" });
    st.lifecycle = "preparing";
    st.presentation = { id: item.index + 1 };
    advance(short ? 100 : 150);
    if (item.kind !== "nothing") {
      board.cameraEvent("Drive Up", "lifecycle", { nowMs: st.nowMs, state: "participating",
        previousState: "preparing", verified: true });
      st.lifecycle = "participating";
      st.held = false;
      st.preparing = false;
    }
    // The preparation deadline releases the clock even when the camera has not landed.
    st.running = true;
    if (item.kind === "flash") {
      st.frames += 1;
      st.frameEpoch = start + 0.1;
    }
    advance(duration * 250, { frames: item.kind === "played" });
    traversed += st.epoch - start;
    board.autoSnapEnd({ nowMs: st.nowMs, wallMs: st.nowMs, epoch: st.epoch, visible: true },
      [{ name: "Drive Up", frames: st.frames, coverage: item.gap ? "gap" : "recorded",
        verifiedLanding: item.kind !== "nothing", landedEpoch: start, frameEpoch: st.frameEpoch, visible: true }]);
    st.running = false;
    st.epoch = end;
    advance(short ? 50 : 300);
  }
  board.autoSnapStopped("finished", { nowMs: st.nowMs });
  advance(10000);

  const session = board.session;
  const camera = session.cameras.get("Drive Up");
  const nav = session.navigation.bySource.auto_snap;
  assert.equal(session.autoSnap.intervals, 645);
  assert.equal(nav.requested, 645);
  assert.deepEqual(nav.outcomes, { settled_observed: 617, settled_unsampled: 20, unsettled_replaced: 8,
    unsettled_window: 0, indeterminate: 0 }, "an unsampled settlement is never an operational supersession");
  assert.equal(nav.landed, 637);
  assert.equal(nav.notLanded, 8);
  assert.equal(nav.frameNotSampled, 20, "no first-frame latency is fabricated for unsampled navigations");
  assert.equal(nav.presentedExact, 0, "without observer timestamps only heartbeat bounds are claimed");
  assert.equal(camera.acquisitions.attempted, 645);
  assert.equal(camera.acquisitions.landed, 637);
  assert.deepEqual(camera.acquisitions.abandonedByReason, { superseded_by_explicit_seek: 8 });
  assert.deepEqual(camera.acquisitions.abandonedLinked, { nothing: 8 },
    "linked by interval identity, not by matching counts");
  // Every interval's Review time is credited, including those shorter than a heartbeat.
  assert.ok(Math.abs(session.clock.continuousS - traversed) < 1e-3,
    `continuous ${session.clock.continuousS} vs traversed ${traversed}`);
  assert.equal(session.clock.unobservedS, 0);
  assert.equal(session.clock.discontinuities, 0);
  // Expected excludes the clock-stopped navigation transitions.
  const account = board.cameraAccounting(camera);
  assert.equal(account.expected[BLACKBOARD_STATES.indexOf("held")], 0);
  assert.ok(account.stoppedTransitionMs > 0);
  const report = board.report({ wallMs: st.nowMs, nowMs: st.nowMs });
  assert.match(report, /^Session #1 \| Status: AUTO_SNAP_STOPPED: FINISHED \(copied while the session is open\)/m);
  assert.match(report, /^Completion: Auto Snap event traversal finished — no further events through the investigation range end\. This is event traversal, not continuous review of recording through the range end; stopped since then 10\.0s\.$/m);
  assert.match(report, /^- Drive Up: PROBLEM DETECTED \(R-09 short events\)\n {4}Steady playback: HEALTHY - verified 100\.0% of steady expected playback/m);
  assert.match(report, /^ {4}Short events: 28\/641 below visible-playback criterion \(flash 18, landed_only 2, nothing 8\)$/m);
  assert.match(report, /^ {2}Abandoned by reason: superseded_by_explicit_seek 8; started within an Auto Snap interval and linked to it 8 \(nothing 8\)$/m);
  assert.match(report, /auto_snap: requested 645; settled_observed 617, settled_unsampled 20, unsettled_replaced 8, unsettled_window 0, indeterminate 0/);
  assert.match(report, /^Review time traversed continuously: 3h 26m observed \+ 0ms unobserved \(2\.0% of the range\)\. ReviewClock motion only/m);
  assert.match(report, /^Outside visited time: before first visit 6m 23s, after last visit /m);
  assert.match(report, /acquisition yes \(abandoned: superseded_by_explicit_seek\)/);
});
