import test from "node:test";
import assert from "node:assert/strict";

import {
  epochToMedia,
  HISTORICAL_MAP_QUANTIZATION_SECONDS,
  inspectHistoricalPresentationEndpoints,
  mediaToEpoch,
  validateHistoricalPresentation
} from "../src/review/historical-presentation.js";

function shiftedMediaPresentation(mediaStartPosition, quantizedMediaStartUs) {
  const value = presentation();
  const shift = quantizedMediaStartUs;
  return {
    ...value,
    media_start_position: mediaStartPosition,
    selected_media_position: mediaStartPosition + 5,
    logical_media_end_position: mediaStartPosition + 20,
    time_map: {
      ...value.time_map,
      spans: value.time_map.spans.map(span => [
        span[0], span[1], span[2] + shift, span[3] + shift
      ])
    }
  };
}

function presentation({ overlap = false, seam = false } = {}) {
  const secondStart = overlap ? 9_950_000 : seam ? 10_800_000 : 10_000_000;
  const secondEnd = secondStart + 10_000_000;
  return {
    schema: 2,
    camera: "garage",
    selected_epoch: 1005,
    resolved_selected_epoch: 1005,
    requested_wall_start: 1000,
    requested_wall_end: 1020,
    effective_wall_start: 1000,
    logical_wall_start: 1000,
    logical_wall_end: 1020,
    effective_absolute_origin: 1000,
    media_start_position: 0,
    selected_media_position: 5,
    logical_media_end_position: 20,
    coverage_run: {
      known_start: 1000,
      known_end: 1020,
      continues_before: false,
      continues_after: false
    },
    time_map: {
      epoch_origin: 1000,
      unit: "microseconds",
      spans: [[0, 10_000_000, 0, 10_000_000], [secondStart, secondEnd, 10_000_000, 20_000_000]]
    }
  };
}

test("validates and clones a sanitized presentation without DOM or Hls", () => {
  const value = validateHistoricalPresentation(presentation(), "garage");
  assert.equal(value.camera, "garage");
  assert.equal(value.time_map.spans.length, 2);
  assert.throws(() => validateHistoricalPresentation(presentation(), "drive_up"));
});

test("rejects malformed presentation responses", () => {
  for (const value of [
    null,
    { ...presentation(), schema: 1 },
    { ...presentation(), logical_wall_end: 1000 },
    { ...presentation(), time_map: { unit: "seconds", epoch_origin: 1000, spans: [] } },
    { ...presentation(), time_map: { ...presentation().time_map, spans: [[0, 1, 0, 2]] } },
  ]) assert.throws(() => validateHistoricalPresentation(value));
});

test("accepts the bounded upward microsecond rounding that froze the clock-holder successor", () => {
  const driveUpShape = shiftedMediaPresentation(1.0000006, 1_000_001);
  const diagnostic = inspectHistoricalPresentationEndpoints(driveUpShape);
  assert.ok(diagnostic.mediaStartUnderflowSeconds > 0);
  assert.ok(diagnostic.mediaStartUnderflowSeconds < HISTORICAL_MAP_QUANTIZATION_SECONDS);
  assert.equal(validateHistoricalPresentation(driveUpShape).media_start_position, 1.0000006);
});

test("same-boundary camera maps may round on opposite sides without changing truth", () => {
  const driveUpShape = shiftedMediaPresentation(1.0000006, 1_000_001);
  const driveDownShape = shiftedMediaPresentation(1.0000004, 1_000_000);
  assert.doesNotThrow(() => validateHistoricalPresentation(driveUpShape));
  assert.doesNotThrow(() => validateHistoricalPresentation(driveDownShape));
  assert.equal(epochToMedia(driveUpShape, 1005).resolvedEpoch, 1005);
  assert.equal(epochToMedia(driveDownShape, 1005).resolvedEpoch, 1005);
});

test("endpoint differences beyond integer-microsecond quantization still fail closed", () => {
  const malformed = shiftedMediaPresentation(0.999998, 1_000_000);
  assert.throws(
    () => validateHistoricalPresentation(malformed),
    error => error.message === "Historical presentation map endpoints were inconsistent." &&
      error.endpointDiagnostic.mediaStartUnderflowSeconds > HISTORICAL_MAP_QUANTIZATION_SECONDS
  );
});

test("maps epoch positions by interpolation", () => {
  const value = presentation();
  assert.equal(epochToMedia(value, 1005).mediaTime, 5);
  assert.equal(epochToMedia(value, 1015).mediaTime, 15);
});

test("maps media positions back to absolute epoch", () => {
  const value = presentation();
  assert.equal(mediaToEpoch(value, 5).epoch, 1005);
  assert.equal(mediaToEpoch(value, 15).epoch, 1015);
});

test("uses the following span at an exact media boundary", () => {
  const value = presentation({ seam: true });
  const mapped = mediaToEpoch(value, 10);
  assert.equal(mapped.epoch, 1010.8);
});

test("resolves an operational sub-tolerance epoch seam forward", () => {
  const value = presentation({ seam: true });
  const mapped = epochToMedia(value, 1010.4);
  assert.equal(mapped.mediaTime, 10);
  assert.equal(mapped.resolvedEpoch, 1010.8);
});

test("prefers the later media span when epoch spans overlap", () => {
  const value = presentation({ overlap: true });
  const mapped = epochToMedia(value, 1009.97);
  assert.ok(mapped.mediaTime >= 10);
});

test("logical end is a boundary sentinel, never a playable epoch", () => {
  const value = presentation();
  assert.equal(epochToMedia(value, 1020).isBoundary, true);
  assert.equal(mediaToEpoch(value, 20).isBoundary, true);
  assert.throws(() => epochToMedia(value, 1020.001));
});

test("provider look-ahead beyond logical media end is inaccessible", () => {
  const value = presentation();
  assert.throws(() => mediaToEpoch(value, 20.001));
});

test("handles a 360-span presentation with bounded binary searches", () => {
  const spans = Array.from({ length: 360 }, (_, index) => [
    index * 10_000_000,
    (index + 1) * 10_000_000,
    index * 10_000_000,
    (index + 1) * 10_000_000
  ]);
  const value = { ...presentation(), logical_wall_end: 4600, requested_wall_end: 4600,
    logical_media_end_position: 3600,
    coverage_run: { known_start: 1000, known_end: 4600, continues_before: false, continues_after: false },
    time_map: { epoch_origin: 1000, unit: "microseconds", spans } };
  const normalized = validateHistoricalPresentation(value);
  assert.equal(epochToMedia(normalized, 4599).mediaTime, 3599);
  assert.equal(mediaToEpoch(normalized, 3590).epoch, 4590);
});

test("accepts a full two-hour V2 map with an exclusive logical end", () => {
  const spans = Array.from({ length: 720 }, (_, index) => [
    index * 10_000_000, (index + 1) * 10_000_000,
    index * 10_000_000, (index + 1) * 10_000_000
  ]);
  const value = { ...presentation(), logical_wall_end: 8200, requested_wall_end: 8200,
    logical_media_end_position: 7200,
    coverage_run: { known_start: 1000, known_end: 8200, continues_before: false, continues_after: false },
    time_map: { epoch_origin: 1000, unit: "microseconds", spans } };
  const normalized = validateHistoricalPresentation(value);
  assert.equal(epochToMedia(normalized, 8199).mediaTime, 7199);
  assert.equal(mediaToEpoch(normalized, 7199).epoch, 8199);
  assert.equal(epochToMedia(normalized, 8200).isBoundary, true);
  assert.equal(mediaToEpoch(normalized, 7200).isBoundary, true);
  assert.throws(() => epochToMedia(normalized, 8200.001));
  assert.throws(() => mediaToEpoch(normalized, 7200.001));
});

test("maps both sides of clip 1080 in a 1101-span Lab presentation", () => {
  const spans = Array.from({ length: 1101 }, (_, index) => [
    index * 10_000_000, (index + 1) * 10_000_000,
    index * 10_000_000, (index + 1) * 10_000_000
  ]);
  const value = { ...presentation(), logical_wall_end: 12010, requested_wall_end: 12010,
    logical_media_end_position: 11010,
    coverage_run: { known_start: 1000, known_end: 12010, continues_before: false, continues_after: false },
    time_map: { epoch_origin: 1000, unit: "microseconds", spans } };
  const normalized = validateHistoricalPresentation(value);
  for (const epoch of [1001, 1000 + 1079 * 10 + 5, 1000 + 1080 * 10 + 5, 12009]) {
    const mapped = epochToMedia(normalized, epoch);
    assert.equal(mediaToEpoch(normalized, mapped.mediaTime).epoch, epoch);
  }
});
