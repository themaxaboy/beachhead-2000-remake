// Props: parachutes, supply crates, Czech hedgehogs, sandbags, concertina wire.
import * as THREE from 'three';
import { Kit, xf, box, cbox, cyl, node, instance, pick, PI, strut, v3, mergeAll, cachedGeometry, extrude, beam } from './geom.js';
import { mulberry32 } from './materials.js';

// ---------------------------------------------------------------------------
// Parachute: canopy top at y ~= 2.2 * radius, rim at ~1.45 * radius, lines converge at the origin (load point)
// ---------------------------------------------------------------------------
function buildParachuteTemplate(mats, radius, forCrate) {
  const root = new THREE.Group();
  root.name = forCrate ? 'cargoChute' : 'parachute';
  const canopy = node('canopy', null, null, root);
  const gores = forCrate ? 12 : 16;
  const segs = gores * 2;
  const R = radius, H = 0.78 * R, rimY = 1.45 * R;
  // canopy profile from the apex vent to the skirt
  const prof = [];
  const steps = 7;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = 0.06 + t * (PI / 2 + 0.08);
    prof.push(new THREE.Vector2(Math.max(0.02 * R, R * Math.sin(a)), rimY + H * Math.cos(a)));
  }
  // LatheGeometry wants increasing y for outward normals -> reverse (skirt to apex)
  prof.reverse();
  const g = new THREE.LatheGeometry(prof, segs);
  // scallops: billow the gore centres (odd segments) outward and lift the skirt between lines
  const pos = g.attributes.position, uv = g.attributes.uv;
  const np = prof.length;
  for (let s = 0; s <= segs; s++) {
    const mid = s % 2 === 1;
    for (let j = 0; j < np; j++) {
      const idx = s * np + j;
      const x = pos.getX(idx), y = pos.getY(idx), z = pos.getZ(idx);
      const tt = j / (np - 1); // 0 at skirt, 1 at apex
      let k = 1;
      if (mid) k = 1 + 0.07 * Math.sin((1 - tt) * PI * 0.9 + 0.2);
      let yy = y;
      if (j === 0 && mid) yy += 0.05 * R;
      pos.setXYZ(idx, x * k, yy, z * k);
      // texture: one panel per gore (texture has 8 panels) ; crate chutes use only the olive panel
      uv.setXY(idx, forCrate ? 0.0625 : (s / segs) * (gores / 8), tt);
    }
  }
  g.computeVertexNormals();
  const k = new Kit({ uvScale: 0.5 });
  k.add('canopyCloth', g, { uv: 'keep' });
  // suspension lines from the seams to the origin
  for (let s = 0; s < gores; s++) {
    const a = (s / gores) * PI * 2;
    const p = v3(Math.sin(a) * R, rimY, Math.cos(a) * R);
    k.add('cord', strut(p, v3(0, 0.15 * R, 0), 0.008 * Math.max(1, R / 3), 3));
  }
  // risers / harness point
  k.add('cord', strut(v3(0, 0.15 * R, 0), v3(0, 0, 0), 0.025, 4));
  k.build(mats, canopy, { name: 'chute' });
  return root;
}

export function buildParachute(mats, radius = 3.5, forCrate = false) {
  const r = Math.round((radius || 3.5) * 100) / 100;
  const root = instance(`parachute:${r}:${forCrate ? 1 : 0}`, mats, (m) => buildParachuteTemplate(m, r, !!forCrate));
  return pick(root, 'canopy');
}

// ---------------------------------------------------------------------------
// Supply crate: ~1.2 m cube, origin at the bottom centre
// ---------------------------------------------------------------------------
function buildCrateTemplate(mats, kind) {
  const root = new THREE.Group();
  root.name = `crate:${kind}`;
  const k = new Kit({ uvScale: 0.8 });
  const S = 1.2, f = 0.1, h = S / 2;
  k.add(kind === 'shield' ? 'crateShield' : 'crateAmmo', box(S - 0.04, S - 0.04, S - 0.04, [0, h, 0]), { uv: 'keep' });
  // frame battens along all 12 edges
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    k.add('crateWood', cbox(S, f, f, 0.012, [0, h + a * (h - f / 2), b * (h - f / 2)]));
    k.add('crateWood', cbox(f, S - 2 * f, f, 0.012, [a * (h - f / 2), h, b * (h - f / 2)]));
    k.add('crateWood', cbox(f, f, S - 2 * f, 0.012, [a * (h - f / 2), h + b * (h - f / 2), 0]));
  }
  // skids + steel corner brackets + lifting straps
  for (const x of [-0.4, 0.4]) k.add('crateWood', cbox(0.12, 0.08, S, 0.01, [x, -0.02, 0]));
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    k.add('darkMetal', box(0.13, 0.13, 0.13, [a * (h - 0.055), S - 0.055, b * (h - 0.055)]));
  }
  for (const x of [-0.25, 0.25]) k.add('webbing', box(0.06, 0.012, S + 0.02, [x, S + 0.006, 0]));
  k.build(mats, root, { name: 'crate' });
  return root;
}

export function buildSupplyCrate(mats, kind = 'ammo') {
  const kd = kind === 'shield' ? 'shield' : 'ammo';
  const root = instance(`crate:${kd}`, mats, (m) => buildCrateTemplate(m, kd));
  return { root };
}

// ---------------------------------------------------------------------------
// Czech hedgehog: 3 crossed I-beams resting on three ends; origin at ground centre
// ---------------------------------------------------------------------------
function iBeamGeo(len, w = 0.17, d = 0.17, tf = 0.017, tw = 0.012) {
  const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, -d / 2 + tf], [tw / 2, -d / 2 + tf], [tw / 2, d / 2 - tf], [w / 2, d / 2 - tf],
    [w / 2, d / 2], [-w / 2, d / 2], [-w / 2, d / 2 - tf], [-tw / 2, d / 2 - tf], [-tw / 2, -d / 2 + tf], [-w / 2, -d / 2 + tf]];
  const g = extrude(pts, len, 0, 1); // along Z, centred
  // UVs: u along the beam, v across -> the rust texture's rolled bands run along the beam
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getZ(i) * 0.32 + 0.5, (pos.getX(i) + pos.getY(i)) * 0.22 + 0.33);
  return g;
}

export function hedgehogGeometry() {
  return cachedGeometry('hedgehog', () => {
    const L = 2.9;
    const q = new THREE.Quaternion().setFromUnitVectors(v3(1, 1, 1).normalize(), v3(0, 1, 0));
    const qy = new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), 0.3);
    q.premultiply(qy);
    const m = new THREE.Matrix4();
    const parts = [];
    const axes = [[v3(1, 0, 0), v3(0, 0.07, 0)], [v3(0, 1, 0), v3(0, 0, 0.07)], [v3(0, 0, 1), v3(0.07, 0, 0)]];
    for (const [ax, off] of axes) {
      const g = iBeamGeo(L);
      const qa = new THREE.Quaternion().setFromUnitVectors(v3(0, 0, 1), ax);
      m.compose(off, qa, v3(1, 1, 1));
      g.applyMatrix4(m);
      parts.push(g);
    }
    // gusset plates + bolts at the crossing
    parts.push(box(0.34, 0.34, 0.02, [0, 0, 0.1]), box(0.02, 0.34, 0.34, [0.1, 0, 0]), box(0.34, 0.02, 0.34, [0, 0.1, 0]));
    for (const [x, y, z] of [[0.1, 0.1, 0.11], [-0.1, 0.1, 0.11], [0.1, -0.1, 0.11], [-0.1, -0.1, 0.11]]) parts.push(cyl(0.022, 0.022, 0.04, 6, 'z', false, [x, y, z]));
    for (const g of parts.slice(3)) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.1 + 0.2, uv.getY(i) * 0.05 + 0.3); }
    m.compose(v3(), q, v3(1, 1, 1));
    for (const g of parts) g.applyMatrix4(m);
    const merged = mergeAll(parts, { uv: 'keep' });
    merged.computeBoundingBox();
    merged.translate(0, -merged.boundingBox.min.y, 0);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  });
}

export function buildHedgehog(mats) {
  const root = instance('hedgehog', mats, (m) => {
    const r = new THREE.Group();
    r.name = 'hedgehog';
    const mesh = new THREE.Mesh(hedgehogGeometry(), m.hedgehog);
    mesh.name = 'hedgehog:mesh';
    mesh.userData.matKey = 'hedgehog';
    mesh.castShadow = mesh.receiveShadow = true;
    r.add(mesh);
    return r;
  });
  return { root };
}

// ---------------------------------------------------------------------------
// Sandbag: ~0.6 x 0.15 x 0.35 m pillow, origin at the bottom centre (y 0..0.15)
// ---------------------------------------------------------------------------
export function sandbagGeometry() {
  return cachedGeometry('sandbag', () => {
    const g = new THREE.SphereGeometry(1, 14, 8);
    const pos = g.attributes.position, uv = g.attributes.uv;
    const sp = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      // super-ellipsoid: boxy footprint, rounded top
      x = sp(x, 0.35); z = sp(z, 0.4); y = sp(y, 0.75);
      // sag: thinner towards the ends, flat bottom, tied end pinch at +x
      const endT = Math.max(0, x - 0.82) / 0.18;
      y *= (1 - 0.35 * x * x) * (y < 0 ? 0.55 : 1);
      z *= 1 - 0.1 * x * x - 0.35 * endT;
      y *= 1 - 0.4 * endT;
      pos.setXYZ(i, x * 0.3, y * 0.098, z * 0.175);
      uv.setXY(i, uv.getX(i) * 4, uv.getY(i) * 2);
    }
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.translate(0, -g.boundingBox.min.y, 0);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  });
}

// ---------------------------------------------------------------------------
// Concertina (barbed) wire along +X from x = 0 to x = length, resting on the ground
// ---------------------------------------------------------------------------
class HelixCurve extends THREE.Curve {
  constructor(length, radius, pitch, seed) {
    super();
    this.length = length; this.radius = radius; this.pitch = pitch;
    const rnd = mulberry32(seed);
    this.wob = [rnd(), rnd(), rnd()].map((v) => v * PI * 2);
  }
  getPoint(t, target = new THREE.Vector3()) {
    const turns = this.length / this.pitch;
    const a = t * turns * PI * 2;
    const r = this.radius * (1 + 0.06 * Math.sin(a * 0.37 + this.wob[0]) + 0.04 * Math.sin(a * 1.9 + this.wob[1]));
    // loops overlap back and forth slightly like a real concertina
    const x = t * this.length + Math.sin(a) * this.pitch * 0.35;
    return target.set(x, this.radius + Math.sin(a) * r, Math.cos(a) * r);
  }
}

export function barbedWireGeometry(length = 10) {
  const L = Math.max(1, Math.round(length * 10) / 10);
  return cachedGeometry(`wire:${L}`, () => {
    const parts = [];
    const R = 0.45, pitch = 0.28;
    const turns = L / pitch;
    const curve = new HelixCurve(L, R, pitch, 7);
    parts.push(new THREE.TubeGeometry(curve, Math.ceil(turns * 10), 0.006, 3, false));
    // straight strands
    for (const [y, z] of [[0.05, 0.3], [0.05, -0.3], [0.9, 0.0]]) parts.push(strut(v3(0, y, z), v3(L, y, z), 0.005, 3));
    // barbs on the straight strands every 0.25 m
    for (let x = 0.12; x < L; x += 0.25) for (const [y, z] of [[0.05, 0.3], [0.05, -0.3], [0.9, 0.0]]) {
      parts.push(strut(v3(x, y - 0.02, z - 0.02), v3(x + 0.01, y + 0.02, z + 0.02), 0.004, 3));
    }
    // pickets (angle-iron stakes)
    const n = Math.max(2, Math.round(L / 3) + 1);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * L;
      for (const z of [0.5, -0.5]) parts.push(beam(v3(x, -0.1, z), v3(x + 0.02, 1.05, z * 0.9), 0.04, 0.04));
    }
    return mergeAll(parts, { uvScale: 2 });
  });
}
