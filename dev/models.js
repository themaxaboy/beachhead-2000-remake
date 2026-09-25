// Dev-only model viewer: lineup of every procedural model, or ?m=<key> for a close-up.
// Params: ?m=tank  &view=front|side|rear|top|fp|iso  &pose=open  &anim  &shot (hide nav)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import * as M from '../src/entities/models/index.js';

const params = new URLSearchParams(location.search);
const only = params.get('m');
const view = params.get('view');
const pose = params.get('pose');
const animate = params.has('anim');
if (params.has('shot')) document.body.classList.add('shot');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 3000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.position.set(40, 60, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

const statsEl = document.getElementById('stats');
const navEl = document.getElementById('nav');

// ---------------------------------------------------------------------------
function loadSet(id) {
  const tl = new THREE.TextureLoader();
  const base = `/assets/textures/${id}/${id}_`;
  const ld = (suffix, srgb) => tl.loadAsync(`${base}${suffix}_1k.jpg`).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }).catch(() => null);
  return Promise.all([ld('diff', true), ld('nor_gl', false), ld('rough', false)]).then(([map, normalMap, roughnessMap]) => ({ map, normalMap, roughnessMap }));
}

function soldierGroup(mats, posed) {
  const { parts } = M.buildSoldierParts(mats);
  const g = new THREE.Group();
  for (const p of parts) {
    const pivot = new THREE.Group();
    pivot.name = p.name;
    pivot.position.copy(p.pivot);
    const mesh = new THREE.Mesh(p.geometry, p.material);
    mesh.castShadow = mesh.receiveShadow = true;
    pivot.add(mesh);
    g.add(pivot);
    if (posed) {
      if (p.name === 'armR') pivot.rotation.set(-1.25, 0.25, 0);
      if (p.name === 'armL') pivot.rotation.set(-1.2, -0.45, 0);
      if (p.name === 'legL') pivot.rotation.x = -0.35;
      if (p.name === 'legR') pivot.rotation.x = 0.3;
    }
  }
  return g;
}

function has(fn) { return typeof M[fn] === 'function'; }

// Model catalogue: key, builder, lineup position, moving part keys (for static draw call count)
function catalogue(mats) {
  const L = [];
  const add = (key, fn, build, pos, rotY = 0, moving = []) => { if (has(fn)) L.push({ key, build, pos, rotY, moving }); };
  add('tank', 'buildTank', () => M.buildTank(mats), [-14, 0, 0], 0.5, ['turret']);
  add('apc', 'buildAPC', () => M.buildAPC(mats), [-6, 0, 0], 0.5, ['ramp', 'mg']);
  add('soldier', 'buildSoldierParts', () => ({ root: soldierGroup(mats, false) }), [-1, 0, 1], 0.3);
  add('soldierPose', 'buildSoldierParts', () => ({ root: soldierGroup(mats, true) }), [0, 0, 1], 0.3);
  add('crate', 'buildSupplyCrate', () => M.buildSupplyCrate(mats, 'ammo'), [2.2, 0, 1], 0.4);
  add('crateShield', 'buildSupplyCrate', () => M.buildSupplyCrate(mats, 'shield'), [4, 0, 1], -0.3);
  add('hedgehog', 'buildHedgehog', () => M.buildHedgehog(mats), [7, 0, 0.5], 0.2);
  add('sandbag', 'sandbagGeometry', () => ({ root: sandbagWall(mats) }), [11, 0, 0.5], 0);
  add('wire', 'barbedWireGeometry', () => ({ root: meshOf(M.barbedWireGeometry(8), mats.wire) }), [14, 0, 0], 0);
  add('parachute', 'buildParachute', () => M.buildParachute(mats, 3.5, false), [26, 1.5, 0], 0);
  add('parachuteCrate', 'buildParachute', () => withCrate(mats), [34, 2, 0], 0);
  add('lct', 'buildLandingCraft', () => M.buildLandingCraft(mats), [0, 1.2, -26], 0.35, ['ramp']);
  add('cobra', 'buildCobra', () => M.buildCobra(mats), [-46, 7, -70], 0.6, ['mainRotor', 'mainRotorBlur', 'tailRotor', 'chinGun']);
  add('ch53', 'buildCH53', () => M.buildCH53(mats), [-20, 8, -70], 0.6, ['mainRotor', 'mainRotorBlur', 'tailRotor', 'ramp', 'door']);
  add('f4', 'buildF4', () => M.buildF4(mats), [8, 8, -70], 0.6, ['bombs']);
  add('c130', 'buildCargoPlane', () => M.buildCargoPlane(mats), [45, 10, -80], 0.6, ['props', 'ramp']);
  add('b52', 'buildB52', () => M.buildB52(mats), [0, 14, -150], 0.5, []);
  add('twinmg', 'buildViewTwinMG', () => M.buildViewTwinMG(mats), [-6, 1.2, 18], PI, ['barrelL', 'barrelR']);
  add('atgun', 'buildViewATGun', () => M.buildViewATGun(mats), [-2.5, 1.2, 18], PI, ['barrel']);
  add('missile', 'buildViewMissilePod', () => M.buildViewMissilePod(mats), [0.5, 1.2, 18], PI, ['tubeL', 'tubeR']);
  add('pistol', 'buildViewPistol', () => M.buildViewPistol(mats), [2.5, 1.2, 18], PI, ['slide', 'magazine']);
  add('howitzer', 'buildViewHowitzer', () => M.buildViewHowitzer(mats), [6.5, 1.2, 18], PI, ['barrel']);
  return L;
}
const PI = Math.PI;

function meshOf(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function sandbagWall(mats) {
  const geo = M.sandbagGeometry();
  const n = 18;
  const im = new THREE.InstancedMesh(geo, mats.sandbag, n);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  let i = 0;
  for (let row = 0; row < 3; row++) for (let c = 0; c < 6; c++) {
    e.set(0, (Math.sin(i * 12.9) * 0.08), Math.sin(i * 7.1) * 0.04);
    q.setFromEuler(e);
    m4.compose(new THREE.Vector3(c * 0.6 + (row % 2 ? 0.3 : 0) - 1.5, row * 0.14, Math.sin(i) * 0.03), q, new THREE.Vector3(1, 1, 1));
    im.setMatrixAt(i++, m4);
  }
  im.castShadow = im.receiveShadow = true;
  return im;
}

function withCrate(mats) {
  const chute = M.buildParachute(mats, 3.2, true);
  const crate = M.buildSupplyCrate(mats, 'ammo');
  crate.root.position.y = -1.25;
  chute.root.add(crate.root);
  return chute;
}

function applyPose(key, o) {
  if (pose !== 'open') return;
  if (key === 'tank') { o.turret.rotation.y = 0.7; o.gun.rotation.x = -0.18; }
  if (key === 'apc') { o.setRampOpen ? o.setRampOpen(1) : (o.ramp.rotation.x = 1.4); o.mg.rotation.y = 0.6; }
  if (key === 'lct') o.ramp.rotation.x = 1.2;
  if (key === 'ch53') { o.setRampOpen ? o.setRampOpen(1) : null; if (o.door) o.door.position.z = -1.4; }
  if (key === 'c130') { o.setRampOpen ? o.setRampOpen(1) : null; }
  if (key === 'cobra') { o.chinGun.rotation.y = 0.4; }
  if (key === 'f4') { o.bombs.visible = false; }
}

function applyWreck(o, mats) {
  if (pose === 'wreck') M.applyCharred(o.root, mats);
}

function spin(key, o, t, dt) {
  if (!animate) return;
  if (o.mainRotor) o.mainRotor.rotation.y += dt * 30;
  if (o.tailRotor) o.tailRotor.rotation.x += dt * 90;
  if (o.props) for (const p of o.props) p.rotation.z += dt * 40;
  if (key === 'tank') o.turret.rotation.y = Math.sin(t * 0.5) * 1.2;
  if (key === 'apc' && o.setRampOpen) o.setRampOpen(0.5 + 0.5 * Math.sin(t));
}

function statsFor(o, moving) {
  const s = M.modelStats(o.root);
  let mov = 0;
  for (const k of moving) {
    const parts = k === 'props' ? o.props : [o[k]];
    for (const p of parts || []) if (p && p !== o.root) mov += M.modelStats(p).calls;
  }
  return { ...s, staticCalls: s.calls - mov };
}

// ---------------------------------------------------------------------------
async function main() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const [hdr, rustyMetal, greenMetalRust, concrete] = await Promise.all([
    new HDRLoader().loadAsync('/assets/hdri/day_2k.hdr'),
    loadSet('rusty_metal'), loadSet('green_metal_rust'), loadSet('concrete'),
  ]);
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = hdr;
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
  scene.environmentIntensity = 1.0;

  const mats = params.has('notex') ? M.createMaterials() : M.createMaterials({ rustyMetal, greenMetalRust, concrete });
  window.__mats = mats;

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), new THREE.MeshStandardMaterial({ color: 0xb09a76, roughness: 0.95 }));
  ground.rotation.x = -PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const cat = catalogue(mats);
  if (!only) {
    // small concrete plinth for the first-person viewmodels
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(17, 0.3, 4), mats.concrete);
    plinth.position.set(0.3, 0.15, 18);
    plinth.castShadow = plinth.receiveShadow = true;
    scene.add(plinth);
  }
  navEl.innerHTML = `<a href="?">lineup</a>` + cat.map((c) => `<a href="?m=${c.key}">${c.key}</a>`).join('');
  const lines = [];
  const built = [];
  const list = only ? cat.filter((c) => c.key === only) : cat;
  if (only && !list.length) statsEl.textContent = `unknown model ${only}`;
  for (const c of list) {
    const t0 = performance.now();
    const o = c.build();
    // build twice to make sure cached instancing works
    if (!only) c.build();
    const ms = performance.now() - t0;
    applyPose(c.key, o);
    applyWreck(o, mats);
    if (only) {
      o.root.position.set(0, 0, 0);
      o.root.rotation.y = 0;
    } else {
      o.root.position.set(...c.pos);
      o.root.rotation.y = c.rotY;
    }
    scene.add(o.root);
    const st = statsFor(o, c.moving);
    built.push({ c, o });
    const line = `${c.key.padEnd(15)} ${String(st.tris).padStart(6)} tris  ${String(st.calls).padStart(2)} calls (${st.staticCalls} static)  ${ms.toFixed(0)}ms`;
    lines.push(line);
    console.log('[models] ' + line);
  }
  statsEl.innerHTML = `<b>procedural models</b>\n` + lines.join('\n');

  // camera framing
  if (only && built.length) {
    const o = built[0].o;
    o.root.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(o.root);
    const isAir = ['cobra', 'ch53', 'f4', 'c130', 'b52'].includes(only);
    const isView = ['twinmg', 'atgun', 'missile', 'pistol', 'howitzer'].includes(only);
    if (isAir || isView) ground.position.y = bb.min.y - (isView ? 0.05 : 2);
    else if (only === 'lct') { ground.position.y = -1.2; }
    const sph = bb.getBoundingSphere(new THREE.Sphere());
    const zoom = parseFloat(params.get('zoom') || '1');
    const dist = sph.radius / Math.sin((camera.fov * PI) / 360) * 0.95 / zoom;
    const dirs = {
      front: [0.15, 0.2, 1], side: [1, 0.12, 0], rear: [-0.3, 0.3, -1], top: [0.01, 1, 0.02], iso: [0.9, 0.55, 0.9],
      left: [1, 0.25, 0.3], right: [-1, 0.25, 0.3], under: [0.3, -0.6, 0.6], fp: [0, 0.18, 1],
      rearlow: [-0.35, -0.08, -1], closeRear: [-0.3, 0.05, -1],
    };
    let d = dirs[view] || (isView ? dirs.fp : dirs.iso);
    const dir = new THREE.Vector3(...d).normalize();
    controls.target.copy(sph.center);
    if (view === 'fp' || (!view && isView)) {
      camera.fov = 50;
      camera.updateProjectionMatrix();
      camera.position.set(0, 0, 0);
      controls.target.set(0, 0, -1);
      // viewmodels: emulate the game placement (model a little below/in front of the eye)
      o.root.position.set(0, -0.28, -0.35);
      if (only === 'pistol') o.root.position.set(0.12, -0.13, -0.32);
      if (only === 'howitzer') o.root.position.set(0, -0.55, -0.6);
      if (only === 'atgun') o.root.position.set(0, -0.35, -0.3);
      ground.position.y = -3;
      camera.position.set(0, 0, 0.001);
    } else {
      camera.position.copy(sph.center).addScaledVector(dir, dist);
    }
    camera.near = Math.max(0.01, dist / 500);
    camera.far = dist * 20 + 500;
    camera.updateProjectionMatrix();
    sun.target.position.copy(sph.center);
    sun.position.copy(sph.center).add(new THREE.Vector3(30, 50, 25));
    const r = Math.max(sph.radius * 1.3, 4);
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 200 });
    sun.shadow.camera.updateProjectionMatrix();
  } else {
    const cams = {
      ground: [[-6, 6.5, 15], [-5, 1, 0]],
      props: [[19, 7, 17], [19, 1.5, 0]],
      air: [[40, 30, -10], [0, 8, -90]],
      sea: [[18, 14, -6], [0, 1, -26]],
      view: [[-1.5, 3.4, 12.2], [0.3, 1.2, 18.5]],
    };
    const cp = cams[params.get('cam')] || [[40, 45, 75], [0, 3, -35]];
    camera.position.set(...cp[0]);
    controls.target.set(...cp[1]);
    Object.assign(sun.shadow.camera, { left: -140, right: 140, top: 140, bottom: -140, near: 1, far: 400 });
    sun.position.set(60, 120, 40);
    sun.target.position.set(0, 0, -40);
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0008;
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  const timer = new THREE.Timer();
  let frames = 0;
  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05), t = timer.getElapsed();
    for (const { c, o } of built) spin(c.key, o, t, dt);
    controls.update();
    renderer.render(scene, camera);
    if (++frames === 3) window.__modelsReady = true;
  });
}

main().catch((e) => { console.error(e); statsEl.textContent = 'ERROR: ' + e.message; });
