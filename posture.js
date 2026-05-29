// Pure posture logic — no DOM, no time, no IO. This is the part worth testing
// and the part most likely to break when tuning sensitivity. See posture.test.js.

/** Posture states. Values are stable strings used as CSS classes and log fields. */
export const POSTURE = Object.freeze({
  GOOD: 'good',
  FORWARD: 'forward',
  LEAN_LEFT: 'lean-left',
  LEAN_RIGHT: 'lean-right',
});

/** Outcome of a bad-posture episode, derived from how long it lasted. */
export const OUTCOME = Object.freeze({
  CORRECTED: 'corrected',
  CORRECTED_SLOW: 'corrected-slow',
  IGNORED: 'ignored',
});

/** Lateral threshold as a fraction of the forward threshold. Shoulders move
 *  less than the head during natural movement, so the lateral gate is tighter. */
export const LATERAL_RATIO = 0.6;

/** Minimum keypoint visibility below which we don't trust the coordinates. */
export const MIN_VISIBILITY = 0.5;

/**
 * @typedef {{ x: number, y: number, visibility: number }} Keypoint
 * @typedef {{ nose: Keypoint, leftShoulder: Keypoint, rightShoulder: Keypoint }} Pose
 * @typedef {{ noseY: number, shoulderTilt: number }} Baseline
 */

/**
 * Offsets of the current pose from the calibrated baseline.
 * @param {Pose} pose
 * @param {Baseline} baseline
 * @returns {{ fDelta: number, lDelta: number }} forward drop and lateral tilt deltas
 */
export function computeDeltas(pose, baseline) {
  return {
    fDelta: pose.nose.y - baseline.noseY,
    lDelta: (pose.leftShoulder.y - pose.rightShoulder.y) - baseline.shoulderTilt,
  };
}

/**
 * Per-frame posture classification. Honest snapshot — temporal smoothing lives
 * in the caller, not here.
 * @param {Pose} pose
 * @param {Baseline} baseline
 * @param {number} threshold forward-slouch threshold (normalized y units)
 * @returns {string} one of POSTURE.*
 */
export function classifyPosture(pose, baseline, threshold) {
  if (pose.nose.visibility < MIN_VISIBILITY ||
      pose.leftShoulder.visibility < MIN_VISIBILITY ||
      pose.rightShoulder.visibility < MIN_VISIBILITY) {
    return POSTURE.GOOD;
  }

  const { fDelta, lDelta } = computeDeltas(pose, baseline);

  if (fDelta > threshold) return POSTURE.FORWARD;

  const lat = threshold * LATERAL_RATIO;
  // y grows downward, so leftShoulder dropping (y rises) means user leans to their own LEFT.
  if (lDelta >  lat) return POSTURE.LEAN_LEFT;
  if (lDelta < -lat) return POSTURE.LEAN_RIGHT;

  return POSTURE.GOOD;
}

/**
 * Human-readable duration. `8s`, `1m 32s`. Nullish → `0s`.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Classify a bad-posture episode by how long it lasted after the first alert.
 * One episode → one outcome, regardless of how many re-nags fired.
 * @param {number} badMs time from first alert until posture returned to good
 * @param {{ fastMs: number, ignoredMs: number }} windows
 * @returns {string} one of OUTCOME.*
 */
export function deriveOutcome(badMs, { fastMs, ignoredMs }) {
  if (badMs < fastMs) return OUTCOME.CORRECTED;
  if (badMs < ignoredMs) return OUTCOME.CORRECTED_SLOW;
  return OUTCOME.IGNORED;
}
