// Generates the 60 missions. Mirrors the parameters of the original Level_NN files:
// ammo per weapon, a time limit and four "Aggression" values (Tank, Jet, HelicopterGun, HelicopterRocket, 1..9),
// plus the enemy composition, landing zones (spawn points change every mission) and a spawn schedule.
// Pure module: no three.js import so it can be unit tested in Node.
import { Rng } from '../core/rng.js';

export const LEVEL_COUNT = 60;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round10 = (v) => Math.round(v / 10) * 10;
const round50 = (v) => Math.round(v / 50) * 50;
const lerp = (a, b, t) => a + (b - a) * t;

export function timeOfDayFor(n) {
  const k = (n - 1) % 20;
  if (k < 10) return 'day';
  if (k < 15) return 'dusk';
  return 'night';
}

export function generateLevel(n) {
  const L = clamp(Math.floor(n), 1, LEVEL_COUNT);
  const p = (L - 1) / (LEVEL_COUNT - 1);
  const rng = new Rng(L * 7919);

  const aggression = {
    tank: clamp(1 + Math.floor((L - 1) / 7), 1, 9),
    jet: clamp(1 + Math.floor((L - 4) / 7), 1, 9),
    heliGun: clamp(1 + Math.floor((L - 5) / 6.5), 1, 9),
    heliRocket: clamp(1 + Math.floor((L - 7) / 6.4), 1, 9),
  };

  const units = {
    infantryLCT: Math.min(2 + Math.floor(L / 6), 10),
    tanks: Math.min(Math.floor((L + 1) / 3), 16),
    apcs: L < 3 ? 0 : Math.min(1 + Math.floor((L - 3) / 5), 10),
    jets: L < 4 ? 0 : Math.min(1 + Math.floor((L - 4) / 4), 14),
    cobras: L < 5 ? 0 : Math.min(1 + Math.floor((L - 5) / 5), 10),
    ch53: L < 6 ? 0 : Math.min(1 + Math.floor((L - 6) / 8), 6),
    bomberRaids: L < 8 ? 0 : Math.min(1 + Math.floor((L - 8) / 10), 6),
    bombersPerRaid: L < 25 ? 1 : L < 45 ? 2 : 3,
  };
  units.troopsPerLCT = 12;
  units.troopsPerAPC = 6;
  units.paratroopersPerCH53 = 8;

  const ammo = {
    bullets: Math.min(round50(1200 + 50 * (L - 1)), 4500),
    projectiles: 12 + Math.floor(2 * units.tanks + 1.5 * units.apcs + units.infantryLCT),
    missiles: 8 + units.jets + units.cobras + units.ch53,
    howitzer: L % 5 === 0 ? 2 + Math.floor(L / 20) : 0,
  };

  const timeLimit = Math.min(round10(120 + 8 * L), 600);

  // Landing zones: where the landing craft hit the beach this mission.
  const zoneCount = Math.min(1 + Math.floor(L / 15), 4);
  const zones = [];
  let guard = 0;
  while (zones.length < zoneCount && guard++ < 500) {
    const x = rng.range(-210, 210);
    if (zones.every((z) => Math.abs(z.x - x) >= 80)) {
      zones.push({ x: Math.round(x), width: Math.round(lerp(40, 80, p)) });
    }
  }
  zones.sort((a, b) => a.x - b.x);

  const caps = {
    lct: Math.min(2 + Math.floor(L / 8), 8),
    air: Math.min(1 + Math.floor(L / 10), 6),
    infantry: 140,
  };

  // ---- schedule ----
  const schedule = [];
  const cargo = [];
  for (let i = 0; i < units.infantryLCT; i++) cargo.push('infantry');
  for (let i = 0; i < units.tanks; i++) cargo.push('tank');
  for (let i = 0; i < units.apcs; i++) cargo.push('apc');
  rng.shuffle(cargo);
  if (L <= 3) {
    // The opening wave of the first missions is always infantry.
    const idx = cargo.indexOf('infantry');
    if (idx > 0) [cargo[0], cargo[idx]] = [cargo[idx], cargo[0]];
  }
  const waveSize = 1 + Math.ceil(L / 15);
  const waves = [];
  for (let i = 0; i < cargo.length; i += waveSize) waves.push(cargo.slice(i, i + waveSize));
  // Waves follow each other closely (a fixed gap that shrinks a little with level) instead of being
  // stretched across the whole time limit, so the player is not left waiting between them.
  const waveGap = lerp(16, 11, p);
  const lastWaveT = Math.min(0.7 * timeLimit, 4 + Math.max(0, waves.length - 1) * waveGap);
  const lastLandT = Math.min(0.7 * timeLimit, lastWaveT + (waveSize - 1) * 2.5);
  waves.forEach((wave, wi) => {
    const base = waves.length === 1 ? 4 : 4 + (wi / (waves.length - 1)) * (lastWaveT - 4);
    const t = wi === 0 ? 4 : base * rng.range(0.85, 1.15);
    wave.forEach((kind, k) => {
      const zone = rng.int(0, zones.length - 1);
      schedule.push({ t: round1(Math.min(t + k * 2.5, lastLandT)), kind: 'lct', cargo: kind, zone });
    });
  });

  const spreadAir = (kind, count, t0, t1) => {
    for (let i = 0; i < count; i++) {
      const base = count === 1 ? (t0 + t1) / 2 : t0 + (i / (count - 1)) * (t1 - t0);
      schedule.push({ t: round1(clamp(base + rng.range(-8, 8), t0, t1)), kind });
    }
  };
  const airEnd = Math.min(0.75 * timeLimit, Math.max(60, lastWaveT + 25));
  spreadAir('jet', units.jets, 20, airEnd);
  spreadAir('cobra', units.cobras, 30, airEnd);
  spreadAir('ch53', units.ch53, 25, airEnd);
  for (let i = 0; i < units.bomberRaids; i++) {
    const t = airEnd * (0.3 + (0.7 * i) / Math.max(1, units.bomberRaids));
    schedule.push({ t: round1(Math.min(t, airEnd)), kind: 'bomberRaid', count: units.bombersPerRaid });
  }
  schedule.sort((a, b) => a.t - b.t);

  const totalInfantry =
    units.infantryLCT * units.troopsPerLCT +
    units.apcs * units.troopsPerAPC +
    units.ch53 * units.paratroopersPerCH53;

  return {
    number: L,
    seed: L * 7919,
    timeLimit,
    timeOfDay: timeOfDayFor(L),
    ammo,
    aggression,
    units,
    totalInfantry,
    zones,
    caps,
    schedule,
  };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/** Renders a level in the spirit of the original game's Level_NN text files. */
export function levelFileText(def) {
  const nn = String(def.number).padStart(2, '0');
  const a = def.aggression;
  return [
    `// LEVEL_${nn}`,
    '//Bullets, Projectiles, Missiles',
    `Ammo ${def.ammo.bullets} ${def.ammo.projectiles} ${def.ammo.missiles}`,
    '//Seconds',
    `Time ${def.timeLimit}`,
    '//Tank, Jet, HelicopterGun, HelicopterRocket',
    `Aggression ${a.tank} ${a.jet} ${a.heliGun} ${a.heliRocket}`,
  ].join('\n');
}

let cache = null;
export function allLevels() {
  if (!cache) cache = Array.from({ length: LEVEL_COUNT }, (_, i) => generateLevel(i + 1));
  return cache;
}
