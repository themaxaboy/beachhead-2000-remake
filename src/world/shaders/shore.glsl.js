// Analytic surf: shoaling and breaking waves on the water, swash run-up and drying wet sand on the beach.
// A simplified port of the ShoreWaves model in dgreenheck/tidewater (MIT): wave phase from the baked travel
// time, sets of ~7 waves with random heights that peel along the beach, Green's-law shoaling, a peaked and
// forward-skewed crest that breaks at depth ≈ 1.28·H, and an up-rush / back-wash run-up curve on the sand.
// The ocean and the terrain both include this file so the water and the wet sand always agree.

// All wave-index dependent terms repeat every SHORE_CYCLE waves; the CPU wraps uShoreTime at the same length
// so the pattern stays continuous forever without float precision loss.
export const SHORE_CYCLE = 56;

export const SHORE_GLSL = /* glsl */ `
  uniform sampler2D uShoreTex;  // R height, G travel time to shore, B wave heading x
  uniform vec4 uShoreRect;      // x0, z0, 1/width, 1/height
  uniform vec4 uShore;          // period (s), amplitude (H/2, m), run-up scale, enabled
  uniform float uShoreTime;     // seconds, wrapped at SHORE_CYCLE periods

  #define BH_TAU 6.2831853
  #define BH_BEACH_SLOPE 0.032
  #define BH_SWASH_UP 0.4
  #define BH_SWASH_DOWN 0.55

  vec4 bhShoreSample( vec2 xz ) {
    return texture2D( uShoreTex, ( xz - uShoreRect.xy ) * uShoreRect.zw );
  }

  float bhShoreHash( float n ) {
    return fract( sin( mod( n, ${SHORE_CYCLE}.0 ) * 91.3458 + 3.7 ) * 47453.5453 );
  }

  // Height (H/2) of wave m where it meets the beach at 'along' (world x).
  float bhShoreAmp( float m, float along ) {
    float mm = mod( m, ${SHORE_CYCLE}.0 );
    float set = abs( sin( mm * 0.44880 ) ) * 0.6 + 0.55;  // sets of 7 waves
    float rnd = 0.7 + 0.6 * bhShoreHash( mm );
    float peel = 1.0 + 0.22 * sin( along * 0.019 + mm * 1.7 ) + 0.12 * sin( along * 0.053 - mm * 0.9 );
    return uShore.y * set * rnd * peel;
  }

  float bhShoreWobble( float along ) {
    return 0.11 * sin( along * 0.0113 ) + 0.06 * sin( along * 0.037 + 1.3 );
  }

  // Wave profile at phase u in [-0.5, 0.5] (u < 0 = shoreward of the crest). b: < 0 shoaling, 0..1 plunging,
  // > 1 broken bore.
  float bhShoreProfile( float u, float A, float dep, out float b ) {
    float db = pow( A * 3.556 / 0.78, 0.8 );
    b = ( db - dep ) / ( db * 0.35 );
    float shoal = pow( 4.0 / clamp( dep, 0.35, 4.0 ), 0.25 );
    float Ash = A * shoal;
    Ash = mix( Ash, min( Ash, 0.42 * max( dep, 0.0 ) + 0.03 ), smoothstep( 0.0, 1.0, b ) );
    float p = mix( 1.0, 3.0, smoothstep( -2.5, 0.0, b ) );
    float skew = smoothstep( -3.0, 0.5, b ) * 0.55;
    float phi = u - skew * ( 1.0 - cos( u * BH_TAU ) ) / BH_TAU;
    float c = max( ( cos( phi * BH_TAU ) + 1.0 ) * 0.5, 0.0 );
    float meanP = mix( 0.5, 0.3125, ( p - 1.0 ) * 0.5 );
    return Ash * 2.0 * ( pow( c, p ) - meanP );
  }

  // Incoming breaker train at a point with still-water depth 'dep' and travel time 'Ts'.
  // Returns height; 'slope' = dy/ds towards the shore, 'foam' = whitewater, 'crest' = 0..1 near the crest.
  float bhShoreWave( float Ts, float dep, float along, out float slope, out float foam, out float crest ) {
    float env = smoothstep( 6.0, 3.0, dep ) * smoothstep( -0.2, 0.08, dep ) * uShore.w;
    slope = 0.0;
    foam = 0.0;
    crest = 0.0;
    if ( env <= 0.0 ) return 0.0;
    float c = sqrt( 9.81 * clamp( dep, 0.25, 25.0 ) );
    float s = ( uShoreTime + Ts ) / uShore.x + bhShoreWobble( along );
    float m = floor( s + 0.5 );
    float u = s - m;
    // Blend towards the neighbouring wave in the trough so wave heights never step.
    float A = mix( bhShoreAmp( m, along ), bhShoreAmp( m + sign( u ), along ), smoothstep( 0.3, 0.5, abs( u ) ) * 0.5 );
    float b, b2;
    float y = bhShoreProfile( u, A, dep, b );
    float y2 = bhShoreProfile( u + 0.004, A, dep, b2 );
    slope = - ( y2 - y ) / 0.004 / ( c * uShore.x ) * env;
    float broken = smoothstep( -0.2, 0.7, b );
    float face = smoothstep( -0.1, 0.0, u ) * ( 1.0 - smoothstep( 0.02, 0.3, u ) );
    float trail = smoothstep( 0.0, 0.12, u ) * ( 1.0 - smoothstep( 0.12, 0.5, u ) ) * smoothstep( 0.8, 2.0, b );
    foam = broken * max( face, trail * 0.7 ) * smoothstep( -0.2, 0.08, dep ) * uShore.w;
    crest = smoothstep( 0.18, 0.0, abs( u ) ) * env;
    return y * env;
  }

  // Reach of the run-up (m inland of the still waterline) at phase tau of a wave cycle.
  float bhSwashReach( float tau, float RhMax ) {
    float su = clamp( tau / BH_SWASH_UP, 0.0, 1.0 );
    float sb = clamp( ( tau - BH_SWASH_UP ) / BH_SWASH_DOWN, 0.0, 1.0 );
    float f = tau < BH_SWASH_UP ? 1.0 - pow( 1.0 - su, 1.5 ) : 1.0 - pow( sb, 1.6 );
    return f * RhMax - 0.3;
  }

  float bhSwashMax( float m, float along ) {
    return bhShoreAmp( m, along ) * 2.1 * uShore.z / BH_BEACH_SLOPE;
  }

  // Swash on the sand at height h. Returns (front, uprush, wetness, sheet):
  //   front > 0 under the water sheet (m behind its leading edge), uprush 1 while the water climbs,
  //   wetness 1 = soaked, drying over ~20 s after the back-wash uncovered the sand.
  vec4 bhSwash( float along, float h ) {
    float inland = max( h, 0.0 ) / BH_BEACH_SLOPE;
    float ss = uShoreTime / uShore.x + bhShoreWobble( along );
    float ms = floor( ss );
    float tau = ss - ms;
    float mm = mod( ms, ${SHORE_CYCLE}.0 );
    float lobes = sin( along * 0.21 + mm * 2.3 ) * 0.5 + sin( along * 0.61 + mm * 5.1 ) * 0.3 + sin( along * 1.73 + mm * 1.7 ) * 0.2;
    float Rh = bhSwashReach( tau, bhSwashMax( ms, along ) );
    float Rt = max( Rh + lobes * ( max( Rh, 0.0 ) * 0.07 + 0.35 ), 0.35 ) * uShore.w;
    float front = Rt - inland;
    // Time (in periods) since the latest back-wash uncovered this point.
    float since = 1e3;
    for ( int k = 0; k < 3; k ++ ) {
      float fk = ( inland + 0.3 ) / max( bhSwashMax( ms - float( k ), along ), 1e-3 );
      if ( fk < 1.0 ) {
        float tr = BH_SWASH_UP + pow( 1.0 - fk, 0.625 ) * BH_SWASH_DOWN;
        float ta = ( 1.0 - pow( 1.0 - fk, 0.6667 ) ) * BH_SWASH_UP;
        float tk = tau + float( k );
        if ( tk >= ta ) since = min( since, max( tk - tr, 0.0 ) );
      }
    }
    if ( front > 0.0 ) since = 0.0;
    float wet = exp( - since * uShore.x / 16.0 ) * uShore.w;
    float sheet = smoothstep( 0.0, 1.5, front );
    return vec4( front, tau < BH_SWASH_UP ? 1.0 : 0.0, wet, sheet );
  }
`;
