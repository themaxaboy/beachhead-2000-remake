// Low-poly infantry soldier split into animatable parts for the game's instanced crowd system.
// Each part: { name, geometry (relative to its pivot), material (vertex-coloured), pivot (soldier space) }.
// Soldier stands on y = 0, faces +Z, left = +X, ~1.8 m tall.
import * as THREE from 'three';
import { xf, box, cbox, cyl, lathe, sphere, hull, v3, paint, strut, mergeAll, PI } from './geom.js';

const COL = {
  uniform: 0x566040,
  trousers: 0x4e583a,
  webbing: 0x78744f,
  pack: 0x5c6243,
  skin: 0xb98266,
  helmet: 0x4a5335,
  helmetBand: 0x3a3f2a,
  boots: 0x2a211a,
  rifle: 0x1d1e1f,
  rifleGrey: 0x3a3c3e,
};

/** Segment (open cylinder) from a to b with radii ra, rb. */
function limb(a, b, ra, rb, seg = 6) {
  const A = v3(...a), B = v3(...b);
  const g = new THREE.CylinderGeometry(rb, ra, A.distanceTo(B), seg, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), B.clone().sub(A).normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), q, v3(1, 1, 1)));
  return g;
}

function ellipseRing(n, y, w, d, zOff = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * PI * 2; pts.push(v3(Math.cos(a) * w / 2, y, zOff + Math.sin(a) * d / 2)); }
  return pts;
}

let _cache = null;

function buildParts() {
  const P = (g, c) => paint(g, c);
  const merge = (list) => mergeAll(list, { uv: 'none', keepColor: true });

  // --- torso (pivot at hip centre)
  const torso = merge([
    P(cbox(0.34, 0.22, 0.22, 0.04, [0, 0.05, 0]), COL.trousers),
    P(hull([...ellipseRing(8, 0.12, 0.31, 0.2), ...ellipseRing(8, 0.36, 0.4, 0.25, 0.01), ...ellipseRing(8, 0.5, 0.43, 0.22), ...ellipseRing(6, 0.56, 0.26, 0.15)]), COL.uniform),
    P(xf(cyl(0.18, 0.18, 0.06, 8, 'y', true), [0, 0.1, 0], null, [1, 1, 0.64]), COL.webbing),
    P(box(0.05, 0.38, 0.27, [0.1, 0.33, 0.005]), COL.webbing),
    P(box(0.05, 0.38, 0.27, [-0.1, 0.33, 0.005]), COL.webbing),
    P(box(0.09, 0.08, 0.05, [0.1, 0.1, 0.125]), COL.webbing),
    P(box(0.09, 0.08, 0.05, [-0.1, 0.1, 0.125]), COL.webbing),
    P(cyl(0.045, 0.045, 0.12, 6, 'y', false, [0.16, 0.06, -0.1]), COL.pack),
    P(box(0.28, 0.3, 0.12, [0, 0.33, -0.17]), COL.pack),
    P(box(0.3, 0.07, 0.07, [0, 0.52, -0.16]), COL.pack), // bedroll
  ]);

  // --- head + helmet (pivot at neck base)
  const head = merge([
    P(cyl(0.05, 0.056, 0.1, 6, 'y', true, [0, 0.04, 0]), COL.skin),
    P(sphere(0.1, 7, 5, [0, 0.15, 0.005], [0.86, 1.06, 1.0]), COL.skin),
    P(lathe([[0.142, 0.18], [0.136, 0.2], [0.126, 0.25], [0.1, 0.295], [0.05, 0.322], [0, 0.328]], 8, 'y'), COL.helmet),
    P(cyl(0.13, 0.13, 0.025, 8, 'y', true, [0, 0.215, 0]), COL.helmetBand),
  ]);

  // --- arms (pivot at the shoulder, hanging down -Y with slight elbow bend, hand at the end)
  const arm = (s) => merge([
    P(sphere(0.058, 6, 3, [0, -0.01, 0]), COL.uniform),
    P(limb([0, -0.01, 0], [s * 0.012, -0.3, -0.005], 0.055, 0.046), COL.uniform),
    P(limb([s * 0.012, -0.27, -0.01], [s * 0.005, -0.54, 0.07], 0.047, 0.038), COL.uniform),
    P(box(0.05, 0.1, 0.08, [s * 0.003, -0.6, 0.09], [0.25, 0, 0]), COL.skin),
  ]);

  // --- legs (pivot at the hip joint, foot at y = -0.92 so it reaches y = 0 when unrotated)
  const leg = () => merge([
    P(limb([0, 0.03, 0], [0, -0.44, 0.02], 0.085, 0.062), COL.trousers),
    P(limb([0, -0.41, 0.02], [0, -0.8, -0.01], 0.064, 0.048), COL.trousers),
    P(cyl(0.056, 0.052, 0.12, 6, 'y', true, [0, -0.76, -0.005]), COL.boots),
    P(cbox(0.11, 0.12, 0.28, 0.03, [0, -0.86, 0.045]), COL.boots),
  ]);

  // --- rifle (pivot at the pistol grip, barrel along +Z)
  const rifle = merge([
    P(box(0.045, 0.075, 0.3, [0, 0.05, 0.05]), COL.rifle),
    P(box(0.02, 0.035, 0.15, [0, 0.105, 0.06]), COL.rifle),
    P(cyl(0.028, 0.028, 0.3, 6, 'z', true, [0, 0.045, 0.35]), COL.rifleGrey),
    P(cyl(0.008, 0.008, 0.26, 4, 'z', true, [0, 0.045, 0.62]), COL.rifle),
    P(box(0.01, 0.06, 0.015, [0, 0.075, 0.5]), COL.rifle),
    P(box(0.04, 0.085, 0.28, [0, 0.02, -0.24], [0.08, 0, 0]), COL.rifle),
    P(box(0.03, 0.09, 0.04, [0, -0.03, -0.01], [0.3, 0, 0]), COL.rifle),
    P(box(0.025, 0.16, 0.06, [0, -0.05, 0.1], [-0.2, 0, 0]), COL.rifleGrey),
  ]);

  return {
    torso, head, armL: arm(1), armR: arm(-1), legL: leg(), legR: leg(), rifle,
  };
}

export const SOLDIER_PIVOTS = {
  torso: new THREE.Vector3(0, 0.95, 0),
  head: new THREE.Vector3(0, 1.5, 0),
  armL: new THREE.Vector3(0.215, 1.43, 0),
  armR: new THREE.Vector3(-0.215, 1.43, 0),
  legL: new THREE.Vector3(0.1, 0.92, 0),
  legR: new THREE.Vector3(-0.1, 0.92, 0),
  rifle: new THREE.Vector3(-0.12, 1.2, 0.36),
};

export function buildSoldierParts(mats) {
  if (!_cache) _cache = buildParts();
  const material = mats.soldier;
  const parts = Object.entries(_cache).map(([name, geometry]) => ({ name, geometry, material, pivot: SOLDIER_PIVOTS[name].clone() }));
  return { parts };
}
