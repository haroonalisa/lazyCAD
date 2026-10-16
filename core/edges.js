// Mesh topology for solid-level operations: faces (coplanar triangle groups), feature edges
// grouped into tangent-continuous chains, edge/face selection, and the cutter geometry for
// fillet, chamfer and shell.

import { add, sub, scale, dot, cross, norm, len } from './vec.js';
import { stitch, meshToManifold } from './sweep.js';

const FEATURE_ANGLE = 30; // degrees between face normals for an edge to count as a feature edge

// ---- topology ------------------------------------------------------------------------------

export function topology(manifold) {
  const mesh = manifold.getMesh();
  const P = mesh.vertProperties, T = mesh.triVerts, np = mesh.numProp;
  const nv0 = P.length / np;
  // Weld vertices that share a position (booleans can leave coincident duplicates), then drop
  // triangles that collapse.
  let ext = 1;
  for (let i = 0; i < P.length; i++) ext = Math.max(ext, Math.abs(P[i]));
  const q = 1e-6 * ext;
  const remap = new Int32Array(nv0), V = [], grid = new Map();
  for (let i = 0; i < nv0; i++) {
    const x = P[i * np], y = P[i * np + 1], z = P[i * np + 2];
    const kx = Math.round(x / q), ky = Math.round(y / q), kz = Math.round(z / q);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dz = -1; dz <= 1 && found < 0; dz++) {
      const j = grid.get(`${kx + dx},${ky + dy},${kz + dz}`);
      if (j !== undefined && Math.abs(V[j][0] - x) <= q && Math.abs(V[j][1] - y) <= q && Math.abs(V[j][2] - z) <= q) found = j;
    }
    if (found < 0) { found = V.length; V.push([x, y, z]); grid.set(`${kx},${ky},${kz}`, found); }
    remap[i] = found;
  }
  const TT = [];
  for (let k = 0; k < T.length; k += 3) {
    const a = remap[T[k]], b = remap[T[k + 1]], c = remap[T[k + 2]];
    if (a !== b && b !== c && c !== a) TT.push(a, b, c);
  }
  const nt = TT.length / 3;
  const tri = (k) => [TT[3 * k], TT[3 * k + 1], TT[3 * k + 2]];
  const N = new Array(nt), area = new Float64Array(nt), degenerate = new Uint8Array(nt);
  for (let k = 0; k < nt; k++) {
    const [a, b, c] = tri(k);
    const n = cross(sub(V[b], V[a]), sub(V[c], V[a]));
    area[k] = len(n) / 2;
    const longest = Math.max(len(sub(V[b], V[a])), len(sub(V[c], V[b])), len(sub(V[a], V[c])));
    // needle / zero-area triangles (left behind by booleans) have meaningless normals
    degenerate[k] = !(area[k] > 1e-14) || 2 * area[k] / longest < 1e-5 ? 1 : 0;
    N[k] = area[k] > 1e-14 ? scale(n, 1 / (2 * area[k])) : [0, 0, 0];
  }
  // directed half-edge "a,b" → triangle
  const half = new Map();
  for (let k = 0; k < nt; k++) {
    const t = tri(k);
    for (let e = 0; e < 3; e++) half.set(`${t[e]},${t[(e + 1) % 3]}`, k);
  }
  // Degenerate triangles inherit the normal of a neighbour across their longest edge, so they are
  // invisible to edge detection (they become part of an adjacent face).
  for (let pass = 0, pending = true; pending && pass < 20; pass++) {
    pending = false;
    for (let k = 0; k < nt; k++) {
      if (degenerate[k] !== 1) continue;
      const t = tri(k);
      let best = -1, bl = -1;
      for (let e = 0; e < 3; e++) {
        const o = half.get(`${t[(e + 1) % 3]},${t[e]}`);
        if (o === undefined || degenerate[o] === 1) continue;
        const l = len(sub(V[t[(e + 1) % 3]], V[t[e]]));
        if (l > bl) { bl = l; best = o; }
      }
      if (best < 0) { pending = true; continue; }
      N[k] = N[best];
      degenerate[k] = 2; // resolved
    }
  }
  // planar faces: connected coplanar triangles
  const face = new Int32Array(nt).fill(-1);
  const faces = [];
  for (let k = 0; k < nt; k++) {
    if (face[k] >= 0) continue;
    const id = faces.length, n = N[k], d = dot(n, V[tri(k)[0]]);
    const members = [k];
    face[k] = id;
    for (let s = 0; s < members.length; s++) {
      const q = members[s], t = tri(q);
      for (let e = 0; e < 3; e++) {
        const o = half.get(`${t[(e + 1) % 3]},${t[e]}`);
        if (o === undefined || face[o] >= 0) continue;
        if (dot(N[o], n) > 1 - 1e-9 && (degenerate[o] || Math.abs(dot(n, V[tri(o)[0]]) - d) < 1e-6)) { face[o] = id; members.push(o); }
      }
    }
    faces.push({ id, tris: members, normal: n, area: members.reduce((s, m) => s + area[m], 0) });
  }
  return { V, N, area, tri, half, face, faces, nt };
}

// Feature edges: undirected mesh edges whose adjacent faces meet at more than `angle` degrees.
// left = triangle containing the directed edge a→b, right = the one containing b→a.
export function featureEdges(topo, angle = FEATURE_ANGLE) {
  const cosMax = Math.cos(angle * Math.PI / 180);
  const out = [];
  for (const [key, k] of topo.half) {
    const [a, b] = key.split(',').map(Number);
    if (a > b) continue;
    const o = topo.half.get(`${b},${a}`);
    if (o === undefined) continue;
    if (topo.face[o] === topo.face[k]) continue;
    if (dot(topo.N[k], topo.N[o]) > cosMax) continue;
    out.push(edgeRecord(topo, a, b, k, o));
  }
  return out;
}

function edgeRecord(topo, a, b, left, right) {
  const t = norm(sub(topo.V[b], topo.V[a]));
  const nL = topo.N[left], nR = topo.N[right];
  const dL = norm(cross(nL, t));
  return { a, b, left, right, convex: dot(dL, nR) < 0 };
}

// Group feature edges into chains that continue through vertices joining exactly two edges with
// a gentle turn (tangent-continuous), e.g. a whole circular edge or a line–arc–line outline.
export function edgeChains(topo, angle = FEATURE_ANGLE) {
  const edges = featureEdges(topo, angle);
  const at = new Map();
  edges.forEach((e, i) => {
    for (const v of [e.a, e.b]) { if (!at.has(v)) at.set(v, []); at.get(v).push(i); }
  });
  const dirFrom = (e, v) => norm(sub(topo.V[v === e.a ? e.b : e.a], topo.V[v]));
  const continues = (v) => {
    const list = at.get(v);
    if (list.length !== 2) return false;
    const d1 = dirFrom(edges[list[0]], v), d2 = dirFrom(edges[list[1]], v);
    return dot(d1, d2) < -Math.cos(50 * Math.PI / 180); // nearly opposite = smooth continuation
  };
  const used = new Uint8Array(edges.length);
  const chains = [];
  const walk = (startEdge, startVert) => {
    // returns oriented list of {edge, from, to}
    const seq = [];
    let e = startEdge, v = startVert;
    for (;;) {
      used[e] = 1;
      const E = edges[e];
      const to = v === E.a ? E.b : E.a;
      seq.push({ e, from: v, to });
      if (!continues(to)) break;
      const next = at.get(to).find((i) => i !== e);
      if (used[next]) break;
      e = next; v = to;
    }
    return seq;
  };
  edges.forEach((E, i) => {
    if (used[i]) return;
    // walk backward to a chain start first
    let v = E.a, e = i;
    const seen = new Set([i]);
    while (continues(v)) {
      const prev = at.get(v).find((x) => x !== e);
      if (seen.has(prev)) break;
      seen.add(prev);
      e = prev;
      const P = edges[e];
      v = v === P.a ? P.b : P.a;
    }
    const seq = walk(e, v);
    const verts = [seq[0].from, ...seq.map((s) => s.to)];
    const closed = verts.length > 2 && verts[0] === verts[verts.length - 1];
    chains.push(makeChain(topo, edges, seq, verts, closed, chains.length));
  });
  return chains;
}

function makeChain(topo, edges, seq, verts, closed, id) {
  // Orient each segment along the chain: left/right faces relative to the walking direction.
  const segs = seq.map(({ e, from, to }) => {
    const E = edges[e];
    return from === E.a ? { a: from, b: to, left: E.left, right: E.right, convex: E.convex }
      : { a: from, b: to, left: E.right, right: E.left, convex: E.convex };
  });
  const pts = verts.map((v) => topo.V[v]);
  let length = 0;
  for (let i = 0; i + 1 < pts.length; i++) length += len(sub(pts[i + 1], pts[i]));
  const convexCount = segs.filter((s) => s.convex).length;
  const d0 = norm(sub(pts[pts.length - 1], pts[0]));
  const straight = !closed && pts.every((p) => len(cross(sub(p, pts[0]), d0)) < 1e-6 * Math.max(1, length));
  const mid = pointAlong(pts, length / 2);
  const min = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))), max = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
  return {
    id, verts, pts, segs, closed, length, mid, bbox: { min, max },
    convex: convexCount * 2 >= segs.length, mixed: convexCount > 0 && convexCount < segs.length,
    kind: straight ? 'line' : closed ? 'loop' : 'curve', dir: straight ? d0 : null,
  };
}

function pointAlong(pts, s) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const L = len(sub(pts[i + 1], pts[i]));
    if (s <= L || i + 2 === pts.length) return add(pts[i], scale(sub(pts[i + 1], pts[i]), L ? Math.min(1, s / L) : 0));
    s -= L;
  }
  return pts[0];
}

export function distToChain(chain, p) {
  let best = Infinity;
  for (let i = 0; i + 1 < chain.pts.length; i++) best = Math.min(best, segDist(p, chain.pts[i], chain.pts[i + 1]));
  return best;
}

function segDist(p, a, b) {
  const ab = sub(b, a), L = dot(ab, ab);
  const t = L ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / L)) : 0;
  return len(sub(p, add(a, scale(ab, t))));
}

// ---- selection ------------------------------------------------------------------------------

/**
 * Edge selection → chains.
 *   'all' | {near:[x,y,z]} | filter {x|y|z: value, box:{min,max}, parallel: [dx,dy,dz], convex, concave, kind, minLength}
 *   arrays are unions. `num` evaluates expressions; `axis` resolves direction specs.
 */
export function selectChains(chains, spec, num, axis) {
  if (spec === undefined || spec === null) throw new Error('No edges selected (edges: "all" | {near:[x,y,z]} | filter)');
  if (Array.isArray(spec)) {
    const out = new Set();
    for (const s of spec) for (const c of selectChains(chains, s, num, axis)) out.add(c);
    return [...out];
  }
  if (spec === 'all') return chains.slice();
  if (spec.near) {
    const p = spec.near.map((v) => num(v));
    let best = null, bd = Infinity;
    for (const c of chains) { const d = distToChain(c, p); if (d < bd) { bd = d; best = c; } }
    if (!best) throw new Error('Body has no edges');
    const tolNear = spec.tolerance !== undefined ? num(spec.tolerance) : Infinity;
    if (bd > tolNear) throw new Error(`No edge within ${tolNear} of [${p}]`);
    return [best];
  }
  const eps = 1e-4;
  return chains.filter((c) => {
    for (const k of ['x', 'y', 'z']) {
      if (spec[k] === undefined) continue;
      const v = num(spec[k]), i = 'xyz'.indexOf(k);
      if (!c.pts.every((p) => Math.abs(p[i] - v) < eps)) return false;
    }
    if (spec.box) {
      const mn = spec.box.min.map(num), mx = spec.box.max.map(num);
      if (!c.pts.every((p) => p.every((v, i) => v >= mn[i] - eps && v <= mx[i] + eps))) return false;
    }
    if (spec.parallel !== undefined) {
      const d = axis(spec.parallel);
      if (c.kind !== 'line' || Math.abs(dot(c.dir, d)) < 1 - 1e-6) return false;
    }
    if (spec.convex && !c.convex) return false;
    if (spec.concave && c.convex) return false;
    if (spec.kind && c.kind !== spec.kind) return false;
    if (spec.minLength !== undefined && c.length < num(spec.minLength)) return false;
    if (spec.maxLength !== undefined && c.length > num(spec.maxLength)) return false;
    return true;
  });
}

// Planar face nearest a point → face record.
export function faceNear(topo, p) {
  let best = -1, bd = Infinity;
  for (let k = 0; k < topo.nt; k++) {
    if (topo.area[k] < 1e-14) continue;
    const [a, b, c] = topo.tri(k);
    const d = len(sub(closestOnTri(p, topo.V[a], topo.V[b], topo.V[c]), p));
    if (d < bd - 1e-9) { bd = d; best = k; }
  }
  if (best < 0) throw new Error('Body has no faces');
  return topo.faces[topo.face[best]];
}

export function closestOnTri(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  const den = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * den), scale(ac, vc * den)));
}

// ---- fillet / chamfer cutters ------------------------------------------------------------------

// Cross-section frame at chain vertex i: tangent t, in-face directions dL, dR (perpendicular to t,
// pointing away from the edge along each face), outward normals nL, nR.
function sectionAt(topo, chain, i) {
  const { segs, pts, closed } = chain;
  const m = segs.length;
  const adj = [];
  if (i > 0 || closed) adj.push(segs[(i - 1 + m) % m]);
  if (i < m || closed) adj.push(segs[i % m]);
  const uniq = [...new Set(adj)];
  let t = [0, 0, 0], nL = [0, 0, 0], nR = [0, 0, 0];
  for (const s of uniq) {
    t = add(t, norm(sub(topo.V[s.b], topo.V[s.a])));
    nL = add(nL, topo.N[s.left]);
    nR = add(nR, topo.N[s.right]);
  }
  t = norm(t); nL = norm(nL); nR = norm(nR);
  const dL = norm(cross(nL, t)), dR = norm(cross(t, nR));
  return { P: pts[i], t, nL, nR, dL, dR, convex: dot(dL, nR) < 0 };
}

/**
 * Build the material to remove (convex edges) and add (concave edges) for a fillet or chamfer.
 * Each edge chain gets one swept cutter: its cross-section (apex, the two tangent points and, for
 * fillets, the arc between them) is placed at every chain vertex and stitched into a single mesh.
 * @returns {remove: Manifold|null, add: Manifold|null, warnings: []}
 */
export function edgeBlend(wasm, track, topo, chains, { kind, radius, distance, distance2, tolerance = 0.01 }) {
  const { Manifold } = wasm;
  const removeParts = [], addParts = [], warnings = [];
  const size = radius || Math.max(distance, distance2 || 0) || 1;
  const eps = 1e-3 * size + 1e-5;
  for (const chain of chains) {
    if (chain.mixed) { warnings.push(`Edge chain ${chain.id} is partly convex and partly concave — skipped`); continue; }
    const n = chain.closed ? chain.segs.length : chain.segs.length + 1;
    const secs = [];
    for (let i = 0; i < n; i++) secs.push(sectionAt(topo, chain, i));
    const thetas = secs.map((s) => Math.acos(Math.max(-1, Math.min(1, dot(s.dL, s.dR)))));
    if (thetas.some((t) => t < 1e-3 || t > Math.PI - 1e-3)) { warnings.push(`Edge chain ${chain.id} is (nearly) flat — skipped`); continue; }
    // arc resolution from the largest arc span along the chain
    const span = Math.PI - Math.min(...thetas);
    const step = radius > tolerance ? Math.min(2 * Math.acos(1 - tolerance / radius), Math.PI / 8) : Math.PI / 8;
    const K = kind === 'fillet' ? Math.max(2, Math.ceil(span / step)) : 0;
    const convex = chain.convex;
    const sign = convex ? 1 : -1; // push outside the material (convex) / into it (concave)
    const rings = [], caps2D = [];
    secs.forEach((s, i) => {
      let P = s.P;
      const end = !chain.closed && (i === 0 || i === n - 1);
      if (end && convex) P = add(P, scale(s.t, i === 0 ? -eps : eps));
      const theta = thetas[i];
      const bis = norm(add(s.dL, s.dR));
      const aL = kind === 'fillet' ? radius / Math.tan(theta / 2) : distance;
      const aR = kind === 'fillet' ? aL : distance2 ?? distance;
      const tL = add(P, scale(s.dL, aL)), tR = add(P, scale(s.dR, aR));
      const poly = [add(P, scale(bis, -eps))]; // apex: outside a convex edge, inside the material of a concave one
      if (kind === 'fillet') {
        const c = add(P, scale(bis, radius / Math.sin(theta / 2)));
        const u = norm(sub(tL, c)), w = norm(sub(tR, c));
        const phi = Math.acos(Math.max(-1, Math.min(1, dot(u, w))));
        const perp = norm(sub(w, scale(u, dot(u, w))));
        poly.push(add(tL, scale(s.nL, sign * eps)));
        for (let k = 0; k <= K; k++) {
          const a = phi * k / K;
          poly.push(add(c, scale(add(scale(u, Math.cos(a)), scale(perp, Math.sin(a))), radius)));
        }
        poly.push(add(tR, scale(s.nR, sign * eps)));
      } else {
        const along = norm(sub(tL, tR));
        poly.push(add(tL, scale(along, eps)), add(tR, scale(along, -eps)));
      }
      rings.push([poly]);
      // 2D coordinates in the section plane for cap triangulation
      const b1 = s.dL, b2 = cross(s.t, b1);
      caps2D.push([poly.map((q) => { const d = sub(q, P); return [dot(d, b1), dot(d, b2)]; })]);
    });
    // orient every cap polygon counter-clockwise consistently
    const orient = (pl) => { let a = 0; pl.forEach((p, k) => { const q = pl[(k + 1) % pl.length]; a += p[0] * q[1] - q[0] * p[1]; }); return a; };
    if (orient(caps2D[0][0]) < 0) {
      rings.forEach((r) => r[0].reverse());
      caps2D.forEach((c) => c[0].reverse());
    }
    let cutter;
    try {
      cutter = track(stitch(wasm, rings, chain.closed, { start: caps2D[0], end: caps2D[caps2D.length - 1] }));
    } catch (e) {
      warnings.push(`Edge chain ${chain.id}: ${e.message}`);
      continue;
    }
    (convex ? removeParts : addParts).push(cutter);
  }
  // Rounded corners where three or more selected convex chains meet at a vertex.
  if (kind === 'fillet') {
    const ends = new Map();
    for (const c of chains) if (!c.closed) for (const v of [c.verts[0], c.verts[c.verts.length - 1]]) ends.set(v, [...(ends.get(v) || []), c]);
    const segs = Math.max(16, Math.min(96, Math.ceil(2 * Math.PI / (radius > tolerance ? Math.min(2 * Math.acos(1 - tolerance / radius), Math.PI / 8) : Math.PI / 8))));
    for (const [v, cs] of ends) {
      if (cs.length < 3 || !cs.every((c) => c.convex)) continue;
      const corner = cornerCutter(wasm, track, topo, v, cs, radius, segs);
      if (corner) removeParts.push(corner);
    }
  }
  return {
    remove: removeParts.length ? track(Manifold.union(removeParts)) : null,
    add: addParts.length ? track(Manifold.union(addParts)) : null,
    warnings,
  };
}

function cornerCutter(wasm, track, topo, v, chains, r, segments) {
  // distinct face planes around the vertex
  const normals = [];
  for (const c of chains) for (const s of [c.segs[0], c.segs[c.segs.length - 1]]) {
    if (s.a !== v && s.b !== v) continue;
    for (const t of [s.left, s.right]) {
      const n = topo.N[t];
      if (!normals.some((m) => dot(m, n) > 1 - 1e-6)) normals.push(n);
    }
  }
  if (normals.length !== 3) return null;
  const V = topo.V[v];
  // Solve n_i · c = n_i · V − r
  const A = normals, b = normals.map((n) => dot(n, V) - r);
  const det = dot(A[0], cross(A[1], A[2]));
  if (Math.abs(det) < 1e-9) return null;
  const c = scale(add(add(scale(cross(A[1], A[2]), b[0]), scale(cross(A[2], A[0]), b[1])), scale(cross(A[0], A[1]), b[2])), 1 / det);
  const pts = [c];
  for (const n of normals) pts.push(add(c, scale(n, r)));
  for (const ch of chains) {
    const far = ch.verts[0] === v ? ch.pts[1] : ch.pts[ch.pts.length - 2];
    const e = norm(sub(far, V));
    pts.push(add(V, scale(e, dot(sub(c, V), e))));
  }
  const out = norm(normals.reduce((s, n) => add(s, n), [0, 0, 0]));
  pts.push(add(V, scale(out, 1e-3 * r + 1e-5)));
  const { Manifold } = wasm;
  const hull = track(Manifold.hull(pts));
  const sphere = track(Manifold.sphere(r, segments).translate(c));
  return track(hull.subtract(sphere));
}

// ---- shell ------------------------------------------------------------------------------------

/**
 * Hollow a solid. inside: keep material within `t` of the boundary (except open faces);
 * outside: add a skin of thickness t around it. Planar walls are offset exactly; concave
 * (inside) / convex (outside) edges get rounded blends.
 */
export function shellSolid(wasm, track, manifold, topo, t, { openFaces = [], outside = false, segments = 16 }) {
  const { Manifold, CrossSection } = wasm;
  const open = new Set(openFaces.map((f) => f.id));
  const sgn = outside ? 1 : -1;
  const pieces = [];
  const cosSmooth = Math.cos(FEATURE_ANGLE * Math.PI / 180);
  const isOpen = (k) => open.has(topo.face[k]);
  // ---- smooth patches: triangles connected across non-feature edges (open faces excluded) ----
  const patch = new Int32Array(topo.nt).fill(-1);
  const patches = [];
  for (let k0 = 0; k0 < topo.nt; k0++) {
    if (patch[k0] >= 0 || isOpen(k0)) continue;
    const id = patches.length, members = [k0];
    patch[k0] = id;
    for (let i = 0; i < members.length; i++) {
      const q = members[i], tq = topo.tri(q);
      for (let e = 0; e < 3; e++) {
        const o = topo.half.get(`${tq[(e + 1) % 3]},${tq[e]}`);
        if (o === undefined || patch[o] >= 0 || isOpen(o)) continue;
        if (dot(topo.N[q], topo.N[o]) < cosSmooth) continue;
        patch[o] = id; members.push(o);
      }
    }
    patches.push(members);
  }
  // ---- one offset band per patch ----
  const facetSlab = (k) => {
    const pts = topo.tri(k).map((i) => topo.V[i]);
    if (topo.area[k] < 1e-14) return;
    const n = topo.N[k], c = scale(add(add(pts[0], pts[1]), pts[2]), 1 / 3), grow = 1e-3 * t + 1e-6;
    const g = pts.map((p) => { const d = sub(p, c), L = len(d); return L > 0 ? add(p, scale(d, grow / L)) : p; });
    pieces.push(track(Manifold.hull([...g, ...g.map((p) => add(p, scale(n, sgn * t)))])));
  };
  for (const members of patches) {
    const band = patchBand(wasm, topo, members, t, sgn);
    if (band) pieces.push(track(band));
    else members.forEach(facetSlab); // fallback when the offset surface would fold over
  }
  // ---- blends along feature edges where neighbouring bands diverge (concave inside / convex outside) ----
  const r = t / Math.cos(Math.PI / segments);
  const sphereDirs = [];
  for (let i = 0; i < segments; i++) for (let j = 1; j < segments / 2; j++) {
    const th = 2 * Math.PI * i / segments, ph = Math.PI * j / (segments / 2);
    sphereDirs.push([Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)]);
  }
  sphereDirs.push([0, 0, 1], [0, 0, -1]);
  for (const [key, k] of topo.half) {
    const [a, b] = key.split(',').map(Number);
    if (a > b) continue;
    const o = topo.half.get(`${b},${a}`);
    if (o === undefined || patch[o] === patch[k]) continue;
    if (isOpen(o) || isOpen(k)) continue;
    // Every point within t of the surface belongs to the shell, so capsules along patch
    // boundaries are always valid; they fill the gaps where neighbouring bands diverge.
    const pts = [];
    for (const c of [topo.V[a], topo.V[b]]) for (const d of sphereDirs) pts.push(add(c, scale(d, r)));
    pieces.push(track(Manifold.hull(pts)));
  }
  if (!pieces.length) throw new Error('Shell: nothing left after removing the open faces');
  const U = track(Manifold.union(pieces));
  if (!outside) return track(manifold.intersect(U));
  let cut = manifold;
  for (const f of openFaces) cut = track(cut.add(shellFaceSlab(wasm, track, topo, f, t * 1.01 + 1e-4)));
  return track(track(manifold.add(U)).subtract(cut));
}

function solve3(A, b) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-18) return null;
  return [0, 1, 2].map((c) => det(A.map((row, i) => row.map((v, j) => (j === c ? b[i] : v)))) / D);
}

// Solid band between a smooth surface patch and its offset by t (sgn −1 inward, +1 outward).
// Vertex offsets keep every incident facet plane exactly t away (sharp-corner exact for planes).
// Returns null if the offset surface would fold over (curvature tighter than t).
function patchBand(wasm, topo, members, t, sgn) {
  const vNormals = new Map();
  for (const k of members) {
    if (topo.area[k] < 1e-14) continue;
    for (const v of topo.tri(k)) {
      if (!vNormals.has(v)) vNormals.set(v, []);
      const list = vNormals.get(v), n = topo.N[k];
      if (!list.some((m) => dot(m, n) > 1 - 1e-9)) list.push(n);
    }
  }
  const off = new Map();
  for (const [v, ns] of vNormals) {
    const avg = norm(ns.reduce((a, n) => add(a, n), [0, 0, 0]));
    const minDot = Math.min(...ns.map((n) => dot(n, avg)));
    let d;
    if (minDot > 0.97) d = scale(avg, t / minDot);
    else {
      // spread normals: least-squares offset keeping each facet plane t away (exact for ≤ 3 planes)
      const A = [[1e-9, 0, 0], [0, 1e-9, 0], [0, 0, 1e-9]], bb = [0, 0, 0];
      for (const n of ns) for (let i = 0; i < 3; i++) { bb[i] += n[i] * t; for (let j = 0; j < 3; j++) A[i][j] += n[i] * n[j]; }
      d = solve3(A, bb);
      if (!d || len(d) > 4 * t) return null;
    }
    off.set(v, add(topo.V[v], scale(d, sgn)));
  }
  const verts = [], idx = new Map(), oidx = new Map();
  const vi = (v) => { if (!idx.has(v)) { idx.set(v, verts.length); verts.push(topo.V[v]); } return idx.get(v); };
  const oi = (v) => { if (!off.has(v)) return -1; if (!oidx.has(v)) { oidx.set(v, verts.length); verts.push(off.get(v)); } return oidx.get(v); };
  const tris = [];
  const inPatch = new Set(members);
  for (const k of members) {
    const [a, b, c] = topo.tri(k);
    if (oi(a) < 0 || oi(b) < 0 || oi(c) < 0) return null;
    // fold-over check: the offset facet must face the same way as the original
    const A = off.get(a), B = off.get(b), C = off.get(c);
    const n2 = cross(sub(B, A), sub(C, A));
    if (topo.area[k] > 1e-12 && dot(n2, topo.N[k]) <= 0.2 * len(n2)) return null;
    tris.push([vi(a), vi(b), vi(c)], [oi(a), oi(c), oi(b)]);
    for (let e = 0; e < 3; e++) {
      const x = [a, b, c][e], y = [a, b, c][(e + 1) % 3];
      const o = topo.half.get(`${y},${x}`);
      if (o !== undefined && inPatch.has(o)) continue;
      tris.push([vi(y), vi(x), oi(x)], [vi(y), oi(x), oi(y)]); // side wall along the patch boundary
    }
  }
  try { return meshToManifold(wasm, verts, tris); } catch { return null; }
}

function shellFaceSlab(wasm, track, topo, f, h) {
  const { CrossSection } = wasm;
  const n = f.normal;
  let x = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  x = norm(sub(x, scale(n, dot(x, n))));
  const y = cross(n, x), o = topo.V[topo.tri(f.tris[0])[0]];
  const polys = f.tris.filter((k) => topo.area[k] > 1e-14).map((k) => topo.tri(k).map((i) => { const d = sub(topo.V[i], o); return [dot(d, x), dot(d, y)]; }));
  const cs = track(CrossSection.union(polys.map((p) => track(new CrossSection([p], 'Positive')))));
  return track(track(cs.extrude(h)).transform([...x, 0, ...y, 0, ...n, 0, ...o, 1]));
}
