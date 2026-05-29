import { PoseLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9';
import { POSTURE, OUTCOME, LATERAL_RATIO, computeDeltas, classifyPosture, formatDuration, deriveOutcome } from './posture.js';

const STORAGE = {
  baseline: 'pc.baseline',
  events: 'pc.events',
  threshold: 'pc.threshold',
};

const ALERT_PERSISTENCE_MS = 2000;
const CORRECTED_FAST_MS = 10_000;
const IGNORED_MS = 30_000;
const TICK_HZ = 5;
const DAYS_KEPT = 7;
const MAX_EVENTS = 1000;

// ── DOM refs ──────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const ctx = overlay.getContext('2d');
const calibrateBtn = $('calibrate');
const timestampEl = $('timestamp');
const statsGrid = $('stats-grid');
const logList = $('log-list');
const statusEl = $('status');
const thresholdEl = $('threshold');
const thresholdValEl = $('threshold-value');
const deltasEl = $('deltas');
const camFrame = $('cam-frame');

// ── Safe localStorage (handles disabled / corrupt / full) ──
function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    if (typeof fallback === 'number') {
      const v = parseFloat(raw);
      return Number.isFinite(v) ? v : fallback;
    }
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, typeof value === 'number' ? String(value) : JSON.stringify(value));
  } catch {
    // private mode / quota exceeded — drop silently.
  }
}

function isRecent(e) {
  return Date.now() - e.startedAt < DAYS_KEPT * 24 * 60 * 60 * 1000;
}

// ── App state: single source of mutation ─────────────
const state = {
  baseline: lsGet(STORAGE.baseline, null),
  threshold: lsGet(STORAGE.threshold, 0.03),
  events: lsGet(STORAGE.events, []).filter(isRecent),
  activeVariant: new URLSearchParams(location.search).get('alert') || 'beep',
  pendingState: null,
  activeEvent: null,
  pose: null,
  poseLandmarker: null,
  audioCtx: null,
  lastDetectTs: 0,
  lastRenderedDay: null,
};

function persistEvents() {
  // Trim to the 7-day window, then hard-cap so a pathological day can't
  // grow the localStorage key toward the quota. Display only shows ~50.
  state.events = state.events.filter(isRecent).slice(-MAX_EVENTS);
  lsSet(STORAGE.events, state.events);
}

function updateSliderFill() {
  const min = parseFloat(thresholdEl.min);
  const max = parseFloat(thresholdEl.max);
  const v = (parseFloat(thresholdEl.value) - min) / (max - min);
  thresholdEl.style.setProperty('--val', v);
}

thresholdEl.value = state.threshold;
thresholdValEl.textContent = state.threshold.toFixed(3);
updateSliderFill();

async function setupCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
  });
  video.srcObject = stream;
  await new Promise((r) => (video.onloadedmetadata = r));
  await video.play();
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
}

async function setupPose() {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/wasm'
  );
  state.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
}

function extractPose(landmarks) {
  if (!landmarks || !landmarks[0]) return null;
  const lm = landmarks[0];
  return {
    nose:          { x: lm[0].x,  y: lm[0].y,  visibility: lm[0].visibility },
    leftShoulder:  { x: lm[11].x, y: lm[11].y, visibility: lm[11].visibility },
    rightShoulder: { x: lm[12].x, y: lm[12].y, visibility: lm[12].visibility },
  };
}

function drawSkeleton(p, postureState) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!p) return;
  const w = overlay.width;
  const h = overlay.height;
  // canvas is not CSS-mirrored, so flip x to align with mirrored video display
  const X = (kp) => (1 - kp.x) * w;
  const Y = (kp) => kp.y * h;
  const color = postureState === POSTURE.GOOD ? '#20c060' : postureState ? '#ff2020' : '#909090';

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(X(p.leftShoulder),  Y(p.leftShoulder));
  ctx.lineTo(X(p.rightShoulder), Y(p.rightShoulder));
  ctx.stroke();

  for (const kp of [p.nose, p.leftShoulder, p.rightShoulder]) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(X(kp), Y(kp), 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function updateDeltas() {
  if (!state.pose || !state.baseline) {
    deltasEl.innerHTML = 'F:----- L:-----';
    return;
  }
  const { fDelta, lDelta } = computeDeltas(state.pose, state.baseline);
  const lat = state.threshold * LATERAL_RATIO;
  const fmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(3);
  const fClass = fDelta > state.threshold ? 'over' : '';
  const lClass = Math.abs(lDelta) > lat ? 'over' : '';
  deltasEl.innerHTML =
    `<span class="${fClass}">F:${fmt(fDelta)}</span> ` +
    `<span class="${lClass}">L:${fmt(lDelta)}</span>`;
}

// Close the current bad-posture episode: log exactly one event for the whole
// continuous slouch, no matter how many re-nags fired during it.
function closeEvent(now) {
  const e = state.activeEvent;
  const badMs = now - e.alertedAt;
  state.events.push({
    type: e.type,
    startedAt: e.startedAt,
    endedAt: now,
    duration: now - e.startedAt,
    nagCount: e.nagCount,
    outcome: deriveOutcome(badMs, { fastMs: CORRECTED_FAST_MS, ignoredMs: IGNORED_MS }),
  });
  persistEvents();
  renderStatsAndLog();
  speakConfirm();
  state.activeEvent = null;
}

function tick() {
  updateDeltas();
  if (!state.pose || !state.baseline) return;
  const postureState = classifyPosture(state.pose, state.baseline, state.threshold);
  const now = Date.now();

  if (postureState === POSTURE.GOOD) {
    if (state.activeEvent) closeEvent(now);
    state.pendingState = null;
    setStatus('good', 'OK');
    return;
  }

  // Bad posture, but not yet alerting: wait out the debounce window.
  if (!state.activeEvent) {
    if (!state.pendingState || state.pendingState.type !== postureState) {
      state.pendingState = { type: postureState, since: now };
      setStatus('pending', '...');
      return;
    }
    if (now - state.pendingState.since >= ALERT_PERSISTENCE_MS) {
      state.activeEvent = {
        type: postureState,            // type that opened the episode (for the log)
        startedAt: state.pendingState.since,
        alertedAt: now,
        lastNagAt: now,
        nagCount: 1,
      };
      dispatchAlert(state.activeVariant, postureState);
      setStatus('bad', postureState.toUpperCase());
    }
    return;
  }

  // Episode ongoing. Same continuous slouch = one event; re-nag every IGNORED_MS.
  // Voice matches the CURRENT posture even if it drifted (forward → lean).
  if (now - state.activeEvent.lastNagAt >= IGNORED_MS) {
    state.activeEvent.lastNagAt = now;
    state.activeEvent.nagCount += 1;
    dispatchAlert(state.activeVariant, postureState);
  }
  setStatus('bad', postureState.toUpperCase());
}

function setStatus(cls, text) {
  statusEl.className = `status ${cls}`;
  statusEl.textContent = text;
}

function dispatchAlert(variant, type) {
  if (variant === 'beep'  || variant === 'combo') beep();
  if (variant === 'voice' || variant === 'combo') speak(type);
  if (variant === 'flash' || variant === 'combo') flash();
}

// AudioContext starts suspended without a user gesture. A returning user with a
// saved baseline may never click anything, so their first alert beep would be
// silent. Prime + resume on the first interaction of any kind.
function primeAudio() {
  state.audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
}
['pointerdown', 'keydown'].forEach((evt) =>
  window.addEventListener(evt, primeAudio, { once: true })
);

function beep() {
  state.audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = state.audioCtx.createOscillator();
  const g = state.audioCtx.createGain();
  o.connect(g).connect(state.audioCtx.destination);
  o.frequency.value = 800;
  g.gain.setValueAtTime(0.0001, state.audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.3, state.audioCtx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, state.audioCtx.currentTime + 0.2);
  o.start();
  o.stop(state.audioCtx.currentTime + 0.22);
}

function say(msg) {
  const u = new SpeechSynthesisUtterance(msg);
  u.rate = 1.0;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function speak(type) {
  say(
    type === POSTURE.FORWARD    ? 'Sit up' :
    type === POSTURE.LEAN_LEFT  ? 'Lean right' :
    type === POSTURE.LEAN_RIGHT ? 'Lean left' :
    'Posture'
  );
}

// Positive confirmation when an episode closes — only for the voice modes,
// so "leave it running" feels like a coach acknowledging the fix.
function speakConfirm() {
  if (state.activeVariant === 'voice' || state.activeVariant === 'combo') {
    say('Good posture');
  }
}

function flash() {
  camFrame.classList.remove('alert');
  void camFrame.offsetWidth;
  camFrame.classList.add('alert');
}

calibrateBtn.addEventListener('click', () => {
  if (!state.pose) {
    setStatus('pending', 'NO POSE');
    return;
  }
  state.baseline = {
    noseY: state.pose.nose.y,
    shoulderTilt: state.pose.leftShoulder.y - state.pose.rightShoulder.y,
    capturedAt: Date.now(),
  };
  lsSet(STORAGE.baseline, state.baseline);
  beep();
  setStatus('good', 'CALIBRATED');
});

thresholdEl.addEventListener('input', () => {
  state.threshold = parseFloat(thresholdEl.value);
  thresholdValEl.textContent = state.threshold.toFixed(3);
  lsSet(STORAGE.threshold, state.threshold);
  updateSliderFill();
  updateDeltas();
});

function syncVariantButtons() {
  document.querySelectorAll('.variant-btn').forEach((b) => {
    const active = b.dataset.variant === state.activeVariant;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
}

document.querySelectorAll('.variant-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.activeVariant = btn.dataset.variant;
    const url = new URL(location.href);
    url.searchParams.set('alert', state.activeVariant);
    history.replaceState({}, '', url);
    syncVariantButtons();
  });
});

syncVariantButtons();

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function renderStatsAndLog() {
  const t0 = todayStart();
  // One time basis everywhere: an episode belongs to the day it STARTED.
  // (Log row, peak-hour grouping, and "today" set all key off startedAt.)
  const today = state.events.filter((e) => e.startedAt >= t0);
  const ignored = today.filter((e) => e.outcome === OUTCOME.IGNORED).length;
  const totalMs = today.reduce((s, e) => s + (e.duration || 0), 0);
  const avgMs = today.length ? totalMs / today.length : 0;

  const hours = {};
  today.forEach((e) => {
    const h = new Date(e.startedAt).getHours();
    hours[h] = (hours[h] || 0) + 1;
  });
  const peak = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];

  statsGrid.innerHTML = `
    <div class="label">Events</div>
    <div class="value">${today.length}${ignored ? ` (${ignored} ignored)` : ''}</div>
    <div class="label">Total bad posture</div>
    <div class="value">${formatDuration(totalMs)}</div>
    <div class="label">Avg duration</div>
    <div class="value">${formatDuration(avgMs)}</div>
    <div class="label">Peak hour</div>
    <div class="value">${peak ? `${String(peak[0]).padStart(2, '0')}:00 (${peak[1]})` : '—'}</div>
  `;

  state.lastRenderedDay = new Date(t0).getDate();

  logList.innerHTML = today
    .slice(-50)
    .reverse()
    .map((e) => {
      const label =
        e.outcome === OUTCOME.CORRECTED      ? '✓ corrected' :
        e.outcome === OUTCOME.CORRECTED_SLOW ? '~ slow' :
                                               '✗ ignored';
      const nags = e.nagCount > 1 ? ` ×${e.nagCount}` : '';
      return `
      <div class="log-entry">
        <span>${formatTime(e.startedAt)}</span>
        <span>${e.type}</span>
        <span>${formatDuration(e.duration)}</span>
        <span class="outcome ${e.outcome}">${label}${nags}</span>
      </div>`;
    }).join('');
}

function formatTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function updateTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  timestampEl.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  // Roll "Today" over at midnight even if no event fires to trigger a render.
  if (state.lastRenderedDay !== null && state.lastRenderedDay !== d.getDate()) {
    renderStatsAndLog();
  }
}

async function frame() {
  if (state.poseLandmarker && video.readyState >= 2) {
    const ts = performance.now();
    if (ts - state.lastDetectTs >= 1000 / TICK_HZ) {
      state.lastDetectTs = ts;
      try {
        // GPU delegate can throw on a single frame (context loss, VRAM hiccup).
        // Swallow it so the RAF loop survives — otherwise detection dies silently
        // and the UI keeps showing OK forever.
        const result = state.poseLandmarker.detectForVideo(video, ts);
        state.pose = extractPose(result.landmarks);
      } catch (err) {
        console.warn('pose detection frame failed, continuing', err);
      }
      const postureState = state.baseline && state.pose
        ? classifyPosture(state.pose, state.baseline, state.threshold)
        : null;
      drawSkeleton(state.pose, postureState);
    }
  }
  requestAnimationFrame(frame);
}

(async function init() {
  setStatus('pending', 'INIT');
  try {
    await setupCamera();
    await setupPose();
  } catch (err) {
    console.error(err);
    setStatus('bad', 'CAMERA FAIL');
    return;
  }
  frame();
  setInterval(tick, 1000 / TICK_HZ);
  setInterval(updateTimestamp, 1000);
  updateTimestamp();
  renderStatsAndLog();
  setStatus(state.baseline ? 'good' : 'pending', state.baseline ? 'OK' : 'CALIBRATE');
})();
