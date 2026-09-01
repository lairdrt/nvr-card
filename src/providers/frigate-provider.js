import { VideoRTC } from "../vendor/go2rtc/video-rtc.js";

const GARAGE_STREAM_ID = "garage";
const GARAGE_PROXY_PATH =
  "/api/frigate/go2rtc/ws/api/ws?src=garage";

class NvrGo2RtcVideo extends VideoRTC {
  configureAuthentication(hass) {
    this._nvrHass = hass;
    this._nvrClosed = false;
    this._nvrSigning = null;
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
    if (
      this._nvrClosed ||
      this._nvrSigning ||
      !this._nvrHass ||
      !this.isConnected ||
      this.ws ||
      this.pc
    ) {
      return false;
    }

    const signing = this._nvrHass.callWS({
      type: "auth/sign_path",
      path: GARAGE_PROXY_PATH,
      expires: 30
    });

    this._nvrSigning = signing;

    void signing
      .then(result => {
        if (
          this._nvrClosed ||
          !this.isConnected ||
          this._nvrSigning !== signing ||
          this.ws ||
          this.pc
        ) {
          return;
        }

        this.wsURL = toWebSocketUrl(result.path);
        super.onconnect();
      })
      .catch(error => {
        console.error(
          "Failed to sign Frigate live stream path:",
          error
        );
      })
      .finally(() => {
        if (this._nvrSigning === signing) {
          this._nvrSigning = null;
        }
      });

    return true;
  }

  closeProviderStream() {
    this._nvrClosed = true;
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
  open(camera, { hass }) {
    if (camera?.entity !== "camera.garage") {
      throw new Error("Garage provider proof only supports camera.garage.");
    }

    const element = document.createElement("nvr-go2rtc-video");
    element.className =
      "nvr-live-camera nvr-provider-live-camera";
    element.dataset.entity = camera.entity;
    element.dataset.stream = GARAGE_STREAM_ID;
    element.mode = "webrtc";
    element.media = "video";
    element.visibilityCheck = false;
    element.configureAuthentication(hass);

    let closed = false;

    return {
      element,
      close() {
        if (closed) {
          return;
        }

        closed = true;
        element.closeProviderStream();
        if (element.video) {
          element.ondisconnect();
        }
        element.remove();
      }
    };
  }
}
