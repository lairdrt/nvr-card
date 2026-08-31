export const TRANSPORT_KINDS = Object.freeze([
  "mse",
  "webrtc",
  "hls",
  "mp4",
  "mjpeg"
]);

export const VIDEO_HEALTH_STATES = Object.freeze([
  "starting",
  "healthy",
  "suspected-stall",
  "stalled",
  "recovering",
  "failed",
  "intentionally-idle"
]);

export const DEFAULT_RESOURCE_POLICY = Object.freeze({
  liveMode: "all-visible",
  qualityMode: "auto-by-tile",
  decoderBudget: undefined,
  aggregatePixelsPerSecond: undefined,
  aggregateBitrateKbps: undefined
});

/**
 * @typedef {object} StreamGateway
 * @property {function(object, object): Promise<object>} resolve
 * @property {function(string): Promise<void>} release
 * @property {function(): Promise<object>} capabilities
 *
 * @typedef {object} NvrProvider
 * @property {function(): Promise<object[]>} listCameras
 *
 * @typedef {object} VideoEngine
 * @property {function(HTMLElement): void} attach
 * @property {function(object, object): Promise<PlaybackSession>} open
 * @property {function(object, object): Promise<PlaybackSession>} switchSource
 * @property {function(): VideoHealth} health
 * @property {function(function(VideoHealth): void): function(): void} subscribeHealth
 * @property {function(boolean): void} setVisible
 * @property {function(boolean): void} setMuted
 * @property {function(): Promise<void>} destroy
 *
 * @typedef {object} PlaybackSession
 * @property {string} transport
 * @property {string} state
 * @property {HTMLElement|object} surface
 * @property {Promise<object>} firstFrame
 * @property {function(): Promise<void>} stop
 * @property {function(): Promise<void>} destroy
 *
 * @typedef {object} VideoHealth
 * @property {string} status
 * @property {number|null} lastProgressAt
 */

function requireOpaquePart(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return encodeURIComponent(value);
}

/** Creates an opaque, provider-namespaced logical camera identity. */
export function createCameraId(providerInstance, providerCameraId) {
  return `camera:${requireOpaquePart(providerInstance, "providerInstance")}:${requireOpaquePart(providerCameraId, "providerCameraId")}`;
}

/** Creates an opaque provider-side source reference; it contains no source URL. */
export function createCameraLiveSource({ providerInstance, sourceId }) {
  return Object.freeze({
    providerInstance: requireOpaquePart(providerInstance, "providerInstance"),
    sourceId: requireOpaquePart(sourceId, "sourceId")
  });
}

export function createStreamVariant({
  id,
  role,
  source,
  video,
  audio,
  capabilities
}) {
  if (!id || !role || !source) {
    throw new TypeError("StreamVariant requires id, role, and source");
  }
  return Object.freeze({
    id: String(id),
    role,
    source,
    ...(video ? { video: Object.freeze({ ...video }) } : {}),
    ...(audio ? { audio: Object.freeze({ ...audio }) } : {}),
    ...(capabilities
      ? { capabilities: Object.freeze({ ...capabilities }) }
      : {})
  });
}

export function createCameraDescriptor({ id, display, variants, capabilities }) {
  if (!id || !Array.isArray(variants) || variants.length === 0) {
    throw new TypeError("CameraDescriptor requires an id and stream variants");
  }
  return Object.freeze({
    id,
    display: Object.freeze({ ...(display ?? {}) }),
    variants: Object.freeze([...variants]),
    ...(capabilities
      ? { capabilities: Object.freeze({ ...capabilities }) }
      : {})
  });
}

function assertSafeEndpoint(endpoint) {
  if (typeof endpoint !== "string") {
    throw new TypeError("Browser transport endpoint must be a string");
  }
  const lower = endpoint.toLowerCase();
  if (lower.startsWith("rtsp:") || lower.startsWith("onvif:")) {
    throw new TypeError("Browser descriptors cannot contain camera source URLs");
  }
  let parsed;
  try {
    parsed = new URL(endpoint, "https://nvr.invalid/");
  } catch {
    throw new TypeError("Browser transport endpoint is invalid");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("Browser descriptors cannot contain credentials");
  }
  for (const key of parsed.searchParams.keys()) {
    if (["username", "user", "password", "pass", "credential"].includes(key.toLowerCase())) {
      throw new TypeError("Browser descriptors cannot contain credentials");
    }
  }
}

function assertSafeTransport(transport) {
  for (const key of Object.keys(transport)) {
    if (["username", "user", "password", "pass", "credentials"].includes(key.toLowerCase())) {
      throw new TypeError("Browser descriptors cannot contain credentials");
    }
  }
  assertSafeEndpoint(transport.endpoint);
}

/** Normalized browser-facing output from any StreamGateway. */
export function createBrowserStreamDescriptor({ handle, transports }) {
  if (!handle || !transports || typeof transports !== "object") {
    throw new TypeError("BrowserStreamDescriptor requires handle and transports");
  }
  const normalized = {};
  for (const [kind, transport] of Object.entries(transports)) {
    if (!TRANSPORT_KINDS.includes(kind)) {
      throw new TypeError(`Unsupported browser transport: ${kind}`);
    }
    assertSafeTransport(transport);
    normalized[kind] = Object.freeze({ ...transport });
  }
  return Object.freeze({
    handle: String(handle),
    transports: Object.freeze(normalized)
  });
}

/** Runtime checks for the deliberately small interface-only contracts. */
export function assertStreamGateway(gateway) {
  for (const method of ["resolve", "release", "capabilities"]) {
    if (typeof gateway?.[method] !== "function") {
      throw new TypeError(`StreamGateway must implement ${method}()`);
    }
  }
  return gateway;
}

export function assertNvrProvider(provider) {
  if (typeof provider?.listCameras !== "function") {
    throw new TypeError("NvrProvider must implement listCameras()");
  }
  return provider;
}

export function assertVideoEngine(engine) {
  for (const method of [
    "attach",
    "open",
    "switchSource",
    "health",
    "subscribeHealth",
    "setVisible",
    "setMuted",
    "destroy"
  ]) {
    if (typeof engine?.[method] !== "function") {
      throw new TypeError(`VideoEngine must implement ${method}()`);
    }
  }
  return engine;
}

export function createTransportPolicy(mode, transports) {
  if (
    ![
      "auto-balanced",
      "prefer-reliability",
      "prefer-low-latency",
      "fixed"
    ].includes(mode)
  ) {
    throw new TypeError(`Unknown transport policy: ${mode}`);
  }
  if (mode === "fixed" && (!Array.isArray(transports) || !transports.length)) {
    throw new TypeError("Fixed transport policy requires an ordered list");
  }
  return Object.freeze({
    mode,
    ...(transports ? { transports: Object.freeze([...transports]) } : {})
  });
}

export function selectTransports(policy, available) {
  const preferences = {
    "auto-balanced": ["mse", "webrtc", "hls", "mp4", "mjpeg"],
    "prefer-reliability": ["mse", "hls", "webrtc", "mp4", "mjpeg"],
    "prefer-low-latency": ["webrtc", "mse", "hls", "mp4", "mjpeg"]
  };
  const ordered = policy.mode === "fixed"
    ? policy.transports
    : preferences[policy.mode];
  return ordered.filter(kind => available.includes(kind));
}
