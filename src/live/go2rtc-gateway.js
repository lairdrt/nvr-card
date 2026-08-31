import {
  createBrowserStreamDescriptor
} from "./contracts.js";

export class Go2RtcGateway {
  constructor(hass, environment = globalThis) {
    this.hass = hass;
    this.environment = environment;
  }

  async resolve(source) {
    const path =
      "/api/frigate/go2rtc/ws/api/ws?src=" +
      encodeURIComponent(source.sourceId);
    const signed = await this.hass.callWS({
      type: "auth/sign_path",
      path,
      expires: 30
    });
    const endpoint = new URL(
      signed.path,
      this.environment.location.href
    );
    endpoint.protocol = endpoint.protocol === "https:"
      ? "wss:"
      : "ws:";

    return createBrowserStreamDescriptor({
      handle: source.sourceId,
      transports: {
        mse: { endpoint: endpoint.href }
      }
    });
  }

  async release() {}

  async capabilities() {
    return { transports: ["mse"] };
  }
}
