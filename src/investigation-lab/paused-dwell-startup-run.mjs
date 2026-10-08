// Manual Lab runner. Invoke once per user-confirmed trial; never loops or retries.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const trialId = process.argv[2];
const predecessor = { A1: null, B1: "A1", A2: "B1", B2: "A2" };
if (!Object.hasOwn(predecessor, trialId)) throw new Error("Expected A1, B1, A2, or B2.");

const target = 1790536357.371; // 2026-09-27 19:12:37.371 UTC
const start = target - 10;
const end = target + 180;
const cameras = ["drive_up", "drive_down"];
const deployment = JSON.parse(readFileSync(`${process.env.TEMP}/nvr-corrected-startup-20260927/deployment.json`));
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find(item => item.type === "page" && new URL(item.url).hostname === "homeassistant.local");
if (!page) throw new Error("Authenticated HA Lab tab unavailable.");
const base = new URL(`/local/nvr-card/experiments/${deployment.folder}/`, page.url).href;
const source = readFileSync("src/investigation-lab/paused-dwell-startup-harness.js", "utf8")
  .replace('"./anchored-pair-seam-experiment.js"', JSON.stringify(base + "anchored-pair-seam-experiment.js"))
  .replace('"./rvfc-flight-recorder.js"', JSON.stringify(base + "rvfc-flight-recorder.js"));
if (source.includes('"./anchored-pair-seam-experiment.js"') || source.includes('"./rvfc-flight-recorder.js"')) {
  throw new Error("Lab harness imports were not resolved.");
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let serial = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id); clearTimeout(item.timer);
  if (message.error) item.reject(new Error("Browser command failed."));
  else item.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser command timed out.")); }, 45_000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error("Browser evaluation failed; details withheld.");
  return response.result.value;
};

try {
  const browserWindow = await send("Browser.getWindowForTarget");
  await send("Browser.setWindowBounds", { windowId: browserWindow.windowId, bounds: { windowState: "normal" } });
  await send("Page.bringToFront");
  const state = await evaluate(`(()=>{const old=window.__pausedDwellTrial;return {
    visible:document.visibilityState==='visible',focused:document.hasFocus(),
    previous:old?{trialId:old.trialId,done:old.done,destroyed:old.experiment?.destroyed,
      activeVideos:old.result?.afterTeardownResources?.activeVideos,
      activeHls:old.result?.afterTeardownResources?.activeHls}:null};})()`);
  if (!state.visible || !state.focused) throw new Error("HA Lab browser is not foregrounded and focused.");
  if (predecessor[trialId] === null ? state.previous !== null :
      state.previous?.trialId !== predecessor[trialId] || !state.previous?.done ||
      !state.previous?.destroyed || state.previous?.activeVideos !== 0 || state.previous?.activeHls !== 0) {
    throw new Error("Previous trial state is absent, incomplete, or not torn down.");
  }

  const served = await evaluate(`(async()=>{const names=${JSON.stringify(deployment.assets.map(asset => asset.name))};
    const out=[];for(const name of names){const response=await fetch(${JSON.stringify(base)}+name,{cache:'no-store'});
      out.push({name,status:response.status,bytes:response.ok?Array.from(new Uint8Array(await response.arrayBuffer())):[]});}
    return out;})()`);
  for (const asset of served) {
    const expected = deployment.assets.find(item => item.name === asset.name);
    if (asset.status !== 200 || createHash("sha256").update(Buffer.from(asset.bytes)).digest("hex") !== expected.hash) {
      throw new Error("Corrected measurement asset hash mismatch.");
    }
  }

  const result = await evaluate(`(async()=>{try{
    let card=null;function walk(root){for(const element of root.querySelectorAll('*')){
      if(element.localName==='investigation-playback-lab'&&element._hass?.callWS)card=element;
      if(element.shadowRoot)walk(element.shadowRoot);}}walk(document);
    if(!card)throw Error('Authenticated Lab card unavailable');
    const target=${target},start=${start},end=${end},cameras=${JSON.stringify(cameras)};
    const preparations=[];
    for(const camera of cameras){
      const available=await card._hass.callWS({type:'frigate_max/v1/recordings/availability',camera,start,end});
      if(!available.coverage?.some(run=>run.start<=start&&run.end>=end))throw Error('Source interval no longer covered');
      const presentation=await card._hass.callWS({type:'frigate_max/lab/vod/prepare',camera,start,end,target});
      if(presentation.requested_wall_start!==start||presentation.requested_wall_end!==end||
          presentation.selected_epoch!==target||!Number.isFinite(presentation.selected_media_position)){
        throw Error('Native VOD preparation differs from the fixed interval');}
      preparations.push({camera,requestedStart:start,requestedEnd:end,
        observationPresentation:presentation,clipCount:presentation.mapping_clip_count,firstClipFromMs:null});
    }
    const url=URL.createObjectURL(new Blob([${JSON.stringify(source)}],{type:'text/javascript'}));
    let module;try{module=await import(url);}finally{URL.revokeObjectURL(url);}
    const prep={start,end,target,preparations};
    window.__pausedDwellTrialTask=module.runPausedDwellStartupTrial(prep,${JSON.stringify(deployment.build)},${JSON.stringify(trialId)});
    window.__pausedDwellTrialTask.catch(error=>{
      window.__pausedDwellTrialTaskFailure=String(error?.message);
    });
    return {scheduled:true,trialId:${JSON.stringify(trialId)},condition:module.startupTrialPlan(${JSON.stringify(trialId)}).condition,
      sourceStart:start,requestedT:target,sourceEnd:end,cameras:preparations.map(p=>({camera:p.camera,
        mappedSeekTarget:p.observationPresentation.selected_media_position,
        clips:p.clipCount}))};
  }catch(error){return {scheduled:false,reason:String(error?.message)}}})()`);
  if (!result.scheduled) throw new Error(result.reason);
  console.log(JSON.stringify(result));
} finally {
  socket.close();
}
