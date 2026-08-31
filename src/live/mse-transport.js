/*
 * MSE flow adapted from AlexxIT/go2rtc www/video-rtc.js (MIT),
 * revision f9234875463fac2110badad636c3bb4ad76e6bfd
 * (accessed 2026-08-31).
 */

const CODECS = [
  "avc1.640029",
  "avc1.64002A",
  "avc1.640033",
  "hvc1.1.6.L153.B0",
  "mp4a.40.2",
  "mp4a.40.5",
  "flac",
  "opus"
];

export class MseTransport {
  constructor(video, environment = globalThis) {
    this.video = video;
    this.environment = environment;
    this.status = "starting";
    this.listeners = [];
    this.queue = [];
    this.destroyed = false;
    this.firstFrame = new Promise((resolve, reject) => {
      this.resolveFirstFrame = resolve;
      this.rejectFirstFrame = reject;
    });
  }

  open(endpoint) {
    const MediaSourceClass =
      this.environment.ManagedMediaSource ??
      this.environment.MediaSource;
    if (!MediaSourceClass) {
      throw new Error("MSE is unavailable");
    }
    this.MediaSourceClass = MediaSourceClass;

    this.mediaSource = new MediaSourceClass();
    this.socket = new this.environment.WebSocket(endpoint);
    this.socket.binaryType = "arraybuffer";
    this.on(this.socket, "open", () => this.negotiate());
    this.on(this.socket, "message", event => this.onMessage(event));
    this.on(this.socket, "error", () => this.fail());
    this.on(this.socket, "close", () => {
      if (!this.destroyed && this.status !== "healthy") this.fail();
    });
    this.on(this.mediaSource, "sourceopen", () => this.negotiate());

    if ("ManagedMediaSource" in this.environment) {
      this.video.srcObject = this.mediaSource;
    } else {
      this.objectUrl = this.environment.URL.createObjectURL(this.mediaSource);
      this.video.src = this.objectUrl;
    }

    this.video.play().catch(() => {});
    this.frameCallback = this.video.requestVideoFrameCallback(() => {
      if (this.destroyed) return;
      this.status = "healthy";
      this.resolveFirstFrame({ presented: true });
    });
    return this.session();
  }

  negotiate() {
    if (
      this.negotiated ||
      this.socket?.readyState !== this.environment.WebSocket.OPEN ||
      this.mediaSource?.readyState !== "open"
    ) return;
    this.negotiated = true;
    const supported = CODECS.filter(codec =>
      this.MediaSourceClass.isTypeSupported(
        `video/mp4; codecs="${codec}"`
      )
    );
    this.socket.send(JSON.stringify({
      type: "mse",
      value: supported.join(",")
    }));
  }

  onMessage(event) {
    if (typeof event.data === "string") {
      const message = JSON.parse(event.data);
      if (message.type !== "mse" || this.sourceBuffer) return;
      this.sourceBuffer = this.mediaSource.addSourceBuffer(message.value);
      this.on(this.sourceBuffer, "updateend", () => {
        this.appendNext();
        this.maintainLiveBuffer();
      });
      this.on(this.sourceBuffer, "error", () => this.fail());
      this.appendNext();
      return;
    }
    this.queue.push(event.data);
    this.appendNext();
  }

  appendNext() {
    if (
      !this.sourceBuffer ||
      this.sourceBuffer.updating ||
      this.queue.length === 0
    ) return;
    this.sourceBuffer.appendBuffer(this.queue.shift());
  }

  maintainLiveBuffer() {
    const buffer = this.sourceBuffer;
    if (buffer?.updating || !buffer?.buffered?.length) return;
    const end = buffer.buffered.end(buffer.buffered.length - 1);
    const liveStart = end - 5;
    const bufferedStart = buffer.buffered.start(0);
    if (liveStart > bufferedStart) {
      buffer.remove(bufferedStart, liveStart);
      this.mediaSource.setLiveSeekableRange?.(liveStart, end);
      return;
    }
    if (this.video.currentTime < liveStart) {
      this.video.currentTime = liveStart;
    }
  }

  on(target, type, listener) {
    target.addEventListener(type, listener);
    this.listeners.push(() => target.removeEventListener(type, listener));
  }

  fail() {
    if (this.destroyed || this.status === "failed") return;
    this.status = "failed";
    this.rejectFirstFrame(new Error("Live stream failed before first frame"));
  }

  session() {
    return {
      transport: "mse",
      state: "starting",
      surface: this.video,
      firstFrame: this.firstFrame,
      stop: () => this.destroy(),
      destroy: () => this.destroy()
    };
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.status = "intentionally-idle";
    this.rejectFirstFrame(new Error("Live stream session destroyed"));
    this.listeners.splice(0).forEach(remove => remove());
    if (this.frameCallback !== undefined) {
      this.video.cancelVideoFrameCallback(this.frameCallback);
    }
    if (this.socket && this.socket.readyState < this.environment.WebSocket.CLOSING) {
      this.socket.close();
    }
    this.queue.length = 0;
    if (this.sourceBuffer?.updating) {
      try { this.sourceBuffer.abort(); } catch {}
    }
    if (this.mediaSource?.readyState === "open") {
      try {
        if (this.sourceBuffer) this.mediaSource.removeSourceBuffer(this.sourceBuffer);
        this.mediaSource.endOfStream();
      } catch {}
    }
    this.video.pause();
    this.video.srcObject = null;
    this.video.removeAttribute("src");
    if (this.objectUrl) this.environment.URL.revokeObjectURL(this.objectUrl);
    this.video.load();
  }
}
