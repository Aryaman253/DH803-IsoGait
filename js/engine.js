// IsoGait analysis engine — JavaScript port of SECTION 2 of IsoGaitv5.py.
// Sliding-window continuous-waveform symmetry metrics for the bilateral (L/R) setup.
// Metrics are 0–100 % (100 = symmetric): rom, impact, shape, timing, dtw.
// Verdict = WEAKEST primary metric vs 90 / 80 % (placeholder thresholds, not clinically validated).

export const KEYS = ["L", "R"];
export const NAMES = { L: "Left foot", R: "Right foot" };
export const SIGNALS = ["ax", "ay", "az", "gx", "gy", "gz", "pitch", "roll", "yaw"];
const ANGLES = new Set(["pitch", "roll", "yaw"]);

export const CFG = {
  fs: 100.0,
  pitch_cutoff_hz: 8.0,
  acc_cutoff_hz: 20.0,
  window_s: 8.0,
  hop_s: 2.0,
  warmup_s: 3.0,
  min_coverage: 0.9,
  max_gap_s: 0.15,
  stride_band_hz: [0.5, 2.0],
  dtw_seconds: 3.0, dtw_radius: 15, dtw_fullscale: 0.25,
  loss_warn_pct: 5.0,
  weights: { shape: 0.2, rom: 0.25, impact: 0.25, timing: 0.15, dtw: 0.15 },
  thr_good: 90.0, thr_mild: 80.0,
};
export const PRIMARY = ["rom", "impact", "timing", "dtw", "shape"];
export const METRIC_LABELS = { rom: "Range of motion", impact: "Impact", shape: "Shape", timing: "Timing", dtw: "DTW" };

// ---------------------------------------------------------------- small numeric helpers
const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; };
export function median(a) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}
export function percentile(a, p) {            // numpy 'linear' method
  const s = Float64Array.from(a).sort();
  if (!s.length) return NaN;
  const pos = (p / 100) * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
function interp(x, xp, fp) {                   // numpy.interp for sorted x and xp
  const out = new Float64Array(x.length);
  let j = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (xi <= xp[0]) { out[i] = fp[0]; continue; }
    if (xi >= xp[xp.length - 1]) { out[i] = fp[fp.length - 1]; continue; }
    while (j < xp.length - 2 && xp[j + 1] < xi) j++;
    while (j > 0 && xp[j] > xi) j--;
    const t = (xi - xp[j]) / (xp[j + 1] - xp[j] || 1);
    out[i] = fp[j] + t * (fp[j + 1] - fp[j]);
  }
  return out;
}
function unwrapDeg(y) {
  const out = new Float64Array(y.length);
  if (!y.length) return out;
  out[0] = y[0];
  let off = 0;
  for (let i = 1; i < y.length; i++) {
    const d = y[i] - y[i - 1];
    if (d > 180) off -= 360; else if (d < -180) off += 360;
    out[i] = y[i] + off;
  }
  return out;
}
function polyfit1(x, y) {
  const n = x.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return [slope, (sy - slope * sx) / n];
}

// ---------------------------------------------------------------- DSP
// 4th-order Butterworth low-pass as two biquads (bilinear transform), applied forward-backward (zero phase).
function biquadLP(fc, fs, Q) {
  const w0 = 2 * Math.PI * fc / fs, c = Math.cos(w0), al = Math.sin(w0) / (2 * Q);
  const a0 = 1 + al;
  return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 };
}
function runBiquad(x, f) {
  const y = new Float64Array(x.length);
  // start in steady state for the first sample (like scipy's lfilter_zi)
  let x1 = x[0], x2 = x[0], y1 = x[0], y2 = x[0];
  for (let i = 0; i < x.length; i++) {
    const v = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
export function lowpass(x, cutoff, fs) {
  const pad = 15;
  if (x.length <= 3 * 5) return Float64Array.from(x);
  const fc = Math.min(cutoff, 0.45 * fs);
  const secs = [biquadLP(fc, fs, 0.5411961), biquadLP(fc, fs, 1.3065630)];
  const n = x.length, ext = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) {                      // odd extension at both ends (scipy filtfilt default)
    ext[i] = 2 * x[0] - x[pad - i];
    ext[n + pad + i] = 2 * x[n - 1] - x[n - 2 - i];
  }
  ext.set(x, pad);
  let y = ext;
  for (const s of secs) y = runBiquad(y, s);
  y.reverse();
  for (const s of secs) y = runBiquad(y, s);
  y.reverse();
  return y.slice(pad, pad + n);
}
function fillInvalid(x, valid) {
  let all = true, nv = 0;
  for (let i = 0; i < valid.length; i++) { if (!valid[i]) all = false; else nv++; }
  if (all) return x;
  if (nv < 2) return new Float64Array(x.length);
  const xi = [], fi = [];
  for (let i = 0; i < x.length; i++) if (valid[i]) { xi.push(i); fi.push(x[i]); }
  const idx = new Float64Array(x.length); for (let i = 0; i < x.length; i++) idx[i] = i;
  return interp(idx, xi, fi);
}
function bandedDTW(a, b, radius) {
  const n = a.length, W = n + 1;
  const D = new Float64Array(W * W).fill(Infinity);
  D[0] = 0;
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(1, i - radius), hi = Math.min(n, i + radius);
    for (let j = lo; j <= hi; j++) {
      D[i * W + j] = Math.abs(a[i - 1] - b[j - 1]) + Math.min(D[(i - 1) * W + j], D[i * W + j - 1], D[(i - 1) * W + j - 1]);
    }
  }
  return D[n * W + n] / n;
}
function parabolic(y, i) {
  if (i > 0 && i < y.length - 1) {
    const d = y[i - 1] - 2 * y[i] + y[i + 1];
    if (d !== 0) return i + 0.5 * (y[i - 1] - y[i + 1]) / d;
  }
  return i;
}
function estimateStrideHz(pl, pr, fs, band) {
  const n = pl.length;
  const nfft = Math.pow(2, Math.ceil(Math.log2(n * 8)));
  const ml = mean(pl), mr = mean(pr);
  const wl = new Float64Array(n), wr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = n > 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) : 1;
    wl[i] = (pl[i] - ml) * w; wr[i] = (pr[i] - mr) * w;
  }
  const kmin = Math.ceil(band[0] * nfft / fs), kmax = Math.floor(band[1] * nfft / fs);
  if (kmax < kmin) return NaN;
  const P = new Map();
  const power = (k) => {
    if (P.has(k)) return P.get(k);
    let rl = 0, il = 0, rr = 0, ir = 0;
    const w = -2 * Math.PI * k / nfft;
    for (let t = 0; t < n; t++) {
      const c = Math.cos(w * t), s = Math.sin(w * t);
      rl += wl[t] * c; il += wl[t] * s; rr += wr[t] * c; ir += wr[t] * s;
    }
    const v = rl * rl + il * il + rr * rr + ir * ir;
    P.set(k, v); return v;
  };
  let best = kmin, bv = -1;
  for (let k = kmin; k <= kmax; k++) { const v = power(k); if (v > bv) { bv = v; best = k; } }
  const y = [power(best - 1), power(best), power(best + 1)];
  return (best + parabolic(y, 1) - 1) * fs / nfft;
}
function contralateralLag(pl, pr, T) {
  const n = pl.length, ml = mean(pl), mr = mean(pr);
  const hi = Math.min(Math.ceil(T) + 1, n - 1);
  const c = new Float64Array(Math.min(hi + 2, n));
  for (let k = 0; k < c.length; k++) {
    let s = 0;
    for (let t = 0; t + k < n; t++) s += (pr[t + k] - mr) * (pl[t] - ml);
    c[k] = s / (n - k);
  }
  let k = 0;
  for (let i = 1; i <= hi; i++) if (c[i] > c[k]) k = i;
  return parabolic(c, k);
}
function ratioPct(a, b) {
  const m = Math.max(Math.abs(a), Math.abs(b));
  return m === 0 ? NaN : 100 * Math.min(Math.abs(a), Math.abs(b)) / m;
}
function corrcoef(a, b) {
  const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / Math.sqrt(saa * sbb);
}

// ---------------------------------------------------------------- session building
// frames: { L: rows[], R: rows[] }, each row = [seq, hub_ms, ax, ay, az, gx, gy, gz, pitch, roll, yaw]
function nodeTime(rows, fs, info) {
  let seq = rows.map((r) => r[0]);
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] - seq[i - 1] < -1000) {
      info.notes.push("node reset detected (seq went backwards): using raw hub time");
      const s = rows.slice().sort((a, b) => a[1] - b[1]);
      return [s, s.map((r) => r[1] / 1000)];
    }
  }
  const seen = new Set();
  let df = rows.filter((r) => (seen.has(r[0]) ? false : (seen.add(r[0]), true)));
  df.sort((a, b) => a[0] - b[0]);
  const sq = df.map((r) => r[0]), hub = df.map((r) => r[1] / 1000);
  if (sq.length >= 20) {
    let [slope, icpt] = polyfit1(sq, hub);
    for (let it = 0; it < 2; it++) {
      const r = hub.map((h, i) => h - (slope * sq[i] + icpt));
      const med = median(r);
      const mad = 1.4826 * median(r.map((v) => Math.abs(v - med))) + 1e-4;
      const kx = [], ky = [];
      for (let i = 0; i < r.length; i++) if (Math.abs(r[i] - med) < 4 * mad + 0.002) { kx.push(sq[i]); ky.push(hub[i]); }
      if (kx.length < 20) break;
      [slope, icpt] = polyfit1(kx, ky);
    }
    if (Math.abs(slope * fs - 1) < 0.05) {
      info.rate_hz = 1 / slope;
      return [df, sq.map((s) => slope * s + icpt)];
    }
    info.notes.push(`seq/hub slope implies ${(1 / slope).toFixed(1)} Hz: using raw hub time`);
  }
  return [df, hub];
}

export function buildSession(frames, cfgIn) {
  const cfg = { ...CFG, ...(cfgIn || {}) };
  const fs = cfg.fs, maxGap = cfg.max_gap_s;
  const raw = {}, info = {};
  for (const k of KEYS) info[k] = { key: k, present: false, n_samples: 0, loss_pct: 0, rate_hz: 0, coverage: 0, notes: [] };
  for (const k of KEYS) {
    const rows = (frames[k] || []).filter((r) => r.every((v) => Number.isFinite(v)));
    if (rows.length < 20) continue;
    const [df, t] = nodeTime(rows, fs, info[k]);
    info[k].present = true; info[k].n_samples = df.length;
    let smin = Infinity, smax = -Infinity;
    for (const r of df) { if (r[0] < smin) smin = r[0]; if (r[0] > smax) smax = r[0]; }
    info[k].loss_pct = Math.max(0, 100 * (1 - df.length / (smax - smin + 1)));
    if (!info[k].rate_hz) info[k].rate_hz = t.length / Math.max(t[t.length - 1] - t[0], 1e-6);
    raw[k] = [df, t];
  }
  const flags = [];
  const present = KEYS.filter((k) => raw[k]);
  const missing = KEYS.filter((k) => !raw[k]);
  const empty = { fs, t: new Float64Array(0), data: {}, valid: {}, info, flags };
  if (!present.length) {
    flags.push({ level: "CRIT", code: "NO_DATA", msg: "No foot sensor data available." });
    return empty;
  }
  if (missing.length) {
    flags.push({ level: "WARN", code: "SINGLE_LEG_STANDBY",
      msg: `Single-leg mode: ${present.map((k) => NAMES[k]).join(", ")} streaming. Missing pod (${missing.map((k) => NAMES[k]).join(", ")}). Bilateral symmetry cannot be scored.` });
  }
  const t0 = Math.max(...present.map((k) => raw[k][1][0]));
  const t1 = Math.min(...present.map((k) => raw[k][1][raw[k][1].length - 1]));
  if (t1 <= t0) {
    flags.push({ level: "CRIT", code: "INVALID_SPAN", msg: "Invalid or zero-duration time span." });
    return empty;
  }
  const N = Math.floor((t1 - t0) * fs);
  const grid = new Float64Array(N);
  for (let i = 0; i < N; i++) grid[i] = t0 + i / fs;
  const data = {}, valid = {};
  for (const k of KEYS) {
    if (raw[k]) {
      const [df, t] = raw[k];
      const ok = new Uint8Array(N);
      let j = 0;
      for (let i = 0; i < N; i++) {
        while (j < t.length && t[j] < grid[i]) j++;            // searchsorted (left)
        const idx = Math.min(Math.max(j, 1), t.length - 1);
        const gap = t[idx] - t[idx - 1];
        ok[i] = gap <= maxGap && grid[i] >= t[0] && grid[i] <= t[t.length - 1] ? 1 : 0;
      }
      valid[k] = ok;
      data[k] = {};
      SIGNALS.forEach((s, si) => {
        let y = df.map((r) => r[2 + si]);
        if (ANGLES.has(s)) y = unwrapDeg(y);
        data[k][s] = interp(grid, t, y);
      });
      info[k].coverage = mean(ok);
    } else {
      valid[k] = new Uint8Array(N);
      data[k] = {};
      for (const s of SIGNALS) data[k][s] = new Float64Array(N).fill(s === "az" ? -9.81 : 0);
    }
  }
  const tt = new Float64Array(N);
  for (let i = 0; i < N; i++) tt[i] = grid[i] - grid[0];
  return { fs, t: tt, t0abs: t0, data, valid, info, flags };
}

function prepareSignals(sess, cfg) {
  const sig = {};
  for (const k of Object.keys(sess.data)) {
    const v = sess.valid[k], d = {};
    for (const s of SIGNALS) d[s] = fillInvalid(sess.data[k][s], v);
    d.pitch_f = lowpass(d.pitch, cfg.pitch_cutoff_hz, sess.fs);
    const norm = new Float64Array(d.ax.length);
    for (let i = 0; i < norm.length; i++) norm[i] = Math.hypot(d.ax[i], d.ay[i], d.az[i]);
    d.acc_norm = lowpass(norm, cfg.acc_cutoff_hz, sess.fs);
    const m = median(d.acc_norm);
    d.acc_dyn = d.acc_norm.map((x) => x - m);
    sig[k] = d;
  }
  return sig;
}

function combine(m, weights) {
  let num = 0, den = 0, used = 0;
  for (const [name, w] of Object.entries(weights)) {
    const v = m[name];
    if (v !== undefined && Number.isFinite(v)) { num += w * v; den += w; used++; }
  }
  return [den ? num / den : NaN, used];
}

export function limitingMetric(summary) {
  let name = null, worst = NaN;
  for (const n of PRIMARY) {
    const v = summary["m_" + n];
    if (v !== undefined && Number.isFinite(v) && (name === null || v < worst)) { name = n; worst = v; }
  }
  return [name, worst];
}

export function verdict(summary, cfgIn) {
  const cfg = { ...CFG, ...(cfgIn || {}) };
  const [name, worst] = limitingMetric(summary);
  if (name === null) return { title: "No result", level: "none", sub: "Not enough valid data to score yet." };
  const tag = `Weakest metric: ${METRIC_LABELS[name]} ${worst.toFixed(0)}%.`;
  if (worst >= cfg.thr_good) return { title: "Within target symmetry", level: "good", sub: `All primary metrics above target. ${tag}`, metric: name, worst };
  if (worst >= cfg.thr_mild) return { title: "Mild asymmetry", level: "mild", sub: `Small compensatory bias. ${tag} Re-test / monitor.`, metric: name, worst };
  return { title: "Marked asymmetry", level: "marked", sub: `Large left–right difference. ${tag} Review with a clinician.`, metric: name, worst };
}

function scoreWindow(sess, sig, a, W, cfg) {
  const fs = sess.fs;
  const sl = (x) => x.subarray ? x.subarray(a, a + W) : x.slice(a, a + W);
  const cov = {};
  for (const k of KEYS) cov[k] = mean(sl(sess.valid[k]));
  const row = { t_start: sess.t[a], t_end: sess.t[a + W - 1], cov_L: cov.L, cov_R: cov.R };
  if (cov.L < cfg.min_coverage || cov.R < cfg.min_coverage) { row.status = "SKIPPED_LEG_DATA"; return row; }
  const pl = sl(sig.L.pitch_f), pr = sl(sig.R.pitch_f);
  const fStr = estimateStrideHz(pl, pr, fs, cfg.stride_band_hz);
  if (!Number.isFinite(fStr)) { row.status = "SKIPPED_NO_STRIDE"; return row; }
  const T = fs / fStr;
  const lag = contralateralLag(pl, pr, T);
  const k = Math.round(lag);
  const phi = (((lag / T) % 1) + 1) % 1;
  const la = pl.slice(0, pl.length - k), ra = pr.slice(k);
  const romL = percentile(pl, 97.5) - percentile(pl, 2.5);
  const romR = percentile(pr, 97.5) - percentile(pr, 2.5);
  const rms = (x) => { const m = median(x); let s = 0; for (const v of x) s += (v - m) ** 2; return Math.sqrt(s / x.length); };
  const rmsL = rms(sl(sig.L.acc_dyn)), rmsR = rms(sl(sig.R.acc_dyn));
  const m = {};
  m.shape = Math.max(0, corrcoef(la, ra)) * 100;
  m.rom = ratioPct(romL, romR);
  m.impact = ratioPct(rmsL, rmsR);
  m.timing = 100 * (1 - Math.abs(2 * phi - 1));
  const nd = Math.floor(cfg.dtw_seconds * fs / 2);
  const mid = Math.max(0, Math.floor(la.length / 2) - nd);
  const segL = [], segR = [];
  for (let i = mid; i < Math.min(mid + 2 * nd, la.length); i += 2) { segL.push(la[i]); segR.push(ra[i]); }
  if (segL.length >= 30) {
    const ml = median(segL), mr = median(segR);
    const cost = bandedDTW(segL.map((v) => v - ml), segR.map((v) => v - mr), cfg.dtw_radius) / Math.max(0.5 * (romL + romR), 1e-6);
    m.dtw = 100 * (1 - Math.min(1, cost / cfg.dtw_fullscale));
  }
  const [gsi, used] = combine(m, cfg.weights);
  Object.assign(row, { status: "OK", stride_hz: fStr, cadence_spm: fStr * 120, phase_lag: phi, lag_samples: lag,
    stride_samples: T, rom_L: romL, rom_R: romR, rms_L: rmsL, rms_R: rmsR, gsi, n_metrics: used });
  for (const [kk, v] of Object.entries(m)) row["m_" + kk] = v;
  return row;
}

// Score the newest window of a live buffer (window ends lagS before the newest sample).
export function liveScore(frames, cfgIn, lagS = 1.0) {
  const cfg = { ...CFG, ...(cfgIn || {}) };
  const sess = buildSession(frames, cfg);
  if (!sess.t.length) return { status: "NO_FOOT", msg: sess.flags[0] ? sess.flags[0].msg : "" };
  if (!sess.info.L.present || !sess.info.R.present) return { status: "SINGLE_LEG", msg: sess.flags[0] ? sess.flags[0].msg : "" };
  const W = Math.round(cfg.window_s * sess.fs), lag = Math.round(lagS * sess.fs), n = sess.t.length;
  if (n < W + lag) return { status: "COLLECTING", have_s: n / sess.fs, need_s: (W + lag) / sess.fs };
  const sig = prepareSignals(sess, cfg);
  const row = scoreWindow(sess, sig, n - W - lag, W, cfg);
  row.verdict = verdict(row, cfg);
  return row;
}

// Full-session analysis (report).
export function analyze(frames, cfgIn, events = []) {
  const cfg = { ...CFG, ...(cfgIn || {}) };
  const sess = buildSession(frames, cfg);
  const flags = [...sess.flags];
  const summary = { n_windows: 0, n_ok: 0, gsi: NaN };
  if (!sess.t.length) { summary.verdict = verdict({}, cfg); return { sess, windows: [], summary, flags }; }
  const fs = sess.fs;
  const sig = prepareSignals(sess, cfg);
  const W = Math.round(cfg.window_s * fs), hop = Math.round(cfg.hop_s * fs), warm = Math.round(cfg.warmup_s * fs);
  const n = sess.t.length;
  const windows = [];
  if (sess.info.L.present && sess.info.R.present) {
    for (let a = n - warm >= W ? warm : 0; a <= n - W; a += hop) windows.push(scoreWindow(sess, sig, a, W, cfg));
  }
  const ok = windows.filter((w) => w.status === "OK");
  summary.n_windows = windows.length; summary.n_ok = ok.length;
  if (ok.length) {
    const g = ok.map((w) => w.gsi);
    summary.gsi = median(g); summary.gsi_p25 = percentile(g, 25); summary.gsi_p75 = percentile(g, 75);
    for (const name of PRIMARY) {
      const v = ok.map((w) => w["m_" + name]).filter(Number.isFinite);
      summary["m_" + name] = v.length ? median(v) : NaN;
    }
    summary.cadence_spm = median(ok.map((w) => w.cadence_spm));
  } else if (sess.info.L.present && sess.info.R.present) {
    flags.push({ level: "CRIT", code: "NO_VALID_WINDOWS",
      msg: `No analysis window had enough valid foot data. A trial needs at least ${cfg.window_s} s of clean data from BOTH feet (plus ${cfg.warmup_s} s warm-up).` });
  }
  summary.verdict = verdict(summary, cfg);
  for (const k of KEYS) {
    const inf = sess.info[k];
    if (inf.present && inf.loss_pct > cfg.loss_warn_pct)
      flags.push({ level: "WARN", code: "HIGH_PACKET_LOSS", msg: `${NAMES[k]}: ${inf.loss_pct.toFixed(1)}% of packets lost.` });
  }
  const nSkip = windows.length - ok.length;
  if (nSkip && ok.length) flags.push({ level: "WARN", code: "WINDOWS_SKIPPED",
    msg: `${nSkip} of ${windows.length} windows skipped: a foot pod had too many gaps there (check battery / range).` });
  for (const e of events) flags.push({ level: e.level || "INFO", code: e.code || "EVENT", msg: `[${e.t_s.toFixed(1)} s] ${e.msg}` });
  const order = { CRIT: 0, WARN: 1, INFO: 2 };
  flags.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));
  return { sess, windows, summary, flags };
}

// Merge consecutive windows whose weakest metric is below the target threshold into flagged segments.
export function flaggedSegments(windows, cfgIn) {
  const cfg = { ...CFG, ...(cfgIn || {}) };
  const segs = [];
  let cur = null;
  for (const w of windows) {
    if (w.status !== "OK") continue;
    const [name, worst] = limitingMetric(w);
    if (name !== null && worst < cfg.thr_good) {
      if (cur && w.t_start <= cur.end) {
        cur.end = w.t_end;
        if (worst < cur.lowest) { cur.lowest = worst; cur.metric = name; }
        cur.minGsi = Math.min(cur.minGsi, w.gsi);
      } else {
        cur = { start: w.t_start, end: w.t_end, lowest: worst, metric: name, minGsi: w.gsi };
        segs.push(cur);
      }
    } else cur = null;
  }
  return segs;
}
