import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const cardSource = readFileSync(
  new URL("../../nvr-card.js", import.meta.url),
  "utf8"
);

export const defaultCameras = [
  { name: "Front", entity: "camera.front", active: true },
  { name: "Garage", entity: "camera.garage", active: true },
  { name: "Patio", entity: "camera.patio", active: true },
  { name: "Hall", entity: "camera.hall", active: true }
];

export function createTestHarness() {
  const window = new Window({
    url: "http://localhost/",
    width: 1280,
    height: 800
  });

  let nextFrameId = 1;
  const animationFrames = new Map();

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

    return { states };
  }

  function createCard({
    cameras = defaultCameras,
    hass = createHass(cameras),
    shellWidth = 1280
  } = {}) {
    const card = window.document.createElement("nvr-card");
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
      `hui-image[data-entity="${camera.entity}"]`
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
    setShellWidth,
    setCardRect,
    getPhysicalCells,
    getLogicalCell,
    getPlayer,
    capturePlayerIdentity,
    close
  };
}
