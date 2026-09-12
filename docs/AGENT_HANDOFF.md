# NVR card agent handoff — migration baseline

This is the starting context for future coding agents. Repository: `nvr-card`, branch `research/frigatemax-sync-prototype`. The checkpoint records the current source/tests and this document; it does not certify every behavior in a real Home Assistant/browser installation. Human runtime validation remains the capability gate.

## Purpose and ownership

This custom Home Assistant NVR application integrates ONVIF cameras, Frigate, the server-side FrigateMax HA interface, and the NVR Card. **The card should orchestrate; it should not unnecessarily become the video system.**

- Live video is HA/ONVIF-owned: persistent HA `hui-image` presentations use configured ONVIF Sub Stream 1 in the grid and Main Stream when maximized. `camera.entity` remains the logical workspace identity; `camera.live.substream` and `camera.live.mainstream` select media sources.
- Frigate owns recordings, Review metadata, detections/events, and historical media. FrigateMax is the server-side authenticated HA gateway to Frigate. The browser/card orchestrates the user experience through HA routes; it must not receive Frigate or camera credentials.
- Live and Review are modes of one application but own separate media/state. Live DOM and player identity persist across a Review round trip. Review must not mutate the Live workspace; returning to Live must restore exact assignments/layout/media identity.

## Current Review implementation

`src/review/review-controller.js` owns Review camera assignments and persistent cells, layouts and primary-camera behavior, and a reactive Cameras/When/Filters query. Edits coalesce over 400 ms; desired and displayed queries are separate, so the displayed Timeline remains authoritative until a successful current response replaces it. There is no query GO/Apply button. When uses vendored flatpickr for dates and direct 24-hour Hour/Minute selectors.

The Timeline uses newest/To at the plot top and oldest/From at the bottom. Click/tap selects historical playback; a Pointer Events handle previews the yellow cursor and bottom Review Time footer without VOD requests on move, then invokes one selection on release. The plot fills the RHS between tabs and the fixed footer. Events render in per-camera lanes with deterministic camera-index palette colors, a single lane label, and a protected time-label gutter. VCR Pause/Play, ±10 seconds, playback speed, and Now use the existing ReviewClock/historical path. Fresh Review starts with zero assigned cameras.

**Hard geometry invariant:** never visually extend an event beyond its actual `[start_time, end_time]` to make it visible. Use an exact point/tick for a too-short interval, not a minimum-duration bar. A former 18px marker minimum falsely made the 2026-09-10 06:53:00 PDT selection (epoch `1789048380`) appear inside later events: Drive Up began 06:53:45.280 and Drive Down 06:53:56.338. Their recordings resumed at 06:53:35 and 06:53:45, respectively. Neither had recording at the selected time; camera IDs and VOD mapping were correct. The frontend marker geometry caused the false visual containment.

## Historical synchronization and open measurement

The historical path requests per-camera FrigateMax VOD timing, uses each camera's effective absolute origin for its independent media seek, waits for pre-seek readiness, seek completion, and post-seek playability, then releases playable cameras together. Playback rate is set before release; an absolute, monotonic ReviewClock is anchored at the common start. Partial camera availability is allowed, stale generations are rejected, and there is no continuous correction loop. Runtime testing reported usually excellent visual inter-camera synchronization. **Do not tune this algorithm without measured evidence of a defect.**

An unresolved runtime time-truth observation: ReviewClock was approximately 16:16:44 while both Drive Up and Drive Down burned-in timestamps were approximately 16:16:42. Native Frigate showed a camera overlay around 16:16:42 with its Timeline indicator around 16:16:51–16:16:52. The two NVR feeds appeared closely synchronized with each other. ReviewClock epoch, recording/media timestamps, and camera burned-in clocks are distinct evidence; neither a camera overlay nor Frigate's UI Timeline should be assumed to be absolute epoch truth.

The next historical task is **development-only measurement/instrumentation, not a sync change**. Capture per camera: selected ReviewClock epoch, effective VOD origin, requested and actual seeked media `currentTime`, readiness completion, reconstructed absolute epoch, barrier release, `play()` issue time, first advancing sample, and inter-camera delta at release and approximately +1, +5, and +30 seconds. Characterize a reported occasional unexpected “No recording available” using selected epoch, displayed-query generation, camera ID, effective origin, available recording/clip interval, and exact rejection reason. Also characterize at least one reportedly worse-than-usual historical start before proposing a fix. Keep these diagnostics development-only and secret-safe.

## Other protected behavior and separate issues

Live workspace hydration has an explicit lifecycle: writes remain closed until restore resolves, and failed hydration must not promote transient defaults. Liveness/terminal recovery is cell-local, gives HA time to recover transient stalls, preserves layout, assignments, maximize state and Saved Views, never writes workspace state merely because media recovered, and uses generations to reject stale replacements.

Separate future tasks, **not part of this checkpoint**: make the 24-hour When controls and 12-hour AM/PM Review Time footer consistent; restore dropping a Layout onto a maximized Live video cell. Neither issue authorizes changing historical sync or Live persistence in a baseline task.

## Baseline, deployment, and agent workflow

Current frontend deployment reported and hash-verified in the preceding pass: **`NVR 5fb57b6-3d251c`**; no HA restart was required. That is a deployed candidate, not a substitute for human runtime review. The checkpoint's commit/tag identify repository state separately from the frontend build identifier.

Verified for this checkpoint: ReviewController **83/83**, full JavaScript **333/333**, FrigateMax/probe Python unittest **9/9**, syntax checks for both changed JavaScript production files passed, and `git diff --check` passed (Git emitted only LF/CRLF working-copy warnings). Use `node --test test/review-controller.test.js`, `node --test test/*.test.js`, and the project `.venv` Python with `-B -m unittest -v test.test_frigate_max_probe`; do not install test tooling without approval.

Before changes, inspect branch/HEAD/status/diff and protect runtime-proven checkpoints. Use bounded commands, architecture-first and incremental edits, focused regressions, then full regression before a checkpoint. Do not let commands hang unexplained. Never expose secrets or copy credentials into browser code, tests, logs, or commits. Secure configured server-side credentials may be used for necessary authenticated **read-only** Frigate diagnosis; credential use is allowed, exposure is not. Distinguish authentication failure from reachability, TLS, and API failure.

Intended migration loop: **Human → ChatGPT design/architecture/review → Cline controller in VS Code → Ollama → local Qwen coding model → repository/tests/deployment → human runtime validation → results back to ChatGPT.** Coding agents should execute bounded prompts, report exact changes and test results, and stop at runtime gates.
