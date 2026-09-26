import { validateHistoricalPresentation } from "../review/historical-presentation.js";

export const NATIVE_VOD_BUILD = "__NATIVE_VOD_BUILD__";
const CAMERAS = ["drive_up", "drive_down"];
const SAMPLE_LIMIT = 256;
const ERROR_LIMIT = 16;
const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const label = value => typeof value === "string" && /^[A-Za-z0-9_. -]{1,80}$/.test(value) ? value : null;
const quality = video => {
  const value = video.getVideoPlaybackQuality?.();
  return { total: number(value?.totalVideoFrames), dropped: number(value?.droppedVideoFrames) };
};
const percentile = (values, fraction) => values.length
  ? values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] : null;

// Native media includes keyframe lead-in. This map covers the full returned
// media, not the logical [T,E] crop used by Place. Mapping failure is data only.
function mapper(presentation) {
  const { epoch_origin: origin, spans } = presentation.time_map;
  return mediaTime => {
    if (number(mediaTime) === null) return null;
    const us = mediaTime * 1_000_000;
    let low = 0, high = spans.length - 1;
    while (low <= high) {
      const index = (low + high) >> 1, span = spans[index];
      if (us < span[2]) high = index - 1;
      else if (us >= span[3]) low = index + 1;
      else return origin + (span[0] + (us - span[2]) * (span[1] - span[0]) / (span[3] - span[2])) / 1_000_000;
    }
    return null;
  };
}

export class NativeVodSyncExperiment {
  constructor({ start, end, preparations, Hls, createVideo, getAuth, expectedOrigin,
    now = () => performance.now() }) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Invalid native VOD interval.");
    this.start = start; this.end = end; this.Hls = Hls;
    this.createVideo = createVideo; this.getAuth = getAuth;
    this.origin = new URL(expectedOrigin).origin; this.now = now;
    this.peers = CAMERAS.map((camera, index) => {
      const prepared = preparations.find(value => value.camera === camera);
      if (prepared?.requestedStart !== start || prepared?.requestedEnd !== end) throw new Error("Native VOD bounds differ.");
      const presentation = validateHistoricalPresentation(prepared.observationPresentation, camera);
      return { camera, id: index + 1, presentation, map: mapper(presentation),
        clipCount: prepared.clipCount, firstClipFromMs: prepared.firstClipFromMs,
        path: `/api/frigate/vod/${camera}/start/${start}/end/${end}/index.m3u8`,
        video: null, hls: null, callback: null, listeners: [], times: {}, first: null, latest: null,
        rvfcCount: 0, unmappedCount: 0, waiting: 0, stalled: 0, seeking: 0,
        mediaErrors: 0, errors: [], hlsErrorCount: 0, httpFailureCount: 0, fatal: false,
        sourceLoads: 0, playCalls: 0, baselineQuality: null };
    });
    this.auth = { setups: 0, setupFailures: 0, refreshAttempts: 0, refreshSuccesses: 0, refreshFailures: 0 };
    this.resources = { videosCreated: 0, videosDestroyed: 0, hlsCreated: 0, hlsDestroyed: 0 };
    this.samples = []; this.lastSampleAt = null; this.startedAt = null; this.finishedAt = null; this.destroyed = false;
  }

  async authenticate(xhr, url, peer) {
    try {
      const resource = new URL(url, this.origin);
      if (resource.origin !== this.origin || resource.username || resource.password || resource.search || resource.hash ||
          !resource.pathname.startsWith(peer.path.slice(0, -"index.m3u8".length))) throw new Error();
      const auth = this.getAuth();
      if (auth.expired) {
        this.auth.refreshAttempts += 1;
        try { await auth.refreshAccessToken(); this.auth.refreshSuccesses += 1; }
        catch { this.auth.refreshFailures += 1; throw new Error(); }
      }
      if (typeof auth.accessToken !== "string" || !auth.accessToken) throw new Error();
      xhr.open("GET", url, true);
      xhr.setRequestHeader("Authorization", `Bearer ${auth.accessToken}`);
      this.auth.setups += 1;
    } catch { this.auth.setupFailures += 1; throw new Error("Native VOD authentication failed."); }
  }

  startPlayback() {
    this.loadSources();
    return this.playPeers();
  }

  loadSources() {
    if (this.startedAt !== null || this.destroyed) throw new Error("Native experiment can run only once.");
    this.startedAt = this.now();
    for (const peer of this.peers) {
      const video = peer.video = this.createVideo(peer.camera);
      this.resources.videosCreated += 1;
      video.muted = true; video.playsInline = true;
      peer.baselineQuality = quality(video);
      const listen = (event, handler) => {
        video.addEventListener(event, handler); peer.listeners.push([event, handler]);
      };
      for (const event of ["loadedmetadata", "canplay", "playing"]) listen(event, () => { peer.times[event] ??= this.now(); });
      listen("waiting", () => { peer.waiting += 1; });
      listen("stalled", () => { peer.stalled += 1; });
      listen("seeking", () => { peer.seeking += 1; });
      listen("error", () => { peer.mediaErrors += 1; peer.fatal = true; });
      this.onVideoCreated(peer, listen);
      const hls = peer.hls = new this.Hls({ xhrSetup: (xhr, url) => this.authenticate(xhr, url, peer) });
      this.resources.hlsCreated += 1;
      hls.on(this.Hls.Events.MANIFEST_PARSED, () => { peer.times.manifestParsed ??= this.now(); });
      hls.on(this.Hls.Events.ERROR, (_event, data) => {
        peer.hlsErrorCount += 1;
        const status = number(data?.response?.code);
        if (status !== null && status >= 400) peer.httpFailureCount += 1;
        peer.errors.push({ type: label(data?.type), details: label(data?.details), fatal: Boolean(data?.fatal), status });
        if (peer.errors.length > ERROR_LIMIT) peer.errors.shift();
        if (data?.fatal) peer.fatal = true;
      });
      const observe = (wallMs, metadata) => {
        if (this.destroyed) return;
        if (!this.acceptObservation(peer, metadata)) {
          peer.callback = video.requestVideoFrameCallback(observe);
          return;
        }
        peer.rvfcCount += 1;
        const representedEpoch = peer.map(metadata.mediaTime);
        if (representedEpoch === null) peer.unmappedCount += 1;
        const observed = { wallMs, mediaTime: number(metadata.mediaTime), representedEpoch,
          presentedFrames: number(metadata.presentedFrames) };
        peer.latest = observed;
        if (!peer.first) peer.first = { ...observed, offsetSeconds: representedEpoch === null ? null : representedEpoch - this.start,
          currentTimeDiagnostic: number(video.currentTime), readyState: number(video.readyState),
          networkState: number(video.networkState), width: number(video.videoWidth), height: number(video.videoHeight), quality: quality(video) };
        this.observePair(wallMs);
        this.onObservation(peer);
        peer.callback = video.requestVideoFrameCallback(observe);
      };
      peer.callback = video.requestVideoFrameCallback(observe);
      hls.attachMedia(video);
      peer.times.loadSource = this.now(); peer.sourceLoads += 1;
      hls.loadSource(peer.path);
    }
  }

  onVideoCreated() {}
  acceptObservation() { return true; }
  onObservation() {}

  playPeers() {
    // No readiness barrier, position assignment, or launch-skew compensation.
    const starts = this.peers.map(peer => {
      peer.times.playInvoked = this.now(); peer.playCalls += 1;
      return Promise.resolve(peer.video.play()).then(() => { peer.times.playResolved = this.now(); }, () => {
        peer.times.playRejected = this.now(); peer.fatal = true;
      });
    });
    return Promise.all(starts);
  }

  observePair(wallMs) {
    const [a, b] = this.peers.map(peer => peer.latest);
    if (!a || !b || a.representedEpoch === null || b.representedEpoch === null) return;
    const pairedAt = Math.min(a.wallMs, b.wallMs);
    if (this.lastSampleAt !== null && pairedAt - this.lastSampleAt < 1000) return;
    this.lastSampleAt = pairedAt;
    this.samples.push({ wallMs: (a.wallMs + b.wallMs) / 2, signedErrorSeconds: b.representedEpoch - a.representedEpoch,
      observationSeparationMs: Math.abs(b.wallMs - a.wallMs) });
    if (this.samples.length > SAMPLE_LIMIT) this.samples.shift();
  }

  get fatal() { return this.peers.some(peer => peer.fatal); }

  report() {
    const at = this.finishedAt ?? this.now();
    const signed = this.samples.map(sample => sample.signedErrorSeconds);
    const absolute = signed.map(Math.abs).sort((a, b) => a - b);
    const separations = this.samples.map(sample => sample.observationSeparationMs).sort((a, b) => a - b);
    const first = this.samples[0], last = this.samples.at(-1);
    const elapsed = first && last ? (last.wallMs - first.wallMs) / 1000 : null;
    let slope = null;
    if (this.samples.length > 1) {
      const xs = this.samples.map(sample => (sample.wallMs - first.wallMs) / 1000);
      const mx = xs.reduce((a,b)=>a+b,0)/xs.length, my = signed.reduce((a,b)=>a+b,0)/signed.length;
      const variance = xs.reduce((sum,x)=>sum+(x-mx)**2,0);
      slope = variance ? xs.reduce((sum,x,i)=>sum+(x-mx)*(signed[i]-my),0)/variance : null;
    }
    return { build: NATIVE_VOD_BUILD, requestedStart: this.start, requestedEnd: this.end, hlsVersion: this.Hls.version,
      startedAt: this.startedAt, finishedAt: this.finishedAt, elapsedWallSeconds: (at-this.startedAt)/1000,
      architecture: { place: false, currentTimeWrites: 0, playbackRateWrites: 0, correction: false, sourceReplacement: false },
      resources: { ...this.resources, activeVideos: this.resources.videosCreated-this.resources.videosDestroyed,
        activeHls: this.resources.hlsCreated-this.resources.hlsDestroyed }, authentication: { ...this.auth },
      playInvocationSkewMs: this.peers[1].times.playInvoked-this.peers[0].times.playInvoked,
      pair: { sign: "drive_down minus drive_up", sampleCount: signed.length,
        firstSignedSeconds: first?.signedErrorSeconds ?? null, firstAbsoluteSeconds: first ? Math.abs(first.signedErrorSeconds) : null,
        medianAbsoluteSeconds: percentile(absolute,0.5), p95AbsoluteSeconds: percentile(absolute,0.95),
        maxAbsoluteSeconds: absolute.at(-1) ?? null, minSignedSeconds: signed.length ? Math.min(...signed) : null,
        maxSignedSeconds: signed.length ? Math.max(...signed) : null, endSignedSeconds: last?.signedErrorSeconds ?? null,
        endMinusFirstSeconds: first && last ? last.signedErrorSeconds-first.signedErrorSeconds : null,
        sampledWallSeconds: elapsed, regressionDriftSecondsPerMinute: slope === null ? null : slope*60,
        medianObservationSeparationMs: percentile(separations,0.5), p95ObservationSeparationMs: percentile(separations,0.95),
        maxObservationSeparationMs: separations.at(-1) ?? null }, samples: this.samples.map(sample=>({...sample})),
      peers: this.peers.map(peer => {
        const q = quality(peer.video), f = peer.first, l = peer.latest;
        const wall = f && l ? (l.wallMs-f.wallMs)/1000 : null;
        const advancement = f?.representedEpoch !== null && l?.representedEpoch !== null && f && l ? l.representedEpoch-f.representedEpoch : null;
        return { camera: peer.camera, sessionId: peer.id, presentationId: peer.id,
          physicalWallStart: peer.presentation.logical_wall_start, physicalWallEnd: peer.presentation.logical_wall_end,
          mapEpochOrigin: peer.presentation.time_map.epoch_origin, mediaStart: peer.presentation.media_start_position,
          mediaEnd: peer.presentation.logical_media_end_position, spanCount: peer.presentation.time_map.spans.length,
          clipCount: peer.clipCount, firstClipFromMs: peer.firstClipFromMs, times: {...peer.times}, first: f ? {...f} : null, latest: l ? {...l} : null,
          representedAdvancementSeconds: advancement, observedWallSeconds: wall, effectiveRepresentedRate: wall > 0 && advancement !== null ? advancement/wall : null,
          rvfcCount: peer.rvfcCount, rvfcPerSecond: wall > 0 ? (peer.rvfcCount-1)/wall : null, unmappedCount: peer.unmappedCount,
          totalFrames: q.total, droppedFrames: q.dropped,
          totalFrameDelta: q.total === null || peer.baselineQuality.total === null ? null : q.total-peer.baselineQuality.total,
          droppedFrameDelta: q.dropped === null || peer.baselineQuality.dropped === null ? null : q.dropped-peer.baselineQuality.dropped,
          waiting: peer.waiting, stalled: peer.stalled, nativeSeekingEvents: peer.seeking, mediaErrors: peer.mediaErrors,
          hlsErrorCount: peer.hlsErrorCount, httpFailureCount: peer.httpFailureCount, errors: peer.errors.map(error=>({...error})), fatal: peer.fatal,
          sourceLoads: peer.sourceLoads, playCalls: peer.playCalls, currentTimeDiagnostic: number(peer.video.currentTime),
          browserPlaybackRate: number(peer.video.playbackRate), readyState: number(peer.video.readyState), networkState: number(peer.video.networkState),
          width: number(peer.video.videoWidth), height: number(peer.video.videoHeight) };
      }) };
  }

  destroy() {
    if (this.destroyed) return;
    this.finishedAt = this.now(); this.destroyed = true;
    for (const peer of this.peers) {
      if (peer.video) {
        peer.video.cancelVideoFrameCallback(peer.callback);
        for (const [event, handler] of peer.listeners) peer.video.removeEventListener(event,handler);
        peer.video.pause(); peer.video.remove(); this.resources.videosDestroyed += 1;
      }
      if (peer.hls) { peer.hls.destroy(); this.resources.hlsDestroyed += 1; }
    }
  }
}
