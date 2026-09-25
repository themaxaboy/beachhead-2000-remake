import { loadScores, qualifies, addScore, loadProgress } from './Storage.js';
import { levelFileText, LEVEL_COUNT } from '../data/levels.js';
import { UNITS } from '../data/units.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString('en-US');

const TITLE = `
  <div class="title-block">
    <div class="title-small">DIGITAL FUSION CLASSIC · REIMAGINED</div>
    <h1 class="title">BEACH HEAD <span>2000</span></h1>
    <div class="title-sub">WEB REMAKE</div>
  </div>`;

/** All menu screens (DOM overlay). */
export class Menus {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('ui');
    this.screen = null;
    this.root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.preventDefault();
      game.audio?.play('click', { bus: 'ui' });
      this.onAction(btn.dataset.action, btn.dataset);
    });
    this.root.addEventListener('mouseover', (e) => {
      const btn = e.target.closest('button');
      if (btn && btn !== this.lastHover) {
        this.lastHover = btn;
        game.audio?.play('hover', { bus: 'ui', volume: 0.4 });
      }
    });
  }

  onAction(action, data) {
    const g = this.game;
    switch (action) {
      case 'play':
        return g.startCampaign(1, false);
      case 'levels':
        return this.show('levels');
      case 'level':
        return g.startCampaign(Number(data.level), true);
      case 'help':
        return this.show('help', { page: Number(data.page || 0) });
      case 'scores':
        return this.show('scores');
      case 'options':
        return this.show('options', { back: data.back || 'main' });
      case 'credits':
        return this.show('credits');
      case 'main':
        return this.show('main');
      case 'back':
        return this.show(data.to || 'main');
      case 'begin':
        return g.beginLevel();
      case 'resume':
        return g.resume();
      case 'quit':
        return g.quitToMenu();
      case 'next':
        return g.continueNext();
      case 'submit': {
        const input = this.root.querySelector('#name-input');
        addScore(input ? input.value.trim() : 'GUNNER', g.score, g.level.def.number);
        g.scoreSubmitted = true;
        return this.show('scores', { highlight: g.score });
      }
      case 'retry':
        return g.startCampaign(g.level.def.number, g.practice);
    }
  }

  hide() {
    this.root.innerHTML = '';
    this.root.className = '';
    this.screen = null;
  }

  show(name, data = {}) {
    this.screen = name;
    this.root.className = `screen-${name}`;
    const html = this[`render_${name}`](data);
    this.root.innerHTML = `<div class="panel-wrap">${html}</div>`;
    if (name === 'options') this.bindOptions(data);
    if (name === 'gameover') this.root.querySelector('#name-input')?.focus();
  }

  render_loading({ progress = 0, text = 'LOADING' }) {
    return `${TITLE}<div class="loading"><div class="lbar"><div style="width:${Math.round(progress * 100)}%"></div></div><div class="ltext">${esc(text)}</div></div>`;
  }

  render_click() {
    return `${TITLE}<button class="big pulse" data-action="main">CLICK TO ENTER</button>
      <p class="fine">Headphones recommended · Mouse &amp; keyboard required</p>`;
  }

  render_main() {
    return `${TITLE}
      <nav class="menu">
        <button data-action="play">PLAY</button>
        <button data-action="levels">LEVEL SELECT</button>
        <button data-action="help">HELP</button>
        <button data-action="scores">HIGH SCORES</button>
        <button data-action="options">OPTIONS</button>
        <button data-action="credits">CREDITS</button>
      </nav>
      <p class="fine">Unofficial fan remake for the web · Not affiliated with Digital Fusion Inc.</p>`;
  }

  render_levels() {
    const { highestLevel } = loadProgress();
    let cells = '';
    for (let i = 1; i <= LEVEL_COUNT; i++) {
      const locked = i > highestLevel;
      cells += `<button class="lvl${locked ? ' locked' : ''}" ${locked ? 'disabled' : `data-action="level" data-level="${i}"`}>${String(i).padStart(2, '0')}</button>`;
    }
    return `<h2>LEVEL SELECT</h2><p class="fine">Practice any mission you have reached. Practice scores are not recorded.</p>
      <div class="level-grid">${cells}</div>
      <button data-action="main">BACK</button>`;
  }

  render_help({ page = 0 }) {
    const tabs = ['GAME CONTROLS', 'GAME INTERFACE', 'GAME OVERVIEW']
      .map((t, i) => `<button class="tab${i === page ? ' active' : ''}" data-action="help" data-page="${i}">${t}</button>`)
      .join('');
    let body = '';
    if (page === 0) {
      body = `<table class="keys">
        <tr><td>Mouse</td><td>Rotate the turret (360°) and aim</td></tr>
        <tr><td>Left button</td><td>Fire (hold for automatic fire)</td></tr>
        <tr><td>Space / Right button</td><td>Toggle machine gun ↔ anti-tank gun</td></tr>
        <tr><td>M</td><td>Guided missiles (lock on to vehicles and aircraft)</td></tr>
        <tr><td>G</td><td>Handgun — replaces the right barrel, unlimited ammo</td></tr>
        <tr><td>H</td><td>155 mm howitzer (only on some missions)</td></tr>
        <tr><td>1 – 5 / Wheel</td><td>Select weapon</td></tr>
        <tr><td>R</td><td>Reload handgun</td></tr>
        <tr><td>+ / −</td><td>Mouse sensitivity</td></tr>
        <tr><td>Esc / P</td><td>Pause</td></tr>
      </table>`;
    } else if (page === 1) {
      body = `<div class="iface">
        <div class="mock">
          <div class="m-top"><span>SCORE</span><span>TIME · COMPASS</span><span>LEVEL</span></div>
          <div class="m-center">+</div>
          <div class="m-bottom"><span>SHIELD / ENEMY FORCE</span><span class="m-radar">RADAR</span><span>WEAPONS &amp; AMMO</span></div>
        </div>
        <ul>
          <li><b>Bunker shield</b> — your only life. When it reaches zero the game is over.</li>
          <li><b>Enemy force</b> — how much of the invasion force remains this mission.</li>
          <li><b>Radar</b> — the sea is at the top. Red squares: vehicles and boats. Orange triangles: aircraft. Blinking yellow: bombers. White: supply crates. The light wedge shows where you are looking.</li>
          <li><b>Weapons</b> — ammunition is limited per mission (except the handgun). Choose carefully.</li>
          <li><b>Compass</b> — SEA is straight ahead; enemies may also attack from the land behind you.</li>
        </ul></div>`;
    } else {
      const rows = Object.entries(UNITS)
        .map(([, u]) => `<tr><td>${u.name}</td><td>${fmt(u.score)}</td><td>${u.advice}</td></tr>`)
        .join('');
      body = `<div class="overview"><p>You are the lone gunner in a beach bunker. Wave after wave of landing craft, tanks,
        armoured personnel carriers, attack helicopters, fighters and bombers will try to take the beach.
        Destroy every enemy unit to complete the mission — bombers do not have to be destroyed.
        There are 60 missions and each one is harder than the last.</p>
        <p>A friendly supply plane drops crates by parachute: a crate with a yellow <b>X</b> holds ammunition,
        a white crate with a red cross repairs your shield. <b>Shoot the crate before it touches the ground</b> to receive it.</p>
        <table class="roster"><tr><th>Enemy</th><th>Points</th><th>Best weapon</th></tr>${rows}</table></div>`;
    }
    return `<h2>HELP</h2><div class="tabs">${tabs}</div><div class="help-body">${body}</div>
      <button data-action="main">BACK</button>`;
  }

  render_scores({ highlight } = {}) {
    const rows = loadScores()
      .map(
        (s, i) =>
          `<tr class="${highlight === s.score ? 'hl' : ''}"><td>${i + 1}</td><td>${esc(s.name)}</td><td>${fmt(s.score)}</td><td>${s.level}</td></tr>`,
      )
      .join('');
    return `<h2>HIGH SCORES</h2><table class="scores"><tr><th>#</th><th>NAME</th><th>SCORE</th><th>LEVEL</th></tr>${rows}</table>
      <button data-action="main">BACK</button>`;
  }

  render_options({ back = 'main' }) {
    const s = this.game.settings;
    const opt = (v, cur, label) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
    return `<h2>OPTIONS</h2>
      <div class="options">
        <label>Graphics quality<select data-k="quality">${opt('auto', s.quality, `Auto — ${(this.game.settings.autoTier || 'detect').replace(/^./, (c) => c.toUpperCase())}`)}${opt('low', s.quality, 'Low')}${opt('medium', s.quality, 'Medium')}${opt('high', s.quality, 'High')}${opt('ultra', s.quality, 'Ultra')}</select></label>
        <label>Mouse sensitivity <span class="v" id="v-sensitivity">${s.sensitivity}</span><input type="range" min="1" max="10" step="1" data-k="sensitivity" value="${s.sensitivity}"></label>
        <label>Field of view <span class="v" id="v-fov">${s.fov}°</span><input type="range" min="45" max="75" step="1" data-k="fov" value="${s.fov}"></label>
        <label>Master volume<input type="range" min="0" max="1" step="0.05" data-k="master" value="${s.master}"></label>
        <label>Effects volume<input type="range" min="0" max="1" step="0.05" data-k="sfx" value="${s.sfx}"></label>
        <label>Ambience volume<input type="range" min="0" max="1" step="0.05" data-k="ambience" value="${s.ambience}"></label>
        <label class="check"><input type="checkbox" data-k="invertY"${s.invertY ? ' checked' : ''}> Invert mouse Y</label>
        <label class="check"><input type="checkbox" data-k="autoPistol"${s.autoPistol ? ' checked' : ''}> Switch to handgun when out of bullets</label>
        <label class="check"><input type="checkbox" data-k="showFps"${s.showFps ? ' checked' : ''}> Show FPS</label>
      </div>
      <button data-action="back" data-to="${back}">BACK</button>`;
  }

  bindOptions() {
    this.root.querySelectorAll('[data-k]').forEach((el) => {
      el.addEventListener('input', () => {
        const k = el.dataset.k;
        let v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
        this.game.setSetting(k, v);
        const label = this.root.querySelector(`#v-${k}`);
        if (label) label.textContent = k === 'fov' ? `${v}°` : String(v);
      });
    });
  }

  render_credits() {
    return `<h2>CREDITS</h2><div class="credits">
      <p><b>Beach Head 2000</b> was created by Digital Fusion Inc. (2000). This is an unofficial, non-commercial fan remake
      built from scratch for the web — no original game assets are used.</p>
      <p>Engine: <a href="https://threejs.org" target="_blank" rel="noopener">three.js</a> (MIT) · Built with Vite.</p>
      <p>Sky HDRIs, sand / concrete / metal textures, crate, rock and barrel models:
      <a href="https://polyhaven.com" target="_blank" rel="noopener">Poly Haven</a> (CC0). Full list in <code>assets/CREDITS.md</code>.</p>
      <p>Vehicles, aircraft, soldiers, particles and every sound effect are generated procedurally in code.</p></div>
      <button data-action="main">BACK</button>`;
  }

  render_briefing({ def, practice }) {
    const u = def.units;
    const intel = [
      [u.infantryLCT, 'landing craft with infantry'],
      [u.tanks, 'M48 tanks'],
      [u.apcs, 'M113 APCs'],
      [u.jets, 'F-4 fighters'],
      [u.cobras, 'AH-1 attack helicopters'],
      [u.ch53, 'CH-53 troop transports'],
      [u.bomberRaids, 'B-52 bomber raids'],
    ]
      .filter(([n]) => n > 0)
      .map(([n, t]) => `<li><b>${n}</b> ${t}</li>`)
      .join('');
    const tod = { day: 'DAY', dusk: 'DUSK', night: 'NIGHT' }[def.timeOfDay];
    return `<div class="briefing">
      <div class="brief-head"><span>MISSION</span><b>${String(def.number).padStart(2, '0')}</b><span class="tod">${tod}${practice ? ' · PRACTICE' : ''}</span></div>
      <div class="brief-cols">
        <pre class="levelfile">${esc(levelFileText(def))}</pre>
        <div><h3>INTELLIGENCE</h3><ul class="intel">${intel}</ul>
        ${def.ammo.howitzer ? '<p class="note">155 mm howitzer available this mission (H).</p>' : ''}</div>
      </div>
      <button class="big pulse" data-action="begin">CLICK TO BEGIN</button>
      <p class="fine">The mouse will be captured — press Esc to pause.</p></div>`;
  }

  render_pause() {
    return `<h2>PAUSED</h2><nav class="menu">
      <button data-action="resume">RESUME</button>
      <button data-action="options" data-back="pause">OPTIONS</button>
      <button data-action="help">HELP</button>
      <button data-action="quit">QUIT TO MENU</button></nav>`;
  }

  render_complete({ def, stats, bonus, total }) {
    const kills = Object.entries(stats.kills)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `<tr><td>${UNITS[k]?.name || k}</td><td>${n}</td></tr>`)
      .join('');
    return `<h2>MISSION ${String(def.number).padStart(2, '0')} COMPLETE</h2>
      <div class="tally"><table>${kills}</table>
      <table class="bonus">
        <tr><td>Shield bonus</td><td>${fmt(bonus.shield)}</td></tr>
        <tr><td>Time bonus</td><td>${fmt(bonus.time)}</td></tr>
        <tr><td>Mission bonus</td><td>${fmt(bonus.level)}</td></tr>
        <tr class="total"><td>SCORE</td><td>${fmt(total)}</td></tr>
      </table></div>
      <button class="big" data-action="next">${def.number >= LEVEL_COUNT ? 'FINISH' : 'NEXT MISSION'}</button>`;
  }

  render_gameover({ score, level, practice }) {
    const q = !practice && qualifies(score);
    return `<h2 class="danger">BUNKER DESTROYED</h2>
      <p class="big-num">${fmt(score)}</p><p>Reached mission ${level}</p>
      ${q ? `<div class="name-entry"><label>NEW HIGH SCORE — ENTER YOUR NAME<input id="name-input" maxlength="10" value="GUNNER" autocomplete="off"></label><button data-action="submit">SUBMIT</button></div>` : ''}
      <nav class="menu"><button data-action="retry">RETRY MISSION</button><button data-action="main">MAIN MENU</button></nav>`;
  }

  render_victory({ score }) {
    const q = qualifies(score);
    return `<h2>BEACH HEAD HELD</h2><p>All 60 missions complete. The invasion has been repelled.</p>
      <p class="big-num">${fmt(score)}</p>
      ${q ? `<div class="name-entry"><label>NEW HIGH SCORE — ENTER YOUR NAME<input id="name-input" maxlength="10" value="GUNNER" autocomplete="off"></label><button data-action="submit">SUBMIT</button></div>` : ''}
      <button data-action="main">MAIN MENU</button>`;
  }

  render_touch() {
    return `${TITLE}<p>This game needs a mouse and keyboard. Please open it on a desktop or laptop computer.</p>`;
  }
}
