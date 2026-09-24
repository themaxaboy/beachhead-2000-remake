// Ground vehicles: M48 Patton-style MBT and M113-style APC.
// Conventions: meters, +Y up, forward +Z, left side = +X, origin at ground under hull centre.
import * as THREE from 'three';
import {
  Kit, xf, box, cbox, cyl, lathe, hull, smoothHull, trackBand, decalQuad, node, instance, pick,
  PI, extrude, mirrorX, strut, beam, v3, disc, invert,
} from './geom.js';
import { decalUV } from './materials.js';

// ---------------------------------------------------------------------------
// shared running-gear helpers (geometry built for the LEFT side, +X; mirrored for right)
// ---------------------------------------------------------------------------
function roadWheel(R, w, hubR, seg = 12) {
  const tire = lathe([[R, -w / 2 + 0.02], [R, w / 2 - 0.025], [R * 0.86, w / 2]], seg, 'x');
  const disc = lathe([[R * 0.86, w / 2], [R * 0.78, w / 2 - 0.04], [hubR, w / 2 - 0.015], [0, w / 2 + 0.035]], seg, 'x');
  return { tire, disc };
}

function sprocket(R, teeth, w) {
  const pts = [];
  const step = (PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const rr = R - 0.03, rt = R + 0.06;
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
    pts.push([Math.cos(a + step * 0.3) * rt, Math.sin(a + step * 0.3) * rt]);
    pts.push([Math.cos(a + step * 0.55) * rt, Math.sin(a + step * 0.55) * rt]);
    pts.push([Math.cos(a + step * 0.85) * rr, Math.sin(a + step * 0.85) * rr]);
  }
  const g = extrude(pts, w, 0, 1);
  xf(g, null, [0, PI / 2, 0]); // extrusion axis -> X
  return g;
}

const sym = (pts) => pts.flatMap(([x, y, z]) => (x === 0 ? [v3(0, y, z)] : [v3(x, y, z), v3(-x, y, z)]));

/** Plan outline: straight sides at +-hw from zr to zs, elliptical nose to (0, zn). */
function planOutline(hw, zr, zs, zn, nSeg = 6) {
  const pts = [[hw, zr], [-hw, zr]];
  for (let i = 0; i <= nSeg; i++) {
    const a = (i / nSeg) * (PI / 2);
    const x = hw * Math.cos(a), z = zs + (zn - zs) * Math.sin(a);
    pts.push([x, z], [-x, z]);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// M48 Patton
// ---------------------------------------------------------------------------
const TANK = {
  deckY: 1.72,
  turretZ: 0.1,
  trackX: 1.45,
  trackW: 0.66,
  trackT: 0.08,
  wheelR: 0.33,
  wheelZ: [-2.1, -1.26, -0.42, 0.42, 1.26, 2.1],
  idler: { z: 3.0, y: 0.66, r: 0.29 },
  sprocket: { z: -3.0, y: 0.7, r: 0.33 },
  rollers: [-1.75, -0.2, 1.35],
};

function buildTankTemplate(mats) {
  const T = TANK;
  const root = new THREE.Group();
  root.name = 'tank';
  const hullG = node('hull', null, null, root);
  const k = new Kit({ uvScale: 0.35 });

  // ---- lower hull (between the tracks)
  k.add('olive', hull(sym([
    [1.02, 0.44, -3.0], [1.02, 0.44, 2.55], [1.06, 0.62, -3.36], [1.08, 1.3, -3.4],
    [1.08, 1.3, 3.2], [1.06, 1.16, 3.42], [1.04, 0.62, 2.78],
  ])));

  // ---- upper hull / sponsons over the tracks (rounded cast nose)
  {
    const pts = [];
    for (const [x, z] of planOutline(1.8, -3.42, 2.2, 3.44, 7)) pts.push(v3(x, 1.22, z));
    for (const [x, z] of planOutline(1.78, -3.42, 2.1, 3.3, 5)) pts.push(v3(x * 0.999, 1.3, z));
    for (const [x, z] of planOutline(1.72, -3.4, 1.4, 2.45, 7)) pts.push(v3(x, T.deckY, z));
    k.add('olive', smoothHull(pts, 32));
  }
  // front fenders following the track slope + rear mud flaps
  for (const s of [1, -1]) {
    const f = xf(extrude([[2.2, 1.25], [3.0, 1.25], [3.52, 1.04], [3.52, 1.0], [2.98, 1.2], [2.2, 1.2]], 0.68), null, [0, -PI / 2, 0]);
    k.add('olive', f, { p: [s * T.trackX, 0, 0] });
    k.add('olive', box(0.68, 0.04, 0.2, [s * T.trackX, 1.23, -3.5]));
    k.add('rubber', box(0.62, 0.34, 0.02, [s * T.trackX, 1.05, -3.6]));
  }
  // engine deck grilles
  for (const s of [1, -1]) {
    k.add('blackMetal', box(1.25, 0.06, 1.7, [s * 0.72, T.deckY + 0.02, -2.4]));
    for (let i = 0; i < 6; i++) k.add('olive', box(1.25, 0.035, 0.07, [s * 0.72, T.deckY + 0.06, -3.1 + i * 0.28]));
    k.add('olive', cbox(1.35, 0.05, 0.12, 0.015, [s * 0.72, T.deckY + 0.03, -1.5]));
  }
  k.add('olive', cbox(0.2, 0.08, 2.0, 0.02, [0, T.deckY + 0.04, -2.4]));
  // rear plate grille + lights + pintle
  k.add('blackMetal', box(1.9, 0.42, 0.06, [0, 1.38, -3.43]));
  for (let i = 0; i < 5; i++) k.add('olive', box(1.9, 0.04, 0.09, [0, 1.22 + i * 0.08, -3.45]));
  for (const s of [1, -1]) {
    k.add('olive', cbox(0.2, 0.16, 0.12, 0.02, [s * 1.55, 1.52, -3.47]));
    k.add('lens', disc(0.045, 8, '-z', [s * 1.55, 1.52, -3.532]));
    k.add('darkMetal', box(0.12, 0.16, 0.2, [s * 0.75, 0.95, -3.42]));
  }
  k.add('darkMetal', box(0.18, 0.14, 0.18, [0, 0.82, -3.38]));
  // rear corner stowage boxes on the fenders
  for (const s of [1, -1]) k.add('olive', cbox(0.62, 0.3, 0.9, 0.03, [s * 1.46, T.deckY - 0.28, -2.85]));
  // headlight clusters with brush guards (on the glacis)
  for (const s of [1, -1]) {
    const hx = s * 1.25, hy = 1.5, hz = 2.92;
    k.add('olive', cbox(0.28, 0.2, 0.18, 0.03, [hx, hy, hz]));
    k.add('lens', disc(0.06, 10, 'z', [hx + 0.06, hy + 0.02, hz + 0.092]));
    k.add('lens', disc(0.04, 8, 'z', [hx - 0.08, hy + 0.02, hz + 0.092]));
    k.add('darkMetal', strut([hx - 0.17, hy - 0.1, hz], [hx - 0.17, hy + 0.17, hz + 0.18], 0.012, 5));
    k.add('darkMetal', strut([hx + 0.17, hy - 0.1, hz], [hx + 0.17, hy + 0.17, hz + 0.18], 0.012, 5));
    k.add('darkMetal', strut([hx - 0.17, hy + 0.17, hz + 0.18], [hx + 0.17, hy + 0.17, hz + 0.18], 0.012, 5));
    // front tow hooks
    k.add('darkMetal', box(0.1, 0.16, 0.2, [s * 0.72, 1.05, 3.36]));
  }
  // driver's hatch + periscopes
  k.add('olive', cyl(0.3, 0.3, 0.05, 14, 'y', false, [0, T.deckY + 0.02, 2.02]));
  k.add('olive', cbox(0.5, 0.06, 0.14, 0.02, [0, T.deckY + 0.02, 2.3]));
  for (const x of [-0.16, 0, 0.16]) k.add('lens', box(0.09, 0.05, 0.02, [x, T.deckY + 0.07, 2.32]));
  // hull number on the rear boxes
  for (const s of [1, -1]) k.add('decals', decalQuad(decalUV('num217'), 0.5, 0.25, [s * 1.46, T.deckY - 0.28, -3.305], [0, PI, 0]));

  // ---- running gear
  const { tire, disc: wdisc } = roadWheel(T.wheelR, 0.3, 0.07, 10);
  const idlerW = roadWheel(T.idler.r, 0.26, 0.06, 10);
  const spr = sprocket(T.sprocket.r, 11, 0.16);
  const sprHub = lathe([[0.2, 0.07], [0.1, 0.12], [0, 0.13]], 10, 'x');
  const roller = cyl(0.11, 0.11, 0.14, 8, 'x');
  const wheels = [
    ...T.wheelZ.map((z) => ({ z, y: T.wheelR + T.trackT, r: T.wheelR })),
    { ...T.idler }, { ...T.sprocket },
    ...T.rollers.map((z) => ({ z, y: 1.02, r: 0.11 })),
  ];
  for (const s of [1, -1]) {
    const place = (g, x, y, z) => { const c = s > 0 ? g.clone() : mirrorX(g); return xf(c, [s * x, y, z]); };
    for (const z of T.wheelZ) {
      k.add('rubber', place(tire, T.trackX + 0.12, T.wheelR + T.trackT, z));
      k.add('olive', place(wdisc, T.trackX + 0.12, T.wheelR + T.trackT, z));
      // suspension arm
      k.add('olive', beam([s * 1.1, T.wheelR + T.trackT + 0.14, z + 0.3], [s * 1.28, T.wheelR + T.trackT, z], 0.1, 0.12));
    }
    k.add('rubber', place(idlerW.tire, T.trackX + 0.1, T.idler.y, T.idler.z));
    k.add('olive', place(idlerW.disc, T.trackX + 0.1, T.idler.y, T.idler.z));
    k.add('olive', place(spr, T.trackX + 0.04, T.sprocket.y, T.sprocket.z));
    k.add('olive', place(sprHub, T.trackX + 0.12, T.sprocket.y, T.sprocket.z));
    for (const z of T.rollers) k.add('olive', place(roller, T.trackX + 0.05, 1.02, z));
    // track band
    k.add('track', trackBand(wheels, s * T.trackX, T.trackW, T.trackT, 48, 0.17), { uv: 'keep' });
  }
  k.build(mats, hullG, { name: 'tankHull' });

  // ---- turret (pivot at ring centre)
  const turret = node('turret', [0, T.deckY, T.turretZ], null, hullG);
  const kt = new Kit({ uvScale: 0.35 });
  const H = 0.9;
  const outline = (th, s) => {
    const c = Math.cos(th), sn = Math.sin(th);
    const L = c >= 0 ? 1.5 : 1.35;
    // blunter nose: super-ellipse towards the front
    const k = c >= 0 ? 0.8 : 1;
    const cc = Math.sign(c) * Math.pow(Math.abs(c), k), ss = Math.sign(sn) * Math.pow(Math.abs(sn), k);
    return [1.42 * ss * s, L * cc * s];
  };
  {
    const pts = [];
    const levels = [[0.0, 0.88], [0.14, 0.99], [0.34, 1.0], [0.56, 0.93], [0.76, 0.78], [H, 0.56]];
    for (const [y, s] of levels) for (let i = 0; i < 20; i++) {
      const [x, z] = outline((i / 20) * PI * 2, s);
      pts.push(v3(x, y + 0.04, z));
    }
    // bustle
    for (const [x, y, z] of [[0.95, 0.14, -1.9], [0.95, 0.62, -1.9], [0.8, 0.14, -2.08], [0.8, 0.6, -2.08], [0.6, 0.1, -1.3], [0.6, 0.72, -1.7]]) {
      pts.push(v3(x, y, z), v3(-x, y, z));
    }
    kt.add('olive', smoothHull(pts, 30));
  }
  // turret ring / base collar
  kt.add('olive', cyl(1.18, 1.22, 0.08, 20, 'y', true, [0, 0.04, 0]));
  // commander's cupola (right side = -X)
  {
    const cx = -0.52, cz = -0.32, cy = H + 0.02;
    kt.add('olive', lathe([[0.46, -0.06], [0.46, 0.1], [0.41, 0.13], [0.41, 0.3], [0.3, 0.38], [0, 0.43]], 12, 'y', [cx, cy, cz]));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * PI * 2 + 0.3;
      kt.add('lens', box(0.12, 0.08, 0.03, [cx + Math.sin(a) * 0.415, cy + 0.2, cz + Math.cos(a) * 0.415], [0, a, 0]));
    }
    // .50 cal on the cupola
    kt.add('darkMetal', box(0.12, 0.14, 0.55, [cx, cy + 0.5, cz + 0.12]));
    kt.add('darkMetal', cyl(0.028, 0.028, 1.05, 8, 'z', false, [cx, cy + 0.52, cz + 0.88]));
    kt.add('darkMetal', cyl(0.045, 0.045, 0.2, 8, 'z', false, [cx, cy + 0.52, cz + 0.45]));
    kt.add('olive', cbox(0.1, 0.18, 0.28, 0.02, [cx + 0.14, cy + 0.44, cz + 0.1]));
  }
  // loader's hatch (left)
  kt.add('olive', cyl(0.3, 0.32, 0.06, 14, 'y', false, [0.52, H + 0.02, -0.28]));
  kt.add('darkMetal', cbox(0.1, 0.05, 0.24, 0.015, [0.52, H + 0.06, -0.58]));
  // lifting eyes / vents
  for (const [x, z] of [[0.9, 0.7], [-0.9, 0.7], [0.75, -1.3], [-0.75, -1.3]]) kt.add('darkMetal', box(0.05, 0.1, 0.14, [x, H - 0.08, z]));
  kt.add('olive', lathe([[0.16, 0], [0.14, 0.1], [0, 0.12]], 10, 'y', [0.05, H, -0.9]));
  // antenna bases + whips
  for (const x of [0.62, -0.62]) {
    kt.add('darkMetal', cyl(0.05, 0.06, 0.12, 8, 'y', false, [x, H - 0.1, -1.55]));
    kt.add('blackMetal', strut([x, H - 0.05, -1.55], [x, H + 2.1, -1.7], 0.008, 4));
  }
  // bustle stowage basket
  {
    const y0 = 0.2, y1 = 0.62, z0 = -2.02, z1 = -2.42, xw = 1.1;
    kt.add('olive2', box(2 * xw, 0.03, 0.42, [0, y0, (z0 + z1) / 2]));
    for (const y of [y0 + 0.2, y1]) {
      kt.add('darkMetal', strut([-xw, y, z1], [xw, y, z1], 0.015, 4));
      kt.add('darkMetal', strut([xw, y, z0 + 0.1], [xw, y, z1], 0.015, 4));
      kt.add('darkMetal', strut([-xw, y, z0 + 0.1], [-xw, y, z1], 0.015, 4));
    }
    for (const x of [-xw, -xw / 3, xw / 3, xw]) kt.add('darkMetal', strut([x, y0, z1], [x, y1, z1], 0.015, 4));
    // stowed gear: bedrolls + boxes
    kt.add('olive2', cyl(0.14, 0.14, 0.9, 8, 'x', false, [-0.45, y0 + 0.15, -2.2]));
    kt.add('olive2', cyl(0.13, 0.13, 0.8, 8, 'x', false, [0.5, y0 + 0.14, -2.18]));
    kt.add('olive', cbox(0.5, 0.22, 0.3, 0.02, [0.1, y0 + 0.36, -2.22]));
  }
  // turret numbers
  for (const s of [1, -1]) {
    const d = decalQuad(decalUV('num217'), 0.5, 0.25);
    xf(d, null, [-0.3, 0, 0]);
    kt.add('decals', xf(d, [s * 1.345, 0.44, -0.3], [0, s * (PI / 2 + 0.25), 0]));
  }
  kt.build(mats, turret, { name: 'tankTurret' });

  // ---- gun (pivot at trunnion)
  const gun = node('gun', [0, 0.45, 1.22], null, turret);
  const kg = new Kit({ uvScale: 0.4 });
  // mantlet + blast cover
  kg.add('olive', smoothHull(sym([[0.5, 0.3, 0.1], [0.5, -0.3, 0.1], [0.44, 0.34, 0.42], [0.44, -0.32, 0.42], [0.3, 0.22, 0.55], [0.3, -0.2, 0.55]]), 35));
  kg.add('olive2', cbox(0.34, 0.34, 0.3, 0.06, [0, 0, 0.62]));
  // barrel with bore evacuator; profile [radius, z]
  kg.add('olive', lathe([
    [0, 0.5], [0.13, 0.5], [0.13, 0.8], [0.105, 0.85], [0.098, 2.65], [0.135, 2.72], [0.142, 2.85], [0.142, 3.25],
    [0.13, 3.35], [0.092, 3.4], [0.085, 3.92],
  ], 12, 'z'));
  // T-shaped muzzle blast deflector
  kg.add('olive', lathe([[0.085, 3.9], [0.115, 3.92], [0.115, 4.28], [0.05, 4.3], [0.048, 4.1]], 12, 'z'));
  kg.add('olive', cbox(0.46, 0.17, 0.3, 0.03, [0, 0, 4.1]));
  for (const s of [1, -1]) kg.add('blackMetal', box(0.02, 0.1, 0.22, [s * 0.232, 0, 4.1]));
  kg.add('blackMetal', cyl(0.047, 0.047, 0.02, 10, 'z', false, [0, 0, 4.15]));
  // coax MG port + xenon searchlight on top of the mantlet
  kg.add('blackMetal', cyl(0.03, 0.03, 0.1, 8, 'z', false, [0.28, 0.02, 0.55]));
  kg.add('olive', cbox(0.46, 0.38, 0.3, 0.05, [0, 0.52, 0.3]));
  kg.add('lens', disc(0.155, 14, 'z', [0, 0.52, 0.452]));
  kg.add('darkMetal', box(0.1, 0.16, 0.1, [0, 0.3, 0.3]));
  kg.build(mats, gun, { name: 'tankGun' });
  node('muzzle', [0, 0, 4.32], null, gun);
  return root;
}

export function buildTank(mats) {
  const root = instance('tank', mats, buildTankTemplate);
  return pick(root, 'hull', 'turret', 'gun', 'muzzle');
}

// ---------------------------------------------------------------------------
// M113 APC
// ---------------------------------------------------------------------------
const APC = {
  trackX: 1.12, trackW: 0.38, trackT: 0.07, wheelR: 0.305,
  wheelZ: [-1.44, -0.72, 0, 0.72, 1.44],
  sprocket: { z: 2.02, y: 0.62, r: 0.25 },
  idler: { z: -1.95, y: 0.5, r: 0.26 },
  roofY: 1.83,
  rampHingeY: 0.45,
  rampLen: 1.32,
};

function buildAPCTemplate(mats) {
  const A = APC;
  const root = new THREE.Group();
  root.name = 'apc';
  const k = new Kit({ uvScale: 0.35 });
  const R = A.roofY;
  // front section (driver/engine): lower hull + upper box with sloped glacis
  const ZB = -0.5; // bulkhead between engine bay and troop compartment
  k.add('olive', hull(sym([[0.92, 0.43, ZB], [0.92, 1.0, ZB], [0.92, 0.43, 2.0], [0.92, 1.02, 2.43], [0.92, 0.6, 2.2]])));
  k.add('olive', hull(sym([
    [1.33, 0.98, ZB], [1.33, R - 0.04, ZB], [1.29, R, ZB], [1.29, R, 1.2], [1.33, R - 0.04, 1.22],
    [1.33, 1.02, 2.42], [1.3, 0.98, 2.43], [1.33, 0.98, 2.3],
  ])));
  // troop compartment: hollow tube section open at the rear (door opening behind the ramp)
  {
    const sh = new THREE.Shape([[0.92, 0.43], [0.92, 0.98], [1.33, 0.98], [1.33, R - 0.04], [1.29, R], [-1.29, R], [-1.33, R - 0.04],
      [-1.33, 0.98], [-0.92, 0.98], [-0.92, 0.43]].map(([x, y]) => new THREE.Vector2(x, y)));
    sh.holes.push(new THREE.Path([[0.86, 0.5], [-0.86, 0.5], [-0.86, 1.04], [-1.27, 1.04], [-1.27, R - 0.06], [1.27, R - 0.06],
      [1.27, 1.04], [0.86, 1.04]].map(([x, y]) => new THREE.Vector2(x, y))));
    const len = ZB + 2.43;
    k.add('olive', xf(extrude(sh, len, 0, 1), [0, 0, (ZB - 2.43) / 2]));
    // rear plate strips beside the doorway + lower hull rear chamfer
    for (const s of [1, -1]) k.add('olive', box(0.4, R - 0.98, 0.04, [s * 1.13, (R + 0.98) / 2, -2.41]));
    // interior liner (faces inward) + bench cushions
    k.add('interior', invert(box(2.52, R - 0.57, 1.9, [0, (R - 0.06 + 0.51) / 2, (ZB - 2.43) / 2 - 0.01])));
    for (const s of [1, -1]) k.add('interior', box(0.34, 0.07, 1.5, [s * 1.08, 1.075, -1.45]));
  }
  // glacis geometry
  const gA = v3(0, R, 1.21), gB = v3(0, 1.0, 2.43);
  const gDir = gB.clone().sub(gA).normalize();
  const gN = v3(0, gDir.z, -gDir.y); // outward normal of glacis (up/forward)
  const onG = (t, off) => gA.clone().lerp(gB, t).addScaledVector(gN, off);
  // trim vane folded on the glacis + ribs
  k.add('olive', beam(onG(0.2, 0.07), onG(0.92, 0.07), 2.3, 0.04, gN));
  for (const x of [-0.9, -0.3, 0.3, 0.9]) k.add('olive', beam(onG(0.22, 0.04).setX(x), onG(0.9, 0.04).setX(x), 0.05, 0.06, gN));
  // headlights with guards (upper glacis corners)
  for (const s of [1, -1]) {
    const p = onG(0.1, 0.07).setX(s * 1.08);
    k.add('olive', cbox(0.2, 0.16, 0.14, 0.02, [p.x, p.y, p.z]));
    k.add('lens', cyl(0.05, 0.05, 0.03, 10, 'z', false, [p.x, p.y + 0.01, p.z + 0.08]));
    k.add('darkMetal', strut([p.x - 0.12, p.y - 0.08, p.z + 0.02], [p.x - 0.12, p.y + 0.12, p.z + 0.13], 0.01, 4));
    k.add('darkMetal', strut([p.x + 0.12, p.y - 0.08, p.z + 0.02], [p.x + 0.12, p.y + 0.12, p.z + 0.13], 0.01, 4));
    k.add('darkMetal', strut([p.x - 0.12, p.y + 0.12, p.z + 0.13], [p.x + 0.12, p.y + 0.12, p.z + 0.13], 0.01, 4));
    // tow eyes
    k.add('darkMetal', cbox(0.08, 0.14, 0.14, 0.02, [s * 0.7, 0.9, 2.45]));
    // rear lights
    k.add('olive', cbox(0.16, 0.14, 0.1, 0.02, [s * 1.18, 1.62, -2.47]));
    k.add('lens', box(0.1, 0.06, 0.02, [s * 1.18, 1.63, -2.525]));
    // rubber track shrouds
    k.add('rubber', box(0.03, 0.2, 4.3, [s * 1.335, 0.9, 0.05]));
    // hull numbers
    k.add('decals', decalQuad(decalUV('num34'), 0.5, 0.25, [s * 1.336, 1.45, -0.6], [0, s * PI / 2, 0]));
  }
  // exhaust grille (right front) + pipe
  {
    const p = onG(0.45, 0.02).setX(-0.95);
    k.add('blackMetal', beam(onG(0.3, 0.03).setX(-0.95), onG(0.62, 0.03).setX(-0.95), 0.34, 0.05, gN));
    k.add('darkMetal', strut([p.x - 0.1, R + 0.02, 1.0], [p.x - 0.1, R + 0.25, 1.05], 0.05, 8));
  }
  // driver's hatch (front left) with periscopes
  k.add('olive', cyl(0.3, 0.3, 0.05, 14, 'y', false, [0.72, R + 0.02, 0.72]));
  for (let i = 0; i < 4; i++) {
    const a = -0.8 + i * 0.53;
    k.add('lens', box(0.09, 0.05, 0.03, [0.72 + Math.sin(a) * 0.33, R + 0.04, 0.72 + Math.cos(a) * 0.33], [0, a, 0]));
  }
  // commander's cupola ring (right)
  k.add('olive', lathe([[0.42, -0.02], [0.42, 0.12], [0.36, 0.16], [0.3, 0.15]], 16, 'y', [-0.3, R, 0.1]));
  for (let i = 0; i < 5; i++) {
    const a = -1.2 + i * 0.6;
    k.add('lens', box(0.1, 0.05, 0.03, [-0.3 + Math.sin(a) * 0.4, R + 0.09, 0.1 + Math.cos(a) * 0.4], [0, a, 0]));
  }
  // rear cargo hatch
  k.add('olive', cbox(1.5, 0.05, 1.4, 0.02, [0, R + 0.02, -1.55]));
  for (const x of [-0.5, 0.5]) k.add('darkMetal', cyl(0.03, 0.03, 0.3, 6, 'x', false, [x, R + 0.04, -0.83]));
  // roof vent + antenna
  k.add('olive', cyl(0.12, 0.14, 0.12, 10, 'y', false, [0.7, R + 0.06, -0.3]));
  k.add('darkMetal', cyl(0.04, 0.05, 0.1, 6, 'y', false, [-1.1, R + 0.05, -2.2]));
  k.add('blackMetal', strut([-1.1, R + 0.1, -2.2], [-1.1, R + 2.3, -2.35], 0.008, 4));

  // running gear
  const { tire, disc } = roadWheel(A.wheelR, 0.22, 0.06, 12);
  const idl = roadWheel(A.idler.r, 0.2, 0.06, 12);
  const spr = sprocket(A.sprocket.r, 10, 0.12);
  const sprHub = lathe([[0.16, -0.08], [0.16, 0.06], [0.08, 0.1], [0, 0.11]], 10, 'x');
  const wheels = [...A.wheelZ.map((z) => ({ z, y: A.wheelR + A.trackT, r: A.wheelR })), { ...A.sprocket }, { ...A.idler }];
  for (const s of [1, -1]) {
    const place = (g, x, y, z) => { const c = s > 0 ? g.clone() : mirrorX(g); return xf(c, [s * x, y, z]); };
    for (const z of A.wheelZ) {
      k.add('rubber', place(tire, A.trackX + 0.06, A.wheelR + A.trackT, z));
      k.add('olive', place(disc, A.trackX + 0.06, A.wheelR + A.trackT, z));
      k.add('olive', beam([s * 0.93, A.wheelR + A.trackT + 0.12, z - 0.28], [s * 1.02, A.wheelR + A.trackT, z], 0.08, 0.1));
    }
    k.add('rubber', place(idl.tire, A.trackX + 0.05, A.idler.y, A.idler.z));
    k.add('olive', place(idl.disc, A.trackX + 0.05, A.idler.y, A.idler.z));
    k.add('olive', place(spr, A.trackX, A.sprocket.y, A.sprocket.z));
    k.add('olive', place(sprHub, A.trackX + 0.06, A.sprocket.y, A.sprocket.z));
    k.add('track', trackBand(wheels, s * A.trackX, A.trackW, A.trackT, 52, 0.15), { uv: 'keep' });
  }
  const hullG = node('hull', null, null, root);
  k.build(mats, hullG, { name: 'apcHull' });

  // ---- rear ramp: hinge at the bottom rear edge. The mount faces backwards so +rotation.x opens it.
  const rampMount = node('rampMount', [0, A.rampHingeY, -2.43], [0, PI, 0], hullG);
  const ramp = node('ramp', null, null, rampMount);
  const kr = new Kit({ uvScale: 0.35 });
  kr.add('olive', cbox(1.86, A.rampLen, 0.08, 0.015, [0, A.rampLen / 2, 0.04]));
  // personnel door outline + handle + ribs on the inside face
  kr.add('olive', cbox(0.62, 1.0, 0.03, 0.01, [-0.45, 0.62, 0.095]));
  kr.add('darkMetal', cbox(0.04, 0.16, 0.05, 0.01, [-0.2, 0.7, 0.12]));
  for (const x of [-0.6, 0, 0.6]) kr.add('olive', box(0.06, A.rampLen - 0.1, 0.05, [x, A.rampLen / 2, -0.02]));
  for (const x of [-0.75, 0.75]) kr.add('darkMetal', cyl(0.05, 0.05, 0.22, 8, 'x', false, [x, 0.02, 0.03]));
  kr.add('decals', decalQuad(decalUV('num34'), 0.46, 0.23, [0.42, 0.95, 0.081], null));
  kr.build(mats, ramp, { name: 'apcRamp' });

  // ---- .50 cal on the commander's cupola (rotates around Y)
  const mg = node('mg', [-0.3, R + 0.16, 0.1], null, hullG);
  const km = new Kit({ uvScale: 0.5 });
  km.add('darkMetal', cyl(0.03, 0.04, 0.3, 8, 'y', false, [0, 0.15, 0])); // pintle
  km.add('darkMetal', cbox(0.14, 0.17, 0.62, 0.02, [0, 0.36, -0.05]));
  km.add('darkMetal', cbox(0.16, 0.2, 0.05, 0.02, [0, 0.36, -0.37]));
  km.add('darkMetal', cyl(0.045, 0.045, 0.2, 10, 'z', false, [0, 0.37, 0.35]));
  km.add('darkMetal', cyl(0.024, 0.024, 1.15, 8, 'z', false, [0, 0.37, 0.92]));
  km.add('darkMetal', cyl(0.03, 0.026, 0.08, 8, 'z', false, [0, 0.37, 1.5]));
  for (const s of [1, -1]) km.add('blackMetal', strut([s * 0.05, 0.36, -0.38], [s * 0.07, 0.3, -0.52], 0.018, 6));
  km.add('olive', cbox(0.12, 0.18, 0.28, 0.015, [0.15, 0.3, 0.0]));
  // ACAV-style gun shield
  km.add('olive', cbox(0.95, 0.5, 0.025, 0.01, [0, 0.42, 0.3]));
  for (const s of [1, -1]) km.add('olive', cbox(0.36, 0.5, 0.025, 0.01, [s * 0.62, 0.42, 0.17], [0, s * 0.75, 0]));
  km.add('blackMetal', box(0.1, 0.08, 0.03, [0, 0.4, 0.3]));
  km.build(mats, mg, { name: 'apcMG' });
  node('muzzle', [0, 0.37, 1.55], null, mg);
  return root;
}

/** Ramp rotation.x at which the ramp lies on the ground behind the APC. */
export const APC_RAMP_OPEN = PI - Math.acos(APC.rampHingeY / APC.rampLen);

export function buildAPC(mats) {
  const root = instance('apc', mats, buildAPCTemplate);
  const out = pick(root, 'ramp', 'mg', 'muzzle');
  out.rampOpenAngle = APC_RAMP_OPEN;
  out.setRampOpen = (t) => { out.ramp.rotation.x = Math.min(1, Math.max(0, t)) * APC_RAMP_OPEN; };
  return out;
}
