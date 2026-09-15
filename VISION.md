# FrigateMax / NVR Card vision

## What this document is

`VISION.md` preserves the product direction behind FrigateMax and NVR Card:
what we are building, why it matters, how it should feel to operate, and
which principles should survive implementation changes. It is deliberately
slower-moving than implementation documentation.

The distinction is intentional:

- `VISION.md` describes purpose, operator experience, human factors, and
  long-term direction.
- `ARCHITECTURE.md` should describe implementation: state ownership,
  providers, APIs, security boundaries, and playback mechanics.
- `README.md` provides the concise project introduction, setup information,
  and links into deeper documentation.

## Product vision

FrigateMax is intended to make security-video review and recording inspection
exceptionally easy and efficient inside a Home Assistant NVR dashboard. The
goal is not simply to reproduce Frigate's Review interface. The goal is to
give an operator a fast way to answer routine questions and a precise way to
investigate difficult incidents, in one coherent workspace.

The interface should feel calm, direct, and trustworthy. An operator should
be able to move quickly when the answer is obvious, slow down when the exact
sequence matters, and move between cameras without losing the temporal
context of the investigation.

## Why this matters

Security-video review has two common forms:

- **Show me what happened.** This rewards speed, obvious navigation, and a
  short path from one meaningful activity to the next.
- **Let me investigate exactly what happened.** This rewards temporal
  precision, context before and after an event, continuous recording access,
  visual scrubbing, and movement between cameras.

FrigateMax should serve both workflows without making the operator repeatedly
switch conceptual modes or decode the interface before acting.

## Influences and synthesis

Frigate contributes a rich continuous-time investigation model: recordings,
motion, detections, alerts, Review information, arbitrary seeking, and a
common timeline. Its most important lesson for this project is that event
metadata and recorded video are separate things. FrigateMax should preserve
that richness while reducing the visual interpretation required from the
operator.

Lorex demonstrates the value of a simple event-review path. The useful idea is
the effortless sequence:

```text
event -> event -> event -> event
```

The lesson is the ease of navigation, not Lorex's recording model. FrigateMax
should retain that low-friction event flow while making the underlying
continuous recording available for deeper inspection.

Professional video-management systems such as Genetec Security Center and
Milestone XProtect provide mature examples of recording-availability layers,
activity overlays, bookmarks, playback cursors, timeline zoom, thumbnail
previews, visual scrubbing, synchronized cameras, and explicit recording
gaps. These are valuable human-interface references and prior art.

The project is a synthesis. It should acknowledge established patterns,
adapt the ones that fit a Home Assistant and Frigate environment, and avoid
presenting long-established VMS ideas as inventions unique to FrigateMax.
These influences do not imply affiliation or endorsement; where established
concepts are adapted, their influence should be acknowledged appropriately.

## The fundamental data model

The authoritative backbone is **recording time**.

Review events, motion, detections, alerts, bookmarks, and similar information
are **annotations and navigation aids over recording time**.

An event must never become the authority for whether video exists. Continuous
recording can exist where there is no event, and an event annotation can exist
near a recording boundary. The interface must preserve that distinction.

The timeline therefore has independent conceptual layers:

1. actual recording availability;
2. motion and activity;
3. object detections;
4. alerts and important Review events; and
5. the current investigation or playback time.

The operator should be able to tell immediately:

```text
Video exists here.
Something happened here.
This is what kind of thing happened.
I am here.
```

Those are different facts. They should not be collapsed into one marker,
color, or event-only playback model.

## One interface, two review workflows

### Rapid event review

The operator should be able to select an activity and move naturally to the
previous or next meaningful activity. Controls such as **Previous activity**
and **Next activity** should be obvious and should not be confused with fixed
time movement.

An optional quiet-time accelerator may advance playback to the next meaningful
activity after the current activity ends. When it is off, playback continues
normally through continuous recording. Event hopping is an accelerator laid
over continuous recording; it is never a replacement for continuous-time
playback.

### Recording and forensic inspection

The same workspace should support arbitrary continuous-time investigation. An
operator should be able to:

- click anywhere recording exists and start there;
- scrub through continuous recording;
- inspect time before and after an event;
- cross event boundaries without artificial stops;
- jump fixed amounts backward and forward;
- zoom from broad periods to fine time resolution;
- change camera viewpoint without losing investigation time; and
- inspect quiet periods with no event metadata.

This should behave like a capable DVR or VMS, rather than an event-clip
browser.

## Transport controls explain their meaning

Controls should distinguish movement through **time** from movement through
**meaning**. A conceptual transport group is:

```text
Previous activity | -10 seconds | Pause / Play | +10 seconds | Next activity | Speed
```

Previous and next activity navigate annotations. Minus and plus ten seconds
navigate absolute time. These operations should have visibly and behaviorally
different meanings so the operator never has to remember which nearly
identical arrow does what.

## The timeline is a layered time ruler

The existing right-hand vertical timeline is a good foundation. It does not
need to become horizontal simply because another product uses a horizontal
timeline. Its direction may evolve, but its conceptual role should remain a
layered time ruler rather than an event-only display.

At any point the operator should be able to distinguish recording, gaps,
activity, detections, important alerts, and the current investigation time.
The visual treatment may change as the design matures, but the separation of
these facts must remain visible.

## Visual scrubbing and recognition

Visual scrubbing is a long-term capability. During a drag, the operator should
be able to see representative frames from candidate times and release once the
scene is understood. Intermediate pointer positions should not each start a
full HLS playback transition.

The intended interaction is:

```text
mouse down / drag timeline
    -> preview representative frames
    -> release
    -> begin playback at the selected time
```

This follows the human-factors principle **recognition over recall**. The
operator should see what was happening rather than infer it from a timestamp
and a collection of markers. As the timeline zooms in, preview sampling can
become finer.

## Future targeted visual search

The architecture should leave room for a more advanced forensic-search flow:

1. show representative thumbnails across an interval;
2. identify between which frames the relevant change occurred;
3. narrow the interval;
4. show finer-grained thumbnails; and
5. repeat until the moment is located.

This is a future investigation capability, not an immediate implementation
requirement. Current choices should not make it impossible.

## The shared investigation clock

Review time is an **investigation clock**, not merely the playback position of
one camera. Selecting `18:21:15` means that the investigation is at
`18:21:15`; it does not merely mean that one selected camera happens to be
playing that timestamp.

Every camera is a viewpoint onto the same absolute time. This lets an operator
reconstruct an incident naturally: follow a vehicle on Drive Up, inspect Drive
Down at the same time, then examine Front Entry, Garage, or Side Gate without
rebuilding the temporal context.

The Review clock must remain conceptually independent from Live mode. The
existing decision to give Review ownership of an absolute clock supports this
vision and should be preserved.

## The camera is a viewpoint

> **The camera is a viewpoint on an incident. The incident and its time are
> the organizing concept.**

Traditional camera interfaces often make each camera behave like an isolated
DVR. FrigateMax should instead let the operator follow an incident through
time. Selecting an event from one camera should be capable of moving the
shared investigation clock. Changing cameras should change the viewpoint,
not erase the temporal context.

Multi-camera layouts should eventually let activity from all visible cameras
contribute to one understandable timeline while keeping camera identity clear.
Garage, Drive Up, Drive Down, Front Door, Front Entry, Side Gate, and other
cameras should be inspectable relative to the same instant.

## Human-factors principles

The interface should optimize for extremely low cognitive overhead. Favor:

- recognition over recall;
- obvious controls over cryptic iconography;
- direct manipulation;
- immediate visual feedback;
- stable spatial layout;
- preservation of context;
- minimal mode switching;
- progressive disclosure of detail;
- fast common-case workflows;
- reversible navigation; and
- consistent time semantics.

Routine questions should be easy to answer:

- What happened while I was gone?
- What happened next?
- What happened immediately before this?
- What did another camera see at this exact time?
- Is there video here even though there was no event?
- Where did that person or vehicle go?

The operator should not need to understand Frigate's internal data model in
order to answer them efficiently. The interface should make the right model
visible without making the operator learn its implementation vocabulary.

## Long-term direction

The target experience combines:

```text
Lorex's effortless event hopping
    +
Frigate's rich metadata and continuous recording
    +
Proven professional-VMS scrubbing and forensic navigation
    +
FrigateMax / NVR Card's synchronized multi-camera workspace
and shared investigation clock
```

The result should be especially well suited to a Home Assistant and Frigate
environment: fast for ordinary review, precise for investigation, honest
about recording gaps, and clear about which camera is providing each view.

FrigateMax is not intended to become a clone of Frigate, Lorex, Genetec,
Milestone, or another VMS. Those systems are references from which to learn
proven interaction patterns. The project should combine applicable strengths
without inheriting another product's limitations simply for familiarity.

## Product boundaries

The vision depends on a few durable boundaries:

- Recording availability remains separate from event and Review metadata.
- The shared investigation clock remains separate from the Live workspace.
- Cameras remain viewpoints that can change without discarding time context.
- Home Assistant and Frigate remain foundational systems rather than details
  to hide through an imitation of their entire products.
- Credentials, authentication material, and private media paths do not belong
  in the browser-facing experience.
- Implementation decisions should preserve the operator's ability to move
  between rapid review and exact investigation.

## Prior art and official references

These projects provide technical foundations, established interaction
patterns, or human-interface inspiration. The links are references, not claims
of affiliation or endorsement:

- [Frigate](https://docs.frigate.video/) — local NVR, continuous recording,
  motion, object detection, Review, and recording navigation.
- [Lorex](https://www.lorex.com/) — straightforward consumer security-video
  workflows and event-oriented navigation.
- [Genetec Security Center](https://www.genetec.com/products/unified-security/security-center)
  — professional VMS concepts for unified investigation and operations.
- [Milestone XProtect](https://www.milestonesys.com/solutions/platform/xprotect/)
  — professional VMS concepts for timeline navigation, recording review, and
  multi-camera investigation.
- [Home Assistant](https://www.home-assistant.io/) — the dashboard,
  integration, camera, and user environment in which this project operates.
- [go2rtc](https://github.com/AlexxIT/go2rtc) — upstream media and transport
  technology used as technical context where applicable.

The project should continue to credit relevant prior art as new influences
are adopted. Mature ideas are valuable because they have already been tested
by operators; acknowledging that history improves both engineering judgment
and documentation honesty.
