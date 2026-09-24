/** Circular radar: bunker at the centre, the sea at the top, 360° coverage. */
export class Radar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.range = 1300;
    this.sweep = 0;
    this.acc = 0;
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const css = this.canvas.clientWidth || 180;
    this.canvas.width = Math.round(css * dpr);
    this.canvas.height = Math.round(css * dpr);
    this.size = this.canvas.width;
  }

  draw(game, dt) {
    this.sweep = (this.sweep + dt * Math.PI) % (Math.PI * 2);
    this.acc += dt;
    if (this.acc < 1 / 30) return;
    this.acc = 0;
    if (this.canvas.clientWidth && Math.abs(this.canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1) - this.size) > 2) this.resize();
    const ctx = this.ctx;
    const S = this.size;
    const c = S / 2;
    const R = c - 3;
    const scale = R / this.range;
    ctx.clearRect(0, 0, S, S);

    // background
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.clip();
    const bg = ctx.createRadialGradient(c, c, 0, c, c, R);
    bg.addColorStop(0, 'rgba(18,40,22,0.88)');
    bg.addColorStop(1, 'rgba(6,16,8,0.9)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, S, S);
    // sea (upper half, beyond the shoreline)
    ctx.fillStyle = 'rgba(40,110,140,0.22)';
    ctx.fillRect(0, 0, S, c - 120 * scale);

    // range rings
    ctx.strokeStyle = 'rgba(140,220,120,0.22)';
    ctx.lineWidth = 1;
    for (const r of [250, 500, 1000]) {
      ctx.beginPath();
      ctx.arc(c, c, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(c, c - R);
    ctx.lineTo(c, c + R);
    ctx.moveTo(c - R, c);
    ctx.lineTo(c + R, c);
    ctx.stroke();

    // view cone
    const yaw = game.yaw;
    const half = ((game.camera.fov * game.camera.aspect) / 2) * (Math.PI / 180);
    ctx.fillStyle = 'rgba(170,255,140,0.10)';
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, R, yaw - half - Math.PI / 2, yaw + half - Math.PI / 2);
    ctx.closePath();
    ctx.fill();

    // sweep
    const sg = ctx.createConicGradient ? ctx.createConicGradient(this.sweep - Math.PI / 2 - 0.6, c, c) : null;
    if (sg) {
      sg.addColorStop(0, 'rgba(120,255,120,0)');
      sg.addColorStop(0.095, 'rgba(120,255,120,0.18)');
      sg.addColorStop(0.096, 'rgba(120,255,120,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(0, 0, S, S);
    }

    const dot = (x, z, color, size, shape = 'dot', blink = false) => {
      if (blink && Math.floor(game.time * 4) % 2) return;
      let px = x * scale;
      let pz = z * scale;
      const d = Math.hypot(px, pz);
      let edge = false;
      if (d > R - 4) {
        px *= (R - 4) / d;
        pz *= (R - 4) / d;
        edge = true;
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      if (shape === 'tri') {
        ctx.moveTo(c + px, c + pz - size * 1.2);
        ctx.lineTo(c + px - size, c + pz + size * 0.8);
        ctx.lineTo(c + px + size, c + pz + size * 0.8);
        ctx.closePath();
      } else if (shape === 'square') {
        ctx.rect(c + px - size, c + pz - size, size * 2, size * 2);
      } else {
        ctx.arc(c + px, c + pz, edge ? size * 0.8 : size, 0, Math.PI * 2);
      }
      ctx.fill();
    };

    const k = S / 180;
    game.infantry.forEachAlive((i) => dot(game.infantry.x[i], game.infantry.z[i], 'rgba(255,90,70,0.9)', 1.3 * k));
    for (const e of game.entities.list) {
      if (!e.alive || e.removed) continue;
      switch (e.radarKind) {
        case 'sea':
          dot(e.pos.x, e.pos.z, '#ff7a4a', 3 * k, 'square');
          break;
        case 'ground':
          dot(e.pos.x, e.pos.z, '#ff4a3a', 2.8 * k, 'square');
          break;
        case 'air':
          dot(e.pos.x, e.pos.z, '#ffb03a', 3 * k, 'tri');
          break;
        case 'bomber':
          dot(e.pos.x, e.pos.z, '#ffe14a', 3.6 * k, 'tri', true);
          break;
        case 'friendly':
          dot(e.pos.x, e.pos.z, '#6ad0ff', 3 * k, 'tri');
          break;
      }
    }
    for (const cr of game.crates) if (cr.active) dot(cr.pos.x, cr.pos.z, '#ffffff', 2.4 * k, 'square', true);

    // bunker
    ctx.fillStyle = '#b9ff9a';
    ctx.beginPath();
    ctx.arc(c, c, 2.5 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(160,230,140,0.55)';
    ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.stroke();
  }
}
