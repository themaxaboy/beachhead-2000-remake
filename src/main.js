import './styles/main.css';
import { Game } from './core/Game.js';
import { installDebug } from './debug/Debug.js';
import { QUALITY_OPTIONS } from './core/Quality.js';

const params = new URLSearchParams(window.location.search);
const num = (k) => (params.has(k) ? Number(params.get(k)) || 0 : 0);
const flags = {
  debug: params.has('debug'),
  nolock: params.has('nolock'),
  autostart: params.has('autostart'),
  level: Math.max(0, Math.min(60, num('level'))),
  seed: num('seed'),
  quality: QUALITY_OPTIONS.includes(params.get('quality')) ? params.get('quality') : null,
  time: ['day', 'dusk', 'night'].includes(params.get('time')) ? params.get('time') : null,
  mute: params.has('mute'),
  norender: params.has('norender'),
};

const touchOnly = window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches;

function fatal(err) {
  console.error(err);
  const ui = document.getElementById('ui');
  ui.innerHTML = `<div class="panel-wrap"><h2 class="danger">UNABLE TO START</h2><p>${String(err && err.message ? err.message : err)}</p>
    <p class="fine">This game needs a browser with WebGL 2 support.</p></div>`;
}

if (touchOnly && !flags.debug) {
  document.getElementById('ui').innerHTML =
    '<div class="panel-wrap"><h1 class="title">BEACH HEAD <span>2000</span></h1><p>This game needs a mouse and keyboard. Please open it on a desktop or laptop computer.</p></div>';
} else {
  try {
    const game = new Game(flags);
    installDebug(game);
    game.boot().catch(fatal);
  } catch (err) {
    fatal(err);
  }
}
