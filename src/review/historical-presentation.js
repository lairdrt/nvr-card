const MICROSECONDS_PER_SECOND = 1_000_000;
const MAX_OPERATIONAL_SEAM_SECONDS = 1.5;
const MAX_SAFE_MICROSECONDS = Number.MAX_SAFE_INTEGER;
export const HISTORICAL_MAP_QUANTIZATION_SECONDS = 1 / MICROSECONDS_PER_SECOND;

function finite(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid historical presentation ${field}.`);
  return number;
}

function integer(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_MICROSECONDS) {
    throw new Error(`Invalid historical presentation ${field}.`);
  }
  return value;
}

function spanObjects(presentation) {
  const origin = presentation.time_map.epoch_origin;
  return presentation.time_map.spans.map(span => ({
    epochStart: origin + span[0] / MICROSECONDS_PER_SECOND,
    epochEnd: origin + span[1] / MICROSECONDS_PER_SECOND,
    mediaStart: span[2] / MICROSECONDS_PER_SECOND,
    mediaEnd: span[3] / MICROSECONDS_PER_SECOND
  }));
}

export function inspectHistoricalPresentationEndpoints(value) {
  const spans = Array.isArray(value?.time_map?.spans) ? value.time_map.spans : [];
  const first = spans[0];
  const last = spans.at(-1);
  const firstMedia = Array.isArray(first) && Number.isFinite(Number(first[2]))
    ? Number(first[2]) / MICROSECONDS_PER_SECOND : null;
  const lastMedia = Array.isArray(last) && Number.isFinite(Number(last[3]))
    ? Number(last[3]) / MICROSECONDS_PER_SECOND : null;
  const effectiveOrigin = Number.isFinite(Number(value?.effective_absolute_origin))
    ? Number(value.effective_absolute_origin) : null;
  const mapOrigin = Number.isFinite(Number(value?.time_map?.epoch_origin))
    ? Number(value.time_map.epoch_origin) : null;
  const mediaStart = Number.isFinite(Number(value?.media_start_position))
    ? Number(value.media_start_position) : null;
  const logicalMediaEnd = Number.isFinite(Number(value?.logical_media_end_position))
    ? Number(value.logical_media_end_position) : null;
  return Object.freeze({
    toleranceSeconds: HISTORICAL_MAP_QUANTIZATION_SECONDS,
    effectiveAbsoluteOrigin: effectiveOrigin,
    mapEpochOrigin: mapOrigin,
    originDeltaSeconds: effectiveOrigin === null || mapOrigin === null
      ? null : effectiveOrigin - mapOrigin,
    mediaStartPosition: mediaStart,
    firstSpanMediaStart: firstMedia,
    mediaStartUnderflowSeconds: mediaStart === null || firstMedia === null
      ? null : firstMedia - mediaStart,
    logicalMediaEndPosition: logicalMediaEnd,
    lastSpanMediaEnd: lastMedia,
    logicalEndOverflowSeconds: logicalMediaEnd === null || lastMedia === null
      ? null : logicalMediaEnd - lastMedia,
    spanCount: spans.length,
    firstSpan: Array.isArray(first) ? Object.freeze([...first]) : null,
    lastSpan: Array.isArray(last) ? Object.freeze([...last]) : null
  });
}

export function validateHistoricalPresentation(value, expectedCamera = null) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== 2 ||
      (expectedCamera !== null && value.camera !== expectedCamera)) {
    throw new Error("Historical presentation response was invalid.");
  }
  const fields = [
    "selected_epoch", "resolved_selected_epoch", "requested_wall_start",
    "requested_wall_end", "effective_wall_start", "logical_wall_start",
    "logical_wall_end", "effective_absolute_origin", "media_start_position",
    "selected_media_position", "logical_media_end_position"
  ];
  const output = { schema: 2, camera: value.camera };
  for (const field of fields) output[field] = finite(value[field], field);
  if (!(output.logical_wall_start < output.logical_wall_end) ||
      output.selected_epoch < output.logical_wall_start ||
      output.selected_epoch >= output.logical_wall_end ||
      output.resolved_selected_epoch < output.logical_wall_start ||
      output.resolved_selected_epoch >= output.logical_wall_end ||
      output.media_start_position < 0 ||
      output.selected_media_position < output.media_start_position ||
      output.logical_media_end_position < output.selected_media_position) {
    throw new Error("Historical presentation logical bounds were invalid.");
  }
  const coverage = value.coverage_run;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage) ||
      !Number.isFinite(Number(coverage.known_start)) ||
      !Number.isFinite(Number(coverage.known_end)) ||
      Number(coverage.known_start) >= Number(coverage.known_end) ||
      typeof coverage.continues_before !== "boolean" ||
      typeof coverage.continues_after !== "boolean") {
    throw new Error("Historical presentation coverage was invalid.");
  }
  output.coverage_run = Object.freeze({
    known_start: Number(coverage.known_start),
    known_end: Number(coverage.known_end),
    continues_before: coverage.continues_before,
    continues_after: coverage.continues_after
  });
  const map = value.time_map;
  if (!map || typeof map !== "object" || Array.isArray(map) || map.unit !== "microseconds" ||
      !Number.isFinite(Number(map.epoch_origin)) || !Array.isArray(map.spans) ||
      map.spans.length === 0) {
    throw new Error("Historical presentation time map was invalid.");
  }
  const spans = [];
  let previousMediaEnd = -1;
  let previousEpochStart = -Infinity;
  for (const raw of map.spans) {
    if (!Array.isArray(raw) || raw.length !== 4 ||
        !raw.every(Number.isSafeInteger)) throw new Error("Historical presentation span was invalid.");
    const values = raw.map((number, index) => integer(number, `span ${index}`));
    if (values[0] >= values[1] || values[2] >= values[3] ||
        values[2] < previousMediaEnd || values[0] < previousEpochStart) {
      throw new Error("Historical presentation spans were not ordered.");
    }
    previousMediaEnd = values[3];
    previousEpochStart = values[0];
    spans.push(Object.freeze(values));
  }
  const normalizedMap = Object.freeze({
    epoch_origin: Number(map.epoch_origin),
    unit: "microseconds",
    spans: Object.freeze(spans)
  });
  output.time_map = normalizedMap;
  const endpoints = inspectHistoricalPresentationEndpoints(output);
  if (Math.abs(endpoints.originDeltaSeconds) > HISTORICAL_MAP_QUANTIZATION_SECONDS ||
      endpoints.mediaStartUnderflowSeconds > HISTORICAL_MAP_QUANTIZATION_SECONDS ||
      endpoints.logicalEndOverflowSeconds > HISTORICAL_MAP_QUANTIZATION_SECONDS) {
    const error = new Error("Historical presentation map endpoints were inconsistent.");
    error.endpointDiagnostic = endpoints;
    throw error;
  }
  return Object.freeze(output);
}

function interpolate(span, epoch) {
  return span.mediaStart + (epoch - span.epochStart) *
    (span.mediaEnd - span.mediaStart) / (span.epochEnd - span.epochStart);
}

export function epochToMedia(presentation, epoch) {
  const value = validateHistoricalPresentation(presentation);
  const target = finite(epoch, "epoch");
  if (target === value.logical_wall_end) {
    return Object.freeze({ mediaTime: value.logical_media_end_position, resolvedEpoch: target, isBoundary: true });
  }
  if (target < value.logical_wall_start || target >= value.logical_wall_end) {
    throw new Error("Epoch is outside the logical historical presentation.");
  }
  const spans = spanObjects(value);
  let low = 0;
  let high = spans.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (spans[middle].epochStart <= target) {
      candidate = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  for (let index = Math.max(0, candidate); index < spans.length; index += 1) {
    const span = spans[index];
    if (span.epochStart > target) break;
    if (target < span.epochEnd) {
      return Object.freeze({ mediaTime: interpolate(span, target), resolvedEpoch: target, isBoundary: false });
    }
  }
  const next = spans.find(span => span.epochStart > target);
  if (!next || next.epochStart - target > MAX_OPERATIONAL_SEAM_SECONDS) {
    throw new Error("Epoch cannot be resolved to historical media.");
  }
  return Object.freeze({ mediaTime: next.mediaStart, resolvedEpoch: next.epochStart, isBoundary: false });
}

export function mediaToEpoch(presentation, mediaTime) {
  const value = validateHistoricalPresentation(presentation);
  const target = finite(mediaTime, "media time");
  if (target === value.logical_media_end_position) {
    return Object.freeze({ epoch: value.logical_wall_end, resolvedEpoch: value.logical_wall_end, isBoundary: true });
  }
  if (target < value.media_start_position || target > value.logical_media_end_position) {
    throw new Error("Media position is outside the logical historical presentation.");
  }
  const spans = spanObjects(value);
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const span = spans[middle];
    if (target < span.mediaStart) high = middle - 1;
    else if (target >= span.mediaEnd) low = middle + 1;
    else {
      const epoch = span.epochStart + (target - span.mediaStart) *
        (span.epochEnd - span.epochStart) / (span.mediaEnd - span.mediaStart);
      return Object.freeze({ epoch, resolvedEpoch: epoch, isBoundary: false });
    }
  }
  throw new Error("Media position cannot be resolved to historical time.");
}
