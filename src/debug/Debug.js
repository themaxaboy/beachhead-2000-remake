import { DEG } from '../core/math.js';
import { Bot } from './Bot.js';

/** window.__game helpers for automated tests and quick debugging (?debug adds cheat keys). */
export function installDebug(game) {
  const api = {
    game,
    get state() {
      return game.state;
    },
    get ready() {
      return !!game.ready;
    },
    async start(n = 1, practice = true) {
      game.bunker.invulnerable = false;
      game.bot = null;
      await game.startCampaign(n, practice);
      game.beginLevel();
      game.enterPlaying();
    },
    advance(sec) {
      game.advance(sec);
    },
    aim(yawDeg, pitchDeg) {
      game.yaw = yawDeg * DEG;
      game.pitch = pitchDeg * DEG;
      game.updateCamera(0);
    },
    aimAt(target) {
      const p = target.pos || target;
      const cam = game.camera.position;
      game.yaw = Math.atan2(p.x - cam.x, -(p.z - cam.z));
      game.pitch = Math.atan2(p.y - cam.y, Math.hypot(p.x - cam.x, p.z - cam.z));
      game.updateCamera(0);
    },
    fire(seconds = 1, step = 1 / 60) {
      game.input.fire = true;
      game.advance(seconds, step);
      game.input.fire = false;
      game.advance(step, step);
    },
    select(name) {
      game.weapons.select(name, true);
    },
    killAll() {
      for (const e of game.entities.list) if (e.alive && e.required) e.destroy('debug');
      game.infantry.forEachAlive((i) => game.infantry.kill(i, 'debug'));
      for (const ev of game.level.events) ev.done = true;
    },
    setBot(on = true) {
      game.bot = on ? new Bot(game) : null;
      if (!on) game.input.fire = false;
    },
    /** Plays a mission with the bot in simulated time and reports the outcome. */
    async simulate(n, maxSeconds = 900) {
      await api.start(n, true);
      api.setBot(true);
      let t = 0;
      while (t < maxSeconds && game.state === 'playing') {
        game.advance(1, 1 / 30);
        t += 1;
      }
      const w = game.weapons.ammo;
      const def = game.level.def;
      const res = {
        level: n,
        result: game.state === 'playing' ? 'timeout' : game.state === 'dying' || game.state === 'gameover' ? 'dead' : 'won',
        time: Math.round(game.level.time),
        limit: def.timeLimit,
        shield: Math.round(game.bunker.shield),
        force: Math.round(game.level.enemyForce * 100),
        ammoLeft: { mg: w.mg, at: w.at, missile: w.missile },
        ammoStart: { mg: def.ammo.bullets, at: def.ammo.projectiles, missile: def.ammo.missiles },
        crates: game.stats.crates,
        score: game.score,
        damageBy: Object.fromEntries(Object.entries(game.stats.damageBy).map(([k, v]) => [k, Math.round(v)])),
      };
      api.setBot(false);
      return res;
    },
    setInvulnerable(v = true) {
      game.bunker.invulnerable = v;
    },
    renderOnce() {
      game.draw(1 / 60);
    },
    hud(v) {
      document.getElementById('hud').style.visibility = v ? '' : 'hidden';
      document.getElementById('ui').style.visibility = v ? '' : 'hidden';
    },
    stats() {
      const info = game.renderer.renderer.info;
      return {
        fps: Math.round(game.fps),
        calls: info.render.calls,
        triangles: info.render.triangles,
        entities: game.entities.list.length,
        infantry: game.infantry.aliveCount,
        particles: game.effects.add.count + game.effects.alpha.count + game.effects.glow.count,
        state: game.state,
        time: game.level.time,
        shield: game.bunker.shield,
        score: game.score,
      };
    },
  };
  window.__bh = api;

  if (game.flags.debug) {
    window.addEventListener('keydown', (e) => {
      if (game.state !== 'playing') return;
      if (e.code === 'KeyK') api.killAll();
      if (e.code === 'KeyI') {
        game.bunker.invulnerable = !game.bunker.invulnerable;
        game.hud.toast(`INVULNERABLE ${game.bunker.invulnerable ? 'ON' : 'OFF'}`);
      }
      if (e.code === 'KeyF') {
        const d = game.level.def.ammo;
        Object.assign(game.weapons.ammo, { mg: d.bullets, at: d.projectiles, missile: d.missiles, howitzer: Math.max(3, d.howitzer) });
        game.hud.toast('AMMO REFILLED');
      }
      if (e.code === 'KeyN') {
        api.killAll();
      }
    });
  }
  return api;
}
