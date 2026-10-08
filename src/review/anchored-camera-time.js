/**
 * Isolated continuous-media clock experiment; unused by production playback.
 * The caller supplies the landed frame's recording-time estimate and RVFC
 * mediaTime, and owns camera/session membership and observation ordering.
 * Provider spans, requested targets, wall time, and playback rate are not inputs.
 */

function finite(value, field) {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be finite.`);
  return value;
}

/**
 * Establish or explicitly replace a relationship after positioning.
 * Each frozen anchor is a distinct ownership identity, even for equal values.
 * A genuine recording break requires an external decision and a new anchor;
 * this module neither detects gaps nor bridges them automatically.
 */
export function createAnchoredCameraTime(anchorAbsolute, anchorMediaTime) {
  const anchor = Object.freeze({
    absoluteTime: finite(anchorAbsolute, "Anchor absolute time"),
    mediaTime: finite(anchorMediaTime, "Anchor media time")
  });
  return Object.freeze({ anchor, mediaTime: anchor.mediaTime });
}

/**
 * Apply a frame to the caller's current state. Capture expectedAnchor when
 * registering observation work; null means that relationship was replaced.
 * This follows Review's object-identity ownership convention without adding
 * another session lifecycle. The caller must always pass its current state.
 */
export function observeAnchoredCameraTime(state, expectedAnchor, mediaTime) {
  if (state.anchor !== expectedAnchor) return null;
  return Object.freeze({
    anchor: state.anchor,
    mediaTime: finite(mediaTime, "Observed media time")
  });
}

export function anchoredCameraTime(state) {
  return state.anchor.absoluteTime + (state.mediaTime - state.anchor.mediaTime);
}

/** Signed seconds: first camera minus second; includes initial landing offset. */
export function anchoredCameraResidual(first, second) {
  return anchoredCameraTime(first) - anchoredCameraTime(second);
}

/**
 * PROVISIONAL policy, separate from the camera clock. The caller chooses the
 * participating states; no participants means no frontier (null). A buffering
 * participant holds this frontier while another camera continues ahead.
 * Membership changes can move it backward/forward; no clamp or policy is hidden.
 */
export function provisionalReviewFrontier(states) {
  if (states.length === 0) return null;
  return states.reduce((frontier, state) =>
    Math.min(frontier, anchoredCameraTime(state)), Infinity);
}
