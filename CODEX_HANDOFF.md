# CODEX development handoff

> **READ THIS FILE FIRST WHEN ENTERING A NEW CODEX THREAD.**
> Do not rescan the repository unless a fact here conflicts with Git or the
> next task requires additional source inspection.

This is a current-state index, not an authority over source, Git, or runtime
evidence. Authority order: Git/source/runtime evidence/protected checkpoints;
then `VISION.md` for product design; then this file for continuity.

## 1. Bootstrap procedure

Run only these cheap checks first:

```powershell
git branch --show-current
git rev-parse HEAD
git status --short
```

Compare `origin/main` only when relevant to the requested task. Do not
recursively inspect the repository. If those checks sufficiently agree with
this handoff, inspect only task-relevant files. If Git materially disagrees,
stop and report the discrepancy; do not silently reconstruct history or change
anything.

## 2. Working relationship

- ChatGPT and the user own architecture, research, diagnosis, design choices,
  runtime interpretation, and task orchestration.
- Codex works directly in this repository/development environment.
- Automated tests are not runtime acceptance; the user performs normal
  Home Assistant/Frigate runtime acceptance.
- Do not independently broaden implementation scope.

## 3. Core product invariants

- Recording time is authoritative; events/detections annotate it but do not
  establish video existence.
- Incident absolute time organizes Review. Cameras, including all future
  investigation cameras, are peer viewpoints: there is no product-level
  primary camera.
- Hide recording/VOD/HLS/auth boundaries where practical.
- Live and Review are distinct; Review work must not regress Live.
- Never expose security-sensitive/private backend detail to the browser.
- Preserve stable operator investigation context.

## 4. Protected baseline and checkpoints

The preceding `main` baseline is `32a6141937c89e5132439b56bd598f92d51d32f1`.
`review-views-known-good` remains at that baseline. The current development
checkpoint is the commit pointed to by the annotated
`long-vod-playback-foundation` tag. This tag preserves the current playback,
V2, Lab, regression-test, and deployment-support source; it is not a production
Review known-good claim.

Relevant protected tags currently present include:

- `recording-availability-api-known-good`
- `review-historical-sync-known-good`
- `review-timeline-foundation-known-good`
- `review-timeline-sync-migration-baseline`
- `review-ui-foundation-known-good`
- `review-ui-time-state-known-good`
- `review-views-known-good`
- `documentation-known-good`

Protected tags must not be moved, recreated, or deleted without explicit user
authorization.

## 5. Checkpoint worktree

The checkpoint includes the previously dirty Review/V2, FrigateMax, Lab,
deployment-support, and associated test files as one dependent state. Generated
Python bytecode under `__pycache__` was excluded. Recheck `git status` before
new work; do not assume the checkout is clean because the checkpoint exists.

## 6. Established Review/V2 architecture

- V1 recordings/availability is the bounded recording-coverage authority;
  operational availability merge tolerance is 1.5 seconds.
- V2 VOD prepare now allows up to 7,200 seconds of historical presentation,
  logical/effective bounds, coverage run, and a piecewise wall-time/media map.
- The 7,200-second normal V2 policy and its 14,460-second query guard are locally
  implemented and automated-test validated, but have not received production
  runtime acceptance. Review's default When selection remains 3,600 seconds.
- `src/review/historical-presentation.js` owns pure epoch/media conversion.
- Home Assistant signing remains separate.
- Phase-B production direction is one video and one active HLS per camera.
- Provider physical look-ahead is excluded from logical time authority.
- Request/video/media mapping must preserve absolute incident-time semantics.

## 7. Failed production experiment: do not casually resume

Dynamic multi-camera availability/join-leave orchestration was implemented and
passed automated tests, but failed human runtime acceptance: black -> Preparing
-> video -> black cycling, unreliable joins, increasing independent-camera
temporal divergence, and incoherent multi-camera investigation. Do not patch or
tune that state machine without a deliberate new architecture decision.

## 8. Reference runtime evidence

- Native Frigate keeps peer cells visually populated better; one camera can be
  fluid while secondary cells are coarse/stutter-step. It is useful prior art,
  not the target UX.
- Lorex showed stable populated peer cells, a shared timeline, reasonably
  synchronized multi-camera motion, and no repeated blank/preparing cycling.
  It is a UX reference, not evidence of undocumented internals.

## 9. Current architectural direction

Visual continuity is not recording continuity. Across a recording gap, desired
camera behavior is `motion -> truthful held edge frame -> motion`; with no later
recording, hold the final truthful frame indefinitely. The timeline must still
truthfully show gaps. Future coverage is known, so prepare expected transitions
rather than discovering them reactively. Investigation-set changes may
pause/recompute the scene; ordinary known coverage transitions must not freeze
peers.

Potential future regimes (not production-proven): paused/scrubbing uses
recording-derived temporal imagery; normal playback uses prepared/buffered
full-motion; high-speed investigation likely needs absolute-time-driven sampled
imagery or another optimized renderer rather than assumed literal 16x video.

## 10. Investigation Playback Lab (active experiment)

Standalone card: `custom:investigation-playback-lab`; the current experiment
requires exactly two distinct safe camera IDs under `cameras:`. Relevant files:

- `investigation-playback-lab.js`
- `src/investigation-lab/long-vod-two-peer-experiment.js` (current observer)
- `src/investigation-lab/single-camera-engine.js`
- `src/investigation-lab/rvfc-peer-coordinator.js` (prior experiment)
- `test/investigation-long-vod-experiment.test.js`
- `test/investigation-playback-lab.test.js`
- `src/review/historical-presentation.js` (shared dependency)

It must remain isolated from `ReviewController` and production Review behavior.

The active Lab card now runs a 1x, two-camera long-VOD observer. V2 prepares
one coverage-run-bounded presentation of up to 7,200 seconds per camera. Each
camera has one video/Hls pipeline, its own epoch/media map, and RVFC-derived
represented time. The first configured camera is only an observation reference;
the second minus first represented epoch is the reported pair error. There is
no correction, synthetic clock, staging, successor, or source transition in
this experiment. Place, Play, Pause, Resume, Reset, and Copy diagnostics are
available. The 1,024-sample ring defaults to one-second cadence so a 15-minute
run can retain its full sampled timeline. At this checkpoint, backend tests
pass 39/39, focused JavaScript tests pass 407/407, and the full JavaScript
suite passes 542/542. The simplified observer has the bounded runtime evidence
in section 13. The previous transition and coordinator modules remain in the
checkpoint for comparison but are not the current card path.

The following coordinator details document the prior experiment, not the
current Lab behavior.

The experimental Scene Coordinator owns scene revision, transport intent, and a
monotonic elapsed-time target clock. Two equal peer renderers independently own
their represented frames and sessions. Camera observations report divergence
but cannot redefine or stop the scene clock or the healthy peer. The Lab now
has an experimental peer-local synchronization controller with TRACKING,
CORRECTING, and REACQUIRING states. It never derives scene time from a camera,
and there is no primary camera or intentional coarse peer sampling.

Initial controller policy is deliberately conservative and runtime-tunable:
0.75-second deadband with 0.35-second exit hysteresis; 1.5-second moderate-error
persistence; proportional correction quantized to 0.05x and capped at +/-10%;
5-second large-error threshold with 0.5-second persistence; 3-second stale-frame
threshold; 8-second maximum correction attempt; and camera-local reacquisition
limited to two attempts per play run with a 5-second cooldown. These constants
are experimental, not accepted synchronization targets.

Peer reacquisition resumes only after the renderer reports an explicit
`acquired` outcome: a current operation has a newly validated RVFC frame at
the requested target within the existing tolerance and still owns the active
session/presentation. `unavailable`, `superseded`, and `failed` outcomes do
not resume a retained truthful frame; the peer remains `REACQUIRING`.

The renderer-only `reacquire()` result is bounded to `acquired`,
`unavailable`, `superseded`, or `failed`; ordinary `place()` retains its
boolean completion behavior. `reacquisitionCount` remains an attempt counter,
and `reacquisitionOutcome` reports the latest bounded result. Focused Lab and
Scene Coordinator tests passed 49/49 (34 + 15); full JavaScript passed
482/482; both changed modules passed `node --check`; `git diff --check`
passed. This is automated/source evidence only.

Time model:

- `requestedEpoch`: operator intent.
- `resolvedEpoch`: deterministic recording-backed navigation result.
- `representedEpoch`: absolute epoch derived from an actually presented frame.

`requestVideoFrameCallback()` is mandatory; there is no synthetic fallback.
Existing truthful active visual stays visible while a hidden staging candidate
completes V2/sign/readiness/seek/presented-frame validation and ownership checks.
Only then commit atomically. Stale work cannot commit or destroy newer resources.

## 11. Recent represented-frame and visible-ownership correctness fixes

Old acceptance could authorize a stale callback by comparing callback distance
to target with `video.currentTime` distance. The focused regression emits stale
callback metadata while seeked `video.currentTime` remains target-like, then
emits the correct frame. It failed before the fix due to premature commit.

Acceptance now requires callback `mediaTime`, mapped through the validated
presentation map, within the existing 0.05-second tolerance of the resolved
target. `video.currentTime` cannot authorize a wrong presented frame. Current
focused Lab suite: 22/22 passing.

A canceled in-map seek now records the held image's represented epoch and
session ownership, then requires the reused renderer to seek and revalidate a
presented frame before it can resume visible progression. The exclusive logical
endpoint is rejected as an unrepresentable frame; playback stops on a validated
pre-end frame and retains that truthful image when available. These corrections
are source/test proven only; browser visual acceptance remains outstanding.
The runtime-reproduced `Place -> Play -> <<` paused-seek race armed target-frame
observation after `seeked`, allowing a browser to present the only paused target
frame too early. Observation is now armed before assigning the seek target and
is jointly awaited with seek settlement; the pending paused state is emitted.
Focused Lab tests: 27/27 passing; shared historical mapping tests: 10/10
passing; full JavaScript suite: 459/459 passing. Browser acceptance remains
outstanding.

The represented-time feedback audit found that frame epochs themselves were
mapped correctly from the active session's RVFC `mediaTime`, but coordinator
`observedAtMs` incorrectly refreshed on every renderer state emission. Rate or
control activity could therefore make a stale represented epoch appear fresh.
The engine now exposes the timestamp of the last validated RVFC observation,
and the coordinator uses only that timestamp for staleness. Pause also drains a
queued already-presented frame so the eventual frozen epoch is not lost at the
pause edge. No deterministic arithmetic or V2 map path was found that creates a
20.000-second peer offset; the earlier exact offset remains unexplained runtime
evidence rather than a proven map defect.

The subsequent read-only diagnosis found RVFC `metadata.mediaTime` is mapped
through each active session's immutable V2 map, and the scene-target arithmetic
is source-trustworthy. A fresh represented epoch is sound recording-derived
evidence; a stale one identifies only the last accepted/held frame, not
necessarily currently progressing imagery. The recurring terminal epochs are
strongly consistent with deterministic final validated frames near different
active presentation logical ends, not manufactured coordinator arithmetic.
This remains a hypothesis: current sanitized diagnostics do not expose enough
active presentation logical wall/media bounds to prove exhaustion as the full
failure cause. Logical-end holds and exclusion of physical VOD lookahead from
logical recording availability remain required. Reacquisition can operate
inside an existing presentation without replacing its session/presentation;
large or stale error bypasses moderate correction and goes directly to it.

## 12. Frontend deployment/cache lesson

Configure the stable Lovelace JavaScript Module resource once as
`/local/nvr-card/investigation-playback-lab-loader.js`. The loader imports a
timestamped Lab entry each page load. Deployment derives `LAB <git>-<manifest>`
and substitutes it into the entry's engine import/visible build label and the
engine's historical-mapping import, then verifies generated bytes and rejects
remaining placeholders. Normal Lab work is deploy then refresh; do not edit the
Lovelace URL per build. Runtime acceptance proved two successive builds loaded
after ordinary refresh with the Lovelace resource unchanged and DevTools closed.

## 13. Prior Lab human runtime evidence

Conventional single-camera playback envelope: 1x PASS, visually excellent,
~0.999x achieved; 2x PASS, visually excellent, ~1.999x; 4x PASS, visually
excellent, ~3.973x; 8x PASS, visually excellent, ~7.996x with zero waiting or
stalled events. At 16x, scanning remains visually useful/acceptable but achieves
~12.964x represented rate, with 18 waiting and zero stalled events; it is not
true 16x temporal traversal. The intended workflow is rapid scan, pause, rewind
a few seconds, then investigate at a lower rate.

Single-camera playback was substantially simpler and visually excellent at 1x,
2x, 4x, and 8x; nominal 16x remained useful for scan/navigation at about
12.964x represented rate. These high-speed checks were not repeated enough to
establish reliability across runs or presentation-boundary conditions. Repeat
representative rates with telemetry and presentation-boundary inspection before
treating them as a proven architectural foundation.

Single-camera runtime acceptance also includes Copy diagnostics and
`Play -> <<` settling requested/resolved/represented at the backward target in
committed-paused state without the prior pending freeze.

With `LAB BUILD: 002` visibly confirmed, exact Place input local incident time
`2026-09-18T18:37:40` reported Requested/Resolved/Represented all
`1789781860.000` (`2026-09-19T01:37:40.000Z`), status `place: committed-paused ·
exact`, and a Garage frame approximately matching its burned-in timestamp.

After Play at 1x then Pause, all three were `1789781886.850`
(`2026-09-19T01:38:06.850Z`), status `pause: paused ·
pause-at-presented-frame`; video visibly advanced. The user's rough "20 seconds"
was a guess, not timing/performance evidence.

Positive runtime evidence is limited to exact Place, an actual historical frame,
converged epochs at Place, visible 1x advancement, and Pause anchoring epochs to
the represented frame. Do not claim more.

Pre-fix two-peer 2x was visually excellent: peer represented epochs were about
200 ms apart, scene errors about +78/-122 ms, achieved rates about
1.985x/1.980x, both TRACKING, with zero corrections/reacquisitions and almost
no transport trouble. 4x was intermittent and had a suspicious exact 20-second
peer difference; 8x lost synchronization after roughly five seconds; 16x had
independent freezes/progression.

The first post-reacquisition-contract runtime test, two-camera 2x, was worse:
both cameras reached `REACQUIRING`/`reacquisition-limit` after two attempts;
Drive Up had three correction entries and Drive Down two. Both latest outcomes
were `acquired`, so unavailable placement being counted as success is not
sufficient to explain the remaining failure. Terminal target was
`1789652120.6536`; Drive Up held `1789652069.940044` (about -50.714 s; RVFC age
19.595 s) and Drive Down `1789652089.940044` (about -30.714 s; age 6.664 s):
again exactly 20 seconds apart. Both remained session/presentation 1/1 with
created/replaced/destroyed 1/0/0. Final rates were 2x; achieved represented
rates were about 2.118x/1.965x; presented/dropped/waiting/stalled were
3181/35/4/0 and 3580/22/5/0 respectively; current/presented media times were
about 173.746178/173.730044 and 192.924448/192.910044. This is runtime evidence
of regression, not proof that presentation exhaustion is the complete cause.

The later simplified long-VOD Lab has one video and one Hls instance per
camera, without a permanent staging player, successor machinery, correction
loop, or synthetic playback clock. Two independent cameras completed a finite
one-hour presentation at 1x with visually good natural synchronization and no
HLS errors, waiting, or stalls. HA bearer-per-request authentication continued
historical HLS beyond the old 900-second signed-path lifetime through three
token refreshes in the same media presentations.

Native Frigate/nginx-vod manifest preparation returned HTTP 200 at 1,080
mapping clips and HTTP 503 at 1,081; nginx-vod reported an invalid durations
array element count. A successful 1,080-clip drive_up presentation covered
about 2h59m41s, with direct absolute seeks, retained video/Hls/session, truthful
RVFC frames, and about 0-10 ms absolute mapping error. All 11 cameras had
continuous recording over the same finalized exact 7,200-second interval:
720-721 mapping clips, mean 720.82, and at least 359 clips of headroom below
the measured 1,080-clip ceiling. These are experimental runtime observations,
not production Review acceptance of the new V2 policy.

## 14. Current Lab visual state

The visible derived `LAB <git>-<manifest>` build uses deterministic dark
surfaces and high-contrast light text, not HA-theme adaptation. Sanitized diagnostics are
selectable and have a copy button with inline success/failure feedback. Do not
spend effort on theme polish unless readability regresses.

Copy first uses `navigator.clipboard.writeText()` and falls back to selecting
the already-rendered sanitized textarea and `document.execCommand("copy")`;
both paths copy only displayed sanitized text. Diagnostics now separate scene
target, represented epoch/RVFC age, video current time, presented media time,
nominal/effective rate, bounded advancement/quality deltas, correction state,
and reacquisition counters. Scene Coordinator tests: 15/15; existing Lab tests:
34/34; full JavaScript suite: 482/482. Controller behavior remains source/test
proven only and requires browser runtime acceptance.

## 15. Next unknowns

The normal V2 7,200-second policy still needs production runtime acceptance.
The simplified long-VOD architecture has not yet accepted 2x/4x/8x/16x
playback, more than two simultaneous historical streams, production
presentation-boundary continuation, or final production gap/held-frame behavior.
Do not treat this development checkpoint as a complete Review playback engine.

## 16. Evidence discipline and handoff upkeep

Distinguish source-code evidence, automated-test evidence, human runtime
evidence, architectural inference, and speculation. Passing tests/source review
are never runtime claims.

After a meaningful implementation change, experiment, runtime result, protected
checkpoint, or next-task change, update only affected sections. Keep this
concise and operational, not a diary; remove superseded detail but retain
negative evidence that prevents repeat failures.
