// Open-sea wind waves: a sum of Gerstner waves shared by the ocean shader (GLSL below) and the CPU
// (boats floating on the same surface). Waves travel towards the beach (+Z) with some directional spread.
//
// Shallow water: every wave is attenuated with depth, long waves first, as in dgreenheck/tidewater (MIT), so the
// swell fades into the analytic shore breakers (see shaders/shore.glsl.js) instead of running up the sand.

const G = 9.81;
export const TAU = Math.PI * 2;
export const MAX_WAVES = 8;

// Sorted by amplitude: lower quality tiers simply use the first N.
// L = wavelength (m), A = amplitude (m), deg = heading relative to +Z, s = steepness share (0..1).
const SET = [
  { L: 46, A: 0.24, deg: 8, s: 0.34, phase: 0.0 },
  { L: 29, A: 0.16, deg: -16, s: 0.4, phase: 1.7 },
  { L: 18.5, A: 0.1, deg: 25, s: 0.45, phase: 4.1 },
  { L: 11.8, A: 0.062, deg: -34, s: 0.5, phase: 2.6 },
  { L: 7.9, A: 0.04, deg: 43, s: 0.5, phase: 5.3 },
  { L: 5.3, A: 0.026, deg: -6, s: 0.55, phase: 0.9 },
  { L: 3.7, A: 0.016, deg: 58, s: 0.55, phase: 3.3 },
  { L: 2.6, A: 0.01, deg: -49, s: 0.6, phase: 6.0 },
];

export const WAVES = SET.map((w) => {
  const k = TAU / w.L;
  const rad = (w.deg * Math.PI) / 180;
  return {
    ...w,
    k,
    dirX: Math.sin(rad),
    dirZ: Math.cos(rad),
    omega: Math.sqrt(G * k),
    // Horizontal (choppiness) factor, normalised so the full set can never fold into loops.
    Q: w.s / (k * w.A * MAX_WAVES),
    d0: Math.min(4, Math.max(0.5, w.L * 0.06)), // depth below which the wave starts to die
    floor: Math.min(0.5, Math.max(0, 1.2 - w.L * 0.1)), // short chop keeps a little energy in the shallows
  };
});

const smooth = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Amplitude multiplier of a wave at a given water depth (1 in deep water, 0 on the sand). */
export function waveAttenuation(w, depth) {
  const a = smooth(0, w.d0, depth);
  return w.floor * smooth(0, 0.6, depth) * (1 - a) + a;
}

/** Wave phase offsets for time t, wrapped on the CPU so the GPU never takes sin() of a huge argument. */
export function wavePhases(t, out = new Float32Array(MAX_WAVES)) {
  for (let i = 0; i < MAX_WAVES; i++) {
    const w = WAVES[i];
    out[i] = (((w.phase - w.omega * t) % TAU) + TAU) % TAU;
  }
  return out;
}

/**
 * Height and slope of the wave field at a rest position (horizontal displacement is ignored: it only
 * matters for the look of the crests, not for what floats on them).
 */
export function sampleWaves(x, z, t, n = 4, depth = 10, out = { y: 0, dx: 0, dz: 0 }) {
  let y = 0;
  let dx = 0;
  let dz = 0;
  const count = Math.min(n, MAX_WAVES);
  for (let i = 0; i < count; i++) {
    const w = WAVES[i];
    const A = w.A * waveAttenuation(w, depth);
    if (A <= 0) continue;
    const th = w.k * (w.dirX * x + w.dirZ * z) - w.omega * t + w.phase;
    y += A * Math.sin(th);
    const c = A * w.k * Math.cos(th);
    dx += c * w.dirX;
    dz += c * w.dirZ;
  }
  out.y = y;
  out.dx = dx;
  out.dz = dz;
  return out;
}

// GLSL mirror. uWaveA[i] = (dirX, dirZ, k, A), uWaveB[i] = (Q, phase(t), d0, floor).
export const WAVES_GLSL = /* glsl */ `
  uniform vec4 uWaveA[ ${MAX_WAVES} ];
  uniform vec4 uWaveB[ ${MAX_WAVES} ];

  float bhWaveAtt( vec4 b, float depth ) {
    float a = smoothstep( 0.0, b.z, depth );
    return mix( b.w * smoothstep( 0.0, 0.6, depth ), 1.0, a );
  }

  // Displacement of the rest point p. 'spacing' = local grid spacing: waves too short for the mesh fade out
  // (band limiting) and are left to the per-pixel normals instead.
  vec3 bhGerstnerDisp( vec2 p, float depth, float spacing ) {
    vec3 d = vec3( 0.0 );
    for ( int i = 0; i < WAVE_COUNT; i ++ ) {
      vec4 a = uWaveA[ i ];
      vec4 b = uWaveB[ i ];
      float L = 6.2831853 / a.z;
      float amp = a.w * bhWaveAtt( b, depth ) * ( 1.0 - smoothstep( 0.22, 0.45, spacing / L ) );
      float th = a.z * dot( a.xy, p ) + b.y;
      float s = sin( th );
      float c = cos( th );
      d.xz += b.x * amp * a.xy * c;
      d.y += amp * s;
    }
    return d;
  }

  // Returns (nx, nz, ny, J): the unnormalised Gerstner normal (-nx, ny, -nz) (GPU Gems 1, ch. 1) and the
  // Jacobian of the horizontal displacement (< 1 where crests are compressed: whitecaps).
  // 'footprint' = metres per pixel: waves much shorter than a pixel fade out (they become roughness).
  vec4 bhGerstnerGrad( vec2 p, float depth, float footprint ) {
    float gx = 0.0, gz = 0.0, ny = 1.0, jxx = 1.0, jzz = 1.0, jxz = 0.0;
    for ( int i = 0; i < WAVE_COUNT; i ++ ) {
      vec4 a = uWaveA[ i ];
      vec4 b = uWaveB[ i ];
      float L = 6.2831853 / a.z;
      float amp = a.w * bhWaveAtt( b, depth ) * ( 1.0 - smoothstep( 0.15, 0.5, footprint / L ) );
      float th = a.z * dot( a.xy, p ) + b.y;
      float s = sin( th );
      float c = cos( th );
      float wa = a.z * amp;
      gx += a.x * wa * c;
      gz += a.y * wa * c;
      float q = b.x * wa * s;
      ny -= q;
      jxx -= q * a.x * a.x;
      jzz -= q * a.y * a.y;
      jxz -= q * a.x * a.y;
    }
    return vec4( gx, gz, ny, jxx * jzz - jxz * jxz );
  }
`;
