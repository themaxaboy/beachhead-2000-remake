/**
 * AudioEngine — runtime playback for the procedurally synthesized sound set (see synth.js).
 *
 * Graph:
 *   voices -> bus[sfx|ambience|ui] -> master -> DynamicsCompressor -> destination
 *   voices -> reverb send (per bus, scaled by the bus volume) -> Convolver (synthetic outdoor IR)
 *          -> reverb return -> master
 *
 * Positional sounds go through a distance lowpass + HRTF PannerNode; one-shots farther than
 * 150 m are delayed by distance / 343 m/s. Loops get manual doppler every listener tick.
 */
import { renderAll, SOUND_META } from './synth.js';

const SPEED_OF_SOUND = 343;
const MAX_VOICES = 48;
const BUSES = ['sfx', 'ambience', 'ui'];
const DEFAULT_META = { gain: 1, var: 0.04, ref: 12, reverb: 0.15, cap: 6, bus: 'sfx', prio: 1, pan2D: 0 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + (b - a) * Math.random();
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Lowpass cutoff vs distance: 20 kHz at <= 50 m, ~1.5 kHz at 1500 m (log-distance), ~900 Hz at 3 km. */
function distanceCutoff(d) {
  if (d <= 50) return 20000;
  const t = Math.log(d / 50) / Math.log(30);
  return Math.max(600, 20000 * Math.pow(0.075, t));
}
/** Reverb send scale: the wet path falls off with sqrt of the dry (inverse-distance) attenuation. */
function wetScale(d, ref) {
  const dry = ref / (ref + Math.max(0, d - ref));
  return Math.sqrt(dry);
}

/** ~1.2 s stereo outdoor impulse response: sparse early slaps + darkening exponential tail. */
function makeImpulseResponse(ctx, seconds = 1.2) {
  const sr = ctx.sampleRate;
  const n = Math.round(sr * seconds);
  const ir = ctx.createBuffer(2, n, sr);
  const taps = [
    [0.011, 0.55], [0.024, 0.4], [0.037, 0.45], [0.058, 0.3],
    [0.083, 0.28], [0.12, 0.2], [0.17, 0.14], [0.24, 0.09],
  ];
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let z = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.exp(-t / 0.17) * Math.min(1, t / 0.012);
      const a = 0.12 + 0.78 * Math.exp(-t / 0.18); // one-pole lowpass coefficient: tail gets darker
      z += a * (Math.random() * 2 - 1 - z);
      d[i] = z * env * 0.5;
    }
    for (const [tt, g] of taps) {
      const i0 = Math.round(tt * (1 + (Math.random() - 0.5) * 0.15) * sr);
      const len = Math.round(0.003 * sr);
      const s = Math.random() < 0.5 ? -1 : 1;
      for (let j = 0; j < len && i0 + j < n; j++) d[i0 + j] += s * g * (Math.random() * 2 - 1) * Math.exp(-j / (0.0006 * sr));
    }
  }
  return ir;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.voices = []; // active/scheduled one-shots, oldest first
    this.loops = new Set();
    this._ready = false;
    this._initPromise = null;
    this._vol = { master: 1, sfx: 1, ambience: 1, ui: 1 };
    this._lp = { x: 0, y: 0, z: 0 }; // listener position
    this._lv = { x: 0, y: 0, z: 0 }; // listener velocity (smoothed)
    this._lt = 0;
    this._hasListener = false;
    this._frameDt = 1 / 60;
    this._loopsTicked = false;
    this._lastVariant = new Map();
    this._altPan = 1;
    this._amb = null;
    this._frame = 0;
    this._warned = new Set();
  }

  get ready() {
    return this._ready;
  }

  /** Create the AudioContext (call from a user-gesture handler) and render every sound. Idempotent. */
  init(onProgress) {
    if (!this._initPromise) {
      this._initPromise = this._init(onProgress).catch((err) => {
        console.error('[audio] init failed:', err);
        this._initPromise = null;
        return false;
      });
    }
    return this._initPromise;
  }

  async _init(onProgress) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) throw new Error('Web Audio API not available');
    if (!this.ctx) {
      // created synchronously inside the caller's user gesture
      this.ctx = new AC({ latencyHint: 'interactive' });
      this._nyq = this.ctx.sampleRate * 0.475;
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.buffers = await renderAll(this.ctx.sampleRate, onProgress);
    this._ready = true;
    return true;
  }

  _buildGraph() {
    const c = this.ctx;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 6;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    this.comp = comp;
    this.master = c.createGain();
    this.master.connect(comp);
    comp.connect(c.destination);

    this.reverb = c.createConvolver();
    this.reverb.buffer = makeImpulseResponse(c);
    this.reverbReturn = c.createGain();
    this.reverbReturn.gain.value = 0.6;
    this.reverb.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);

    this.bus = {};
    this.send = {};
    for (const b of BUSES) {
      this.bus[b] = c.createGain();
      this.bus[b].connect(this.master);
      this.send[b] = c.createGain(); // reverb send scaled by the bus volume
      this.send[b].connect(this.reverb);
    }
    this._applyVolumes(true);
  }

  resume() {
    return this.ctx ? this.ctx.resume().catch(() => {}) : Promise.resolve();
  }

  suspend() {
    return this.ctx ? this.ctx.suspend().catch(() => {}) : Promise.resolve();
  }

  /** Volumes 0..1 for { master, sfx, ambience, ui } (any subset). */
  setVolumes(v = {}) {
    for (const k of ['master', 'sfx', 'ambience', 'ui']) if (typeof v[k] === 'number' && Number.isFinite(v[k])) this._vol[k] = clamp(v[k], 0, 1);
    this._applyVolumes(false);
  }

  _applyVolumes(immediate) {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const set = (p, val) => {
      if (immediate) p.value = val;
      else {
        p.cancelScheduledValues(now);
        p.setTargetAtTime(val, now, 0.03);
      }
    };
    set(this.master.gain, this._vol.master);
    for (const b of BUSES) {
      set(this.bus[b].gain, this._vol[b]);
      set(this.send[b].gain, this._vol[b]);
    }
  }

  _meta(name) {
    return SOUND_META[name] || DEFAULT_META;
  }

  _panner(ref) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1;
    p.maxDistance = 3000;
    return p;
  }

  _setPannerPos(p, x, y, z, ramp) {
    if (p.positionX) {
      if (ramp) {
        const end = this.ctx.currentTime + this._frameDt;
        p.positionX.linearRampToValueAtTime(x, end);
        p.positionY.linearRampToValueAtTime(y, end);
        p.positionZ.linearRampToValueAtTime(z, end);
      } else {
        p.positionX.value = x;
        p.positionY.value = y;
        p.positionZ.value = z;
      }
    } else p.setPosition(x, y, z);
  }

  // ----------------------------------------------------------------------------------- listener

  /** Call every frame with the active THREE.Camera (reads camera.matrixWorld). */
  updateListener(camera) {
    if (!this.ctx || !camera || !camera.matrixWorld) return;
    const e = camera.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
    let fx = -e[8], fy = -e[9], fz = -e[10];
    let ux = e[4], uy = e[5], uz = e[6];
    const fl = Math.hypot(fx, fy, fz) || 1;
    const ul = Math.hypot(ux, uy, uz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    ux /= ul; uy /= ul; uz /= ul;

    const now = performance.now() / 1000;
    const dt = this._hasListener ? clamp(now - this._lt, 0.001, 0.25) : 1 / 60;
    if (this._hasListener) {
      // heavily smoothed so camera shake / recoil does not wobble the doppler
      const k = 1 - Math.exp(-dt / 0.35);
      this._lv.x += ((px - this._lp.x) / dt - this._lv.x) * k;
      this._lv.y += ((py - this._lp.y) / dt - this._lv.y) * k;
      this._lv.z += ((pz - this._lp.z) / dt - this._lv.z) * k;
    }
    this._lp.x = px;
    this._lp.y = py;
    this._lp.z = pz;
    this._lt = now;
    this._frameDt = dt;
    const first = !this._hasListener;
    this._hasListener = true;

    // don't pile automation events up while the context is suspended (game paused)
    if (this.ctx.state === 'running' || first) {
      const L = this.ctx.listener;
      if (L.positionX) {
        const params = [L.positionX, L.positionY, L.positionZ, L.forwardX, L.forwardY, L.forwardZ, L.upX, L.upY, L.upZ];
        const vals = [px, py, pz, fx, fy, fz, ux, uy, uz];
        if (first) for (let i = 0; i < 9; i++) params[i].value = vals[i];
        else {
          const end = this.ctx.currentTime + dt;
          for (let i = 0; i < 9; i++) params[i].linearRampToValueAtTime(vals[i], end);
        }
      } else {
        L.setPosition(px, py, pz);
        L.setOrientation(fx, fy, fz, ux, uy, uz);
      }
    }
    this._tickLoops();
    this._loopsTicked = true;
  }

  // ---------------------------------------------------------------------------------- one-shots

  /**
   * Play a one-shot.
   * @param {string} name
   * @param {{position?:{x:number,y:number,z:number}, volume?:number, rate?:number, bus?:'sfx'|'ui'|'ambience', delay?:number}} [opts]
   * @returns {{stop(fade?:number):void, readonly playing:boolean}|null}
   */
  play(name, opts = {}) {
    if (!this._ready) return null;
    try {
      return this._play(name, opts || {});
    } catch (err) {
      this._warnOnce('play:' + name, err);
      return null;
    }
  }

  _play(name, opts) {
    const bufs = this.buffers.get(name);
    if (!bufs || !bufs.length) return this._warnOnce('missing:' + name, `unknown sound "${name}"`), null;
    const c = this.ctx;
    const m = this._meta(name);
    const prio = m.prio ?? 1;

    // per-sound cap: steal the oldest voice of this sound
    let count = 0, oldest = null;
    for (const v of this.voices) {
      if (v.name === name) {
        count++;
        if (!oldest) oldest = v;
      }
    }
    if (count >= m.cap && oldest) this._stopVoice(oldest, 0.015);
    // global cap: steal the oldest lowest-priority voice below this one's priority, else give up
    if (this.voices.length >= MAX_VOICES) {
      this._reapVoices();
      if (this.voices.length >= MAX_VOICES) {
        let victim = null;
        for (const v of this.voices) if (v.prio < prio && (!victim || v.prio < victim.prio)) victim = v;
        if (!victim) return null;
        this._stopVoice(victim, 0.015);
      }
    }

    // variant: random, never the same twice in a row
    let idx = 0;
    if (bufs.length > 1) {
      const last = this._lastVariant.get(name);
      if (last == null) idx = Math.floor(Math.random() * bufs.length);
      else {
        idx = Math.floor(Math.random() * (bufs.length - 1));
        if (idx >= last) idx++;
      }
      this._lastVariant.set(name, idx);
    }
    const buf = bufs[idx];
    const rate = clamp(num(opts.rate, 1) * (1 + (Math.random() * 2 - 1) * m.var), 0.25, 4);
    const busName = this.bus[opts.bus] ? opts.bus : this.bus[m.bus] ? m.bus : 'sfx';
    const bus = this.bus[busName];

    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = Math.max(0, num(opts.volume, 1)) * m.gain;
    src.connect(g);
    const nodes = [src, g];
    let start = c.currentTime + Math.max(0, num(opts.delay, 0));
    let tap = g;
    let wet = m.reverb;

    const pos = opts.position;
    if (pos) {
      const px = num(pos.x), py = num(pos.y), pz = num(pos.z);
      const d = Math.hypot(px - this._lp.x, py - this._lp.y, pz - this._lp.z);
      const lpf = c.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.Q.value = 0.5;
      lpf.frequency.value = Math.min(distanceCutoff(d), this._nyq);
      const pan = this._panner(m.ref);
      this._setPannerPos(pan, px, py, pz, false);
      g.connect(lpf);
      lpf.connect(pan);
      pan.connect(bus);
      nodes.push(lpf, pan);
      tap = lpf;
      wet = Math.max(m.reverb, 0.12) * wetScale(d, m.ref);
      if (d > 150) start += d / SPEED_OF_SOUND; // sound arrives late from far away
    } else if (m.pan2D && c.createStereoPanner) {
      const sp = c.createStereoPanner();
      this._altPan = -this._altPan; // alternate sides (twin barrels)
      sp.pan.value = m.pan2D * this._altPan * rand(0.7, 1);
      g.connect(sp);
      sp.connect(bus);
      nodes.push(sp);
    } else {
      g.connect(bus);
    }
    if (wet > 0.002) {
      const s = c.createGain();
      s.gain.value = wet;
      tap.connect(s);
      s.connect(this.send[busName]);
      nodes.push(s);
    }

    src.start(start);
    const voice = { name, src, gain: g, nodes, prio, start, end: start + buf.duration / rate, done: false, tracked: true };
    src.onended = () => this._releaseVoice(voice);
    this.voices.push(voice);
    return {
      stop: (fade = 0.05) => this._stopVoice(voice, Math.max(0.005, num(fade, 0.05))),
      get playing() {
        return !voice.done;
      },
    };
  }

  _untrack(v) {
    if (!v.tracked) return;
    v.tracked = false;
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  _stopVoice(v, fade) {
    this._untrack(v); // frees the slot immediately
    if (v.done || v.stopping) return;
    v.stopping = true;
    const now = this.ctx.currentTime;
    try {
      const p = v.gain.gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + fade);
      v.src.stop(now + fade + 0.005);
    } catch {
      this._releaseVoice(v);
    }
  }

  _releaseVoice(v) {
    if (v.done) return;
    v.done = true;
    this._untrack(v);
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }

  /** Safety net in case an 'ended' event never arrives. */
  _reapVoices() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.end < now - 0.5) this._releaseVoice(v);
    }
  }

  // -------------------------------------------------------------------------------------- loops

  /**
   * Start a continuous (optionally positional) loop.
   * @returns {{setPosition(v):void, setVelocity(v):void, setVolume(v:number, rampSec?:number):void,
   *            setRate(r:number):void, stop(fadeSec?:number):void, readonly playing:boolean}|null}
   */
  loop(name, opts = {}) {
    if (!this._ready) return null;
    try {
      return this._loop(name, opts || {});
    } catch (err) {
      this._warnOnce('loop:' + name, err);
      return null;
    }
  }

  _loop(name, opts) {
    const bufs = this.buffers.get(name);
    if (!bufs || !bufs.length) return this._warnOnce('missing:' + name, `unknown sound "${name}"`), null;
    const c = this.ctx;
    const m = this._meta(name);
    const buf = bufs[0];
    const busName = this.bus[opts.bus] ? opts.bus : this.bus[m.bus] ? m.bus : 'sfx';
    const now = c.currentTime;

    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const baseRate = clamp(num(opts.rate, 1), 0.1, 4);
    src.playbackRate.value = baseRate;
    const vol = c.createGain();
    const volume = Math.max(0, num(opts.volume, 1));
    vol.gain.setValueAtTime(0, now);
    vol.gain.linearRampToValueAtTime(volume * m.gain, now + 0.08);
    src.connect(vol);

    const L = {
      name, src, vol, busName,
      lpf: null, pan: null, sendG: null,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      vref: null, // last sample used to estimate velocity when setVelocity() is never called
      velSet: false,
      follow: null, // live position object passed in opts.position (followed until setPosition())
      baseRate, volume, gain: m.gain, reverb: m.reverb, ref: m.ref,
      playing: true,
    };
    vol.connect(this.bus[busName]);
    if (m.reverb > 0.002) {
      L.sendG = c.createGain();
      L.sendG.gain.value = m.reverb;
      vol.connect(L.sendG);
      L.sendG.connect(this.send[busName]);
    }
    if (opts.position) {
      this._make3D(L);
      L.follow = opts.position;
      this._setLoopPos(L, opts.position, false);
      this._tickLoop(L, true);
    }
    src.start(now, Math.random() * buf.duration);
    src.onended = () => {
      for (const n of [src, vol, L.lpf, L.pan, L.sendG]) {
        try {
          n && n.disconnect();
        } catch {
          /* ignore */
        }
      }
    };
    this.loops.add(L);

    const self = this;
    return {
      setPosition(v) {
        if (!v || !L.playing) return;
        L.follow = null;
        if (!L.pan) self._make3D(L);
        self._setLoopPos(L, v, true);
      },
      setVelocity(v) {
        if (!v) return;
        L.velSet = true;
        L.vel.x = num(v.x);
        L.vel.y = num(v.y);
        L.vel.z = num(v.z);
      },
      setVolume(v, rampSec = 0.1) {
        if (!L.playing) return;
        L.volume = Math.max(0, num(v, 1));
        const t = self.ctx.currentTime;
        const p = L.vol.gain;
        p.cancelScheduledValues(t);
        p.setValueAtTime(p.value, t);
        p.linearRampToValueAtTime(L.volume * L.gain, t + Math.max(0.005, num(rampSec, 0.1)));
      },
      setRate(r) {
        if (!L.playing) return;
        L.baseRate = clamp(num(r, 1), 0.1, 4);
        if (!L.pan) L.src.playbackRate.setTargetAtTime(L.baseRate, self.ctx.currentTime, 0.02);
        else self._tickLoop(L);
      },
      stop(fadeSec = 0.3) {
        self._stopLoop(L, Math.max(0.005, num(fadeSec, 0.3)));
      },
      get playing() {
        return L.playing;
      },
    };
  }

  /** Insert distance lowpass + panner between the loop's gain and its bus. */
  _make3D(L) {
    const c = this.ctx;
    L.lpf = c.createBiquadFilter();
    L.lpf.type = 'lowpass';
    L.lpf.Q.value = 0.5;
    L.lpf.frequency.value = 20000 > this._nyq ? this._nyq : 20000;
    L.pan = this._panner(L.ref);
    L.vol.disconnect();
    L.vol.connect(L.lpf);
    L.lpf.connect(L.pan);
    L.pan.connect(this.bus[L.busName]);
    if (L.sendG) L.lpf.connect(L.sendG);
  }

  _setLoopPos(L, v, ramp) {
    const x = num(v.x), y = num(v.y), z = num(v.z);
    L.pos.x = x;
    L.pos.y = y;
    L.pos.z = z;
    if (!L.velSet) {
      const t = performance.now() / 1000;
      if (!L.vref) L.vref = { x, y, z, t };
      else if (t - L.vref.t > 0.004) {
        const dt = Math.min(0.25, t - L.vref.t);
        const k = 1 - Math.exp(-dt / 0.15);
        L.vel.x += ((x - L.vref.x) / dt - L.vel.x) * k;
        L.vel.y += ((y - L.vref.y) / dt - L.vel.y) * k;
        L.vel.z += ((z - L.vref.z) / dt - L.vel.z) * k;
        L.vref.x = x;
        L.vref.y = y;
        L.vref.z = z;
        L.vref.t = t;
      }
    }
    if (L.pan) this._setPannerPos(L.pan, x, y, z, ramp && this.ctx.state === 'running');
  }

  _tickLoops() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    for (const L of this.loops) if (L.pan) this._tickLoop(L, false);
  }

  /** Distance filter, reverb send and manual doppler for one positional loop. */
  _tickLoop(L, immediate) {
    if (L.follow) this._setLoopPos(L, L.follow, !immediate);
    const dx = L.pos.x - this._lp.x, dy = L.pos.y - this._lp.y, dz = L.pos.z - this._lp.z;
    const d = Math.hypot(dx, dy, dz);
    const rvx = L.vel.x - this._lv.x, rvy = L.vel.y - this._lv.y, rvz = L.vel.z - this._lv.z;
    const radial = d > 1e-3 ? (rvx * dx + rvy * dy + rvz * dz) / d : 0; // > 0: receding
    const doppler = clamp(SPEED_OF_SOUND / Math.max(1, SPEED_OF_SOUND + radial), 0.5, 2);
    const rate = L.baseRate * doppler;
    const cutoff = Math.min(distanceCutoff(d), this._nyq);
    const wet = Math.max(L.reverb, 0.1) * wetScale(d, L.ref);
    if (immediate) {
      L.src.playbackRate.value = rate;
      L.lpf.frequency.value = cutoff;
      if (L.sendG) L.sendG.gain.value = wet;
    } else {
      const now = this.ctx.currentTime;
      L.src.playbackRate.setTargetAtTime(rate, now, 0.04);
      L.lpf.frequency.setTargetAtTime(cutoff, now, 0.05);
      if (L.sendG) L.sendG.gain.setTargetAtTime(wet, now, 0.1);
    }
  }

  _stopLoop(L, fade) {
    if (!L.playing) return;
    L.playing = false;
    this.loops.delete(L);
    const now = this.ctx.currentTime;
    try {
      const p = L.vol.gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + fade);
      L.src.stop(now + fade + 0.02);
    } catch {
      /* ignore */
    }
  }

  /** Stop every one-shot and loop (e.g. level teardown). Ambience is left alone. */
  stopAll(fade = 0.1) {
    if (!this.ctx) return;
    for (const v of this.voices.slice()) this._stopVoice(v, fade);
    for (const L of Array.from(this.loops)) this._stopLoop(L, fade);
  }

  // ---------------------------------------------------------------------------------- ambience

  /** Surf + wind beds and occasional distant artillery / gunfire on the ambience bus (2D stereo). */
  startAmbience() {
    if (!this._ready || this._amb) return;
    const c = this.ctx;
    const now = c.currentTime;
    const bus = this.bus.ambience;
    const mk = (name, pan, vol, rate) => {
      const bufs = this.buffers.get(name);
      if (!bufs) return null;
      const src = c.createBufferSource();
      src.buffer = bufs[0];
      src.loop = true;
      src.playbackRate.value = rate;
      const g = c.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(vol, now + 2);
      const sp = c.createStereoPanner ? c.createStereoPanner() : null;
      src.connect(g);
      if (sp) {
        sp.pan.value = pan;
        g.connect(sp);
        sp.connect(bus);
      } else g.connect(bus);
      src.start(now, Math.random() * bufs[0].duration);
      return { src, g, sp, base: vol };
    };
    this._amb = {
      layers: [mk('ambSurf', -0.6, 0.42, 1.0), mk('ambSurf', 0.6, 0.42, 0.93), mk('ambWind', 0, 0.3, 1.0)],
      tGust: 1,
      tSwell: 2,
      tBoom: rand(3, 8),
      tBattle: rand(10, 20),
    };
  }

  stopAmbience(fade = 1.5) {
    const A = this._amb;
    if (!A || !this.ctx) return;
    this._amb = null;
    const now = this.ctx.currentTime;
    for (const L of A.layers) {
      if (!L) continue;
      try {
        const p = L.g.gain;
        p.cancelScheduledValues(now);
        p.setValueAtTime(p.value, now);
        p.linearRampToValueAtTime(0, now + fade);
        L.src.stop(now + fade + 0.05);
        L.src.onended = () => {
          for (const n of [L.src, L.g, L.sp]) n && n.disconnect();
        };
      } catch {
        /* ignore */
      }
    }
  }

  _updateAmbience(dt) {
    const A = this._amb;
    if (!A || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const [surfL, surfR, wind] = A.layers;
    if ((A.tGust -= dt) <= 0) {
      A.tGust = rand(1.5, 4.5);
      if (wind) {
        wind.g.gain.setTargetAtTime(wind.base * rand(0.45, 1.5), now, rand(0.6, 1.5));
        if (wind.sp) wind.sp.pan.setTargetAtTime(rand(-0.5, 0.5), now, 1.5);
      }
    }
    if ((A.tSwell -= dt) <= 0) {
      A.tSwell = rand(2.5, 6);
      for (const s of [surfL, surfR]) if (s) s.g.gain.setTargetAtTime(s.base * rand(0.55, 1.35), now, rand(0.8, 2));
    }
    if ((A.tBoom -= dt) <= 0) {
      A.tBoom = rand(6, 18);
      this._ambShot('ambBoom', { pan: rand(-0.85, 0.85), volume: rand(0.25, 0.75), rate: rand(0.8, 1.12) });
    }
    if ((A.tBattle -= dt) <= 0) {
      // a distant machine-gun burst somewhere down the beach
      A.tBattle = rand(14, 35);
      const n = 4 + Math.floor(Math.random() * 7);
      const pan = rand(-0.9, 0.9), base = rand(0.05, 0.12), lp = rand(700, 1300), gap = rand(0.085, 0.11);
      const name = Math.random() < 0.75 ? 'enemyMG' : 'rifle';
      for (let i = 0; i < n; i++) this._ambShot(name, { pan, volume: base * rand(0.7, 1), rate: rand(0.85, 1), delay: i * gap * rand(0.9, 1.1), lp });
    }
  }

  _ambShot(name, { pan = 0, volume = 1, rate = 1, delay = 0, lp = 0 } = {}) {
    const bufs = this.buffers.get(name);
    if (!bufs || !bufs.length) return;
    const c = this.ctx;
    const m = this._meta(name);
    const src = c.createBufferSource();
    src.buffer = bufs[Math.floor(Math.random() * bufs.length)];
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = volume * m.gain;
    const nodes = [src, g];
    let last = g;
    src.connect(g);
    if (lp) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lp;
      last.connect(f);
      last = f;
      nodes.push(f);
    }
    const s = c.createGain();
    s.gain.value = 0.35;
    last.connect(s);
    s.connect(this.send.ambience);
    nodes.push(s);
    if (c.createStereoPanner) {
      const sp = c.createStereoPanner();
      sp.pan.value = clamp(pan, -1, 1);
      last.connect(sp);
      last = sp;
      nodes.push(sp);
    }
    last.connect(this.bus.ambience);
    src.start(c.currentTime + delay);
    src.onended = () => {
      for (const n of nodes) n.disconnect();
    };
  }

  // ------------------------------------------------------------------------------------ update

  /** Per-frame tick: doppler/distance for loops (if updateListener didn't run) + ambience events. */
  update(dt = 1 / 60) {
    if (!this._ready) return;
    if (!this._loopsTicked) this._tickLoops();
    this._loopsTicked = false;
    this._updateAmbience(clamp(num(dt, 1 / 60), 0, 0.25));
    if (++this._frame % 120 === 0) this._reapVoices();
  }

  _warnOnce(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn('[audio]', msg);
  }
}

export default AudioEngine;
