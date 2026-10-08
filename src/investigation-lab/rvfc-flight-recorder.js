const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const ownershipKeys = ["operationId", "sessionId", "presentationId"];
const identityValue = value => typeof value === "string" && value.length > 0 || Number.isFinite(value);

// Deterministic precedence: operation, session, presentation, media metadata,
// then proven pre-Play composition submission. Missing display time is data.
export function classifyRvfc(record, identity, currentOwnership, playReferenceMs) {
  for (const key of ownershipKeys) {
    if (record[key] !== identity[key] || record[key] !== currentOwnership?.[key]) {
      return { accepted: false, reason: `stale-${key.replace(/Id$/, "").toLowerCase()}` };
    }
  }
  if (record.mediaTime === null) return { accepted: false, reason: "missing-media-time" };
  if (record.presentationTime !== null && record.presentationTime < playReferenceMs) {
    return { accepted: false, reason: "submitted-before-play" };
  }
  return { accepted: true, reason: "accepted" };
}

// One camera only. Capture never maps provider epochs or compares cameras.
// Window uses JS entry time [Play, Play + duration); capacity keeps earliest
// records and drops newest, retaining startup evidence with explicit counters.
export class RvfcFlightRecorder {
  constructor({ camera, recorderId, operationId, sessionId, presentationId, timeOriginId,
    anchor, playReferenceMs, durationMs, maxRecords, now = () => performance.now(), currentOwnership }) {
    if (![camera, recorderId, operationId, sessionId, presentationId, timeOriginId, anchor?.id].every(identityValue) ||
        !Number.isFinite(anchor?.absoluteTime) || !Number.isFinite(anchor?.mediaTime) ||
        !Number.isFinite(playReferenceMs) || !Number.isFinite(durationMs) || durationMs <= 0 ||
        !Number.isSafeInteger(maxRecords) || maxRecords <= 0 || !Number.isFinite(playReferenceMs + durationMs)) {
      throw new Error("Invalid bounded RVFC capture contract.");
    }
    this.identity = Object.freeze({ camera, recorderId, operationId, sessionId, presentationId, timeOriginId });
    this.anchor = Object.freeze({ id: anchor.id, absoluteTime: anchor.absoluteTime, mediaTime: anchor.mediaTime });
    this.playReferenceMs = playReferenceMs; this.endMs = playReferenceMs + durationMs;
    this.maxRecords = maxRecords; this.now = now;
    this.currentOwnership = currentOwnership ?? (() => this.identity);
    this.records = []; this.sequence = 0; this.droppedNewest = 0;
    this.outsideWindow = 0; this.windowEnded = false;
  }

  capture(callbackNow, metadata, video, callbackOwnership = this.identity) {
    const entryNow = this.now(); // First operation: JS receipt, distinct from RVFC now.
    this.sequence += 1;
    if (!Number.isFinite(entryNow)) throw new Error("Invalid monotonic callback-entry time.");
    if (entryNow < this.playReferenceMs || entryNow >= this.endMs) {
      this.outsideWindow += 1;
      if (entryNow >= this.endMs) this.windowEnded = true;
      return null;
    }
    if (this.records.length >= this.maxRecords) { this.droppedNewest += 1; return null; }
    const mediaTime = finite(metadata?.mediaTime);
    const record = { ...this.identity,
      operationId: callbackOwnership.operationId, sessionId: callbackOwnership.sessionId,
      presentationId: callbackOwnership.presentationId, sequence: this.sequence,
      callbackNow: finite(callbackNow), entryNow, mediaTime,
      presentationTime: finite(metadata?.presentationTime), expectedDisplayTime: finite(metadata?.expectedDisplayTime),
      presentedFrames: finite(metadata?.presentedFrames), processingDuration: finite(metadata?.processingDuration),
      currentTime: finite(video.currentTime), readyState: finite(video.readyState), networkState: finite(video.networkState),
      paused: Boolean(video.paused), seeking: Boolean(video.seeking), ended: Boolean(video.ended),
      anchorId: this.anchor.id, normalizedAdvancement: mediaTime === null ? null : mediaTime - this.anchor.mediaTime,
      accepted: false, reason: "unclassified" };
    this.records.push(record); // Raw evidence exists before any classification.
    try { Object.assign(record, this.classify(record)); }
    catch { record.accepted = false; record.reason = "classification-error"; }
    return Object.freeze(record);
  }

  classify(record) { return classifyRvfc(record, this.identity, this.currentOwnership(), this.playReferenceMs); }

  snapshot() {
    return Object.freeze({ identity: this.identity, anchor: this.anchor, playReferenceMs: this.playReferenceMs,
      endMs: this.endMs, maxRecords: this.maxRecords, retention: "earliest-drop-newest",
      observedCallbacks: this.sequence, droppedNewest: this.droppedNewest, outsideWindow: this.outsideWindow,
      windowEnded: this.windowEnded, truncated: this.droppedNewest > 0,
      records: Object.freeze(this.records.slice()) });
  }
}

function currentRecords(trace) {
  return trace.records.filter(record => record.camera === trace.identity.camera &&
    record.recorderId === trace.identity.recorderId && record.timeOriginId === trace.identity.timeOriginId &&
    record.anchorId === trace.anchor.id && ownershipKeys.every(key => record[key] === trace.identity[key]) &&
    !record.reason.startsWith("stale-") && record.reason !== "classification-error" &&
    record.entryNow >= trace.playReferenceMs && record.entryNow < trace.endMs);
}

// Strict mediaTime > M0: no cadence or synchronization tolerance.
export function analyzeCameraTrace(trace) {
  const records = currentRecords(trace), repeatedAnchor = [], backwards = [], presentedFrameJumps = [];
  let previous = null;
  for (const record of records) {
    if (record.mediaTime === trace.anchor.mediaTime) repeatedAnchor.push(record);
    if (record.mediaTime !== null && (record.mediaTime < trace.anchor.mediaTime ||
        previous && previous.mediaTime !== null && record.mediaTime < previous.mediaTime)) backwards.push(record);
    if (previous && previous.presentedFrames !== null && record.presentedFrames !== null &&
        record.presentedFrames - previous.presentedFrames > 1) {
      presentedFrameJumps.push({ previous, record, countDelta: record.presentedFrames - previous.presentedFrames });
    }
    previous = record;
  }
  return { firstRaw: records[0] ?? null, firstAccepted: records.find(record => record.accepted) ?? null,
    firstAdvancing: records.find(record => record.mediaTime !== null && record.mediaTime > trace.anchor.mediaTime) ?? null,
    repeatedAnchor, backwards, presentedFrameJumps, currentRecordCount: records.length,
    truncated: trace.truncated, windowEnded: trace.windowEnded };
}

// Offline, directional nearest-coordinate candidates, with reuse permitted.
// Ties choose earlier display coordinate, then mediaTime, then sequence.
// Display time is expected visibility, not proof of physical scanout. There is
// no implicit fitness threshold; each candidate exposes its actual distance.
// Qualification means coordinate fitness only. Distinct media frames at one
// rounded display coordinate are ambiguous and cannot qualify a comparison.
export function compareDisplayCoordinates(traceA, traceB, { maxDistanceMs = null, acceptedOnly = false } = {}) {
  if (traceA.identity.timeOriginId !== traceB.identity.timeOriginId) throw new Error("Different document time origins.");
  if (maxDistanceMs !== null && (!Number.isFinite(maxDistanceMs) || maxDistanceMs < 0)) throw new Error("Invalid comparison distance.");
  const candidates = trace => currentRecords(trace).filter(record => record.mediaTime !== null &&
    record.expectedDisplayTime !== null && record.expectedDisplayTime >= trace.playReferenceMs &&
    record.expectedDisplayTime < trace.endMs &&
    (!acceptedOnly || record.accepted)).sort((a, b) => a.expectedDisplayTime - b.expectedDisplayTime ||
      a.mediaTime - b.mediaTime || a.sequence - b.sequence);
  const aRecords = candidates(traceA), bRecords = candidates(traceB);
  const ambiguousCoordinates = records => {
    const coordinates = new Set();
    for (let i = 1; i < records.length; i++) if (records[i].expectedDisplayTime === records[i - 1].expectedDisplayTime &&
        records[i].mediaTime !== records[i - 1].mediaTime) coordinates.add(records[i].expectedDisplayTime);
    return coordinates;
  };
  const ambiguousA = ambiguousCoordinates(aRecords), ambiguousB = ambiguousCoordinates(bRecords);
  const comparisons = aRecords.map(a => {
    // Binary search, then choose the first deterministic record at the winning coordinate.
    let low = 0, high = bRecords.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (bRecords[mid].expectedDisplayTime < a.expectedDisplayTime) low = mid + 1; else high = mid;
    }
    let index = low;
    if (index === bRecords.length || index > 0 &&
        a.expectedDisplayTime - bRecords[index - 1].expectedDisplayTime <= bRecords[index].expectedDisplayTime - a.expectedDisplayTime) index -= 1;
    if (index < 0) return { a, b: null, qualified: false, reason: "no-display-candidate" };
    const coordinate = bRecords[index].expectedDisplayTime;
    while (index > 0 && bRecords[index - 1].expectedDisplayTime === coordinate) index -= 1;
    const b = bRecords[index], separationMs = Math.abs(a.expectedDisplayTime - b.expectedDisplayTime);
    const advancementA = a.mediaTime - traceA.anchor.mediaTime, advancementB = b.mediaTime - traceB.anchor.mediaTime;
    const rawResidual = advancementA - advancementB;
    const ambiguityA = ambiguousA.has(a.expectedDisplayTime), ambiguityB = ambiguousB.has(b.expectedDisplayTime);
    return { a, b, expectedDisplayTimeA: a.expectedDisplayTime, expectedDisplayTimeB: b.expectedDisplayTime,
      separationMs, advancementA, advancementB, rawResidual,
      anchoredTimeA: traceA.anchor.absoluteTime + advancementA, anchoredTimeB: traceB.anchor.absoluteTime + advancementB,
      anchoredResidual: (traceA.anchor.absoluteTime - traceB.anchor.absoluteTime) + rawResidual,
      acceptedA: a.accepted, acceptedB: b.accepted, exactDisplayCoordinate: separationMs === 0,
      ambiguousA: ambiguityA, ambiguousB: ambiguityB,
      qualified: ambiguityA || ambiguityB ? false : maxDistanceMs === null ? null : separationMs <= maxDistanceMs,
      reason: ambiguityA || ambiguityB ? "ambiguous-display-coordinate" : maxDistanceMs === null ? "distance-reported-no-fitness-policy" :
        separationMs <= maxDistanceMs ? "within-requested-distance" : "outside-requested-distance" };
  });
  return { coordinate: "expectedDisplayTime", sign: "A minus B", maxDistanceMs, acceptedOnly,
    comparisons, excludedA: traceA.records.length - aRecords.length, excludedB: traceB.records.length - bRecords.length,
    truncationA: traceA.truncated, truncationB: traceB.truncated };
}
