import {
  createCameraDescriptor,
  createCameraId,
  createCameraLiveSource,
  createStreamVariant,
  createTransportPolicy
} from "./contracts.js";
import {
  CameraPresentationController
} from "./presentation.js";
import { Go2RtcGateway } from "./go2rtc-gateway.js";
import { VideoEngine } from "./video-engine.js";

export class NvrLivePresentation extends HTMLElement {
  constructor() {
    super();
    this.style.display = "block";
    this.style.width = "100%";
    this.style.height = "100%";
  }

  set hass(value) {
    this._hass = value;
    this.startIfReady();
  }

  set liveConfig(value) {
    this._liveConfig = value;
    this.startIfReady();
  }

  connectedCallback() {
    this.startIfReady();
  }

  disconnectedCallback() {
    void this.destroy();
  }

  async destroy() {
    this.generation = (this.generation ?? 0) + 1;
    const controller = this.controller;
    this.controller = null;
    await controller?.destroy();
  }

  async startIfReady() {
    if (
      !this.isConnected ||
      !this._hass ||
      !this._liveConfig ||
      this.controller
    ) return;

    const generation = (this.generation ?? 0) + 1;
    this.generation = generation;
    const source = createCameraLiveSource({
      providerInstance: "stage2a",
      sourceId: this._liveConfig.sourceId
    });
    const variant = createStreamVariant({
      id: this._liveConfig.variantId,
      role: this._liveConfig.role,
      source
    });
    const camera = createCameraDescriptor({
      id: createCameraId("stage2a", this._liveConfig.cameraId),
      display: {},
      variants: [variant]
    });
    const engine = new VideoEngine(globalThis);
    const controller = new CameraPresentationController({
      host: this,
      gateway: new Go2RtcGateway(this._hass),
      engine,
      transportPolicy: createTransportPolicy("fixed", ["mse"])
    });
    this.controller = controller;

    try {
      await controller.present(camera, variant);
    } catch {
      if (generation === this.generation) {
        await controller.destroy();
        this.controller = null;
        this.textContent = "Live stream unavailable";
      }
    }
  }
}

if (!customElements.get("nvr-live-presentation")) {
  customElements.define("nvr-live-presentation", NvrLivePresentation);
}
