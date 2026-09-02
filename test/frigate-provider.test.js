import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";

const window = new Window({
  url: "https://home-assistant.example/lovelace/nvr"
});

Object.assign(globalThis, {
  customElements: window.customElements,
  document: window.document,
  HTMLElement: window.HTMLElement,
  location: window.location,
  window
});

const {
  EXPERIMENT_ACTIVE_CAMERA_LIMIT,
  EXPERIMENT_CAMERA_ENTITIES,
  FrigateProvider
} = await import(
  "../src/providers/frigate-provider.js"
);

test("FrigateProvider renews signing for each serialized VideoRTC connection", async () => {
  const calls = [];
  const sockets = [];
  const signedPaths = ["signed-a", "signed-b"];

  class MockWebSocket {
    static CLOSED = 3;
    static CONNECTING = 0;

    constructor(url) {
      this.url = url;
      this.binaryType = "";
      this.listeners = new Map();
      sockets.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    close() {}
  }

  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket;

  const hass = {
    states: {
      "camera.garage": {
        attributes: { camera_name: "garage" }
      }
    },
    callWS(message) {
      calls.push(message);
      return Promise.resolve({
        path:
          "/api/frigate/go2rtc/ws/api/ws" +
          `?src=garage&authSig=${signedPaths.shift()}`
      });
    }
  };

  try {
    const provider = new FrigateProvider();
    const opened = provider.open(
      { name: "Garage", entity: "camera.garage" },
      { hass }
    );

    assert.ok(opened.element instanceof window.HTMLElement);
    assert.equal(typeof opened.close, "function");
    assert.equal(opened.element.dataset.stream, "garage");
    assert.equal(opened.element.mode, "webrtc");
    assert.equal(opened.element.media, "video");
    assert.equal(opened.element.visibilityCheck, false);

    window.document.body.appendChild(opened.element);
    opened.element.onconnect();
    assert.equal(calls.length, 1);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(sockets.length, 1);
    assert.match(sockets[0].url, /authSig=signed-a$/);

    opened.element.ws = null;
    opened.element.wsState = MockWebSocket.CLOSED;
    opened.element.onconnect();
    opened.element.onconnect();
    assert.equal(calls.length, 2);

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(sockets.length, 2);
    assert.match(sockets[1].url, /authSig=signed-b$/);
    assert.notEqual(sockets[1].url, sockets[0].url);
    assert.deepEqual(calls, [
      {
        type: "auth/sign_path",
        path: "/api/frigate/go2rtc/ws/api/ws?src=garage",
        expires: 30
      },
      {
        type: "auth/sign_path",
        path: "/api/frigate/go2rtc/ws/api/ws?src=garage",
        expires: 30
      }
    ]);

    opened.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("FrigateProvider close invalidates a pending signed reconnect", async () => {
  let resolveSigning;
  const signing = new Promise(resolve => {
    resolveSigning = resolve;
  });
  const calls = [];
  const sockets = [];

  class MockWebSocket {
    static CLOSED = 3;
    static CONNECTING = 0;

    constructor(url) {
      sockets.push(url);
    }
  }

  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket;

  try {
    const opened = new FrigateProvider().open(
      { name: "Garage", entity: "camera.garage" },
      {
        hass: {
          states: {
            "camera.garage": {
              attributes: { camera_name: "garage" }
            }
          },
          callWS(message) {
            calls.push(message);
            return signing;
          }
        }
      }
    );

    window.document.body.appendChild(opened.element);
    opened.element.onconnect();
    assert.equal(calls.length, 1);

    opened.close();
    resolveSigning({
      path:
        "/api/frigate/go2rtc/ws/api/ws" +
        "?src=garage&authSig=too-late"
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(sockets.length, 0);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("FrigateProvider applies the ordered experiment camera limit", () => {
  const signRequests = [];
  const hass = {
    states: {
      "camera.garage": {
        attributes: { camera_name: "garage" }
      },
      "camera.front_door": {
        attributes: { camera_name: "front_door" }
      },
      "camera.drive_up": {
        attributes: { camera_name: "drive_up" }
      }
    },
    callWS(message) {
      signRequests.push(message);
      return new Promise(() => {});
    }
  };
  const provider = new FrigateProvider();
  const cameras = [
    { name: "Garage", entity: "camera.garage" },
    { name: "Front Door", entity: "camera.front_door" },
    { name: "Drive Up", entity: "camera.drive_up" }
  ];
  assert.equal(EXPERIMENT_ACTIVE_CAMERA_LIMIT, 11);
  assert.deepEqual(EXPERIMENT_CAMERA_ENTITIES.slice(0, 3), [
    "camera.garage",
    "camera.front_door",
    "camera.front_entry"
  ]);
  const orderedCameras = EXPERIMENT_CAMERA_ENTITIES.map(entity => ({
    name: entity,
    entity
  }));
  assert.deepEqual(
    orderedCameras.slice(0, 3).map(camera =>
      new FrigateProvider(2).supports(camera)
    ),
    [true, true, false]
  );
  assert.deepEqual(
    orderedCameras.slice(0, 3).map(camera =>
      new FrigateProvider(3).supports(camera)
    ),
    [true, true, true]
  );
  assert.equal(
    orderedCameras.every(camera =>
      new FrigateProvider(
        EXPERIMENT_CAMERA_ENTITIES.length
      ).supports(camera)
    ),
    true
  );
  assert.equal(
    provider.supports(
      { entity: "camera.not_configured" },
      EXPERIMENT_CAMERA_ENTITIES.length
    ),
    false
  );
  const experimentHass = {
    states: Object.fromEntries(
      EXPERIMENT_CAMERA_ENTITIES.map(entity => [
        entity,
        {
          attributes: {
            camera_name: entity.slice("camera.".length)
          }
        }
      ])
    )
  };
  for (const expectedCount of [2, 3, EXPERIMENT_CAMERA_ENTITIES.length]) {
    const limitedProvider = new FrigateProvider(expectedCount);
    const limitedHandles = orderedCameras.map(camera =>
      limitedProvider.open(camera, { hass: experimentHass })
    );
    assert.equal(
      limitedHandles.filter(Boolean).length,
      expectedCount
    );
    limitedHandles.filter(Boolean).forEach(handle => handle.close());
  }
  const opened = cameras.map(camera =>
    provider.open(camera, { hass })
  );

  assert.deepEqual(
    opened.map(handle => handle.element.dataset.stream),
    ["garage", "front_door", "drive_up"]
  );
  opened.forEach(handle => {
    assert.equal(handle.element.mode, "webrtc");
    assert.equal(handle.element.visibilityCheck, false);
    window.document.body.appendChild(handle.element);
  });
  assert.deepEqual(
    signRequests.map(request => request.path),
    [
      "/api/frigate/go2rtc/ws/api/ws?src=garage",
      "/api/frigate/go2rtc/ws/api/ws?src=front_door",
      "/api/frigate/go2rtc/ws/api/ws?src=drive_up"
    ]
  );
  assert.equal(
    signRequests.every(request => request.expires === 30),
    true
  );
  opened.forEach(handle => {
    handle.close();
  });
});

test("nvr-card leaves authentication and playback internals behind the provider", () => {
  const source = readFileSync(
    new URL("../nvr-card.js", import.meta.url),
    "utf8"
  );

  assert.equal(source.includes("auth/sign_path"), false);
  assert.equal(source.includes("MediaSource"), false);
  assert.equal(source.includes("SourceBuffer"), false);
  assert.equal(source.includes("src=garage"), false);
  assert.equal(source.toLowerCase().includes("go2rtc"), false);
});
