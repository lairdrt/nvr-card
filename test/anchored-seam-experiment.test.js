import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {AnchoredSeamExperiment} from "../src/investigation-lab/anchored-seam-experiment.js";

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

function harness(seam=-1){const start=1004,end=1035,videos=[];
 const p=preparation('drive_up',start,end,4);
 p.observationPresentation.time_map.spans=[[0,20000000,0,20000000],[(20+seam)*1e6,(35)*1e6,20000000,(35-seam)*1e6]];
 p.observationPresentation.logical_media_end_position=35-seam;
 const experiment=new AnchoredSeamExperiment({start,end,preparations:[p],seamMediaTime:20,Hls,
 createVideo:()=>{const v=new Video();videos.push(v);return v;},getAuth:()=>({}),expectedOrigin:'https://ha.example.test',now:()=>1000});
 return {experiment,videos};}
async function ready(h){const p=h.experiment.prepare();h.videos[0].frame(3.8,2000);await p;}
test('one-camera preparation anchors actual landing and waits for explicit Play',async()=>{
 const h=harness();await ready(h);const r=h.experiment.report();
 assert.equal(r.phase,'ready');assert.equal(h.videos.length,1);assert.equal(h.videos[0].plays,0);
 assert.deepEqual(r.anchor,{absoluteTime:1003.8,mediaTime:3.8});assert.equal(r.secondsUntilSeamFromAnchor,16.2);
 assert.equal(r.resources.activeHls,1);await h.experiment.play();assert.equal(h.videos[0].plays,1);
 await assert.rejects(h.experiment.play(),/not ready/);h.experiment.destroy();
});
for(const seam of [-1,1])test('continuous anchor across provider seam '+seam,async()=>{
 const h=harness(seam);await ready(h);await h.experiment.play();
 h.videos[0].frame(19.96,3000);h.videos[0].frame(20.04,3080);const r=h.experiment.report();
 assert.ok(Math.abs(r.after.mediaTime-r.before.mediaTime-.08)<1e-9);
 assert.ok(Math.abs(r.after.anchoredTime-r.before.anchoredTime-.08)<1e-9);
 assert.ok(Math.abs(r.after.representedEpoch-r.before.representedEpoch-(seam+.08))<1e-9);
 assert.equal(r.before.span,0);assert.equal(r.after.span,1);assert.equal(r.trace.length,2);
 assert.deepEqual([h.videos[0].writes.length,h.videos[0].plays,h.videos[0].pauses],[1,1,0]);
 assert.equal(r.peers[0].sourceLoads,1);h.experiment.destroy();
});
test('unmapped provider data has no control effect; trace is bounded',async()=>{
 const h=harness();await ready(h);await h.experiment.play();
 h.videos[0].frame(50,3000);assert.equal(h.experiment.clock.mediaTime,50);
 for(let i=0;i<300;i++)h.videos[0].frame(19+i/1000,3100+i);
 assert.equal(h.experiment.trace.length,256);assert.equal(h.experiment.report().peers[0].unmappedCount,1);
 assert.deepEqual([h.videos[0].writes.length,h.videos[0].plays,h.videos[0].pauses],[1,1,0]);
 h.experiment.destroy();assert.equal(h.experiment.report().resources.activeHls,0);
});
