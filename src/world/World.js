import * as THREE from 'three';
import { Terrain } from './Terrain.js';
import { Ocean } from './Ocean.js';
import { Sky } from './Sky.js';
import { Props } from './Props.js';
import { CONFIG } from '../config.js';

/** Assembles the static environment: sky, sea, beach and scenery. */
export class World {
  constructor(game) {
    this.game = game;
    const { scene, assets, renderer } = game;
    this.sky = new Sky(renderer.renderer, scene, assets);
    this.terrain = new Terrain(assets);
    scene.add(this.terrain.mesh);
    const q = renderer.quality;
    this.ocean = new Ocean(assets, scene, q.water);
    this.props = new Props(assets, game.mats, q);
    scene.add(this.props.group);
    this.obstacles = this.props.obstacles;
    this.focus = new THREE.Vector3();
  }

  async setTimeOfDay(name) {
    const preset = await this.sky.apply(name);
    this.ocean.applySky(this.sky.sunDir, this.sky.sun.color, preset.water, preset.sunIntensity);
    this.timeOfDay = name;
    return preset;
  }

  setQuality(q) {
    this.ocean.setMode(q.water);
    this.sky.setShadowSize(q.shadows);
    this.props.setGrass(q.grass);
  }

  update(dt, camera) {
    this.terrain.update(dt);
    this.ocean.update(dt);
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
