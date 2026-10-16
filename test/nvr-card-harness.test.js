import assert from "node:assert/strict";
import test from "node:test";

import { createTestHarness } from "./helpers/nvr-card-harness.js";

const realNow = performance.now;

function assertRealPerformanceNow() {
  assert.equal(Object.getOwnPropertyDescriptor(performance, "now"), undefined);
  assert.strictEqual(performance.now, realNow);
  const before = performance.now();
  for (let index = 0; index < 1e6 && performance.now() === before; index += 1);
  assert.ok(performance.now() > before, "the real clock must advance");
}

test("harness fake clock is active only while the harness is open", t => {
  assertRealPerformanceNow();
  const harness = createTestHarness();
  t.after(() => harness.close());
  assert.strictEqual(harness.window.performance, performance);
  assert.equal(performance.now(), 0);
  harness.advanceTime(250);
  assert.equal(performance.now(), 250);
  harness.close();
  assertRealPerformanceNow();
});

for (const order of ["newest first", "oldest first"]) {
  test(`overlapping harnesses restore the real clock when closed ${order}`, t => {
    const older = createTestHarness();
    const newer = createTestHarness();
    t.after(() => { older.close(); newer.close(); });
    older.advanceTime(100);
    newer.advanceTime(700);
    assert.equal(performance.now(), 700, "the newest open harness owns the clock");
    if (order === "newest first") {
      newer.close();
      assert.equal(performance.now(), 100, "the remaining harness regains its clock");
      older.close();
    } else {
      older.close();
      assert.equal(performance.now(), 700, "closing an older harness keeps the newest clock");
      newer.close();
    }
    assertRealPerformanceNow();
  });
}

test("closing a harness twice cannot remove another harness's clock", t => {
  const first = createTestHarness();
  first.close();
  const second = createTestHarness();
  t.after(() => second.close());
  second.advanceTime(40);
  first.close();
  assert.equal(performance.now(), 40);
  second.close();
  second.close();
  assertRealPerformanceNow();
});
