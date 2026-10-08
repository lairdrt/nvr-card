// Manual post-trial collection. Preserves one result and verifies teardown.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzePausedDwellTrial } from "./paused-dwell-startup-analysis.js";

const trialId = process.argv[2];
if (!["A1", "B1", "A2", "B2"].includes(trialId)) throw new Error("Expected a trial ID.");
const helper = pathToFileURL(join(process.env.TEMP, "nvr-corrected-startup-20260927", "cdp.mjs"));
const { connect } = await import(helper.href);
const cdp = await connect();
let collected;
try {
  collected = await cdp.evaluate(`(()=>{const state=window.__pausedDwellTrial;let videos=0;
    function walk(root){videos+=root.querySelectorAll('video').length;
      for(const element of root.querySelectorAll('*'))if(element.shadowRoot)walk(element.shadowRoot);}
    walk(document);return {trialId:state?.trialId??null,done:state?.done??false,
      destroyed:state?.experiment?.destroyed??false,activeDocumentVideos:videos,
      taskFailure:window.__pausedDwellTrialTaskFailure??null,result:state?.result??null};})()`);
} finally {
  cdp.close();
}
if (collected.trialId !== trialId || !collected.done || !collected.destroyed || !collected.result) {
  throw new Error("Trial has not finished and torn down; no evidence file written.");
}
const resources = collected.result.afterTeardownResources;
if (resources?.activeVideos !== 0 || resources?.activeHls !== 0 || collected.activeDocumentVideos !== 0) {
  throw new Error("Media teardown is incomplete; no evidence file written.");
}
const directory = join(process.env.TEMP, "nvr-paused-dwell-20260927");
mkdirSync(directory, { recursive: true });
const runtimePath = join(directory, `${trialId}-runtime.json`);
writeFileSync(runtimePath, JSON.stringify(collected, null, 2));
let analysis = null, analysisPath = null;
if (collected.result.playReferenceMs !== null) {
  analysis = analyzePausedDwellTrial(collected.result);
  analysisPath = join(directory, `${trialId}-analysis.json`);
  writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
}
console.log(JSON.stringify({ trialId, status: collected.result.status,
  contaminated: collected.result.contaminated,
  runDurationMs: collected.result.actualRunDurationMs,
  qualifiedComparisons: analysis?.qualifiedCount ?? null,
  firstFiveSeconds: analysis?.windows.firstFiveSeconds ?? null,
  resources, activeDocumentVideos: collected.activeDocumentVideos,
  taskFailure: collected.taskFailure, runtimePath, analysisPath }));
