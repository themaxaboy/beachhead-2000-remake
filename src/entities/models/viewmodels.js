// First-person viewmodels, built in CAMERA space: forward = -Z, +Y up, +X right.
// Origin = mount / trunnion / grip point. The game positions them in its overlay scene.
import * as THREE from 'three';
import {
  Kit, xf, box, cbox, cyl, lathe, node, instance, pick, PI, strut, disc, v3, invert, extrude, mirrorX, sphere,
} from './geom.js';

/** Scale the UVs of a geometry in place (for tiling alpha textures on cylinders). */
function scaleUV(g, su, sv) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

/** Tube along a Catmull-Rom path of points. */
function tubePath(points, r, seg = 8, radial = 5) {
  const c = new THREE.CatmullRomCurve3(points.map((p) => v3(...p)));
  return new THREE.TubeGeometry(c, seg, r, radial, false);
}

// ---------------------------------------------------------------------------
// Twin M2 .50 cal
// ---------------------------------------------------------------------------
function m2Gun(k, s) {
  // s = +1: feed from +X (right gun), -1: feed from -X (left gun). Gun centred at x = 0, barrel along -Z.
  k.add('darkMetal', cbox(0.14, 0.19, 0.62, 0.012, [0, 0, -0.03]));
  // side plate rivets
  for (const side of [1, -1]) for (let i = 0; i < 6; i++) {
    k.add('darkMetal', cyl(0.007, 0.007, 0.008, 6, 'x', false, [side * 0.072, -0.06 + (i % 2) * 0.1, 0.2 - Math.floor(i / 2) * 0.2]));
  }
  // top cover, latch, rear sight
  k.add('darkMetal', cbox(0.15, 0.04, 0.36, 0.01, [0, 0.112, -0.15]));
  k.add('blackMetal', box(0.05, 0.02, 0.04, [0, 0.135, -0.3]));
  k.add('blackMetal', box(0.03, 0.05, 0.02, [0, 0.14, 0.12]));
  // feed tray slot + charging handle on the feed side
  k.add('blackMetal', box(0.012, 0.05, 0.14, [s * 0.072, 0.07, -0.2]));
  k.add('darkMetal', box(0.02, 0.03, 0.12, [s * 0.08, -0.02, 0.05]));
  k.add('blackMetal', cyl(0.012, 0.012, 0.05, 6, 'x', false, [s * 0.1, -0.02, 0.1]));
  // backplate + spade grips + butterfly trigger
  k.add('darkMetal', cbox(0.17, 0.21, 0.05, 0.012, [0, -0.005, 0.3]));
  for (const x of [-0.06, 0.06]) {
    k.add('darkMetal', strut([x, -0.03, 0.32], [x * 1.2, -0.05, 0.4], 0.012, 6));
    k.add('rubber', strut([x * 1.2, -0.05, 0.39], [x * 1.25, -0.09, 0.5], 0.02, 8));
  }
  k.add('blackMetal', box(0.07, 0.03, 0.015, [0, -0.02, 0.335]));
  // trunnion block, barrel bearing sleeve, perforated jacket, barrel, muzzle
  k.add('darkMetal', cbox(0.12, 0.13, 0.08, 0.01, [0, 0, -0.37]));
  k.add('darkMetal', cyl(0.047, 0.047, 0.14, 12, '-z', false, [0, 0, -0.47]));
  k.add('perforated', scaleUV(cyl(0.043, 0.043, 0.58, 14, '-z', true, [0, 0, -0.83]), 5, 12), { uv: 'keep' });
  k.add('darkMetal', cyl(0.022, 0.022, 1.36, 10, '-z', false, [0, 0, -1.04]));
  for (const z of [-0.54, -0.83, -1.11]) k.add('darkMetal', cyl(0.048, 0.048, 0.025, 12, '-z', false, [0, 0, z]));
  k.add('blackMetal', lathe([[0.022, 0], [0.03, 0.015], [0.031, 0.08], [0.024, 0.095], [0.012, 0.095], [0.012, 0.02]], 10, '-z', [0, 0, -1.69]));
  k.add('darkMetal', box(0.008, 0.035, 0.015, [0, 0.035, -1.62]));
  // ammo box on the feed side + belt of brass
  k.add('olive', cbox(0.13, 0.19, 0.3, 0.01, [s * 0.2, -0.11, -0.16]));
  k.add('olive', cbox(0.135, 0.02, 0.305, 0.006, [s * 0.2, -0.01, -0.16]));
  k.add('darkMetal', box(0.02, 0.02, 0.12, [s * 0.27, -0.06, -0.16]));
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const x = s * (0.19 - t * 0.12), y = 0.0 + Math.sin(t * PI) * 0.05 + t * 0.06;
    k.add('brass', cyl(0.0105, 0.0105, 0.1, 6, '-z', true, [x, y, -0.2]));
    k.add('darkMetal', cyl(0.001, 0.0095, 0.035, 6, '-z', false, [x, y, -0.268]));
    k.add('blackMetal', box(0.012, 0.024, 0.08, [x, y - 0.012, -0.2]));
  }
}

function buildTwinMGTemplate(mats) {
  const root = new THREE.Group();
  root.name = 'viewTwinMG';
  const guns = {};
  for (const [name, x, s] of [['barrelL', -0.32, -1], ['barrelR', 0.32, 1]]) {
    const g = node(name, [x, 0, 0], null, root);
    const k = new Kit({ uvScale: 2 });
    m2Gun(k, s);
    k.build(mats, g, { name });
    node(name === 'barrelL' ? 'muzzleL' : 'muzzleR', [0, 0, -1.79], null, g);
    guns[name] = g;
  }
  // cradle, pedestal, shield plate, AA ring sight
  const k = new Kit({ uvScale: 2 });
  k.add('darkMetal', cbox(0.84, 0.05, 0.34, 0.01, [0, -0.135, -0.2]));
  for (const x of [-0.32, 0.32]) k.add('darkMetal', cbox(0.17, 0.07, 0.3, 0.01, [x, -0.11, -0.25]));
  k.add('darkMetal', cyl(0.07, 0.08, 0.9, 12, 'y', false, [0, -0.6, -0.2]));
  k.add('darkMetal', cyl(0.12, 0.12, 0.06, 14, 'y', false, [0, -0.19, -0.2]));
  // handles to traverse
  for (const x of [-0.2, 0.2]) k.add('rubber', strut([x, -0.16, 0.0], [x, -0.24, 0.22], 0.018, 8));
  // armoured shield plate at the bottom edge (tilted back), with bolts
  {
    const sh = new THREE.Shape([[-0.9, -0.85], [0.9, -0.85], [0.9, -0.3], [0.7, -0.2], [0.3, -0.2], [0.22, -0.28], [-0.22, -0.28], [-0.3, -0.2], [-0.7, -0.2], [-0.9, -0.3]].map(([x, y]) => new THREE.Vector2(x, y)));
    const g = extrude(sh, 0.025, 0.006, 1);
    xf(g, null, [-0.2, 0, 0]);
    k.add('olive', xf(g, [0, 0, -0.62]));
    for (let i = 0; i < 9; i++) {
      const x = -0.8 + i * 0.2;
      if (Math.abs(x) < 0.3) continue;
      k.add('darkMetal', cyl(0.012, 0.012, 0.012, 6, 'z', false, [x, -0.26, -0.62 + 0.012 - 0.26 * Math.sin(0.2)]));
    }
    // side wings folded back
    for (const s of [1, -1]) {
      const w = extrude([[0, -0.85], [0.35, -0.85], [0.35, -0.38], [0, -0.3]], 0.025, 0.006, 1);
      xf(w, null, [0, s > 0 ? -0.6 - PI / 2 : 0.6 + PI / 2, 0]);
      k.add('olive', xf(w, [s * 0.9, 0, -0.62]));
    }
  }
  k.build(mats, root, { name: 'twinMGMount' });
  // AA ring sight on a post between the guns
  const sight = node('sight', [0, 0.2, -0.75], null, root);
  const ks = new Kit({ uvScale: 2 });
  ks.add('darkMetal', new THREE.TorusGeometry(0.1, 0.005, 4, 24));
  ks.add('darkMetal', new THREE.TorusGeometry(0.05, 0.004, 4, 16));
  ks.add('darkMetal', box(0.2, 0.004, 0.004));
  ks.add('darkMetal', box(0.004, 0.2, 0.004));
  ks.add('darkMetal', strut([0, -0.1, 0], [0, -0.33, 0.1], 0.008, 5));
  ks.add('darkMetal', strut([0, 0.0, 0.85], [0, -0.33, 0.6], 0.008, 5));
  ks.add('darkMetal', cyl(0.012, 0.012, 0.01, 8, 'z', false, [0, 0, 0.85]));
  ks.build(mats, sight, { name: 'twinMGSight' });
  node('pistolMount', [0.26, -0.02, -0.42], null, root);
  return root;
}

export function buildViewTwinMG(mats) {
  const root = instance('viewTwinMG', mats, buildTwinMGTemplate);
  return pick(root, 'barrelL', 'barrelR', 'muzzleL', 'muzzleR', 'pistolMount', 'sight');
}

// ---------------------------------------------------------------------------
// 75 mm AT gun
// ---------------------------------------------------------------------------
function buildATGunTemplate(mats) {
  const root = new THREE.Group();
  root.name = 'viewATGun';
  const barrel = node('barrel', null, null, root);
  const kb = new Kit({ uvScale: 2 });
  kb.add('olive2', lathe([[0, -0.12], [0.09, -0.12], [0.09, 0.22], [0.076, 0.27], [0.064, 1.9], [0.06, 2.2]], 16, '-z'));
  // double-baffle muzzle brake
  kb.add('olive2', lathe([[0.058, 2.17], [0.105, 2.19], [0.105, 2.29], [0.07, 2.31], [0.07, 2.37], [0.105, 2.39], [0.105, 2.5], [0.045, 2.52], [0.042, 2.3]], 16, '-z'));
  for (const s of [1, -1]) kb.add('blackMetal', box(0.012, 0.11, 0.055, [s * 0.1, 0, -2.34]));
  kb.add('blackMetal', disc(0.044, 12, '-z', [0, 0, -2.4]));
  // breech ring
  kb.add('darkMetal', cbox(0.26, 0.26, 0.36, 0.025, [0, 0, 0.3]));
  kb.add('darkMetal', box(0.06, 0.04, 0.3, [0, 0.14, 0.3]));
  kb.build(mats, barrel, { name: 'atBarrel' });
  const breech = node('breech', [0, -0.02, 0.47], null, barrel);
  const kbr = new Kit({ uvScale: 2 });
  kbr.add('darkMetal', cbox(0.18, 0.16, 0.08, 0.012));
  kbr.add('blackMetal', box(0.05, 0.05, 0.02, [0, 0.02, 0.045]));
  kbr.add('darkMetal', strut([0.09, 0, 0], [0.2, -0.05, 0.14], 0.012, 6));
  kbr.add('rubber', cyl(0.018, 0.018, 0.08, 8, 'y', false, [0.21, -0.08, 0.15]));
  kbr.build(mats, breech, { name: 'atBreech' });
  node('muzzle', [0, 0, -2.53], null, barrel);
  // cradle, recoil cylinders, shield, sight, handwheel (static)
  const k = new Kit({ uvScale: 2 });
  k.add('olive', cyl(0.11, 0.11, 0.8, 16, '-z', false, [0, 0, -0.3]));
  for (const y of [0.16, -0.15]) {
    k.add('olive', cyl(0.05, 0.05, 1.0, 12, '-z', false, [0, y, -0.25]));
    k.add('darkMetal', cyl(0.055, 0.055, 0.04, 12, '-z', false, [0, y, 0.25]));
    k.add('darkMetal', box(0.05, Math.abs(y), 0.06, [0, y / 2, -0.7]));
  }
  {
    const sh = new THREE.Shape([[-0.8, -0.6], [0.8, -0.6], [0.8, 0.3], [0.6, 0.5], [-0.6, 0.5], [-0.8, 0.3]].map(([x, y]) => new THREE.Vector2(x, y)));
    const hole = new THREE.Path(); hole.absarc(0, 0, 0.14, 0, PI * 2, false); sh.holes.push(hole);
    const win = new THREE.Path([[-0.4, 0.12], [-0.25, 0.12], [-0.25, 0.22], [-0.4, 0.22]].map(([x, y]) => new THREE.Vector2(x, y)));
    sh.holes.push(win);
    const g = extrude(sh, 0.02, 0.005, 12);
    xf(g, null, [-0.1, 0, 0]);
    k.add('olive', xf(g, [0, 0, -0.75]));
    for (const s of [1, -1]) {
      const w = extrude([[0, -0.6], [0.3, -0.6], [0.3, 0.2], [0, 0.3]], 0.02, 0.005, 1);
      xf(w, null, [0, s > 0 ? -0.5 - PI / 2 : 0.5 + PI / 2, 0]);
      k.add('olive', xf(w, [s * 0.8, 0, -0.75]));
    }
    // shield bolts
    for (let i = 0; i < 7; i++) k.add('darkMetal', cyl(0.012, 0.012, 0.012, 6, 'z', false, [-0.6 + i * 0.2, 0.42, -0.72]));
  }
  // sight telescope on the left + eyepiece
  k.add('blackMetal', cyl(0.03, 0.03, 0.5, 12, '-z', false, [-0.22, 0.13, 0.0]));
  k.add('rubber', cyl(0.035, 0.03, 0.06, 12, '-z', false, [-0.22, 0.13, 0.27]));
  k.add('glass', disc(0.026, 10, '-z', [-0.22, 0.13, -0.252]));
  k.add('darkMetal', box(0.1, 0.04, 0.06, [-0.16, 0.1, 0.0]));
  // elevation handwheel
  k.add('darkMetal', xf(new THREE.TorusGeometry(0.08, 0.008, 5, 16), [-0.26, -0.12, 0.2], [0, PI / 2, 0]));
  k.add('darkMetal', cyl(0.01, 0.01, 0.12, 6, 'x', false, [-0.2, -0.12, 0.2]));
  k.add('rubber', cyl(0.012, 0.012, 0.05, 6, 'x', false, [-0.29, -0.05, 0.2]));
  k.build(mats, root, { name: 'atMount' });
  return root;
}

export function buildViewATGun(mats) {
  const root = instance('viewATGun', mats, buildATGunTemplate);
  return pick(root, 'barrel', 'muzzle', 'breech');
}

// ---------------------------------------------------------------------------
// Twin missile launch tubes
// ---------------------------------------------------------------------------
function buildMissilePodTemplate(mats) {
  const root = new THREE.Group();
  root.name = 'viewMissilePod';
  for (const [side, x] of [['L', -0.28], ['R', 0.28]]) {
    const tube = node(`tube${side}`, [x, 0, 0], null, root);
    const k = new Kit({ uvScale: 2 });
    k.add('olive', cyl(0.115, 0.115, 1.5, 18, '-z', true, [0, 0, -0.3]));
    k.add('interior', invert(cyl(0.108, 0.108, 1.5, 18, '-z', true, [0, 0, -0.3])));
    k.add('darkMetal', lathe([[0.108, 0], [0.13, 0.005], [0.13, 0.07], [0.108, 0.075]], 18, '-z', [0, 0, 0.42]));
    k.add('darkMetal', lathe([[0.108, 0], [0.13, 0.005], [0.13, 0.07], [0.108, 0.075]], 18, '-z', [0, 0, -0.98]));
    for (const z of [-0.2, 0.2]) k.add('olive2', cyl(0.122, 0.122, 0.06, 18, '-z', true, [0, 0, z]));
    k.add('markingYellow', cyl(0.117, 0.117, 0.05, 18, '-z', true, [0, 0, -0.85]));
    k.add('blackMetal', disc(0.108, 16, 'z', [0, 0, 0.5]));
    k.build(mats, tube, { name: `tube${side}` });
    const missile = node(`missile${side}`, null, null, tube);
    const km = new Kit({ uvScale: 2 });
    km.add('aircraftGrey', lathe([[0.085, 0], [0.085, 0.5], [0.08, 0.62], [0.06, 0.72], [0.035, 0.76]], 14, '-z', [0, 0, -0.2]));
    km.add('glass', sphere(0.036, 10, 6, [0, 0, -0.955], [1, 1, 0.8]));
    km.add('markingYellow', cyl(0.086, 0.086, 0.03, 14, '-z', true, [0, 0, -0.62]));
    for (let i = 0; i < 4; i++) {
      const a = (i * PI) / 2 + PI / 4;
      km.add('aircraftGrey', xf(box(0.004, 0.035, 0.07, [0, 0.1, 0]), [0, 0, -0.78], [0, 0, a]));
    }
    km.build(mats, missile, { name: `missile${side}` });
    node(`muzzle${side}`, [0, 0, -1.07], null, tube);
  }
  // centre sight unit, cross members, grips, pedestal
  const k = new Kit({ uvScale: 2 });
  k.add('blackMetal', cbox(0.13, 0.15, 0.34, 0.015, [0, 0.03, -0.1]));
  k.add('glass', disc(0.045, 12, '-z', [0, 0.05, -0.272]));
  k.add('rubber', cyl(0.035, 0.04, 0.08, 12, '-z', false, [0, 0.05, 0.1]));
  for (const z of [-0.5, 0.15]) k.add('olive2', cbox(0.62, 0.05, 0.08, 0.01, [0, -0.13, z]));
  for (const s of [1, -1]) {
    k.add('olive2', cbox(0.05, 0.1, 0.08, 0.01, [s * 0.28, -0.1, -0.5]));
    k.add('olive2', cbox(0.05, 0.1, 0.08, 0.01, [s * 0.28, -0.1, 0.15]));
    k.add('rubber', xf(cbox(0.035, 0.12, 0.05, 0.01), [s * 0.14, -0.22, 0.28], [0.35, 0, 0]));
  }
  k.add('darkMetal', cyl(0.05, 0.06, 0.8, 12, 'y', false, [0, -0.55, -0.15]));
  k.add('blackMetal', tubePath([[0.05, 0.02, 0.08], [0.12, -0.05, 0.25], [0.14, -0.2, 0.3]], 0.01, 10, 5));
  k.build(mats, root, { name: 'missileMount' });
  return root;
}

export function buildViewMissilePod(mats) {
  const root = instance('viewMissilePod', mats, buildMissilePodTemplate);
  return pick(root, 'tubeL', 'tubeR', 'missileL', 'missileR', 'muzzleL', 'muzzleR');
}

// ---------------------------------------------------------------------------
// 1911-style pistol in a gloved right hand (origin at the grip)
// ---------------------------------------------------------------------------
function buildPistolTemplate(mats) {
  const root = new THREE.Group();
  root.name = 'viewPistol';
  const yb = 0.052; // bore axis height
  // slide (moves +Z when firing)
  const slide = node('slide', null, null, root);
  const ks = new Kit({ uvScale: 6 });
  ks.add('blackMetal', cbox(0.024, 0.031, 0.21, 0.004, [0, yb, -0.03]));
  for (let i = 0; i < 7; i++) {
    const z = 0.04 + i * 0.0045;
    for (const s of [1, -1]) ks.add('blackMetal', box(0.002, 0.024, 0.0022, [s * 0.0125, yb - 0.001, z]));
  }
  ks.add('darkMetal', box(0.002, 0.014, 0.035, [0.0122, yb + 0.005, -0.01]));
  ks.add('blackMetal', box(0.008, 0.008, 0.006, [0, yb + 0.019, 0.068]));
  ks.add('blackMetal', box(0.004, 0.007, 0.006, [0, yb + 0.019, -0.128]));
  ks.add('darkMetal', cyl(0.0095, 0.0095, 0.006, 12, '-z', false, [0, yb - 0.002, -0.136]));
  ks.add('darkMetal', cyl(0.0065, 0.0065, 0.008, 12, '-z', true, [0, yb - 0.002, -0.137]));
  ks.add('blackMetal', disc(0.0045, 8, '-z', [0, yb - 0.002, -0.137]));
  ks.build(mats, slide, { name: 'pistolSlide' });
  node('muzzle', [0, yb - 0.002, -0.142], null, slide);
  // frame, trigger guard, trigger, hammer, safeties
  const k = new Kit({ uvScale: 6 });
  k.add('blackMetal', cbox(0.022, 0.018, 0.13, 0.003, [0, yb - 0.024, -0.06]));
  k.add('blackMetal', box(0.008, 0.006, 0.052, [0, 0.0, -0.047]));
  k.add('blackMetal', box(0.008, 0.034, 0.006, [0, 0.014, -0.072], [0.25, 0, 0]));
  k.add('darkMetal', box(0.006, 0.02, 0.008, [0, 0.016, -0.03], [0.2, 0, 0]));
  k.add('blackMetal', box(0.008, 0.016, 0.01, [0, yb + 0.004, 0.08], [-0.5, 0, 0]));
  k.add('blackMetal', box(0.02, 0.008, 0.03, [0, yb - 0.02, 0.075], [-0.3, 0, 0]));
  k.add('blackMetal', box(0.004, 0.006, 0.02, [-0.013, yb - 0.018, 0.04]));
  k.add('blackMetal', box(0.004, 0.005, 0.03, [-0.013, yb - 0.026, -0.02]));
  // grip (angled), grip panels
  const grip = (g) => xf(g, [0, -0.03, 0.028], [0.3, 0, 0]);
  k.add('blackMetal', grip(cbox(0.026, 0.12, 0.048, 0.004)));
  k.add('rubber', grip(cbox(0.031, 0.09, 0.04, 0.005, [0, 0.005, 0])));
  k.build(mats, root, { name: 'pistolFrame' });
  // magazine (drops for reload)
  const magazine = node('magazine', [0, -0.03, 0.028], [0.3, 0, 0], root);
  const km = new Kit({ uvScale: 6 });
  km.add('darkMetal', box(0.02, 0.11, 0.032, [0, -0.005, 0]));
  km.add('blackMetal', cbox(0.026, 0.01, 0.046, 0.003, [0, -0.064, 0.002]));
  km.build(mats, magazine, { name: 'pistolMag' });
  // gloved hand + sleeve
  const kh = new Kit({ uvScale: 8 });
  const G = (g) => xf(g, [0, -0.03, 0.028], [0.3, 0, 0]); // into grip-aligned frame
  // palm / back of hand around the grip (grip frame coordinates)
  kh.add('glove', G(sphere(0.045, 10, 8, [0.012, 0.0, 0.03], [0.62, 1.2, 0.75])));
  // three fingers wrapping the front strap
  for (const [y, r] of [[0.012, 0.0095], [-0.014, 0.0092], [-0.04, 0.0085]]) {
    kh.add('glove', G(tubePath([[0.021, y, 0.01], [0.02, y, -0.022], [0.0, y - 0.002, -0.036], [-0.019, y - 0.001, -0.02], [-0.018, y, 0.0]], r, 10, 6)));
  }
  // index finger along the frame onto the trigger
  kh.add('glove', tubePath([[0.018, 0.018, 0.0], [0.016, 0.026, -0.03], [0.01, 0.02, -0.05], [0.002, 0.012, -0.036]], 0.0095, 10, 6));
  // thumb along the left side
  kh.add('glove', tubePath([[0.005, 0.012, 0.05], [-0.016, 0.026, 0.02], [-0.019, 0.032, -0.02]], 0.011, 8, 6));
  // wrist, cuff, sleeve
  kh.add('glove', tubePath([[0.012, -0.035, 0.06], [0.02, -0.07, 0.13], [0.03, -0.1, 0.2]], 0.034, 8, 10));
  kh.add('glove', cyl(0.04, 0.038, 0.05, 12, 'y', true, [0.03, -0.11, 0.21]).rotateX(0));
  kh.add('sleeve', tubePath([[0.03, -0.1, 0.2], [0.04, -0.16, 0.33], [0.05, -0.24, 0.52]], 0.046, 8, 12));
  kh.build(mats, root, { name: 'pistolHand' });
  return root;
}

export function buildViewPistol(mats) {
  const root = instance('viewPistol', mats, buildPistolTemplate);
  return pick(root, 'slide', 'magazine', 'muzzle');
}

// ---------------------------------------------------------------------------
// 155 mm howitzer
// ---------------------------------------------------------------------------
function buildHowitzerTemplate(mats) {
  const root = new THREE.Group();
  root.name = 'viewHowitzer';
  const barrel = node('barrel', null, null, root);
  const kb = new Kit({ uvScale: 1 });
  kb.add('olive2', lathe([[0, -0.3], [0.2, -0.3], [0.2, 0.55], [0.165, 0.65], [0.14, 2.2], [0.2, 2.32], [0.21, 2.45], [0.21, 3.1], [0.2, 3.22], [0.135, 3.32], [0.12, 4.9]], 20, '-z'));
  kb.add('darkMetal', cyl(0.212, 0.212, 0.04, 20, '-z', true, [0, 0, -2.5]));
  kb.add('darkMetal', cyl(0.212, 0.212, 0.04, 20, '-z', true, [0, 0, -3.05]));
  // double-baffle muzzle brake with side ports
  kb.add('olive2', lathe([[0.118, 4.88], [0.2, 4.9], [0.2, 5.05], [0.14, 5.07], [0.14, 5.25], [0.2, 5.27], [0.2, 5.45], [0.085, 5.47], [0.08, 5.25]], 20, '-z'));
  for (const s of [1, -1]) kb.add('blackMetal', box(0.012, 0.2, 0.16, [s * 0.14, 0, -5.16]));
  kb.add('blackMetal', disc(0.08, 16, '-z', [0, 0, -5.3]));
  // breech ring + block + firing lock
  kb.add('darkMetal', cbox(0.52, 0.52, 0.56, 0.04, [0, 0, 0.55]));
  kb.add('blackMetal', cbox(0.3, 0.32, 0.06, 0.02, [0, 0, 0.84]));
  kb.add('darkMetal', cyl(0.05, 0.05, 0.08, 10, 'z', false, [0, 0, 0.9]));
  kb.add('darkMetal', strut([0.2, 0.1, 0.85], [0.35, 0.2, 1.1], 0.02, 6));
  kb.build(mats, barrel, { name: 'howBarrel' });
  node('muzzle', [0, 0, -5.48], null, barrel);
  // cradle + recoil/recuperator cylinders (static)
  const k = new Kit({ uvScale: 1 });
  k.add('olive', cbox(0.56, 0.38, 1.3, 0.04, [0, 0, -0.35]));
  for (const x of [-0.16, 0.16]) {
    k.add('olive', cyl(0.07, 0.07, 1.9, 14, '-z', false, [x, 0.27, -0.55]));
    k.add('darkMetal', cyl(0.075, 0.075, 0.05, 14, '-z', false, [x, 0.27, 0.42]));
  }
  k.add('olive', cyl(0.09, 0.09, 1.7, 14, '-z', false, [0, -0.28, -0.45]));
  k.add('darkMetal', box(0.3, 0.06, 0.08, [0, 0.22, -1.45]));
  k.build(mats, root, { name: 'howCradle' });
  return root;
}

export function buildViewHowitzer(mats) {
  const root = instance('viewHowitzer', mats, buildHowitzerTemplate);
  return pick(root, 'barrel', 'muzzle');
}
