// LCM-8 / LCT-style landing craft. Waterline at y = 0, bow (ramp) towards +Z, wheelhouse at the stern (-Z).
import * as THREE from 'three';
import { Kit, xf, box, cbox, cyl, lathe, node, instance, pick, PI, extrude, strut, decalQuad, disc } from './geom.js';
import { decalUV } from './materials.js';

export const LCT = {
  length: 22.4,
  beam: 6.4,
  draft: 1.2,
  deckY: 0.35, // well-deck floor height
  wallTop: 2.3,
  wellZ0: -4.0,
  hingeZ: 10.6,
  rampLen: 2.25,
  get cargoZ() { return (this.wellZ0 + this.hingeZ) / 2; },
};

const sideExtrude = (pts, w, x = 0) => xf(xf(extrude(pts, w), null, [0, -PI / 2, 0]), [x, 0, 0]);

function buildLCTTemplate(mats) {
  const C = LCT;
  const root = new THREE.Group();
  root.name = 'landingCraft';
  const k = new Kit({ uvScale: 0.3 });
  const zs = -11.2, zb = 10.9, hw = C.beam / 2, wall = 0.35, iw = hw - wall;

  // underwater hull (antifouling) with bow rake and stern skeg
  k.add('antifoul', sideExtrude([[zs, -0.85], [zs + 0.5, -1.2], [8.4, -1.2], [zb, -0.15], [zb, 0.0], [zs, 0.0]], C.beam));
  k.add('antifoul', box(0.25, 0.5, 6.0, [0, -1.4, -7.6]));
  // propeller tunnels / rudders
  for (const s of [1, -1]) {
    k.add('antifoul', box(0.06, 0.9, 0.7, [s * 1.2, -0.95, -10.9]));
    k.add('blackMetal', cyl(0.08, 0.08, 1.2, 8, 'z', false, [s * 1.2, -1.0, -10.0]));
  }
  // side walls (full length) + stern block + well-deck floor
  for (const s of [1, -1]) {
    k.add('navyGrey', box(wall, C.wallTop, zb - zs, [s * (iw + wall / 2), C.wallTop / 2, (zs + zb) / 2]));
    // rounded gunwale cap
    k.add('navyGrey', cyl(0.2, 0.2, zb - zs, 8, 'z', false, [s * (iw + wall / 2), C.wallTop, (zs + zb) / 2]));
    // rub rails / fenders
    k.add('rubber', cyl(0.12, 0.12, zb - zs - 0.6, 8, 'z', false, [s * (hw + 0.06), 1.55, (zs + zb) / 2]));
    k.add('rubber', cyl(0.09, 0.09, zb - zs - 1.6, 6, 'z', false, [s * (hw + 0.03), 0.45, (zs + zb) / 2 - 0.4]));
    // inner stiffeners along the well
    for (let z = C.wellZ0 + 0.9; z < C.hingeZ - 0.4; z += 1.25) k.add('navyGrey', box(0.1, C.wallTop - C.deckY, 0.12, [s * (iw - 0.05), (C.wallTop + C.deckY) / 2, z]));
    // bow ramp winch posts (A-frame + sheave)
    k.add('blackMetal', strut([s * (iw + 0.15), C.wallTop, 9.3], [s * (iw + 0.15), C.wallTop + 1.1, 9.9], 0.06, 6));
    k.add('blackMetal', strut([s * (iw + 0.15), C.wallTop, 10.5], [s * (iw + 0.15), C.wallTop + 1.1, 9.9], 0.06, 6));
    k.add('blackMetal', cyl(0.15, 0.15, 0.1, 10, 'x', false, [s * (iw + 0.15), C.wallTop + 1.1, 9.9]));
    // hull numbers near the bow
    k.add('decals', decalQuad(decalUV('numL62'), 1.6, 0.8, [s * (hw + 0.004), 1.0, 7.8], [0, s * PI / 2, 0]));
  }
  // deck (well) + double bottom
  k.add('deckGrey', box(2 * iw, C.deckY, zb - C.wellZ0 - 0.3, [0, C.deckY / 2, (C.wellZ0 + zb - 0.3) / 2]));
  // non-skid strips on the well deck
  for (let z = C.wellZ0 + 0.6; z < C.hingeZ - 0.3; z += 1.4) k.add('deckGrey', box(2 * iw - 0.3, 0.025, 0.08, [0, C.deckY + 0.012, z]));
  // bow sill below the ramp
  k.add('navyGrey', box(2 * iw, 0.2, 0.35, [0, C.deckY - 0.1, zb - 0.17]));
  // stern block (engine room) + aft deck
  k.add('navyGrey', box(2 * iw, C.wallTop - C.deckY, C.wellZ0 - zs, [0, (C.wallTop + C.deckY) / 2, (zs + C.wellZ0) / 2]));
  k.add('deckGrey', box(C.beam + 0.1, 0.05, C.wellZ0 - zs + 0.05, [0, C.wallTop + 0.2 + 0.02, (zs + C.wellZ0) / 2]));
  k.add('navyGrey', box(C.beam + 0.1, 0.2, C.wellZ0 - zs + 0.05, [0, C.wallTop + 0.1, (zs + C.wellZ0) / 2]));
  // stern fender
  k.add('rubber', cyl(0.14, 0.14, C.beam - 0.4, 8, 'x', false, [0, 1.6, zs - 0.08]));
  // aft bulkhead door + hatch
  k.add('navyGrey', cbox(0.9, 1.7, 0.08, 0.03, [1.6, C.deckY + 0.9, C.wellZ0 + 0.04]));
  k.add('blackMetal', box(0.06, 0.2, 0.06, [1.25, C.deckY + 0.95, C.wellZ0 + 0.1]));

  // wheelhouse
  const wz0 = -10.3, wz1 = -7.5, wy0 = C.wallTop + 0.22, wy1 = wy0 + 2.1, ww = 1.35;
  k.add('navyGrey', cbox(2 * ww, wy1 - wy0, wz1 - wz0, 0.08, [0, (wy0 + wy1) / 2, (wz0 + wz1) / 2]));
  // roof with overhang
  k.add('navyGrey', cbox(2 * ww + 0.3, 0.12, wz1 - wz0 + 0.5, 0.04, [0, wy1 + 0.06, (wz0 + wz1) / 2 + 0.15]));
  // windows: front 3 panes, 2 per side
  const wy = wy0 + 1.35;
  for (const x of [-0.85, 0, 0.85]) k.add('glass', box(0.72, 0.55, 0.04, [x, wy, wz1 + 0.01]));
  for (const s of [1, -1]) for (const z of [-9.5, -8.4]) k.add('glass', box(0.04, 0.55, 0.8, [s * (ww + 0.01), wy, z]));
  // wheelhouse door (starboard side = -X)
  k.add('navyGrey', cbox(0.06, 1.8, 0.8, 0.02, [-(ww + 0.03), wy0 + 0.92, -9.9]));
  // mast, yardarm, radar, nav lights
  const mz = -9.0;
  k.add('blackMetal', cyl(0.07, 0.1, 3.2, 8, 'y', false, [0, wy1 + 1.6, mz]));
  k.add('blackMetal', box(1.8, 0.07, 0.07, [0, wy1 + 2.4, mz]));
  k.add('blackMetal', cyl(0.25, 0.3, 0.12, 12, 'y', false, [0, wy1 + 0.3, mz + 0.9]));
  k.add('navyGrey', lathe([[0.36, 0], [0.38, 0.18], [0.3, 0.3], [0, 0.34]], 12, 'y', [0, wy1 + 0.36, mz + 0.9]));
  for (const s of [1, -1]) {
    k.add('glass', box(0.12, 0.15, 0.12, [s * 0.85, wy1 + 2.5, mz]));
    k.add('blackMetal', strut([s * 1.1, wy1 + 0.1, -10.1], [s * 1.18, wy1 + 3.2, -10.3], 0.012, 4));
  }
  k.add('glass', box(0.14, 0.16, 0.14, [0, wy1 + 3.28, mz]));
  // searchlight on the roof
  k.add('blackMetal', cyl(0.14, 0.14, 0.26, 10, 'z', false, [0.9, wy1 + 0.3, wz1 - 0.1]));
  // exhaust stacks, vents, bitts
  for (const s of [1, -1]) {
    k.add('blackMetal', cyl(0.16, 0.16, 1.3, 10, 'y', false, [s * 2.2, C.wallTop + 0.85, -6.2]));
    k.add('blackMetal', cyl(0.19, 0.16, 0.12, 10, 'y', false, [s * 2.2, C.wallTop + 1.5, -6.2]));
    k.add('navyGrey', lathe([[0.12, 0], [0.12, 0.5], [0.28, 0.55], [0.28, 0.65], [0, 0.7]], 10, 'y', [s * 1.7, C.wallTop + 0.2, -4.8]));
    for (const z of [-10.7, -4.6]) {
      k.add('blackMetal', cyl(0.12, 0.12, 0.45, 8, 'y', false, [s * 2.6, C.wallTop + 0.45, z - 0.2]));
      k.add('blackMetal', cyl(0.12, 0.12, 0.45, 8, 'y', false, [s * 2.6, C.wallTop + 0.45, z + 0.2]));
    }
    // bow bitts on the wall tops
    k.add('blackMetal', cyl(0.1, 0.1, 0.35, 8, 'y', false, [s * (iw + 0.15), C.wallTop + 0.2, 8.4]));
  }
  // guard rails around the aft deck
  {
    const ry0 = C.wallTop + 0.24, ry1 = ry0 + 1.0, rx = hw - 0.08;
    const pts = [];
    for (let z = C.wellZ0 - 0.1; z >= zs + 0.1; z -= 1.2) pts.push([rx, z]);
    for (let x = rx; x >= -rx; x -= 1.1) pts.push([x, zs + 0.1]);
    for (let z = zs + 0.1; z <= C.wellZ0 - 0.1; z += 1.2) pts.push([-rx, z]);
    for (const [x, z] of pts) k.add('blackMetal', cyl(0.025, 0.025, 1.0, 4, 'y', true, [x, (ry0 + ry1) / 2, z]));
    for (const y of [ry1, ry0 + 0.5]) {
      k.add('blackMetal', strut([rx, y, C.wellZ0 - 0.1], [rx, y, zs + 0.1], 0.02, 4));
      k.add('blackMetal', strut([-rx, y, C.wellZ0 - 0.1], [-rx, y, zs + 0.1], 0.02, 4));
      k.add('blackMetal', strut([rx, y, zs + 0.1], [-rx, y, zs + 0.1], 0.02, 4));
      // rail along the front edge of the aft deck (over the well)
      k.add('blackMetal', strut([rx, y, C.wellZ0 - 0.1], [-rx, y, C.wellZ0 - 0.1], 0.02, 4));
    }
  }
  const hullG = node('hull', null, null, root);
  k.build(mats, hullG, { name: 'lctHull' });

  // ---- bow ramp, hinged at the bottom front edge of the well deck
  const ramp = node('ramp', [0, C.deckY, C.hingeZ], null, hullG);
  const kr = new Kit({ uvScale: 0.3 });
  const rw = 2 * iw - 0.1, rl = C.rampLen, rt = 0.25;
  kr.add('navyGrey', box(rw, rl, rt, [0, rl / 2, rt / 2]));
  // outer face stiffeners (horizontal channels) + side cheeks
  for (let i = 0; i < 4; i++) kr.add('navyGrey', box(rw - 0.2, 0.14, 0.1, [0, 0.35 + i * 0.55, rt + 0.05]));
  for (const s of [1, -1]) kr.add('navyGrey', box(0.12, rl, 0.32, [s * (rw / 2 - 0.06), rl / 2, rt / 2 + 0.02]));
  // inner (loading) face: non-skid cleats
  kr.add('deckGrey', box(rw - 0.3, rl - 0.1, 0.03, [0, rl / 2, -0.01]));
  for (let y = 0.2; y < rl - 0.1; y += 0.28) kr.add('deckGrey', box(rw - 0.4, 0.05, 0.06, [0, y, -0.04]));
  // top lip + lifting eyes
  kr.add('navyGrey', cyl(0.12, 0.12, rw, 8, 'x', false, [0, rl, rt / 2]));
  for (const s of [1, -1]) kr.add('blackMetal', cyl(0.08, 0.08, 0.2, 8, 'x', false, [s * (rw / 2 - 0.3), rl + 0.05, rt / 2]));
  // hinge knuckles
  for (let x = -2.2; x <= 2.21; x += 1.1) kr.add('blackMetal', cyl(0.13, 0.13, 0.4, 10, 'x', false, [x, 0.0, 0.12]));
  kr.build(mats, ramp, { name: 'lctRamp' });
  return root;
}

/** Ramp rotation at which it is horizontal (pi/2) and at which its tip reaches the hull-bottom level. */
export const LCT_RAMP_HORIZONTAL = PI / 2;

export function buildLandingCraft(mats) {
  const root = instance('landingCraft', mats, buildLCTTemplate);
  const out = pick(root, 'hull', 'ramp');
  out.deckY = LCT.deckY;
  out.cargoZ = LCT.cargoZ;
  out.rampLength = LCT.rampLen;
  out.rampHinge = new THREE.Vector3(0, LCT.deckY, LCT.hingeZ);
  out.length = LCT.length;
  out.beam = LCT.beam;
  out.draft = LCT.draft;
  return out;
}
