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

const { FrigateProvider } = await import(
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
