import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RESOURCE_POLICY,
  assertNvrProvider,
  createBrowserStreamDescriptor,
  createCameraDescriptor,
  createCameraId,
  createCameraLiveSource,
  createStreamVariant,
  createTransportPolicy,
  selectTransports
} from "../src/live/contracts.js";
import {
  CameraPresentationController,
  VideoHealthMonitor,
  planVisiblePresentations,
  selectStreamVariant
} from "../src/live/presentation.js";
import { Go2RtcGateway } from "../src/live/go2rtc-gateway.js";
import { MseTransport } from "../src/live/mse-transport.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeGateway {
  constructor(kind = "gateway-a") {
    this.kind = kind;
    this.resolved = [];
    this.released = [];
  }

  async resolve(source, request) {
    this.resolved.push({ source, request });
    return createBrowserStreamDescriptor({
      handle: `${this.kind}-${this.resolved.length}`,
      transports: this.kind === "gateway-a"
        ? {
            mse: { endpoint: `/stream/${this.resolved.length}/mse` },
            webrtc: { endpoint: `/stream/${this.resolved.length}/webrtc` }
          }
        : {
            hls: { endpoint: `/media/${this.resolved.length}.m3u8` },
            mjpeg: { endpoint: `/media/${this.resolved.length}.jpg` }
          }
    });
  }

  async release(handle) {
    this.released.push(handle);
  }

  async capabilities() {
    return { kind: this.kind };
  }
}

class FakeVideoEngine {
  constructor() {
    this.host = null;
    this.sessions = [];
    this.visible = true;
    this.muted = true;
    this.destroyed = false;
    this.healthState = { status: "healthy" };
    this.deferNextFrame = false;
    this.resources = {
      timer: true,
      frameCallback: true,
      webSocket: true,
      mediaSource: true,
      peerConnection: true,
      mediaTrack: true,
      eventListener: true
    };
  }

  attach(host) {
    this.host = host;
  }

  makeSession(descriptor, options, operation) {
    const frame = this.deferNextFrame ? deferred() : null;
    this.deferNextFrame = false;
    const session = {
      descriptor,
      options,
      operation,
      surface: { id: `surface-${this.sessions.length + 1}` },
      transport: options.transportOrder[0],
      state: "starting",
      firstFrame: frame?.promise ?? Promise.resolve({ presented: true }),
      stopped: false,
      destroyed: false,
      stop: async () => {
        session.stopped = true;
      },
      destroy: async () => {
        session.stopped = true;
        session.destroyed = true;
      },
      presentFrame: () => frame?.resolve({ presented: true })
    };
    this.sessions.push(session);
    return session;
  }

  async open(descriptor, options) {
    return this.makeSession(descriptor, options, "open");
  }

  async switchSource(descriptor, options) {
    return this.makeSession(descriptor, options, "switch");
  }

  health() {
    return this.healthState;
  }

  subscribeHealth() {
    return () => {};
  }

  setVisible(visible) {
    this.visible = visible;
  }

  setMuted(muted) {
    this.muted = muted;
  }

  async destroy() {
    Object.keys(this.resources).forEach(key => {
      this.resources[key] = false;
    });
    this.destroyed = true;
  }
}

function variantsFor(providerInstance, index) {
  const source = role => createCameraLiveSource({
    providerInstance,
    sourceId: `${index}-${role}`
  });
  return [
    createStreamVariant({
      id: `${index}-main`,
      role: "main",
      source: source("main"),
      video: { codec: "h264", width: 3840, height: 2160, fps: 20 }
    }),
    createStreamVariant({
      id: `${index}-sub`,
      role: "sub",
      source: source("sub"),
      video: { codec: "h264", width: 640, height: 360, fps: 10 }
    }),
    createStreamVariant({
      id: `${index}-custom`,
      role: "custom",
      source: source("custom")
    })
  ];
}

function camera(providerInstance, index) {
  return createCameraDescriptor({
    id: createCameraId(providerInstance, `camera-${index}`),
    display: { label: `Camera ${index}` },
    variants: variantsFor(providerInstance, index),
    capabilities: { snapshots: true }
  });
}

test("sixteen visible assigned cameras may open sixteen independent live sessions", async () => {
  const descriptors = Array.from({ length: 16 }, (_, index) =>
    camera("provider", index)
  );
  const planned = planVisiblePresentations(
    descriptors.map(descriptor => ({ descriptor, visible: true, assigned: true })),
    new Map(descriptors.map(descriptor => [descriptor.id, 400]))
  );
  assert.equal(planned.length, 16);
  assert.equal(DEFAULT_RESOURCE_POLICY.decoderBudget, undefined);

  const controllers = planned.map(({ camera: plannedCamera }) => {
    const engine = new FakeVideoEngine();
    return {
      engine,
      controller: new CameraPresentationController({
        host: { physicalCell: true },
        gateway: new FakeGateway(),
        engine,
        transportPolicy: createTransportPolicy("auto-balanced")
      }),
      camera: plannedCamera.descriptor
    };
  });
  await Promise.all(controllers.map(({ controller, camera: descriptor }) =>
    controller.present(descriptor, descriptor.variants[1])
  ));
  assert.equal(
    controllers.reduce((count, item) => count + item.engine.sessions.length, 0),
    16
  );
});

test("quality selection does not reduce the number of live presentations", () => {
  const descriptors = Array.from({ length: 16 }, (_, index) => camera("p", index));
  const state = descriptors.map(descriptor => ({
    descriptor,
    visible: true,
    assigned: true
  }));
  const widths = new Map(descriptors.map(descriptor => [descriptor.id, 320]));
  const subPlan = planVisiblePresentations(state, widths);
  const mainPlan = planVisiblePresentations(state, widths, {
    ...DEFAULT_RESOURCE_POLICY,
    qualityMode: "main"
  });
  assert.equal(subPlan.length, 16);
  assert.equal(mainPlan.length, 16);
  assert.ok(subPlan.every(item => item.variant.role === "sub"));
  assert.ok(mainPlan.every(item => item.variant.role === "main"));
});

test("variant selection supports main, sub, custom, missing metadata, and hysteresis", () => {
  const variants = variantsFor("p", 1);
  assert.equal(selectStreamVariant(variants, { qualityMode: "main" }).role, "main");
  assert.equal(selectStreamVariant(variants, { qualityMode: "sub" }).role, "sub");
  assert.equal(selectStreamVariant(variants, {
    qualityMode: "custom",
    customVariantId: "1-custom"
  }).role, "custom");
  assert.equal(selectStreamVariant(variants, { tileWidth: 400 }).role, "sub");
  assert.equal(selectStreamVariant(variants, { tileWidth: 1200 }).role, "main");

  const roleOnly = variants.map(variant => createStreamVariant({
    id: variant.id,
    role: variant.role,
    source: variant.source
  }));
  assert.equal(selectStreamVariant(roleOnly, { tileWidth: 400 }).role, "sub");
  assert.equal(selectStreamVariant(roleOnly, { tileWidth: 1200 }).role, "main");

  assert.strictEqual(selectStreamVariant(variants, {
    tileWidth: 680,
    previousVariant: variants[1]
  }), variants[1]);
  assert.strictEqual(selectStreamVariant(variants, {
    tileWidth: 800,
    previousVariant: variants[1]
  }), variants[0]);
});

test("healthy maximize with an unchanged variant reuses the current session", async () => {
  const descriptor = camera("p", 1);
  const engine = new FakeVideoEngine();
  const gateway = new FakeGateway();
  const host = { physicalCell: true };
  const controller = new CameraPresentationController({
    host,
    gateway,
    engine,
    transportPolicy: createTransportPolicy("auto-balanced")
  });
  const first = await controller.present(descriptor, descriptor.variants[0]);
  const maximized = await controller.present(descriptor, descriptor.variants[0], {
    maximized: true
  });
  assert.strictEqual(maximized, first);
  assert.equal(engine.sessions.length, 1);
  assert.equal(gateway.resolved.length, 1);
  assert.strictEqual(engine.host, host);
});

test("maximize and restore preserve the old surface until the replacement presents a frame", async () => {
  const descriptor = camera("p", 1);
  const engine = new FakeVideoEngine();
  const gateway = new FakeGateway();
  const host = { physicalCell: true };
  const controller = new CameraPresentationController({
    host,
    gateway,
    engine,
    transportPolicy: createTransportPolicy("prefer-reliability")
  });
  const sub = await controller.present(descriptor, descriptor.variants[1]);

  engine.deferNextFrame = true;
  const maximizing = controller.present(descriptor, descriptor.variants[0], {
    maximized: true
  });
  await new Promise(resolve => setImmediate(resolve));
  const pendingMain = engine.sessions[1];
  assert.equal(sub.stopped, false);
  assert.strictEqual(controller.current.session, sub);
  pendingMain.presentFrame();
  const main = await maximizing;
  assert.equal(sub.stopped, true);
  assert.strictEqual(controller.current.session, main);
  assert.strictEqual(engine.host, host);

  engine.deferNextFrame = true;
  const restoring = controller.present(descriptor, descriptor.variants[1], {
    maximized: false
  });
  await new Promise(resolve => setImmediate(resolve));
  const pendingSub = engine.sessions[2];
  assert.equal(main.stopped, false);
  assert.strictEqual(controller.current.session, main);
  pendingSub.presentFrame();
  const restored = await restoring;
  assert.equal(main.stopped, true);
  assert.strictEqual(controller.current.session, restored);
  assert.strictEqual(engine.host, host);
});

test("nominal media state without frame progress becomes suspected then stalled", () => {
  const monitor = new VideoHealthMonitor({
    suspectAfterMs: 2000,
    stallAfterMs: 4000
  });
  const sample = now => ({
    now,
    playbackExpected: true,
    visible: true,
    documentVisible: true,
    pausedByPolicy: false,
    ended: false,
    seeking: false,
    readyState: 4,
    paused: false,
    presentedFrames: 47156,
    currentTime: 2727.318,
    totalVideoFrames: 47156
  });
  assert.equal(monitor.observe(sample(0)).status, "healthy");
  assert.equal(monitor.observe(sample(2100)).status, "suspected-stall");
  assert.equal(monitor.observe(sample(4100)).status, "stalled");
  assert.equal(monitor.observe({ ...sample(4200), presentedFrames: 47157 }).status, "healthy");
});

test("health monitoring suppresses false stalls for intentionally idle playback", () => {
  const idleCases = [
    { documentVisible: false },
    { visible: false },
    { pausedByPolicy: true },
    { playbackExpected: false },
    { ended: true },
    { seeking: true }
  ];
  idleCases.forEach(overrides => {
    const monitor = new VideoHealthMonitor({ suspectAfterMs: 1, stallAfterMs: 2 });
    const result = monitor.observe({
      now: 100,
      playbackExpected: true,
      visible: true,
      documentVisible: true,
      pausedByPolicy: false,
      ended: false,
      seeking: false,
      presentedFrames: 1,
      currentTime: 1,
      totalVideoFrames: 1,
      ...overrides
    });
    assert.equal(result.status, "intentionally-idle");
  });
});

test("recovery is local to one controller and preserves its physical host", async () => {
  const descriptorA = camera("p", 1);
  const descriptorB = camera("p", 2);
  const engineA = new FakeVideoEngine();
  const engineB = new FakeVideoEngine();
  const hostA = { physicalCell: "a" };
  const hostB = { physicalCell: "b" };
  const makeController = (host, engine) => new CameraPresentationController({
    host,
    gateway: new FakeGateway(),
    engine,
    transportPolicy: createTransportPolicy("auto-balanced")
  });
  const controllerA = makeController(hostA, engineA);
  const controllerB = makeController(hostB, engineB);
  await controllerA.present(descriptorA, descriptorA.variants[1]);
  const sessionB = await controllerB.present(descriptorB, descriptorB.variants[1]);
  engineA.healthState = { status: "stalled" };
  await controllerA.recover();
  assert.equal(engineA.sessions.length, 2);
  assert.equal(engineB.sessions.length, 1);
  assert.equal(sessionB.stopped, false);
  assert.strictEqual(engineA.host, hostA);
  assert.strictEqual(engineB.host, hostB);
});

test("transport policy is independent of gateway implementation", async () => {
  const balanced = createTransportPolicy("auto-balanced");
  const reliable = createTransportPolicy("prefer-reliability");
  const latency = createTransportPolicy("prefer-low-latency");
  const fixed = createTransportPolicy("fixed", ["hls", "webrtc", "mse"]);
  const available = ["webrtc", "mse", "hls"];
  assert.deepEqual(selectTransports(balanced, available), ["mse", "webrtc", "hls"]);
  assert.deepEqual(selectTransports(reliable, available), ["mse", "hls", "webrtc"]);
  assert.deepEqual(selectTransports(latency, available), ["webrtc", "mse", "hls"]);
  assert.deepEqual(selectTransports(fixed, available), ["hls", "webrtc", "mse"]);

  for (const gateway of [new FakeGateway("gateway-a"), new FakeGateway("gateway-b")]) {
    const descriptor = await gateway.resolve(
      createCameraLiveSource({ providerInstance: "p", sourceId: "s" }),
      { variantId: "v" }
    );
    assert.ok(Object.keys(descriptor.transports).length > 0);
    assert.equal("go2rtc" in descriptor, false);
  }
});

test("Frigate-like and Dahua-like fixtures normalize without presentation branching", async () => {
  const normalizeFixture = fixture => createCameraDescriptor({
    id: createCameraId(fixture.providerInstance, fixture.cameraKey),
    display: { label: fixture.label },
    variants: fixture.streams.map(stream => createStreamVariant({
      id: stream.id,
      role: stream.role,
      source: createCameraLiveSource({
        providerInstance: fixture.providerInstance,
        sourceId: stream.sourceId
      })
    }))
  });
  const fixtures = [
    {
      providerInstance: "backend-a",
      cameraKey: "front",
      label: "Front",
      streams: [{ id: "main", role: "main", sourceId: "live-main" }]
    },
    {
      providerInstance: "backend-b",
      cameraKey: "channel-1",
      label: "Channel 1",
      streams: [{ id: "main", role: "main", sourceId: "channel-main" }]
    }
  ];
  const providers = fixtures.map(fixture => assertNvrProvider({
    async listCameras() {
      return [normalizeFixture(fixture)];
    }
  }));
  const normalized = (await Promise.all(
    providers.map(provider => provider.listCameras())
  )).flat();
  normalized.forEach(descriptor => {
    assert.equal(typeof descriptor.id, "string");
    assert.equal(descriptor.variants[0].role, "main");
    assert.deepEqual(Object.keys(descriptor.variants[0].source), [
      "providerInstance",
      "sourceId"
    ]);
  });
});

test("frontend descriptors reject credentials and proprietary camera source URLs", () => {
  const sentinel = "DO_NOT_EXPOSE";
  assert.throws(() => createBrowserStreamDescriptor({
    handle: "bad",
    transports: {
      mse: { endpoint: `https://user:${sentinel}@gateway.invalid/media` }
    }
  }), /credentials/);
  assert.throws(() => createBrowserStreamDescriptor({
    handle: "bad",
    transports: {
      webrtc: { endpoint: `rtsp://user:${sentinel}@camera.invalid/live` }
    }
  }), /camera source URLs/);
  assert.throws(() => createBrowserStreamDescriptor({
    handle: "bad",
    transports: {
      mse: { endpoint: "/media", password: sentinel }
    }
  }), /credentials/);
  assert.throws(() => createBrowserStreamDescriptor({
    handle: "bad",
    transports: {
      hls: { endpoint: `/media?username=user&password=${sentinel}` }
    }
  }), /credentials/);
  assert.throws(() => createBrowserStreamDescriptor({
    handle: "bad",
    transports: {
      hls: { endpoint: `onvif://user:${sentinel}@camera.invalid/profile` }
    }
  }), /camera source URLs/);

  let unsafeGetterRead = false;
  const source = createCameraLiveSource({
    providerInstance: "safe-provider",
    sourceId: "opaque-source",
    get rawUrl() {
      unsafeGetterRead = true;
      throw new Error(sentinel);
    }
  });
  assert.equal(unsafeGetterRead, false);
  assert.equal(JSON.stringify(source).includes(sentinel), false);
});

test("controller teardown establishes complete future resource-cleanup expectations", async () => {
  const descriptor = camera("p", 1);
  const engine = new FakeVideoEngine();
  const gateway = new FakeGateway();
  const controller = new CameraPresentationController({
    host: { physicalCell: true },
    gateway,
    engine,
    transportPolicy: createTransportPolicy("auto-balanced")
  });
  const session = await controller.present(descriptor, descriptor.variants[1]);
  await controller.destroy();
  assert.equal(session.stopped, true);
  assert.equal(session.destroyed, true);
  assert.equal(gateway.released.length, 1);
  assert.equal(engine.destroyed, true);
  assert.ok(Object.values(engine.resources).every(value => value === false));
});

class MockEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, properties = {}) {
    const event = { type, target: this, ...properties };
    [...(this.listeners.get(type) ?? [])].forEach(listener => listener(event));
  }
}

class MockSourceBuffer extends MockEventTarget {
  constructor() {
    super();
    this.updating = false;
    this.appended = [];
    this.aborted = false;
  }

  appendBuffer(data) {
    this.appended.push(data);
    this.updating = true;
  }

  finishAppend() {
    this.updating = false;
    this.dispatch("updateend");
  }

  abort() {
    this.aborted = true;
    this.updating = false;
  }
}

class MockMediaSource extends MockEventTarget {
  static isTypeSupported() {
    return true;
  }

  constructor() {
    super();
    this.readyState = "closed";
    this.sourceBuffers = [];
    MockMediaSource.instances.push(this);
  }

  open() {
    this.readyState = "open";
    this.dispatch("sourceopen");
  }

  addSourceBuffer(type) {
    this.sourceBufferType = type;
    const sourceBuffer = new MockSourceBuffer();
    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  }

  removeSourceBuffer(sourceBuffer) {
    this.removedSourceBuffer = sourceBuffer;
  }

  endOfStream() {
    this.ended = true;
    this.readyState = "ended";
  }
}
MockMediaSource.instances = [];

class MockWebSocket extends MockEventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch("open");
  }

  send(value) {
    this.sent.push(value);
  }

  message(data) {
    this.dispatch("message", { data });
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.closed = true;
    this.dispatch("close");
  }
}
MockWebSocket.instances = [];

function createMseFixture() {
  MockMediaSource.instances.length = 0;
  MockWebSocket.instances.length = 0;
  let nextFrameCallback = 1;
  const frameCallbacks = new Map();
  const video = {
    style: {},
    src: "",
    srcObject: null,
    paused: false,
    loadCalled: false,
    play: async () => {},
    pause() { this.paused = true; },
    load() { this.loadCalled = true; },
    removeAttribute(name) {
      if (name === "src") this.src = "";
    },
    requestVideoFrameCallback(callback) {
      const id = nextFrameCallback++;
      frameCallbacks.set(id, callback);
      return id;
    },
    cancelVideoFrameCallback(id) {
      frameCallbacks.delete(id);
      this.cancelledFrameCallback = id;
    }
  };
  const revoked = [];
  const environment = {
    MediaSource: MockMediaSource,
    WebSocket: MockWebSocket,
    URL: {
      createObjectURL: () => "blob:mse-test",
      revokeObjectURL: value => revoked.push(value)
    }
  };
  return {
    video,
    environment,
    revoked,
    presentFrame() {
      const callback = frameCallbacks.values().next().value;
      callback?.(0, {});
    },
    frameCallbacks
  };
}

test("Go2RtcGateway signs only the exact HA Frigate MSE proxy path", async () => {
  const calls = [];
  const hass = {
    async callWS(message) {
      calls.push(message);
      return {
        path: message.path + "&authSig=short-lived-signature"
      };
    }
  };
  const gateway = new Go2RtcGateway(hass, {
    location: { href: "https://ha.example/dashboard" }
  });
  const descriptor = await gateway.resolve(
    createCameraLiveSource({
      providerInstance: "test",
      sourceId: "garage"
    })
  );

  assert.deepEqual(calls, [{
    type: "auth/sign_path",
    path: "/api/frigate/go2rtc/ws/api/ws?src=garage",
    expires: 30
  }]);
  assert.equal(
    descriptor.transports.mse.endpoint,
    "wss://ha.example/api/frigate/go2rtc/ws/api/ws?src=garage&authSig=short-lived-signature"
  );
  const serialized = JSON.stringify(descriptor);
  assert.equal(serialized.includes("rtsp:"), false);
  assert.equal(serialized.includes("username"), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(serialized.includes(":1984"), false);
  assert.deepEqual(Object.keys(descriptor.transports), ["mse"]);
});

test("MSE transport negotiates, appends in order, presents a real first frame, and tears down", async () => {
  const fixture = createMseFixture();
  const transport = new MseTransport(fixture.video, fixture.environment);
  const session = transport.open("wss://ha.example/signed-playback");
  const socket = MockWebSocket.instances[0];
  const mediaSource = MockMediaSource.instances[0];
  let firstFrameResolved = false;
  session.firstFrame.then(() => {
    firstFrameResolved = true;
  });

  socket.open();
  assert.equal(socket.sent.length, 0);
  mediaSource.open();
  assert.equal(JSON.parse(socket.sent[0]).type, "mse");
  socket.message(JSON.stringify({
    type: "mse",
    value: 'video/mp4; codecs="avc1.640029"'
  }));
  assert.equal(mediaSource.sourceBuffers.length, 1);

  const sourceBuffer = mediaSource.sourceBuffers[0];
  const first = new ArrayBuffer(2);
  const second = new ArrayBuffer(3);
  socket.message(first);
  socket.message(second);
  assert.deepEqual(sourceBuffer.appended, [first]);
  sourceBuffer.finishAppend();
  assert.deepEqual(sourceBuffer.appended, [first, second]);

  socket.message("{\"type\":\"ignored\"}");
  fixture.video.readyState = 4;
  fixture.video.dispatchLoadedMetadata?.();
  await Promise.resolve();
  assert.equal(firstFrameResolved, false);
  fixture.presentFrame();
  await session.firstFrame;
  assert.equal(firstFrameResolved, true);
  assert.equal(transport.status, "healthy");

  await session.destroy();
  assert.equal(socket.closed, true);
  assert.equal(sourceBuffer.aborted, true);
  assert.strictEqual(mediaSource.removedSourceBuffer, sourceBuffer);
  assert.equal(mediaSource.ended, true);
  assert.deepEqual(fixture.revoked, ["blob:mse-test"]);
  assert.equal(fixture.video.paused, true);
  assert.equal(fixture.video.src, "");
  assert.equal(fixture.video.srcObject, null);
  assert.equal(fixture.video.loadCalled, true);
  assert.equal(fixture.frameCallbacks.size, 0);
  assert.equal(transport.queue.length, 0);
});

test("multiple MSE sessions isolate resources and one failure does not stop another", async () => {
  const first = createMseFixture();
  const firstTransport = new MseTransport(first.video, first.environment);
  const firstSession = firstTransport.open("wss://ha.example/signed-first");
  const firstSocket = MockWebSocket.instances[0];
  const firstMediaSource = MockMediaSource.instances[0];

  const second = createMseFixture();
  const secondTransport = new MseTransport(second.video, second.environment);
  const secondSession = secondTransport.open("wss://ha.example/signed-second");
  const secondSocket = MockWebSocket.instances[0];
  const secondMediaSource = MockMediaSource.instances[0];

  assert.notStrictEqual(firstSocket, secondSocket);
  assert.notStrictEqual(firstMediaSource, secondMediaSource);
  assert.notStrictEqual(first.frameCallbacks, second.frameCallbacks);

  for (const [socket, mediaSource] of [
    [firstSocket, firstMediaSource],
    [secondSocket, secondMediaSource]
  ]) {
    socket.open();
    mediaSource.open();
    socket.message(JSON.stringify({
      type: "mse",
      value: 'video/mp4; codecs="avc1.640029"'
    }));
  }

  const firstBuffer = firstMediaSource.sourceBuffers[0];
  const secondBuffer = secondMediaSource.sourceBuffers[0];
  assert.notStrictEqual(firstBuffer, secondBuffer);
  firstSocket.message(new ArrayBuffer(1));
  secondSocket.message(new ArrayBuffer(2));
  assert.equal(firstBuffer.appended[0].byteLength, 1);
  assert.equal(secondBuffer.appended[0].byteLength, 2);

  const firstFailure = assert.rejects(firstSession.firstFrame);
  firstSocket.dispatch("error");
  await firstFailure;
  assert.equal(firstTransport.status, "failed");
  assert.equal(secondTransport.status, "starting");

  second.presentFrame();
  await secondSession.firstFrame;
  assert.equal(secondTransport.status, "healthy");

  await firstSession.destroy();
  assert.equal(firstSocket.closed, true);
  assert.notEqual(secondSocket.closed, true);
  assert.equal(secondBuffer.aborted, false);

  await secondSession.destroy();
});
