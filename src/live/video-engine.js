import { MseTransport } from "./mse-transport.js";

export class VideoEngine {
  constructor(environment = globalThis) {
    this.environment = environment;
    this.visible = true;
    this.muted = true;
    this.listeners = new Set();
  }

  attach(host) {
    this.host = host;
    this.video = host.ownerDocument.createElement("video");
    Object.assign(this.video, {
      autoplay: true,
      muted: this.muted,
      playsInline: true
    });
    Object.assign(this.video.style, {
      display: "block",
      width: "100%",
      height: "100%",
      objectFit: "contain"
    });
    host.appendChild(this.video);
  }

  async open(descriptor) {
    const endpoint = descriptor.transports.mse?.endpoint;
    if (!endpoint) throw new Error("MSE endpoint unavailable");
    this.transport = new MseTransport(this.video, this.environment);
    this.currentSession = this.transport.open(endpoint);
    return this.currentSession;
  }

  async switchSource(descriptor) {
    void descriptor;
    throw new Error("Source switching is not implemented in Stage 2A");
  }

  health() {
    return { status: this.transport?.status ?? "starting" };
  }

  subscribeHealth(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setVisible(visible) {
    this.visible = visible;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.video) this.video.muted = muted;
  }

  async destroy() {
    await this.currentSession?.destroy();
    this.currentSession = null;
    this.transport = null;
    this.listeners.clear();
  }
}
