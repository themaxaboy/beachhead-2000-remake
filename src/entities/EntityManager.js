/** Owns every vehicle / aircraft entity. */
export class EntityManager {
  constructor(game) {
    this.game = game;
    this.list = [];
  }

  add(e) {
    this.list.push(e);
    return e;
  }

  update(dt) {
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (e.removed) continue;
      e.update(dt);
      if (!e.removed) e.sync();
    }
    // compact removed entities
    let w = 0;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (!e.removed) this.list[w++] = e;
    }
    this.list.length = w;
  }

  /** Units that still have to be destroyed for the mission to end. */
  requiredAlive() {
    let n = 0;
    for (const e of this.list) if (e.alive && e.required) n++;
    return n;
  }

  byType(type) {
    return this.list.filter((e) => e.type === type && e.alive);
  }

  clear() {
    for (const e of this.list) e.remove();
    this.list.length = 0;
  }
}
