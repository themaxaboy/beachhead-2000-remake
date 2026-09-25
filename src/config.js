// Central tunables. Anything that affects balance or feel lives here.
import { DEG } from './core/math.js';

export const CONFIG = {
  world: {
    waterlineZ: -120, // average distance of the shoreline in front of the bunker
    moundHeight: 6,
    size: 3000,
  },

  camera: {
    eyeHeight: 8.6,
    fov: 58,
    pitchMin: -17 * DEG, // firing slit: limited up/down travel
    pitchMax: 48 * DEG,
  },

  sensitivity: { steps: 10, default: 5, base: 0.0021, factor: 1.22 },

  bunker: {
    shield: 100,
    position: [0, 7.2, 0],
    radius: 4.5,
  },

  // Assumptions about details the original never documented (kept in one place so they are easy to change).
  rules: {
    shieldCarryover: false, // shield resets each mission
    overtime: 'bombers', // after the time limit bomber raids keep coming until the beach is clear
    overtimeRaidInterval: 40,
    timeBonusPerSecond: 5,
    shieldBonus: 20,
    levelBonus: 500,
  },

  weapons: {
    mg: { rate: 16, spread: 0.28 * DEG, speed: 950, life: 1.6, label: 'BULLETS' },
    at: { reload: 1.7, speed: 280, gravity: 9.81 * 0.55, spread: 0.05 * DEG, label: 'PROJECTILES' },
    missile: { reload: 0.7, maxAirborne: 2, lockCone: 7 * DEG, label: 'MISSILES' },
    pistol: { rate: 5, magazine: 15, reload: 1.5, spread: 0.15 * DEG, range: 350, label: 'HANDGUN' },
    howitzer: { reload: 3.5, speed: 190, gravity: 9.81 * 0.7, label: 'HOWITZER' },
  },

  supply: {
    firstMin: 35,
    firstMax: 50,
    intervalMin: 50,
    intervalMax: 80,
    urgentMin: 15,
    urgentMax: 25,
    minGap: 30,
    ammoBullets: 300,
    ammoMissiles: 3,
    ammoProjectiles: 3,
    shield: 25,
  },

  quality: {
    low: { pixelRatio: 0.75, shadows: 0, bloom: false, msaa: 0, water: 'simple', particles: 1500, grass: 0 },
    medium: { pixelRatio: 1, shadows: 1024, bloom: true, msaa: 2, water: 512, particles: 4000, grass: 1400 },
    high: { pixelRatio: 1.5, shadows: 2048, bloom: true, msaa: 4, water: 1024, particles: 5000, grass: 3000 },
  },

  timeOfDay: {
    day: { hdri: 'day_2k.hdr', exposure: 0.95, skyMedian: 0.32, sunAzimuth: 145 * DEG, sunIntensity: 3.2, fogDensity: 0.00045, water: 0x1d5f70, minElevation: 28 * DEG, hemi: 0.35 },
    dusk: { hdri: 'dusk_2k.hdr', exposure: 1.0, skyMedian: 0.2, sunColor: 0xffb070, sunAzimuth: -28 * DEG, sunIntensity: 2.2, fogDensity: 0.0007, water: 0x223344, minElevation: 7 * DEG, hemi: 0.3 },
    night: { hdri: 'night_1k.hdr', exposure: 1.15, skyMedian: 0.022, envBoost: 1.6, elevation: 32 * DEG, sunColor: 0x9fb6ff, sunAzimuth: 22 * DEG, sunIntensity: 0.45, fogDensity: 0.0009, water: 0x0b1a26, minElevation: 16 * DEG, hemi: 0.1, flares: true },
  },
};

export function aggressionLerp(a, lo, hi) {
  return lo + (hi - lo) * ((a - 1) / 8);
}
