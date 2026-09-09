import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewRange,
  parseReviewTarget,
  sanitizeReviewError
} from "../experiments/review-sync-probe.js";

test("Review Probe builds the common 15-second-before and 120-second-after range", () => {
  const target = 1799500000;
  assert.deepEqual(buildReviewRange(target), {
    targetEpoch: target,
    rangeStart: target - 15,
    rangeEnd: target + 120,
    seekPosition: 15
  });
});

test("Review Probe parses ISO and numeric absolute timestamps", () => {
  assert.equal(parseReviewTarget("2026-09-08T14:00:00Z"), Date.parse("2026-09-08T14:00:00Z") / 1000);
  assert.equal(parseReviewTarget("1799500000"), 1799500000);
  assert.throws(() => parseReviewTarget("not a timestamp"), /Invalid target/);
});

test("Review Probe sanitizes signed URL details from errors", () => {
  assert.equal(
    sanitizeReviewError(
      new Error(
        "GET /api/frigate/vod/front/start/1/end/2/index.m3u8?authSig=secret failed"
      )
    ),
    "Error: [details redacted]"
  );
  assert.equal(
    sanitizeReviewError(new Error("No seekable HLS range became available.")),
    "Error: No seekable HLS range became available."
  );
});
