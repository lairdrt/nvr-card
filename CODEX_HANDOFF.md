# Codex handoff: FrigateMax / NVR Card

This is an operational bootstrap for a fresh Codex session. Git, source,
tests, and direct runtime evidence outrank this handoff if they disagree.
VISION.md governs product design. Inspect only source relevant to the next
task; do not reconstruct the whole repository or conversation history.

## 1. Protected Git baseline

- Branch: main.
- Runtime-proven experimental checkpoint: annotated tag
  one-seek-hands-off-playback. Resolve its commit with
  git rev-parse one-seek-hands-off-playback^{}. It preserves only the isolated
  native-VOD/one-seek modules, their direct tests, and this handoff. It does not
  accept production Review or include the abandoned dirty Place experiments.
- Protected development checkpoint: d1c194abb96ed1147c10ea0b2232be61b7c5947e.
- Annotated tag: long-vod-playback-foundation, peeled to that commit.
- The checkpoint was pushed to origin/main. Later documentation commits may
  advance main and origin/main; verify the refs instead of assuming HEAD is
  still the tagged commit.
- The tag preserves the mutually dependent FrigateMax V2, Review, Lab,
  deployment-support, tests, and handoff state. It is a protected development
  checkpoint, not a production Review known-good claim. Never move, recreate,
  or delete it without explicit user authorization. Preserve older protected
  tags, including review-views-known-good.
- Five generated Python bytecode files were excluded from the checkpoint.
  They may remain untracked; do not mistake them for project changes.

## 2. Product and security invariants

- Recording time is authoritative. Events, motion, detections, and alerts
  annotate or navigate recording; they do not prove that video exists.
- Review has a shared absolute incident-time investigation clock, conceptually
  independent from Live. Cameras are equal viewpoints on an incident; there
  is no product-level primary camera. Changing viewpoint must preserve time.
- Live and Review are distinct contexts. Preserve stable Live behavior and
  existing Home Assistant workspace persistence semantics.
- Keep actual recording gaps visible and preserve truthful visual context.
  Internal Frigate, provider, file, VOD, HLS, and authentication boundaries
  should be invisible to the operator where practical.
- Never expose camera or provider credentials, private provider mappings,
  recording filesystem paths, bearer tokens, auth signatures, or secrets to
  the browser, logs, diagnostics, documentation, or reports.

## 3. Current historical-playback direction

- Prefer one native Frigate VOD presentation, one video element, and one Hls
  instance per camera during ordinary in-presentation playback.
- Coordinate peer commands by the same absolute incident epoch. Each camera
  may have a different media position for that epoch.
- Map each presented requestVideoFrameCallback mediaTime through that
  camera's immutable V2 presentation map. The resulting representedEpoch is
  presented-frame truth; video.currentTime or a synthetic clock cannot prove
  which recording frame is visible. Keep requested, resolved, and represented
  epochs distinct.
- Async work must recheck its current request, camera assignment,
  presentation, and player ownership before applying results. Stale work may
  release only resources it owns.
- V1 recording availability is the bounded coverage authority; its
  operational merge tolerance is 1.5 seconds. V2 preparation provides a
  continuous recording run, logical/effective bounds, and a piecewise
  wall-time/media map. Physical/keyframe lookahead is not logical coverage.
  Logical ends are half-open, and genuine gaps stay explicit.
- The simplified Lab observer uses no permanent staging player, ordinary
  in-presentation successor, synchronization correction loop, or synthetic
  playback clock. Introduce those mechanisms only if later runtime evidence
  demonstrates a need. Do not automatically revive the older coordinator.
- Desired gap behavior is truthful context: a camera may hold its last
  validated edge frame while peers continue, with the gap still shown on the
  timeline. Final production gap and boundary behavior remain unaccepted.
- The earlier dynamic production multi-camera join/leave state machine passed
  tests but failed runtime acceptance with black/Preparing/video cycling,
  unreliable joins, and temporal divergence. Do not tune that state machine
  casually or treat its tests as runtime proof.

## 4. Runtime-proven experimental evidence

These observations came from the deployed development environment. They do
not establish production Review acceptance of the current 7,200-second V2
policy.

### One mapped seek, then hands off (2026-09-26)

The isolated path is Frigate native VOD -> ordinary hls.js -> one paused video
per camera -> one authoritative mapped seek toward common absolute T -> Play
-> passive observation only. It bypasses the recent Place state machine.
There is no first-frame-at-or-after rule, frame chasing, iterative refinement,
exact-frame/50-ms acceptance, leader/follower, correction, or extra player.
A mapped current-operation RVFC is accepted before/after T, before seeked,
and at readyState 1. within1000ms is diagnostic only; distance never gates Play.

The zero-seek control requested identical native [T,E] but the physical origins
differed: drive_up began 2.371s before T, drive_down 9.371s before T. Natural
represented-time separation was about 5.65s; common request bounds alone did
not align the media origins.

The one-seek run used drive_up/drive_down, T=1790448870.371,
E=1790449470.371, ordinary fractional historical time with finalized continuous
coverage. Independent targets were 2.371000051498413s and
9.371000051498413s. Initial RVFC mediaTimes 2.35s/9.35s both mapped to
1790448870.35 (T minus 21.000147ms): zero initial pair error. Both observations
arrived before seeked at readyState 1 and were accepted without another seek.

After 150.018 wall seconds at 1x, 144 approximately 1Hz paired samples showed
50ms median / 60.056ms p95 / 100ms maximum sampled absolute error. Sign is
drive_down minus drive_up: first playback error 0ms, range -100 to +50ms,
ending sample -100ms. Play invocation skew was 0.400ms, uncompensated.
Descriptive fitted trend -27.568ms/min is NOT proven persistent clock drift.
Median/p95/max callback-pair separation was 0/33.4/66.6ms; extrema are sampled,
not an every-frame bound.

Actual browser property/method auditing, including hls.js, found exactly one
initial currentTime write per camera and, after Play, zero currentTime/rate
writes, seeking events, corrective pause/play, synchronization actions, or
source replacements. One Play call and one source per camera. Exactly two
videos/two Hls instances; teardown returned active counts to zero.
Effective represented rates were 0.999017x/0.998351x; RVFC counts 2616/2593;
frame deltas 2996/2999; dropped-frame deltas 0/0; waiting/stalled 0/0 and 1/0.
Both decoded 3840x2160, with zero HLS/media/HTTP errors or unmapped playback
observations. All 40 captured responses were HTTP 200; 40 HA bearer request
setups succeeded, with no refresh required in this run.

This runtime result supports materially aligned, healthy two-camera natural
1x playback after one mapped seek, with no adjustment during this observation.
It supplies no measured need for more precise placement or ongoing correction.
Production Review has not adopted or runtime-accepted this architecture.
Longer-duration hands-off stability, higher rates, more than two cameras,
other camera combinations/targets, finite-presentation continuation, and
production gaps remain unproven/unresolved. The prior hour-long experiment
and older high-rate results do not automatically validate this exact path.

### Two-camera long VOD at 1x

Two independent cameras completed a deliberately finite one-hour presentation
using one video and one Hls instance each, without staging, successors, source
replacement, correction, or a synthetic clock. Playback was visually
synchronized; natural represented-time error stayed roughly within 100 ms.
The successful long run had no HLS errors, waiting, or stall events.

### Authentication and installed integration

The successful Lab historical-HLS path used HA bearer authentication on each
HLS request. Three HA token refreshes occurred underneath the same continuous
media presentations, beyond the former 900-second signed-path lifetime.
Authentication lifetime is experimentally separate from presentation lifetime.
The old signed-path approach is no longer the preferred Lab HLS path.
The installed Frigate HA integration currently has the small upstream-compatible
authenticated-segment fix that accepts an HA-authenticated request instead of
authSig. A HACS/integration update could overwrite this installed-file patch
until an upstream release containing it is installed. Keep authentication
material private.

### Native Frigate/nginx-vod boundary

Direct deployed measurement: 1,080 Frigate mapping clips returned HTTP 200;
1,081 returned HTTP 503. FrigateMax preparation itself succeeded at 1,081.
Failure happened during nginx-vod manifest construction, before HLS playback;
the diagnostic was "media_set_parse_durations: invalid number of elements in
the durations array 1081". This is a measured provider boundary, not a source
constant or a playback-endurance inference. Distinguish mapping-clip count from
recording-row count and time-map span count.

### Large-presentation random access

A successful drive_up presentation had 1,080 mapping clips and represented
about 2h59m41s of wall time. Direct absolute seeks across it retained the same
video, Hls instance, session, and presentation. Truthful RVFC frames were
obtained throughout; absolute mapping error was about 0-10 ms and
seek-to-truthful-frame latency about 1.2-2.5 seconds in that experiment.

### All-camera two-hour clip measurement

All 11 configured cameras had continuous recording over the same finalized
exact interval, 2026-09-25 12:00:05-14:00:05 UTC,
[1790337605, 1790344805). Nine cameras had 721 mapping clips; patio and
side_gate had 720. Mean was 720.82; worst-case headroom below the measured
1,080 ceiling was 359 clips (66.76% utilization). Every camera was below
900 clips. This supports a fixed two-hour policy for the measured workload;
it does not validate production playback of that policy.

## 5. Source and automated-test evidence only

- Normal FrigateMax V2 now caps a presentation at 7,200 seconds. The recording
  query envelope expanded to plus/minus 7,200 seconds, with a 14,460-second
  maximum query guard. The checkpoint validation was backend 39/39, focused
  historical/playback/Lab JavaScript 407/407, full JavaScript 542/542, syntax
  checks passed, and git diff --check passed.
- The change preserves the forward-biased window, 15-second preroll, end
  backfill, Review bounds, continuous-run constraint, genuine gaps, half-open
  logical end, physical/keyframe lookahead, microsecond mapping, safe camera
  IDs, sanitized response, and authentication behavior.
- Normal V2 does not expose the Lab's experimental clip counts. The normal
  7,200-second V2 policy is committed and test validated but has NOT received
  production runtime acceptance.
- Review's "When" selection default remains 3,600 seconds. That UI range
  default is separate from the V2 media-presentation maximum; do not change
  it merely because V2 supports two hours.
- Older Lab single-camera/high-rate and coordinator results belong to earlier
  architectures. They do not accept higher rates on the simplified long-VOD
  architecture. Source/tests are never a substitute for browser/HA runtime
  evidence.

## 6. Lab and deployment context

- The new isolated modules are
  src/investigation-lab/native-vod-sync-experiment.js and
  src/investigation-lab/one-seek-vod-experiment.js. Instantiate the latter with
  common start/end, per-camera preparations, Hls, createVideo, getAuth, and
  expectedOrigin; then startPlayback(), observe passively, report(), destroy().
  Each preparation has identical requestedStart/requestedEnd and an immutable
  observationPresentation covering the native physical media, including lead-in;
  a logical [T,E] crop cannot truthfully map frames before T. Existing safe
  FrigateMax recording/clip association and piecewise mapping produced this
  sanitized map; no backend behavior changed. Auth uses the HA auth object and
  bearer-per-request xhrSetup. No credentials/provider paths enter reports.
- The one-seek runtime build was ONE SEEK LAB 813add4-8d6b56, deployed through
  mapped Z: without restart. Modules have build placeholders substituted by
  the isolated harness; the existing dashboard Lab entry does not route through
  them. Do not mistake the dirty legacy Lab UI for this checkpoint's path.
- Focused checkpoint validation: one-seek 16/16, native 12/12, authoritative
  mapping 15/15 (43/43 total), syntax and whitespace checks. Tests are separate
  from the browser result above. Temporary raw runtime JSON/REPORT files are
  deliberately not committed; section 4 preserves the sanitized findings.
- The active custom:investigation-playback-lab card uses exactly two distinct
  safe camera IDs and the long-VOD observer in
  src/investigation-lab/long-vod-two-peer-experiment.js. It is isolated from
  production ReviewController. Its peer-local time maps and RVFC observations
  report natural synchronization without correction.
- The checkpoint retains prior Lab engines/coordinator tests and temporary
  Lab-only FrigateMax preflight/exact-range actions. Keep this diagnostic
  infrastructure available for reproducibility; do not automatically
  productionize it or discard it as dead code.
- A stable Lovelace module resource points to
  /local/nvr-card/investigation-playback-lab-loader.js. The loader imports a
  versioned Lab entry. Deployment derives a LAB <git>-<manifest> marker,
  substitutes versioned imports, and verifies generated bytes. Two successive
  builds loaded after ordinary refresh without changing the Lovelace URL.
  Deployment or service restarts require explicit task authorization.

## 7. Major unresolved work

1. Accept 2x, 4x, 8x, 16x, and useful slower rates on the simplified long-VOD
   architecture. Earlier high-speed results do not transfer automatically.
2. Scale beyond two simultaneous historical streams: four cameras first,
   then nine or eleven if warranted. Measure natural synchronization at
   higher rates and camera counts before considering correction.
3. Define and runtime-accept the simplest robust continuation at a real
   presentation boundary. With two-hour presentations, a boundary arrives
   about every two hours at 1x, one hour at 2x, 30 minutes at 4x, 15 minutes
   at 8x, and 7.5 minutes at 16x. Do not automatically revive permanent
   active/staging architecture.
4. Runtime-accept final production behavior at genuine recording gaps,
   including truthful held frames while other cameras continue.
5. Runtime-accept normal production Review using the new 7,200-second V2
   policy. The complete production Review playback engine is not proven.

## 8. Recommended next technical experiment

Run a longer bounded 1x hands-off observation using this exact one-seek
architecture with two cameras and finalized continuous coverage. One mapped
initial seek per camera, truthful resulting RVFC regardless of offset, common
Play calls, then zero playback adjustments until teardown. Measure natural
pair-error distribution/trend, represented rates, RVFC/frame progress,
HLS/media/network/auth health, waiting/stalls, and balanced resources.
Keep frame precision, correction, speed/scaling, continuation, and gap redesign
outside that investigation. A different explicit user task takes precedence.

## 9. Git and evidence safety

- At the start of each task verify branch, HEAD, origin/main, worktree,
  staged state, and relevant protected tags. Resolve disagreements against
  Git/source/runtime evidence before acting.
- Preserve one-seek-hands-off-playback, long-vod-playback-foundation, and older
  tags. Do not create tags
  merely because code was committed; meaningful new tags require
  runtime-proven checkpoints and explicit authorization.
- Separate source facts, automated tests, experimental runtime observations,
  production runtime acceptance, inference, and unresolved hypotheses.
- Preserve user-owned dirty work. Do not clean, reset, revert, stash, merge,
  deploy, or restart systems without task authorization.

## 10. Fresh-session bootstrap

1. Fetch remote refs.
2. Verify main, origin/main, HEAD, working tree, staged state, and protected
   tags against Git; confirm long-vod-playback-foundation still peels to
   d1c194abb96ed1147c10ea0b2232be61b7c5947e.
3. Read VISION.md.
4. Read this CODEX_HANDOFF.md.
5. Inspect only architecture, source, and tests relevant to the assigned task.
6. Verify and preserve one-seek-hands-off-playback and the protected
   long-vod-playback-foundation checkpoint. Preserve abandoned dirty Place work
   and generated bytecode without treating them as part of the one-seek path.
7. Unless the user gives a different task, begin with the bounded two-camera
   longer 1x hands-off observation in section 8.
