// localStorage wrappers (private windows can throw, so everything is guarded).
const SETTINGS_KEY = 'bh2k.settings.v1';
const SCORES_KEY = 'bh2k.hiscores.v1';
const PROGRESS_KEY = 'bh2k.progress.v1';

export const DEFAULT_SETTINGS = {
  quality: 'auto', // auto | low | medium | high | ultra
  autoTier: null, // tier auto quality settled on for autoGpu
  autoGpu: '',
  sensitivity: 5,
  invertY: false,
  fov: 58,
  master: 0.9,
  sfx: 1,
  ambience: 0.7,
  autoPistol: true,
  showFps: false,
};

const DEFAULT_SCORES = [
  ['SARGE', 250000, 30],
  ['GUNNY', 180000, 24],
  ['DUKE', 140000, 20],
  ['ACE', 100000, 16],
  ['BRAVO', 75000, 12],
  ['HAWK', 50000, 9],
  ['ROOKIE', 30000, 6],
  ['PVT', 15000, 4],
  ['CADET', 8000, 2],
  ['RECRUIT', 3000, 1],
].map(([name, score, level]) => ({ name, score, level, date: '2000-01-01' }));

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) };
}

export function saveSettings(s) {
  write(SETTINGS_KEY, s);
}

export function loadScores() {
  const s = read(SCORES_KEY, null);
  return Array.isArray(s) && s.length ? s : DEFAULT_SCORES.slice();
}

export function qualifies(score) {
  const s = loadScores();
  return score > 0 && (s.length < 10 || score > s[s.length - 1].score);
}

export function addScore(name, score, level) {
  const s = loadScores();
  s.push({ name: name.slice(0, 10).toUpperCase() || 'GUNNER', score, level, date: new Date().toISOString().slice(0, 10) });
  s.sort((a, b) => b.score - a.score);
  const top = s.slice(0, 10);
  write(SCORES_KEY, top);
  return top;
}

export function loadProgress() {
  const p = { highestLevel: 1, ...read(PROGRESS_KEY, {}) };
  // lastCleared: last campaign mission completed (older saves only kept highestLevel).
  if (!Number.isInteger(p.lastCleared)) p.lastCleared = Math.max(0, p.highestLevel - 1);
  return p;
}

/** Mission the campaign resumes from: the one after the last mission cleared. */
export function resumeLevel(levelCount) {
  const { lastCleared } = loadProgress();
  return lastCleared >= levelCount ? 1 : lastCleared + 1;
}

export function saveProgress(p) {
  write(PROGRESS_KEY, p);
}
