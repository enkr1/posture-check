import { PoseLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9';

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
const LATERAL_RATIO = 0.6;

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
  threshold: lsGet(STORAGE.threshold, 0.035),
  events: lsGet(STORAGE.events, []).filter(isRecent),
  activeVariant: new URLSearchParams(location.search).get('alert') || 'beep',
  pendingState: null,
  activeEvent: null,
  pose: null,
  poseLandmarker: null,
  audioCtx: null,
  lastDetectTs: 0,
};

function persistEvents() {
  state.events = state.events.filter(isRecent);
  lsSet(STORAGE.events, state.events);
}

// ── Shared geometry: both classify and live readout use this ──
function computeDeltas(pose, baseline) {
  return {
    fDelta: pose.nose.y - baseline.noseY,
    lDelta: (pose.leftShoulder.y - pose.rightShoulder.y) - baseline.shoulderTilt,
  };
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

/**
 * Per-frame posture classification.
 * Returns 'good' | 'forward' | 'lean-left' | 'lean-right'.
 * Temporal smoothing lives in tick(), not here — return an honest snapshot.
 */
function classifyPosture(pose, baseline, threshold) {
  if (pose.nose.visibility < 0.5 ||
      pose.leftShoulder.visibility < 0.5 ||
      pose.rightShoulder.visibility < 0.5) {
    return 'good';
  }

  const { fDelta, lDelta } = computeDeltas(pose, baseline);

  if (fDelta > threshold) return 'forward';

  const lat = threshold * LATERAL_RATIO;
  // y grows downward, so leftShoulder dropping (y rises) means user leans to their own LEFT.
  if (lDelta >  lat) return 'lean-left';
  if (lDelta < -lat) return 'lean-right';

  return 'good';
}

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
  const color = postureState === 'good' ? '#20c060' : postureState ? '#ff2020' : '#909090';

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

function tick() {
  updateDeltas();
  if (!state.pose || !state.baseline) return;
  const postureState = classifyPosture(state.pose, state.baseline, state.threshold);
  const now = Date.now();

  if (postureState === 'good') {
    if (state.activeEvent) {
      const duration = now - state.activeEvent.startedAt;
      const outcome = (now - state.activeEvent.alertedAt) < CORRECTED_FAST_MS
        ? 'corrected'
        : 'corrected-slow';
      state.events.push({ ...state.activeEvent, endedAt: now, duration, outcome });
      persistEvents();
      renderStatsAndLog();
      state.activeEvent = null;
    }
    state.pendingState = null;
    setStatus('good', 'OK');
    return;
  }

  if (!state.pendingState || state.pendingState.type !== postureState) {
    state.pendingState = { type: postureState, since: now };
    setStatus('pending', '...');
    return;
  }

  if (!state.activeEvent && now - state.pendingState.since >= ALERT_PERSISTENCE_MS) {
    state.activeEvent = {
      type: state.pendingState.type,
      startedAt: state.pendingState.since,
      alertedAt: now,
    };
    dispatchAlert(state.activeVariant, state.pendingState.type);
    setStatus('bad', state.pendingState.type.toUpperCase());
    return;
  }

  if (state.activeEvent && now - state.activeEvent.alertedAt > IGNORED_MS) {
    state.events.push({
      ...state.activeEvent,
      endedAt: now,
      duration: now - state.activeEvent.startedAt,
      outcome: 'ignored',
    });
    persistEvents();
    renderStatsAndLog();
    state.activeEvent = null;
    state.pendingState = { type: postureState, since: now };
  }
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

function speak(type) {
  const msg =
    type === 'forward'    ? 'Sit up' :
    type === 'lean-left'  ? 'Lean right' :
    type === 'lean-right' ? 'Lean left' :
    'Posture';
  const u = new SpeechSynthesisUtterance(msg);
  u.rate = 1.0;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
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
  const today = state.events.filter((e) => e.endedAt >= t0);
  const ignored = today.filter((e) => e.outcome === 'ignored').length;
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

  logList.innerHTML = today
    .slice(-50)
    .reverse()
    .map((e) => `
      <div class="log-entry">
        <span>${formatTime(e.startedAt)}</span>
        <span>${e.type}</span>
        <span>${formatDuration(e.duration)}</span>
        <span class="outcome ${e.outcome}">${
          e.outcome === 'corrected'      ? '✓ corrected' :
          e.outcome === 'corrected-slow' ? '~ slow' :
                                           '✗ ignored'
        }</span>
      </div>`).join('');
}

function formatTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function updateTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  timestampEl.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function frame() {
  if (state.poseLandmarker && video.readyState >= 2) {
    const ts = performance.now();
    if (ts - state.lastDetectTs >= 1000 / TICK_HZ) {
      state.lastDetectTs = ts;
      const result = state.poseLandmarker.detectForVideo(video, ts);
      state.pose = extractPose(result.landmarks);
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
