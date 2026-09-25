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

  // Graphics tiers. `auto` picks one from the GPU and then scales the resolution between dynResMin and pixelRatio.
  // post 'direct' renders straight to the canvas (no half-float composer targets): the biggest saving on old iGPUs.
  // water: q = shader feature level 0..3, waves = Gerstner count, grid = [angular, radial] segments,
  //        reflection = planar reflection target size (0 = sky/environment only), wakes = boats with foam wakes.
  quality: {
    low: {
      pixelRatio: 0.75, dynResMin: 0.5, post: 'direct', shadows: 0, bloom: false, msaa: 0, godRays: false,
      water: { q: 0, waves: 4, grid: [192, 72], reflection: 0, wakes: 0 },
      terrainSeg: 192, particles: 1200, grass: 0, explosionLights: 1,
    },
    medium: {
      pixelRatio: 1, dynResMin: 0.6, post: 'composer', shadows: 1024, bloom: true, msaa: 2, godRays: false,
      water: { q: 1, waves: 6, grid: [320, 110], reflection: 256, wakes: 4 },
      terrainSeg: 256, particles: 3000, grass: 1400, explosionLights: 2,
    },
    high: {
      pixelRatio: 1.25, dynResMin: 0.75, post: 'composer', shadows: 2048, bloom: true, msaa: 4, godRays: true,
      water: { q: 2, waves: 8, grid: [448, 150], reflection: 512, wakes: 6 },
      terrainSeg: 320, particles: 5000, grass: 3000, explosionLights: 4,
    },
    ultra: {
      pixelRatio: 2, dynResMin: 1, post: 'composer', shadows: 4096, bloom: true, msaa: 4, godRays: true,
      water: { q: 3, waves: 8, grid: [640, 200], reflection: 1024, wakes: 8 },
      terrainSeg: 400, particles: 5000, grass: 5000, explosionLights: 4,
    },
  },

  // grade = [saturation, contrast, warmth] (composer tiers), godRays = sun-shaft strength (High/Ultra),
  // whitecaps = open-sea foam amount.
  timeOfDay: {
    day: { hdri: 'day_2k.hdr', exposure: 0.95, skyMedian: 0.32, sunAzimuth: 145 * DEG, sunIntensity: 3.2, fogDensity: 0.00045, water: 0x1d5f70, minElevation: 28 * DEG, hemi: 0.35, grade: [1.06, 1.04, 0.015], godRays: 0.35, whitecaps: 0.5 },
    dusk: { hdri: 'dusk_2k.hdr', exposure: 1.0, skyMedian: 0.2, sunColor: 0xffb070, sunAzimuth: -28 * DEG, sunIntensity: 2.2, fogDensity: 0.0007, water: 0x223344, minElevation: 7 * DEG, hemi: 0.3, grade: [1.1, 1.05, 0.04], godRays: 0.9, whitecaps: 0.45 },
    night: { hdri: 'night_1k.hdr', exposure: 1.15, skyMedian: 0.022, envBoost: 1.6, elevation: 32 * DEG, sunColor: 0x9fb6ff, sunAzimuth: 22 * DEG, sunIntensity: 0.45, fogDensity: 0.0009, water: 0x0b1a26, minElevation: 16 * DEG, hemi: 0.1, flares: true, grade: [0.95, 1.03, -0.03], godRays: 0, whitecaps: 0.4 },
  },
};

export function aggressionLerp(a, lo, hi) {
  return lo + (hi - lo) * ((a - 1) / 8);
}
