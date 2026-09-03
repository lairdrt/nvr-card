import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const baseCardSource = readFileSync(
  new URL("../../nvr-card.js", import.meta.url),
  "utf8"
);

export const defaultCameras = [
  { name: "Front", entity: "camera.front", active: true },
  { name: "Garage", entity: "camera.garage", active: true },
  { name: "Patio", entity: "camera.patio", active: true },
  { name: "Hall", entity: "camera.hall", active: true }
];

export function createTestHarness({
  useHaHuiImageExperiment = true,
  liveTransitionDiagnostics = false
} = {}) {
  const window = new Window({
    url: "http://localhost/",
    width: 1280,
    height: 800
  });

  let nextFrameId = 1;
  const animationFrames = new Map();
  let currentTime = 0;
  let nextIntervalId = 1;
  const intervals = new Map();
  const providerOpenCalls = [];
  const userStateBackend = new Map();
  const userStateCalls = [];

  class ImmediateResult {
    constructor(value, error = null) {
      this.value = value;
      this.error = error;
    }

    then(onFulfilled, onRejected) {
      try {
        if (this.error) {
          return onRejected
            ? ImmediateResult.from(onRejected(this.error))
            : this;
        }
        return ImmediateResult.from(onFulfilled(this.value));
      } catch (error) {
        return new ImmediateResult(undefined, error);
      }
    }

    catch(onRejected) {
      return this.error
        ? this.then(undefined, onRejected)
        : this;
    }

    finally(onFinally) {
      try {
        onFinally();
        return this;
      } catch (error) {
        return new ImmediateResult(undefined, error);
      }
    }

    static from(value) {
      return value instanceof ImmediateResult
        ? value
        : new ImmediateResult(value);
    }
  }

  class MockResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = new Set();
    }

    observe(target) {
      this.observed.add(target);
    }

    disconnect() {
      this.observed.clear();
    }
  }

  class MockHuiImage extends window.HTMLElement {
    constructor() {
      super();
      this.connectedCount = 0;
      this.disconnectedCount = 0;
    }

    connectedCallback() {
      this.connectedCount += 1;
    }

    disconnectedCallback() {
      this.disconnectedCount += 1;
    }
  }

  class MockNvrLivePresentation extends window.HTMLElement {
    constructor() {
      super();
      this.connectedCount = 0;
      this.disconnectedCount = 0;
      this.startCount = 0;
    }

    connectedCallback() {
      this.connectedCount += 1;
      if (this._hass && this._liveConfig && this.startCount === 0) {
        this.startCount += 1;
      }
    }

    disconnectedCallback() {
      this.disconnectedCount += 1;
    }

    set hass(value) {
      this._hass = value;
      if (this.isConnected && this._liveConfig && this.startCount === 0) {
        this.startCount += 1;
      }
    }

    set liveConfig(value) {
      this._liveConfig = value;
      if (this.isConnected && this._hass && this.startCount === 0) {
        this.startCount += 1;
      }
    }
  }

  class MockProviderPlayer extends window.HTMLElement {
    constructor() {
      super();
      this.connectedCount = 0;
      this.disconnectedCount = 0;
      this.closeCount = 0;
      this.cameraView = "live";
    }

    connectedCallback() {
      this.connectedCount += 1;
    }

    disconnectedCallback() {
      this.disconnectedCount += 1;
    }
  }

  class MockFrigateProvider {
    get experimentLimit() {
      return 11;
    }

    supports(camera) {
      return new Set([
        "camera.garage",
        "camera.front_door",
        "camera.front_entry",
        "camera.drive_up",
        "camera.drive_down",
        "camera.side_gate",
        "camera.ac",
        "camera.patio",
        "camera.backyard",
        "camera.fireplace",
        "camera.patio_roof"
      ]).has(camera?.entity);
    }

    open(camera, options) {
      const streamId =
        options.hass.states[camera.entity]
          ?.attributes?.camera_name;

      if (!streamId) {
        return null;
      }

      const element = window.document.createElement(
        "nvr-go2rtc-video"
      );
      element.className =
        "nvr-live-camera nvr-provider-live-camera";
      element.dataset.entity = camera.entity;
      element.dataset.stream = streamId;
      providerOpenCalls.push({ camera, options, element });

      return {
        element,
        close() {
          element.closeCount += 1;
          element.remove();
        }
      };
    }
  }

  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: MockResizeObserver
  });

  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: callback => {
      const frameId = nextFrameId++;
      animationFrames.set(frameId, callback);
      return frameId;
    }
  });

  Object.defineProperty(window.performance, "now", {
    configurable: true,
    value: () => currentTime
  });

  Object.defineProperty(window, "setInterval", {
    configurable: true,
    value: (callback, delay) => {
      const intervalId = nextIntervalId++;
      intervals.set(intervalId, {
        callback,
        delay,
        nextTime: currentTime + delay
      });
      return intervalId;
    }
  });

  Object.defineProperty(window, "clearInterval", {
    configurable: true,
    value: intervalId => {
      intervals.delete(intervalId);
    }
  });

  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: frameId => {
      animationFrames.delete(frameId);
    }
  });

  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      height: 800,
      offsetTop: 0,
      addEventListener() {},
      removeEventListener() {}
    }
  });

  window.customElements.define("hui-image", MockHuiImage);
  window.customElements.define(
    "nvr-live-presentation",
    MockNvrLivePresentation
  );
  window.customElements.define(
    "nvr-go2rtc-video",
    MockProviderPlayer
  );
  window.FrigateProvider = MockFrigateProvider;
  const cardSource = baseCardSource
    .replace(
      'import { FrigateProvider } from "./src/providers/frigate-provider.js";',
      "const FrigateProvider = window.FrigateProvider;"
    )
    .replace(
      "const USE_HA_HUI_IMAGE_EXPERIMENT = true;",
      `const USE_HA_HUI_IMAGE_EXPERIMENT = ${useHaHuiImageExperiment};`
    )
    .replace(
      "const NVR_LIVE_TRANSITION_DIAGNOSTICS = true;",
      `const NVR_LIVE_TRANSITION_DIAGNOSTICS = ${liveTransitionDiagnostics};`
    );
  window.eval(cardSource);

  function flushAnimationFrames() {
    while (animationFrames.size > 0) {
      const pending = [...animationFrames.entries()];
      animationFrames.clear();

      pending.forEach(([, callback]) => {
        callback(window.performance.now());
      });
    }
  }

  function advanceTime(milliseconds) {
    const targetTime = currentTime + milliseconds;

    while (true) {
      const next = [...intervals.entries()]
        .sort((left, right) => {
          return left[1].nextTime - right[1].nextTime;
        })[0];

      if (!next || next[1].nextTime > targetTime) {
        break;
      }

      const [intervalId, interval] = next;
      currentTime = interval.nextTime;
      interval.callback();

      if (intervals.has(intervalId)) {
        interval.nextTime += interval.delay;
      }
    }

    currentTime = targetTime;
  }

  function setDocumentVisibility(state) {
    Object.defineProperty(window.document, "visibilityState", {
      configurable: true,
      value: state
    });
    window.document.dispatchEvent(
      new window.Event("visibilitychange")
    );
  }

  function createHass(cameras = defaultCameras) {
    const states = {};

    cameras.forEach(camera => {
      if (camera.entity) {
        states[camera.entity] = {
          state: "streaming",
          attributes: {}
        };
      }
    });

    return {
      states,
      callWS(message) {
        userStateCalls.push(
          JSON.parse(JSON.stringify(message))
        );

        if (message.type === "frontend/get_user_data") {
          return new ImmediateResult({
            value: userStateBackend.has(message.key)
              ? JSON.parse(JSON.stringify(
                  userStateBackend.get(message.key)
                ))
              : null
          });
        }

        if (message.type === "frontend/set_user_data") {
          userStateBackend.set(
            message.key,
            JSON.parse(JSON.stringify(message.value))
          );
          return new ImmediateResult(null);
        }

        return new ImmediateResult(
          undefined,
          new Error(`Unexpected WebSocket type: ${message.type}`)
        );
      }
    };
  }

  function createCard({
    cameras = defaultCameras,
    hass = createHass(cameras),
    shellWidth = 1280,
    logicalCapacity = null
  } = {}) {
    const card = window.document.createElement("nvr-card");

    if (logicalCapacity !== null) {
      card._assignedCameras =
        new Array(logicalCapacity).fill(null);
    }

    window.document.body.appendChild(card);
    card.setConfig({ cameras });
    card.hass = hass;
    setShellWidth(card, shellWidth);
    flushAnimationFrames();
    return card;
  }

  function setShellWidth(card, width) {
    const shell = card.querySelector(".nvr-shell");
    Object.defineProperty(shell, "clientWidth", {
      configurable: true,
      value: width
    });
    card.updateResponsiveShell();
  }

  function setCardRect(card, rect = {}) {
    const haCard = card.querySelector("ha-card");
    haCard.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      right: 1280,
      bottom: 800,
      left: 0,
      width: 1280,
      height: 800,
      ...rect
    });
  }

  function getPhysicalCells(card) {
    return [...card.querySelectorAll(".video-cell")];
  }

  function getLogicalCell(card, slot) {
    return card.querySelector(
      `.video-cell[data-slot="${slot}"]`
    );
  }

  function getPlayer(card, cameraName) {
    const camera = card.getCameraByName(cameraName);
    if (!camera?.entity) {
      return null;
    }

    return card.querySelector(
      `.nvr-live-camera[data-entity="${camera.entity}"]`
    );
  }

  function capturePlayerIdentity(card, cameraName) {
    const player = getPlayer(card, cameraName);
    return {
      player,
      cell: player?.closest(".video-cell") ?? null,
      connectedCount: player?.connectedCount ?? 0,
      disconnectedCount: player?.disconnectedCount ?? 0
    };
  }

  function close() {
    window.close();
  }

  return {
    window,
    createCard,
    createHass,
    flushAnimationFrames,
    advanceTime,
    setDocumentVisibility,
    setShellWidth,
    setCardRect,
    getPhysicalCells,
    getLogicalCell,
    getPlayer,
    capturePlayerIdentity,
    providerOpenCalls,
    userStateBackend,
    userStateCalls,
    close
  };
}
