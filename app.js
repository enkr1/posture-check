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

let baseline = JSON.parse(localStorage.getItem(STORAGE.baseline) || 'null');
let threshold = parseFloat(localStorage.getItem(STORAGE.threshold) || '0.035');
let events = (JSON.parse(localStorage.getItem(STORAGE.events) || '[]')).filter(isRecent);
let activeVariant = new URLSearchParams(location.search).get('alert') || 'beep';
let pendingState = null;
let activeEvent = null;
let pose = null;
let poseLandmarker = null;

function updateSliderFill() {
  const min = parseFloat(thresholdEl.min);
  const max = parseFloat(thresholdEl.max);
  const v = (parseFloat(thresholdEl.value) - min) / (max - min);
  thresholdEl.style.setProperty('--val', v);
}

thresholdEl.value = threshold;
thresholdValEl.textContent = threshold.toFixed(3);
updateSliderFill();

function isRecent(e) {
  return Date.now() - e.startedAt < DAYS_KEPT * 24 * 60 * 60 * 1000;
}

function persistEvents() {
  events = events.filter(isRecent);
  localStorage.setItem(STORAGE.events, JSON.stringify(events));
}

/**
 * Per-frame posture classification.
 * Returns 'good' | 'forward' | 'lean-left' | 'lean-right'.
 * Temporal smoothing lives in tick(), not here — return an honest snapshot.
 */
function classifyPosture(pose, baseline, threshold) {
  // Low-visibility keypoints give wild coords; treat as good rather than fire false alerts.
  if (pose.nose.visibility < 0.5 ||
      pose.leftShoulder.visibility < 0.5 ||
      pose.rightShoulder.visibility < 0.5) {
    return 'good';
  }

  if (pose.nose.y - baseline.noseY > threshold) {
    return 'forward';
  }

  // Shoulders move less than the head from natural typing/glancing, so 0.6× threshold.
  const tiltDelta = (pose.leftShoulder.y - pose.rightShoulder.y) - baseline.shoulderTilt;
  const lateralThreshold = threshold * LATERAL_RATIO;

  // y grows downward, so leftShoulder dropping (y rises) means user leans to their own LEFT.
  if (tiltDelta >  lateralThreshold) return 'lean-left';
  if (tiltDelta < -lateralThreshold) return 'lean-right';

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
  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
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

function drawSkeleton(p, state) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!p) return;
  const w = overlay.width;
  const h = overlay.height;
  // canvas is not CSS-mirrored, so flip x to align with mirrored video display
  const X = (kp) => (1 - kp.x) * w;
  const Y = (kp) => kp.y * h;
  const color = state === 'good' ? '#20c060' : state ? '#ff2020' : '#909090';

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
  if (!pose || !baseline) {
    deltasEl.innerHTML = 'F:----- L:-----';
    return;
  }
  const fDelta = pose.nose.y - baseline.noseY;
  const lDelta = (pose.leftShoulder.y - pose.rightShoulder.y) - baseline.shoulderTilt;
  const lat = threshold * LATERAL_RATIO;
  const fmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(3);
  const fClass = fDelta > threshold ? 'over' : '';
  const lClass = Math.abs(lDelta) > lat ? 'over' : '';
  deltasEl.innerHTML =
    `<span class="${fClass}">F:${fmt(fDelta)}</span> ` +
    `<span class="${lClass}">L:${fmt(lDelta)}</span>`;
}

function tick() {
  updateDeltas();
  if (!pose || !baseline) return;
  const state = classifyPosture(pose, baseline, threshold);
  const now = Date.now();

  if (state === 'good') {
    if (activeEvent) {
      const duration = now - activeEvent.startedAt;
      const outcome = (now - activeEvent.alertedAt) < CORRECTED_FAST_MS
        ? 'corrected'
        : 'corrected-slow';
      events.push({ ...activeEvent, endedAt: now, duration, outcome });
      persistEvents();
      renderStatsAndLog();
      activeEvent = null;
    }
    pendingState = null;
    setStatus('good', 'OK');
    return;
  }

  if (!pendingState || pendingState.type !== state) {
    pendingState = { type: state, since: now };
    setStatus('pending', '...');
    return;
  }

  if (!activeEvent && now - pendingState.since >= ALERT_PERSISTENCE_MS) {
    activeEvent = {
      type: pendingState.type,
      startedAt: pendingState.since,
      alertedAt: now,
    };
    dispatchAlert(activeVariant, pendingState.type);
    setStatus('bad', pendingState.type.toUpperCase());
    return;
  }

  if (activeEvent && now - activeEvent.alertedAt > IGNORED_MS) {
    events.push({
      ...activeEvent,
      endedAt: now,
      duration: now - activeEvent.startedAt,
      outcome: 'ignored',
    });
    persistEvents();
    renderStatsAndLog();
    activeEvent = null;
    pendingState = { type: state, since: now };
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

let audioCtx = null;
function beep() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.connect(g).connect(audioCtx.destination);
  o.frequency.value = 800;
  g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.3, audioCtx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.2);
  o.start();
  o.stop(audioCtx.currentTime + 0.22);
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
  if (!pose) {
    setStatus('pending', 'NO POSE');
    return;
  }
  baseline = {
    noseY: pose.nose.y,
    shoulderTilt: pose.leftShoulder.y - pose.rightShoulder.y,
    capturedAt: Date.now(),
  };
  localStorage.setItem(STORAGE.baseline, JSON.stringify(baseline));
  beep();
  setStatus('good', 'CALIBRATED');
});

thresholdEl.addEventListener('input', () => {
  threshold = parseFloat(thresholdEl.value);
  thresholdValEl.textContent = threshold.toFixed(3);
  localStorage.setItem(STORAGE.threshold, String(threshold));
  updateSliderFill();
  updateDeltas();
});

document.querySelectorAll('.variant-btn').forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.variant === activeVariant);
  btn.addEventListener('click', () => {
    activeVariant = btn.dataset.variant;
    const url = new URL(location.href);
    url.searchParams.set('alert', activeVariant);
    history.replaceState({}, '', url);
    document.querySelectorAll('.variant-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.variant === activeVariant)
    );
  });
});

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function renderStatsAndLog() {
  const t0 = todayStart();
  const today = events.filter((e) => e.endedAt >= t0);
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

let lastDetectTs = 0;
async function frame() {
  if (poseLandmarker && video.readyState >= 2) {
    const ts = performance.now();
    if (ts - lastDetectTs >= 1000 / TICK_HZ) {
      lastDetectTs = ts;
      const result = poseLandmarker.detectForVideo(video, ts);
      pose = extractPose(result.landmarks);
      const state = baseline && pose ? classifyPosture(pose, baseline, threshold) : null;
      drawSkeleton(pose, state);
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
  setStatus(baseline ? 'good' : 'pending', baseline ? 'OK' : 'CALIBRATE');
})();
