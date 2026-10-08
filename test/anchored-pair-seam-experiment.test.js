import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {AnchoredPairSeamExperiment} from "../src/investigation-lab/anchored-pair-seam-experiment.js";

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


function harness(){const start=1004,end=1035,videos=[];
 const up=preparation('drive_up',start,end,4),down=preparation('drive_down',start,end,9);
 up.observationPresentation.time_map.spans=[[0,20000000,0,20000000],[19000000,35000000,20000000,36000000]];
 up.observationPresentation.logical_media_end_position=36;
 const experiment=new AnchoredPairSeamExperiment({start,end,preparations:[up,down],seamMediaTime:20,Hls,
 createVideo:()=>{const v=new Video();videos.push(v);return v;},getAuth:()=>({}),expectedOrigin:'https://ha.example.test',now:()=>1000});
 return {experiment,videos};}
async function ready(h){const p=h.experiment.prepare();h.videos[0].frame(3.8,2000);h.videos[1].frame(9.1,2005);await p;}
function pair(h,up,down,wall){h.videos[0].frame(up,wall);h.videos[1].frame(down,wall+10);}
function handsOff(h){assert.deepEqual(h.videos.map(v=>[v.writes.length,v.plays,v.pauses]),[[1,1,0],[1,1,0]]);
 assert.ok(h.experiment.peers.every(p=>p.sourceLoads===1&&p.anchorCount===1));}
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,a+' != '+b);
test('two truthful unequal anchors wait for both landings and explicit Play',async()=>{
 const h=harness(),p=h.experiment.prepare();h.videos[0].frame(3.8,2000);
 assert.equal(h.videos.length,2);assert.ok(h.videos.every(v=>v.plays===0));
 h.videos[1].frame(9.1,2005);await p;const r=h.experiment.report();
 assert.equal(r.phase,'ready');assert.deepEqual(r.anchors.map(p=>p.anchor),[{absoluteTime:1003.8,mediaTime:3.8},{absoluteTime:1004.1,mediaTime:9.1}]);
 assert.equal(r.resources.activeVideos,2);assert.equal(r.resources.activeHls,2);
 await h.experiment.play();handsOff(h);await assert.rejects(h.experiment.play(),/not ready/);h.experiment.destroy();
});
test('known provider seam changes provider residual only, preserving landed displacement',async()=>{
 const h=harness();await ready(h);await h.experiment.play();pair(h,19.95,25.25,3000);pair(h,20,25.3,3050);
 const r=h.experiment.report();close(r.before.rawResidual,0);close(r.after.rawResidual,0);
 close(r.before.anchoredResidual,-.3);close(r.after.anchoredResidual,-.3);
 close(r.after.providerResidual-r.before.providerResidual,-1);
 close(r.after.up.mediaTime-r.before.up.mediaTime,.05);close(r.after.down.mediaTime-r.before.down.mediaTime,.05);
 assert.equal(r.pair.sign,'drive_up minus drive_down');assert.equal(r.after.observationSeparationMs,10);
 handsOff(h);h.experiment.destroy();
});
test('passive pairing waits for fresh observations from both and retains phase separation',async()=>{
 const h=harness();await ready(h);await h.experiment.play();h.videos[0].frame(18,3000);h.videos[0].frame(18.05,3050);
 assert.equal(h.experiment.pairCount,0);h.videos[1].frame(23.35,3080);assert.equal(h.experiment.pairCount,1);
 assert.equal(h.experiment.latestPair.observationSeparationMs,30);
 h.videos[1].frame(23.4,3100);assert.equal(h.experiment.pairCount,1);h.videos[0].frame(18.1,3120);
 assert.equal(h.experiment.pairCount,2);handsOff(h);h.experiment.destroy();
});
test('real divergent media advancement remains visible without threshold actions',async()=>{
 const h=harness();await ready(h);await h.experiment.play();pair(h,19,24.3,3000);pair(h,20,24.8,4000);
 close(h.experiment.latestPair.rawResidual,.5);close(h.experiment.latestPair.anchoredResidual,.2);
 assert.equal(h.experiment.peers[0].mediaProgress.maxDelta,1);handsOff(h);h.experiment.destroy();
});
test('unmapped provider comparison does not reject anchored or raw observations',async()=>{
 const h=harness();await ready(h);await h.experiment.play();pair(h,40,45.3,3000);
 assert.equal(h.experiment.latestPair.providerResidual,null);close(h.experiment.latestPair.rawResidual,0);
 close(h.experiment.latestPair.anchoredResidual,-.3);handsOff(h);h.experiment.destroy();
});
test('trace is bounded and individual progress retains backward evidence without control',async()=>{
 const h=harness();await ready(h);await h.experiment.play();for(let i=0;i<300;i++)pair(h,19+i/1000,24.3+i/1000,3000+i);
 assert.equal(h.experiment.trace.length,256);assert.equal(h.experiment.pairCount,300);
 pair(h,18.5,23.8,4000);assert.equal(h.experiment.peers[0].mediaProgress.backwards,1);
 handsOff(h);h.experiment.destroy();
});
test('balanced teardown rejects stale observer work and report excludes credentials',async()=>{
 const h=harness();await ready(h);await h.experiment.play();pair(h,19.95,25.25,3000);
 const old=h.videos[0].callbacks.values().next().value;h.experiment.destroy();const n=h.experiment.pairCount;
 old(5000,{mediaTime:20,presentationTime:5000});assert.equal(h.experiment.pairCount,n);
 const r=h.experiment.report();assert.equal(r.resources.activeVideos,0);assert.equal(r.resources.activeHls,0);
 assert.deepEqual(h.videos.map(v=>v.pauses),[1,1]);assert.doesNotMatch(JSON.stringify(r),/credential-fixture|Authorization|authSig/);
});
