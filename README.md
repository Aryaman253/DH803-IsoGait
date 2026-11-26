# IsoGait — Web Dashboard (DH803)

Browser version of the IsoGait gait-symmetry dashboard. It runs the same analysis as `IsoGaitv5.py` (GSI = ROM 25 % · Impact 25 % · Shape 20 % · Timing 15 % · DTW 15 %, verdict from the **weakest** metric against 90 % / 80 %) and reads the ESP32-S3 base-station hub **directly over USB** from the browser. No Python and no server are needed to run it.

> Research prototype and screening indicator, **not** a diagnostic device. The weights and the 90 % / 80 % thresholds are placeholders carried over from `IsoGaitv5.py` and have not been clinically validated.

## Screens

1. **Connect pods**: choose *Demo mode* (simulated pods) or *Hardware* (hub on USB). Shows live status, packet age, stream rate and dropped packets for the left and right pods, plus a 5 s stand-still calibration.
2. **Session setup**: participant, activity, speed, duration, condition (healthy baseline / induced asymmetry with shoe-lift size and side) and the pre-trial checklist.
3. **Live monitor**: live symmetry index (the newest 8 s window, rescored every second, as in the Python `LiveAnalyzer`), overlaid left/right foot pitch, symmetry trend with the 90 % line, cross-correlation lag, peak correlation, cadence, weakest metric and alerts (pod offline, symmetry below 90 %, marked events).
4. **Session report**: baseline vs induced mean symmetry and the drop, a per-metric breakdown, flagged segments, a video check (load your phone video and jump to each flagged segment), CSV export (raw hub data + per-window scores) and a PDF report (browser print → *Save as PDF*). Sessions are kept in this browser's local storage.

## Hardware path

```
ESP32-C6 pods (L, R) ──ESP-NOW──▶ ESP32-S3 hub ──USB serial 921 600 baud──▶ browser (Web Serial)
```

The app expects exactly the hub protocol from `IsoGaitv5.py`, one line per sample:

```
D,<node>,<seq>,<hub_ms>,<ax>,<ay>,<az>,<gx>,<gy>,<gz>,<pitch>,<roll>,<yaw>
node L | R (0 | 1 also accepted) · accel m/s² · gyro rad/s · angles degrees
```

Lines that don't start with `D,` are ignored, and malformed lines are counted, never fatal (same rules as the Python parser).

**Requirements:** Chrome or Edge on a laptop or desktop. Web Serial is not available in Safari, Firefox or on phones, but Demo mode works everywhere. Only one program can hold the serial port, so close the Python app and the Arduino Serial Monitor before pressing **Connect**.

## Run locally

Any static file server works, for example:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

(Opening `index.html` directly from disk will not work, because the app uses ES modules.)

## Deploy on Vercel

1. In Vercel, choose **Add New → Project** and import `Aryaman253/DH803-IsoGait`.
2. Framework preset: **Other**. Leave the build command empty and keep the output directory as the repo root.
3. Deploy. The site is fully static. Vercel serves it over HTTPS, which Web Serial requires.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `styles.css` | The four screens (layout and colours from the agreed UI mock-ups) |
| `js/engine.js` | Port of the analysis engine (session alignment, drift fit, gap marking, filters, stride estimate, cross-correlation lag, DTW, GSI, verdict, flagged segments) |
| `js/sim.js` | Port of the gait simulator (ROM / impact / timing asymmetry, packet loss, jitter, clock drift), emitting real hub lines |
| `js/recorder.js` | Hub-line parser, per-pod health monitor, live scorer and Web Serial reader |
| `js/app.js` | UI wiring, charts, report and exports |

The JS engine reproduces the Python selftest trend: GSI ≈ 99 % at severity 0, ≈ 93 % at 0.10, ≈ 85 % at 0.25 and ≈ 77 % at 0.40.

**Demo mapping of shoe lift to simulated severity:** 5 mm → 0.08, 10 mm → 0.15, 15 mm → 0.25, 20 mm → 0.35. This applies only to Demo mode. With real hardware, the score comes from the measured data.
