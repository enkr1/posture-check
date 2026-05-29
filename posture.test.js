import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  POSTURE,
  LATERAL_RATIO,
  computeDeltas,
  classifyPosture,
  formatDuration,
} from './posture.js';

// Helper: build a pose where everything is fully visible and at baseline,
// then nudge specific axes. Baseline is nose at 0.4, shoulders level.
const BASELINE = { noseY: 0.4, shoulderTilt: 0 };

function pose({ noseY = 0.4, lShoulderY = 0.5, rShoulderY = 0.5, vis = 1 } = {}) {
  return {
    nose: { x: 0.5, y: noseY, visibility: vis },
    leftShoulder: { x: 0.4, y: lShoulderY, visibility: vis },
    rightShoulder: { x: 0.6, y: rShoulderY, visibility: vis },
  };
}

test('computeDeltas: fDelta is nose drop from baseline', () => {
  const { fDelta } = computeDeltas(pose({ noseY: 0.45 }), BASELINE);
  assert.ok(Math.abs(fDelta - 0.05) < 1e-9, `expected ~0.05, got ${fDelta}`);
});

test('computeDeltas: lDelta is shoulder tilt minus baseline tilt', () => {
  // left lower than right by 0.03 → tilt 0.03, baseline 0 → lDelta 0.03
  const { lDelta } = computeDeltas(pose({ lShoulderY: 0.53, rShoulderY: 0.5 }), BASELINE);
  assert.ok(Math.abs(lDelta - 0.03) < 1e-9, `expected ~0.03, got ${lDelta}`);
});

test('classifyPosture: upright at baseline is good', () => {
  assert.equal(classifyPosture(pose(), BASELINE, 0.05), POSTURE.GOOD);
});

test('classifyPosture: nose dropped past threshold is forward', () => {
  assert.equal(classifyPosture(pose({ noseY: 0.46 }), BASELINE, 0.05), POSTURE.FORWARD);
});

test('classifyPosture: forward boundary is exclusive (== threshold is good)', () => {
  // fDelta exactly 0.05, threshold 0.05 → uses > so NOT forward
  assert.equal(classifyPosture(pose({ noseY: 0.45 }), BASELINE, 0.05), POSTURE.GOOD);
});

test('classifyPosture: left shoulder lower → lean-left', () => {
  // lateral threshold = 0.05 * 0.6 = 0.03. lDelta 0.04 > 0.03
  assert.equal(
    classifyPosture(pose({ lShoulderY: 0.54, rShoulderY: 0.5 }), BASELINE, 0.05),
    POSTURE.LEAN_LEFT
  );
});

test('classifyPosture: right shoulder lower → lean-right', () => {
  assert.equal(
    classifyPosture(pose({ lShoulderY: 0.5, rShoulderY: 0.54 }), BASELINE, 0.05),
    POSTURE.LEAN_RIGHT
  );
});

test('classifyPosture: lateral uses LATERAL_RATIO of threshold', () => {
  const threshold = 0.05;
  const lat = threshold * LATERAL_RATIO; // 0.03
  // just under → good
  const under = classifyPosture(pose({ lShoulderY: 0.5 + lat - 0.005, rShoulderY: 0.5 }), BASELINE, threshold);
  assert.equal(under, POSTURE.GOOD);
  // just over → lean-left
  const over = classifyPosture(pose({ lShoulderY: 0.5 + lat + 0.005, rShoulderY: 0.5 }), BASELINE, threshold);
  assert.equal(over, POSTURE.LEAN_LEFT);
});

test('classifyPosture: forward wins when both forward and lateral exceed', () => {
  // big nose drop AND big tilt → must return forward, not lean
  const p = pose({ noseY: 0.5, lShoulderY: 0.6, rShoulderY: 0.5 });
  assert.equal(classifyPosture(p, BASELINE, 0.05), POSTURE.FORWARD);
});

test('classifyPosture: low visibility short-circuits to good', () => {
  // nose dropped hard, but visibility below 0.5 → good (no false alert)
  const p = pose({ noseY: 0.6, vis: 0.3 });
  assert.equal(classifyPosture(p, BASELINE, 0.05), POSTURE.GOOD);
});

test('classifyPosture: partial low visibility (one keypoint) still gates', () => {
  const p = pose({ noseY: 0.6 });
  p.leftShoulder.visibility = 0.4;
  assert.equal(classifyPosture(p, BASELINE, 0.05), POSTURE.GOOD);
});

test('formatDuration: sub-minute shows seconds', () => {
  assert.equal(formatDuration(8000), '8s');
  assert.equal(formatDuration(59000), '59s');
});

test('formatDuration: minute boundary', () => {
  assert.equal(formatDuration(60000), '1m 0s');
  assert.equal(formatDuration(92000), '1m 32s');
});

test('formatDuration: zero and nullish are 0s', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(null), '0s');
  assert.equal(formatDuration(undefined), '0s');
});

test('formatDuration: rounds to nearest second', () => {
  assert.equal(formatDuration(8400), '8s');
  assert.equal(formatDuration(8600), '9s');
});
