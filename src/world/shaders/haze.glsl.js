import * as THREE from 'three';

// Aerial perspective: two exponential height-fog layers (a dense marine layer and a thin aerosol layer)
// integrated analytically along the view ray, tinted towards the sun with a forward-scattering phase.
// After the AirHaze model in dgreenheck/tidewater (MIT). Replaces three's FogExp2 maths for every built-in
// material, so aircraft high up stay crisp while the far beach and sea melt into the horizon.

export const HAZE_GLSL = /* glsl */ `
  float bhHazeDepth( float sigma, float H, float hc, float vy, float d ) {
    float k = vy * d / H;
    float fk = abs( k ) < 1e-3 ? d : H * ( 1.0 - exp( - k ) ) / vy;
    return exp( - hc / H ) * sigma * fk;
  }
  // v = camera->fragment vector in world space, hc = camera height, density = FogExp2 density.
  float bhHazeAmount( vec3 v, float hc, float density ) {
    float d = length( v );
    float vy = v.y / max( d, 1e-4 );
    float s = density * 0.55;
    float tau = bhHazeDepth( s, 110.0, hc, vy, d ) + bhHazeDepth( s * 0.22, 1400.0, hc, vy, d );
    return 1.0 - exp( - tau );
  }
  // Henyey-Greenstein forward lobe, scaled so the glow right around the sun roughly doubles the haze colour.
  float bhSunGlow( float cosT ) {
    const float g = 0.72;
    return 0.055 * ( 1.0 - g * g ) / pow( max( 1.0 + g * g - 2.0 * g * cosT, 1e-4 ), 1.5 );
  }
`;

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vHazeView;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vHazeView = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vHazeView;
  #ifdef FOG_EXP2
    uniform float fogDensity;
    ${HAZE_GLSL}
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = bhHazeAmount( vHazeView, cameraPosition.y, fogDensity );
    vec3 bhHazeCol = fogColor;
    #if ( defined( STANDARD ) || defined( PHONG ) || defined( LAMBERT ) || defined( TOON ) ) && NUM_DIR_LIGHTS > 0
      // The scene's only directional light is the sun (or the moon at night).
      vec3 bhSunC = directionalLights[ 0 ].color;
      float bhSunM = max( max( bhSunC.r, bhSunC.g ), max( bhSunC.b, 1e-3 ) );
      vec3 bhDir = normalize( ( viewMatrix * vec4( vHazeView, 0.0 ) ).xyz );
      float bhGlow = bhSunGlow( dot( bhDir, directionalLights[ 0 ].direction ) ) * min( 1.0, bhSunM / 3.0 );
      bhHazeCol *= 1.0 + ( bhSunC / bhSunM ) * bhGlow;
    #endif
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    vec3 bhHazeCol = fogColor;
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, bhHazeCol, fogFactor );
#endif
`;

let installed = false;

/** Swaps three's fog chunks for the height haze. Must run before the first material compiles. */
export function installHaze() {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;
}
