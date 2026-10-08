import { OneSeekVodExperiment } from "./one-seek-vod-experiment.js";
import { createAnchoredCameraTime, observeAnchoredCameraTime, anchoredCameraTime } from "../review/anchored-camera-time.js";

export const ANCHORED_PAIR_SEAM_BUILD = "__ANCHORED_PAIR_SEAM_BUILD__";
const SIGN = "drive_up minus drive_down";

// Legacy callback-time diagnostics only; these pairs are not synchronization
// evidence. Use independent flight recorders and offline display comparison.
export class AnchoredPairSeamExperiment extends OneSeekVodExperiment {
  constructor(options) {
    super({ ...options, cameras: ["drive_up", "drive_down"] });
    if (!Number.isFinite(options.seamMediaTime)) throw new Error("Invalid seam position.");
    this.seamMediaTime = options.seamMediaTime;
    this.trace = []; this.overview = []; this.before = null; this.after = null;
    this.pairCount = 0; this.firstPair = null; this.latestPair = null;
    this.ranges = { rawResidual: [Infinity, -Infinity], anchoredResidual: [Infinity, -Infinity], providerResidual: [Infinity, -Infinity] };
    for (const peer of this.peers) {
      peer.clock = null; peer.anchorIdentity = null; peer.anchorCount = 0;
      peer.pairedFrame = 0; peer.clockObservation = null;
      peer.mediaProgress = { steps: 0, backwards: 0, minDelta: null, maxDelta: null, maxCallbackIntervalMs: null };
    }
  }

  prepare() { return super.startPlayback(); }
  playPeers() { this.phase = "ready"; this.playStartedAt = null; return Promise.resolve(); }

  async play() {
    if (this.phase !== "ready" || this.destroyed || this.fatal) throw new Error("Pair experiment is not ready.");
    for (const peer of this.peers) {
      peer.first = null; peer.latest = null; peer.rvfcCount = 0; peer.unmappedCount = 0;
      peer.seekingEventsBeforePlay = peer.seeking;
    }
    this.phase = "playing"; this.playStartedAt = this.now();
    return super.playPeers();
  }

  // Native pair sampling runs before onObservation; use the completed clock
  // observations below instead, keeping all residuals in the same sign.
  observePair() {}

  onObservation(peer) {
    super.onObservation(peer);
    if (this.phase === "positioning" && peer.initial && !peer.clock) {
      peer.clock = createAnchoredCameraTime(peer.initial.representedEpoch, peer.initial.mediaTime);
      peer.anchorIdentity = peer.clock.anchor; peer.anchorCount += 1;
    }
    if (this.phase !== "playing") return;
    const frame = peer.latest, previous = peer.clockObservation;
    peer.clock = observeAnchoredCameraTime(peer.clock, peer.anchorIdentity, frame.mediaTime);
    const span = peer.presentation.time_map.spans.findIndex(s => frame.mediaTime * 1e6 >= s[2] && frame.mediaTime * 1e6 < s[3]);
    peer.clockObservation = { wallMs: frame.wallMs, mediaTime: frame.mediaTime,
      advancement: frame.mediaTime - peer.clock.anchor.mediaTime, anchoredTime: anchoredCameraTime(peer.clock),
      providerTime: frame.representedEpoch, span,
      mappingOffset: frame.representedEpoch === null ? null : frame.representedEpoch - frame.mediaTime,
      readyState: peer.video.readyState };
    if (previous) {
      const delta = frame.mediaTime - previous.mediaTime, progress = peer.mediaProgress;
      progress.steps += 1; if (delta < 0) progress.backwards += 1;
      progress.minDelta = Math.min(progress.minDelta ?? delta, delta);
      progress.maxDelta = Math.max(progress.maxDelta ?? delta, delta);
      progress.maxCallbackIntervalMs = Math.max(progress.maxCallbackIntervalMs ?? 0, frame.wallMs - previous.wallMs);
    }
    if (this.peers.some(p => !p.clockObservation || p.rvfcCount <= p.pairedFrame)) return;
    for (const p of this.peers) p.pairedFrame = p.rvfcCount;
    const [up, down] = this.peers.map(p => ({ ...p.clockObservation }));
    const sample = { wallMs: (up.wallMs + down.wallMs) / 2,
      observationSeparationMs: Math.abs(up.wallMs - down.wallMs), up, down,
      rawResidual: up.advancement - down.advancement,
      anchoredResidual: up.anchoredTime - down.anchoredTime,
      providerResidual: up.providerTime === null || down.providerTime === null ? null : up.providerTime - down.providerTime };
    this.pairCount += 1; this.firstPair ??= sample; this.latestPair = sample;
    for (const [key, range] of Object.entries(this.ranges)) if (sample[key] !== null) {
      range[0] = Math.min(range[0], sample[key]); range[1] = Math.max(range[1], sample[key]);
    }
    if (!this.overview.length || sample.wallMs - this.overview.at(-1).wallMs >= 1000) {
      if (this.overview.length < 64) this.overview.push(sample);
    }
    if (up.mediaTime < this.seamMediaTime) this.before = sample;
    else this.after ??= sample;
    if (Math.abs(up.mediaTime - this.seamMediaTime) <= 2 && this.trace.length < 256) this.trace.push(sample);
  }

  report() {
    return { ...super.report(), build: ANCHORED_PAIR_SEAM_BUILD,
      seamMediaTime: this.seamMediaTime,
      secondsUntilSeamFromAnchor: this.peers[0].clock ? this.seamMediaTime - this.peers[0].clock.anchor.mediaTime : null,
      anchors: this.peers.map(p => ({ camera: p.camera, anchor: p.clock ? { ...p.clock.anchor } : null,
        anchorCount: p.anchorCount, mediaProgress: { ...p.mediaProgress } })),
      pair: { name: "legacy-callback-time-diagnostic", synchronizationEvidence: false,
        sign: SIGN, sampleCount: this.pairCount, first: this.firstPair, latest: this.latestPair,
        ranges: Object.fromEntries(Object.entries(this.ranges).map(([key, range]) => [key,
          Number.isFinite(range[0]) ? { min: range[0], max: range[1] } : null])) },
      before: this.before, after: this.after, trace: this.trace.map(s => structuredClone(s)),
      overview: this.overview.map(s => structuredClone(s)) };
  }
}
