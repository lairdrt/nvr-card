import { OneSeekVodExperiment } from "./one-seek-vod-experiment.js";
import { createAnchoredCameraTime, observeAnchoredCameraTime, anchoredCameraTime } from "../review/anchored-camera-time.js";

export const ANCHORED_SEAM_BUILD = "__ANCHORED_SEAM_BUILD__";

// Single-camera, explicit readiness barrier. Provider mapping after landing is
// diagnostic only; the inherited media pipeline performs no playback correction.
export class AnchoredSeamExperiment extends OneSeekVodExperiment {
  constructor(options) {
    super({ ...options, cameras: ["drive_up"] });
    if (!Number.isFinite(options.seamMediaTime)) throw new Error("Invalid seam position.");
    this.seamMediaTime = options.seamMediaTime;
    this.clock = null; this.anchorIdentity = null;
    this.trace = []; this.before = null; this.after = null;
  }

  prepare() { return super.startPlayback(); }

  // The inherited preparation calls this instead of invoking video.play().
  playPeers() { this.phase = "ready"; this.playStartedAt = null; return Promise.resolve(); }

  async play() {
    if (this.phase !== "ready" || this.destroyed || this.fatal) throw new Error("Seam experiment is not ready.");
    const peer = this.peers[0];
    peer.first = null; peer.latest = null; peer.rvfcCount = 0; peer.unmappedCount = 0;
    peer.seekingEventsBeforePlay = peer.seeking;
    this.phase = "playing"; this.playStartedAt = this.now();
    return super.playPeers();
  }

  onObservation(peer) {
    super.onObservation(peer);
    if (this.phase === "positioning" && peer.initial && !this.clock) {
      this.clock = createAnchoredCameraTime(peer.initial.representedEpoch, peer.initial.mediaTime);
      this.anchorIdentity = this.clock.anchor;
    }
    if (this.phase !== "playing") return;
    const frame = peer.latest;
    this.clock = observeAnchoredCameraTime(this.clock, this.anchorIdentity, frame.mediaTime);
    const span = peer.presentation.time_map.spans.findIndex(s => frame.mediaTime * 1e6 >= s[2] && frame.mediaTime * 1e6 < s[3]);
    const anchoredTime = anchoredCameraTime(this.clock);
    const sample = { wallMs: frame.wallMs, mediaTime: frame.mediaTime, anchoredTime,
      representedEpoch: frame.representedEpoch, span,
      mappingOffset: frame.representedEpoch === null ? null : frame.representedEpoch - frame.mediaTime,
      anchoredMinusPiecewise: frame.representedEpoch === null ? null : anchoredTime - frame.representedEpoch,
      readyState: peer.video.readyState };
    if (frame.mediaTime < this.seamMediaTime) this.before = sample;
    else if (!this.after) this.after = sample;
    if (Math.abs(frame.mediaTime - this.seamMediaTime) <= 2 && this.trace.length < 256) this.trace.push(sample);
  }

  report() {
    return { ...super.report(), build: ANCHORED_SEAM_BUILD,
      anchor: this.clock ? { ...this.clock.anchor } : null,
      seamMediaTime: this.seamMediaTime,
      secondsUntilSeamFromAnchor: this.clock ? this.seamMediaTime - this.clock.anchor.mediaTime : null,
      before: this.before, after: this.after, trace: this.trace.map(s => ({ ...s })) };
  }
}
