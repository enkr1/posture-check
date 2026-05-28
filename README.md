# posture-check

A browser app that watches you via webcam and pings you when you slouch or lean. Pure frontend, no backend, no data leaves your device.

> **v1 prototype** — exploring four alert mechanisms (beep / voice / flash / combo) and surveillance-style UI. Logic and UX are still in flux.

## Run

```bash
cd _ideas/posture-check
python3 -m http.server 8000
# open http://localhost:8000
```

`getUserMedia` requires a secure context, so `file://` will not work. Use any local server.

## How it works

1. Click **CALIBRATE** while sitting upright. Baseline (nose Y + shoulder tilt) is stored in `localStorage`.
2. Browser-side MediaPipe Pose runs at 5 fps and watches you.
3. When you slouch forward or lean for 3+ seconds, the active alert fires.
4. The log records every event with type, duration, and outcome (`corrected` / `corrected-slow` / `ignored`).

## v1 scope

- Forward slouch detection (nose Y delta vs baseline)
- Lateral lean detection (left / right, via shoulder slope)
- 4 alert variants — switch via UI or `?alert=beep|voice|flash|combo`
- Stats panel: events, total bad-posture time, avg duration, peak hour
- Scrollable log of recent events
- 7-day persistence in `localStorage`
- Surveillance-style frame (REC dot, timestamp, scanlines, alert flash)

## v2 backlog

- Distraction detection (head turning away from screen) — separate alert semantics, not bundled with posture
- Gaze heatmap (where on screen you look) — its own sibling project
- Mobile `navigator.vibrate()` variant
- Toggle skeleton overlay

## File map

```
index.html   markup + variant bar + stats + log
style.css    surveillance vibe (REC dot, scanlines, alert flash)
app.js       MediaPipe + state machine + alert dispatcher
             ↑ contains TODO(human) for classifyPosture()
```

## Privacy

Camera frames never leave your machine. MediaPipe runs in-browser via WASM/WebGL. Baseline + event log live only in your browser's `localStorage` (cleared if you clear site data).
