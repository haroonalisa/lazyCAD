// Mesh builders for sweeps and lofts. Each returns a manifold Manifold built from an explicit
// triangle mesh (rings of vertices stitched together, capped with triangulated profiles).

import { sub, add, scale, dot, norm, cross, len, toWorld, rotateAxis } from './vec.js';

export function meshToManifold(wasm, verts, tris) {
  const { Manifold, Mesh } = wasm;
  // Orientation: make the signed volume positive.
  let vol = 0;
  for (const [a, b, c] of tris) vol += dot(verts[a], cross(verts[b], verts[c]));
  if (vol < 0) for (const t of tris) [t[1], t[2]] = [t[2], t[1]];
  const vp = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => vp.set(v, i * 3));
  const tv = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => tv.set(t, i * 3));
  const mesh = new Mesh({ numProp: 3, vertProperties: vp, triVerts: tv });
  mesh.merge();
  const m = new Manifold(mesh);
  const st = m.status();
  if (st && st !== 'NoError' && st.value !== 0) throw new Error(`Generated mesh is not a valid solid (${st.constructor?.name || st})`);
  return m;
}

// Stitch rings (each ring = array of contours, each contour = array of world points) into a solid.
// capPolys2D: 2D polygons (same contours, same order) used to triangulate the end caps, or
// {start, end} when the two ends have different shapes.
export function stitch(wasm, rings, closed, capPolys2D) {
  const verts = [], tris = [];
  const idx = rings.map((ring) => ring.map((contour) => contour.map((p) => { verts.push(p); return verts.length - 1; })));
  const R = rings.length;
  for (let i = 0; i < (closed ? R : R - 1); i++) {
    const A = idx[i], B = idx[(i + 1) % R];
    for (let c = 0; c < A.length; c++) {
      const a = A[c], b = B[c], n = a.length;
      for (let j = 0; j < n; j++) {
        const j2 = (j + 1) % n;
        tris.push([a[j], a[j2], b[j2]], [a[j], b[j2], b[j]]);
      }
    }
  }
  if (!closed) {
    const startPolys = capPolys2D.start || capPolys2D, endPolys = capPolys2D.end || capPolys2D;
    const flat0 = idx[0].flat(), flat1 = idx[R - 1].flat();
    for (const [a, b, c] of wasm.triangulate(startPolys)) tris.push([flat0[a], flat0[c], flat0[b]]);
    for (const [a, b, c] of wasm.triangulate(endPolys)) tris.push([flat1[a], flat1[b], flat1[c]]);
  }
  // Consistency: side walls follow contour orientation; caps are oriented against them. If the
  // sweep direction is opposite to the profile normal, everything is inverted — fixed by the
  // global volume-sign check in meshToManifold.
  return meshToManifold(wasm, verts, tris);
}

function dedupe(points, closed) {
  const out = [];
  for (const p of points) if (!out.length || len(sub(p, out[out.length - 1])) > 1e-9) out.push(p);
  if (closed && out.length > 1 && len(sub(out[0], out[out.length - 1])) < 1e-9) out.pop();
  return out;
}

/**
 * Sweep a planar profile along a polyline path (mitred joints → rotation-minimising).
 * @param polys2D   profile contours in sketch coordinates (manifold orientation: outer CCW)
 * @param frame     sketch frame of the profile
 * @param path      {points:[[x,y,z]...], closed}
 */
export function sweepAlongPath(wasm, polys2D, frame, path) {
  const P = dedupe(path.points, path.closed);
  if (P.length < 2) throw new Error('Sweep path needs at least two distinct points');
  const n = P.length, closed = !!path.closed;
  const segCount = closed ? n : n - 1;
  const dirs = [];
  for (let i = 0; i < segCount; i++) dirs.push(norm(sub(P[(i + 1) % n], P[i])));
  // Miter plane normal at each path vertex.
  const miter = (i) => {
    if (!closed && i === 0) return dirs[0];
    if (!closed && i === n - 1) return dirs[segCount - 1];
    const din = dirs[(i - 1 + segCount) % segCount], dout = dirs[i % segCount];
    const m = add(din, dout);
    return len(m) < 1e-9 ? dout : norm(m);
  };
  const project = (pts, dir, planeP, planeN) => pts.map((q) => {
    const denom = dot(dir, planeN);
    if (Math.abs(denom) < 1e-9) throw new Error('Sweep path turns back on itself');
    const t = dot(sub(planeP, q), planeN) / denom;
    return add(q, scale(dir, t));
  });
  let ring = polys2D.map((c) => c.map((uv) => toWorld(frame, uv)));
  if (closed) ring = ring.map((c) => project(c, dirs[0], P[0], miter(0)));
  const rings = [ring];
  const last = closed ? n - 1 : n - 1;
  for (let i = 1; i <= last; i++) {
    const d = dirs[i - 1];
    ring = ring.map((c) => project(c, d, P[i], miter(i)));
    rings.push(ring);
  }
  return stitch(wasm, rings, closed, polys2D);
}

/**
 * Sweep a profile along a helix (screw motion: exact for threads and springs).
 * helix: {origin:[x,y,z], axis:[x,y,z], pitch, turns | height, leftHanded}
 */
export function sweepHelix(wasm, polys2D, frame, helix, tol = 0.01) {
  const axis = norm(helix.axis || [0, 0, 1]), o = helix.origin || [0, 0, 0];
  const pitch = helix.pitch;
  const turns = helix.turns ?? helix.height / pitch;
  if (!(pitch > 0) || !(turns > 0)) throw new Error('Helix needs positive pitch and turns/height');
  const base = polys2D.map((c) => c.map((uv) => toWorld(frame, uv)));
  // Radius for segment count: farthest profile point from axis.
  let R = 0;
  for (const c of base) for (const p of c) {
    const d = sub(p, o), along = dot(d, axis);
    R = Math.max(R, len(sub(d, scale(axis, along))));
  }
  const perTurn = Math.max(24, Math.min(360, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - tol / Math.max(R, tol))))));
  const steps = Math.max(2, Math.ceil(turns * perTurn));
  const sgn = helix.leftHanded ? -1 : 1;
  const rings = [];
  for (let i = 0; i <= steps; i++) {
    const ang = sgn * 2 * Math.PI * turns * i / steps;
    const rise = pitch * turns * i / steps;
    rings.push(base.map((c) => c.map((p) => add(add(o, rotateAxis(sub(p, o), axis, ang)), scale(axis, rise)))));
  }
  return stitch(wasm, rings, false, polys2D);
}

// ---- loft --------------------------------------------------------------------------------

// Hermite / Catmull-Rom interpolation between corresponding ring points, giving a smooth loft.
// startTangent / endTangent (weights) make the surface leave / arrive along the section normals.
function smoothRings(rings, normals, { startTangent = 0, endTangent = 0, steps = 12 }) {
  const S = rings.length, N = rings[0][0].length;
  const centroid = (r) => scale(r[0].reduce((a, p) => add(a, p), [0, 0, 0]), 1 / N);
  const C = rings.map(centroid);
  const out = [];
  for (let i = 0; i + 1 < S; i++) {
    const span = len(sub(C[i + 1], C[i]));
    const tan = (k, j) => {
      const Q = (m) => rings[m][0][j];
      if (k === 0) return startTangent ? scale(normals[0], startTangent * span) : sub(Q(1), Q(0));
      if (k === S - 1) return endTangent ? scale(normals[S - 1], endTangent * span) : sub(Q(S - 1), Q(S - 2));
      return scale(sub(Q(k + 1), Q(k - 1)), 0.5);
    };
    for (let st = 0; st < steps; st++) {
      const t = st / steps, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      const ring = [];
      for (let j = 0; j < N; j++) {
        const p0 = rings[i][0][j], p1 = rings[i + 1][0][j], m0 = tan(i, j), m1 = tan(i + 1, j);
        ring.push([0, 1, 2].map((k) => h00 * p0[k] + h10 * m0[k] + h01 * p1[k] + h11 * m1[k]));
      }
      out.push([ring]);
    }
  }
  out.push(rings[S - 1]);
  return out;
}

function perimeterFractions(poly) {
  const L = [0];
  for (let i = 0; i < poly.length; i++) L.push(L[i] + len(sub(poly[(i + 1) % poly.length], poly[i])));
  const total = L[L.length - 1];
  return { fr: L.slice(0, -1).map((l) => l / total), total, cum: L };
}

function sampleAt(poly, cum, total, f) {
  const target = f * total;
  let i = 0;
  while (i < poly.length - 1 && cum[i + 1] < target) i++;
  const a = poly[i], b = poly[(i + 1) % poly.length];
  const seg = cum[i + 1] - cum[i];
  const t = seg > 1e-12 ? (target - cum[i]) / seg : 0;
  return a.map((v, k) => v + (b[k] - v) * t);
}

/**
 * Ruled loft through sections. Each section: {poly2D (single CCW contour), frame}.
 * Corners of every section are preserved by sampling all sections at the union of their
 * vertex arc-length fractions.
 */
export function loftSections(wasm, sections, opts = {}) {
  if (sections.length < 2) throw new Error('Loft needs at least two sections');
  // World polygons, oriented consistently (normals agree with the first section).
  const world = sections.map((s) => s.poly.map((p) => toWorld(s.frame, p)));
  const normals = sections.map((s) => s.frame.n);
  // Loft direction: from first centroid to last
  const centroid = (pts) => scale(pts.reduce((a, p) => add(a, p), [0, 0, 0]), 1 / pts.length);
  const dirAll = sub(centroid(world[world.length - 1]), centroid(world[0]));
  world.forEach((w, i) => {
    if (dot(normals[i], dirAll) < 0) { w.reverse(); sections[i] = { ...sections[i], poly: sections[i].poly.slice().reverse() }; }
  });
  // Align start vertices: rotate each section so its start is closest to the previous start.
  for (let i = 1; i < world.length; i++) {
    const prev = world[i - 1][0], ci = centroid(world[i]), cp = centroid(world[i - 1]);
    const target = add(ci, sub(prev, cp));
    let best = 0, bd = Infinity;
    world[i].forEach((p, k) => { const d = len(sub(p, target)); if (d < bd) { bd = d; best = k; } });
    world[i] = [...world[i].slice(best), ...world[i].slice(0, best)];
    sections[i] = { ...sections[i], poly: [...sections[i].poly.slice(best), ...sections[i].poly.slice(0, best)] };
  }
  const infos = world.map(perimeterFractions);
  const fr = [...new Set(infos.flatMap((inf) => inf.fr.map((f) => Math.round(f * 1e9) / 1e9)))].sort((a, b) => a - b);
  let rings = world.map((w, i) => [fr.map((f) => sampleAt(w, infos[i].cum, infos[i].total, f))]);
  const smooth = opts.smooth ?? (sections.length > 2 || !!opts.startTangent || !!opts.endTangent);
  if (smooth) rings = smoothRings(rings, sections.map((s, i) => (dot(normals[i], dirAll) < 0 ? scale(normals[i], -1) : normals[i])), opts);
  const first2D = fr.map((f) => {
    const inf = perimeterFractions(sections[0].poly);
    return sampleAt(sections[0].poly, inf.cum, inf.total, f);
  });
  const last = sections[sections.length - 1];
  const last2D = fr.map((f) => {
    const inf = perimeterFractions(last.poly);
    return sampleAt(last.poly, inf.cum, inf.total, f);
  });
  // Caps: triangulate first and last separately (different shapes).
  const verts = [], tris = [];
  const idx = rings.map((r) => r[0].map((p) => { verts.push(p); return verts.length - 1; }));
  const N = fr.length;
  for (let i = 0; i < idx.length - 1; i++)
    for (let j = 0; j < N; j++) {
      const a = idx[i], b = idx[i + 1], j2 = (j + 1) % N;
      tris.push([a[j], a[j2], b[j2]], [a[j], b[j2], b[j]]);
    }
  const orient2D = (poly) => { let s = 0; poly.forEach((p, i) => { const q = poly[(i + 1) % poly.length]; s += p[0] * q[1] - q[0] * p[1]; }); return s; };
  const capA = orient2D(first2D) >= 0 ? first2D : first2D.slice().reverse();
  const capB = orient2D(last2D) >= 0 ? last2D : last2D.slice().reverse();
  const mapA = orient2D(first2D) >= 0 ? idx[0] : idx[0].slice().reverse();
  const mapB = orient2D(last2D) >= 0 ? idx[idx.length - 1] : idx[idx.length - 1].slice().reverse();
  // First cap faces backwards, last cap faces forwards (relative to loft direction).
  const tA = wasm.triangulate([capA]), tB = wasm.triangulate([capB]);
  const nA = sections[0].frame.n, nB = last.frame.n;
  const fA = dot(nA, dirAll) >= 0 ? -1 : 1, fB = dot(nB, dirAll) >= 0 ? 1 : -1;
  for (const [a, b, c] of tA) tris.push(fA > 0 ? [mapA[a], mapA[b], mapA[c]] : [mapA[a], mapA[c], mapA[b]]);
  for (const [a, b, c] of tB) tris.push(fB > 0 ? [mapB[a], mapB[b], mapB[c]] : [mapB[a], mapB[c], mapB[b]]);
  // Side orientation must agree with caps; verify via edge consistency, flip sides if needed.
  const edgeDir = new Map();
  for (const t of tris.slice(0, (idx.length - 1) * N * 2)) for (let k = 0; k < 3; k++) edgeDir.set(`${t[k]},${t[(k + 1) % 3]}`, true);
  const capStart = (idx.length - 1) * N * 2;
  let conflicts = 0;
  for (const t of tris.slice(capStart)) for (let k = 0; k < 3; k++) if (edgeDir.has(`${t[k]},${t[(k + 1) % 3]}`)) conflicts++;
  if (conflicts) for (const t of tris.slice(0, capStart)) [t[1], t[2]] = [t[2], t[1]];
  return meshToManifold(wasm, verts, tris);
}
