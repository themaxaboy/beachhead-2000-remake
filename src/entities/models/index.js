// Procedural 3D models for the Beach Head 2000 remake (Three.js, built entirely in code).
// Conventions: meters, +Y up, forward +Z (viewmodels: forward -Z, camera space), left = +X.
// Every builder returns { root, ...namedParts }. Geometry is built once per type and cached;
// repeated calls return cheap clones sharing geometry + materials (from createMaterials()).
export {
  createMaterials, applyCharred, restoreMaterials, charMaterialFor, makeCanvasTexture, decalUV,
} from './materials.js';
export { buildTank, buildAPC, APC_RAMP_OPEN } from './ground.js';
export { buildLandingCraft, LCT } from './naval.js';
export { buildCobra, buildCH53, CH53_RAMP_OPEN } from './helicopters.js';
export { buildF4, buildB52, buildCargoPlane, C130_RAMP_LEVEL } from './aircraft.js';
export {
  buildParachute, buildSupplyCrate, buildHedgehog, hedgehogGeometry, sandbagGeometry, barbedWireGeometry,
} from './props.js';
export { buildSoldierParts, SOLDIER_PIVOTS } from './soldier.js';
export {
  buildViewTwinMG, buildViewATGun, buildViewMissilePod, buildViewPistol, buildViewHowitzer,
} from './viewmodels.js';
export { modelStats } from './geom.js';
