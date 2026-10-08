import test from "node:test";
import assert from "node:assert/strict";

import {
  anchoredCameraResidual,
  anchoredCameraTime,
  createAnchoredCameraTime,
  observeAnchoredCameraTime,
  provisionalReviewFrontier
} from "../src/review/anchored-camera-time.js";

function close(actual, expected, tolerance = 0.000001) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`);
}

function frame(state, mediaTime) {
  return observeAnchoredCameraTime(state, state.anchor, mediaTime);
}

test("landed anchor and media advancement preserve the absolute relationship", () => {
  const initial = createAnchoredCameraTime(1790448870.350, 2.350);
  const later = frame(initial, 102.350);
  close(anchoredCameraTime(initial), 1790448870.350);
  close(anchoredCameraTime(later), 1790448970.350);
  assert.equal(later.anchor, initial.anchor);
  assert.equal(initial.mediaTime, 2.350);
  assert.ok(Object.isFrozen(initial) && Object.isFrozen(initial.anchor));
  assert.ok(Object.isFrozen(later));
});

test("actual landing before or after the requested epoch remains observable", () => {
  const requested = 1000;
  for (const landed of [999.979, 1000.021]) {
    const state = createAnchoredCameraTime(landed, 2.350);
    close(anchoredCameraTime(state) - requested, landed - requested);
    close(anchoredCameraTime(frame(state, 12.350)), landed + 10);
  }
});

test("pause or buffering with unchanged mediaTime freezes camera time", () => {
  let state = createAnchoredCameraTime(1000, 2);
  state = frame(state, 12);
  for (let observation = 0; observation < 5; observation += 1) {
    state = frame(state, 12);
    assert.equal(anchoredCameraTime(state), 1010);
  }
});

test("four seconds of actual media progress advances time by four seconds", () => {
  // Represents 4x media progress over one wall second. Neither that elapsed
  // second nor a requested playbackRate participates in the calculation.
  const initial = createAnchoredCameraTime(1000, 2);
  assert.equal(anchoredCameraTime(frame(initial, 6)), 1004);
});

test("different native origins with equal normalized advancement remain aligned", () => {
  const first = createAnchoredCameraTime(1000, 2);
  const second = createAnchoredCameraTime(1000, 9);
  assert.equal(anchoredCameraResidual(frame(first, 102), frame(second, 109)), 0);
});

test("relative displacement includes different initial landed absolute anchors", () => {
  const first = createAnchoredCameraTime(1000, 2);
  const second = createAnchoredCameraTime(1000.020, 9);
  const laterFirst = frame(first, 102);
  const laterSecond = frame(second, 109);
  close(anchoredCameraTime(laterFirst), 1100);
  close(anchoredCameraTime(laterSecond), 1100.020);
  close(anchoredCameraResidual(laterFirst, laterSecond), -0.020);
  close(anchoredCameraResidual(laterSecond, laterFirst), 0.020);
});

test("one buffering camera produces a growing truthful residual", () => {
  const first = frame(createAnchoredCameraTime(1000, 2), 102);
  const second = frame(createAnchoredCameraTime(1000.020, 9), 109);
  const advancing = frame(first, 105);
  const buffering = frame(second, 109);
  close(anchoredCameraTime(advancing), 1103);
  close(anchoredCameraTime(buffering), 1100.020);
  close(anchoredCameraResidual(advancing, buffering), 2.980);
});

for (const seam of [
  { name: "backward", beforeMedia: 235.149, afterMedia: 235.150,
    beforeProvider: 1790449104.000, afterProvider: 1790449103.000, jump: -1 },
  { name: "forward", beforeMedia: 455.029, afterMedia: 455.030,
    beforeProvider: 1790449322.990, afterProvider: 1790449324.000, jump: 1.010 }
]) {
  test(`${seam.name} recording metadata seam does not change anchored progress or pair alignment`, () => {
    const first = createAnchoredCameraTime(1790448870.350, 2.350);
    const second = createAnchoredCameraTime(1790448870.370, 9.350);
    const firstBefore = frame(first, seam.beforeMedia);
    const firstAfter = frame(firstBefore, seam.afterMedia);
    const secondBefore = frame(second, seam.beforeMedia + 7);
    const secondAfter = frame(secondBefore, seam.afterMedia + 7);

    // These hypothetical old piecewise observations are deliberately outside
    // the anchored module: their discontinuity must never redefine its anchor.
    const oldBefore = seam.beforeProvider;
    const oldAfter = seam.afterProvider;
    close(oldAfter - oldBefore, seam.jump);
    close(anchoredCameraTime(firstAfter) - anchoredCameraTime(firstBefore), 0.001);
    close(firstAfter.mediaTime - first.anchor.mediaTime,
      secondAfter.mediaTime - second.anchor.mediaTime);
    close(anchoredCameraResidual(firstBefore, secondBefore), -0.020);
    close(anchoredCameraResidual(firstAfter, secondAfter), -0.020);

    // Only camera one's provider attribution jumps; camera two advances normally.
    const oldSecondBefore = oldBefore + 0.020;
    const oldSecondAfter = oldSecondBefore + 0.001;
    close((oldAfter - oldSecondAfter) - (oldBefore - oldSecondBefore), seam.jump - 0.001);
    assert.equal(firstAfter.anchor, first.anchor);
  });
}

test("arbitrary provider offset changes cannot enter subsequent observations", () => {
  const initial = createAnchoredCameraTime(1000, 2);
  for (const offset of [-100, -1, 0, 1.010, 100]) {
    const oldProviderPosition = 1100 + offset;
    const state = frame(initial, 102);
    assert.equal(anchoredCameraTime(state), 1100);
    close(oldProviderPosition - anchoredCameraTime(state), offset);
  }
});

test("explicit re-anchor replaces the relationship and rejects old observation ownership", () => {
  const previous = frame(createAnchoredCameraTime(1000, 2), 102);
  const current = createAnchoredCameraTime(2000, 5);
  assert.equal(anchoredCameraTime(current), 2000);
  assert.equal(observeAnchoredCameraTime(current, previous.anchor, 103), null);
  assert.equal(anchoredCameraTime(frame(current, 15)), 2010);
  assert.equal(anchoredCameraTime(previous), 1100);
});

test("replacement identity rejects stale work even with identical numeric anchors", () => {
  const previous = createAnchoredCameraTime(1000, 2);
  const current = createAnchoredCameraTime(1000, 2);
  assert.notEqual(previous.anchor, current.anchor);
  assert.equal(observeAnchoredCameraTime(current, previous.anchor, 20), null);
  assert.equal(current.mediaTime, 2);
});

test("external genuine-gap decision establishes a fresh relationship without bridging footage", () => {
  const edge = frame(createAnchoredCameraTime(1000, 2), 12);
  assert.equal(anchoredCameraTime(edge), 1010);
  // The external caller establishes that footage resumes at 1020 in a new
  // presentation. No observation here invents footage during [1010, 1020).
  const resumed = createAnchoredCameraTime(1020, 0);
  assert.equal(observeAnchoredCameraTime(resumed, edge.anchor, 13), null);
  assert.equal(anchoredCameraTime(resumed), 1020);
  assert.equal(anchoredCameraTime(frame(resumed, 1)), 1021);
});

test("provisional minimum frontier exposes buffering rather than deciding recovery", () => {
  const first = frame(createAnchoredCameraTime(1000, 2), 102);
  const second = frame(createAnchoredCameraTime(1000.020, 9), 109);
  close(provisionalReviewFrontier([first, second]), 1100);
  const advancing = frame(first, 105);
  close(provisionalReviewFrontier([advancing, second]), 1100.020);
  close(provisionalReviewFrontier([frame(advancing, 106), second]), 1100.020);
  assert.equal(provisionalReviewFrontier([]), null);
  assert.equal(provisionalReviewFrontier([advancing]), 1103);
  // Participant selection is external. A join can regress the candidate cursor;
  // the helper exposes that consequence instead of silently clamping it.
  assert.equal(provisionalReviewFrontier([advancing, createAnchoredCameraTime(1090, 0)]), 1090);
});

test("non-finite or coerced anchor and observation inputs are rejected", () => {
  for (const invalid of [NaN, Infinity, -Infinity, null, undefined, "2"]) {
    assert.throws(() => createAnchoredCameraTime(invalid, 2), TypeError);
    assert.throws(() => createAnchoredCameraTime(1000, invalid), TypeError);
    const state = createAnchoredCameraTime(1000, 2);
    assert.throws(() => observeAnchoredCameraTime(state, state.anchor, invalid), TypeError);
    assert.equal(anchoredCameraTime(state), 1000);
  }
});
