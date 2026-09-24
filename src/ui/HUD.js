import * as THREE from 'three';
import { Radar } from './Radar.js';
import { CONFIG } from '../config.js';

const _v = new THREE.Vector3();
const LABELS = {
  mg: 'BULLETS',
  at: 'PROJECTILES',
  missile: 'MISSILES',
  pistol: 'HANDGUN',
  howitzer: 'HOWITZER',
};
const KEYS = { mg: '1', at: '2', missile: '3 · M', pistol: '4 · G', howitzer: '5 · H' };

const CROSSHAIRS = {
  mg: `<svg viewBox="-50 -50 100 100"><circle r="15" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M-32 0H-19M19 0H32M0 -32V-19M0 19V32" stroke="currentColor" stroke-width="2"/><circle r="1.6" fill="currentColor"/></svg>`,
  at: `<svg viewBox="-50 -50 100 100"><path d="M-40 0H-8M8 0H40M0 -30V-8" stroke="currentColor" stroke-width="1.8"/><path d="M0 6V44M-6 14H6M-9 22H9M-12 30H12M-15 38H15" stroke="currentColor" stroke-width="1.4"/><circle r="1.8" fill="currentColor"/></svg>`,
  missile: `<svg viewBox="-50 -50 100 100"><rect x="-26" y="-20" width="52" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="10 6"/><path d="M-6 0H6M0 -6V6" stroke="currentColor" stroke-width="1.8"/></svg>`,
  pistol: `<svg viewBox="-50 -50 100 100"><circle r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M-16 0H-7M7 0H16M0 -16V-7M0 7V16" stroke="currentColor" stroke-width="1.6"/></svg>`,
  howitzer: `<svg viewBox="-50 -50 100 100"><circle r="30" fill="none" stroke="currentColor" stroke-width="1.6"/><circle r="8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M-44 0H-32M32 0H44M0 -44V-32M0 32V44" stroke="currentColor" stroke-width="2"/></svg>`,
};

/** DOM heads-up display modelled on the original's layout: radar, shield, enemy force, ammunition. */
export class HUD {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('hud');
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="hud-box score"><span class="lbl">SCORE</span><span id="hud-score" class="val">0</span></div>
        <div class="hud-center-top">
          <div id="hud-time" class="val">00:00</div>
          <div class="compass"><div id="hud-compass-tape" class="tape"></div><div class="caret"></div></div>
        </div>
        <div class="hud-box level"><span class="lbl">LEVEL</span><span id="hud-level" class="val">01</span></div>
      </div>
      <div id="hud-messages"></div>
      <div id="hud-crosshair"></div>
      <div id="hud-hit" class="hitmarker"><svg viewBox="-20 -20 40 40"><path d="M-12 -12L-5 -5M12 -12L5 -5M-12 12L-5 5M12 12L5 5" stroke="currentColor" stroke-width="2.5"/></svg></div>
      <div id="hud-lock" class="lock"><span>LOCK</span></div>
      <div id="hud-damage"></div>
      <div id="hud-popups"></div>
      <div class="hud-bottom">
        <div class="hud-panel status">
          <div class="bar-row"><span class="lbl">BUNKER SHIELD</span><span id="hud-shield-num" class="num">100</span></div>
          <div class="bar"><div id="hud-shield" class="fill shield"></div></div>
          <div class="bar-row"><span class="lbl">ENEMY FORCE</span><span id="hud-enemy-num" class="num">100%</span></div>
          <div class="bar"><div id="hud-enemy" class="fill enemy"></div></div>
          <div class="bar-row reload-row"><span class="lbl" id="hud-reload-lbl">READY</span></div>
          <div class="bar thin"><div id="hud-reload" class="fill reload"></div></div>
        </div>
        <div class="radar-wrap"><canvas id="hud-radar"></canvas></div>
        <div class="hud-panel weapons" id="hud-weapons"></div>
      </div>
      <div id="hud-toast"></div>`;
    this.el = {
      score: document.getElementById('hud-score'),
      time: document.getElementById('hud-time'),
      level: document.getElementById('hud-level'),
      compass: document.getElementById('hud-compass-tape'),
      messages: document.getElementById('hud-messages'),
      crosshair: document.getElementById('hud-crosshair'),
      hit: document.getElementById('hud-hit'),
      lock: document.getElementById('hud-lock'),
      damage: document.getElementById('hud-damage'),
      popups: document.getElementById('hud-popups'),
      shield: document.getElementById('hud-shield'),
      shieldNum: document.getElementById('hud-shield-num'),
      enemy: document.getElementById('hud-enemy'),
      enemyNum: document.getElementById('hud-enemy-num'),
      reload: document.getElementById('hud-reload'),
      reloadLbl: document.getElementById('hud-reload-lbl'),
      weapons: document.getElementById('hud-weapons'),
      toast: document.getElementById('hud-toast'),
    };
    this.buildCompass();
    this.weaponRows = {};
    for (const name of Object.keys(LABELS)) {
      const row = document.createElement('div');
      row.className = 'wrow';
      row.innerHTML = `<span class="key">${KEYS[name]}</span><span class="name">${LABELS[name]}</span><span class="count">0</span>`;
      this.el.weapons.appendChild(row);
      this.weaponRows[name] = { row, count: row.querySelector('.count') };
    }
    this.radar = new Radar(document.getElementById('hud-radar'));
    this.cache = {};
    this.hitTimer = 0;
    this.messageList = [];
    this.popups = [];
    this.arcs = [];
    this.visible = false;
    this.weaponChanged('mg');
  }

  buildCompass() {
    const marks = [];
    for (let d = -360; d <= 720; d += 15) {
      const deg = ((d % 360) + 360) % 360;
      const label = deg === 0 ? 'SEA' : deg === 90 ? 'E' : deg === 180 ? 'LAND' : deg === 270 ? 'W' : deg % 45 === 0 ? String(deg).padStart(3, '0') : '';
      marks.push(`<span class="mark${label ? ' major' : ''}" style="left:${(d + 360) * 4}px">${label || '|'}</span>`);
    }
    this.el.compass.innerHTML = marks.join('');
  }

  show(v) {
    this.visible = v;
    this.root.classList.toggle('visible', v);
  }

  set(key, value, el) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    el.textContent = value;
  }

  weaponChanged(name) {
    this.el.crosshair.innerHTML = CROSSHAIRS[name] || CROSSHAIRS.mg;
    this.el.crosshair.dataset.weapon = name;
    for (const [n, r] of Object.entries(this.weaponRows || {})) r.row.classList.toggle('active', n === name);
  }

  message(text, level = 'info') {
    const div = document.createElement('div');
    div.className = `msg ${level}`;
    div.textContent = text;
    this.el.messages.appendChild(div);
    this.messageList.push({ div, t: 0 });
    while (this.messageList.length > 4) this.messageList.shift().div.remove();
  }

  toast(text) {
    this.el.toast.textContent = text;
    this.el.toast.classList.remove('show');
    void this.el.toast.offsetWidth;
    this.el.toast.classList.add('show');
  }

  hitMarker(kill) {
    this.hitTimer = kill ? 0.3 : 0.12;
    this.el.hit.classList.toggle('kill', kill);
  }

  popup(worldPos, text) {
    if (this.popups.length > 6) this.popups.shift().div.remove();
    const div = document.createElement('div');
    div.className = 'popup';
    div.textContent = text;
    this.el.popups.appendChild(div);
    this.popups.push({ div, pos: worldPos.clone(), t: 0 });
  }

  damageFrom(from) {
    const game = this.game;
    const b = Math.atan2(from.x, -from.z);
    const rel = b - game.yaw;
    const div = document.createElement('div');
    div.className = 'arc';
    div.style.transform = `rotate(${rel}rad)`;
    this.el.damage.appendChild(div);
    this.arcs.push({ div, t: 0 });
    if (this.arcs.length > 6) this.arcs.shift().div.remove();
  }

  clear() {
    for (const m of this.messageList) m.div.remove();
    for (const p of this.popups) p.div.remove();
    for (const a of this.arcs) a.div.remove();
    this.messageList = [];
    this.popups = [];
    this.arcs = [];
  }

  update(dt) {
    const game = this.game;
    if (!this.visible) return;
    const level = game.level;
    const w = game.weapons;
    this.set('score', String(game.score).padStart(7, '0'), this.el.score);
    this.set('level', String(level.def.number).padStart(2, '0'), this.el.level);
    const left = level.overtime ? 0 : level.timeLeft;
    const mm = Math.floor(left / 60);
    const ss = Math.floor(left % 60);
    this.set('time', level.overtime ? 'OVERTIME' : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`, this.el.time);
    this.el.time.classList.toggle('warn', level.overtime || left < 20);

    // compass tape: 4px per degree
    const deg = ((game.yaw * 180) / Math.PI + 360) % 360;
    this.el.compass.style.transform = `translateX(${-(deg + 360) * 4}px)`;

    const shield = Math.ceil(game.bunker.shield);
    this.set('shieldNum', String(shield), this.el.shieldNum);
    if (this.cache.shieldW !== shield) {
      this.cache.shieldW = shield;
      this.el.shield.style.width = `${shield}%`;
      this.el.shield.dataset.level = shield > 50 ? 'ok' : shield > 25 ? 'warn' : 'danger';
    }
    const force = Math.round(level.enemyForce * 100);
    this.set('enemyNum', `${force}%`, this.el.enemyNum);
    if (this.cache.forceW !== force) {
      this.cache.forceW = force;
      this.el.enemy.style.width = `${force}%`;
    }
    const rf = w.reloadFraction;
    const rkey = Math.round(rf * 100);
    if (this.cache.reload !== rkey) {
      this.cache.reload = rkey;
      this.el.reload.style.width = `${rkey}%`;
    }
    let rl = 'READY';
    if (rf < 1) rl = w.current === 'pistol' ? 'RELOADING' : 'LOADING';
    if (w.current === 'missile') rl = `${game.projectiles.missilesAirborne}/${CONFIG.weapons.missile.maxAirborne} IN FLIGHT`;
    this.set('reloadLbl', rl, this.el.reloadLbl);

    for (const [name, r] of Object.entries(this.weaponRows)) {
      let v = name === 'pistol' ? `${w.ammo.pistol}/∞` : String(w.ammo[name]);
      this.set(`w-${name}`, v, r.count);
      const empty = name !== 'pistol' && w.ammo[name] <= 0;
      if (this.cache[`we-${name}`] !== empty) {
        this.cache[`we-${name}`] = empty;
        r.row.classList.toggle('empty', empty);
      }
      const hide = name === 'howitzer' && level.def.ammo.howitzer === 0 && w.ammo.howitzer === 0;
      if (this.cache[`wh-${name}`] !== hide) {
        this.cache[`wh-${name}`] = hide;
        r.row.style.display = hide ? 'none' : '';
      }
    }

    // missile lock bracket
    const lt = w.lockTarget;
    if (lt && lt.alive) {
      _v.copy(lt.pos).project(game.camera);
      if (_v.z < 1) {
        const x = (_v.x * 0.5 + 0.5) * window.innerWidth;
        const y = (-_v.y * 0.5 + 0.5) * window.innerHeight;
        this.el.lock.style.transform = `translate(${x}px, ${y}px)`;
        this.el.lock.classList.add('on');
        this.el.lock.classList.toggle('locked', w.lockTime > 0.35);
      } else this.el.lock.classList.remove('on');
    } else this.el.lock.classList.remove('on');

    this.hitTimer -= dt;
    this.el.hit.classList.toggle('on', this.hitTimer > 0);

    for (let i = this.messageList.length - 1; i >= 0; i--) {
      const m = this.messageList[i];
      m.t += dt;
      if (m.t > 4) {
        m.div.remove();
        this.messageList.splice(i, 1);
      } else if (m.t > 3.3) m.div.style.opacity = String((4 - m.t) / 0.7);
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.t += dt;
      _v.copy(p.pos).project(game.camera);
      if (p.t > 1.4 || _v.z > 1) {
        p.div.remove();
        this.popups.splice(i, 1);
        continue;
      }
      const x = (_v.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-_v.y * 0.5 + 0.5) * window.innerHeight - p.t * 40;
      p.div.style.transform = `translate(${x}px, ${y}px)`;
      p.div.style.opacity = String(Math.min(1, (1.4 - p.t) * 2));
    }
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i];
      a.t += dt;
      if (a.t > 1.2) {
        a.div.remove();
        this.arcs.splice(i, 1);
      } else a.div.style.opacity = String(1 - a.t / 1.2);
    }
    this.radar.draw(game, dt);
  }
}
