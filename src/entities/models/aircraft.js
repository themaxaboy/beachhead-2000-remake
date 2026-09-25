// Fixed-wing aircraft: F-4 Phantom II, B-52 Stratofortress, C-130-style cargo plane.
// Origin at the centre of mass, forward +Z, left wing +X.
import * as THREE from 'three';
import {
  Kit, xf, box, cbox, cyl, lathe, node, instance, pick, PI, strut, decalQuad, disc, v3,
  loft, stationRing, wingLoft, foilRing, mirrorX, invert, extrude,
} from './geom.js';
import { decalUV } from './materials.js';

const rings = (stations, n) => stations.map(([z, w, yb, yt, e, cx]) => stationRing(n, { z, w, ht: (yt - yb) / 2, hb: (yt - yb) / 2, cy: (yt + yb) / 2, e: e ?? 2.5, cx: cx ?? 0 }));

/** Canopy ring tapering from sill width wb to top width wt. */
function canopyRing(n, z, wb, wt, yb, yt, e = 2.4) {
  const pts = stationRing(n, { z, w: wb, ht: yt - yb, hb: 0.05, cy: yb, e });
  for (const p of pts) {
    const t = Math.max(0, Math.min(1, (p.y - yb) / (yt - yb)));
    p.x *= 1 + (wt / wb - 1) * t;
  }
  return pts;
}

/** Store/tank/bomb body of revolution along +Z centred at origin: length L, radius r. */
function storeBody(L, r, seg = 10, noseSharp = 0.3, tailSharp = 0.25) {
  const h = L / 2;
  return lathe([
    [0, -h], [r * 0.35, -h + L * 0.02], [r * 0.8, -h + L * tailSharp * 0.5], [r, -h + L * tailSharp],
    [r, h - L * noseSharp], [r * 0.75, h - L * noseSharp * 0.45], [r * 0.3, h - L * 0.03], [0, h],
  ], seg, 'z');
}

/** Cruciform tail fins for stores. */
function storeFins(kit, key, z, span, chord, x = 0, y = 0, n = 4, rot = PI / 4) {
  for (let i = 0; i < n; i++) {
    const a = rot + (i * PI * 2) / n;
    const g = box(0.012, span, chord, [0, span / 2, 0]);
    xf(g, null, [0, 0, a]);
    kit.add(key, xf(g, [x, y, z]));
  }
}

/** Mk-82 style bomb with conical "Snakeye" tail (nose +Z). */
function addBomb(kit, key, finKey, p) {
  const b = storeBody(2.2, 0.137, 8, 0.32, 0.2);
  kit.add(key, xf(b, p));
  kit.add(finKey, xf(lathe([[0.09, -1.1], [0.16, -1.25], [0.02, -1.26]], 8, 'z'), p));
  storeFins(kit, finKey, p[2] - 1.08, 0.18, 0.3, p[0], p[1]);
  kit.add('markingYellow', xf(cyl(0.139, 0.139, 0.05, 8, 'z', true), [p[0], p[1], p[2] + 0.62]));
}

// ---------------------------------------------------------------------------
// F-4 Phantom II
// ---------------------------------------------------------------------------
const camoUV = (cen, n, p) => (n.y < -0.35 ? [p.x / 21 + 0.5, 0.035] : [p.x / 21 + 0.5, 0.075 + (p.z / 21 + 0.5) * 0.92]);

function buildF4Template(mats) {
  const root = new THREE.Group();
  root.name = 'f4';
  const k = new Kit({ uvScale: 0.35 });
  const C = (g) => k.add('jetCamo', g, { uv: camoUV });
  const N = 22;
  C(loft(rings([
    [9.6, 0.05, -0.06, 0.0, 2], [9.25, 0.36, -0.22, 0.12, 2], [8.6, 0.72, -0.42, 0.3, 2], [7.7, 0.96, -0.56, 0.44, 2.1],
    [6.6, 1.08, -0.66, 0.55, 2.3], [5.4, 1.18, -0.72, 0.62, 2.4], [4.2, 1.26, -0.78, 0.66, 2.5], [3.0, 1.32, -0.8, 0.74, 2.6],
    [1.5, 1.5, -0.82, 0.84, 2.8], [0.0, 2.1, -0.82, 0.8, 3.2], [-2.0, 2.35, -0.84, 0.74, 3.4], [-4.5, 2.3, -0.82, 0.66, 3.4],
    [-6.5, 2.05, -0.72, 0.6, 3.2], [-7.8, 1.8, -0.6, 0.56, 3.0], [-8.4, 1.15, -0.2, 0.52, 2.6], [-9.2, 0.5, 0.08, 0.45, 2.2], [-9.6, 0.12, 0.2, 0.36, 2],
  ], N)));
  // intakes (D-shaped ducts) with splitter plates and dark mouths
  for (const s of [1, -1]) {
    const duct = loft([
      stationRing(14, { z: 3.65, w: 0.6, ht: 0.52, hb: 0.52, cy: -0.12, e: 3, cx: s * 1.02 }),
      stationRing(14, { z: 2.0, w: 0.68, ht: 0.56, hb: 0.56, cy: -0.12, e: 3, cx: s * 1.06 }),
      stationRing(14, { z: 0.0, w: 0.56, ht: 0.52, hb: 0.52, cy: -0.1, e: 3, cx: s * 0.95 }),
    ], { capStart: false });
    C(duct);
    k.add('blackMetal', xf(cbox(0.5, 0.95, 0.05, 0.12), [s * 1.02, -0.12, 3.5]));
    const sp = xf(extrude([[3.8, 0.44], [3.75, -0.66], [2.2, -0.5], [2.2, 0.36]], 0.03), null, [0, -PI / 2, 0]);
    C(xf(sp, [s * 0.69, 0, 0]));
    // wing glove / intake-to-wing fairing
  }
  // canopy + frames
  const can = [[6.35, 0.6, 0.26, 0.44, 0.6], [5.95, 0.9, 0.42, 0.48, 1.0], [5.2, 0.98, 0.5, 0.52, 1.12], [4.4, 1.0, 0.5, 0.56, 1.12],
    [3.8, 1.0, 0.48, 0.58, 1.07], [3.1, 1.02, 0.5, 0.6, 1.14], [2.3, 1.0, 0.46, 0.64, 1.1], [1.5, 0.9, 0.34, 0.7, 0.98]];
  const cr = can.map(([z, wb, wt, yb, yt]) => canopyRing(16, z, wb, wt, yb, yt));
  k.add('glass', loft(cr));
  for (const i of [1, 4, 6]) {
    const a = cr[i].map((p) => v3(p.x * 1.025, p.y + 0.008, p.z + 0.04));
    const b = cr[i].map((p) => v3(p.x * 1.025, p.y + 0.008, p.z - 0.04));
    C(loft([a, b], { capStart: false, capEnd: false }));
  }
  // spine behind the canopy
  C(loft(rings([[1.6, 0.5, 0.5, 0.95, 2.2], [-2.0, 0.42, 0.55, 0.86, 2.2], [-5.6, 0.3, 0.52, 0.7, 2]], 10)));
  // gun fairing under the nose (F-4E) + muzzle
  C(lathe([[0, 3.8], [0.2, 4.4], [0.22, 5.4], [0.19, 6.9], [0.12, 7.3], [0.07, 7.32]], 10, 'z', [0, -0.68, 0]));
  k.add('blackMetal', disc(0.06, 8, 'z', [0, -0.68, 7.33]));
  // pitot
  k.add('darkMetal', cyl(0.012, 0.03, 0.7, 5, 'z', false, [0, -0.03, 9.9]));
  // wings: inner panel + outer panel with dihedral + dogtooth
  const wi = wingLoft([{ le: [0.9, -0.34, 2.4], chord: 6.0, t: 0.06 }, { le: [4.1, -0.3, -0.8], chord: 2.8, t: 0.05 }], 'x', 5);
  const wo = wingLoft([{ le: [4.1, -0.3, -0.52], chord: 3.08, t: 0.05 }, { le: [5.85, 0.07, -2.3], chord: 1.4, t: 0.04 }], 'x', 5);
  const sti = wingLoft([{ le: [0.7, 0.05, -7.45], chord: 2.45, t: 0.05 }, { le: [3.0, -0.93, -9.05], chord: 0.95, t: 0.04 }], 'x', 4);
  for (const [g, s] of [[wi, 1], [wo, 1], [sti, 1]]) { C(g.clone()); C(mirrorX(g)); }
  // fin
  C(wingLoft([{ le: [0, 0.4, -5.3], chord: 4.3, t: 0.06 }, { le: [0, 2.95, -8.55], chord: 1.25, t: 0.05 }], 'y', 5));
  k.add('darkMetal', cyl(0.07, 0.07, 0.6, 8, 'z', false, [0, 2.8, -9.4]));
  // nozzles with afterburner glow discs
  for (const s of [1, -1]) {
    const nx = s * 0.56, ny = -0.34;
    k.add('darkMetal', lathe([[0.49, 0], [0.48, 0.9], [0.44, 1.55], [0.41, 1.72], [0.37, 1.7], [0.36, 1.2]], 14, '-z', [nx, ny, -7.2]));
    k.add('blackMetal', lathe([[0.36, 1.2], [0.33, 1.0], [0.2, 0.95], [0, 0.95]], 12, '-z', [nx, ny, -7.2]));
    k.add('engineGlow', disc(0.34, 14, '-z', [nx, ny, -8.25]));
  }
  // tail hook, antennas
  k.add('darkMetal', strut([0, -0.35, -7.0], [0, -0.55, -8.6], 0.035, 5));
  k.add('darkMetal', box(0.02, 0.3, 0.25, [0, -0.95, 2.0]));
  // semi-recessed Sparrow missiles
  for (const s of [1, -1]) for (const z of [2.3, -2.6]) {
    const p = [s * 0.72, -0.86, z];
    k.add('aircraftGrey', xf(storeBody(3.66, 0.1, 8, 0.12, 0.05), p));
    storeFins(k, 'aircraftGrey', p[2] + 0.3, 0.2, 0.35, p[0], p[1]);
    storeFins(k, 'aircraftGrey', p[2] - 1.6, 0.2, 0.3, p[0], p[1]);
  }
  // drop tanks: 2 wing + centreline, with pylons
  for (const s of [1, -1]) {
    const p = [s * 3.65, -1.0, -0.6];
    C(xf(storeBody(5.2, 0.36, 12, 0.34, 0.3), p));
    storeFins(k, 'jetCamo', p[2] - 2.1, 0.35, 0.55, p[0], p[1], 2, PI / 2);
    C(box(0.08, 0.5, 1.8, [p[0], -0.53, -0.9]));
    C(box(0.08, 0.45, 1.4, [s * 2.2, -0.52, -1.0])); // inner pylon (TER hangs below, in bombs group)
  }
  C(xf(storeBody(5.6, 0.42, 12, 0.34, 0.3), [0, -1.35, -0.6]));
  C(box(0.1, 0.35, 1.8, [0, -0.93, -0.6]));
  // numbers on the fin
  for (const s of [1, -1]) k.add('decals', decalQuad(decalUV('num508'), 0.9, 0.45, [s * 0.121, 1.3, -7.6], [0, s * PI / 2, 0]));
  k.build(mats, root, { name: 'f4' });

  // bombs (separate group so the game can hide them after release)
  const bombs = node('bombs', null, null, root);
  const kb = new Kit({ uvScale: 0.5 });
  for (const s of [1, -1]) {
    const x = s * 2.2;
    kb.add('darkMetal', box(0.3, 0.12, 1.9, [x, -0.8, -0.9]));
    addBomb(kb, 'olive2', 'olive2', [x + 0.2, -1.0, -0.9]);
    addBomb(kb, 'olive2', 'olive2', [x - 0.2, -1.0, -0.9]);
    addBomb(kb, 'olive2', 'olive2', [x, -1.22, -0.9]);
  }
  kb.build(mats, bombs, { name: 'f4Bombs' });

  node('afterburnerL', [0.56, -0.34, -8.95], [0, PI, 0], root);
  node('afterburnerR', [-0.56, -0.34, -8.95], [0, PI, 0], root);
  node('wingtipL', [5.85, 0.07, -2.9], null, root);
  node('wingtipR', [-5.85, 0.07, -2.9], null, root);
  node('gunMuzzle', [0, -0.68, 7.35], null, root);
  return root;
}

export function buildF4(mats) {
  const root = instance('f4', mats, buildF4Template);
  return pick(root, 'afterburnerL', 'afterburnerR', 'bombs', 'wingtipL', 'wingtipR', 'gunMuzzle');
}

// ---------------------------------------------------------------------------
// B-52 Stratofortress
// ---------------------------------------------------------------------------
function buildB52Template(mats) {
  const root = new THREE.Group();
  root.name = 'b52';
  const k = new Kit({ uvScale: 0.12 });
  const N = 24;
  const fus = [
    [23.8, 0.3, -0.75, -0.2, 2], [23.2, 1.7, -1.45, 0.5, 2.2], [22.0, 2.6, -1.85, 1.35, 2.6], [20.5, 2.9, -1.95, 1.95, 3],
    [17.0, 2.95, -2.0, 2.05, 3.2], [-10.0, 2.9, -1.85, 2.0, 3.2], [-16.0, 2.5, -1.3, 1.9, 3], [-20.0, 1.9, -0.7, 1.8, 2.8],
    [-23.0, 1.2, -0.1, 1.6, 2.4], [-24.4, 0.6, 0.35, 1.25, 2.2],
  ];
  k.add('bomberGrey', loft(rings(fus, N)));
  // cockpit glazing: a row of flat panes (glass band) with frame posts
  {
    const gl = rings([[22.05, 2.56, -1.82, 1.32, 2.6], [21.5, 2.78, -1.9, 1.74, 2.8], [20.9, 2.9, -1.95, 1.93, 3]], N);
    const sect = gl.map((r) => r.filter((_, i) => i >= 3 && i <= 9).map((p) => v3(p.x * 1.012, p.y * 1.012 + 0.006, p.z)));
    k.add('glass', loft(sect, { closed: false }));
    for (const f of [-0.75, -0.25, 0.25, 0.75]) k.add('bomberGrey', strut([f * 1.15, 1.42, 21.95], [f * 1.3, 1.95, 20.95], 0.035, 4));
  }
  // wing (high, swept, drooping) — root inside the fuselage top
  const W = [{ le: [1.2, 1.65, 6.2], chord: 11.2, t: 0.1 }, { le: [14.0, 1.0, -3.1], chord: 7.3, t: 0.09 }, { le: [28.2, -0.55, -13.5], chord: 3.3, t: 0.08 }];
  const wing = wingLoft(W, 'x', 6);
  k.add('bomberGrey', wing.clone());
  k.add('bomberGrey', mirrorX(wing));
  // wing position helpers
  const wingAt = (x) => {
    const i = x < W[1].le[0] ? 0 : 1;
    const a = W[i], b = W[i + 1];
    const t = (x - a.le[0]) / (b.le[0] - a.le[0]);
    return { y: a.le[1] + (b.le[1] - a.le[1]) * t, z: a.le[2] + (b.le[2] - a.le[2]) * t, chord: a.chord + (b.chord - a.chord) * t };
  };
  // engine pods: 4 twin pods on pylons
  const nacelle = lathe([[0.36, -0.7], [0.48, 0], [0.62, 0.8], [0.74, 2.2], [0.76, 3.6], [0.72, 4.7], [0.66, 5.2], [0.56, 5.3], [0.5, 5.1]], 14, 'z');
  const cone = lathe([[0.4, 0], [0.26, -0.5], [0, -0.75]], 10, 'z');
  for (const px of [9.8, 19.8]) {
    const w = wingAt(px);
    const py = w.y - 1.55, pz = w.z - 3.4;
    for (const s of [1, -1]) {
      for (const dx of [-0.78, 0.78]) {
        const x = s * px + dx;
        k.add('bomberGrey', xf(nacelle.clone(), [x, py, pz]));
        k.add('blackMetal', disc(0.5, 12, 'z', [x, py, pz + 5.0]));
        k.add('darkMetal', xf(lathe([[0, 0], [0.22, 0.05], [0.08, 0.45], [0, 0.5]], 8, 'z'), [x, py, pz + 4.9]));
        k.add('darkMetal', xf(cone.clone(), [x, py, pz - 0.65]));
      }
      // pylon
      const pyl = xf(extrude([[pz + 4.6, py + 0.5], [pz + 3.8, w.y + 0.2], [pz - 0.4, w.y + 0.2], [pz + 0.4, py + 0.5]], 0.34), null, [0, -PI / 2, 0]);
      k.add('bomberGrey', xf(pyl, [s * px, 0, 0]));
      k.add('bomberGrey', box(1.3, 0.3, 4.2, [s * px, py + 0.6, pz + 2.4]));
    }
  }
  // external tanks + outrigger gear pods near the tips
  for (const s of [1, -1]) {
    const wt = wingAt(22.5);
    k.add('bomberGrey', xf(storeBody(9.0, 0.62, 12, 0.3, 0.3), [s * 22.5, wt.y - 1.0, wt.z - 2.6]));
    k.add('bomberGrey', box(0.2, 0.7, 3.0, [s * 22.5, wt.y - 0.35, wt.z - 3.2]));
    storeFins(k, 'bomberGrey', wt.z - 6.3, 0.9, 1.1, s * 22.5, wt.y - 1.0, 2, PI / 2);
    const wo = wingAt(25.3);
    k.add('bomberGrey', xf(storeBody(3.2, 0.34, 10, 0.3, 0.3), [s * 25.3, wo.y - 0.55, wo.z - 1.6]));
    k.add('rubber', cyl(0.3, 0.3, 0.18, 10, 'x', false, [s * 25.3, wo.y - 0.9, wo.z - 2.2]));
  }
  // tall vertical tail + horizontal stabilizer
  k.add('bomberGrey', wingLoft([{ le: [0, 1.7, -12.8], chord: 9.6, t: 0.09 }, { le: [0, 11.0, -20.8], chord: 3.4, t: 0.08 }], 'y', 6));
  const hs = wingLoft([{ le: [0.8, 0.9, -16.8], chord: 6.2, t: 0.08 }, { le: [7.9, 0.9, -22.3], chord: 2.1, t: 0.06 }], 'x', 5);
  k.add('bomberGrey', hs.clone());
  k.add('bomberGrey', mirrorX(hs));
  // tail gun turret (4 guns) + radar dome
  k.add('darkMetal', lathe([[0.5, 0], [0.45, 0.35], [0.2, 0.5], [0, 0.52]], 10, '-z', [0, 0.8, -24.35]));
  for (const [dx, dy] of [[-0.12, -0.1], [0.12, -0.1], [-0.12, 0.1], [0.12, 0.1]]) k.add('darkMetal', cyl(0.035, 0.035, 1.2, 6, '-z', false, [dx, 0.8 + dy, -25.2]));
  k.add('glass', box(0.8, 0.35, 0.05, [0, 1.3, -24.0]));
  k.add('bomberGrey', lathe([[0.55, 0], [0.5, 0.3], [0, 0.45]], 10, 'y', [0, 1.55, -23.6]));
  // gear doors / bomb bay outline, antennas
  k.add('blackMetal', box(1.6, 0.02, 7.5, [0, -1.99, -1.0]));
  k.add('bomberGrey', box(1.2, 0.08, 3.5, [0, -2.0, 9.0]));
  k.add('bomberGrey', box(1.2, 0.08, 3.5, [0, -1.95, -12.0]));
  k.add('darkMetal', strut([0, 2.05, 12.0], [0, 2.8, 11.2], 0.03, 4));
  k.add('darkMetal', strut([0, 2.0, -4.0], [0, 2.6, -4.6], 0.03, 4));
  for (const s of [1, -1]) k.add('decals', decalQuad(decalUV('tailCode'), 4.2, 1.05, [s * 0.32, 4.0, -17.8], [0, s * PI / 2, 0]));
  k.build(mats, root, { name: 'b52' });
  node('bombBay', [0, -2.05, -1.0], null, root);
  return root;
}

export function buildB52(mats) {
  const root = instance('b52', mats, buildB52Template);
  return pick(root, 'bombBay');
}

// ---------------------------------------------------------------------------
// C-130-style cargo plane (friendly)
// ---------------------------------------------------------------------------
const C130 = {
  rampHinge: [-2.08, -5.4], // y, z (front edge of the ramp at the cargo floor)
  rampEnd: [-1.25, -8.5],
  doorEnd: [-0.2, -11.0], // aft end of the upper cargo door (its hinge)
};

/** Propeller blade along +Y from r0 to r1 with twist (pitch in radians) — rotates about Z. */
function propBlade(r0, r1, chord, pitch0, pitch1, n = 3, t = 0.08) {
  const secs = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const r = r0 + (r1 - r0) * f;
    const c = chord * (f < 0.15 ? 0.7 + f * 2 : 1 - (f - 0.15) * 0.25);
    const pitch = pitch0 + (pitch1 - pitch0) * f;
    const ringPts = foilRing([0, r, c * 0.3], c, t * (1 - f * 0.5), 'y', 4);
    const q = new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), PI / 2 - pitch);
    secs.push(ringPts.map((p) => p.applyQuaternion(q)));
  }
  return loft(secs);
}

function buildCargoTemplate(mats) {
  const root = new THREE.Group();
  root.name = 'c130';
  const k = new Kit({ uvScale: 0.2 });
  const N = 24;
  const front = [
    [14.1, 0.45, -0.98, -0.55, 2], [13.8, 1.6, -1.45, 0.05, 2], [13.2, 2.8, -1.78, 0.95, 2.1], [12.3, 3.7, -1.98, 1.65, 2.2],
    [11.0, 4.2, -2.08, 2.0, 2.3], [9.0, 4.3, -2.1, 2.1, 2.4], [-5.4, 4.3, -2.1, 2.1, 2.4],
  ];
  const rampSec = [[-5.4, 4.3, -2.1, 2.1, 2.4], [-8.5, 4.1, -1.25, 2.1, 2.4], [-11.0, 3.4, -0.2, 2.05, 2.3]];
  const tail = [[-11.0, 3.4, -0.2, 2.05, 2.3], [-13.5, 2.2, 0.75, 2.0, 2.2], [-15.8, 0.5, 1.45, 1.85, 2]];
  k.add('aircraftGrey', loft(rings(front, N), { capEnd: false }));
  k.add('aircraftGrey', loft(rings(tail, N), { capStart: false }));
  const rr = rings(rampSec, N);
  const iA = 15, iB = 21;
  const upper = rr.map((r) => { const o = []; for (let i = iB; i !== iA + 1; i = (i + 1) % N) o.push(r[i]); return o; });
  const lower = rr.map((r) => r.slice(iA, iB + 1));
  const upperGeo = loft(upper, { closed: false });
  k.add('aircraftGrey', upperGeo);
  k.add('interior', invert(upperGeo.clone()));
  k.add('interior', invert(box(3.0, 3.1, 14.6, [0, -0.05, 1.9])));
  // cockpit glazing
  {
    const gl = rings([[13.62, 1.95, -1.55, 0.35, 2], [13.25, 2.75, -1.76, 0.92, 2.1], [12.7, 3.4, -1.9, 1.38, 2.15], [12.1, 3.8, -2.0, 1.72, 2.2]], N);
    const sect = gl.map((r) => r.filter((_, i) => i >= 2 && i <= 10).map((p) => v3(p.x * 1.012, (p.y + 0.5) * 1.012 - 0.5, p.z + 0.01)));
    k.add('glass', loft(sect, { closed: false }));
    for (const x of [-0.95, 0, 0.95]) k.add('aircraftGrey', strut([x * 0.7, 0.35 + 0.05, 13.66], [x * 1.25, 1.62, 12.15], 0.04, 4));
    k.add('aircraftGrey', strut([1.6, 1.25, 12.75], [-1.6, 1.25, 12.75], 0.035, 4));
  }
  // side windows, paratroop doors, crew door outline
  for (const s of [1, -1]) {
    for (const z of [7.0, 3.5, 0.0, -3.0]) k.add('glass', disc(0.16, 10, s > 0 ? 'x' : '-x', [s * 2.152, 0.35, z]));
    k.add('decals', decalQuad(decalUV('roundel'), 1.7, 1.7, [s * 2.162, 0.5, -1.6], [0, s * PI / 2, 0]));
  }
  // landing gear sponsons
  for (const s of [1, -1]) {
    k.add('aircraftGrey', loft(rings([[3.4, 0.3, -1.6, -1.2, 2, s * 1.95], [2.6, 1.0, -2.05, -0.75, 2.4, s * 2.1], [-4.8, 1.0, -2.05, -0.75, 2.4, s * 2.1], [-5.8, 0.3, -1.7, -1.1, 2, s * 1.95]], 12)));
  }
  // wing: single loft tip-to-tip (centre section forms the hump over the fuselage)
  const wsec = [
    { le: [-20.2, 2.95, 2.3], chord: 2.7, t: 0.12 }, { le: [-10.2, 2.5, 2.52], chord: 3.9, t: 0.15 }, { le: [0, 2.2, 2.7], chord: 4.9, t: 0.17 },
    { le: [10.2, 2.5, 2.52], chord: 3.9, t: 0.15 }, { le: [20.2, 2.95, 2.3], chord: 2.7, t: 0.12 },
  ];
  k.add('aircraftGrey', wingLoft(wsec, 'x', 6));
  // roundels on the wings (top left, bottom right)
  k.add('decals', decalQuad(decalUV('roundel'), 2.0, 2.0, [14.5, 2.95, 0.9], [-PI / 2, 0, 0]));
  k.add('decals', decalQuad(decalUV('roundel'), 2.0, 2.0, [-14.5, 2.38, 0.9], [PI / 2, 0, 0]));
  // nacelles
  const nacRings = (x) => rings([
    [6.1, 0.84, 1.33, 2.17, 2, x], [5.4, 1.12, 1.0, 2.38, 2.2, x], [4.2, 1.28, 0.9, 2.55, 2.4, x], [1.0, 1.28, 0.95, 2.7, 2.5, x],
    [-2.0, 1.05, 1.25, 2.65, 2.3, x], [-4.4, 0.34, 1.95, 2.4, 2, x],
  ], 14);
  const props = [];
  const nacX = [10.2, 5.2, -5.2, -10.2];
  for (const x of nacX) {
    k.add('aircraftGrey', loft(nacRings(x)));
    k.add('blackMetal', xf(cbox(0.56, 0.3, 0.1, 0.06), [x, 1.18, 5.36]));
    k.add('darkMetal', cyl(0.1, 0.12, 0.4, 8, 'z', false, [x + (x > 0 ? 0.45 : -0.45), 2.2, -1.8]));
  }
  // tail: fin with dorsal fillet, stabilizers
  k.add('aircraftGrey', wingLoft([{ le: [0, 1.8, -9.9], chord: 5.6, t: 0.12 }, { le: [0, 8.4, -12.8], chord: 2.6, t: 0.1 }], 'y', 5));
  k.add('aircraftGrey', xf(xf(extrude([[-6.3, 2.0], [-10.2, 2.0], [-10.2, 3.4]], 0.34), null, [0, -PI / 2, 0]), [0, 0, 0]));
  const hs = wingLoft([{ le: [0.5, 2.05, -11.3], chord: 4.0, t: 0.1 }, { le: [7.9, 2.15, -13.3], chord: 1.7, t: 0.08 }], 'x', 5);
  k.add('aircraftGrey', hs.clone());
  k.add('aircraftGrey', mirrorX(hs));
  for (const s of [1, -1]) k.add('decals', decalQuad(decalUV('tailCode'), 2.6, 0.65, [s * 0.285, 4.6, -12.3], [0, s * PI / 2, 0]));
  // antennas
  k.add('darkMetal', strut([0, 2.1, 6.0], [0, 2.7, 5.5], 0.025, 4));
  k.add('darkMetal', strut([0, -2.1, 4.0], [0, -2.5, 3.6], 0.025, 4));
  k.build(mats, root, { name: 'c130' });

  // propellers (spin around Z)
  const blade = propBlade(0.36, 1.9, 0.46, 0.95, 0.4, 3);
  const tip = propBlade(1.9, 2.05, 0.36, 0.4, 0.38, 2);
  const spinner = lathe([[0.46, 0], [0.45, 0.3], [0.33, 0.7], [0.12, 0.98], [0, 1.0]], 12, 'z');
  nacX.forEach((x, i) => {
    const p = node(`prop${i}`, [x, 1.75, 6.05], null, root);
    const kp = new Kit({ uvScale: 0.5 });
    kp.add('aircraftGrey', spinner.clone());
    for (let b = 0; b < 4; b++) {
      const a = (b * PI) / 2 + PI / 4;
      kp.add('blackMetal', xf(blade.clone(), [0, 0, 0.3], [0, 0, a]));
      kp.add('markingYellow', xf(tip.clone(), [0, 0, 0.3], [0, 0, a]));
    }
    kp.build(mats, p, { name: `c130Prop${i}` });
    props.push(p);
  });

  // ramp (lower sector of the ramp section), mount faces aft so +rotation.x lowers it
  const [hy, hz] = C130.rampHinge;
  const rampMount = node('rampMount', [0, hy, hz], [0, PI, 0], root);
  const ramp = node('ramp', null, null, rampMount);
  const toLocal = (p, y0, z0) => v3(-p.x, p.y - y0, -(p.z - z0));
  const kr = new Kit({ uvScale: 0.2 });
  const rampRings = lower.slice(0, 2);
  kr.add('aircraftGrey', loft(rampRings.map((r) => r.map((p) => toLocal(p, hy, hz))), { closed: false }));
  const [ey, ez] = C130.rampEnd;
  const L = Math.hypot(ey - hy, hz - ez), ang = Math.atan2(ey - hy, hz - ez);
  kr.add('interior', xf(box(2.9, 0.06, L, [0, 0.2, L / 2]), null, [-ang, 0, 0]));
  for (let i = 0; i < 5; i++) kr.add('darkMetal', xf(box(2.7, 0.03, 0.06, [0, 0.25, 0.3 + (i * (L - 0.5)) / 4]), null, [-ang, 0, 0]));
  kr.build(mats, ramp, { name: 'c130Ramp' });

  // upper cargo door: hinged at its aft end; rotation.x = -angle swings it up into the fuselage
  const [dy, dz] = C130.doorEnd;
  const doorMount = node('cargoDoorMount', [0, dy, dz], null, root);
  const cargoDoor = node('cargoDoor', null, null, doorMount);
  const kd = new Kit({ uvScale: 0.2 });
  const dr = lower.slice(1, 3).map((r) => r.map((p) => v3(p.x, p.y - dy, p.z - dz)));
  const dg = loft(dr, { closed: false });
  kd.add('aircraftGrey', dg);
  kd.add('interior', invert(dg.clone()));
  kd.build(mats, cargoDoor, { name: 'c130Door' });

  node('dropPoint', [0, -1.2, -13.2], null, root);
  return root;
}

/** Ramp angle at which the C-130 ramp is level with the cargo floor (air-drop position). */
export const C130_RAMP_LEVEL = Math.atan2(C130.rampEnd[0] - C130.rampHinge[0], C130.rampHinge[1] - C130.rampEnd[1]);

export function buildCargoPlane(mats) {
  const root = instance('c130', mats, buildCargoTemplate);
  const out = pick(root, 'ramp', 'cargoDoor', 'dropPoint');
  out.props = [0, 1, 2, 3].map((i) => root.getObjectByName(`prop${i}`));
  out.rampOpenAngle = C130_RAMP_LEVEL;
  out.setRampOpen = (t) => {
    const f = Math.min(1, Math.max(0, t));
    out.ramp.rotation.x = f * C130_RAMP_LEVEL;
    out.cargoDoor.rotation.x = -f * 1.05;
  };
  return out;
}
