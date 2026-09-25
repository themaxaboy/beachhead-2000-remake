import * as THREE from 'three';
import { Terrain } from './Terrain.js';
import { Ocean } from './Ocean.js';
import { Sky } from './Sky.js';
import { Props } from './Props.js';
import { createShore } from './ShoreField.js';
import { CONFIG } from '../config.js';

/** Assembles the static environment: sky, sea, beach and scenery. */
export class World {
  constructor(game) {
    this.game = game;
    const { scene, assets, renderer } = game;
    this.sky = new Sky(renderer.renderer, scene, assets);
    const q = renderer.quality;
    this.terrain = new Terrain(assets, q.terrainSeg);
    scene.add(this.terrain.mesh);
    this.shore = createShore();
    this.ocean = new Ocean(assets, scene, q.water);
    this.ocean.attachShore(this.shore);
    this.terrain.attachShore?.(this.shore);
    this.props = new Props(assets, game.mats, q);
    scene.add(this.props.group);
    this.obstacles = this.props.obstacles;
    // Layer 1 = visible to the main and shadow cameras but skipped by the water reflection
    // (from the bunker the sea never reflects the beach, so rendering it twice is wasted work).
    this.terrain.mesh.layers.set(1);
    this.sky.sun.shadow.camera.layers.enable(1);
    this.focus = new THREE.Vector3();
  }

  async setTimeOfDay(name) {
    const preset = await this.sky.apply(name);
    this.ocean.applySky(this.sky, preset);
    const r = this.game.renderer;
    const g = preset.grade || [1, 1, 0];
    r.grade.set(g[0], g[1], g[2], 0);
    r.setSun(this.sky.sunDir, this.sky.sun.color, preset.godRays ?? 0);
    this.timeOfDay = name;
    return preset;
  }

  setQuality(q) {
    this.terrain.setSegments(q.terrainSeg);
    this.ocean.setMode(q.water);
    this.sky.setShadowSize(q.shadows);
    this.props.setGrass(q.grass);
    this.props.group.traverse((o) => o.layers.set(1));
  }

  update(dt, camera) {
    this.shore.update(dt);
    this.terrain.update(dt);
    this.ocean.update(dt);
    this.ocean.setWakes(this.game.entities?.list || []);
    this.props.update(dt);
    // Shadow frustum follows the aim point.
    camera.getWorldDirection(this.focus);
    this.focus.y = 0;
    this.focus.normalize().multiplyScalar(55).add(camera.position);
    this.sky.update(this.focus);
  }

  get waterline() {
    return CONFIG.world.waterlineZ;
  }
}
