import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NativeVodSyncExperiment } from "../src/investigation-lab/native-vod-sync-experiment.js";

class Video extends EventTarget {
  constructor() { super(); this.callbacks = new Map(); this.serial = 0; this.frames = 0;
    this.paused = true; this.readyState = 1; this.networkState = 2; this.videoWidth = 1920; this.videoHeight = 1080; }
  get currentTime() { return 0; }
  set currentTime(_) { throw new Error("Experiment wrote currentTime"); }
  get playbackRate() { return 1; }
  set playbackRate(_) { throw new Error("Experiment wrote playbackRate"); }
  play() { this.paused = false; this.dispatchEvent(new Event("playing")); return Promise.resolve(); }
  pause() { this.paused = true; }
  remove() {}
  requestVideoFrameCallback(fn) { this.callbacks.set(++this.serial, fn); return this.serial; }
  cancelVideoFrameCallback(id) { this.callbacks.delete(id); }
  frame(mediaTime, wallMs) { const [id, fn] = this.callbacks.entries().next().value;
    this.callbacks.delete(id); fn(wallMs, {mediaTime, presentedFrames:++this.frames}); }
  getVideoPlaybackQuality() { return {totalVideoFrames:this.frames,droppedVideoFrames:0}; }
}
class Hls {
  static version = "1.7.2";
  static Events = {MANIFEST_PARSED:"manifestParsed",ERROR:"error"};
  constructor(config) { this.config=config; this.events=new Map(); this.loads=[]; }
  on(event,fn) { this.events.set(event,fn); }
  attachMedia(video) { this.video=video; }
  loadSource(path) { this.loads.push(path); this.events.get("manifestParsed")(); }
  destroy() { this.destroyed=true; }
}
function preparation(camera,start,end,lead) {
  const origin=start-lead,duration=end-origin;
  return {camera,requestedStart:start,requestedEnd:end,clipCount:61,firstClipFromMs:0,
    observationPresentation:{schema:2,camera,selected_epoch:start,resolved_selected_epoch:start,
      requested_wall_start:origin,requested_wall_end:end,logical_wall_start:origin,logical_wall_end:end,
      effective_wall_start:origin,effective_absolute_origin:origin,media_start_position:0,
      selected_media_position:lead,logical_media_end_position:duration,
      coverage_run:{known_start:origin,known_end:end,continues_before:false,continues_after:false},
      time_map:{epoch_origin:origin,unit:"microseconds",spans:[[0,Math.round(duration*1e6),0,Math.round(duration*1e6)]]}}};
}
function harness() {
  const start=1790432450.371,end=start+600,videos=[];
  let clock=1000;
  const auth={accessToken:"credential-fixture",expired:false,refreshAccessToken:async()=>{auth.expired=false;}};
  const experiment=new NativeVodSyncExperiment({start,end,preparations:[preparation("drive_up",start,end,2),preparation("drive_down",start,end,9)],
    Hls,createVideo:()=>{const v=new Video();videos.push(v);return v;},getAuth:()=>auth,
    expectedOrigin:"https://ha.example.test",now:()=>++clock});
  return {experiment,videos,auth,start,end};
}

test("both sources request exactly the same fractional T and E, with one pipeline each",async()=>{
  const h=harness();await h.experiment.startPlayback();
  assert.deepEqual(h.experiment.peers.map(p=>p.hls.loads),["drive_up","drive_down"].map(c=>[
    `/api/frigate/vod/${c}/start/${h.start}/end/${h.end}/index.m3u8`]));
  const r=h.experiment.report();assert.equal(r.resources.activeVideos,2);assert.equal(r.resources.activeHls,2);
  assert.deepEqual(r.peers.map(p=>[p.sourceLoads,p.playCalls]),[[1,1],[1,1]]);
  assert.equal(r.architecture.place,false);assert.ok(h.videos.every(v=>!v.paused));
  h.experiment.destroy();
});

for (const offset of [-0.5,-0.06,0,0.02]) test(`first RVFC with signed offset ${offset} is data, never a gate`,async()=>{
  const h=harness();await h.experiment.startPlayback();h.videos[0].frame(2+offset,2000);
  const p=h.experiment.report().peers[0];assert.ok(Math.abs(p.first.offsetSeconds-offset)<1e-6);
  assert.equal(p.first.mediaTime,2+offset);assert.equal(p.first.readyState,1);
  assert.ok(!h.videos[0].paused);assert.equal(p.playCalls,1);assert.equal(p.sourceLoads,1);
  h.experiment.destroy();
});

test("mapping and pair sampling cannot write position/rate or correct a seven-second difference",async()=>{
  const h=harness();await h.experiment.startPlayback();
  for(let i=0;i<20;i++){h.videos[0].frame(i,2000+i*1000);h.videos[1].frame(i,2000+i*1000);}
  const r=h.experiment.report();assert.equal(r.pair.firstSignedSeconds,-7);
  assert.equal(r.pair.medianAbsoluteSeconds,7);assert.equal(r.pair.endSignedSeconds,-7);
  assert.equal(r.pair.regressionDriftSecondsPerMinute,0);
  assert.ok(r.peers.every(p=>p.playCalls===1&&p.sourceLoads===1));
  assert.equal(r.architecture.currentTimeWrites,0);assert.equal(r.architecture.playbackRateWrites,0);
  h.experiment.destroy();
});

test("unmapped observations and fatal errors report data without controlling playback",async()=>{
  const h=harness();await h.experiment.startPlayback();h.videos[0].frame(-1,2000);
  h.experiment.peers[0].hls.events.get("error")("error",{type:"networkError",details:"fragLoadError",fatal:true,response:{code:503}});
  const r=h.experiment.report();assert.equal(r.peers[0].unmappedCount,1);assert.equal(r.peers[0].first.representedEpoch,null);
  assert.equal(h.experiment.fatal,true);assert.ok(h.videos.every(v=>!v.paused));
  assert.equal(r.peers[0].httpFailureCount,1);assert.equal(r.resources.activeVideos,2);h.experiment.destroy();
});

test("sample and error storage remain bounded and diagnostic output excludes credentials and provider paths",async()=>{
  const h=harness();await h.experiment.startPlayback();
  for(let i=0;i<400;i++){h.videos[0].frame(i,2000+i*1000);h.videos[1].frame(i,2000+i*1000);}
  for(let i=0;i<50;i++)h.experiment.peers[0].hls.events.get("error")("error",{
    type:"networkError",details:"fragLoadError",url:"https://private/?authSig=credential-fixture",
    response:{code:403,text:"Bearer credential-fixture"},headers:{Authorization:"Bearer credential-fixture"},path:"/recordings/private.mp4"});
  const r=h.experiment.report();assert.equal(r.samples.length,256);assert.equal(r.peers[0].errors.length,16);
  assert.doesNotMatch(JSON.stringify(r),/credential-fixture|authSig|Authorization|private\.mp4|https?:\/\//);
  h.experiment.destroy();
});

test("HA bearer infrastructure refreshes without replacing media and rejects foreign routes safely",async()=>{
  const h=harness();await h.experiment.startPlayback();h.auth.expired=true;
  const xhr={open(){},setRequestHeader(name,value){assert.equal(name,"Authorization");assert.equal(value,"Bearer credential-fixture");}};
  const p=h.experiment.peers[0];await h.experiment.authenticate(xhr,"https://ha.example.test"+p.path,p);
  assert.equal(h.experiment.report().authentication.refreshSuccesses,1);
  await assert.rejects(h.experiment.authenticate(xhr,"https://foreign.example.test/secret",p),/authentication failed/);
  assert.equal(p.sourceLoads,1);assert.equal(p.playCalls,1);h.experiment.destroy();
});

test("teardown balances all resources once and stale callbacks cannot restart observation",async()=>{
  const h=harness();await h.experiment.startPlayback();const callback=h.videos[0].callbacks.values().next().value;
  h.experiment.destroy();h.experiment.destroy();callback(2000,{mediaTime:1});
  const r=h.experiment.report();assert.equal(r.resources.activeVideos,0);assert.equal(r.resources.activeHls,0);
  assert.equal(r.resources.videosDestroyed,2);assert.equal(r.resources.hlsDestroyed,2);
  assert.equal(r.peers[0].rvfcCount,0);assert.ok(h.videos.every(v=>v.paused));
});

test("there is no position/rate assignment, Place import, recovery or source replacement path",()=>{
  const source=readFileSync(new URL("../src/investigation-lab/native-vod-sync-experiment.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/(?:currentTime|playbackRate)\s*=|\.seek\(|\.place\(|startLoad\(|recoverMediaError\(|long-vod-two-peer-experiment/);
  assert.equal((source.match(/\.loadSource\(/g)||[]).length,1);
  assert.equal((source.match(/\.play\(/g)||[]).length,1);
  assert.equal((source.match(/\.pause\(/g)||[]).length,1);
});

test("native interval mismatches fail before allocating any media",()=>{
  const h=harness();assert.throws(()=>new NativeVodSyncExperiment({start:h.start,end:h.end,
    preparations:[preparation("drive_up",h.start+1,h.end,2)],Hls,createVideo:()=>{throw new Error("allocation");},expectedOrigin:"https://ha.example.test"}),/bounds differ/);
});
