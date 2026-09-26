import { NativeVodSyncExperiment } from "./native-vod-sync-experiment.js";
import { epochToMedia } from "../review/historical-presentation.js";

export const ONE_SEEK_VOD_BUILD = "__ONE_SEEK_VOD_BUILD__";

// Initial positioning is the only additional controller. The inherited playing
// path only observes frames/events; it has no position or rate assignment.
export class OneSeekVodExperiment extends NativeVodSyncExperiment {
  constructor(options) {
    super(options);
    this.phase = "new";
    this.playStartedAt = null;
    for (const peer of this.peers) {
      peer.targetMediaTime = epochToMedia(peer.presentation, this.start).mediaTime;
      peer.initialWrites = 0; peer.initial = null; peer.staleInitialFrames = 0;
      peer.initialFrame = new Promise((resolve, reject) => {
        peer.resolveInitial = resolve; peer.rejectInitial = reject;
      });
    }
  }

  async startPlayback() {
    if (this.phase !== "new") throw new Error("One-seek experiment can run only once.");
    this.phase = "positioning";
    const initialFrames = Promise.all(this.peers.map(peer => peer.initialFrame));
    const timeout = setTimeout(() => {
      for (const peer of this.peers) if (!peer.initial) {
        peer.fatal = true; peer.rejectInitial(new Error("No mapped post-seek frame observed."));
      }
    }, 20000);
    try {
      this.loadSources();
      await initialFrames;
      if (this.destroyed || this.fatal) throw new Error("Initial media operation failed.");
    } finally { clearTimeout(timeout); }
    // Snapshot initial observations separately. Playback statistics begin here.
    for (const peer of this.peers) {
      peer.seekingEventsBeforePlay = peer.seeking;
      peer.first = null; peer.latest = null; peer.rvfcCount = 0; peer.unmappedCount = 0;
      const q = peer.video.getVideoPlaybackQuality?.();
      peer.baselineQuality = { total: q?.totalVideoFrames ?? null, dropped: q?.droppedVideoFrames ?? null };
    }
    this.samples.length = 0; this.lastSampleAt = null;
    this.phase = "playing"; this.playStartedAt = this.now();
    return this.playPeers();
  }

  onVideoCreated(peer, listen) {
    const tryInitialSeek = () => {
      if (this.destroyed || this.phase !== "positioning" || peer.initialWrites) return;
      const ranges = peer.video.seekable;
      let seekable = false;
      for (let i = 0; i < (ranges?.length ?? 0); i++) {
        if (ranges.start(i) <= peer.targetMediaTime && peer.targetMediaTime <= ranges.end(i)) seekable = true;
      }
      // Wait only for an assignable seek range, never for frame precision.
      if (!seekable) return;
      peer.times.seekInvoked = this.now(); peer.initialWrites = 1;
      try { peer.video.currentTime = peer.targetMediaTime; }
      catch { peer.fatal = true; peer.rejectInitial(new Error("Initial browser seek failed.")); }
    };
    for (const event of ["loadedmetadata", "progress", "canplay"]) listen(event, tryInitialSeek);
    listen("seeked", () => { peer.times.seeked ??= this.now(); });
  }

  acceptObservation(peer, metadata) {
    if (!peer.initialWrites) return false; // The initial operation has not begun.
    if (this.phase === "positioning") {
      if (Number.isFinite(metadata.presentationTime) && metadata.presentationTime < peer.times.seekInvoked) {
        peer.staleInitialFrames += 1; return false; // Proven pre-operation frame.
      }
      return peer.map(metadata.mediaTime) !== null;
    }
    // Exclude a queued pre-Play frame from playback measurements only.
    return !Number.isFinite(metadata.presentationTime) || metadata.presentationTime >= this.playStartedAt;
  }

  onObservation(peer) {
    if (this.phase !== "positioning" || peer.initial) return;
    const observed = peer.first, signedOffset = observed.representedEpoch - this.start;
    peer.initial = { ...observed, signedOffsetSeconds: signedOffset,
      absoluteOffsetSeconds: Math.abs(signedOffset), within1000ms: Math.abs(signedOffset) <= 1 };
    // Classification has no control effect. Every mapped current-operation
    // observation resolves, including frames before T or several seconds away.
    peer.resolveInitial();
  }

  observePair(wallMs) {
    if (this.phase === "playing") super.observePair(wallMs);
  }

  report() {
    const report = super.report();
    const [a,b] = this.peers.map(peer => peer.initial?.representedEpoch);
    return { ...report, build: ONE_SEEK_VOD_BUILD, phase: this.phase, playStartedAt: this.playStartedAt,
      playbackWallSeconds: this.playStartedAt === null ? null : ((this.finishedAt ?? this.now())-this.playStartedAt)/1000,
      architecture: { ...report.architecture, currentTimeWrites: this.peers.reduce((n,p)=>n+p.initialWrites,0),
        afterPlayCurrentTimeWrites: 0, afterPlayPlaybackRateWrites: 0, initialSeeksPerCamera: 1 },
      initialSignedPairSeconds: a === undefined || b === undefined ? null : b-a,
      peers: report.peers.map((result,index) => {
        const peer = this.peers[index];
        return { ...result, targetMediaTime: peer.targetMediaTime, initialCurrentTimeWrites: peer.initialWrites,
          initialSeeks: peer.initialWrites, initial: peer.initial ? {...peer.initial} : null,
          staleInitialFrames: peer.staleInitialFrames, seekingEventsBeforePlay: peer.seekingEventsBeforePlay ?? null,
          seekingEventsAfterPlay: peer.seekingEventsBeforePlay === undefined ? null : peer.seeking-peer.seekingEventsBeforePlay };
      }) };
  }

  destroy() {
    if (this.destroyed) return;
    for (const peer of this.peers) if (!peer.initial) peer.rejectInitial(new Error("Experiment torn down."));
    super.destroy();
  }
}
