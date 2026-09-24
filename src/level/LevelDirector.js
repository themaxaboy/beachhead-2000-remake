import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { UNITS } from '../data/units.js';
import { shoreZ } from '../world/Terrain.js';
import { rng } from '../core/rng.js';
import { lerp } from '../core/math.js';
import { LandingCraft } from '../entities/LandingCraft.js';
import { Jet, Bomber, SupplyPlane } from '../entities/Aircraft.js';
import { Cobra, CH53 } from '../entities/Helicopters.js';

const AIR_TYPES = new Set(['jet', 'cobra', 'ch53']);

/** Runs a mission: spawns the schedule, supply drops, overtime raids and checks for victory. */
export class LevelDirector {
  constructor(game) {
    this.game = game;
    this.def = null;
    this.time = 0;
  }

  get progress() {
    return this.def ? (this.def.number - 1) / 59 : 0;
  }

  start(def) {
    this.def = def;
    this.time = 0;
    this.events = def.schedule.map((e) => ({ ...e, done: false }));
    const u = def.units;
    this.totalForce =
      (u.infantryLCT + u.tanks + u.apcs) * UNITS.lct.force +
      u.tanks * UNITS.tank.force +
      u.apcs * UNITS.apc.force +
      u.jets * UNITS.jet.force +
      u.cobras * UNITS.cobra.force +
      u.ch53 * UNITS.ch53.force +
      def.totalInfantry * UNITS.infantry.force;
    this.removedForce = 0;
    const s = CONFIG.supply;
    this.nextSupply = rng.range(s.firstMin, s.firstMax);
    this.lastSupply = -999;
    this.cratesLeft = 3 + Math.floor(def.number / 10);
    this.overtime = false;
    this.nextOvertimeRaid = 0;
    this.nextFlare = 3;
    this.announced = new Set();
    this.complete = false;
  }

  unitRemoved(e) {
    if (e.forceCounted) return;
    e.forceCounted = true;
    this.removedForce += e.def.force || 0;
  }

  infantryRemoved(n = 1) {
    this.removedForce += n * UNITS.infantry.force;
  }

  get enemyForce() {
    if (!this.totalForce) return 0;
    return Math.max(0, Math.min(1, 1 - this.removedForce / this.totalForce));
  }

  get timeLeft() {
    return Math.max(0, this.def.timeLimit - this.time);
  }

  pendingEvents() {
    return this.events.some((e) => !e.done && e.kind !== 'bomberRaid');
  }

  isComplete() {
    return !this.pendingEvents() && this.game.entities.requiredAlive() === 0 && this.game.infantry.aliveCount === 0;
  }

  update(dt) {
    const game = this.game;
    this.time += dt;
    const caps = this.def.caps;
    let lctAlive = 0;
    let airAlive = 0;
    for (const e of game.entities.list) {
      if (!e.alive) continue;
      if (e.type === 'lct' && e.required) lctAlive++;
      if (AIR_TYPES.has(e.type)) airAlive++;
    }
    for (const ev of this.events) {
      if (ev.done || ev.t > this.time) continue;
      if (ev.kind === 'lct') {
        if (lctAlive >= caps.lct || game.infantry.aliveCount > caps.infantry) continue;
        this.spawnLCT(ev);
        lctAlive++;
      } else if (AIR_TYPES.has(ev.kind)) {
        if (airAlive >= caps.air) continue;
        this.spawnAir(ev.kind);
        airAlive++;
      } else if (ev.kind === 'bomberRaid') {
        this.spawnRaid(ev.count);
      }
      ev.done = true;
    }

    // Time limit: after it runs out bombers keep coming until the beach is clear.
    if (!this.overtime && this.time >= this.def.timeLimit && CONFIG.rules.overtime === 'bombers') {
      this.overtime = true;
      this.nextOvertimeRaid = this.time + 4;
      game.hud.message('TIME UP — BOMBERS INBOUND', 'danger');
    }
    if (this.overtime && this.time >= this.nextOvertimeRaid) {
      this.nextOvertimeRaid = this.time + CONFIG.rules.overtimeRaidInterval;
      this.spawnRaid(this.def.units.bombersPerRaid);
    }

    this.updateSupply();

    if (game.world.timeOfDay === 'night') {
      this.nextFlare -= dt;
      if (this.nextFlare <= 0) {
        this.nextFlare = rng.range(14, 20);
        game.effects.dropFlare(rng.range(-160, 160), 190, rng.range(-150, -60));
      }
    }

    if (!this.complete && this.time > 3 && this.isComplete()) {
      this.complete = true;
      game.onLevelComplete();
    }
  }

  updateSupply() {
    const game = this.game;
    const s = CONFIG.supply;
    if (this.cratesLeft <= 0) return;
    const w = game.weapons;
    const lowAmmo = w.ammo.mg < this.def.ammo.bullets * 0.25;
    const lowShield = game.bunker.shield < 40;
    if ((lowAmmo || lowShield) && this.nextSupply - this.time > s.urgentMax && this.time - this.lastSupply > s.minGap) {
      this.nextSupply = this.time + rng.range(s.urgentMin, s.urgentMax);
    }
    if (this.time >= this.nextSupply) {
      this.lastSupply = this.time;
      this.nextSupply = this.time + rng.range(s.intervalMin, s.intervalMax);
      const n = Math.min(this.cratesLeft, rng.chance(0.5) ? 2 : 1);
      this.cratesLeft -= n;
      const kinds = [];
      for (let i = 0; i < n; i++) {
        let kind;
        if (game.bunker.shield <= 50) kind = rng.chance(0.7) ? 'shield' : 'ammo';
        else if (w.ammo.mg < this.def.ammo.bullets * 0.3) kind = rng.chance(0.8) ? 'ammo' : 'shield';
        else kind = rng.chance(0.5) ? 'ammo' : 'shield';
        kinds.push(kind);
      }
      const bearing = Math.PI + rng.range(-0.7, 0.7);
      game.entities.add(new SupplyPlane(game, { bearing, crates: kinds }));
      game.hud.message('SUPPLY DROP INBOUND — SHOOT THE CRATES', 'info');
      game.audio?.play('radio', { bus: 'ui' });
    }
  }

  announce(key, text, level = 'info') {
    if (this.announced.has(key) && key !== 'raid') return;
    this.announced.add(key);
    this.game.hud.message(text, level);
    this.game.audio?.play('radio', { bus: 'ui' });
  }

  spawnLCT(ev) {
    const zone = this.def.zones[ev.zone] || this.def.zones[0];
    const landX = zone.x + rng.range(-zone.width / 2, zone.width / 2);
    const z = shoreZ(landX) - rng.range(290, 350);
    const x = landX + rng.range(-50, 50);
    this.game.entities.add(new LandingCraft(this.game, { x, z, landX, cargo: ev.cargo }));
    this.announce('lct', 'LANDING CRAFT APPROACHING');
  }

  spawnAir(kind) {
    const level = this.def.number;
    const game = this.game;
    if (kind === 'jet') {
      const bearing = level >= 20 && rng.chance(0.5) ? rng.range(-Math.PI, Math.PI) : rng.range(-1.35, 1.35);
      game.entities.add(new Jet(game, { bearing }));
      this.announce('jet', 'ENEMY AIRCRAFT INBOUND', 'warn');
    } else if (kind === 'cobra') {
      const bearing = level >= 15 && rng.chance(0.4) ? rng.range(-Math.PI, Math.PI) : rng.range(-1.3, 1.3);
      game.entities.add(new Cobra(game, { bearing }));
      this.announce('cobra', 'ATTACK HELICOPTER', 'warn');
    } else if (kind === 'ch53') {
      game.entities.add(new CH53(game, { bearing: rng.range(-0.9, 0.9) }));
      this.announce('ch53', 'TROOP TRANSPORT — PARATROOPERS', 'warn');
    }
  }

  spawnRaid(count) {
    const game = this.game;
    const bearing = rng.range(-Math.PI, Math.PI);
    const lateral = lerp(120, 0, this.progress) * rng.sign() + rng.range(-20, 20);
    for (let i = 0; i < count; i++) {
      const side = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 70;
      game.entities.add(new Bomber(game, { bearing, lateral: lateral + side, trail: i * 90 }));
    }
    game.audio?.play('siren', { bus: 'ui' });
    this.announce('raid', 'AIR RAID — BOMBERS INBOUND', 'danger');
  }
}

export { THREE };
