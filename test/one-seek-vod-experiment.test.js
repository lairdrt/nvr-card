import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {OneSeekVodExperiment} from "../src/investigation-lab/one-seek-vod-experiment.js";

class Video extends EventTarget {
  constructor() { super(); this.callbacks=new Map(); this.serial=0; this.frames=0; this.writes=[];
    this.paused=true; this.readyState=1; this.networkState=2; this.videoWidth=1920; this.videoHeight=1080;
    this.seeking=false; this.plays=0; this.pauses=0; this.position=0;
    this.seekable={length:1,start:()=>0,end:()=>620}; }
  get currentTime(){return this.position;}
  set currentTime(value){assert.equal(this.plays,0,"post-Play position write");this.writes.push(value);this.position=value;
    this.seeking=true;this.dispatchEvent(new Event("seeking"));}
  get playbackRate(){return 1;}
  set playbackRate(_){throw new Error("rate write");}
  play(){this.plays++;this.paused=false;this.dispatchEvent(new Event("playing"));return Promise.resolve();}
  pause(){this.pauses++;this.paused=true;}
  remove(){}
  requestVideoFrameCallback(fn){this.callbacks.set(++this.serial,fn);return this.serial;}
  cancelVideoFrameCallback(id){this.callbacks.delete(id);}
  frame(mediaTime,wallMs,presentationTime=wallMs){const [id,fn]=this.callbacks.entries().next().value;
    this.callbacks.delete(id);fn(wallMs,{mediaTime,presentationTime,presentedFrames:++this.frames});}
  getVideoPlaybackQuality(){return{totalVideoFrames:this.frames,droppedVideoFrames:0};}
}
class Hls {
  static version="1.7.2";static Events={MANIFEST_PARSED:"manifest",ERROR:"error"};
  constructor(config){this.config=config;this.events=new Map();this.loads=[];}
  on(event,fn){this.events.set(event,fn);}
  attachMedia(video){this.video=video;}
  loadSource(path){this.loads.push(path);this.events.get("manifest")();this.video.dispatchEvent(new Event("loadedmetadata"));}
  destroy(){this.destroyed=true;}
}
function preparation(camera,start,end,lead){const origin=start-lead,duration=end-origin;
  return{camera,requestedStart:start,requestedEnd:end,clipCount:61,firstClipFromMs:0,
    observationPresentation:{schema:2,camera,selected_epoch:start,resolved_selected_epoch:start,
      requested_wall_start:origin,requested_wall_end:end,logical_wall_start:origin,logical_wall_end:end,
      effective_wall_start:origin,effective_absolute_origin:origin,media_start_position:0,
      selected_media_position:lead,logical_media_end_position:duration,
      coverage_run:{known_start:origin,known_end:end,continues_before:false,continues_after:false},
      time_map:{epoch_origin:origin,unit:"microseconds",spans:[[0,duration*1e6,0,duration*1e6]]}}};}
function harness(){const start=1790448870.371,end=start+600,videos=[];let clock=1000;
  const experiment=new OneSeekVodExperiment({start,end,preparations:[preparation("drive_up",start,end,4),preparation("drive_down",start,end,9)],
    Hls,createVideo:()=>{const v=new Video();videos.push(v);return v;},getAuth:()=>({accessToken:"credential-fixture",expired:false}),
    expectedOrigin:"https://ha.example.test",now:()=>++clock});
  return{experiment,videos,start,end};}
async function land(h,offsets=[0,0]){const pending=h.experiment.startPlayback();
  h.videos.forEach((v,i)=>v.frame([4,9][i]+offsets[i],2000+i));await pending;}

test("identical T/E with independently mapped positions and one paused seek/pipeline each",async()=>{
  const h=harness(),pending=h.experiment.startPlayback();
  assert.deepEqual(h.videos.map(v=>v.writes),[[4],[9]]);assert.ok(h.videos.every(v=>v.paused&&v.plays===0));
  assert.deepEqual(h.experiment.peers.map(p=>p.hls.loads),["drive_up","drive_down"].map(c=>[
    `/api/frigate/vod/${c}/start/${h.start}/end/${h.end}/index.m3u8`]));
  h.videos[0].frame(4,2000);assert.ok(h.videos.every(v=>v.paused));h.videos[1].frame(9,2001);await pending;
  const r=h.experiment.report();assert.deepEqual(r.peers.map(p=>[p.initialCurrentTimeWrites,p.initialSeeks,p.sourceLoads,p.playCalls]),[[1,1,1,1],[1,1,1,1]]);
  assert.equal(r.resources.activeVideos,2);assert.equal(r.resources.activeHls,2);h.experiment.destroy();
});
for(const offset of [0,-.06,.5,-.95,1.4,-3])test(`offset ${offset}: truthful RVFC before seeked at readyState 1 unconditionally reaches Play`,async()=>{
  const h=harness();await land(h,[offset,offset]);const r=h.experiment.report();
  for(const p of r.peers){assert.ok(Math.abs(p.initial.signedOffsetSeconds-offset)<1e-6);
    assert.equal(p.initial.within1000ms,Math.abs(offset)<=1);assert.equal(p.initial.readyState,1);
    assert.equal(p.times.seeked,undefined);assert.equal(p.initialSeeks,1);assert.equal(p.playCalls,1);}
  assert.ok(h.videos.every(v=>v.seeking&&!v.paused&&v.writes.length===1));h.experiment.destroy();
});
test("unequal large offsets are retained as actual epochs; no cross-camera matching",async()=>{
  const h=harness();await land(h,[-3,1.4]);const r=h.experiment.report();
  assert.ok(Math.abs(r.initialSignedPairSeconds-4.4)<1e-6);assert.equal(r.peers[0].initial.within1000ms,false);
  assert.equal(r.peers[1].initial.within1000ms,false);assert.deepEqual(h.videos.map(v=>v.writes),[[4],[9]]);h.experiment.destroy();
});
test("a proven pre-seek presentationTime is stale; a current mapped frame is accepted",async()=>{
  const h=harness(),pending=h.experiment.startPlayback();h.videos[0].frame(0,2000,900);
  assert.equal(h.experiment.peers[0].initial,null);assert.equal(h.experiment.peers[0].staleInitialFrames,1);
  h.videos[0].frame(1,2100);h.videos[1].frame(9,2101);await pending;
  assert.equal(h.experiment.report().peers[0].initial.signedOffsetSeconds,-3);h.experiment.destroy();
});
test("unmapped evidence cannot establish a landing, without another seek",async()=>{
  const h=harness(),pending=h.experiment.startPlayback();h.videos[0].frame(-1,2000);h.videos[1].frame(9,2001);
  assert.equal(h.videos[1].plays,0);h.videos[0].frame(4,2100);await pending;
  assert.deepEqual(h.videos.map(v=>v.writes.length),[1,1]);h.experiment.destroy();
});
test("no pre-seek observation approves placement; assignable range only enables the one write",async()=>{
  const h=harness();const original=h.experiment.createVideo;
  h.experiment.createVideo=()=>{const v=original();v.seekable={length:0};return v;};
  const pending=h.experiment.startPlayback();h.videos.forEach(v=>v.frame(0,2000));assert.ok(h.videos.every(v=>v.writes.length===0));
  h.videos.forEach((v,i)=>{v.seekable={length:1,start:()=>0,end:()=>620};v.dispatchEvent(new Event("progress"));v.frame([4,9][i],2100+i);});
  await pending;assert.deepEqual(h.videos.map(v=>v.writes.length),[1,1]);h.experiment.destroy();
});
test("large changing pair errors after Play cannot write position/rate, pause, reload or refine",async()=>{
  const h=harness();await land(h);for(let i=0;i<400;i++){
    h.videos[0].frame(4+i,3000+i*1000);h.videos[1].frame(9+i+i/10,3000+i*1000);}
  const r=h.experiment.report();assert.equal(r.samples.length,256);assert.ok(r.pair.endSignedSeconds>30);
  assert.deepEqual(h.videos.map(v=>[v.writes.length,v.plays,v.pauses]),[[1,1,0],[1,1,0]]);
  assert.ok(r.peers.every(p=>p.sourceLoads===1));assert.equal(r.architecture.afterPlayCurrentTimeWrites,0);
  assert.equal(r.architecture.afterPlayPlaybackRateWrites,0);h.experiment.destroy();
});
test("bounded sanitized health diagnostics remain passive",async()=>{
  const h=harness();await land(h);for(let i=0;i<40;i++)h.experiment.peers[0].hls.events.get("error")("error",{
    type:"networkError",details:"fragLoadError",fatal:false,response:{code:403,text:"credential-fixture"},
    url:"https://private/?authSig=credential-fixture",path:"/recordings/private.mp4",headers:{Authorization:"Bearer credential-fixture"}});
  const r=h.experiment.report();assert.equal(r.peers[0].errors.length,16);assert.equal(r.peers[0].httpFailureCount,40);
  assert.doesNotMatch(JSON.stringify(r),/credential-fixture|authSig|Authorization|private\.mp4|https?:\/\//);
  assert.deepEqual(h.videos.map(v=>[v.writes.length,v.plays]),[[1,1],[1,1]]);h.experiment.destroy();
});
test("fatal load evidence prevents Play and never causes another seek",async()=>{
  const h=harness(),pending=h.experiment.startPlayback();h.experiment.peers[0].fatal=true;
  h.videos[0].frame(4,2000);h.videos[1].frame(9,2001);await assert.rejects(pending,/media operation failed/);
  assert.deepEqual(h.videos.map(v=>[v.writes.length,v.plays]),[[1,0],[1,0]]);h.experiment.destroy();
});
test("teardown balances resources and stale callbacks cannot mutate playback",async()=>{
  const h=harness();await land(h);const old=h.videos[0].callbacks.values().next().value;
  h.experiment.destroy();h.experiment.destroy();old(4000,{mediaTime:5,presentationTime:4000});
  const r=h.experiment.report();assert.equal(r.resources.activeVideos,0);assert.equal(r.resources.activeHls,0);
  assert.deepEqual(h.videos.map(v=>[v.writes.length,v.plays,v.pauses]),[[1,1,1],[1,1,1]]);
});
test("post-Play observer has no assignments or correction path; only one initial assignment exists",()=>{
  const source=readFileSync(new URL("../src/investigation-lab/one-seek-vod-experiment.js",import.meta.url),"utf8");
  const native=readFileSync(new URL("../src/investigation-lab/native-vod-sync-experiment.js",import.meta.url),"utf8");
  assert.equal((source.match(/\.currentTime\s*=/g)||[]).length,1);
  assert.doesNotMatch(source,/\.playbackRate\s*=|\.place\(|\.seek\(|recoverMediaError|startLoad|long-vod-two-peer/);
  assert.doesNotMatch(source.slice(source.indexOf("  acceptObservation")),/\.(?:currentTime|playbackRate)\s*=/);
  assert.doesNotMatch(native,/\.(?:currentTime|playbackRate)\s*=/);
  assert.equal((native.match(/\.loadSource\(/g)||[]).length,1);assert.equal((native.match(/\.play\(/g)||[]).length,1);
});
