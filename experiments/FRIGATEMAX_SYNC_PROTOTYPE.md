# FrigateMax synchronized historical playback checkpoint

Prototype #1A records the runtime-proven FrigateMax historical synchronization
prototype. Browser-only timing was insufficient because independently prepared
historical players did not expose a shared authoritative origin. Prototype #0
uses a common absolute ReviewClock and authoritative per-camera Frigate VOD
origins to calculate each player seek.

The implementation does not parse filesystem paths. It lazily inspects
Frigate-ordered recording candidates, isolates the first candidate covering the
requested start, requires an unambiguous one-clip mapping, verifies its
adjusted `clipFrom` against the full VOD mapping, and fails closed when the
associated candidate remains ambiguous. This resolves the normal fractional
overlap between adjacent recording rows caused by whole-second cache starts and
fractional probed ends.

Runtime target: `2026-09-08T14:00:00-07:00`
(equivalent UTC: `2026-09-08T21:00:00.000Z`). Safe observed timing values:

- Drive Up: requested clip 6000 ms; adjusted clip 0 ms; effective origin
  `2026-09-08T20:59:39.000Z`; seek 21.000 s.
- Drive Down: requested clip 7000 ms; adjusted clip 0 ms; effective origin
  `2026-09-08T20:59:38.000Z`; seek 22.000 s.

The estimated absolute delta was approximately 27 ms early and approximately
171 ms near one minute. Visual misalignment was difficult to distinguish,
especially near the beginning. No continuous correction loop was running.

**HARD GATE PASSED:** synchronized multi-camera historical playback is viable.
