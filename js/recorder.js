// Recorder + live analyzer + Web Serial source — port of SECTION 3 of IsoGaitv5.py.
import { KEYS, NAMES, liveScore, CFG } from "./engine.js";

const ALIASES = { L: "L", 0: "L", LEFT: "L", R: "R", 1: "R", RIGHT: "R" };

export function parseLine(line) {
  line = line.trim();
  if (!line.startsWith("D,")) return null;
  const f = line.split(",");
  if (f.length !== 12 && f.length !== 13) throw new Error(`expected 12 or 13 fields, got ${f.length}`);
  const node = ALIASES[f[1].trim().toUpperCase()];
  if (!node) throw new Error(`unknown node '${f[1]}'`);
  const seq = parseInt(f[2], 10);
  const hub = f.length === 13 ? parseInt(f[3], 10) : null;
  const vals = f.slice(-9).map(Number);
  if (!Number.isFinite(seq) || !vals.every(Number.isFinite)) throw new Error("non-finite value");
  return [node, seq, hub, vals];
}

export class Recorder {
  constructor(clock, { offlineAfter = 0.5, grace = 3.0 } = {}) {
    this.clock = clock;                 // () => seconds since recording start
    this.offlineAfter = offlineAfter; this.grace = grace;
    this.events = []; this.parseErrors = 0; this.ignored = 0;
    this.hubT0 = null; this.paused = false;
    this.rows = { L: [], R: [] };       // [seq, hub_ms, ax, ay, az, gx, gy, gz, pitch, roll, yaw]
    this.st = {};
    for (const k of KEYS) this.st[k] = { count: 0, lost: 0, lastSeq: null, lastT: null, online: false, offlineSince: null,
      nOffline: 0, winCount: 0, winT: 0, rate: 0, resets: 0, neverFlagged: false };
    this.listeners = [];
  }
  now() { return this.clock(); }
  log(level, code, msg) {
    const e = { t_s: Math.round(this.now() * 100) / 100, level, code, msg };
    this.events.push(e);
    this.listeners.forEach((fn) => fn(e));
  }
  handleLine(line) {
    if (this.paused) return;
    let pkt;
    try { pkt = parseLine(line); } catch (err) {
      this.parseErrors++;
      if (this.parseErrors <= 5) this.log("WARN", "PARSE_ERROR", `Bad line ignored (${err.message}).`);
      return;
    }
    if (!pkt) { this.ignored++; return; }
    const [k, seq, hubIn, vals] = pkt;
    const s = this.st[k], now = this.now();
    const hub = hubIn ?? Math.round(now * 1000) + 1;
    if (this.hubT0 === null) this.hubT0 = hub;
    if (!s.online) {
      if (s.offlineSince !== null) this.log("INFO", `${k}_BACK`, `${NAMES[k]} pod back online after ${(now - s.offlineSince).toFixed(1)} s offline.`);
      else this.log("INFO", `${k}_ONLINE`, `${NAMES[k]} pod connected.`);
      s.online = true; s.offlineSince = null;
    }
    if (s.lastSeq !== null) {
      const d = seq - s.lastSeq;
      if (d > 1) s.lost += d - 1;
      else if (d < -1000) { s.resets++; this.log("WARN", `${k}_RESET`, `${NAMES[k]} pod restarted (seq reset).`); }
    }
    s.lastSeq = seq; s.lastT = now; s.count++; s.winCount++;
    this.rows[k].push([seq, hub, ...vals]);
  }
  tick() {
    const now = this.now();
    for (const k of KEYS) {
      const s = this.st[k];
      if (this.paused) { s.lastT = s.lastT === null ? null : now; continue; }
      if (s.online && now - s.lastT > this.offlineAfter) {
        s.online = false; s.offlineSince = s.lastT; s.nOffline++;
        this.log("CRIT", `${k}_OFFLINE`, `${NAMES[k]} pod offline — check wireless link and battery.`);
      }
      if (s.count === 0 && now > this.grace && !s.neverFlagged) {
        s.neverFlagged = true;
        this.log("CRIT", `${k}_NEVER_CONNECTED`, `${NAMES[k]} pod has not sent any data.`);
      }
      if (now - s.winT >= 1.0) { s.rate = s.winCount / (now - s.winT); s.winCount = 0; s.winT = now; }
    }
  }
  nodeStatus(k) {
    const s = this.st[k], tot = s.count + s.lost;
    return { ...s, lossPct: tot ? (100 * s.lost) / tot : 0, age: s.lastT === null ? null : this.now() - s.lastT };
  }
  newestHub() {
    let m = null;
    for (const k of KEYS) { const r = this.rows[k]; if (r.length) { const h = r[r.length - 1][1]; if (m === null || h > m) m = h; } }
    return m;
  }
  recentFrames(seconds) {
    const newest = this.newestHub();
    if (newest === null) return {};
    const out = {};
    for (const k of KEYS) {
      const r = this.rows[k];
      let i = r.length;
      while (i > 0 && r[i - 1][1] >= newest - seconds * 1000) i--;
      if (i < r.length) out[k] = r.slice(i);
    }
    return out;
  }
  // Last `seconds` of pitch per node, as [t_rel_s, pitch] in hub time.
  recentPitch(seconds, endLagS = 0) {
    const newest = this.newestHub();
    const out = { L: [], R: [] };
    if (newest === null) return out;
    const end = newest - endLagS * 1000, start = end - seconds * 1000;
    for (const k of KEYS) {
      const r = this.rows[k];
      for (let i = r.length - 1; i >= 0 && r[i][1] >= start - 2000; i--) out[k].push([r[i][1], r[i][8]]);
      out[k].reverse();
    }
    return { ...out, start, end };
  }
  toCSV() {
    const head = "node,seq,hub_ms,timestamp,ax,ay,az,gx,gy,gz,pitch,roll,yaw";
    const lines = [head];
    for (const k of KEYS) for (const r of this.rows[k])
      lines.push([k, r[0], r[1], ((r[1] - this.hubT0) / 1000).toFixed(3), ...r.slice(2).map((v) => v.toFixed(4))].join(","));
    return lines.join("\n");
  }
}

export class LiveAnalyzer {
  constructor(rec, onResult, cfg) { this.rec = rec; this.onResult = onResult; this.cfg = cfg; this.points = []; this.latest = null; this.timer = null; }
  start() { this.timer = setInterval(() => this.evaluate(), 1000); }
  stop() { clearInterval(this.timer); this.timer = null; }
  evaluate() {
    const now = this.rec.now();
    if (now < 1 || this.rec.paused) return;
    let r;
    try {
      const cfg = { ...CFG, ...(this.cfg || {}) };
      r = liveScore(this.rec.recentFrames(cfg.window_s + 3), cfg);
    } catch (e) { r = { status: "ERROR", msg: String(e) }; }
    r.t = Math.round(now * 100) / 100;
    this.latest = r;
    if (r.status === "OK") this.points.push(r);
    this.onResult(r);
  }
}

// ---- Web Serial line source (Chrome / Edge on desktop) -----------------------------------
export const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ""));
export const webSerialSupported = () => "serial" in navigator && !isMobile();

export class SerialSource {
  constructor(onLine, onError) { this.onLine = onLine; this.onError = onError; this.port = null; this.reader = null; this.running = false; this.t0 = performance.now(); }
  async request(baud = 921600) {
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: baud, bufferSize: 1 << 16 });
    const info = this.port.getInfo ? this.port.getInfo() : {};
    return info;
  }
  now() { return (performance.now() - this.t0) / 1000; }
  async start() {
    this.running = true;
    const decoder = new TextDecoder();
    let buf = "";
    while (this.running && this.port && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        while (this.running) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n");
          buf = parts.pop();
          for (const ln of parts) this.onLine(ln);
        }
      } catch (e) {
        if (this.running) this.onError && this.onError(e);
        break;
      } finally {
        try { this.reader.releaseLock(); } catch (_) { /* ignore */ }
      }
    }
  }
  async stop() {
    this.running = false;
    try { if (this.reader) await this.reader.cancel(); } catch (_) { /* ignore */ }
    try { if (this.port) await this.port.close(); } catch (_) { /* ignore */ }
    this.port = null;
  }
}
