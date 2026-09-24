// Geometry helpers shared by all procedural model builders.
// - primitives that return fresh BufferGeometry (boxes, chamfered boxes, lathes, lofts, airfoil wings ...)
// - Kit: collects geometry per material key and merges it into one mesh per material
// - template cache + cheap instancing (clones share geometry and materials)
import * as THREE from 'three';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';

export const PI = Math.PI;
export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Transform geometry in place: scale, then rotate (Euler XYZ), then translate. Returns geo. */
export function xf(geo, p = null, r = null, s = null) {
  _e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0);
  _q.setFromEuler(_e);
  if (s == null) _s.set(1, 1, 1);
  else if (typeof s === 'number') _s.set(s, s, s);
  else _s.set(s[0], s[1], s[2]);
  _p.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0);
  _m.compose(_p, _q, _s);
  geo.applyMatrix4(_m);
  if (_s.x * _s.y * _s.z < 0) flipWinding(geo);
  return geo;
}

/** Reverse triangle winding (after a mirror). Normals are left as transformed. */
export function flipWinding(geo) {
  if (geo.index) {
    const a = geo.index.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    geo.index.needsUpdate = true;
  } else {
    for (const name of Object.keys(geo.attributes)) {
      const at = geo.attributes[name], n = at.itemSize, arr = at.array;
      for (let i = 0; i < at.count; i += 3) {
        for (let k = 0; k < n; k++) {
          const i1 = (i + 1) * n + k, i2 = (i + 2) * n + k;
          const t = arr[i1]; arr[i1] = arr[i2]; arr[i2] = t;
        }
      }
      at.needsUpdate = true;
    }
  }
  return geo;
}

/** Mirrored copy across the YZ plane (x -> -x) with correct winding. */
export function mirrorX(geo) {
  return xf(geo.clone(), null, null, [-1, 1, 1]);
}

/** Flip normals + winding (make a surface face inward). */
export function invert(geo) {
  flipWinding(geo);
  const n = geo.attributes.normal;
  if (n) { for (let i = 0; i < n.array.length; i++) n.array[i] = -n.array[i]; n.needsUpdate = true; }
  return geo;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
export const box = (w, h, d, p, r) => xf(new THREE.BoxGeometry(w, h, d), p, r);

function axisRot(axis) {
  if (axis === 'x') return [0, 0, -PI / 2]; // +Y -> +X
  if (axis === 'z') return [PI / 2, 0, 0]; // +Y -> +Z
  if (axis === '-z') return [-PI / 2, 0, 0]; // +Y -> -Z
  if (axis === '-x') return [0, 0, PI / 2];
  return null;
}

/** Cylinder along an axis ('y' default, 'x', 'z', '-z'); rTop is at the + end. */
export function cyl(rTop, rBot, h, seg = 12, axis = 'y', open = false, p = null) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
  const r = axisRot(axis);
  if (r) xf(g, null, r);
  if (p) xf(g, p);
  return g;
}

/** Flat disc (e.g. a lens) facing +Z by default; axis 'z' | '-z' | 'x' | '-x' | 'y'. */
export function disc(r, seg = 10, axis = 'z', p = null) {
  const g = new THREE.CircleGeometry(r, seg);
  if (axis === '-z') xf(g, null, [0, PI, 0]);
  else if (axis === 'x') xf(g, null, [0, PI / 2, 0]);
  else if (axis === '-x') xf(g, null, [0, -PI / 2, 0]);
  else if (axis === 'y') xf(g, null, [-PI / 2, 0, 0]);
  else if (axis === '-y') xf(g, null, [PI / 2, 0, 0]);
  return p ? xf(g, p) : g;
}

/** Lathe of [[radius, axial], ...] (axial increasing = towards + end of axis). */
export function lathe(pts, seg = 12, axis = 'y', p = null, phiStart = 0, phiLength = PI * 2) {
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y)), seg, phiStart, phiLength);
  const r = axisRot(axis);
  if (r) xf(g, null, r);
  if (p) xf(g, p);
  return g;
}

export const sphere = (r, ws = 12, hs = 8, p = null, s = null) => xf(new THREE.SphereGeometry(r, ws, hs), p, null, s);

/** Convex hull of points (flat shaded). */
export function hull(points) {
  return new ConvexGeometry(points.map((p) => (Array.isArray(p) ? v3(p[0], p[1], p[2]) : p)));
}

/** Convex hull with smooth normals where the dihedral angle is below creaseDeg. */
export function smoothHull(points, creaseDeg = 35) {
  return toCreasedNormals(hull(points), (creaseDeg * PI) / 180);
}

/** Box with chamfered edges (c = chamfer size). Cheap (44 tris). */
export function cbox(w, h, d, c = 0.02, p = null, r = null) {
  const x = w / 2, y = h / 2, z = d / 2;
  c = Math.min(c, x * 0.95, y * 0.95, z * 0.95);
  const pts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    pts.push(v3(sx * x, sy * (y - c), sz * (z - c)), v3(sx * (x - c), sy * y, sz * (z - c)), v3(sx * (x - c), sy * (y - c), sz * z));
  }
  return xf(hull(pts), p, r);
}

/** Points of a (possibly asymmetric) super-ellipse ring in the XY plane at z. */
export function ring(n, w, hTop, hBot = hTop, e = 2, cx = 0, cy = 0, z = 0, xScaleBottom = 1) {
  const pts = [];
  const k = 2 / e;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    let x = (w / 2) * Math.sign(c) * Math.pow(Math.abs(c), k);
    const y = (s >= 0 ? hTop : hBot) * Math.sign(s) * Math.pow(Math.abs(s), k);
    if (s < 0) x *= xScaleBottom;
    pts.push(v3(cx + x, cy + y, z));
  }
  return pts;
}

/** Super-ellipse fuselage station helper: {z, w, ht, hb, cy, e, xb}. */
export function stationRing(n, st) {
  return ring(n, st.w, st.ht, st.hb ?? st.ht, st.e ?? 2, st.cx ?? 0, st.cy ?? 0, st.z, st.xb ?? 1);
}

/**
 * Loft through rings of points (all rings same length). Smooth normals along the surface,
 * flat caps. Orientation is fixed automatically so faces point outward.
 */
export function loft(sections, { closed = true, capStart = true, capEnd = true, flat = false } = {}) {
  const M = sections[0].length, N = sections.length;
  const P = [];
  for (const s of sections) for (const p of s) P.push(p);
  const tris = [];
  const segs = closed ? M : M - 1;
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * M + j, b = i * M + ((j + 1) % M), c = (i + 1) * M + ((j + 1) % M), d = (i + 1) * M + j;
      tris.push([a, b, d], [b, c, d]);
    }
  }
  const capTris = [];
  const capPts = [];
  const addCap = (ringIdx, reverse) => {
    const ringPts = sections[ringIdx];
    const c = new THREE.Vector3();
    ringPts.forEach((p) => c.add(p));
    c.multiplyScalar(1 / ringPts.length);
    for (let j = 0; j < M; j++) {
      const p0 = ringPts[j], p1 = ringPts[(j + 1) % M];
      capTris.push(reverse ? [c, p1, p0] : [c, p0, p1]);
    }
  };
  if (closed && capStart) addCap(0, true);
  if (closed && capEnd) addCap(N - 1, false);
  // orientation via signed volume about the centroid
  const cen = new THREE.Vector3();
  P.forEach((p) => cen.add(p));
  cen.multiplyScalar(1 / P.length);
  let vol = 0;
  const t0 = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
  const tv = (a, b, c) => { t0.subVectors(a, cen); t1.subVectors(b, cen); t2.subVectors(c, cen); return t0.dot(t1.cross(t2)); };
  for (const [a, b, c] of tris) vol += tv(P[a], P[b], P[c]);
  for (const [a, b, c] of capTris) vol += tv(a, b, c);
  const flip = vol < 0;

  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(P.length * 3);
  P.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z; });
  const uv = new Float32Array(P.length * 2);
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) { uv[(i * M + j) * 2] = j / M; uv[(i * M + j) * 2 + 1] = i / Math.max(1, N - 1); }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const idx = [];
  for (const [a, b, c] of tris) flip ? idx.push(a, c, b) : idx.push(a, b, c);
  g.setIndex(idx);
  g.computeVertexNormals();
  let out = g.toNonIndexed();
  if (flat) out.computeVertexNormals();
  if (capTris.length) {
    const cp = new Float32Array(capTris.length * 9);
    capTris.forEach(([a, b, c], i) => {
      const q = flip ? [a, c, b] : [a, b, c];
      q.forEach((v, k) => { cp[i * 9 + k * 3] = v.x; cp[i * 9 + k * 3 + 1] = v.y; cp[i * 9 + k * 3 + 2] = v.z; });
    });
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(cp, 3));
    cg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(capTris.length * 6), 2));
    cg.computeVertexNormals();
    out = mergeGeometries([out, cg]);
  }
  return out;
}

/** Symmetric airfoil outline (closed loop) as [s (0=LE..1=TE), y] with n points per surface. */
export function airfoil(thick = 0.12, n = 6, camber = 0) {
  const yt = (x) => 5 * thick * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const xs = [];
  for (let i = 0; i <= n; i++) xs.push(0.5 * (1 - Math.cos((i / n) * PI))); // cosine spacing 0..1
  const pts = [];
  // upper: TE -> LE
  for (let i = n; i >= 0; i--) pts.push([xs[i], yt(xs[i]) + camber * 4 * xs[i] * (1 - xs[i])]);
  // lower: LE(next) -> TE(prev) (skip duplicate LE and TE)
  for (let i = 1; i < n; i++) pts.push([xs[i], -yt(xs[i]) + camber * 4 * xs[i] * (1 - xs[i])]);
  return pts;
}

/**
 * Airfoil section ring. le = leading-edge point, chord along -Z (forward is +Z).
 * spanAxis 'x' -> thickness along Y (wings); 'y' -> thickness along X (fins).
 */
export function foilRing(le, chord, thick = 0.1, spanAxis = 'x', n = 6, thickAbs = null) {
  const af = airfoil(thickAbs != null ? thickAbs / chord : thick, n);
  return af.map(([s, t]) => spanAxis === 'x'
    ? v3(le[0], le[1] + t * chord, le[2] - s * chord)
    : v3(le[0] + t * chord, le[1], le[2] - s * chord));
}

/** Wing/fin from a list of sections [{le:[x,y,z], chord, t}] */
export function wingLoft(sections, spanAxis = 'x', n = 6, opts = {}) {
  return loft(sections.map((s) => foilRing(s.le, s.chord, s.t ?? 0.1, spanAxis, n)), { capStart: true, capEnd: true, ...opts });
}

/** Extrude a 2D shape (THREE.Shape or [[x,y]...]) along +Z from -depth/2..depth/2 with optional chamfer bevel. */
export function extrude(shape, depth, bevel = 0, curveSegments = 6) {
  const s = Array.isArray(shape) ? new THREE.Shape(shape.map(([x, y]) => new THREE.Vector2(x, y))) : shape;
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(1e-4, depth - 2 * bevel), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
    bevelOffset: -bevel, bevelSegments: 1, curveSegments,
  });
  g.translate(0, 0, -(depth - 2 * bevel) / 2);
  return g;
}

/** Side profile [[z, y], ...] (in the ZY plane) extruded along X, centered: width w. */
export function sideProfile(pts, w, bevel = 0, p = null) {
  const g = extrude(pts, w, bevel);
  // shape x -> world z, shape y -> world y, extrusion z -> world x
  xf(g, null, [0, -PI / 2, 0]);
  return p ? xf(g, p) : g;
}

/** Plan profile [[x, z], ...] extruded upward from y0 to y0+h. */
export function planProfile(pts, h, bevel = 0, y0 = 0) {
  const g = extrude(pts.map(([x, z]) => [x, -z]), h, bevel);
  // shape (x, -z) ; rotate -90 about X: shape y -> -z... result: (x, z) plane, extrusion -> +y
  xf(g, null, [-PI / 2, 0, 0]);
  return xf(g, [0, y0 + h / 2, 0]);
}

/** Front profile [[x, y], ...] extruded along Z, centered at z (depth d). */
export function frontProfile(pts, d, bevel = 0, z = 0) {
  return xf(extrude(pts, d, bevel), [0, 0, z]);
}

/** Rounded-rectangle shape points. */
export function roundRectPts(w, h, r, seg = 3, cx = 0, cy = 0) {
  const pts = [];
  const corners = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, PI / 2], [-w / 2 + r, -h / 2 + r, PI], [w / 2 - r, -h / 2 + r, PI * 1.5]];
  for (const [x, y, a0] of corners) for (let i = 0; i <= seg; i++) {
    const a = a0 + (i / seg) * (PI / 2);
    pts.push([cx + x + Math.cos(a) * r, cy + y + Math.sin(a) * r]);
  }
  return pts;
}

/** Thin tube between two points (for struts, cables, lines). */
export function strut(a, b, r = 0.02, seg = 6) {
  const A = Array.isArray(a) ? v3(...a) : a, B = Array.isArray(b) ? v3(...b) : b;
  const len = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
  const dir = new THREE.Vector3().subVectors(B, A).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), dir);
  const m = new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), q, v3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/** Box oriented from a to b (for beams). w along the local X, h along the local "up". */
export function beam(a, b, w, h, up = v3(0, 1, 0)) {
  const A = Array.isArray(a) ? v3(...a) : a, B = Array.isArray(b) ? v3(...b) : b;
  const len = A.distanceTo(B);
  const g = new THREE.BoxGeometry(w, h, len);
  const zAxis = new THREE.Vector3().subVectors(B, A).normalize();
  let xAxis = new THREE.Vector3().crossVectors(up, zAxis);
  if (xAxis.lengthSq() < 1e-6) xAxis = new THREE.Vector3().crossVectors(v3(1, 0, 0), zAxis);
  xAxis.normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
  const m = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).setPosition(A.clone().add(B).multiplyScalar(0.5));
  g.applyMatrix4(m);
  return g;
}

/** A quad textured with a decal from the atlas: faces +Z, size w x h. */
export function decalQuad(uvRect, w, h, p = null, r = null) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  const [u0, v0, u1, v1] = uvRect;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  return xf(g, p, r);
}

/** 2D convex hull (Andrew monotone chain) of [[x,y]...], returns CCW list. */
export function hull2D(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/** Resample a closed 2D polyline to n points evenly by arc length. Returns {pts, length}. */
export function resampleClosed(poly, n) {
  const L = [0];
  for (let i = 1; i <= poly.length; i++) {
    const a = poly[i - 1], b = poly[i % poly.length];
    L.push(L[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = L[L.length - 1];
  const out = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const d = (k / n) * total;
    while (L[seg + 1] < d) seg++;
    const a = poly[seg], b = poly[(seg + 1) % poly.length];
    const t = (d - L[seg]) / Math.max(1e-9, L[seg + 1] - L[seg]);
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return { pts: out, length: total };
}

/**
 * Continuous track band around wheels given as circles [{z, y, r}] (r = wheel radius).
 * Band centred at x, width w, thickness t. UV: u across band, v along band in link pitches.
 */
export function trackBand(wheels, x, w, t = 0.08, n = 64, pitch = 0.16) {
  const pts = [];
  for (const wh of wheels) {
    const R = wh.r + t / 2;
    for (let i = 0; i < 24; i++) { const a = (i / 24) * PI * 2; pts.push([wh.z + Math.cos(a) * R, wh.y + Math.sin(a) * R]); }
  }
  const hullPts = hull2D(pts); // CCW in (z, y)
  const { pts: S, length } = resampleClosed(hullPts, n);
  const pos = [], nor = [], uv = [];
  const x0 = x - w / 2, x1 = x + w / 2;
  const P = S.map((p, i) => {
    const a = S[(i - 1 + n) % n], b = S[(i + 1) % n];
    let tz = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tz, ty); tz /= l; ty /= l;
    // CCW polygon in (z, y): outward normal = (ty, -tz)
    return { z: p[0], y: p[1], nz: ty, ny: -tz, v: (i / n) * (length / pitch) };
  });
  const push = (px, py, pz, nx, ny, nz, u, v) => { pos.push(px, py, pz); nor.push(nx, ny, nz); uv.push(u, v); };
  for (let i = 0; i < n; i++) {
    const A = P[i], B = P[(i + 1) % n];
    const vB = i === n - 1 ? length / pitch : B.v;
    const o = (Q) => [Q.z + Q.nz * t / 2, Q.y + Q.ny * t / 2];
    const q = (Q) => [Q.z - Q.nz * t / 2, Q.y - Q.ny * t / 2];
    const [aoz, aoy] = o(A), [boz, boy] = o(B), [aiz, aiy] = q(A), [biz, biy] = q(B);
    // outer surface
    push(x0, aoy, aoz, 0, A.ny, A.nz, 0, A.v); push(x1, aoy, aoz, 0, A.ny, A.nz, 1, A.v); push(x1, boy, boz, 0, B.ny, B.nz, 1, vB);
    push(x0, aoy, aoz, 0, A.ny, A.nz, 0, A.v); push(x1, boy, boz, 0, B.ny, B.nz, 1, vB); push(x0, boy, boz, 0, B.ny, B.nz, 0, vB);
    // inner surface
    push(x0, aiy, aiz, 0, -A.ny, -A.nz, 0, A.v); push(x1, biy, biz, 0, -B.ny, -B.nz, 1, vB); push(x1, aiy, aiz, 0, -A.ny, -A.nz, 1, A.v);
    push(x0, aiy, aiz, 0, -A.ny, -A.nz, 0, A.v); push(x0, biy, biz, 0, -B.ny, -B.nz, 0, vB); push(x1, biy, biz, 0, -B.ny, -B.nz, 1, vB);
    // side x1 (normal -x... choose +x for x1 side)
    push(x1, aoy, aoz, 1, 0, 0, 0.9, A.v); push(x1, aiy, aiz, 1, 0, 0, 1, A.v); push(x1, biy, biz, 1, 0, 0, 1, vB);
    push(x1, aoy, aoz, 1, 0, 0, 0.9, A.v); push(x1, biy, biz, 1, 0, 0, 1, vB); push(x1, boy, boz, 1, 0, 0, 0.9, vB);
    // side x0
    push(x0, aoy, aoz, -1, 0, 0, 0.1, A.v); push(x0, biy, biz, -1, 0, 0, 0, vB); push(x0, aiy, aiz, -1, 0, 0, 0, A.v);
    push(x0, aoy, aoz, -1, 0, 0, 0.1, A.v); push(x0, boy, boz, -1, 0, 0, 0.1, vB); push(x0, biy, biz, -1, 0, 0, 0, vB);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  fixWindingToNormals(g);
  return g;
}

/** For non-indexed geometry: flip any triangle whose winding disagrees with its vertex normals. */
export function fixWindingToNormals(g) {
  const pos = g.attributes.position, nor = g.attributes.normal;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), fn = new THREE.Vector3();
  const swap = (at, i1, i2) => {
    const s = at.itemSize, arr = at.array;
    for (let k = 0; k < s; k++) { const t = arr[i1 * s + k]; arr[i1 * s + k] = arr[i2 * s + k]; arr[i2 * s + k] = t; }
  };
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    fn.subVectors(b, a).cross(c.sub(a));
    n.fromBufferAttribute(nor, i).add(c.fromBufferAttribute(nor, i + 1)).add(c.fromBufferAttribute(nor, i + 2));
    if (fn.dot(n) < 0) for (const k of Object.keys(g.attributes)) swap(g.attributes[k], i + 1, i + 2);
  }
  return g;
}

// ---------------------------------------------------------------------------
// UV helpers
// ---------------------------------------------------------------------------
/** Per-triangle box (tri-planar) projection UVs in world units * scale. Geometry must be non-indexed. */
export function boxUV(geo, scale = 0.5) {
  const pos = geo.attributes.position, n = pos.count;
  const uv = new Float32Array(n * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    fn.subVectors(b, a).cross(c.clone().sub(a));
    const ax = Math.abs(fn.x), ay = Math.abs(fn.y), az = Math.abs(fn.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      let u, v;
      if (ax >= ay && ax >= az) { u = p.z; v = p.y; } else if (ay >= az) { u = p.x; v = p.z; } else { u = p.x; v = p.y; }
      uv[(i + k) * 2] = u * scale; uv[(i + k) * 2 + 1] = v * scale;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Per-triangle UV from a function f(centroid, faceNormal, vertexPos) -> [u, v]. Non-indexed geometry. */
export function funcUV(geo, f) {
  const pos = geo.attributes.position, n = pos.count;
  const uv = new Float32Array(n * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3(), cen = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    cen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    fn.subVectors(b, a).cross(c.clone().sub(a)).normalize();
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      const [u, v] = f(cen, fn, p);
      uv[(i + k) * 2] = u; uv[(i + k) * 2 + 1] = v;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Add a constant vertex colour attribute. */
export function paint(geo, color) {
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

// ---------------------------------------------------------------------------
// Kit: per-material geometry buckets -> merged meshes
// ---------------------------------------------------------------------------
const NO_CAST = new Set(['glass', 'rotorBlur', 'engineGlow', 'decals', 'lens', 'canopyCloth', 'cord', 'interior']);
// materials whose geometry carries its own (non world-projected) UVs
const KEEP_UV = new Set(['decals', 'track', 'crateAmmo', 'crateShield', 'canopyCloth', 'rotorBlur', 'jetCamo']);

/** Normalise a geometry for merging: non-indexed, exactly position/normal/uv (+color if keepColor). */
export function normalizeGeo(geo, keepColor = false) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && !(keepColor && name === 'color')) g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

export class Kit {
  constructor({ uvScale = 0.5 } = {}) {
    this.buckets = new Map();
    this.uvScale = uvScale;
  }

  /**
   * Add geometry to the bucket of material `key`.
   * opts: { p, r, s } transform; uv: 'box' (default) | 'keep' | function(cen, n, p) -> [u,v]; uvScale
   */
  add(key, geo, opts = {}) {
    if (!geo) return this;
    if (opts.p || opts.r || opts.s) xf(geo, opts.p, opts.r, opts.s);
    const g = normalizeGeo(geo, !!opts.color);
    const uvMode = opts.uv ?? (KEEP_UV.has(key) ? 'keep' : 'box');
    if (typeof uvMode === 'function') funcUV(g, uvMode);
    else if (uvMode !== 'keep') boxUV(g, opts.uvScale ?? this.uvScale);
    if (!this.buckets.has(key)) this.buckets.set(key, []);
    this.buckets.get(key).push(g);
    return this;
  }

  /** Add geometry and its X-mirror. */
  addSym(key, geo, opts = {}) {
    if (opts.p || opts.r || opts.s) xf(geo, opts.p, opts.r, opts.s);
    const o = { ...opts, p: null, r: null, s: null };
    this.add(key, mirrorX(geo), o);
    this.add(key, geo, o);
    return this;
  }

  /** Merge buckets into meshes (one per material). Returns a Group (or adds to `parent`). */
  build(mats, parent = null, { name = '' } = {}) {
    const group = parent || new THREE.Group();
    for (const [key, list] of this.buckets) {
      let merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) { console.warn('[models] merge failed for', key); continue; }
      merged = mergeVertices(merged, 1e-4);
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mat = (mats && mats[key]) || fallbackMaterial(key);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = name ? `${name}:${key}` : key;
      mesh.userData.matKey = key;
      mesh.castShadow = !NO_CAST.has(key);
      mesh.receiveShadow = key !== 'engineGlow' && key !== 'rotorBlur';
      group.add(mesh);
    }
    return group;
  }
}

const _fallbacks = {};
function fallbackMaterial(key) {
  if (!_fallbacks[key]) {
    console.warn('[models] missing material', key);
    _fallbacks[key] = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.7, name: key });
  }
  return _fallbacks[key];
}

/** Named empty socket / pivot group. */
export function node(name, p = null, r = null, parent = null) {
  const o = new THREE.Group();
  o.name = name;
  if (p) o.position.set(p[0], p[1], p[2]);
  if (r) o.rotation.set(r[0], r[1], r[2]);
  if (parent) parent.add(o);
  return o;
}

// ---------------------------------------------------------------------------
// Template cache + instancing
// ---------------------------------------------------------------------------
const _templates = new Map();

/** Build a template once (module-level cache) and return a cheap clone with materials from `mats`. */
export function instance(type, mats, buildFn) {
  let t = _templates.get(type);
  if (!t) {
    t = buildFn(mats);
    t.userData.modelType = type;
    _templates.set(type, t);
  }
  const root = t.clone(true);
  if (mats) {
    root.traverse((o) => {
      if (o.isMesh && o.userData.matKey && mats[o.userData.matKey] && o.material !== mats[o.userData.matKey]) o.material = mats[o.userData.matKey];
    });
  }
  return root;
}

/** Collect named parts from a root: pick(root, 'turret', 'gun') -> { turret, gun }. */
export function pick(root, ...names) {
  const out = { root };
  for (const n of names) {
    const o = root.getObjectByName(n);
    if (!o) console.warn('[models] missing part', n);
    out[n] = o || null;
  }
  return out;
}

const _geoCache = new Map();
/** Cache arbitrary geometry by key. */
export function cachedGeometry(key, fn) {
  if (!_geoCache.has(key)) _geoCache.set(key, fn());
  return _geoCache.get(key);
}

/** Merge a list of geometries (normalising attributes) into one indexed BufferGeometry. */
export function mergeAll(list, { uvScale = 0.5, uv = 'box', keepColor = false } = {}) {
  const gs = list.map((g) => {
    const n = normalizeGeo(g, keepColor);
    if (typeof uv === 'function') funcUV(n, uv);
    else if (uv === 'box') boxUV(n, uvScale);
    return n;
  });
  let m = mergeGeometries(gs, false);
  m = mergeVertices(m, 1e-4);
  m.computeBoundingSphere();
  m.computeBoundingBox();
  return m;
}

/** Stats: triangle count and mesh (draw call) count of a hierarchy. */
export function modelStats(root) {
  let tris = 0, calls = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const g = o.geometry;
    const t = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    tris += t * (o.isInstancedMesh ? o.count : 1);
    calls++;
  });
  return { tris: Math.round(tris), calls };
}

export { THREE, mergeGeometries, mergeVertices, toCreasedNormals };
