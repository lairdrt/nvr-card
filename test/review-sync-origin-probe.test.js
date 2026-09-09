import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateOriginSeek,
  sanitizeTimingResult
} from "../experiments/review-sync-origin-probe.js";

test("Origin Probe calculates independent seeks from independent origins", () => {
  const target = 1800000015;
  assert.equal(
    calculateOriginSeek(target, { effective_absolute_origin: 1800000001 }),
    14
  );
  assert.equal(
    calculateOriginSeek(target, { effective_absolute_origin: 1799999997 }),
    18
  );
});

test("Origin Probe rejects invalid timing and origins after the target", () => {
  assert.throws(() => calculateOriginSeek(100, {}), /invalid VOD timing/);
  assert.throws(
    () => calculateOriginSeek(100, { effective_absolute_origin: 101 }),
    /origin after the target/
  );
});

test("Origin Probe strips paths, URLs, credentials, and unknown mapping data", () => {
  const safe = sanitizeTimingResult({
    camera: "drive_up",
    requested_start: 100,
    requested_end: 220,
    recording_start: 95,
    requested_clip_from_ms: 5000,
    adjusted_clip_from_ms: 2000,
    effective_absolute_origin: 97,
    calculated_target_seek: 18,
    path: "/media/frigate/private.mp4",
    url: "/api/frigate/private?authSig=secret",
    password: "secret",
    sequences: [{ clips: [] }]
  });
  assert.deepEqual(safe, {
    camera: "drive_up",
    requested_start: 100,
    requested_end: 220,
    recording_start: 95,
    requested_clip_from_ms: 5000,
    adjusted_clip_from_ms: 2000,
    effective_absolute_origin: 97,
    calculated_target_seek: 18
  });
  assert.equal(JSON.stringify(safe).includes("secret"), false);
  assert.equal(JSON.stringify(safe).includes("private"), false);
});
