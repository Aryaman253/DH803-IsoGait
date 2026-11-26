// Gait simulator — JavaScript port of SECTION 1 of IsoGaitv5.py.
// Produces hub serial lines identical to the real ESP32-S3 hub:
//   D,<node>,<seq>,<hub_ms>,<ax>,<ay>,<az>,<gx>,<gy>,<gz>,<pitch>,<roll>,<yaw>
const G = 9.81;

function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const uniform = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = (mu = 0, sigma = 1) => {
    if (spare !== null) { const v = spare; spare = null; return mu + sigma * v; }
    let u = 0, v = 0;
    while (u === 0) u = uniform();
    v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return mu + sigma * r * Math.cos(2 * Math.PI * v);
  };
  return { uniform, normal, int: (lo, hi) => lo + Math.floor(uniform() * (hi - lo)) };
}

function interp1(x, xp, fp, hint) {              // single-point interp with moving hint (x increasing)
  let j = hint.j;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[xp.length - 1]) return fp[fp.length - 1];
  while (j < xp.length - 2 && xp[j + 1] < x) j++;
  hint.j = j;
  return fp[j] + (x - xp[j]) / (xp[j + 1] - xp[j]) * (fp[j + 1] - fp[j]);
}

// Map the session-setup form to simulator parameters.
export function simParamsFromSetup(s) {
  const liftSeverity = { 0: 0, 5: 0.08, 10: 0.15, 15: 0.25, 20: 0.35 };
  const sev = s.condition === "baseline" ? 0 : (liftSeverity[s.liftMm] ?? 0.15);
  const speed = Number(s.speed) || 5;
  const cadence = s.activity === "Jogging" ? Math.min(185, 140 + speed * 3) : Math.min(130, 85 + speed * 6);
  return {
    duration_sec: Math.max(15, (Number(s.duration) || 2) * 60 + 2),
    cadence_spm: cadence, asymmetry_severity: sev, side: s.liftSide === "Left" ? "L" : "R",
    packet_loss: 0.005, burst_prob: 0.0003, jitter_ms: 1.5, start_spread_s: 0.5, clock_ppm: 300, stride_var: 0.02,
    seed: Math.floor(Math.random() * 2 ** 31),
  };
}

// Pre-render a whole trial and return packets sorted by hub time: [{hub, line}]
export function renderTrial(p) {
  const rng = makeRng(p.seed);
  const fs = 100, dur = p.duration_sec;
  const s = p.asymmetry_severity, romA = s, impA = s, timA = 0.3 * s;
  const f0 = p.cadence_spm / 120;

  const dtf = 0.002, nf = Math.floor((dur + 1) / dtf);
  const knots = (kdt, sigma) => {
    const kx = [], kz = [];
    for (let t = 0; t < dur + 1 + 2 * kdt; t += kdt) { kx.push(t); kz.push(rng.normal(0, sigma)); }
    return [kx, kz];
  };
  const [fkx, fkz] = knots(0.5 / f0, p.stride_var);
  const [akx, akz] = knots(2.0, 0.03);
  const tF = new Float64Array(nf), thF = new Float64Array(nf), ampF = new Float64Array(nf);
  let acc = 0; const h1 = { j: 0 }, h2 = { j: 0 };
  const phase0 = rng.uniform() * 2 * Math.PI;
  for (let i = 0; i < nf; i++) {
    const t = i * dtf; tF[i] = t;
    acc += f0 * (1 + interp1(t, fkx, fkz, h1)) * dtf;
    thF[i] = 2 * Math.PI * acc + phase0;
    ampF[i] = 1 + interp1(t, akx, akz, h2);
  }

  const impaired = p.side || "R";
  const packets = [];
  for (const key of ["L", "R"]) {
    const off = rng.uniform() * p.start_spread_s;
    const dt = (1 / fs) * (1 + rng.normal(0, p.clock_ppm * 1e-6));
    const n = Math.floor((dur - off) / dt);
    const isImp = key === impaired;
    const romScale = isImp ? 1 - romA : 1, impScale = isImp ? 1 - impA : 1;
    const phaseOff = key === "R" ? Math.PI * (1 + (isImp ? timA : 0)) : (isImp ? -Math.PI * timA : 0);
    const hT = { j: 0 }, hA = { j: 0 };
    const rows = [];
    for (let i = 0; i < n; i++) {
      const t = off + i * dt;
      const th = interp1(t, tF, thF, hT) + phaseOff;
      const sc = romScale * interp1(t, tF, ampF, hA);
      const pitch = sc * (35 * Math.sin(th) - 14 * Math.sin(2 * th) + 4 * Math.cos(3 * th));
      const roll = 5 * Math.sin(th + 0.6), yaw = 4 * Math.cos(th);
      const contact = Math.max(0, Math.sin(th));
      const az = -G + impScale * 24 * contact ** 8 + sc * 5.5 * Math.sin(th);
      const ax = sc * 9.5 * Math.sin(th - 0.7) - impScale * 12 * contact ** 6;
      const ay = 2.8 * Math.sin(th);
      rows.push({ t, ax, ay, az, pitch, roll, yaw });
    }
    // gyro = true angular rate (deg -> rad/s, central differences like numpy.gradient)
    const rad = Math.PI / 180;
    const grad = (f, i) => {
      if (i === 0) return (rows[1][f] - rows[0][f]) / (rows[1].t - rows[0].t);
      if (i === rows.length - 1) return (rows[i][f] - rows[i - 1][f]) / (rows[i].t - rows[i - 1].t);
      return (rows[i + 1][f] - rows[i - 1][f]) / (rows[i + 1].t - rows[i - 1].t);
    };
    // packet loss + bursts
    const lost = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (rng.uniform() < p.packet_loss) lost[i] = 1;
      if (rng.uniform() < p.burst_prob) { const L = rng.int(3, 16); for (let j = i; j < Math.min(n, i + L); j++) lost[j] = 1; }
    }
    for (let i = 0; i < n; i++) {
      if (lost[i]) continue;
      const r = rows[i];
      const lat = 0.004 + Math.abs(rng.normal(0, p.jitter_ms / 1000));
      const hub = Math.round((r.t + lat) * 1000 + 5000);
      const v = [
        r.ax + rng.normal(0, 0.35), r.ay + rng.normal(0, 0.25), r.az + rng.normal(0, 0.4),
        grad("roll", i) * rad + rng.normal(0, 0.04), grad("pitch", i) * rad + rng.normal(0, 0.05), grad("yaw", i) * rad + rng.normal(0, 0.03),
        r.pitch + rng.normal(0, 0.3), r.roll + rng.normal(0, 0.2), r.yaw + rng.normal(0, 0.2),
      ];
      const line = `D,${key},${i},${hub},` + v.slice(0, 6).map((x) => x.toFixed(4)).join(",") + "," + v.slice(6).map((x) => x.toFixed(3)).join(",");
      packets.push({ hub, line });
    }
  }
  packets.sort((a, b) => a.hub - b.hub);
  return packets;
}

// Replays a pre-rendered trial in real time (speed = 1) as hub lines.
export class SimSource {
  constructor(params, onLine, speed = 1) {
    this.packets = renderTrial(params);
    this.onLine = onLine; this.speed = speed;
    this.i = 0; this.simT = 0; this.paused = false; this.timer = null;
    this.t0 = this.packets.length ? this.packets[0].hub : 0;
  }
  now() { return this.simT; }
  start() {
    let last = performance.now();
    this.timer = setInterval(() => {
      const wall = performance.now();
      if (!this.paused) this.simT += ((wall - last) / 1000) * this.speed;
      last = wall;
      while (this.i < this.packets.length && (this.packets[this.i].hub - this.t0) / 1000 <= this.simT) {
        this.onLine(this.packets[this.i].line);
        this.i++;
      }
    }, 20);
  }
  done() { return this.i >= this.packets.length; }
  stop() { clearInterval(this.timer); this.timer = null; }
}
