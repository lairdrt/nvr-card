import { VideoRTC } from "../vendor/go2rtc/video-rtc.js";

const FRIGATE_PROXY_PATH =
  "/api/frigate/go2rtc/ws/api/ws";
export const EXPERIMENT_CAMERA_ENTITIES = Object.freeze([
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
]);
export const EXPERIMENT_ACTIVE_CAMERA_LIMIT = 11;
let nextPresentationId = 1;
let nextPlayerId = 1;

function traceProviderLifecycle(event, details) {
  console.info("[NVR provider lifecycle]", {
    event,
    ...details
  });
}

class NvrGo2RtcVideo extends VideoRTC {
  constructor() {
    super();
    this._nvrPlayerId = `player-${nextPlayerId++}`;
    this._nvrSignAttempt = 0;
  }

  configureAuthentication(hass, proxyPath, context) {
    this._nvrHass = hass;
    this._nvrProxyPath = proxyPath;
    this._nvrPresentationId = context.presentationId;
    this._nvrCameraEntity = context.cameraEntity;
    this._nvrStreamId = context.streamId;
    this._nvrClosed = false;
    this._nvrSigning = null;

    this.traceLifecycle("player-configured");
  }

  traceLifecycle(event, details = {}) {
    traceProviderLifecycle(event, {
      presentationId: this._nvrPresentationId ?? null,
      playerId: this._nvrPlayerId,
      cameraEntity: this._nvrCameraEntity ?? null,
      streamId: this._nvrStreamId ?? null,
      isConnected: this.isConnected,
      closed: this._nvrClosed ?? null,
      hasSigningRequest: Boolean(this._nvrSigning),
      hasWebSocket: Boolean(this.ws),
      hasPeerConnection: Boolean(this.pc),
      ...details
    });
  }

  connectedCallback() {
    this.traceLifecycle("connected-callback-start");
    super.connectedCallback();
    this.traceLifecycle("connected-callback-end");
  }

  disconnectedCallback() {
    this.traceLifecycle("disconnected-callback-start");
    super.disconnectedCallback();
    this.traceLifecycle("disconnected-callback-end", {
      disconnectScheduled: Boolean(this.disconnectTID)
    });
  }

  oninit() {
    super.oninit();
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.controls = false;
    this.video.style.objectFit = "contain";
  }

  onconnect() {
    this.traceLifecycle("onconnect-enter");

    if (
      this._nvrClosed ||
      this._nvrSigning ||
      !this._nvrHass ||
      !this.isConnected ||
      this.ws ||
      this.pc
    ) {
      this.traceLifecycle("onconnect-skipped");
      return false;
    }

    const signAttempt = ++this._nvrSignAttempt;
    this.traceLifecycle("sign-request-start", {
      signAttempt,
      proxyPath: this._nvrProxyPath,
      expires: 30
    });

    const signing = this._nvrHass.callWS({
      type: "auth/sign_path",
      path: this._nvrProxyPath,
      expires: 30
    });

    this._nvrSigning = signing;

    void signing
      .then(result => {
        const stale =
          this._nvrClosed ||
          !this.isConnected ||
          this._nvrSigning !== signing ||
          this.ws ||
          this.pc;

        this.traceLifecycle("sign-request-result", {
          signAttempt,
          stale: Boolean(stale),
          signedPathReceived: Boolean(result?.path)
        });

        if (stale) {
          return;
        }

        this.wsURL = toWebSocketUrl(result.path);
        const connectionStarted = super.onconnect();
        this.traceLifecycle("upstream-onconnect-result", {
          signAttempt,
          connectionStarted
        });
      })
      .catch(error => {
        this.traceLifecycle("sign-request-error", {
          signAttempt,
          errorName: error?.name ?? null,
          errorMessage: error?.message ?? String(error)
        });
        console.error(
          "Failed to sign Frigate live stream path:",
          error
        );
      })
      .finally(() => {
        if (this._nvrSigning === signing) {
          this._nvrSigning = null;
        }

        this.traceLifecycle("sign-request-finished", {
          signAttempt
        });
      });

    return true;
  }

  closeProviderStream() {
    this.traceLifecycle("close-provider-stream-start");
    this._nvrClosed = true;
    this.traceLifecycle("close-provider-stream-end");
  }
}

if (!customElements.get("nvr-go2rtc-video")) {
  customElements.define("nvr-go2rtc-video", NvrGo2RtcVideo);
}

function toWebSocketUrl(path) {
  const url = new URL(path, globalThis.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export class FrigateProvider {
  constructor(experimentLimit = EXPERIMENT_ACTIVE_CAMERA_LIMIT) {
    this._experimentLimit = experimentLimit;
  }

  get experimentLimit() {
    return this._experimentLimit;
  }

  supports(camera, limit = this._experimentLimit) {
    const cameraIndex =
      EXPERIMENT_CAMERA_ENTITIES.indexOf(camera?.entity);
    return cameraIndex >= 0 && cameraIndex < limit;
  }

  open(camera, { hass }) {
    if (!this.supports(camera)) {
      traceProviderLifecycle("provider-open-skipped", {
        presentationId: null,
        playerId: null,
        cameraEntity: camera?.entity ?? null,
        streamId: null,
        reason: "experiment-camera-limit"
      });
      return null;
    }

    const streamId =
      hass?.states?.[camera?.entity]?.attributes?.camera_name;

    if (
      typeof streamId !== "string" ||
      streamId.trim().length === 0
    ) {
      traceProviderLifecycle("provider-open-skipped", {
        presentationId: null,
        playerId: null,
        cameraEntity: camera?.entity ?? null,
        streamId: null,
        reason: "missing-camera-name"
      });
      return null;
    }

    const presentationId =
      `presentation-${nextPresentationId++}`;
    const proxyPath =
      `${FRIGATE_PROXY_PATH}?src=${encodeURIComponent(streamId)}`;

    traceProviderLifecycle("provider-open-start", {
      presentationId,
      playerId: null,
      cameraEntity: camera.entity,
      streamId,
      proxyPath
    });

    const element = document.createElement("nvr-go2rtc-video");
    element.className =
      "nvr-live-camera nvr-provider-live-camera";
    element.dataset.entity = camera.entity;
    element.dataset.stream = streamId;
    element.mode = "webrtc";
    element.media = "video";
    element.visibilityCheck = false;
    element.configureAuthentication(hass, proxyPath, {
      presentationId,
      cameraEntity: camera.entity,
      streamId
    });

    let closed = false;
    const diagnostic = Object.freeze({
      presentationId,
      playerId: element._nvrPlayerId,
      cameraEntity: camera.entity,
      streamId
    });

    traceProviderLifecycle("provider-open-return", {
      ...diagnostic,
      isConnected: element.isConnected
    });

    return {
      element,
      diagnostic,
      close() {
        traceProviderLifecycle("provider-close-called", {
          ...diagnostic,
          alreadyClosed: closed,
          isConnected: element.isConnected,
          parentConnected: element.parentElement?.isConnected ?? null
        });

        if (closed) {
          return;
        }

        closed = true;
        element.closeProviderStream();
        if (element.video) {
          element.ondisconnect();
        }
        element.remove();

        traceProviderLifecycle("provider-close-complete", {
          ...diagnostic,
          isConnected: element.isConnected,
          hasParent: Boolean(element.parentElement)
        });
      }
    };
  }
}
