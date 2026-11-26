// IsoGait web app — UI wiring for the four screens.
import { CFG, KEYS, NAMES, METRIC_LABELS, PRIMARY, analyze, flaggedSegments, verdict } from "./engine.js";
import { Recorder, LiveAnalyzer, SerialSource, webSerialSupported, isMobile } from "./recorder.js";
import { SimSource, simParamsFromSetup } from "./sim.js";

const $ = (id) => document.getElementById(id);
const fmtTime = (s) => { s = Math.max(0, Math.round(s)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const pct = (v, d = 0) => (Number.isFinite(v) ? `${v.toFixed(d)}%` : "—");
const TEAL = "#0B6B6A", AMBER = "#9A4A06";

const S = {
  mode: null,          // "sim" | "serial"
  source: null,        // SimSource | SerialSource
  rec: null,           // Recorder for the current phase (preview or trial)
  recStart: 0,         // source time at which rec started
  live: null,
  trial: null,         // { setup, startedAt, durationS, running }
  cal: null,           // { L: offset, R: offset }
  calibrating: null,
  lastResult: null,
  wasBelow: false,
  analysis: null,
  segIdx: 0,
  history: loadHistory(),
};

// ------------------------------------------------------------------ helpers
function toast(msg, ms = 3000) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove("show"), ms);
}
function loadHistory() { try { return JSON.parse(localStorage.getItem("isogait.sessions") || "[]"); } catch { return []; } }
function saveHistory() { try { localStorage.setItem("isogait.sessions", JSON.stringify(S.history.slice(-50))); } catch { /* storage unavailable */ } }
function srcNow() { return S.source ? S.source.now() : 0; }
function newRecorder() {
  const src = S.source, start = src ? src.now() : 0;
  S.recStart = start;
  S.rec = new Recorder(() => (src ? src.now() : 0) - start);
  S.rec.listeners.push(onEvent);
}
function onLine(line) { if (S.rec) S.rec.handleLine(line); }
function connected() { return !!S.source; }
function bothOnline() { return S.rec && KEYS.every((k) => S.rec.st[k].online); }

// ------------------------------------------------------------------ routing
const VIEWS = ["connect", "setup", "live", "report"];
function show(view) {
  if (!VIEWS.includes(view)) view = "connect";
  VIEWS.forEach((v) => { $("view-" + v).hidden = v !== view; });
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("on", a.dataset.view === view));
  const nav = document.querySelector(".nav"), on = nav.querySelector("a.on");
  if (on && nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2, behavior: "smooth" });
  if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
  if (view === "live") requestAnimationFrame(drawCharts);
  if (view === "report") renderHistory();
}
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

// ------------------------------------------------------------------ 1. connect
async function connect() {
  const mode = document.querySelector("input[name=src]:checked").value;
  if (mode === "serial" && !webSerialSupported()) {
    $("sourceMsg").textContent = "This browser cannot open USB serial ports. Use Chrome or Edge on a laptop, or choose Demo mode.";
    return;
  }
  await disconnect(true);
  S.mode = mode;
  if (mode === "sim") {
    S.source = new SimSource({ ...simParamsFromSetup({ condition: "baseline", activity: "Walking", speed: 4, duration: 30 }) }, onLine);
    newRecorder(); S.source.start();
    $("sourceMsg").textContent = "Demo mode: two simulated foot pods streaming at 100 Hz through a simulated hub.";
  } else {
    const src = new SerialSource(onLine, (e) => { if (S.rec) S.rec.log("CRIT", "HUB_DISCONNECTED", `Serial link lost (${e.message}).`); });
    try {
      await src.request(921600);
    } catch (e) {
      $("sourceMsg").textContent = e.name === "NotFoundError" ? "No port selected." : `Could not open the port: ${e.message}`;
      return;
    }
    S.source = src; newRecorder(); src.start();
    $("sourceMsg").textContent = "Hub connected at 921 600 baud. Waiting for D,… lines from the left and right pods.";
  }
  $("disconnectBtn").hidden = false; updateConnectLabel();
  $("calBtn").disabled = false; $("rescanBtn").disabled = false;
  S.live = null;
}
async function disconnect(silent) {
  if (S.trial && S.trial.running) stopTrial(false);
  if (S.source) { await S.source.stop(); }
  S.source = null; S.rec = null; S.mode = null; S.calibrating = null;
  $("disconnectBtn").hidden = true; updateConnectLabel();
  $("calBtn").disabled = true; $("rescanBtn").disabled = true;
  if (!silent) $("sourceMsg").textContent = "Disconnected.";
}
function updateConnectLabel() {
  const want = document.querySelector("input[name=src]:checked").value;
  $("connectBtn").textContent = !S.source ? "Connect" : S.mode === want ? "Reconnect" : want === "serial" ? "Switch to hardware" : "Switch to demo";
}
function rescan() {
  if (!connected()) return;
  if (S.mode === "sim") { connect(); return; }
  newRecorder(); toast("Pod statistics reset. Listening again…");
}
function startCalibration() {
  if (!bothOnline()) { $("calMsg").textContent = "Both pods must be streaming before calibrating."; return; }
  S.calibrating = { t0: S.rec.now(), hub0: S.rec.newestHub() };
  $("calBtn").disabled = true; $("calMsg").textContent = "Hold still… 5 s";
}
function updateCalibration() {
  const c = S.calibrating; if (!c || !S.rec) return;
  const el = S.rec.now() - c.t0, frac = Math.min(1, el / 5);
  KEYS.forEach((k) => { const card = $("card-" + k); card.querySelector("[data-k=calBar]").style.width = `${frac * 100}%`; card.querySelector("[data-k=calText]").textContent = `Calibrating… ${Math.ceil(5 - el)} s`; });
  $("calMsg").textContent = `Hold still… ${Math.max(0, Math.ceil(5 - el))} s`;
  if (frac < 1) return;
  const off = {}; let ok = true;
  for (const k of KEYS) {
    const rows = S.rec.rows[k].filter((r) => r[1] >= c.hub0);
    if (rows.length < 100) { ok = false; break; }
    off[k] = rows.reduce((s, r) => s + r[8], 0) / rows.length;
  }
  S.calibrating = null; $("calBtn").disabled = false;
  if (!ok) { $("calMsg").textContent = "Calibration failed: not enough data from both pods. Try again."; return; }
  S.cal = off;
  $("calMsg").textContent = `Done. Resting pitch L ${off.L.toFixed(1)}°, R ${off.R.toFixed(1)}°.`;
  S.rec.log("INFO", "CALIBRATED", "Stand-still calibration completed.");
}
function renderPods() {
  for (const k of KEYS) {
    const card = $("card-" + k), q = (n) => card.querySelector(`[data-k=${n}]`);
    const chip = q("chip");
    if (!S.rec) {
      chip.textContent = "Waiting"; chip.className = "chip off";
      q("state").textContent = "Not connected"; q("age").textContent = "—"; q("rate").textContent = "—"; q("loss").textContent = "—";
      continue;
    }
    const s = S.rec.nodeStatus(k);
    if (s.count === 0) { chip.textContent = s.neverFlagged ? "No data" : "Waiting"; chip.className = s.neverFlagged ? "chip bad" : "chip off"; q("state").textContent = "No packets yet"; }
    else if (!s.online) { chip.textContent = "Offline"; chip.className = "chip bad"; q("state").textContent = `Offline for ${s.age.toFixed(1)} s`; }
    else { chip.textContent = "Connected"; chip.className = "chip"; q("state").textContent = `${s.count.toLocaleString()} samples`; }
    q("age").textContent = s.age === null ? "—" : s.age < 1 ? `${Math.round(s.age * 1000)} ms ago` : `${s.age.toFixed(1)} s ago`;
    q("rate").textContent = s.count ? `${Math.round(s.rate)} Hz` : "—";
    q("loss").textContent = s.count ? `${s.lossPct.toFixed(1)}%` : "—";
    if (!S.calibrating) {
      q("calBar").style.width = S.cal ? "100%" : "0%";
      q("calText").textContent = S.cal ? `Calibration: done (rest ${S.cal[k].toFixed(1)}°)` : "Calibration: not done";
    }
  }
  const online = S.rec ? KEYS.filter((k) => S.rec.st[k].online).length : 0;
  $("navStatus").innerHTML = !S.source ? "Base station: not connected"
    : `${S.mode === "sim" ? "Demo hub" : "Base station"}: connected<br>${online}/2 pods streaming`;
}

// ------------------------------------------------------------------ 2. setup
function readSetup() {
  return {
    pid: $("f-pid").value.trim() || "P-00", activity: $("f-act").value, speed: parseFloat($("f-speed").value) || 0,
    duration: parseFloat($("f-dur").value) || 2, condition: $("f-cond").value, liftMm: parseInt($("f-lift").value, 10),
    liftSide: $("f-side").value, notes: $("f-notes").value, video: $("f-video").checked,
  };
}
function setChip(id, ok, okText = "Done", noText = "To do", warn = false) {
  const el = $(id); el.textContent = ok ? okText : noText; el.className = ok ? "chip" : warn ? "chip w" : "chip off";
}
function renderChecklist() {
  const st = readSetup();
  setChip("st-consent", $("ck-consent").checked);
  setChip("st-pods", bothOnline(), "Done", S.source ? "Waiting" : "Not connected", !!S.source);
  setChip("st-cal", !!S.cal, "Done", "Recommended", true);
  setChip("st-video", !st.video || $("ck-video").checked, st.video ? "Ready" : "Not needed", "To do");
  document.querySelector(".lift").style.opacity = st.condition === "baseline" ? 0.45 : 1;
  $("f-lift").disabled = $("f-side").disabled = st.condition === "baseline";
}
function startTrial() {
  const st = readSetup();
  const missing = [];
  if (!$("ck-consent").checked) missing.push("consent");
  if (!S.source) missing.push("connect the pods (screen 1)");
  else if (!bothOnline()) missing.push("both pods streaming");
  if (st.video && !$("ck-video").checked) missing.push("video camera ready");
  if (missing.length) { $("startMsg").textContent = "Before starting: " + missing.join(", ") + "."; return; }
  $("startMsg").textContent = "";
  if (S.mode === "sim") {
    S.source.stop();
    S.source = new SimSource(simParamsFromSetup(st), onLine);
    newRecorder(); S.source.start();
  } else {
    newRecorder();
  }
  S.trial = { setup: st, durationS: st.duration * 60, running: true };
  S.lastResult = null; S.wasBelow = false;
  S.live = new LiveAnalyzer(S.rec, onLive); S.live.start();
  $("alertList").innerHTML = '<div class="mut">No alerts yet</div>';
  $("pauseBtn").textContent = "Pause";
  resetLiveCards();
  S.rec.log("INFO", "TRIAL_START", `Trial started: ${condText(st)}.`);
  show("live");
}
function condText(st) { return st.condition === "baseline" ? "Healthy baseline" : `Induced asymmetry, ${st.liftMm} mm ${st.liftSide.toLowerCase()} lift`; }

// ------------------------------------------------------------------ 3. live
function resetLiveCards() {
  $("siVal").textContent = "—"; $("siChip").textContent = "Collecting"; $("siChip").className = "chip off";
  $("siNote").textContent = `Threshold to flag: below ${CFG.thr_good}%`;
  ["tLag", "tCorr", "tCad", "tWeak"].forEach((id) => { $(id).textContent = "—"; });
}
function onLive(r) {
  S.lastResult = r;
  if (r.status === "OK") {
    const v = r.verdict;
    $("siVal").textContent = `${Math.round(r.gsi)}%`;
    $("siChip").textContent = v.title; $("siChip").className = v.level === "good" ? "chip" : v.level === "mild" ? "chip w" : "chip bad";
    $("siNote").textContent = `Threshold to flag: below ${CFG.thr_good}%`;
    const lagMs = (r.phase_lag - 0.5) * r.stride_samples * 10;
    $("tLag").textContent = `${lagMs >= 0 ? "+" : ""}${lagMs.toFixed(0)} ms`;
    $("tCorr").textContent = (r.m_shape / 100).toFixed(2);
    $("tCad").textContent = `${Math.round(r.cadence_spm)} spm`;
    $("tWeak").textContent = v.metric ? `${METRIC_LABELS[v.metric]} ${Math.round(v.worst)}%` : "—";
    const below = v.worst < CFG.thr_good;
    if (below && !S.wasBelow) S.rec.log("WARN", "SI_BELOW", `Symmetry below ${CFG.thr_good}% (${METRIC_LABELS[v.metric]} ${Math.round(v.worst)}%).`);
    if (!below && S.wasBelow) S.rec.log("INFO", "SI_RECOVERED", `Symmetry back above ${CFG.thr_good}%.`);
    S.wasBelow = below;
  } else if (r.status === "COLLECTING") {
    $("siChip").textContent = `Collecting ${Math.floor(r.have_s)}/${Math.ceil(r.need_s)} s`; $("siChip").className = "chip off";
  } else if (r.status === "SINGLE_LEG" || r.status === "NO_FOOT") {
    $("siChip").textContent = "Waiting for both pods"; $("siChip").className = "chip w";
  }
}
function onEvent(e) {
  if (!S.trial || !S.trial.running) return;
  if (["TRIAL_START"].includes(e.code)) return;
  const list = $("alertList");
  if (list.querySelector(".mut")) list.innerHTML = "";
  const cls = e.level === "CRIT" ? "chip bad" : e.level === "WARN" ? "chip w" : "chip";
  const tag = e.level === "CRIT" ? "Critical" : e.level === "WARN" ? "Flag" : e.code === "MARK" ? "Event" : "Info";
  const div = document.createElement("div"); div.className = "kv";
  div.innerHTML = `<span></span><span class="${cls}">${tag}</span>`;
  div.firstChild.textContent = `${fmtTime(e.t_s)} ${e.msg}`;
  list.prepend(div);
}
function markEvent() {
  if (!S.trial || !S.trial.running) return;
  const note = prompt("Event note (optional):", "Participant adjusted shoe");
  if (note === null) return;
  S.rec.log("INFO", "MARK", `Marked: ${note || "event"}`);
}
function togglePause() {
  if (!S.trial || !S.trial.running) return;
  const p = !S.rec.paused;
  S.rec.paused = p;
  if (S.mode === "sim") S.source.paused = p;
  $("pauseBtn").textContent = p ? "Resume" : "Pause";
  if (!p) S.rec.log("INFO", "RESUME", "Recording resumed.");
  else S.rec.log("INFO", "PAUSE", "Recording paused.");
}
function stopTrial(goReport = true) {
  if (!S.trial || !S.trial.running) return;
  S.trial.running = false;
  if (S.live) S.live.stop();
  S.rec.paused = false;
  S.rec.log("INFO", "TRIAL_STOP", "Trial stopped.");
  const trialRec = S.rec;
  S.trial.elapsed = trialRec.now();
  S.trial.rec = trialRec;
  S.trial.livePoints = S.live ? S.live.points : [];
  // keep pods visible on screen 1 after the trial
  if (S.mode === "sim" && S.source) {
    S.source.stop();
    S.source = new SimSource(simParamsFromSetup({ condition: "baseline", activity: "Walking", speed: 4, duration: 30 }), onLine);
    newRecorder(); S.source.start();
  } else if (S.source) newRecorder();
  buildReport(trialRec, S.trial);
  if (goReport) show("report");
}
function liveTick() {
  if (!S.trial || !S.trial.running) return;
  const st = S.trial.setup, el = S.rec.now();
  $("liveSub").textContent = `${st.pid} · ${st.activity} ${st.speed.toFixed(1)} km/h · ${condText(st)} · ${fmtTime(el)} / ${fmtTime(S.trial.durationS)}${S.rec.paused ? " · paused" : ""}`;
  if (el >= S.trial.durationS || (S.mode === "sim" && S.source.done())) stopTrial(true);
}

// ------------------------------------------------------------------ charts
function setupCanvas(cv) {
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  return [ctx, w, h];
}
function drawWave() {
  const cv = $("waveCanvas"); if (!cv.offsetParent) return;
  const [ctx, w, h] = setupCanvas(cv);
  const padL = 36, padB = 18, pw = w - padL - 6, ph = h - padB - 6;
  ctx.font = "11px Inter, sans-serif"; ctx.fillStyle = "#4A5E5C";
  if (!S.rec || !S.trial) { ctx.fillText("Start a trial to see live waveforms", padL, h / 2); return; }
  const r = S.lastResult, lagMs = r && r.status === "OK" ? r.lag_samples * 10 : 0;
  const d = S.rec.recentPitch(4, lagMs / 1000 + 0.15);
  const off = S.cal || { L: 0, R: 0 };
  const series = [
    { pts: d.L.filter((p) => p[0] >= d.start && p[0] <= d.end).map((p) => [p[0], p[1] - off.L]), color: TEAL, dash: [] },
    { pts: d.R.map((p) => [p[0] - lagMs, p[1] - off.R]).filter((p) => p[0] >= d.start && p[0] <= d.end), color: AMBER, dash: [8, 5] },
  ];
  let lo = Infinity, hi = -Infinity;
  series.forEach((s) => s.pts.forEach((p) => { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }));
  if (!Number.isFinite(lo)) { ctx.fillText("Waiting for data…", padL, h / 2); return; }
  const span = Math.max(10, hi - lo); lo -= span * 0.08; hi += span * 0.08;
  const X = (t) => padL + ((t - d.start) / (d.end - d.start)) * pw, Y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * ph;
  ctx.strokeStyle = "#E6EEEC"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = 6 + (i / 4) * ph; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
    ctx.fillText(`${(hi - (i / 4) * (hi - lo)).toFixed(0)}°`, 2, y + 4); }
  for (let s = 0; s <= 4; s++) ctx.fillText(`-${4 - s}s`, X(d.start + s * 1000) - (s === 4 ? 14 : 6), h - 4);
  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = 2.5; ctx.setLineDash(s.dash); ctx.beginPath();
    let prev = null;
    s.pts.forEach((p) => { const x = X(p[0]), y = Y(p[1]); if (prev && p[0] - prev > 150) ctx.moveTo(x, y); else if (prev === null) ctx.moveTo(x, y); else ctx.lineTo(x, y); prev = p[0]; });
    ctx.stroke(); ctx.setLineDash([]);
  }
}
function drawTrendOn(cv, pts, durS) {
  const [ctx, w, h] = setupCanvas(cv);
  const padL = 36, padB = 18, pw = w - padL - 8, ph = h - padB - 8;
  ctx.font = "11px Inter, sans-serif"; ctx.fillStyle = "#4A5E5C";
  const yLo = Math.min(60, ...pts.map((p) => Math.floor(p[1] / 10) * 10)), yHi = 100;
  const tMax = Math.max(durS || 0, ...pts.map((p) => p[0]), 30);
  const X = (t) => padL + (t / tMax) * pw, Y = (v) => 8 + (1 - (v - yLo) / (yHi - yLo)) * ph;
  ctx.strokeStyle = "#E6EEEC"; ctx.lineWidth = 1;
  for (let v = yLo; v <= yHi; v += 10) { ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(padL + pw, Y(v)); ctx.stroke(); ctx.fillText(`${v}%`, 2, Y(v) + 4); }
  const step = tMax > 600 ? 120 : tMax > 180 ? 60 : 30;
  for (let t = 0; t <= tMax; t += step) ctx.fillText(fmtTime(t), Math.min(X(t) - 10, w - 34), h - 4);
  const thr = CFG.thr_good;
  if (pts.length > 1) {                                // shade where the trend is below the threshold
    ctx.fillStyle = "rgba(253,233,211,0.9)";
    for (let i = 1; i < pts.length; i++) {
      const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
      if (v0 >= thr && v1 >= thr) continue;
      ctx.beginPath(); ctx.moveTo(X(t0), Y(thr)); ctx.lineTo(X(t0), Y(Math.min(v0, thr))); ctx.lineTo(X(t1), Y(Math.min(v1, thr))); ctx.lineTo(X(t1), Y(thr)); ctx.closePath(); ctx.fill();
    }
  }
  ctx.strokeStyle = "#8CA5A2"; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(padL, Y(thr)); ctx.lineTo(padL + pw, Y(thr)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#4A5E5C"; ctx.fillText(`${thr}% threshold`, padL + 6, Y(thr) - 5);
  if (!pts.length) { ctx.fillText("The symmetry index appears after ~9 s of walking", padL + 6, Y(75)); return; }
  ctx.strokeStyle = "#0E7C7B"; ctx.lineWidth = 3; ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
  ctx.stroke();
  const last = pts[pts.length - 1]; ctx.fillStyle = "#0E7C7B"; ctx.beginPath(); ctx.arc(X(last[0]), Y(last[1]), 4, 0, 7); ctx.fill();
}
function drawCharts() {
  if ($("view-live").hidden) return;
  drawWave();
  const pts = S.live ? S.live.points.map((p) => [p.t, p.gsi]) : [];
  drawTrendOn($("trendCanvas"), pts, S.trial ? S.trial.durationS : 120);
}

// ------------------------------------------------------------------ 4. report
function buildReport(rec, trial) {
  const an = analyze(rec.rows, CFG, rec.events.filter((e) => e.code === "MARK" || e.level === "CRIT"));
  const st = trial.setup, s = an.summary;
  S.analysis = { an, rec, trial, segs: flaggedSegments(an.windows, CFG) };
  S.segIdx = 0;
  const entry = { id: Date.now(), date: new Date().toISOString(), pid: st.pid, condition: st.condition, liftMm: st.liftMm, liftSide: st.liftSide,
    activity: st.activity, speed: st.speed, gsi: s.gsi, verdict: s.verdict.title, source: S.mode, durationS: trial.elapsed,
    metrics: Object.fromEntries(PRIMARY.map((m) => [m, s["m_" + m]])) };
  if (Number.isFinite(s.gsi)) { S.history.push(entry); saveHistory(); }
  S.analysis.entry = entry;
  renderReport();
}
function latest(cond, pid, excludeId) {
  const same = S.history.filter((h) => h.condition === cond && h.id !== excludeId && Number.isFinite(h.gsi));
  return same.filter((h) => h.pid === pid).pop() || same.pop() || null;
}
function renderReport() {
  const A = S.analysis; if (!A) return;
  const { an, trial, entry, segs } = A, st = trial.setup, s = an.summary;
  $("repSub").textContent = `${st.pid} · ${st.activity} ${st.speed.toFixed(1)} km/h · ${fmtTime(trial.elapsed ?? 0)} · ${condText(st)} · ${entry.source === "sim" ? "demo data" : "hardware"}`;
  const cur = Number.isFinite(s.gsi) ? entry : null;
  const base = st.condition === "baseline" ? cur : latest("baseline", st.pid, entry.id);
  const ind = st.condition === "induced" ? cur : latest("induced", st.pid, entry.id);
  $("rBase").textContent = base ? pct(base.gsi) : "—";
  $("rBaseNote").textContent = base ? `Healthy baseline run · ${base.pid} · ${new Date(base.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${base === cur ? " (this trial)" : ""}` : "No baseline run yet — record one to compare";
  $("rInd").textContent = ind ? pct(ind.gsi) : "—";
  $("rIndNote").textContent = ind ? `${ind.liftMm} mm lift, ${String(ind.liftSide).toLowerCase()}${ind === cur ? " (this trial)" : ""}` : "No induced-asymmetry run yet";
  $("rDrop").textContent = base && ind ? `${(base.gsi - ind.gsi).toFixed(0)} pts` : "—";
  $("rVerdict").textContent = `This trial: ${s.verdict.title}. ${s.verdict.sub}`;
  $("rMetrics").innerHTML = PRIMARY.map((m) => {
    const v = s["m_" + m];
    const col = !Number.isFinite(v) ? "#8CA5A2" : v >= CFG.thr_good ? "#0E7C7B" : v >= CFG.thr_mild ? "#C2620A" : "#B42318";
    return `<div class="metric"><div class="n">${METRIC_LABELS[m]} · weight ${Math.round(CFG.weights[m] * 100)}%</div><div class="v">${pct(v)}</div><div class="bar"><div style="width:${Number.isFinite(v) ? v : 0}%;background:${col}"></div></div></div>`;
  }).join("");
  const marks = A.rec.events.filter((e) => e.code === "MARK");
  $("segBody").innerHTML = segs.length ? "" : `<tr><td colspan="4" class="mut">${s.n_ok ? `No segment fell below ${CFG.thr_good}%` : "Not enough clean data to score (needs ≥ 11 s from both pods)"}</td></tr>`;
  segs.forEach((g) => {
    const mk = marks.filter((e) => e.t_s >= g.start - 2 && e.t_s <= g.end + 2).map((e) => e.msg.replace(/^Marked: /, ""));
    const tr = document.createElement("tr");
    [fmtTime(g.start), fmtTime(g.end - g.start), `${Math.round(g.lowest)}%`, `Lowest: ${METRIC_LABELS[g.metric]}${mk.length ? " · " + mk.join("; ") : ""}`].forEach((t) => { const td = document.createElement("td"); td.textContent = t; tr.appendChild(td); });
    $("segBody").appendChild(tr);
  });
  const fl = an.flags.filter((f) => f.code !== "SINGLE_LEG_STANDBY" || !s.n_ok);
  $("flagList").textContent = "";
  fl.slice(0, 6).forEach((f) => { const d = document.createElement("div"); d.textContent = `[${f.level}] ${f.msg}`; $("flagList").appendChild(d); });
  renderHistory();
}
function renderHistory() {
  const body = $("histBody"); body.innerHTML = "";
  if (!S.history.length) { body.innerHTML = '<tr><td colspan="6" class="mut">No saved sessions yet</td></tr>'; return; }
  S.history.slice().reverse().forEach((h) => {
    const tr = document.createElement("tr");
    const cells = [new Date(h.date).toLocaleString([], { dateStyle: "short", timeStyle: "short" }), h.pid,
      h.condition === "baseline" ? "Baseline" : `Induced ${h.liftMm} mm ${String(h.liftSide).toLowerCase()}`, pct(h.gsi, 1), `${h.verdict}${h.source === "sim" ? " (demo)" : ""}`];
    cells.forEach((t) => { const td = document.createElement("td"); td.textContent = t; tr.appendChild(td); });
    const td = document.createElement("td"); const b = document.createElement("button"); b.className = "linkbtn"; b.textContent = "Delete";
    b.onclick = () => { S.history = S.history.filter((x) => x.id !== h.id); saveHistory(); renderHistory(); if (S.analysis) renderReport(); };
    td.appendChild(b); tr.appendChild(td); body.appendChild(tr);
  });
}
function download(name, text, type = "text/csv") {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportCSV() {
  if (!S.analysis) { toast("Run a trial first."); return; }
  const st = S.analysis.trial.setup, stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "_");
  download(`IsoGait_${st.pid}_${st.condition}_${stamp}_raw.csv`, S.analysis.rec.toCSV());
  const cols = ["t_start", "t_end", "status", "gsi", ...PRIMARY.map((m) => "m_" + m), "cadence_spm", "phase_lag"];
  const lines = [cols.join(",")].concat(S.analysis.an.windows.map((w) => cols.map((c) => (typeof w[c] === "number" ? w[c].toFixed(3) : w[c] ?? "")).join(",")));
  setTimeout(() => download(`IsoGait_${st.pid}_${st.condition}_${stamp}_windows.csv`, lines.join("\n")), 400);
}
function jumpToSegment() {
  const v = $("vid");
  if (!v.src) { toast("Load the trial video first."); return; }
  const segs = S.analysis ? S.analysis.segs : [];
  if (!segs.length) { toast("No flagged segments in this trial."); return; }
  const g = segs[S.segIdx % segs.length]; S.segIdx++;
  v.currentTime = Math.max(0, (parseFloat($("vidOff").value) || 0) + g.start);
  v.play().catch(() => {});
  toast(`Segment at ${fmtTime(g.start)} (${S.segIdx % segs.length || segs.length} of ${segs.length})`);
}

// ------------------------------------------------------------------ wiring
function init() {
  if (!webSerialSupported()) {
    const hw = $("hwOption"); hw.classList.add("disabled"); hw.querySelector("input").disabled = true;
    hw.querySelector("span").innerHTML = isMobile()
      ? "<strong>Hardware</strong> — needs a laptop with Chrome / Edge (phones can't open the hub's USB port)"
      : "<strong>Hardware</strong> — needs Chrome or Edge (this browser can't open USB serial ports)";
  }
  document.querySelectorAll(".nav a").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); show(a.dataset.view); }));
  $("toSetup").onclick = () => show("setup");
  $("connectBtn").onclick = connect;
  $("disconnectBtn").onclick = () => disconnect(false);
  $("rescanBtn").onclick = rescan;
  $("calBtn").onclick = startCalibration;
  $("swapBtn").onclick = () => toast("Flash the spare with the failed side's firmware (L or R), power it on, then press Re-scan pods.", 5000);
  document.querySelectorAll("input[name=src]").forEach((r) => r.addEventListener("change", () => {
    updateConnectLabel();
    $("sourceMsg").textContent = r.value === "serial" && r.checked
      ? (webSerialSupported() ? "Plug the ESP32-S3 hub into this laptop, press Connect and pick its port (CP210x / CH340 / USB JTAG)." : "USB serial needs Chrome or Edge on a laptop. Demo mode works in any browser.")
      : "Demo mode streams the same hub lines your firmware sends.";
  }));
  ["setupForm", "ck-consent", "ck-video"].forEach((id) => $(id).addEventListener("input", renderChecklist));
  $("startBtn").onclick = startTrial;
  $("saveProtoBtn").onclick = () => { try { localStorage.setItem("isogait.protocol", JSON.stringify(readSetup())); } catch { /* ignore */ } toast("Protocol saved in this browser."); };
  try { const p = JSON.parse(localStorage.getItem("isogait.protocol") || "null");
    if (p) { $("f-pid").value = p.pid; $("f-act").value = p.activity; $("f-speed").value = p.speed; $("f-dur").value = p.duration; $("f-cond").value = p.condition; $("f-lift").value = p.liftMm; $("f-side").value = p.liftSide; $("f-notes").value = p.notes || ""; $("f-video").checked = !!p.video; } } catch { /* ignore */ }
  $("markBtn").onclick = markEvent;
  $("pauseBtn").onclick = togglePause;
  $("stopBtn").onclick = () => stopTrial(true);
  $("csvBtn").onclick = exportCSV;
  $("pdfBtn").onclick = () => { if (!S.analysis) { toast("Run a trial first."); return; } window.print(); };
  $("vidFile").onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const v = $("vid"); v.src = URL.createObjectURL(f); v.hidden = false; $("vidPh").hidden = true;
  };
  $("jumpBtn").onclick = jumpToSegment;

  setInterval(() => { if (S.rec) S.rec.tick(); updateCalibration(); renderPods(); renderChecklist(); liveTick(); }, 200);
  const loop = () => { drawCharts(); setTimeout(() => requestAnimationFrame(loop), 66); };
  loop();
  window.addEventListener("resize", drawCharts);
  show(location.hash.slice(1) || "connect");
}
init();
