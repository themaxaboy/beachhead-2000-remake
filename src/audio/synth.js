/**
 * synth.js — procedural sound design for the Beach Head 2000 remake.
 *
 * Every sound is synthesized at load time; no sample files are used. Each recipe builds a small
 * Web Audio graph inside its own OfflineAudioContext (noise / oscillator sources -> biquads ->
 * enveloped gains -> WaveShaper saturation -> delay-line reflections), optionally fed by
 * JS-generated excitation buffers (modal "struck metal" partials, granular debris/sand, bubble
 * chirps, rotor-blade pulse trains). Renders run concurrently on the audio threads, then a small
 * JS pass removes DC, soft-limits ("punch"), trims silence and normalizes.
 *
 * Loops are made seamless by construction: every source inside a loop graph is periodic with
 * the loop length L (looped noise buffers of exactly L samples, oscillator/LFO frequencies that
 * are integer multiples of 1/L, wrap-around event buffers). After a short settle time the filter
 * states are periodic too, so the window [settle, settle + L) wraps without a seam.
 *
 * Public API:
 *   renderAll(sampleRate, onProgress?) -> Promise<Map<string, AudioBuffer[]>>
 *   SOUND_META   { [name]: { loop, loopable, gain, var, ref, reverb, cap, bus, prio, pan2D } }
 *   SOUND_NAMES  string[]
 */

const TAU = Math.PI * 2;
const MAX_RENDER_SR = 48000;
const CONCURRENCY = 8;

// ------------------------------------------------------------------------------------------------
// Seeded randomness (deterministic renders per recipe/variant)
// ------------------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

let rnd = Math.random;
const rr = (a, b) => a + (b - a) * rnd();
const rlog = (a, b) => a * Math.pow(b / a, rnd());
const sgn = () => (rnd() < 0.5 ? -1 : 1);

// ------------------------------------------------------------------------------------------------
// Buffers & shared resources
// ------------------------------------------------------------------------------------------------
function toBuf(data, sr) {
  const b = new AudioBuffer({ length: Math.max(1, data.length), sampleRate: sr, numberOfChannels: 1 });
  b.copyToChannel(data, 0);
  return b;
}

/** 4 s circular white / pink / brown noise, RMS-matched so recipe levels are comparable. */
function makeShared(sr) {
  const rand = mulberry32(0xbeac4);
  const n = Math.round(sr * 4);
  const white = new Float32Array(n);
  const pink = new Float32Array(n);
  const brown = new Float32Array(n);
  for (let i = 0; i < n; i++) white[i] = rand() * 2 - 1;
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
  // two passes over the same white noise: the second pass starts with settled filter state, so the
  // colored noise is circular (seamless when a source loops it)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const w = white[i];
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
      br = br * 0.996 + w * 0.06;
      if (pass === 1) {
        pink[i] = p;
        brown[i] = br;
      }
    }
  }
  const norm = (d, target) => {
    let s = 0, m = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i], (m += d[i]);
    m /= d.length;
    const k = target / Math.sqrt(s / d.length - m * m);
    for (let i = 0; i < d.length; i++) d[i] = (d[i] - m) * k;
  };
  norm(white, 0.35);
  norm(pink, 0.35);
  norm(brown, 0.35);
  return {
    sr,
    white: toBuf(white, sr),
    pink: toBuf(pink, sr),
    brown: toBuf(brown, sr),
    curves: new Map(),
  };
}

// ------------------------------------------------------------------------------------------------
// Graph builder — thin sugar over an OfflineAudioContext
// ------------------------------------------------------------------------------------------------
class Graph {
  constructor(S, lenSamples) {
    this.S = S;
    this.sr = S.sr;
    this.len = Math.max(256, lenSamples | 0);
    this.dur = this.len / this.sr;
    this.c = new OfflineAudioContext(1, this.len, this.sr);
    this.out = this.c.createGain();
    this.out.connect(this.c.destination);
    this.L = 0; // loop length in samples (loop recipes only)
    this.Ls = 0; // loop length in seconds
    this.LN = null; // periodic white noise of exactly L samples
  }

  // ---- sources
  buf(b, t = 0, o = {}) {
    const s = this.c.createBufferSource();
    s.buffer = b;
    if (o.rate && o.rate !== 1) s.playbackRate.value = o.rate;
    if (o.loop) s.loop = true;
    const t0 = Math.max(0, t);
    s.start(t0, o.offset || 0);
    if (o.dur != null) s.stop(t0 + Math.max(0.001, o.dur));
    return s;
  }
  /** Colored noise from the shared circular buffers, random start offset per call. */
  noise(color = 'white', t = 0, dur = this.dur - t) {
    const b = this.S[color];
    const bd = b.duration;
    const loop = dur > bd * 0.8;
    const offset = loop ? rnd() * bd * 0.95 : rnd() * (bd - dur - 0.01);
    return this.buf(b, t, { loop, offset, dur: Math.min(dur, this.dur - t) + 0.002 });
  }
  /** Periodic (loop-length) white noise — only for loop recipes. */
  lnoise() {
    return this.buf(this.LN, 0, { loop: true, offset: Math.floor(rnd() * this.L) / this.sr });
  }
  /** Round a frequency to an integer number of cycles per loop (keeps loops periodic). */
  pf(f) {
    return this.Ls ? Math.max(1, Math.round(f * this.Ls)) / this.Ls : f;
  }
  osc(type, f, t = 0, dur = this.dur - t) {
    const o = this.c.createOscillator();
    if (typeof type === 'string') o.type = type;
    else o.setPeriodicWave(type);
    o.frequency.value = f;
    const t0 = Math.max(0, t);
    o.start(t0);
    o.stop(t0 + Math.max(0.001, dur));
    return o;
  }

  // ---- processors
  f(type, freq, Q, gain) {
    const b = this.c.createBiquadFilter();
    b.type = type;
    b.frequency.value = Math.min(freq, this.sr * 0.45);
    if (Q != null) b.Q.value = Q;
    if (gain != null) b.gain.value = gain;
    return b;
  }
  lp(f, Q = 0.707) { return this.f('lowpass', f, Q); }
  hp(f, Q = 0.707) { return this.f('highpass', f, Q); }
  bp(f, Q = 1) { return this.f('bandpass', f, Q); }
  pk(f, Q, db) { return this.f('peaking', f, Q, db); }
  ls(f, db) { return this.f('lowshelf', f, undefined, db); }
  hs(f, db) { return this.f('highshelf', f, undefined, db); }
  g(v = 1) {
    const g = this.c.createGain();
    g.gain.value = v;
    return g;
  }
  /** tanh saturation; `asym` adds even harmonics. Input beyond ±1 hard-limits at the curve ends. */
  ws(drive = 2, asym = 0) {
    const key = drive + ':' + asym;
    let curve = this.S.curves.get(key);
    if (!curve) {
      curve = new Float32Array(2048);
      const off = Math.tanh(drive * asym);
      const k = Math.max(Math.abs(Math.tanh(drive * (1 + asym)) - off), Math.abs(Math.tanh(drive * (-1 + asym)) - off));
      for (let i = 0; i < 2048; i++) {
        const x = (i / 2047) * 2 - 1;
        curve[i] = (Math.tanh(drive * (x + asym)) - off) / k;
      }
      this.S.curves.set(key, curve);
    }
    const w = this.c.createWaveShaper();
    w.curve = curve;
    return w;
  }
  dl(t) {
    const d = this.c.createDelay(Math.max(0.05, t + 0.05));
    d.delayTime.value = t;
    return d;
  }
  ch(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }
  /** src -> pre... -> envelope gain -> post... -> dest. Returns the last node before dest. */
  layer(src, pre = [], env = null, post = [], dest = this.out) {
    const eg = this.g(env ? 0 : 1);
    this.ch(src, ...pre, eg, ...post);
    const last = post.length ? post[post.length - 1] : eg;
    last.connect(dest);
    if (env) env(eg.gain);
    return last;
  }
}

// ---- envelopes (functions applied to an AudioParam)
/** Linear attack then exponential decay with time constant tau. */
const perc = (t, att, tau, peak = 1) => (p) => {
  p.setValueAtTime(0, 0);
  if (t > 0) p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + att);
  p.setTargetAtTime(0, t + att, tau);
};
/** Rise from t0 to peak at tp, then exponential decay. */
const swell = (t0, tp, tau, peak = 1) => (p) => {
  p.setValueAtTime(0, 0);
  if (t0 > 0) p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(peak, Math.max(tp, t0 + 0.0005));
  p.setTargetAtTime(0, Math.max(tp, t0 + 0.0005), tau);
};
/** Attack, hold until t1, exponential release. */
const ahd = (t0, att, t1, tau, peak = 1) => (p) => {
  const ta = t0 + att;
  p.setValueAtTime(0, 0);
  if (t0 > 0) p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(peak, ta);
  p.setValueAtTime(peak, Math.max(t1, ta));
  p.setTargetAtTime(0, Math.max(t1, ta), tau);
};
/** Attack, hold until t1, linear release to zero. */
const hold = (t0, att, t1, rel, peak = 1) => (p) => {
  const ta = t0 + att;
  p.setValueAtTime(0, 0);
  if (t0 > 0) p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(peak, ta);
  p.setValueAtTime(peak, Math.max(t1, ta));
  p.linearRampToValueAtTime(0, Math.max(t1, ta) + rel);
};
const sweep = (param, t, f0, f1, T) => {
  param.setValueAtTime(f0, t);
  param.exponentialRampToValueAtTime(f1, t + T);
};

// ---- layer helpers
function nhit(g, t, o = {}) {
  const { color = 'white', pre = [], att = 0.001, tau = 0.05, level = 1, post = [], dest = g.out, env = null } = o;
  const dur = Math.min(g.dur - t, o.dur ?? att + tau * 8 + 0.005);
  if (dur <= 0.0005) return null;
  return g.layer(g.noise(color, t, dur), pre, env || perc(t, att, tau, level), post, dest);
}
function tone(g, t, o = {}) {
  const { type = 'sine', f0 = 100, f1 = f0, sw = 0.05, att = 0.001, tau = 0.08, level = 1, pre = [], post = [], dest = g.out, env = null } = o;
  const dur = Math.min(g.dur - t, o.dur ?? att + tau * 8 + 0.005);
  if (dur <= 0.0005) return null;
  const osc = g.osc(type, f0, t, dur);
  if (f1 !== f0) sweep(osc.frequency, t, f0, f1, sw);
  return g.layer(osc, pre, env || perc(t, att, tau, level), post, dest);
}
function lpSweep(g, f0, f1, t, T, Q = 0.707) {
  const f = g.lp(f0, Q);
  sweep(f.frequency, t, f0, f1, T);
  return f;
}
/** Discrete reflections: from -> delay -> lowpass -> gain -> dest. */
function echo(g, from, taps, dest = g.out) {
  for (const [dt, lpf, gain] of taps) g.ch(from, g.dl(dt), g.lp(lpf, 0.5), g.g(gain), dest);
}
/** Gain node whose gain is 1 + (sum of sine LFOs) * depth — amplitude modulation in series. */
function amNode(g, depth, freqs) {
  const a = g.g(1);
  for (const f of freqs) {
    const o = g.osc('sine', f, 0, g.dur);
    const d = g.g(depth / freqs.length);
    o.connect(d);
    d.connect(a.gain);
  }
  return a;
}
/** Lowpassed noise rumble with slow random-ish amplitude wobble and darkening over time. */
function rumble(g, t, o = {}) {
  const { f = 250, f1 = f * 0.45, att = 0.05, peakAt = t + att, tau = 0.8, level = 0.5, am = 0.3, dest = g.out, color = 'brown' } = o;
  const dur = Math.min(g.dur - t, tau * 7 + (peakAt - t));
  if (dur <= 0.001) return null;
  const pre = [lpSweep(g, f, f1, t, Math.min(dur, tau * 3), 0.6)];
  if (am > 0) pre.push(amNode(g, am, [rr(2, 3.6), rr(4.4, 7), rr(0.7, 1.5)]));
  return g.layer(g.noise(color, t, dur), pre, swell(t, peakAt, tau, level), [], dest);
}

// ---- JS excitation generators
/** Struck-object partials: [freq, decayTau, amp]. Inharmonic ratios give "metal". */
function metal(f0, ratios, tau, spread = 0.015) {
  return ratios.map((r, i) => [f0 * r * (1 + (rnd() * 2 - 1) * spread), (tau / (1 + 0.45 * i)) * rr(0.8, 1.2), (1 / (1 + 0.55 * i)) * rr(0.6, 1.1)]);
}
/** Sum of exponentially damped sinusoids (+ optional noise "strike"). hits: {t, amp, parts, strike, strikeTau, phase} */
function modalInto(d, sr, hits, wrap = false) {
  const n = d.length;
  for (const h of hits) {
    let i0 = Math.round(h.t * sr);
    if (i0 >= n) {
      if (!wrap) continue;
      i0 %= n;
    }
    for (const [f, tau, a] of h.parts) {
      if (f >= sr * 0.45 || a === 0) continue;
      const w = (TAU * f) / sr;
      const r = Math.exp(-1 / (tau * sr));
      const c2 = 2 * r * Math.cos(w), r2 = r * r;
      const A = h.amp * a;
      const ph = h.phase ?? rnd() * TAU;
      let y2 = A * Math.sin(ph);
      let y1 = A * r * Math.sin(w + ph);
      const len = wrap ? Math.min(n, Math.ceil(tau * sr * 7)) : Math.min(n - i0, Math.ceil(tau * sr * 7));
      let i = i0;
      for (let k = 0; k < len; k++) {
        let y;
        if (k === 0) y = y2;
        else if (k === 1) y = y1;
        else {
          y = c2 * y1 - r2 * y2;
          y2 = y1;
          y1 = y;
        }
        d[i] += y;
        if (++i >= n) i = 0;
      }
    }
    if (h.strike) {
      const tau = h.strikeTau ?? 0.0006;
      const k = Math.exp(-1 / (tau * sr));
      const len = Math.ceil(tau * sr * 6);
      let e = h.amp * h.strike;
      let i = i0;
      for (let j = 0; j < len; j++) {
        if (i >= n) {
          if (!wrap) break;
          i = 0;
        }
        d[i++] += e * (rnd() * 2 - 1);
        e *= k;
      }
    }
  }
  return d;
}
function modalBuf(g, dur, hits) {
  return toBuf(modalInto(new Float32Array(Math.ceil(dur * g.sr)), g.sr, hits), g.sr);
}
/** Poisson-distributed micro noise bursts (crackle, sand, debris, fire). */
function grainsInto(d, sr, o) {
  const { t0 = 0, t1 = d.length / sr, rate, amp, gmin = 0.0002, gmax = 0.0015, skew = 3, wrap = false } = o;
  const n = d.length;
  let t = t0;
  for (;;) {
    t += -Math.log(1 - rnd()) / Math.max(rate(t), 0.5);
    if (t >= t1) break;
    const a = amp(t) * Math.pow(rnd(), skew) * sgn();
    const tau = rr(gmin, gmax);
    const k = Math.exp(-1 / (tau * sr));
    const len = Math.ceil(tau * sr * 5);
    let e = a;
    let i = Math.floor(t * sr);
    for (let j = 0; j < len; j++, i++) {
      if (i >= n) {
        if (!wrap) break;
        i -= n;
      }
      d[i] += e * (rnd() * 2 - 1);
      e *= k;
    }
  }
  return d;
}
/** Water droplets / bubbles: upward-chirping damped sines (Van den Doel style). */
function bubblesInto(d, sr, o) {
  const { t0 = 0, t1 = d.length / sr, rate, amp, fmin = 800, fmax = 4000, tmin = 0.005, tmax = 0.02, rise = 0.9, wrap = false } = o;
  const n = d.length;
  let t = t0;
  for (;;) {
    t += -Math.log(1 - rnd()) / Math.max(rate(t), 0.5);
    if (t >= t1) break;
    const f0 = rlog(fmin, fmax);
    const tau = rr(tmin, tmax) * Math.sqrt(1500 / f0);
    const a = amp(t) * (0.25 + 0.75 * rnd());
    const len = Math.ceil(tau * sr * 5);
    const dec = Math.exp(-1 / (tau * sr));
    let e = a, ph = 0;
    let i = Math.floor(t * sr);
    for (let j = 0; j < len; j++, i++) {
      if (i >= n) {
        if (!wrap) break;
        i -= n;
      }
      ph += (TAU * f0 * (1 + (rise * j) / len)) / sr;
      d[i] += e * (j < 24 ? j / 24 : 1) * Math.sin(ph);
      e *= dec;
    }
  }
  return d;
}
function jsBuf(g, fill) {
  const d = new Float32Array(g.len);
  fill(d, g.sr);
  return toBuf(d, g.sr);
}

// ---- JS post effects
/** Compact Freeverb-style reverb (6 damped combs + 3 allpasses); wet energy set relative to dry. */
function reverbJS(x, sr, { rt = 1.4, mix = 0.2, damp = 0.35, pre = 0.012 } = {}) {
  const n = x.length;
  const scale = sr / 44100;
  const cl = [1116, 1188, 1277, 1356, 1422, 1491].map((v) => Math.round(v * scale));
  const al = [556, 441, 341].map((v) => Math.round(v * scale));
  const cb = cl.map((l) => new Float32Array(l));
  const ci = new Int32Array(6);
  const cs = new Float64Array(6);
  const cg = cl.map((l) => Math.pow(10, (-3 * (l / sr)) / rt));
  const ab = al.map((l) => new Float32Array(l));
  const ai = new Int32Array(3);
  const preN = Math.round(pre * sr);
  const wet = new Float32Array(n);
  const d1 = 1 - damp;
  for (let i = 0; i < n; i++) {
    const inp = i >= preN ? x[i - preN] : 0;
    let s = 0;
    for (let c = 0; c < 6; c++) {
      const b = cb[c];
      const o = b[ci[c]];
      cs[c] = o * d1 + cs[c] * damp;
      b[ci[c]] = inp + cs[c] * cg[c];
      if (++ci[c] >= b.length) ci[c] = 0;
      s += o;
    }
    for (let a = 0; a < 3; a++) {
      const b = ab[a];
      const bo = b[ai[a]];
      b[ai[a]] = s + bo * 0.5;
      s = bo - s;
      if (++ai[a] >= b.length) ai[a] = 0;
    }
    wet[i] = s;
  }
  let ed = 0, ew = 0;
  for (let i = 0; i < n; i++) (ed += x[i] * x[i]), (ew += wet[i] * wet[i]);
  const k = ew > 0 ? mix * Math.sqrt(ed / ew) : 0;
  for (let i = 0; i < n; i++) x[i] += wet[i] * k;
  return x;
}
const rv = (o) => (d, sr) => reverbJS(d, sr, o);

// ------------------------------------------------------------------------------------------------
// Recipe registry
// ------------------------------------------------------------------------------------------------
const RECIPES = {};
const DEFAULTS = {
  dur: 1, // one-shot render length (s)
  variants: 3,
  loop: false, // continuous loop (len seconds, 1 variant)
  loopable: false, // one-shot that is also sample-exact periodic
  len: 3,
  settle: 0.4,
  gain: 1, // engine playback gain (mix balance, since every buffer is peak-normalized)
  var: 0.04, // random playback-rate variance (±)
  ref: 12, // PannerNode refDistance
  reverb: 0.15, // shared reverb send level
  cap: 6, // max simultaneous voices of this sound
  bus: 'sfx',
  prio: 1, // voice-steal priority when the global cap is hit
  peak: 0.89, // normalization target (≈ -1 dBFS)
  punch: 0, // soft-clip drive applied before normalization (loudness density)
  pan2D: 0, // stereo spread for non-positional playback ('mg' alternates barrels)
  post: null, // JS post-process (d, sr) => void
  js: null, // pure-JS recipe (sr) => Float32Array (bypasses the graph)
};
function def(name, meta, build) {
  RECIPES[name] = Object.assign({ name, build }, DEFAULTS, meta.loop ? { peak: 0.5, variants: 1, var: 0 } : null, meta);
}

// ================================================================================================
// PLAYER WEAPONS (2D)
// ================================================================================================

def('mg', { dur: 0.42, variants: 4, var: 0.03, cap: 8, gain: 0.6, reverb: 0.1, prio: 3, punch: 2.2, pan2D: 0.14 }, (g) => {
  const t = 0.001;
  const bus = g.g(1);
  bus.connect(g.out);
  // supersonic muzzle crack
  nhit(g, t, { pre: [g.hp(2200)], att: 0.0001, tau: rr(0.0018, 0.0026), level: 1.1, post: [g.ws(3)], dest: bus });
  // muzzle blast bark
  nhit(g, t, { color: 'pink', pre: [lpSweep(g, 7000, rr(650, 850), t, 0.1, 0.9), g.pk(rr(950, 1250), 1.2, 6)], att: 0.0005, tau: rr(0.024, 0.032), level: 1.2, dest: bus });
  // chest thump
  tone(g, t, { f0: rr(150, 172), f1: rr(46, 54), sw: 0.07, att: 0.0012, tau: rr(0.038, 0.048), level: 1.4, post: [g.ws(2.4)], dest: bus });
  // low pressure punch
  nhit(g, t, { color: 'brown', pre: [g.lp(240)], att: 0.0015, tau: 0.05, level: 1.0, dest: bus });
  // bolt / feed-tray clack
  const mb = modalBuf(g, 0.22, [
    { t: t + rr(0.022, 0.03), amp: 0.22, strike: 0.6, parts: metal(rr(1700, 2100), [1, 1.71, 2.53, 3.4], 0.022) },
    { t: t + rr(0.058, 0.072), amp: 0.12, strike: 0.5, parts: metal(rr(2500, 3000), [1, 1.6, 2.4], 0.014) },
  ]);
  g.ch(g.buf(mb), g.hp(900), bus);
  // close reflections (sandbags, bunker slit)
  echo(g, bus, [
    [rr(0.032, 0.042), 2400, 0.3],
    [rr(0.07, 0.09), 1400, 0.18],
    [rr(0.13, 0.16), 900, 0.1],
  ]);
});

def('mgTail', { dur: 1.7, variants: 3, var: 0.05, cap: 2, gain: 0.5, reverb: 0.25, prio: 2, post: rv({ rt: 1.2, mix: 0.25 }) }, (g) => {
  const bus = g.g(1);
  bus.connect(g.out);
  // the burst's rhythm echoing back from the dunes
  const n = 5 + Math.floor(rnd() * 3);
  let tt = rr(0.03, 0.06);
  for (let k = 0; k < n; k++) {
    nhit(g, tt, { color: 'pink', pre: [g.bp(rr(450, 750), 0.8), g.lp(1500)], att: 0.004, tau: rr(0.035, 0.05), level: 0.9 * Math.exp(-k * 0.42), dest: bus });
    tt += rr(0.085, 0.1);
  }
  nhit(g, 0, { color: 'pink', pre: [g.bp(700, 0.5)], env: swell(0, 0.06, 0.3, 0.3), dur: 1.6, dest: bus });
  rumble(g, 0, { f: 200, att: 0.03, tau: 0.42, level: 0.5, dest: bus });
  echo(g, bus, [
    [0.23, 900, 0.35],
    [0.5, 600, 0.2],
  ]);
});

def('brass', { dur: 1.0, variants: 4, var: 0.08, cap: 4, gain: 0.3, reverb: 0.05, prio: 0 }, (g) => {
  const hits = [];
  const casings = 2 + (rnd() < 0.5 ? 1 : 0);
  for (let c = 0; c < casings; c++) {
    let t = rr(0.0, 0.1) + c * rr(0.04, 0.1);
    let a = rr(0.7, 1);
    let gap = rr(0.09, 0.15);
    const f0 = rr(2300, 3400);
    const bounces = 3 + Math.floor(rnd() * 3);
    for (let b = 0; b < bounces && t < 0.8; b++) {
      hits.push({
        t,
        amp: a,
        strike: 0.4,
        parts: [
          [f0, rr(0.05, 0.09), 1],
          [f0 * 2.756 * rr(0.98, 1.02), 0.04, 0.55],
          [f0 * 5.404 * rr(0.98, 1.02), 0.025, 0.3],
          [f0 * rr(1.3, 1.5), 0.03, 0.25],
        ],
      });
      t += gap;
      gap *= rr(0.55, 0.75);
      a *= rr(0.45, 0.7);
    }
  }
  g.ch(g.buf(modalBuf(g, g.dur, hits)), g.hp(1200), g.out);
});

def('at', { dur: 3.2, variants: 3, var: 0.03, cap: 2, gain: 1, reverb: 0.3, prio: 3, punch: 2.0, post: rv({ rt: 1.8, mix: 0.1 }) }, (g) => {
  const t = 0.002;
  const bus = g.g(1);
  bus.connect(g.out);
  nhit(g, t, { pre: [g.hp(1400)], att: 0.0002, tau: 0.004, level: 1.0, post: [g.ws(3)], dest: bus });
  nhit(g, t, { color: 'pink', pre: [lpSweep(g, 7500, rr(350, 450), t, 0.35, 0.8), g.pk(600, 1, 4)], att: 0.001, tau: rr(0.08, 0.1), level: 1.3, post: [g.ws(1.6)], dest: bus });
  tone(g, t, { f0: rr(85, 96), f1: 32, sw: 0.25, att: 0.002, tau: 0.22, level: 1.8, post: [g.ws(2)], dest: bus });
  nhit(g, t, { color: 'brown', pre: [g.lp(180)], att: 0.003, tau: 0.35, level: 1.1, dest: bus });
  rumble(g, t + 0.02, { f: 320, f1: 140, att: 0.1, tau: 0.7, level: 0.55, am: 0.35, dest: bus });
  // diffuse outdoor tail
  nhit(g, t, { color: 'pink', pre: [g.bp(900, 0.5)], env: swell(t + 0.01, t + 0.08, 0.55, 0.28), dur: 3, dest: g.out });
  // breech recoil clunk
  g.ch(g.buf(modalBuf(g, 1, [{ t: rr(0.11, 0.14), amp: 0.3, strike: 0.3, parts: metal(rr(200, 240), [1, 2.45, 4.1, 6.7], 0.15) }])), g.out);
  echo(g, bus, [
    [rr(0.17, 0.22), 1500, 0.35],
    [rr(0.4, 0.48), 900, 0.25],
    [rr(0.75, 0.9), 600, 0.15],
  ]);
});

def('atReload', { dur: 0.75, variants: 3, var: 0.04, cap: 2, gain: 0.7, reverb: 0.1, prio: 3 }, (g) => {
  const tc = rr(0.4, 0.45);
  const hits = [
    { t: 0.01, amp: 0.9, strike: 0.5, parts: metal(rr(290, 330), [1, 2.32, 4.25, 6.8, 9.9], 0.12) },
    { t: rr(0.035, 0.05), amp: 0.35, strike: 0.6, parts: metal(rr(1500, 1800), [1, 1.55, 2.2], 0.03) },
    { t: tc, amp: 1.0, strike: 0.6, parts: metal(rr(250, 280), [1, 2.4, 4.1, 6.3, 9.2], 0.14) },
    { t: tc + rr(0.03, 0.045), amp: 0.45, strike: 0.7, parts: metal(rr(2600, 3200), [1, 1.48, 2.1], 0.025) },
  ];
  for (let k = 0; k < 4; k++) hits.push({ t: rr(0.12, 0.3), amp: rr(0.05, 0.12), strike: 0.8, parts: metal(rr(2000, 3500), [1, 1.6], 0.012) });
  g.ch(g.buf(modalBuf(g, g.dur, hits)), g.hp(120), g.out);
  tone(g, 0.01, { f0: 140, f1: 80, sw: 0.03, tau: 0.03, level: 0.7, post: [g.ws(1.5)] });
  tone(g, tc, { f0: 120, f1: 60, sw: 0.04, tau: 0.045, level: 1.0, post: [g.ws(1.5)] });
  // shell sliding into the breech
  nhit(g, 0.1, { pre: [g.bp(rr(1600, 2200), 1.5)], env: swell(0.1, 0.17, 0.06, 0.25), dur: 0.35 });
  nhit(g, tc - 0.08, { pre: [g.bp(1200, 1.2)], env: swell(tc - 0.08, tc - 0.01, 0.02, 0.3), dur: 0.12 });
});

def('missileLaunch', { dur: 2.2, variants: 3, var: 0.04, cap: 3, gain: 0.9, reverb: 0.25, prio: 3, punch: 1.2 }, (g) => {
  const t = 0.002;
  nhit(g, t, { pre: [g.hp(700)], att: 0.0002, tau: 0.008, level: 0.9, post: [g.ws(2)] });
  tone(g, t, { f0: 120, f1: 50, sw: 0.06, tau: 0.06, level: 1.0, post: [g.ws(1.8)] });
  // rocket motor, receding (filters close as it flies away)
  const bpA = g.bp(1600, 0.7);
  sweep(bpA.frequency, t + 0.2, 1600, 650, 1.4);
  nhit(g, t, { pre: [bpA, lpSweep(g, 9000, 1400, t + 0.2, 1.6)], env: ahd(t + 0.01, 0.05, t + 0.3, 0.45, 1.0), dur: 2.1 });
  nhit(g, t, { color: 'pink', pre: [lpSweep(g, 900, 280, t + 0.2, 1.5)], env: ahd(t + 0.01, 0.05, t + 0.3, 0.5, 0.9), dur: 2.1 });
  const cr = jsBuf(g, (d, sr) => grainsInto(d, sr, { t0: t + 0.02, t1: 1.8, rate: () => 180, amp: (x) => (x < 0.35 ? 1 : Math.exp(-(x - 0.35) / 0.4)), gmin: 0.0002, gmax: 0.0008 }));
  g.ch(g.buf(cr), g.hp(1800), g.g(0.6), g.out);
  // tube-exit whoosh
  const bpW = g.bp(400, 2);
  bpW.frequency.setValueAtTime(400, t);
  bpW.frequency.exponentialRampToValueAtTime(2800, t + 0.18);
  bpW.frequency.exponentialRampToValueAtTime(600, t + 0.8);
  nhit(g, t, { pre: [bpW], env: swell(t, t + 0.12, 0.2, 1.1), dur: 1.2 });
});

def('pistol', { dur: 0.6, variants: 3, var: 0.04, cap: 4, gain: 0.8, reverb: 0.18, prio: 3, punch: 1.8 }, (g) => {
  const t = 0.001;
  const bus = g.g(1);
  bus.connect(g.out);
  nhit(g, t, { pre: [g.hp(3000)], att: 0.0001, tau: 0.0018, level: 1.2, post: [g.ws(3)], dest: bus });
  nhit(g, t, { color: 'pink', pre: [lpSweep(g, 9000, 1600, t, 0.05), g.pk(rr(1300, 1700), 1, 6)], att: 0.0004, tau: rr(0.014, 0.02), level: 1.1, dest: bus });
  tone(g, t, { f0: 230, f1: 90, sw: 0.03, att: 0.0008, tau: 0.022, level: 0.8, post: [g.ws(2)], dest: bus });
  const mb = modalBuf(g, 0.2, [
    { t: t + rr(0.014, 0.02), amp: 0.2, strike: 0.6, parts: metal(rr(2300, 2700), [1, 1.63, 2.49, 3.1], 0.018) },
    { t: t + rr(0.04, 0.05), amp: 0.14, strike: 0.6, parts: metal(rr(2000, 2400), [1, 1.7, 2.6], 0.02) },
  ]);
  g.ch(g.buf(mb), g.hp(1000), bus);
  nhit(g, t, { color: 'pink', pre: [g.bp(1400, 0.6)], env: swell(t, t + 0.012, 0.11, 0.2), dur: 0.55 });
  echo(g, bus, [
    [rr(0.03, 0.04), 2500, 0.25],
    [rr(0.08, 0.1), 1500, 0.15],
  ]);
});

def('pistolReload', { dur: 1.3, variants: 2, var: 0.03, cap: 1, gain: 0.7, reverb: 0.08, prio: 3 }, (g) => {
  const tIn = rr(0.6, 0.66), tPull = rr(0.92, 0.98), tRel = tPull + rr(0.1, 0.13);
  const hits = [
    { t: 0.05, amp: 0.35, strike: 0.6, parts: metal(rr(2900, 3200), [1, 1.55, 2.3], 0.01) }, // mag release
    { t: 0.24, amp: 0.25, strike: 0.5, parts: metal(rr(1600, 1900), [1, 1.7, 2.8], 0.02) }, // mag clears
    { t: tIn + 0.08, amp: 0.8, strike: 0.7, parts: metal(rr(1700, 1900), [1, 1.62, 2.4, 3.3], 0.025) }, // mag seats
    { t: tPull, amp: 0.45, strike: 0.6, parts: metal(rr(2500, 2800), [1, 1.57, 2.6], 0.018) }, // slide back
    { t: tRel, amp: 1.0, strike: 0.8, parts: metal(rr(2100, 2400), [1, 1.6, 2.35, 3.2], 0.03) }, // slide home
  ];
  g.ch(g.buf(modalBuf(g, g.dur, hits)), g.hp(500), g.out);
  // scrapes
  nhit(g, 0.1, { pre: [g.bp(2500, 2)], env: swell(0.1, 0.14, 0.05, 0.3), dur: 0.2 });
  nhit(g, tIn, { pre: [g.bp(2000, 2)], env: swell(tIn, tIn + 0.07, 0.015, 0.35), dur: 0.12 });
  nhit(g, tPull - 0.05, { pre: [g.bp(3200, 2)], env: swell(tPull - 0.05, tPull, 0.012, 0.25), dur: 0.08 });
  // thunks
  tone(g, tIn + 0.08, { f0: 190, f1: 120, sw: 0.02, tau: 0.02, level: 0.6 });
  tone(g, tRel, { f0: 220, f1: 130, sw: 0.02, tau: 0.02, level: 0.7 });
});

def('howitzer', { dur: 5.5, variants: 3, var: 0.03, cap: 2, gain: 1, reverb: 0.3, prio: 3, punch: 2.0, post: rv({ rt: 2.4, mix: 0.12 }) }, (g) => {
  const t = 0.002;
  const bus = g.g(1);
  bus.connect(g.out);
  nhit(g, t, { pre: [g.hp(900)], att: 0.0002, tau: 0.006, level: 1.0, post: [g.ws(3)], dest: bus });
  nhit(g, t, { color: 'pink', pre: [lpSweep(g, 6000, 260, t, 0.6, 0.8), g.pk(450, 0.8, 4)], att: 0.0015, tau: rr(0.13, 0.16), level: 1.4, post: [g.ws(1.8)], dest: bus });
  tone(g, t, { f0: rr(58, 66), f1: 24, sw: 0.45, att: 0.003, tau: 0.45, level: 2.0, post: [g.ws(2)], dest: bus });
  nhit(g, t, { color: 'brown', pre: [g.lp(150)], att: 0.004, tau: 0.6, level: 1.3, dest: bus });
  rumble(g, t + 0.03, { f: 320, f1: 90, att: 0.1, peakAt: t + 0.35, tau: 1.3, level: 0.75, am: 0.4, dest: bus });
  nhit(g, t, { color: 'pink', pre: [g.bp(700, 0.5)], env: swell(t + 0.01, t + 0.12, 0.9, 0.3), dur: 5 });
  g.ch(g.buf(modalBuf(g, 1.5, [{ t: rr(0.22, 0.28), amp: 0.3, strike: 0.3, parts: metal(rr(170, 200), [1, 2.4, 4.3, 6.9], 0.2) }])), g.out);
  echo(g, bus, [
    [rr(0.32, 0.4), 1000, 0.4],
    [rr(0.85, 1.0), 700, 0.3],
    [rr(1.5, 1.7), 500, 0.22],
    [rr(2.3, 2.6), 380, 0.14],
  ]);
});

def('dryFire', { dur: 0.2, variants: 3, var: 0.05, cap: 2, gain: 0.6, reverb: 0.05, prio: 3 }, (g) => {
  const hits = [
    { t: 0.002, amp: 0.8, strike: 0.8, parts: metal(rr(1900, 2300), [1, 1.62, 2.7, 3.9], 0.012) },
    { t: rr(0.025, 0.035), amp: 0.4, strike: 0.7, parts: metal(rr(3000, 3600), [1, 1.5, 2.2], 0.008) },
  ];
  g.ch(g.buf(modalBuf(g, g.dur, hits)), g.hp(600), g.out);
  tone(g, 0.002, { f0: 400, f1: 250, sw: 0.01, tau: 0.008, level: 0.3 });
});

def('switch', { dur: 0.5, variants: 3, var: 0.05, cap: 2, gain: 0.7, reverb: 0.08, prio: 3 }, (g) => {
  const t2 = rr(0.24, 0.27);
  const hits = [
    { t: 0.003, amp: 0.7, strike: 0.5, parts: metal(rr(850, 1000), [1, 1.8, 2.9, 4.4], 0.035) },
    { t: t2, amp: 1.0, strike: 0.6, parts: metal(rr(600, 700), [1, 2.1, 3.3, 5.2], 0.05) },
    { t: t2 + 0.018, amp: 0.35, strike: 0.6, parts: metal(rr(2400, 2900), [1, 1.5], 0.015) },
  ];
  g.ch(g.buf(modalBuf(g, g.dur, hits)), g.hp(150), g.out);
  // traverse servo whir
  const o = g.osc('sawtooth', 180, 0.04, 0.22);
  sweep(o.frequency, 0.04, 180, 320, 0.16);
  g.layer(o, [g.bp(1100, 2)], hold(0.04, 0.03, 0.19, 0.03, 0.16));
  nhit(g, 0.04, { pre: [g.bp(2500, 1.5)], env: hold(0.04, 0.03, 0.19, 0.03, 0.08), dur: 0.2 });
  tone(g, 0.003, { f0: 160, f1: 100, sw: 0.03, tau: 0.03, level: 0.6, post: [g.ws(1.5)] });
  tone(g, t2, { f0: 130, f1: 70, sw: 0.04, tau: 0.05, level: 0.9, post: [g.ws(1.5)] });
});

def('lockTone', { dur: 0.14, variants: 1, var: 0, cap: 3, gain: 0.4, reverb: 0, bus: 'ui', prio: 4 }, (g) => {
  g.layer(g.osc('sine', 1250, 0.001, 0.13), [], hold(0.001, 0.004, 0.1, 0.012, 1));
  g.layer(g.osc('square', 1250, 0.001, 0.13), [g.lp(3500)], hold(0.001, 0.004, 0.1, 0.012, 0.12));
});

// sample-exact periodic 0.5 s tone: usable with play() or loop()
def('lockOnTone', { loopable: true, variants: 1, len: 0.5, var: 0, cap: 2, gain: 0.35, reverb: 0, bus: 'ui', prio: 4, peak: 0.6 }, null);
RECIPES.lockOnTone.js = (sr) => {
  const n = Math.round(sr * 0.5);
  const d = new Float32Array(n);
  // integer cycle counts per 0.5 s: 880 (1760 Hz), 1760 (3520 Hz), 10 (20 Hz warble)
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const warble = 0.82 + 0.18 * Math.sin(TAU * 10 * u);
    d[i] = warble * (Math.sin(TAU * 880 * u) + 0.12 * Math.sin(TAU * 1760 * u));
  }
  return d;
};

// ================================================================================================
// EXPLOSIONS & IMPACTS (3D)
// ================================================================================================

function explosion(g, P) {
  const t = 0.002;
  const bus = g.g(1);
  bus.connect(g.out);
  nhit(g, t, { pre: [g.hp(P.crackHp)], att: 0.0002, tau: P.crackTau, level: P.crack ?? 1, post: [g.ws(3)], dest: bus });
  nhit(g, t, { color: 'pink', pre: [lpSweep(g, P.bf0, P.bf1, t, P.bsw, 0.8), g.pk(P.bpk ?? 500, 0.9, 4)], att: 0.001, tau: P.btau, level: P.blast ?? 1.2, post: [g.ws(1.6)], dest: bus });
  tone(g, t, { f0: P.sf0, f1: P.sf1, sw: P.ssw, att: 0.002, tau: P.stau, level: P.sub ?? 1.6, post: [g.ws(2)], dest: bus });
  nhit(g, t, { color: 'brown', pre: [g.lp(P.bodyLp ?? 220)], att: 0.003, tau: P.bodyTau, level: P.body ?? 1, dest: bus });
  rumble(g, t + 0.02, { f: P.rf, f1: P.rf * 0.4, att: 0.06, peakAt: t + P.rpeak, tau: P.rtau, level: P.rumble, am: 0.4, dest: bus });
  if (P.dirt) {
    // sand / dirt raining back down
    const d = jsBuf(g, (d, sr) =>
      grainsInto(d, sr, { t0: 0.02, t1: P.dirtEnd, rate: (x) => P.dirtRate * Math.exp(-x / P.dirtTau), amp: (x) => Math.min(1, x / 0.05) * Math.exp(-x / (P.dirtTau * 1.3)), gmin: 0.0003, gmax: 0.002, skew: 2 })
    );
    g.ch(g.buf(d), g.hp(900), g.lp(7000), g.g(P.dirt), bus);
  }
  if (P.crackle) {
    // debris crackle / snapping
    const d = jsBuf(g, (d, sr) =>
      grainsInto(d, sr, { t0: 0.04, t1: P.crackleEnd, rate: (x) => 260 * Math.exp(-x / 0.45) + 25 * Math.exp(-x / 1.4), amp: (x) => Math.exp(-x / 1.0), gmin: 0.0002, gmax: 0.0012, skew: 3 })
    );
    g.ch(g.buf(d), g.hp(1400), g.pk(3200, 1, 4), g.g(P.crackle), bus);
  }
  // bright outdoor diffuse tail (not echoed)
  nhit(g, t, { color: 'pink', pre: [g.bp(P.tailF ?? 800, 0.5)], env: swell(t + 0.01, t + 0.09, P.tailTau ?? 0.5, P.tail ?? 0.25), dur: g.dur - t });
  echo(g, bus, P.echoes);
  return bus;
}

def('explosionS', { dur: 2.2, variants: 4, var: 0.06, cap: 6, gain: 0.85, ref: 25, reverb: 0.3, prio: 2, punch: 1.8 }, (g) => {
  explosion(g, {
    crackHp: 1200, crackTau: 0.004,
    bf0: 6000, bf1: rr(450, 600), bsw: 0.25, btau: rr(0.05, 0.07), blast: 1.2, bpk: 700,
    sf0: rr(95, 110), sf1: 40, ssw: 0.15, stau: 0.12, sub: 1.3,
    bodyTau: 0.2, body: 0.8, bodyLp: 260,
    rf: 260, rpeak: 0.08, rtau: 0.45, rumble: 0.35,
    dirt: 0.45, dirtRate: 1800, dirtTau: 0.3, dirtEnd: 1.4,
    tail: 0.2, tailTau: 0.35,
    echoes: [[rr(0.22, 0.3), 900, 0.25]],
  });
});

def('explosionM', { dur: 3.2, variants: 4, var: 0.06, cap: 5, gain: 0.95, ref: 40, reverb: 0.35, prio: 2, punch: 2.0 }, (g) => {
  explosion(g, {
    crackHp: 900, crackTau: 0.006,
    bf0: 5000, bf1: rr(280, 350), bsw: 0.4, btau: rr(0.09, 0.11), blast: 1.3, bpk: 500,
    sf0: rr(66, 76), sf1: 28, ssw: 0.3, stau: 0.3, sub: 1.8,
    bodyTau: 0.4, body: 1.0,
    rf: 260, rpeak: 0.25, rtau: 0.8, rumble: 0.5,
    dirt: 0.4, dirtRate: 2200, dirtTau: 0.45, dirtEnd: 2.0,
    crackle: 0.35, crackleEnd: 1.6,
    tail: 0.25, tailTau: 0.5,
    echoes: [[rr(0.28, 0.34), 900, 0.3], [rr(0.7, 0.82), 600, 0.2]],
  });
});

def('explosionL', { dur: 4.6, variants: 3, var: 0.05, cap: 4, gain: 1, ref: 60, reverb: 0.35, prio: 2, punch: 2.0 }, (g) => {
  const bus = explosion(g, {
    crackHp: 800, crackTau: 0.007,
    bf0: 5000, bf1: rr(220, 280), bsw: 0.5, btau: rr(0.12, 0.14), blast: 1.35, bpk: 420,
    sf0: rr(58, 66), sf1: 24, ssw: 0.4, stau: 0.42, sub: 2.0,
    bodyTau: 0.55, body: 1.2, bodyLp: 180,
    rf: 240, rpeak: 0.35, rtau: 1.3, rumble: 0.7,
    dirt: 0.3, dirtRate: 1600, dirtTau: 0.6, dirtEnd: 2.5,
    crackle: 0.55, crackleEnd: 3.2,
    tail: 0.28, tailTau: 0.7,
    echoes: [[rr(0.36, 0.44), 900, 0.32], [rr(0.95, 1.1), 600, 0.22], [rr(1.7, 1.95), 420, 0.14]],
  });
  // vehicle hull tearing: low metal crunch
  const hits = [{ t: 0.004, amp: 0.5, strike: 0.4, parts: metal(rr(130, 160), [1, 2.35, 4.4, 7.1, 10.5], 0.45) }];
  // secondary cook-off
  const t2 = rr(0.22, 0.45);
  nhit(g, t2, { color: 'pink', pre: [lpSweep(g, 3500, 380, t2, 0.25)], att: 0.002, tau: 0.08, level: 0.9, post: [g.ws(1.5)], dest: bus });
  tone(g, t2, { f0: 80, f1: 35, sw: 0.15, tau: 0.15, level: 1.0, post: [g.ws(1.6)], dest: bus });
  // fireball roar
  nhit(g, 0.03, { color: 'pink', pre: [lpSweep(g, 1400, 300, 0.05, 1.5)], env: swell(0.03, 0.2, 0.7, 0.5), dur: 4, dest: bus });
  // metal debris landing
  const nd = 6 + Math.floor(rnd() * 5);
  for (let k = 0; k < nd; k++) {
    const tk = rr(0.5, 3.3);
    hits.push({ t: tk, amp: rr(0.08, 0.3) * Math.exp(-(tk - 0.5) / 2.5), strike: 0.6, parts: metal(rlog(600, 2600), [1, 1.53, 2.31, 3.1], rr(0.04, 0.12)) });
  }
  g.ch(g.buf(modalBuf(g, g.dur, hits)), g.hp(90), g.g(0.9), bus);
});

def('impactSand', { dur: 0.5, variants: 4, var: 0.08, cap: 8, gain: 0.6, ref: 6, reverb: 0.08, prio: 1 }, (g) => {
  const t = 0.001;
  nhit(g, t, { pre: [g.hp(4000)], att: 0.0001, tau: 0.0007, level: 0.5 });
  nhit(g, t, { color: 'pink', pre: [g.lp(rr(600, 900)), g.pk(300, 1, 4)], att: 0.0008, tau: rr(0.015, 0.022), level: 1.0, post: [g.ws(1.5)] });
  tone(g, t, { f0: 170, f1: 80, sw: 0.02, tau: 0.015, level: 0.5 });
  const d = jsBuf(g, (d, sr) => grainsInto(d, sr, { t0: 0.003, t1: 0.4, rate: (x) => 3000 * Math.exp(-x / 0.08), amp: (x) => Math.exp(-x / 0.09), gmin: 0.0002, gmax: 0.001, skew: 1.5 }));
  g.ch(g.buf(d), g.hp(1800), g.lp(9000), g.g(rr(0.35, 0.5)), g.out);
});

def('impactMetal', { dur: 0.9, variants: 4, var: 0.06, cap: 6, gain: 0.6, ref: 8, reverb: 0.12, prio: 1 }, (g) => {
  const f0 = rr(1400, 2600);
  const hits = [
    {
      t: 0.001,
      amp: 1,
      strike: 1.0,
      strikeTau: 0.0008,
      parts: [[f0, rr(0.25, 0.4), 1], [f0 * 1.47, 0.22, 0.7], [f0 * 2.09, 0.16, 0.5], [f0 * 2.56, 0.12, 0.4], [f0 * 3.14, 0.08, 0.3], [f0 * 4.2, 0.05, 0.2], [f0 * 0.53, 0.1, 0.3]],
    },
  ];
  g.ch(g.buf(modalBuf(g, g.dur, hits)), g.hp(400), g.g(0.8), g.out);
  nhit(g, 0.001, { pre: [g.hp(2500)], tau: 0.0015, level: 0.8, post: [g.ws(2)] });
  tone(g, 0.001, { f0: 320, f1: 200, sw: 0.02, tau: 0.02, level: 0.35 });
});

def('ricochet', { dur: 1.0, variants: 4, var: 0.08, cap: 4, gain: 0.5, ref: 10, reverb: 0.15, prio: 1 }, (g) => {
  const t0 = 0.004;
  const f0 = rr(3200, 4800), f1 = rr(900, 1500), T = rr(0.4, 0.6), am = rr(35, 70), amD = rr(0.3, 0.55);
  const whine = jsBuf(g, (d, sr) => {
    let ph = 0;
    const end = Math.min(d.length, Math.floor((t0 + T * 1.6) * sr));
    const fadeN = Math.floor(0.12 * sr);
    for (let i = Math.floor(t0 * sr); i < end; i++) {
      const x = i / sr - t0;
      const f = f1 + (f0 - f1) * Math.exp(-x / (T * 0.35));
      ph += (TAU * f) / sr;
      let env = Math.min(1, x / 0.006) * Math.exp(-x / (T * 0.5)) * (1 - amD * (0.5 + 0.5 * Math.sin(TAU * am * x)));
      if (i > end - fadeN) env *= (end - i) / fadeN;
      d[i] = env * (Math.sin(ph) + 0.22 * Math.sin(2 * ph + 0.4));
    }
  });
  g.ch(g.buf(whine), g.hp(500), g.g(0.8), g.out);
  const bp = g.bp(f0, 14);
  sweep(bp.frequency, t0, f0, f1 * 1.05, T * 0.9);
  nhit(g, t0, { pre: [bp], env: swell(t0, t0 + 0.01, T * 0.45, 1.6), dur: T * 1.5 });
  nhit(g, 0.001, { pre: [g.hp(3000)], tau: 0.0015, level: 0.7, post: [g.ws(2)] });
});

def('splash', { dur: 1.4, variants: 3, var: 0.08, cap: 6, gain: 0.7, ref: 10, reverb: 0.12, prio: 1 }, (g) => {
  const t = 0.002;
  nhit(g, t, { color: 'pink', pre: [g.bp(rr(700, 1000), 0.7)], att: 0.001, tau: 0.03, level: 0.9 });
  tone(g, t + 0.005, { f0: rr(220, 300), f1: rr(900, 1300), sw: 0.03, att: 0.002, tau: 0.03, level: 0.45 });
  nhit(g, t + 0.01, { pre: [g.hp(1500), g.lp(9000)], env: swell(t + 0.01, t + 0.05, 0.18, 0.55), dur: 1.2 });
  const d = jsBuf(g, (d, sr) => {
    bubblesInto(d, sr, { t0: 0.02, t1: 1.1, rate: (x) => 160 * Math.exp(-x / 0.3), amp: (x) => Math.exp(-x / 0.4), fmin: 900, fmax: 4500 });
    grainsInto(d, sr, { t0: 0.03, t1: 1.0, rate: (x) => 600 * Math.exp(-x / 0.25), amp: (x) => 0.35 * Math.exp(-x / 0.3), skew: 2 });
  });
  g.ch(g.buf(d), g.hp(600), g.g(0.5), g.out);
});

def('splashBig', { dur: 2.8, variants: 3, var: 0.06, cap: 4, gain: 0.85, ref: 30, reverb: 0.2, prio: 2, punch: 1.2 }, (g) => {
  const t = 0.002;
  nhit(g, t, { color: 'brown', pre: [g.lp(320)], att: 0.004, tau: 0.12, level: 1.2 });
  tone(g, t, { f0: 85, f1: 42, sw: 0.1, att: 0.003, tau: 0.1, level: 0.8, post: [g.ws(1.5)] });
  // water column roar, then the column collapsing back down
  nhit(g, t, { color: 'pink', pre: [g.bp(1200, 0.5), g.hp(350)], env: swell(t, t + 0.1, 0.45, 0.8), dur: 2.6 });
  nhit(g, 0.3, { pre: [g.bp(2500, 0.6)], env: swell(0.3, 0.75, 0.55, 0.45), dur: 2.4 });
  const d = jsBuf(g, (d, sr) => {
    bubblesInto(d, sr, { t0: 0.15, t1: 2.6, rate: (x) => 240 * Math.exp(-Math.pow((x - 0.9) / 0.8, 2)), amp: (x) => 0.8, fmin: 700, fmax: 4000 });
    grainsInto(d, sr, { t0: 0.2, t1: 2.5, rate: (x) => 1400 * Math.exp(-Math.pow((x - 0.8) / 0.7, 2)), amp: () => 0.4, skew: 2 });
  });
  g.ch(g.buf(d), g.hp(500), g.g(0.45), g.out);
});

def('bunkerHit', { dur: 2.0, variants: 3, var: 0.05, cap: 3, gain: 1, ref: 15, reverb: 0.2, prio: 3, punch: 2.2 }, (g) => {
  const t = 0.002;
  const bus = g.g(1);
  bus.connect(g.out);
  nhit(g, t, { pre: [g.hp(800)], att: 0.0002, tau: 0.005, level: 1.0, post: [g.ws(3)], dest: bus });
  // concrete crunch (gritty distortion)
  nhit(g, t, { color: 'pink', pre: [g.bp(rr(800, 1100), 0.6)], att: 0.001, tau: 0.05, level: 1.0, post: [g.ws(4, 0.15)], dest: bus });
  tone(g, t, { f0: rr(72, 80), f1: 32, sw: 0.2, att: 0.002, tau: 0.25, level: 2.0, post: [g.ws(2)], dest: bus });
  nhit(g, t, { color: 'brown', pre: [g.lp(150)], att: 0.003, tau: 0.3, level: 1.2, dest: bus });
  // bunker structure boom
  const hits = [{ t: 0.003, amp: 0.35, strike: 0, parts: metal(rr(80, 90), [1, 2.2, 3.6, 5.5], 0.3) }];
  // pebbles & chunks falling
  for (let k = 0; k < 8; k++) {
    const tk = rr(0.15, 1.4);
    hits.push({ t: tk, amp: rr(0.03, 0.12) * Math.exp(-tk / 0.8), strike: 1.5, strikeTau: 0.001, parts: metal(rlog(700, 2200), [1, 1.6], 0.012) });
  }
  g.ch(g.buf(modalBuf(g, g.dur, hits)), g.hp(60), bus);
  const d = jsBuf(g, (d, sr) => grainsInto(d, sr, { t0: 0.05, t1: 1.6, rate: (x) => 900 * Math.exp(-x / 0.35) + 60, amp: (x) => Math.exp(-x / 0.5), gmin: 0.0003, gmax: 0.002, skew: 2.5 }));
  g.ch(g.buf(d), g.bp(2200, 0.5), g.g(0.6), bus);
  // dust sifting down
  nhit(g, 0.1, { pre: [g.hp(3000)], env: swell(0.1, 0.35, 0.5, 0.06), dur: 1.8 });
  echo(g, bus, [[rr(0.05, 0.07), 1500, 0.3], [rr(0.13, 0.17), 900, 0.2]]);
});

def('whizz', { dur: 0.5, variants: 4, var: 0.08, cap: 4, gain: 0.6, ref: 4, reverb: 0.05, prio: 2 }, (g) => {
  const tp = rr(0.06, 0.08);
  // air-rush zip, doppler down
  const bp = g.bp(5200, 2.5);
  bp.frequency.setValueAtTime(5200, 0);
  bp.frequency.setValueAtTime(5200, tp - 0.01);
  bp.frequency.exponentialRampToValueAtTime(1300, tp + 0.2);
  nhit(g, 0.002, { pre: [bp], env: (p) => { p.setValueAtTime(0, 0); p.setValueAtTime(0.02, 0.002); p.exponentialRampToValueAtTime(1.2, tp); p.setTargetAtTime(0, tp, 0.06); }, dur: 0.45 });
  // supersonic snap
  nhit(g, tp, { pre: [g.hp(3500)], att: 0.0001, tau: 0.0006, level: 1.0, post: [g.ws(2.5)] });
  // tonal whistle
  const fc = rr(1600, 2100);
  const w = jsBuf(g, (d, sr) => {
    let ph = 0;
    for (let i = 0; i < d.length; i++) {
      const x = i / sr;
      const f = fc * (1 - 0.32 * Math.tanh((x - tp) / 0.012));
      ph += (TAU * f) / sr;
      d[i] = 0.35 * Math.exp(-Math.abs(x - tp) / (x < tp ? 0.02 : 0.05)) * Math.sin(ph);
    }
  });
  g.ch(g.buf(w), g.out);
});

def('rifle', { dur: 1.2, variants: 4, var: 0.06, cap: 10, gain: 0.75, ref: 20, reverb: 0.25, prio: 1, punch: 1.5, post: rv({ rt: 1.1, mix: 0.12 }) }, (g) => {
  const t = 0.001;
  const bus = g.g(1);
  bus.connect(g.out);
  nhit(g, t, { pre: [g.hp(2500)], att: 0.0001, tau: 0.0012, level: 0.8, post: [g.ws(2)], dest: bus });
  nhit(g, t, { color: 'pink', pre: [lpSweep(g, 6000, 1100, t, 0.04), g.pk(rr(700, 1000), 0.9, 5)], att: 0.0004, tau: rr(0.018, 0.026), level: 1.1, dest: bus });
  tone(g, t, { f0: 170, f1: 70, sw: 0.035, tau: 0.028, level: 0.6, post: [g.ws(1.8)], dest: bus });
  nhit(g, t, { color: 'pink', pre: [g.bp(650, 0.5)], env: swell(t + 0.005, t + 0.05, 0.22, 0.3), dur: 1.1 });
  echo(g, bus, [
    [rr(0.1, 0.14), 1500, 0.3],
    [rr(0.26, 0.34), 900, 0.2],
    [rr(0.5, 0.6), 600, 0.12],
  ]);
});

def('enemyMG', { dur: 0.6, variants: 4, var: 0.05, cap: 10, gain: 0.7, ref: 25, reverb: 0.22, prio: 1, punch: 1.6 }, (g) => {
  const t = 0.001;
  const bus = g.g(1);
  bus.connect(g.out);
  nhit(g, t, { pre: [g.hp(2000)], att: 0.0001, tau: 0.0015, level: 0.8, post: [g.ws(2)], dest: bus });
  nhit(g, t, { color: 'pink', pre: [lpSweep(g, 5500, 900, t, 0.05), g.pk(rr(600, 850), 0.9, 5)], att: 0.0005, tau: rr(0.022, 0.03), level: 1.2, dest: bus });
  tone(g, t, { f0: 135, f1: 58, sw: 0.04, tau: 0.035, level: 0.8, post: [g.ws(2)], dest: bus });
  nhit(g, t, { color: 'pink', pre: [g.bp(600, 0.5)], env: swell(t + 0.004, t + 0.03, 0.1, 0.25), dur: 0.55 });
  echo(g, bus, [[rr(0.08, 0.11), 1300, 0.22], [rr(0.2, 0.25), 800, 0.12]]);
});

def('tankFire', { dur: 3.0, variants: 3, var: 0.05, cap: 3, gain: 1, ref: 60, reverb: 0.35, prio: 2, punch: 1.8, post: rv({ rt: 1.8, mix: 0.12 }) }, (g) => {
  explosion(g, {
    crackHp: 1000, crackTau: 0.004, crack: 0.8,
    bf0: 4500, bf1: rr(300, 380), bsw: 0.35, btau: rr(0.08, 0.1), blast: 1.3, bpk: 600,
    sf0: rr(70, 80), sf1: 30, ssw: 0.25, stau: 0.28, sub: 1.7,
    bodyTau: 0.35, body: 1.0,
    rf: 260, rpeak: 0.2, rtau: 0.75, rumble: 0.55,
    tail: 0.3, tailTau: 0.6,
    echoes: [[rr(0.28, 0.34), 1000, 0.35], [rr(0.75, 0.85), 650, 0.25], [rr(1.4, 1.6), 450, 0.15]],
  });
});

def('rocketLaunch', { dur: 1.5, variants: 3, var: 0.06, cap: 4, gain: 0.8, ref: 30, reverb: 0.2, prio: 1 }, (g) => {
  const t = 0.002;
  nhit(g, t, { pre: [g.hp(1000)], att: 0.0002, tau: 0.006, level: 0.8, post: [g.ws(2)] });
  tone(g, t, { f0: 120, f1: 60, sw: 0.04, tau: 0.03, level: 0.6 });
  nhit(g, t, { pre: [g.bp(2000, 0.7), lpSweep(g, 8000, 1400, t + 0.1, 1.1)], env: ahd(t, 0.01, t + 0.15, 0.3, 1), dur: 1.45 });
  nhit(g, t, { color: 'pink', pre: [g.lp(1000)], env: ahd(t, 0.01, t + 0.15, 0.3, 0.7), dur: 1.45 });
  const cr = jsBuf(g, (d, sr) => grainsInto(d, sr, { t0: t, t1: 1.0, rate: () => 140, amp: (x) => Math.exp(-Math.max(0, x - 0.15) / 0.3), gmin: 0.0002, gmax: 0.0008 }));
  g.ch(g.buf(cr), g.hp(2500), g.g(0.6), g.out);
  const bpW = g.bp(800, 1.5);
  bpW.frequency.setValueAtTime(800, t);
  bpW.frequency.exponentialRampToValueAtTime(3000, t + 0.12);
  bpW.frequency.exponentialRampToValueAtTime(700, t + 0.8);
  nhit(g, t, { pre: [bpW], env: swell(t, t + 0.08, 0.2, 0.9), dur: 1.2 });
});

def('grenadeThrow', { dur: 0.6, variants: 3, var: 0.06, cap: 3, gain: 0.6, ref: 8, reverb: 0.1, prio: 1 }, (g) => {
  const hits = [
    { t: 0.005, amp: 0.4, strike: 0.8, parts: metal(rr(4000, 4500), [1, 1.5], 0.01) }, // pin
    { t: rr(0.07, 0.1), amp: 0.6, strike: 0.5, parts: metal(rr(2500, 2800), [1, 1.52, 2.1], rr(0.06, 0.09)) }, // spoon ping
  ];
  g.ch(g.buf(modalBuf(g, g.dur, hits)), g.hp(800), g.out);
  const bp = g.bp(500, 1.2);
  bp.frequency.setValueAtTime(500, 0.1);
  bp.frequency.exponentialRampToValueAtTime(1500, 0.24);
  bp.frequency.exponentialRampToValueAtTime(700, 0.4);
  nhit(g, 0.1, { color: 'pink', pre: [bp], env: swell(0.1, 0.23, 0.07, 0.9), dur: 0.45 });
});

def('chutePop', { dur: 1.0, variants: 3, var: 0.06, cap: 3, gain: 0.7, ref: 20, reverb: 0.15, prio: 1 }, (g) => {
  const t = rr(0.09, 0.12);
  // fabric rustle building up
  nhit(g, 0.005, { color: 'pink', pre: [g.bp(900, 0.6)], env: swell(0.005, t, 0.02, 0.35), dur: t + 0.1 });
  // canopy catching air: FWUMP
  nhit(g, t, { color: 'brown', pre: [g.lp(500)], att: 0.006, tau: 0.06, level: 1.3, post: [g.ws(1.5)] });
  nhit(g, t, { color: 'pink', pre: [g.bp(420, 1)], att: 0.004, tau: 0.05, level: 0.9 });
  // canopy flutter
  const fl = amNode(g, 0.9, [rr(16, 22)]);
  nhit(g, t + 0.01, { color: 'pink', pre: [g.bp(1200, 0.7), fl], env: swell(t + 0.01, t + 0.04, 0.22, 0.45), dur: 0.8 });
  // suspension lines twang
  tone(g, t + 0.01, { f0: 185, tau: 0.08, level: 0.15 });
  tone(g, t + 0.01, { f0: 372, tau: 0.06, level: 0.08 });
});

def('bombWhistle', { dur: 2.3, variants: 3, var: 0.05, cap: 4, gain: 0.7, ref: 60, reverb: 0.2, prio: 2 }, (g) => {
  const T = rr(1.9, 2.15), f0 = rr(1500, 1900), f1 = rr(480, 620);
  const w = jsBuf(g, (d, sr) => {
    let ph = 0;
    const n = Math.min(d.length, Math.floor(T * sr));
    for (let i = 0; i < n; i++) {
      const x = i / sr, u = x / T;
      const f = f0 * Math.pow(f1 / f0, Math.pow(u, 1.25)) * (1 + 0.006 * Math.sin(TAU * 5.5 * x));
      ph += (TAU * f) / sr;
      const amp = (0.12 + 0.88 * Math.pow(u, 1.5)) * Math.min(1, x / 0.25) * Math.min(1, (T - x) / 0.05);
      d[i] = amp * (Math.sin(ph) + 0.18 * Math.sin(2 * ph) + 0.06 * Math.sin(3 * ph));
    }
  });
  g.ch(g.buf(w), g.out);
  const bp = g.bp(f0, 6);
  sweep(bp.frequency, 0, f0, f1, T);
  const env = (p) => {
    p.setValueAtTime(0, 0);
    p.linearRampToValueAtTime(0.1, 0.25);
    p.linearRampToValueAtTime(1.4, T - 0.05);
    p.linearRampToValueAtTime(0, T);
  };
  nhit(g, 0, { pre: [bp], env, dur: T });
});

// ================================================================================================
// MISC 3D ONE-SHOTS
// ================================================================================================

def('soldierDie', { dur: 0.9, variants: 4, var: 0.06, cap: 4, gain: 0.45, ref: 10, reverb: 0.2, prio: 1 }, (g, v) => {
  const K = [
    { p: [125, 150, 95], d: 0.28, F0: [600, 1040, 2250], F1: [500, 900, 2200], br: 0.25, att: 0.015 }, // "ugh"
    { p: [210, 250, 150], d: 0.55, F0: [750, 1250, 2600], F1: [600, 1000, 2400], br: 0.35, att: 0.03 }, // "aah"
    { p: [180, 270, 165], d: 0.45, F0: [700, 1150, 2500], F1: [450, 850, 2300], br: 0.4, att: 0.02 }, // "argh"
    { p: [160, 190, 110], d: 0.35, F0: [650, 1100, 2450], F1: [550, 950, 2300], br: 0.55, att: 0.01 }, // breathy grunt
  ][v % 4];
  const t = 0.01, D = K.d * rr(0.9, 1.1), m = rr(0.92, 1.08);
  const src = g.osc('sawtooth', K.p[0] * m, t, D + 0.1);
  src.frequency.setValueAtTime(K.p[0] * m, t);
  src.frequency.linearRampToValueAtTime(K.p[1] * m, t + D * 0.25);
  src.frequency.linearRampToValueAtTime(K.p[2] * m, t + D);
  const lfo = g.osc('sine', rr(22, 32), t, D + 0.1);
  const lg = g.g(K.p[1] * m * 0.025);
  lfo.connect(lg);
  lg.connect(src.frequency);
  const voice = g.g(1);
  g.ch(src, g.lp(3500), voice);
  g.ch(g.noise('white', t, D + 0.1), g.g(K.br), voice);
  const env = g.g(0);
  env.gain.setValueAtTime(0, 0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(1, t + K.att);
  env.gain.linearRampToValueAtTime(0.75, t + D * 0.6);
  env.gain.linearRampToValueAtTime(0, t + D);
  const Qs = [7, 9, 11], G = [1, 0.5, 0.22];
  for (let i = 0; i < 3; i++) {
    const bp = g.bp(K.F0[i], Qs[i]);
    bp.frequency.setValueAtTime(K.F0[i], t);
    bp.frequency.linearRampToValueAtTime(K.F1[i], t + D);
    g.ch(voice, bp, g.g(G[i] * 3), env);
  }
  g.ch(voice, g.lp(300), g.g(0.3), env);
  g.ch(env, g.ws(1.4), g.out);
});

def('debris', { dur: 1.8, variants: 3, var: 0.08, cap: 4, gain: 0.6, ref: 15, reverb: 0.15, prio: 1 }, (g) => {
  const hits = [];
  const n = 5 + Math.floor(rnd() * 5);
  for (let k = 0; k < n; k++) {
    const tk = k === 0 ? 0.01 : rr(0.05, 1.4);
    const a = rr(0.25, 1) * Math.exp(-tk / 1.2);
    hits.push({ t: tk, amp: a, strike: 0.7, parts: metal(rlog(380, 1800), [1, 1.49, 2.26, 3.03, 3.9], rr(0.06, 0.25)) });
    // thud into the sand
    tone(g, tk, { f0: rr(120, 180), f1: 70, sw: 0.02, tau: 0.02, level: a * 0.6 });
    nhit(g, tk, { color: 'pink', pre: [g.lp(700)], tau: 0.015, level: a * 0.5 });
  }
  g.ch(g.buf(modalBuf(g, g.dur, hits)), g.hp(250), g.g(0.7), g.out);
  const d = jsBuf(g, (d, sr) => grainsInto(d, sr, { t0: 0.02, t1: 1.5, rate: (x) => 300 * Math.exp(-x / 0.5), amp: (x) => Math.exp(-x / 0.6), gmin: 0.0003, gmax: 0.0015, skew: 2.5 }));
  g.ch(g.buf(d), g.bp(2800, 0.7), g.g(0.35), g.out);
});

def('rampDrop', { dur: 2.2, variants: 3, var: 0.05, cap: 3, gain: 0.9, ref: 30, reverb: 0.2, prio: 2, punch: 1.5 }, (g) => {
  const ts = rr(0.45, 0.55);
  // chain / winch rattle while the ramp falls
  const rattle = [];
  for (let t = 0.01; t < ts - 0.02; t += rr(0.02, 0.045)) rattle.push({ t, amp: rr(0.08, 0.2), strike: 0.5, parts: metal(rlog(1500, 3200), [1, 1.45, 2.2], 0.02) });
  g.ch(g.buf(modalBuf(g, g.dur, rattle)), g.hp(900), g.out);
  // hinge creak
  const cr = g.osc('sawtooth', rr(80, 100), 0.02, ts);
  const lf = g.osc('sine', rr(9, 14), 0.02, ts);
  const lfg = g.g(12);
  lf.connect(lfg);
  lfg.connect(cr.frequency);
  g.layer(cr, [g.bp(rr(850, 1100), 4)], hold(0.02, 0.06, ts - 0.1, 0.08, 0.2));
  // slam: huge steel plate hitting the beach
  const slam = [{ t: ts, amp: 1, strike: 0.6, strikeTau: 0.002, parts: metal(rr(52, 60), [1, 1.75, 2.9, 4.3, 6.8, 10.5, 16], 0.6) }];
  slam.push({ t: ts, amp: 0.25, strike: 0, parts: metal(rr(1150, 1350), [1, 1.46, 2.08], 0.35) });
  g.ch(g.buf(modalBuf(g, g.dur, slam)), g.g(0.8), g.out);
  tone(g, ts, { f0: 72, f1: 34, sw: 0.12, att: 0.002, tau: 0.16, level: 1.4, post: [g.ws(1.8)] });
  nhit(g, ts, { color: 'brown', pre: [g.lp(220)], att: 0.003, tau: 0.2, level: 1.0 });
  nhit(g, ts, { color: 'pink', pre: [g.bp(1500, 0.6)], att: 0.003, tau: 0.18, level: 0.45 });
  const d = jsBuf(g, (d, sr) => bubblesInto(d, sr, { t0: ts + 0.02, t1: ts + 1.2, rate: (x) => 120 * Math.exp(-(x - ts) / 0.35), amp: () => 0.5, fmin: 900, fmax: 3500 }));
  g.ch(g.buf(d), g.hp(600), g.g(0.35), g.out);
});

// ================================================================================================
// 3D LOOPS (sample-exact periodic)
// ================================================================================================

/** Periodic pulse train: count pulses per loop; shape(x seconds since pulse, k) -> sample. */
function pulseTrain(g, count, len, shape) {
  const d = new Float32Array(g.L);
  const per = g.L / count;
  const n = Math.ceil(len * g.sr);
  for (let k = 0; k < count; k++) {
    const i0 = Math.round(k * per);
    const s = shape.bind(null);
    for (let j = 0; j < n; j++) {
      const i = (i0 + j) % g.L;
      d[i] += s(j / g.sr, k);
    }
  }
  return toBuf(d, g.sr);
}

def('jetLoop', { loop: true, len: 3, ref: 70, gain: 1, reverb: 0.15, cap: 4 }, (g) => {
  g.ch(g.lnoise(), g.lp(2600, 0.6), g.pk(320, 0.8, 5), g.g(1.0), g.out); // main roar
  g.ch(g.lnoise(), g.lp(170), g.lp(170), g.g(3.5), g.out); // low rumble
  g.ch(g.lnoise(), g.bp(900, 0.6), amNode(g, 0.6, [g.pf(1.7), g.pf(3.3), g.pf(0.67)]), g.g(0.7), g.out); // turbulence
  g.ch(g.lnoise(), g.hp(5000), g.g(0.25), g.out); // hiss
  const wob = amNode(g, 0.3, [g.pf(0.67), g.pf(2.3)]);
  wob.connect(g.out);
  for (const [f, a] of [[2870, 0.05], [5740, 0.018], [1180, 0.03], [4310, 0.012]]) g.ch(g.osc('sine', g.pf(f)), g.g(a), wob);
  const cr = jsBuf({ len: g.L, sr: g.sr }, (d, sr) => grainsInto(d, sr, { t0: 0, t1: g.Ls, rate: () => 70, amp: () => 1, gmin: 0.0003, gmax: 0.0012, skew: 3, wrap: true }));
  g.ch(g.buf(cr, 0, { loop: true }), g.lp(4500), g.hp(300), g.g(1.4), g.out); // exhaust crackle
});

function rotorLoop(g, o) {
  const slap = pulseTrain(g, o.blades, 0.09, (x, k) => {
    const a = (k % 2 ? o.alt : 1) * (0.95 + 0.1 * Math.sin(k * 2.1));
    const thump = Math.sin(TAU * o.thumpF * x) * Math.exp(-x / o.thumpTau);
    const crack = (rnd() * 2 - 1) * Math.exp(-x / o.crackTau);
    return a * (thump + crack * o.crack) * (x < 0.0008 ? x / 0.0008 : 1);
  });
  g.ch(g.buf(slap, 0, { loop: true }), g.lp(o.slapLp), g.pk(o.thumpF * 1.2, 1, 4), g.g(o.slap), g.ws(1.5), g.out);
  // rotor wash, swelling with every blade pass
  const per = g.L / o.blades;
  const wash = new Float32Array(g.L);
  for (let i = 0; i < g.L; i++) wash[i] = (rnd() * 2 - 1) * (0.35 + 0.65 * Math.exp(-((i % per) / per) * 5));
  g.ch(g.buf(toBuf(wash, g.sr), 0, { loop: true }), g.lp(o.washLp), g.hp(70), g.g(o.wash), g.out);
  g.ch(g.lnoise(), g.lp(o.rumbleLp), g.lp(o.rumbleLp), g.g(o.rumble), g.out);
  // tail rotor buzz
  g.ch(g.osc('sawtooth', g.pf(o.tail)), g.lp(600), g.g(o.tailA), g.out);
  // turbine whine(s) + gearbox hum
  const wob = amNode(g, 0.25, [g.pf(0.8), g.pf(1.6)]);
  wob.connect(g.out);
  for (const [f, a] of o.whine) g.ch(g.osc('sine', g.pf(f)), g.g(a), wob);
}

def('cobraLoop', { loop: true, len: 2.5, ref: 45, gain: 1, reverb: 0.12, cap: 4 }, (g) => {
  // AH-1: 2-blade main rotor, 27 slaps in 2.5 s = 10.8 Hz
  rotorLoop(g, {
    blades: 27, alt: 0.8, thumpF: 88, thumpTau: 0.013, crackTau: 0.0035, crack: 0.55, slapLp: 1800, slap: 1.0,
    washLp: 900, wash: 0.5, rumbleLp: 130, rumble: 2.2, tail: 53.6, tailA: 0.05,
    whine: [[1620, 0.03], [3240, 0.012], [6480, 0.006], [210, 0.025]],
  });
});

def('ch53Loop', { loop: true, len: 2, ref: 55, gain: 1, reverb: 0.12, cap: 3 }, (g) => {
  // CH-53: 7 blades, 42 slaps in 2 s = 21 Hz; heavier, less impulsive
  rotorLoop(g, {
    blades: 42, alt: 0.92, thumpF: 64, thumpTau: 0.02, crackTau: 0.004, crack: 0.25, slapLp: 900, slap: 0.9,
    washLp: 650, wash: 0.55, rumbleLp: 100, rumble: 3.5, tail: 46.5, tailA: 0.06,
    whine: [[1180, 0.025], [1183, 0.025], [2360, 0.01], [520, 0.015]],
  });
});

function trackedLoop(g, o) {
  // diesel exhaust pulses with per-cylinder jitter
  const jit = Array.from({ length: o.cyl }, () => rr(0.7, 1.15));
  const eng = pulseTrain(g, o.fires, 0.05, (x, k) => {
    const a = jit[k % o.cyl];
    return a * (Math.sin(TAU * o.pulseF * x) * Math.exp(-x / 0.008) + (rnd() * 2 - 1) * 0.5 * Math.exp(-x / 0.003));
  });
  g.ch(g.buf(eng, 0, { loop: true }), g.lp(o.engLp), g.ws(2.2), g.pk(o.pulseF, 1, 4), g.g(o.eng), g.out);
  // valve / mechanical clatter riding on the firing rhythm
  const clat = g.g(0);
  g.ch(g.buf(eng, 0, { loop: true }), g.g(o.clatter * 6), clat.gain);
  g.ch(g.lnoise(), g.bp(1600, 1), clat, g.out);
  // track link clanks against the sprockets
  const hits = [];
  const n = o.clanks;
  for (let k = 0; k < n; k++) hits.push({ t: (k / n) * g.Ls + rr(-0.006, 0.006) + 0.01, amp: rr(0.5, 1), strike: 0.8, parts: metal(rr(o.clankF * 0.85, o.clankF * 1.15), [1, 1.8, 2.9, 4.1], 0.03) });
  const cl = new Float32Array(g.L);
  modalInto(cl, g.sr, hits, true);
  g.ch(g.buf(toBuf(cl, g.sr), 0, { loop: true }), g.hp(250), g.g(o.clank), g.out);
  // track squeal
  for (const [f, q, a] of o.squeal) g.ch(g.lnoise(), g.bp(f, q), amNode(g, 0.95, [g.pf(0.34), g.pf(1.0), g.pf(2.33)]), g.g(a), g.out);
  // ground rumble + engine whine
  g.ch(g.lnoise(), g.lp(75), g.lp(75), g.g(o.rumble), g.out);
  g.ch(g.osc('sine', g.pf(o.whine)), g.g(0.02), g.out);
}

def('tankLoop', { loop: true, len: 3, ref: 30, gain: 1, reverb: 0.1, cap: 6 }, (g) => {
  trackedLoop(g, {
    cyl: 6, fires: 108, pulseF: 85, engLp: 480, eng: 1.2, clatter: 0.12,
    clanks: 27, clankF: 720, clank: 0.35,
    squeal: [[2300, 28, 0.9], [3550, 34, 0.6]],
    rumble: 3.0, whine: 820,
  });
});

def('apcLoop', { loop: true, len: 3, ref: 25, gain: 1, reverb: 0.1, cap: 6 }, (g) => {
  trackedLoop(g, {
    cyl: 8, fires: 156, pulseF: 120, engLp: 700, eng: 1.0, clatter: 0.15,
    clanks: 36, clankF: 1100, clank: 0.28,
    squeal: [[2900, 30, 0.5]],
    rumble: 2.2, whine: 1150,
  });
});

def('lctLoop', { loop: true, len: 4, ref: 35, gain: 1, reverb: 0.1, cap: 6 }, (g) => {
  // slow 2-stroke marine diesel
  const eng = pulseTrain(g, 96, 0.06, (x, k) => (k % 2 ? 0.85 : 1) * (Math.sin(TAU * 62 * x) * Math.exp(-x / 0.012) + (rnd() * 2 - 1) * 0.6 * Math.exp(-x / 0.004)));
  g.ch(g.buf(eng, 0, { loop: true }), g.lp(320), g.ws(2), g.pk(62, 1, 4), g.g(1.3), g.out);
  g.ch(g.buf(eng, 0, { loop: true }), g.bp(900, 0.8), g.g(0.12), g.out); // exhaust burble
  // bow wash with swell
  g.ch(g.lnoise(), g.bp(750, 0.5), g.hp(250), amNode(g, 0.7, [g.pf(0.25), g.pf(0.5), g.pf(1.25)]), g.g(0.9), g.out);
  g.ch(g.lnoise(), g.bp(220, 1), amNode(g, 0.5, [g.pf(4)]), g.g(0.5), g.out); // prop churn
  // hull slaps
  const slaps = [];
  for (let k = 0; k < 3; k++) slaps.push({ t: (k + rr(0.1, 0.8)) * (g.Ls / 3), amp: rr(0.5, 1), strike: 0, parts: [[rr(55, 70), 0.08, 1], [rr(140, 170), 0.04, 0.4]] });
  const sl = new Float32Array(g.L);
  modalInto(sl, g.sr, slaps, true);
  bubblesInto(sl, g.sr, { t0: 0, t1: g.Ls, rate: () => 25, amp: () => 0.25, fmin: 800, fmax: 3000, wrap: true });
  g.ch(g.buf(toBuf(sl, g.sr), 0, { loop: true }), g.g(0.8), g.out);
  g.ch(g.lnoise(), g.lp(90), g.g(2), g.out);
});

def('b52Loop', { loop: true, len: 4, ref: 150, gain: 1, reverb: 0.2, cap: 2 }, (g) => {
  g.ch(g.lnoise(), g.lp(110), g.lp(110), g.g(4.5), g.out);
  g.ch(g.lnoise(), g.lp(650), amNode(g, 0.3, [g.pf(0.25), g.pf(0.5), g.pf(0.75)]), g.g(0.8), g.out);
  g.ch(g.lnoise(), g.bp(1400, 0.7), amNode(g, 0.4, [g.pf(0.5), g.pf(1.25)]), g.g(0.12), g.out);
  // 8 slightly detuned engines beating against each other
  for (let k = 0; k < 8; k++) g.ch(g.osc('sine', g.pf(405 + k * 3.25 + rr(-1, 1))), g.g(0.01), g.out);
  g.ch(g.osc('sawtooth', g.pf(96)), g.lp(300), g.g(0.03), g.out);
});

def('propLoop', { loop: true, len: 4, ref: 60, gain: 1, reverb: 0.15, cap: 2 }, (g) => {
  // four turboprops, blade-pass ~68 Hz, detuned by 0.25 Hz steps -> slow "wub-wub" beating
  for (const f of [67.75, 68, 68.25, 68.5]) {
    const o = g.osc('sawtooth', g.pf(f));
    g.ch(o, g.lp(950, 0.9), g.g(0.12), g.out);
  }
  g.ch(g.lnoise(), g.lp(500), g.g(0.5), g.out);
  g.ch(g.lnoise(), g.bp(1400, 0.8), g.g(0.12), g.out);
  g.ch(g.lnoise(), g.lp(140), g.g(1.6), g.out);
  for (const f of [1650.25, 1651.5]) g.ch(g.osc('sine', g.pf(f)), g.g(0.018), g.out);
});

def('missileLoop', { loop: true, len: 2, ref: 20, gain: 1, reverb: 0.1, cap: 6 }, (g) => {
  const fl = amNode(g, 0.2, [g.pf(7.5), g.pf(13)]);
  fl.connect(g.out);
  g.ch(g.lnoise(), g.bp(1000, 0.6), g.g(1), fl);
  g.ch(g.lnoise(), g.lp(400), g.g(1.2), fl);
  g.ch(g.lnoise(), g.hp(3500), g.g(0.3), fl);
  const cr = jsBuf({ len: g.L, sr: g.sr }, (d, sr) => grainsInto(d, sr, { t0: 0, t1: g.Ls, rate: () => 200, amp: () => 1, gmin: 0.0002, gmax: 0.0008, wrap: true }));
  g.ch(g.buf(cr, 0, { loop: true }), g.hp(1500), g.g(1.0), g.out);
});

def('fireLoop', { loop: true, len: 4, ref: 10, gain: 1, reverb: 0.1, cap: 6 }, (g) => {
  g.ch(g.lnoise(), g.lp(250), amNode(g, 0.5, [g.pf(0.5), g.pf(0.75), g.pf(1.25)]), g.g(2.2), g.out);
  g.ch(g.lnoise(), g.bp(500, 0.7), amNode(g, 0.6, [g.pf(3.25), g.pf(2)]), g.g(0.45), g.out);
  const d = new Float32Array(g.L);
  grainsInto(d, g.sr, { t0: 0, t1: g.Ls, rate: () => 28, amp: () => 1, gmin: 0.0003, gmax: 0.0015, skew: 2.5, wrap: true });
  const pops = [];
  for (let k = 0; k < 12; k++) pops.push({ t: rr(0, g.Ls), amp: rr(0.1, 0.4), strike: 1, strikeTau: 0.0015, parts: [[rr(700, 1500), rr(0.008, 0.02), 1]] });
  modalInto(d, g.sr, pops, true);
  g.ch(g.buf(toBuf(d, g.sr), 0, { loop: true }), g.bp(2800, 0.5), g.g(1.2), g.out);
  g.ch(g.lnoise(), g.hp(5000), g.g(0.05), g.out);
});

// ================================================================================================
// AMBIENCE (internal names used by AudioEngine.startAmbience)
// ================================================================================================

def('ambSurf', { loop: true, len: 4, gain: 1, reverb: 0, bus: 'ambience' }, (g) => {
  // one wave cycle per loop (the engine plays two decorrelated copies at different rates)
  const env = new Float32Array(g.L);
  const fizz = new Float32Array(g.L);
  const crash = 0.9;
  // wave envelope at phase u (s): smooth rise to the crash, then exponential wash-out; the previous
  // cycle's tail is added so the envelope is periodic
  const wave = (x) => {
    const u = ((x % g.Ls) + g.Ls) % g.Ls;
    const cur = u < crash ? Math.pow(Math.sin((Math.PI / 2) * (u / crash)), 2) : Math.exp(-(u - crash) / 1.0);
    return cur + Math.exp(-(u + g.Ls - crash) / 1.0);
  };
  for (let i = 0; i < g.L; i++) {
    const x = i / g.sr;
    env[i] = 0.3 + 0.7 * wave(x);
    fizz[i] = 0.1 + 0.9 * wave(x - 0.4); // foam hiss trails the crash
  }
  const ea = g.g(0);
  g.buf(toBuf(env, g.sr), 0, { loop: true }).connect(ea.gain);
  g.ch(g.lnoise(), g.lp(1400), g.hp(90), ea, g.g(1), g.out);
  const eb = g.g(0);
  g.buf(toBuf(fizz, g.sr), 0, { loop: true }).connect(eb.gain);
  g.ch(g.lnoise(), g.hp(2500), eb, g.g(0.3), g.out);
  g.ch(g.lnoise(), g.lp(100), g.g(1.5), g.out);
});

def('ambWind', { loop: true, len: 4, gain: 1, reverb: 0, bus: 'ambience' }, (g) => {
  g.ch(g.lnoise(), g.bp(380, 0.5), amNode(g, 0.6, [g.pf(0.25), g.pf(0.5), g.pf(0.75)]), g.g(1), g.out);
  g.ch(g.lnoise(), g.bp(1150, 14), amNode(g, 0.8, [g.pf(0.5), g.pf(1.25)]), g.g(0.6), g.out);
  g.ch(g.lnoise(), g.lp(60), g.g(1.2), g.out);
});

def('ambBoom', { dur: 3.6, variants: 3, var: 0.1, cap: 3, gain: 0.8, reverb: 0, bus: 'ambience', prio: 0, post: rv({ rt: 2.5, mix: 0.3, damp: 0.6 }) }, (g) => {
  const bus = g.g(1);
  bus.connect(g.out);
  const t = 0.01;
  tone(g, t, { f0: rr(52, 60), f1: 28, sw: 0.3, att: 0.01, tau: 0.35, level: 1.2, post: [g.ws(1.5)], dest: bus });
  nhit(g, t, { color: 'brown', pre: [g.lp(170)], att: 0.015, tau: 0.5, level: 1.0, dest: bus });
  nhit(g, t, { color: 'pink', pre: [g.lp(700)], att: 0.005, tau: 0.05, level: 0.5, dest: bus });
  rumble(g, t, { f: 230, att: 0.1, tau: 0.9, level: 0.6, am: 0.5, dest: bus });
  echo(g, bus, [[rr(0.4, 0.5), 260, 0.4], [rr(1.1, 1.3), 200, 0.3], [rr(1.9, 2.1), 160, 0.2]]);
});

// ================================================================================================
// UI / ALERTS / MUSICAL STINGS (2D)
// ================================================================================================

function brassNote(g, t, f, dur, { level = 0.25, bright = 2600, dest = g.out, voices = 3 } = {}) {
  const mix = g.g(1 / voices);
  const oscs = [];
  for (let i = 0; i < voices; i++) {
    const o = g.osc('sawtooth', f, t, dur + 0.3);
    o.detune.value = (i - (voices - 1) / 2) * 7 + rr(-2, 2);
    o.connect(mix);
    oscs.push(o);
  }
  const vib = g.osc('sine', rr(4.8, 5.6), t, dur + 0.3);
  const vg = g.g(0);
  vib.connect(vg);
  for (const o of oscs) vg.connect(o.frequency);
  vg.gain.setValueAtTime(0, t + 0.15);
  vg.gain.linearRampToValueAtTime(f * 0.006, t + 0.45);
  const lp = g.lp(250, 1.1);
  lp.frequency.setValueAtTime(250, t);
  lp.frequency.linearRampToValueAtTime(bright, t + 0.04);
  lp.frequency.linearRampToValueAtTime(bright * 0.55, t + 0.2);
  lp.frequency.setValueAtTime(bright * 0.55, t + dur);
  lp.frequency.linearRampToValueAtTime(300, t + dur + 0.15);
  const env = g.g(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(level, t + 0.03);
  env.gain.linearRampToValueAtTime(level * 0.72, t + 0.18);
  env.gain.setValueAtTime(level * 0.72, t + dur);
  env.gain.linearRampToValueAtTime(0, t + dur + 0.18);
  g.ch(mix, lp, env, dest);
}
function snare(g, t, level = 0.5) {
  nhit(g, t, { pre: [g.hp(1200), g.pk(3500, 0.8, 4)], att: 0.0005, tau: 0.06, level });
  tone(g, t, { type: 'triangle', f0: 220, f1: 170, sw: 0.03, tau: 0.04, level: level * 0.6 });
}
function kick(g, t, level = 1) {
  tone(g, t, { f0: 120, f1: 45, sw: 0.12, att: 0.002, tau: 0.18, level, post: [g.ws(1.5)] });
  nhit(g, t, { color: 'brown', pre: [g.lp(300)], tau: 0.03, level: level * 0.5 });
}
function timp(g, t, f, level = 0.8) {
  tone(g, t, { f0: f * 1.05, f1: f, sw: 0.06, att: 0.003, tau: 0.5, level });
  tone(g, t, { f0: f * 1.5, att: 0.003, tau: 0.25, level: level * 0.35 });
  tone(g, t, { f0: f * 2, att: 0.003, tau: 0.18, level: level * 0.2 });
  nhit(g, t, { color: 'pink', pre: [g.lp(700)], tau: 0.04, level: level * 0.4 });
}
function cymbal(g, t, level = 0.3, tau = 1.0) {
  nhit(g, t, { pre: [g.hp(4500), g.pk(7500, 1, 5)], att: 0.002, tau, level });
}
const N = { C2: 65.41, C3: 130.81, Eb3: 155.56, F3: 174.61, G3: 196, C4: 261.63, D4: 293.66, E4: 329.63, G4: 392, C5: 523.25, E5: 659.25, G5: 783.99, C6: 1046.5 };

def('levelStart', { dur: 2.4, variants: 1, var: 0, cap: 1, gain: 0.7, reverb: 0, bus: 'ui', prio: 4, post: rv({ rt: 1.8, mix: 0.3 }) }, (g) => {
  for (let i = 0; i < 6; i++) snare(g, 0.02 + i * 0.045, 0.12 + i * 0.05);
  const b = 0.3;
  [N.G4, N.C5, N.E5].forEach((f, i) => {
    brassNote(g, b + i * 0.16, f, 0.12, { level: 0.3 });
    snare(g, b + i * 0.16, 0.5);
  });
  const h = b + 0.5;
  brassNote(g, h, N.G5, 1.0, { level: 0.34, bright: 3200 });
  brassNote(g, h, N.C5, 1.0, { level: 0.22 });
  brassNote(g, h, N.E4, 1.0, { level: 0.2, bright: 1800 });
  brassNote(g, h, N.C3, 1.0, { level: 0.2, bright: 1200 });
  kick(g, h, 1.0);
  snare(g, h, 0.6);
  cymbal(g, h, 0.3, 0.8);
});

def('levelComplete', { dur: 3.2, variants: 1, var: 0, cap: 1, gain: 0.7, reverb: 0, bus: 'ui', prio: 4, post: rv({ rt: 1.8, mix: 0.3 }) }, (g) => {
  const seq = [[N.G4, 0.0, 0.1], [N.C5, 0.12, 0.1], [N.E5, 0.24, 0.1], [N.G5, 0.36, 0.2], [N.E5, 0.62, 0.1], [N.G5, 0.76, 0.1]];
  for (const [f, t, d] of seq) {
    brassNote(g, t + 0.02, f, d, { level: 0.3 });
    snare(g, t + 0.02, 0.4);
  }
  const h = 0.94;
  brassNote(g, h, N.C6, 1.3, { level: 0.3, bright: 3600 });
  brassNote(g, h, N.G5, 1.3, { level: 0.22 });
  brassNote(g, h, N.E5, 1.3, { level: 0.2 });
  brassNote(g, h, N.C4, 1.3, { level: 0.22, bright: 1500 });
  brassNote(g, h, N.C3, 1.3, { level: 0.2, bright: 1000 });
  kick(g, h, 1.0);
  timp(g, h, 65.4, 0.8);
  cymbal(g, h, 0.35, 1.2);
  for (let i = 0; i < 8; i++) snare(g, h + 0.9 + i * 0.03, 0.1 + i * 0.03);
  kick(g, h + 1.15, 0.8);
  cymbal(g, h + 1.15, 0.2, 0.6);
});

def('gameOver', { dur: 3.8, variants: 1, var: 0, cap: 1, gain: 0.75, reverb: 0, bus: 'ui', prio: 4, post: rv({ rt: 2.2, mix: 0.35 }) }, (g) => {
  brassNote(g, 0.02, N.G3, 0.28, { level: 0.3, bright: 1400 });
  brassNote(g, 0.02, N.D4, 0.28, { level: 0.22, bright: 1400 });
  timp(g, 0.02, 98, 0.8);
  brassNote(g, 0.55, N.F3, 0.28, { level: 0.3, bright: 1300 });
  brassNote(g, 0.55, N.C4, 0.28, { level: 0.22, bright: 1300 });
  timp(g, 0.55, 87.3, 0.8);
  const h = 1.1;
  for (const [f, l] of [[N.C3, 0.3], [N.Eb3, 0.24], [N.G3, 0.22], [N.C2, 0.26], [N.C4, 0.14]]) brassNote(g, h, f, 1.6, { level: l, bright: 1100 });
  timp(g, h, 65.4, 1.0);
  kick(g, h, 1.0);
  tone(g, h, { f0: 55, f1: 32, sw: 0.4, att: 0.005, tau: 0.8, level: 0.8 });
  cymbal(g, h, 0.12, 1.5);
});

def('siren', { dur: 6.6, variants: 1, var: 0, cap: 1, gain: 0.55, reverb: 0, bus: 'ui', prio: 4, post: rv({ rt: 2.6, mix: 0.3, damp: 0.5 }) }, (g) => {
  const T = 6.2;
  const n = 620;
  const fa = new Float32Array(n), fb = new Float32Array(n), amp = new Float32Array(n);
  const fmin = 150, fmax = 470;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * T;
    let f;
    if (x < 3.3) f = fmin + (fmax - fmin) * (1 - Math.exp(-x / 0.75)) + 6 * Math.sin(TAU * 0.9 * x) * Math.min(1, x / 2);
    else {
      const f33 = fmin + (fmax - fmin) * (1 - Math.exp(-3.3 / 0.75));
      f = 110 + (f33 - 110) * Math.exp(-(x - 3.3) / 1.4);
    }
    fa[i] = f;
    fb[i] = f * 1.2;
    const s = Math.min(1, Math.max(0, (f - 110) / (fmax - 110)));
    amp[i] = Math.pow(s, 0.8) * Math.min(1, x / 0.3) * Math.min(1, (T - x) / 0.4);
  }
  const mix = g.g(1);
  const a = g.osc('sawtooth', fmin, 0, T);
  a.frequency.setValueCurveAtTime(fa, 0, T);
  const b = g.osc('square', fmin * 1.2, 0, T);
  b.frequency.setValueCurveAtTime(fb, 0, T);
  g.ch(a, g.g(0.6), mix);
  g.ch(b, g.g(0.35), mix);
  const env = g.g(0);
  env.gain.setValueCurveAtTime(amp, 0, T);
  g.ch(mix, g.lp(1800, 0.8), g.pk(900, 1, 3), env, g.ws(1.3), g.out);
  echo(g, env, [[0.32, 1200, 0.3], [0.71, 800, 0.18]]);
});

def('radio', { dur: 0.6, variants: 3, var: 0.02, cap: 2, gain: 0.5, reverb: 0, bus: 'ui', prio: 4 }, (g) => {
  const bus = g.g(1);
  g.ch(bus, g.hp(350), g.lp(3200), g.out);
  // squelch open
  nhit(g, 0.002, { pre: [g.bp(1800, 0.7)], env: hold(0.002, 0.002, 0.11, 0.004, 0.8), dur: 0.13, post: [g.ws(4)], dest: bus });
  const cr = jsBuf(g, (d, sr) => grainsInto(d, sr, { t0: 0.0, t1: 0.52, rate: () => 60, amp: () => 0.6, skew: 2 }));
  g.ch(g.buf(cr), bus);
  // beep
  g.layer(g.osc('square', 1000, 0.15, 0.13), [g.lp(2500)], hold(0.15, 0.004, 0.26, 0.006, 0.35), [], bus);
  // squelch tail
  nhit(g, 0.33, { pre: [g.bp(2000, 0.6)], env: hold(0.33, 0.002, 0.43, 0.003, 0.7), dur: 0.12, post: [g.ws(4)], dest: bus });
});

def('alarm', { dur: 0.46, variants: 1, var: 0, cap: 2, gain: 0.45, reverb: 0, bus: 'ui', prio: 4 }, (g) => {
  for (const t of [0.003, 0.22]) {
    g.layer(g.osc('square', 950, t, 0.16), [g.lp(3000)], hold(t, 0.004, t + 0.12, 0.01, 0.5));
    g.layer(g.osc('sawtooth', 1425, t, 0.16), [g.lp(3500)], hold(t, 0.004, t + 0.12, 0.01, 0.15));
  }
});

def('crateGet', { dur: 1.0, variants: 2, var: 0.02, cap: 2, gain: 0.5, reverb: 0, bus: 'ui', prio: 4, post: rv({ rt: 1.0, mix: 0.2 }) }, (g, v) => {
  const notes = v ? [N.C5 * 2, N.E5 * 2, N.G5 * 2, N.C6 * 2] : [N.G5, N.C6, N.E5 * 2, N.G5 * 2];
  const hits = notes.map((f, i) => ({ t: 0.005 + i * 0.065, amp: 0.8 + i * 0.1, phase: 0, parts: [[f, 0.35, 1], [f * 2, 0.16, 0.3], [f * 3, 0.1, 0.15], [f * 4.2, 0.06, 0.08]] }));
  g.ch(g.buf(modalBuf(g, g.dur, hits)), g.out);
  tone(g, 0.003, { f0: 880, f1: 1760, sw: 0.04, att: 0.002, tau: 0.03, level: 0.25 });
});

def('click', { dur: 0.06, variants: 3, var: 0.05, cap: 3, gain: 0.45, reverb: 0, bus: 'ui', prio: 4 }, (g) => {
  nhit(g, 0.001, { pre: [g.bp(rr(2500, 3200), 1.2)], att: 0.0002, tau: 0.0025, level: 1 });
  tone(g, 0.001, { f0: 900, f1: 600, sw: 0.01, tau: 0.006, level: 0.5 });
});

def('hover', { dur: 0.05, variants: 2, var: 0.05, cap: 3, gain: 0.25, reverb: 0, bus: 'ui', prio: 4 }, (g) => {
  tone(g, 0.001, { f0: rr(2300, 2600), att: 0.001, tau: 0.007, level: 1 });
  nhit(g, 0.001, { pre: [g.hp(6000)], att: 0.0002, tau: 0.001, level: 0.4 });
});

// ------------------------------------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------------------------------------
export const SOUND_NAMES = Object.keys(RECIPES);
export const SOUND_META = Object.fromEntries(
  SOUND_NAMES.map((n) => {
    const R = RECIPES[n];
    return [n, { loop: R.loop, loopable: R.loopable, gain: R.gain, var: R.var, ref: R.ref, reverb: R.reverb, cap: R.cap, bus: R.bus, prio: R.prio, pan2D: R.pan2D }];
  })
);

function finishOneShot(d, sr, R) {
  // DC blocker (~8 Hz one-pole highpass)
  const a = 1 - (TAU * 8) / sr;
  let x1 = 0, y1 = 0;
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    y1 = x - x1 + a * y1;
    x1 = x;
    d[i] = y1;
  }
  let pk = 0;
  for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
  if (!(pk > 1e-9)) return d;
  if (R.punch > 0) {
    const k = R.punch, inv = 1 / pk, tk = Math.tanh(k);
    for (let i = 0; i < d.length; i++) d[i] = Math.tanh(d[i] * inv * k) / tk;
    pk = 1;
  }
  // trim trailing silence (-66 dB re peak), fade the last stretch
  const thr = pk * 0.0005;
  let end = d.length - 1;
  while (end > 0 && Math.abs(d[end]) < thr) end--;
  end = Math.min(d.length, end + Math.round(0.01 * sr));
  const out = d.slice(0, Math.max(end, 64));
  const fin = Math.min(8, out.length);
  for (let i = 0; i < fin; i++) out[i] *= i / fin;
  const fo = Math.min(Math.round(0.05 * sr), Math.floor(out.length * 0.15));
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
  let p2 = 0;
  for (let i = 0; i < out.length; i++) p2 = Math.max(p2, Math.abs(out[i]));
  const k = R.peak / p2;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

function finishLoop(d, R) {
  let m = 0;
  for (let i = 0; i < d.length; i++) m += d[i];
  m /= d.length;
  let pk = 0;
  for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i] - m));
  const k = pk > 1e-9 ? R.peak / pk : 0;
  for (let i = 0; i < d.length; i++) d[i] = (d[i] - m) * k;
  return d;
}

async function renderJob(S, R, v, stats) {
  const rng = mulberry32((hashStr(R.name) + v * 7919) >>> 0);
  rnd = rng;
  const sr = S.sr;
  const t0 = performance.now();
  let t1 = t0, t2 = t0, result;
  if (R.js) {
    const d = R.js(sr, v);
    result = toBuf(R.loop || R.loopable ? finishLoop(d, R) : finishOneShot(d, sr, R), sr);
    t1 = t2 = performance.now();
  } else if (R.loop) {
    const L = Math.round(R.len * sr);
    const settle = Math.round(R.settle * sr);
    const g = new Graph(S, L + settle);
    g.L = L;
    g.Ls = L / sr;
    const ln = new Float32Array(L);
    for (let i = 0; i < L; i++) ln[i] = (rnd() * 2 - 1) * 0.6;
    g.LN = toBuf(ln, sr);
    R.build(g, v);
    t1 = performance.now();
    const rendered = await g.c.startRendering();
    t2 = performance.now();
    const d = rendered.getChannelData(0).slice(settle, settle + L);
    result = toBuf(finishLoop(d, R), sr);
  } else {
    const g = new Graph(S, Math.ceil(R.dur * sr));
    R.build(g, v);
    t1 = performance.now();
    const rendered = await g.c.startRendering();
    t2 = performance.now();
    const d = rendered.getChannelData(0).slice();
    rnd = rng;
    if (R.post) R.post(d, sr);
    result = toBuf(finishOneShot(d, sr, R), sr);
  }
  if (stats) {
    const e = (stats[R.name] ||= { build: 0, render: 0, post: 0 });
    e.build += t1 - t0;
    e.render += t2 - t1;
    e.post += performance.now() - t2;
  }
  return result;
}

/**
 * Render every recipe. Returns Map<name, AudioBuffer[]> (variants; loops have exactly one).
 * @param {number} sampleRate  target rate (clamped to 22.05–48 kHz; the AudioContext resamples)
 * @param {(fraction:number)=>void} [onProgress]
 * @param {{only?: string[], concurrency?: number, stats?: object}} [options]  subset / worker count / timing stats (tests, tools)
 */
export async function renderAll(sampleRate = 48000, onProgress, options = {}) {
  const sr = Math.max(22050, Math.min(MAX_RENDER_SR, Math.round(sampleRate || 48000)));
  const S = makeShared(sr);
  const jobs = [];
  const out = new Map();
  const names = options.only ? SOUND_NAMES.filter((n) => options.only.includes(n)) : SOUND_NAMES;
  for (const name of names) {
    const R = RECIPES[name];
    const nv = R.loop || R.loopable ? 1 : R.variants;
    out.set(name, new Array(nv));
    for (let v = 0; v < nv; v++) jobs.push({ R, v, cost: R.loop ? R.len + R.settle : R.dur });
  }
  // longest first keeps the worker pool busy until the end
  jobs.sort((a, b) => b.cost - a.cost);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      try {
        out.get(j.R.name)[j.v] = await renderJob(S, j.R, j.v, options.stats);
      } catch (e) {
        console.error(`[synth] recipe "${j.R.name}" #${j.v} failed:`, e);
        out.get(j.R.name)[j.v] = null;
      }
      done++;
      if (onProgress) {
        try {
          onProgress(done / jobs.length);
        } catch {
          /* ignore UI errors */
        }
      }
    }
  };
  await Promise.all(Array.from({ length: options.concurrency || CONCURRENCY }, worker));
  rnd = Math.random;
  for (const [name, arr] of out) {
    const ok = arr.filter(Boolean);
    if (ok.length) out.set(name, ok);
    else out.delete(name);
  }
  return out;
}
