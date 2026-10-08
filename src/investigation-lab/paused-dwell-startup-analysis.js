import { analyzeCameraTrace, compareDisplayCoordinates } from "./rvfc-flight-recorder.js";

const CAMERAS = ["drive_up", "drive_down"];
const SAMPLE_POINTS_MS = [250, 500, 1_000, 2_000, 3_000, 5_000, 10_000, 30_000];
const finite = value => Number.isFinite(value) ? value : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const p95 = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;
const relative = (value, origin) => value === null || value === undefined || origin === null ? null : value - origin;

function frame(record, trace, playReferenceMs) {
  if (!record) return null;
  return { sequence: record.sequence, accepted: record.accepted, reason: record.reason,
    mediaTime: record.mediaTime, advancement: record.mediaTime === null ? null : record.mediaTime - trace.anchor.mediaTime,
    callbackNowMs: relative(record.callbackNow, playReferenceMs),
    entryMs: relative(record.entryNow, playReferenceMs),
    presentationMs: relative(record.presentationTime, playReferenceMs),
    expectedDisplayMs: relative(record.expectedDisplayTime, playReferenceMs),
    presentedFrames: record.presentedFrames, readyState: record.readyState,
    networkState: record.networkState, paused: record.paused };
}

function stats(comparisons) {
  const signed = comparisons.map(value => value.anchoredResidual);
  const absolute = signed.map(Math.abs);
  return { count: comparisons.length, medianSignedSeconds: median(signed),
    medianAbsoluteSeconds: median(absolute), p95AbsoluteSeconds: p95(absolute),
    maximumAbsoluteSeconds: absolute.length ? Math.max(...absolute) : null,
    signedRangeSeconds: signed.length ? [Math.min(...signed), Math.max(...signed)] : null };
}

function compactComparison(value, playReferenceMs) {
  return { upSequence: value.a.sequence, downSequence: value.b.sequence,
    upExpectedDisplayMs: value.expectedDisplayTimeA - playReferenceMs,
    downExpectedDisplayMs: value.expectedDisplayTimeB - playReferenceMs,
    expectedDisplaySeparationMs: value.separationMs,
    upAdvancementSeconds: value.advancementA, downAdvancementSeconds: value.advancementB,
    rawResidualSeconds: value.rawResidual, anchoredResidualSeconds: value.anchoredResidual,
    upAccepted: value.acceptedA, downAccepted: value.acceptedB };
}

export function analyzePausedDwellTrial(result) {
  if (!result || !CAMERAS.every(camera => result.traces?.some(trace => trace?.identity?.camera === camera))) {
    throw new Error("Both independent raw traces are required.");
  }
  const playReferenceMs = finite(result.playReferenceMs);
  if (playReferenceMs === null) throw new Error("Play reference is required.");
  const traces = CAMERAS.map(camera => result.traces.find(trace => trace.identity.camera === camera));
  const camera = traces.map(trace => {
    const analysis = analyzeCameraTrace(trace);
    const accepted = trace.records.filter(record => record.accepted);
    const rejectedReasons = {};
    for (const record of trace.records) if (!record.accepted) {
      rejectedReasons[record.reason] = (rejectedReasons[record.reason] ?? 0) + 1;
    }
    const firstAcceptedAdvancing = accepted.find(record => record.mediaTime !== null &&
      record.mediaTime > trace.anchor.mediaTime) ?? null;
    const work = result.audit.cameras.find(value => value.camera === trace.identity.camera)?.callbackWork ?? [];
    const cost = work.map(value => value.exit - value.entry).filter(Number.isFinite);
    return { camera: trace.identity.camera, anchor: trace.anchor,
      rawCount: trace.records.length, acceptedCount: accepted.length, rejectedReasons,
      observedCallbacks: trace.observedCallbacks, droppedNewest: trace.droppedNewest,
      outsideWindow: trace.outsideWindow, truncated: trace.truncated, windowEnded: trace.windowEnded,
      repeatedAnchorCount: analysis.repeatedAnchor.length, backwardsCount: analysis.backwards.length,
      presentedFrameJumpCount: analysis.presentedFrameJumps.length,
      firstRaw: frame(analysis.firstRaw, trace, playReferenceMs),
      firstAccepted: frame(analysis.firstAccepted, trace, playReferenceMs),
      firstAdvancingRaw: frame(analysis.firstAdvancing, trace, playReferenceMs),
      firstAcceptedAdvancing: frame(firstAcceptedAdvancing, trace, playReferenceMs),
      callbackWorkMs: { count: cost.length, median: median(cost), p95: p95(cost),
        maximum: cost.length ? Math.max(...cost) : null } };
  });
  const comparison = compareDisplayCoordinates(traces[0], traces[1], { maxDistanceMs: 1, acceptedOnly: true });
  const qualified = comparison.comparisons.filter(value => value.qualified);
  const compact = qualified.map(value => compactComparison(value, playReferenceMs));
  const near = Object.fromEntries(SAMPLE_POINTS_MS.map(point => {
    const closest = compact.reduce((best, value) =>
      !best || Math.abs(value.upExpectedDisplayMs - point) < Math.abs(best.upExpectedDisplayMs - point)
        ? value : best, null);
    return [String(point), closest && Math.abs(closest.upExpectedDisplayMs - point) <= 125 ? closest : null];
  }));
  near.end = compact.at(-1) ?? null;
  const firstUp = camera[0].firstAcceptedAdvancing?.expectedDisplayMs;
  const firstDown = camera[1].firstAcceptedAdvancing?.expectedDisplayMs;
  return { trialId: result.trialId, condition: result.condition, sign: "drive_up minus drive_down",
    status: result.status, contaminated: result.contaminated, contaminationReasons: result.contaminationReasons,
    sourceStart: result.sourceStart, requestedT: result.requestedT, sourceEnd: result.sourceEnd,
    actualRunDurationMs: result.actualRunDurationMs, readyToPlayMs: relative(playReferenceMs, result.readyAt),
    laterAnchorToPlayMs: result.laterAnchorToPlayMs,
    anchorDifferenceSeconds: traces[0].anchor.absoluteTime - traces[1].anchor.absoluteTime,
    firstAdvancingExpectedDisplayDifferenceMs: firstUp === null || firstDown === null ? null : firstUp - firstDown,
    camera, comparisonPolicy: { coordinate: "expectedDisplayTime", maxDistanceMs: 1,
      acceptedOnly: true, interpolation: false },
    totalCandidateComparisons: comparison.comparisons.length, qualifiedCount: compact.length,
    earliestQualified: compact[0] ?? null, near, windows: {
      firstFiveSeconds: stats(qualified.filter(value => value.expectedDisplayTimeA - playReferenceMs < 5_000)),
      firstTenSeconds: stats(qualified.filter(value => value.expectedDisplayTimeA - playReferenceMs < 10_000)),
      fullPlayback: stats(qualified)
    }, qualifiedComparisons: compact };
}
