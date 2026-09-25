// Helicopters: AH-1 Cobra gunship and CH-53 Sea Stallion transport.
// Origin at the centre of mass (under the rotor mast), forward +Z, left +X.
import * as THREE from 'three';
import {
  Kit, xf, box, cbox, cyl, lathe, node, instance, pick, PI, strut, decalQuad, disc, v3,
  loft, stationRing, ring, wingLoft, mirrorX, invert, sphere,
} from './geom.js';
import { decalUV } from './materials.js';

/** Stations [z, w, yBottom, yTop, e] -> rings */
function stationsToRings(stations, n) {
  return stations.map(([z, w, yb, yt, e]) => stationRing(n, { z, w, ht: (yt - yb) / 2, hb: (yt - yb) / 2, cy: (yt + yb) / 2, e: e ?? 2.5 }));
}

/** Canopy ring: super-ellipse whose width tapers from the sill (wb) to the top (wt). */
function canopyRing(n, z, wb, wt, yb, yt, e = 2.4) {
  const pts = ring(n, wb, yt - yb, 0.06, e, 0, yb, z);
  for (const p of pts) {
    const t = Math.max(0, Math.min(1, (p.y - yb) / (yt - yb)));
    p.x *= 1 + (wt / wb - 1) * t;
  }
  return pts;
}

/** Rotor blade along +X from r0 to r1, chord c (LE towards +Z at 0 deg). */
function blade(r0, r1, c, t = 0.1, y = 0) {
  return wingLoft([
    { le: [r0, y, c * 0.3], chord: c, t: t * 1.4 },
    { le: [r1, y, c * 0.3], chord: c, t },
  ], 'x', 4);
}

// ---------------------------------------------------------------------------
// AH-1 Cobra
// ---------------------------------------------------------------------------
const COBRA_COM_Y = 1.6;

function buildCobraTemplate(mats) {
  const root = new THREE.Group();
  root.name = 'cobra';
  const body = node('body', [0, -COBRA_COM_Y, 0], null, root); // ground frame: skids at y = 0
  const k = new Kit({ uvScale: 0.4 });
  const N = 18;
  const fus = [
    [5.08, 0.1, 1.1, 1.22, 2], [4.9, 0.5, 0.88, 1.42, 2.2], [4.55, 0.8, 0.75, 1.6, 2.4], [4.0, 0.92, 0.7, 1.7, 2.6],
    [3.0, 0.95, 0.72, 1.74, 2.8], [2.0, 0.97, 0.76, 1.78, 2.8], [1.0, 0.99, 0.8, 2.08, 2.8], [0.1, 1.0, 0.82, 2.42, 3.0],
    [-1.3, 1.0, 0.86, 2.44, 3.0], [-2.1, 0.94, 0.98, 2.34, 2.8], [-2.8, 0.72, 1.3, 2.24, 2.4], [-4.5, 0.54, 1.56, 2.2, 2.2],
    [-6.5, 0.42, 1.72, 2.2, 2.2], [-7.7, 0.34, 1.82, 2.22, 2.2], [-8.5, 0.14, 1.96, 2.16, 2],
  ];
  k.add('helicopterGreen', loft(stationsToRings(fus, N)));
  // canopy (stepped tandem)
  const can = [
    [4.5, 0.46, 0.2, 1.52, 1.6], [4.15, 0.8, 0.38, 1.55, 2.1], [3.6, 0.86, 0.48, 1.58, 2.3], [3.0, 0.88, 0.5, 1.6, 2.34],
    [2.55, 0.9, 0.5, 1.62, 2.4], [2.1, 0.92, 0.52, 1.64, 2.56], [1.5, 0.94, 0.52, 1.68, 2.58], [0.95, 0.94, 0.46, 1.78, 2.5], [0.55, 0.9, 0.36, 1.98, 2.44],
  ];
  const canRings = can.map(([z, wb, wt, yb, yt]) => canopyRing(16, z, wb, wt, yb, yt));
  k.add('glass', loft(canRings));
  // canopy frames: hoops + spine
  for (const i of [1, 4, 7]) {
    const r = canRings[i];
    const a = r.map((p) => v3(p.x * 1.02, p.y + (p.y - 1.6) * 0.02, p.z + 0.035));
    const b = r.map((p) => v3(p.x * 1.02, p.y + (p.y - 1.6) * 0.02, p.z - 0.035));
    k.add('helicopterGreen', loft([a, b], { capStart: false, capEnd: false }));
  }
  for (let i = 1; i < can.length - 1; i++) {
    const top = (r) => r[4]; // top-centre point of the 16-point ring
    k.add('helicopterGreen', strut(top(canRings[i]).clone().setY(top(canRings[i]).y + 0.015), top(canRings[i + 1]).clone().setY(top(canRings[i + 1]).y + 0.015), 0.025, 4));
  }
  // nose sight (TSU) + pitot + wire cutters
  k.add('glass', sphere(0.14, 10, 6, [0, 1.12, 5.02]));
  k.add('darkMetal', cyl(0.15, 0.15, 0.1, 10, 'z', false, [0, 1.12, 4.95]));
  k.add('darkMetal', strut([0.2, 1.3, 4.6], [0.2, 1.32, 5.25], 0.012, 4));
  k.add('darkMetal', beam3([0, 2.2, 3.9], [0, 2.52, 3.5], 0.03, 0.12));
  // engine intakes, exhaust (IR suppressor), cowling seams
  for (const s of [1, -1]) {
    k.add('blackMetal', xf(sphere(0.2, 10, 6, null, [0.3, 1.0, 1.4]), [s * 0.44, 2.1, 0.4]));
    k.add('helicopterGreen', xf(sphere(0.24, 10, 6, null, [0.35, 1.0, 1.4]), [s * 0.42, 2.12, 0.42]));
  }
  k.add('blackMetal', lathe([[0.26, -0.1], [0.3, 0.3], [0.3, 0.6], [0.25, 0.62], [0.22, 0.3]], 10, '-z', [0, 2.2, -2.1]));
  k.add('blackMetal', box(0.9, 0.08, 0.5, [0, 2.46, -0.6]));
  // mast fairing
  k.add('helicopterGreen', lathe([[0.4, 0], [0.34, 0.2], [0.2, 0.36], [0.16, 0.4]], 10, 'y', [0, 2.4, 0]));
  k.add('darkMetal', cyl(0.1, 0.12, 1.2, 10, 'y', false, [0, 3.1, 0]));
  // stub wings with pylons, rocket pods and TOW launchers
  const wing = wingLoft([{ le: [0.4, 1.28, 0.28], chord: 1.12, t: 0.16 }, { le: [1.65, 1.22, 0.1], chord: 0.9, t: 0.13 }], 'x', 5);
  k.add('helicopterGreen', mirrorX(wing));
  k.add('helicopterGreen', wing);
  const pod = lathe([[0, -0.78], [0.14, -0.76], [0.2, -0.6], [0.2, 0.55], [0.17, 0.72], [0.12, 0.75]], 10, 'z');
  const tow = cyl(0.085, 0.085, 1.3, 8, 'z', true);
  for (const s of [1, -1]) {
    k.add('helicopterGreen', box(0.08, 0.28, 0.7, [s * 0.95, 1.04, -0.05]));
    k.add('helicopterGreen', box(0.08, 0.2, 0.6, [s * 1.45, 1.08, -0.05]));
    k.add('helicopterGreen', xf(pod.clone(), [s * 0.95, 0.72, 0.0]));
    k.add('blackMetal', disc(0.125, 10, 'z', [s * 0.95, 0.72, 0.745]));
    for (let i = 0; i < 7; i++) {
      const a = (i / 6) * PI * 2, r = i === 6 ? 0 : 0.075;
      k.add('darkMetal', cyl(0.004, 0.025, 0.05, 5, 'z', false, [s * 0.95 + Math.cos(a) * r, 0.72 + Math.sin(a) * r, 0.74]));
    }
    for (const [dx, dy] of [[-0.09, -0.09], [0.09, -0.09], [-0.09, 0.09], [0.09, 0.09]]) {
      k.add('helicopterGreen', xf(tow.clone(), [s * 1.45 + dx, 0.82 + dy, 0.05]));
      k.add('blackMetal', disc(0.08, 8, 'z', [s * 1.45 + dx, 0.82 + dy, 0.69]));
    }
    // skids + cross tubes
    const sx = s * 1.12;
    k.add('darkMetal', strut([sx, 0.06, -2.3], [sx, 0.06, 1.85], 0.045, 6));
    k.add('darkMetal', strut([sx, 0.06, 1.85], [sx, 0.3, 2.35], 0.045, 6));
    for (const z of [1.25, -1.35]) {
      k.add('darkMetal', strut([s * 0.35, 0.84, z], [s * 0.9, 0.55, z], 0.05, 6));
      k.add('darkMetal', strut([s * 0.9, 0.55, z], [sx, 0.06, z], 0.05, 6));
    }
    // elevators
    const el = wingLoft([{ le: [0.18, 1.92, -4.45], chord: 0.62, t: 0.12 }, { le: [1.08, 1.92, -4.62], chord: 0.46, t: 0.1 }], 'x', 4);
    k.add('helicopterGreen', s > 0 ? el : mirrorX(el));
    k.add('helicopterGreen', box(0.03, 0.3, 0.5, [s * 1.08, 1.94, -4.85]));
    // tail boom numbers
    k.add('decals', decalQuad(decalUV('num09'), 0.7, 0.35, [s * 0.262, 1.9, -5.4], [0, s * PI / 2, 0]));
  }
  k.add('darkMetal', strut([0, 0.84, 1.25], [0, 0.84, -1.35], 0.05, 6));
  // vertical fin + tail skid + tail rotor gearbox (left side)
  k.add('helicopterGreen', wingLoft([{ le: [0, 1.95, -7.05], chord: 1.4, t: 0.14 }, { le: [0, 3.4, -8.25], chord: 0.72, t: 0.12 }], 'y', 5));
  k.add('darkMetal', strut([0, 1.85, -7.6], [0, 1.45, -8.3], 0.025, 4));
  k.add('helicopterGreen', cyl(0.12, 0.14, 0.3, 10, 'x', false, [0.16, 2.95, -8.18]));
  k.build(mats, body, { name: 'cobraBody' });

  // main rotor (2 blades), blur disc, tail rotor
  const hubY = 3.78;
  const mainRotor = node('mainRotor', [0, hubY, 0], null, body);
  const kr = new Kit({ uvScale: 0.5 });
  kr.add('darkMetal', cbox(1.0, 0.12, 0.26, 0.03));
  kr.add('darkMetal', cyl(0.12, 0.12, 0.3, 10, 'y', false, [0, 0.1, 0]));
  for (const s of [1, -1]) {
    kr.add('darkMetal', strut([s * 0.3, -0.25, 0.1], [s * 0.36, 0.0, 0.1], 0.02, 4));
    const bl = blade(0.45, 6.55, 0.84, 0.09);
    kr.add('rotor', s > 0 ? bl : xf(bl, null, [0, PI, 0]));
    const tip = blade(6.55, 6.7, 0.84, 0.09);
    kr.add('markingYellow', s > 0 ? tip : xf(tip, null, [0, PI, 0]));
  }
  kr.build(mats, mainRotor, { name: 'cobraRotor' });
  const blur = new THREE.Mesh(blurDisc(6.7), mats.rotorBlur);
  blur.name = 'mainRotorBlur';
  blur.userData.matKey = 'rotorBlur';
  blur.position.set(0, hubY + 0.02, 0);
  blur.visible = false;
  body.add(blur);

  const tailRotor = node('tailRotor', [0.34, 2.95, -8.18], null, body);
  const kt = new Kit({ uvScale: 0.5 });
  kt.add('darkMetal', cyl(0.07, 0.07, 0.18, 8, 'x'));
  for (const s of [1, -1]) {
    const tb = xf(blade(0.1, 1.2, 0.22, 0.1), null, [0, 0, PI / 2]); // along +Y, thin in X
    kt.add('rotor', s > 0 ? tb : xf(tb, null, [PI, 0, 0]));
    const tt = xf(blade(1.2, 1.3, 0.22, 0.1), null, [0, 0, PI / 2]);
    kt.add('markingWhite', s > 0 ? tt : xf(tt, null, [PI, 0, 0]));
  }
  kt.build(mats, tailRotor, { name: 'cobraTailRotor' });

  // chin turret (M197-style 3-barrel 20mm)
  const chinGun = node('chinGun', [0, 0.6, 4.2], null, body);
  const kc = new Kit({ uvScale: 0.5 });
  kc.add('helicopterGreen', lathe([[0, -0.2], [0.26, -0.15], [0.3, 0.02], [0.24, 0.16], [0, 0.2]], 12, 'y'));
  kc.add('darkMetal', cbox(0.2, 0.18, 0.5, 0.03, [0, -0.02, 0.2]));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * PI * 2 + PI / 2;
    kc.add('darkMetal', cyl(0.022, 0.022, 1.25, 6, 'z', false, [Math.cos(a) * 0.045, -0.02 + Math.sin(a) * 0.045, 1.0]));
  }
  kc.add('darkMetal', cyl(0.08, 0.08, 0.05, 10, 'z', false, [0, -0.02, 1.2]));
  kc.add('darkMetal', cyl(0.07, 0.07, 0.04, 10, 'z', false, [0, -0.02, 1.52]));
  kc.build(mats, chinGun, { name: 'cobraChinGun' });
  node('muzzle', [0, -0.02, 1.64], null, chinGun);
  node('rocketL', [0.95, 0.72, 0.78], null, body);
  node('rocketR', [-0.95, 0.72, 0.78], null, body);
  return root;
}

function beam3(a, b, w, h) {
  const A = v3(...a), B = v3(...b);
  const g = new THREE.BoxGeometry(w, h, A.distanceTo(B));
  const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 0, 1), B.clone().sub(A).normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), q, v3(1, 1, 1)));
  return g;
}

/** Rotor blur disc (faces up, radial alpha texture). */
function blurDisc(r) {
  const g = new THREE.CircleGeometry(r, 48);
  xf(g, null, [-PI / 2, 0, 0]);
  return g;
}

export function buildCobra(mats) {
  const root = instance('cobra', mats, buildCobraTemplate);
  const out = pick(root, 'mainRotor', 'mainRotorBlur', 'tailRotor', 'chinGun', 'muzzle', 'rocketL', 'rocketR');
  out.body = root.getObjectByName('body');
  return out;
}

// ---------------------------------------------------------------------------
// CH-53 Sea Stallion
// ---------------------------------------------------------------------------
const CH53_COM_Y = 2.6;
const CH = {
  rampHinge: [0.72, -3.4], // y, z
  rampEnd: [2.12, -6.9],
};

function buildCH53Template(mats) {
  const root = new THREE.Group();
  root.name = 'ch53';
  const body = node('body', [0, -CH53_COM_Y, 0], null, root);
  const k = new Kit({ uvScale: 0.3 });
  const N = 24;
  // fuselage in three parts: nose+cabin (closed), ramp section (open at the bottom), tail boom (closed)
  const front = [
    [9.6, 0.3, 1.5, 1.8, 2], [9.35, 1.5, 0.98, 2.5, 2.2], [8.85, 2.2, 0.8, 2.98, 2.8], [8.1, 2.6, 0.72, 3.26, 3.4],
    [7.1, 2.7, 0.7, 3.35, 3.8], [-3.4, 2.7, 0.7, 3.35, 3.8],
  ];
  const rampSec = [[-3.4, 2.7, 0.7, 3.35, 3.8], [-5.0, 2.62, 1.3, 3.35, 3.6], [-6.9, 2.1, 2.12, 3.36, 3.2]];
  const tail = [[-6.9, 2.1, 2.12, 3.36, 3.2], [-8.5, 1.3, 2.55, 3.36, 2.6], [-10.0, 0.92, 2.75, 3.4, 2.4], [-11.0, 0.55, 2.88, 3.4, 2.2]];
  k.add('helicopterGreen', loft(stationsToRings(front, N), { capEnd: false }));
  k.add('helicopterGreen', loft(stationsToRings(tail, N), { capStart: false }));
  const rr = stationsToRings(rampSec, N);
  // ring index 0 is +X (angle 0), counter-clockwise; bottom sector = indices 15..21 (225..315 deg)
  const iA = 15, iB = 21;
  const upper = rr.map((r) => { const o = []; for (let i = iB; i !== iA + 1; i = (i + 1) % N) o.push(r[i]); return o; });
  const lower = rr.map((r) => r.slice(iA, iB + 1));
  const upperGeo = loft(upper, { closed: false });
  k.add('helicopterGreen', upperGeo);
  k.add('interior', invert(upperGeo.clone()));
  // cabin liner (inward faces) so the open ramp / door shows an interior
  k.add('interior', invert(box(2.2, 2.15, 10.2, [0, 0.95 + 1.075, 1.75])));
  // cockpit glazing: upper-front sector of the nose rings pushed out slightly
  {
    const gl = stationsToRings([[9.5, 1.0, 1.25, 2.2, 2.2], [9.3, 1.56, 0.98, 2.52, 2.2], [8.85, 2.24, 0.82, 3.0, 2.8], [8.15, 2.64, 0.74, 3.28, 3.4]], N);
    const sect = gl.map((r) => r.filter((_, i) => i >= 1 && i <= 11).map((p) => v3(p.x * 1.012, (p.y - 2.0) * 1.012 + 2.0, p.z + 0.01)));
    k.add('glass', loft(sect, { closed: false }));
    // frames
    for (const s of [1, -1]) k.add('helicopterGreen', strut([s * 0.55, 2.95, 9.0], [s * 0.35, 2.45, 9.42], 0.035, 4));
    k.add('helicopterGreen', strut([0, 3.28, 8.2], [0, 2.52, 9.4], 0.035, 4));
    k.add('helicopterGreen', strut([1.0, 3.2, 8.4], [-1.0, 3.2, 8.4], 0.035, 4));
  }
  // cabin windows (both sides), door opening + crew door on the right (-X)
  for (const s of [1, -1]) {
    for (const z of [3.6, 2.2, 0.8, -0.6, -2.0]) k.add('glass', box(0.02, 0.4, 0.36, [s * 1.353, 2.35, z]));
    k.add('decals', decalQuad(decalUV('num12'), 0.9, 0.45, [s * 0.66, 3.0, -8.4], [0, s * (PI / 2 - 0.26), 0]));
  }
  k.add('interior', box(0.02, 1.7, 1.28, [-1.355, 1.85, 5.25]));
  // sponsons (fuel + main gear) with struts and twin wheels
  const spon = stationsToRings([[2.2, 0.2, 1.2, 1.4, 2], [1.8, 0.8, 0.92, 1.66, 2.4], [1.1, 1.1, 0.8, 1.78, 2.8], [-2.0, 1.1, 0.8, 1.78, 2.8], [-3.2, 0.4, 1.1, 1.5, 2.2]], 14);
  const sponGeo = loft(spon);
  for (const s of [1, -1]) {
    k.add('helicopterGreen', xf(sponGeo.clone(), [s * 1.72, 0, 0]));
    k.add('darkMetal', strut([s * 1.9, 0.9, -0.6], [s * 1.95, 0.42, -0.6], 0.07, 6));
    for (const dz of [-0.2, 0.2]) k.add('rubber', cyl(0.42, 0.42, 0.26, 12, 'x', false, [s * 2.0, 0.42, -0.6 + dz * 0]));
    k.add('darkMetal', cyl(0.16, 0.16, 0.28, 8, 'x', false, [s * 2.0, 0.42, -0.6]));
    // nose gear
    k.add('rubber', cyl(0.3, 0.3, 0.2, 10, 'x', false, [s * 0.2, 0.3, 6.8]));
  }
  k.add('darkMetal', strut([0, 0.75, 6.8], [0, 0.3, 6.8], 0.06, 6));
  // upper deck: main gearbox fairing, engines, mast
  k.add('helicopterGreen', loft(stationsToRings([[3.3, 0.5, 3.3, 3.45, 2], [2.6, 1.7, 3.3, 4.1, 2.6], [-2.6, 1.9, 3.3, 4.3, 3], [-4.3, 1.1, 3.3, 3.75, 2.6], [-5.2, 0.3, 3.3, 3.4, 2]], 14)));
  const nac = lathe([[0, -2.3], [0.3, -2.25], [0.52, -1.7], [0.56, -0.6], [0.56, 1.0], [0.5, 1.6], [0.44, 1.9], [0.38, 1.95]], 12, 'z');
  for (const s of [1, -1]) {
    k.add('helicopterGreen', xf(nac.clone(), [s * 1.12, 3.72, 0]));
    k.add('blackMetal', disc(0.38, 12, 'z', [s * 1.12, 3.72, 1.92]));
    k.add('darkMetal', lathe([[0, 0], [0.15, 0.02], [0.05, 0.3], [0, 0.32]], 8, 'z', [s * 1.12, 3.72, 1.75]));
    k.add('blackMetal', lathe([[0.28, 0], [0.32, 0.5], [0.3, 0.55]], 10, '-z', [s * 1.18, 3.72, -2.25]));
  }
  k.add('darkMetal', cyl(0.2, 0.24, 0.9, 12, 'y', false, [0, 4.6, 0]));
  // tail pylon, stabilizer (right side), tail rotor gearbox (left side)
  k.add('helicopterGreen', wingLoft([{ le: [0, 3.2, -8.9], chord: 2.4, t: 0.18 }, { le: [0, 6.2, -10.1], chord: 1.35, t: 0.16 }], 'y', 5));
  k.add('helicopterGreen', wingLoft([{ le: [-0.2, 5.45, -9.75], chord: 1.1, t: 0.12 }, { le: [-4.3, 5.6, -10.3], chord: 0.7, t: 0.1 }], 'x', 4));
  k.add('helicopterGreen', cyl(0.24, 0.3, 0.5, 10, 'x', false, [0.3, 5.7, -10.35]));
  // antennas, steps, probe-like pitot
  k.add('darkMetal', strut([0.6, 3.35, 6.5], [0.6, 3.95, 6.2], 0.015, 4));
  k.add('darkMetal', strut([-0.5, 3.35, -6.0], [-0.5, 3.9, -6.3], 0.015, 4));
  k.add('darkMetal', strut([0.9, 2.2, 9.3], [0.9, 2.2, 10.1], 0.02, 4));
  k.build(mats, body, { name: 'ch53Body' });

  // ---- rear ramp (bottom sector of the ramp section). Mount faces aft so +rotation.x lowers it.
  const [hy, hz] = CH.rampHinge;
  const rampMount = node('rampMount', [0, hy, hz], [0, PI, 0], body);
  const ramp = node('ramp', null, null, rampMount);
  const kr = new Kit({ uvScale: 0.3 });
  // express the lower sector in ramp-local coordinates: translate by -hinge then rotate PI about Y
  const toLocal = (p) => v3(-p.x, p.y - hy, -(p.z - hz));
  const rampSkin = loft(lower.map((r) => r.map(toLocal)), { closed: false });
  kr.add('helicopterGreen', rampSkin);
  // ramp floor (inner face) + side walls
  const e0 = CH.rampEnd;
  const L = Math.hypot(e0[0] - hy, e0[1] - hz), ang = Math.atan2(e0[0] - hy, hz - e0[1]);
  kr.add('interior', xf(box(1.9, 0.05, L, [0, 0.12, L / 2]), null, [-ang, 0, 0]));
  for (let i = 0; i < 6; i++) kr.add('darkMetal', xf(box(1.8, 0.03, 0.05, [0, 0.16, 0.4 + i * (L - 0.6) / 5]), null, [-ang, 0, 0]));
  kr.build(mats, ramp, { name: 'ch53Ramp' });

  // ---- crew door (right side, slides aft: door.position.z = -1.4 fully open)
  const doorMount = node('doorMount', [-1.38, 1.85, 5.25], null, body);
  const door = node('door', null, null, doorMount);
  const kd = new Kit({ uvScale: 0.3 });
  kd.add('helicopterGreen', cbox(0.04, 1.76, 1.32, 0.015));
  kd.add('glass', box(0.02, 0.4, 0.5, [-0.02, 0.5, 0]));
  kd.add('darkMetal', box(0.04, 0.06, 0.16, [-0.03, 0.0, -0.45]));
  kd.build(mats, door, { name: 'ch53Door' });

  // door gun (.50 cal on a pintle in the doorway, pointing out to -X)
  const kg = new Kit({ uvScale: 0.5 });
  const gx = -1.15, gy = 2.05, gz = 5.25;
  kg.add('darkMetal', cyl(0.03, 0.03, 0.6, 6, 'y', false, [gx, gy - 0.35, gz]));
  kg.add('darkMetal', box(0.55, 0.14, 0.12, [gx - 0.2, gy, gz]));
  kg.add('darkMetal', cyl(0.024, 0.024, 1.1, 6, 'x', false, [gx - 1.0, gy, gz]));
  kg.add('darkMetal', cyl(0.04, 0.04, 0.18, 8, 'x', false, [gx - 0.55, gy, gz]));
  kg.add('darkMetal', box(0.25, 0.18, 0.12, [gx - 0.1, gy - 0.08, gz + 0.14]));
  const gunG = node('doorGun', null, null, body);
  kg.build(mats, gunG, { name: 'ch53DoorGun' });
  node('doorGunMuzzle', [gx - 1.56, gy, gz], null, body);

  // ---- rotors
  const hubY = 5.15;
  const mainRotor = node('mainRotor', [0, hubY, 0], null, body);
  const km = new Kit({ uvScale: 0.5 });
  km.add('darkMetal', lathe([[0, -0.2], [0.6, -0.15], [0.62, 0.1], [0.3, 0.2], [0, 0.25]], 12, 'y'));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * PI * 2;
    const bl = blade(0.7, 10.85, 0.66, 0.08);
    km.add('rotor', xf(bl, null, [0, a, 0]));
    km.add('markingYellow', xf(blade(10.85, 11.0, 0.66, 0.08), null, [0, a, 0]));
    km.add('darkMetal', xf(cbox(0.5, 0.14, 0.18, 0.03, [0.55, 0, 0]), null, [0, a, 0]));
  }
  km.build(mats, mainRotor, { name: 'ch53Rotor' });
  const blur = new THREE.Mesh(blurDisc(11.0), mats.rotorBlur);
  blur.name = 'mainRotorBlur';
  blur.userData.matKey = 'rotorBlur';
  blur.position.set(0, hubY + 0.02, 0);
  blur.visible = false;
  body.add(blur);

  const tailRotor = node('tailRotor', [0.62, 5.7, -10.35], null, body);
  const kt = new Kit({ uvScale: 0.5 });
  kt.add('darkMetal', cyl(0.14, 0.14, 0.25, 10, 'x'));
  for (let i = 0; i < 4; i++) {
    const tb = xf(blade(0.15, 2.3, 0.35, 0.1), null, [0, 0, PI / 2]);
    kt.add('rotor', xf(tb, null, [(i * PI) / 2, 0, 0]));
    const tt = xf(blade(2.3, 2.44, 0.35, 0.1), null, [0, 0, PI / 2]);
    kt.add('markingWhite', xf(tt, null, [(i * PI) / 2, 0, 0]));
  }
  kt.build(mats, tailRotor, { name: 'ch53TailRotor' });
  return root;
}

/** Ramp rotation.x that puts the ramp tip on the ground (ramp lowered for unloading). */
export const CH53_RAMP_OPEN = (() => {
  const [hy, hz] = CH.rampHinge, [ey, ez] = CH.rampEnd;
  const L = Math.hypot(ey - hy, hz - ez), a0 = Math.atan2(ey - hy, hz - ez);
  return a0 + Math.asin(Math.min(1, (hy - 0.05) / L));
})();

export function buildCH53(mats) {
  const root = instance('ch53', mats, buildCH53Template);
  const out = pick(root, 'mainRotor', 'mainRotorBlur', 'tailRotor', 'ramp', 'door', 'doorGunMuzzle', 'doorGun');
  out.body = root.getObjectByName('body');
  out.rampOpenAngle = CH53_RAMP_OPEN;
  out.doorOpenOffset = -1.4;
  out.setRampOpen = (t) => { out.ramp.rotation.x = Math.min(1, Math.max(0, t)) * CH53_RAMP_OPEN; };
  out.setDoorOpen = (t) => { out.door.position.z = Math.min(1, Math.max(0, t)) * -1.4; };
  return out;
}
