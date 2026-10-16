// Sketch evaluation: solve constraints, discretise curves, find closed loops / regions,
// and turn profile specifications into 2D cross-sections (manifold CrossSection).

import { solveSketch, indexEntities, entityEnds } from './solver.js';
import { toWorld } from './vec.js';

export const DEFAULT_TOLERANCE = 0.01; // max chord error in mm when discretising curves

// ---- discretisation ------------------------------------------------------------------------

function arcSegments(r, sweep, tol) {
  const step = r > tol ? 2 * Math.acos(1 - tol / r) : Math.PI / 4;
  const n = Math.ceil(sweep / Math.min(step, Math.PI / 8));
  return Math.max(2, Math.min(n, Math.ceil(720 * sweep / (2 * Math.PI))));
}

export function arcGeometry(byId, e) {
  const c = byId.get(e.center), s = byId.get(e.start), t = byId.get(e.end);
  const r = Math.hypot(s.x - c.x, s.y - c.y);
  const a0 = Math.atan2(s.y - c.y, s.x - c.x), a1 = Math.atan2(t.y - c.y, t.x - c.x);
  let sweep = a1 - a0;
  while (sweep <= 1e-12) sweep += 2 * Math.PI;
  return { c: [c.x, c.y], r, a0, sweep };
}

// Polyline for a curve entity, from its first endpoint to its last.
export function discretize(byId, e, tol = DEFAULT_TOLERANCE) {
  const P = (id) => { const p = byId.get(id); return [p.x, p.y]; };
  switch (e.type) {
    case 'line': return [P(e.p1), P(e.p2)];
    case 'arc': {
      const { c, r, a0, sweep } = arcGeometry(byId, e);
      const n = arcSegments(r, sweep, tol);
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + sweep * i / n;
        pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
      }
      pts[0] = P(e.start); pts[n] = P(e.end); // exact endpoints
      return pts;
    }
    case 'circle': {
      const c = P(e.center), r = e.r;
      // multiple of 4 so the quadrant points (and therefore the bounding box) are exact
      const n = Math.ceil(Math.max(12, arcSegments(r, 2 * Math.PI, tol)) / 4) * 4;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = 2 * Math.PI * i / n;
        pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
      }
      return pts; // closed implicitly
    }
    case 'bezier': {
      const p0 = P(e.p0), c1 = P(e.c1), c2 = P(e.c2), p1 = P(e.p1);
      const ctrl = Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(p1[0] - c2[0], p1[1] - c2[1]);
      const n = Math.max(8, Math.min(256, Math.ceil(Math.sqrt(ctrl / tol) * 1.5)));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n, u = 1 - t;
        const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        pts.push([0, 1].map((k) => b[0] * p0[k] + b[1] * c1[k] + b[2] * c2[k] + b[3] * p1[k]));
      }
      return pts;
    }
  }
  return null;
}

export const signedArea = (poly) => {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

export function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- topology: closed loops from the curve graph ---------------------------------------------

// Planar arrangement of all non-construction curves: curves are split wherever they cross or
// touch each other, so overlapping or crossing shapes form separate closed regions.
function buildGraph(sketch, byId, tol, split = true) {
  const ents = sketch.entities;
  // Canonical point positions: coincident constraints share the root point's coordinates.
  const parent = new Map();
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  for (const e of ents) if (e.type === 'point') parent.set(e.id, e.id);
  for (const c of sketch.constraints || []) {
    if (c.type === 'coincident' && parent.has(c.a) && parent.has(c.b)) { const a = find(c.a), b = find(c.b); if (a !== b) parent.set(a, b); }
  }
  const posOf = (pid) => { const p = byId.get(find(pid)); return [p.x, p.y]; };
  const curves = [];
  for (const e of ents) {
    if (e.construction || e.type === 'point') continue;
    let pts = discretize(byId, e, tol);
    if (!pts || pts.length < 2) continue;
    if (e.type === 'circle') { curves.push({ id: e.id, pts, closed: true }); continue; }
    const ends = entityEnds(e);
    pts = pts.slice();
    pts[0] = posOf(ends[0]);
    pts[pts.length - 1] = posOf(ends[1]);
    if (find(ends[0]) === find(ends[1])) {
      if (pts.length > 3) curves.push({ id: e.id, pts: pts.slice(0, -1), closed: true });
      continue;
    }
    curves.push({ id: e.id, pts, closed: false });
  }
  // scale-aware tolerance
  let ext = 1;
  for (const c of curves) for (const p of c.pts) ext = Math.max(ext, Math.abs(p[0]), Math.abs(p[1]));
  const eps = 1e-9 * ext;
  const segCount = (c) => (c.closed ? c.pts.length : c.pts.length - 1);
  const seg = (c, k) => [c.pts[k], c.pts[(k + 1) % c.pts.length]];
  const bbox = (c) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of c.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0 - eps, y0 - eps, x1 + eps, y1 + eps];
  };
  curves.forEach((c) => { c.bb = bbox(c); c.splits = []; });
  const addSplit = (c, k, t, p) => c.splits.push({ s: k + Math.max(0, Math.min(1, t)), p });
  for (let i = 0; i < (split ? curves.length : 0); i++) {
    for (let j = i + 1; j < curves.length; j++) {
      const A = curves[i], B = curves[j];
      if (A.bb[2] < B.bb[0] || B.bb[2] < A.bb[0] || A.bb[3] < B.bb[1] || B.bb[3] < A.bb[1]) continue;
      for (let ka = 0; ka < segCount(A); ka++) {
        const [p, p2] = seg(A, ka);
        const d1 = [p2[0] - p[0], p2[1] - p[1]];
        const sx0 = Math.min(p[0], p2[0]) - eps, sx1 = Math.max(p[0], p2[0]) + eps, sy0 = Math.min(p[1], p2[1]) - eps, sy1 = Math.max(p[1], p2[1]) + eps;
        for (let kb = 0; kb < segCount(B); kb++) {
          const [q, q2] = seg(B, kb);
          if (Math.max(q[0], q2[0]) < sx0 || Math.min(q[0], q2[0]) > sx1 || Math.max(q[1], q2[1]) < sy0 || Math.min(q[1], q2[1]) > sy1) continue;
          const d2 = [q2[0] - q[0], q2[1] - q[1]];
          const den = d1[0] * d2[1] - d1[1] * d2[0];
          const L1 = Math.hypot(...d1), L2 = Math.hypot(...d2);
          const w = [q[0] - p[0], q[1] - p[1]];
          if (Math.abs(den) < 1e-12 * L1 * L2) {
            // parallel: collinear overlaps split at each other's endpoints
            if (Math.abs(w[0] * d1[1] - w[1] * d1[0]) / (L1 || 1) > eps) continue;
            for (const [pt, onA, kk, P0, D, L] of [[q, true, ka, p, d1, L1], [q2, true, ka, p, d1, L1], [p, false, kb, q, d2, L2], [p2, false, kb, q, d2, L2]]) {
              const t = ((pt[0] - P0[0]) * D[0] + (pt[1] - P0[1]) * D[1]) / (L * L);
              if (t > -1e-9 && t < 1 + 1e-9) addSplit(onA ? A : B, kk, t, pt);
            }
            continue;
          }
          const ta = (w[0] * d2[1] - w[1] * d2[0]) / den, tb = (w[0] * d1[1] - w[1] * d1[0]) / den;
          const ea = eps / (L1 || 1), eb = eps / (L2 || 1);
          if (ta < -ea || ta > 1 + ea || tb < -eb || tb > 1 + eb) continue;
          let pt;
          if (ta <= ea) pt = p; else if (ta >= 1 - ea) pt = p2; else if (tb <= eb) pt = q; else if (tb >= 1 - eb) pt = q2;
          else pt = [p[0] + d1[0] * ta, p[1] + d1[1] * ta];
          addSplit(A, ka, ta, pt);
          addSplit(B, kb, tb, pt);
        }
      }
    }
  }
  // Node keys from positions (endpoint snapping makes shared/touching points identical).
  const keyOf = (p) => `${Math.round(p[0] / eps / 100)},${Math.round(p[1] / eps / 100)}`;
  const edges = [], closed = [];
  for (const c of curves) {
    const n = segCount(c);
    let splits = c.splits.filter((x) => c.closed || (x.s > 1e-9 && x.s < n - 1e-9)).sort((a, b) => a.s - b.s);
    // dedupe nearly equal parameters
    splits = splits.filter((x, i) => i === 0 || x.s - splits[i - 1].s > 1e-9);
    const pointAt = (sv) => {
      const k = Math.min(Math.floor(sv), n - 1), t = sv - k;
      const [a, b] = seg(c, k);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    const piece = (s0, s1, p0, p1) => {
      // polyline from param s0 to s1 (s1 may exceed n for closed curves)
      const pts = [p0];
      for (let k = Math.floor(s0) + 1; k < s1 - 1e-12; k++) pts.push(c.pts[k % c.pts.length]);
      pts.push(p1);
      return pts;
    };
    if (c.closed) {
      if (splits.length < 2) {
        if (splits.length === 0) { closed.push({ entities: [c.id], poly: c.pts }); continue; }
        const s0 = splits[0];
        edges.push({ id: c.id, a: keyOf(s0.p), b: keyOf(s0.p), pts: piece(s0.s, s0.s + n, s0.p, s0.p), self: true });
        continue;
      }
      for (let i = 0; i < splits.length; i++) {
        const A = splits[i], B = splits[(i + 1) % splits.length];
        const sB = i + 1 < splits.length ? B.s : B.s + n;
        edges.push({ id: c.id, a: keyOf(A.p), b: keyOf(B.p), pts: piece(A.s, sB, A.p, B.p) });
      }
    } else {
      const cuts = [{ s: 0, p: c.pts[0] }, ...splits, { s: n, p: c.pts[c.pts.length - 1] }];
      for (let i = 0; i + 1 < cuts.length; i++) edges.push({ id: c.id, a: keyOf(cuts[i].p), b: keyOf(cuts[i + 1].p), pts: piece(cuts[i].s, cuts[i + 1].s, cuts[i].p, cuts[i + 1].p) });
    }
  }
  // drop degenerate pieces and duplicates (collinear overlaps produce the same piece twice)
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    if (e.self) { // a closed curve touched at a single point: keep it as a loop
      closed.push({ entities: [e.id], poly: e.pts.slice(0, -1) });
      continue;
    }
    if (e.a === e.b && e.pts.length < 4) continue;
    let L = 0;
    for (let i = 0; i + 1 < e.pts.length; i++) L += Math.hypot(e.pts[i + 1][0] - e.pts[i][0], e.pts[i + 1][1] - e.pts[i][1]);
    if (L < eps * 10) continue;
    const m = e.pts[Math.floor(e.pts.length / 2)], m2 = e.pts.length === 2 ? [(e.pts[0][0] + e.pts[1][0]) / 2, (e.pts[0][1] + e.pts[1][1]) / 2] : m;
    const key = [e.a, e.b].sort().join('|') + '|' + keyOf(m2);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return { edges: out, closed, find };
}

// Find bounded faces of the planar curve graph (half-edge traversal). Returns loops:
// [{id, entities:[...], poly:[[u,v]...] (CCW), area}]
// split=false: closed shapes as drawn (curves joined at shared endpoints) — "shape loops".
// split=true: planar arrangement where crossing curves are split — "regions" (atomic faces).
export function findLoops(sketch, byId, tol = DEFAULT_TOLERANCE, split = false) {
  const { edges: all, closed } = buildGraph(sketch, byId, tol, split);
  // prune dangling edges
  let edges = all;
  for (;;) {
    const deg = new Map();
    for (const e of edges) { deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); }
    const kept = edges.filter((e) => deg.get(e.a) > 1 && deg.get(e.b) > 1);
    if (kept.length === edges.length) break;
    edges = kept;
  }
  const out = new Map(); // node -> [{he, ang}]
  const hes = [];
  for (const e of edges) {
    const fwd = { edge: e, from: e.a, to: e.b, pts: e.pts };
    const rev = { edge: e, from: e.b, to: e.a, pts: e.pts.slice().reverse() };
    fwd.twin = rev; rev.twin = fwd;
    hes.push(fwd, rev);
  }
  for (const h of hes) {
    const p = h.pts[0], q = h.pts[1];
    h.ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
    if (!out.has(h.from)) out.set(h.from, []);
    out.get(h.from).push(h);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.ang - b.ang);
    list.forEach((h, i) => { h.idx = i; });
  }
  const loops = [];
  const seen = new Set();
  for (const h0 of hes) {
    if (seen.has(h0)) continue;
    const poly = [], ents = [];
    let h = h0, guard = 0;
    while (!seen.has(h) && guard++ < 100000) {
      seen.add(h);
      for (let i = 0; i < h.pts.length - 1; i++) poly.push(h.pts[i]);
      ents.push(h.edge.id);
      const list = out.get(h.to);
      const t = h.twin;
      h = list[(t.idx - 1 + list.length) % list.length];
    }
    const area = signedArea(poly);
    if (area > 1e-9) loops.push({ entities: ents, poly, area });
  }
  for (const c of closed) {
    let poly = c.poly, area = signedArea(poly);
    if (area < 0) { poly = poly.slice().reverse(); area = -area; }
    if (area > 1e-9) loops.push({ entities: c.entities, poly, area });
  }
  // Loop ids from their entities; faces cut from the same entities get #2, #3… (ordered by position).
  const groups = new Map();
  for (const l of loops) {
    l.id = [...new Set(l.entities)].sort().join('+');
    if (!groups.has(l.id)) groups.set(l.id, []);
    groups.get(l.id).push(l);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const c = (l) => l.poly.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((v) => v / l.poly.length);
    list.sort((a, b) => { const ca = c(a), cb = c(b); return Math.abs(ca[0] - cb[0]) > 1e-6 ? ca[0] - cb[0] : ca[1] - cb[1]; });
    list.forEach((l, i) => { if (i) l.id += `#${i + 1}`; });
  }
  return loops;
}

// ---- sketch evaluation ---------------------------------------------------------------------

/**
 * Evaluate a sketch: solve, discretise, find loops.
 * @param sketch   the document's sketch object (positions are updated in place by the solver)
 * @param frame    plane frame {o,x,y,n}
 * @param valueOf  expression evaluator
 * @param wasm     manifold module (for CrossSection); may be null for solve-only use
 */
export function evaluateSketch(sketch, frame, valueOf, wasm, opts = {}) {
  sketch.entities ||= [];
  sketch.constraints ||= [];
  const tol = opts.tolerance || DEFAULT_TOLERANCE;
  const solve = solveSketch(sketch, valueOf, opts);
  const byId = indexEntities(sketch.entities);
  const loops = findLoops(sketch, byId, tol, false);
  const faces = findLoops(sketch, byId, tol, true);
  const polylines = new Map();
  for (const e of sketch.entities) {
    const pts = discretize(byId, e, tol);
    if (pts) polylines.set(e.id, e.type === 'circle' ? [...pts, pts[0]] : pts);
  }
  return new SketchResult(sketch, frame, byId, solve, loops, faces, polylines, wasm, tol);
}

export class SketchResult {
  constructor(sketch, frame, byId, solve, loops, faces, polylines, wasm, tol) {
    Object.assign(this, { sketch, frame, byId, solve, loops, faces, polylines, wasm, tol });
  }

  point(id) {
    const p = this.byId.get(id);
    if (!p || p.type !== 'point') throw new Error(`Sketch "${this.sketch.id}": no point "${id}"`);
    return [p.x, p.y];
  }
  world(uv) { return toWorld(this.frame, uv); }

  loopsFor(ref) {
    let ls = this.loops.filter((l) => l.id === ref);
    if (!ls.length) ls = this.faces.filter((l) => l.id === ref);
    if (!ls.length) ls = this.loops.filter((l) => l.entities.includes(ref));
    if (!ls.length) {
      const e = this.byId.get(ref);
      if (!e) throw new Error(`Sketch "${this.sketch.id}": unknown loop/entity "${ref}"`);
      throw new Error(`Sketch "${this.sketch.id}": "${ref}" is not part of a closed loop`);
    }
    return ls;
  }

  loopCS(loop, track) {
    const { CrossSection } = this.wasm;
    return track(new CrossSection([loop.poly], 'Positive'));
  }

  // Atomic region containing a point: inside every region face that contains it, outside all others.
  regionAt(uv) {
    const inside = [], outside = [];
    for (const l of this.faces) (pointInPolygon(uv, l.poly) ? inside : outside).push(l.id);
    return inside.length ? { inside, outside } : null;
  }

  /**
   * Profile specification → CrossSection.
   *   undefined | "all" | "auto"      all closed loops; nested loops become holes (alternating)
   *   "l1"                            the closed loop containing entity l1 (or a loop id "a+b+c")
   *   ["l1", "c2"] | {union: [...]}   union
   *   {subtract: [a, b, ...]}         a minus the rest
   *   {intersect: [...]}, {xor: [...]}
   *   {point: [u, v]}                 the smallest region containing that point
   *   {region: {inside:[...], outside:[...]}}  explicit atomic region
   *   {regions: [region...]}           union of regions
   *   {offset: d, of: spec, join: "round"|"miter"|"square"}  grow (+) / shrink (−)
   */
  profile(spec, track, valueOf = (v) => Number(v)) {
    const { CrossSection } = this.wasm;
    const ofList = (list) => list.map((s) => this.profile(s, track, valueOf));
    const union = (list) => {
      if (!list.length) throw new Error(`Sketch "${this.sketch.id}": the profile selection is empty`);
      return list.length === 1 ? list[0] : track(CrossSection.union(list));
    };
    if (spec === undefined || spec === null || spec === 'all' || spec === 'auto') return this.autoProfile(track);
    if (typeof spec === 'string') return union(this.loopsFor(spec).map((l) => this.loopCS(l, track)));
    if (Array.isArray(spec)) return union(ofList(spec));
    if (spec.union) return union(ofList(spec.union));
    if (spec.loops) return union(ofList(spec.loops));
    if (spec.subtract) {
      const [a, ...rest] = ofList(spec.subtract);
      return rest.length ? track(a.subtract(union(rest))) : a;
    }
    if (spec.intersect) return track(CrossSection.intersection(ofList(spec.intersect)));
    if (spec.xor) {
      return ofList(spec.xor).reduce((acc, cs) => acc ? track(track(acc.subtract(cs)).add(track(cs.subtract(acc)))) : cs, null);
    }
    if (spec.point) {
      const r = this.regionAt(spec.point.map((v) => valueOf(v)));
      if (!r) throw new Error(`Sketch "${this.sketch.id}": no closed region at point [${spec.point}]`);
      return this.profile({ region: r }, track, valueOf);
    }
    if (spec.region) {
      const ins = spec.region.inside.map((id) => union(this.loopsFor(id).map((l) => this.loopCS(l, track))));
      const outs = (spec.region.outside || []).flatMap((id) => {
        try { return this.loopsFor(id).map((l) => this.loopCS(l, track)); } catch { return []; }
      });
      let cs = track(CrossSection.intersection(ins));
      if (outs.length) cs = track(cs.subtract(union(outs)));
      return cs;
    }
    if (spec.regions) return union(spec.regions.map((r) => this.profile(r.inside ? { region: r } : r, track, valueOf)));
    if (spec.offset !== undefined) {
      const base = this.profile(spec.of, track, valueOf);
      const join = { round: 'Round', miter: 'Miter', square: 'Square' }[spec.join || 'round'];
      return track(base.offset(valueOf(spec.offset), join, 2, 64));
    }
    throw new Error(`Unrecognised profile spec ${JSON.stringify(spec)}`);
  }

  autoProfile(track) {
    const { CrossSection } = this.wasm;
    // Shapes as drawn; if curves only close by crossing each other, use the crossing regions.
    const loops = this.loops.length ? this.loops : this.faces;
    if (!loops.length) throw new Error(`Sketch "${this.sketch.id}" has no closed loops`);
    const cs = loops.map((l) => this.loopCS(l, track));
    const depth = loops.map((l, i) => {
      let d = 0;
      for (let j = 0; j < loops.length; j++) {
        if (i === j || loops[j].area <= l.area) continue;
        const diff = track(cs[i].subtract(cs[j]));
        if (diff.area() < 1e-9 * l.area + 1e-12) d++;
      }
      return d;
    });
    const maxD = Math.max(...depth);
    let acc = null;
    for (let d = 0; d <= maxD; d++) {
      const level = cs.filter((_, i) => depth[i] === d);
      if (!level.length) continue;
      const u = track(CrossSection.union(level));
      acc = !acc ? u : track(d % 2 ? acc.subtract(u) : acc.add(u));
    }
    return acc;
  }

  // All atomic regions (for UI picking / display): [{inside, outside, polys, sample, area}]
  regions(track) {
    const { CrossSection } = this.wasm;
    const seen = new Map();
    const samples = this.faces.map((f) => interiorPoint([f.poly]));
    for (const [i, f] of this.faces.entries()) {
      let cs = this.loopCS(f, track);
      const inner = this.faces.filter((g, j) => j !== i && g.area < f.area && samples[j] && pointInPolygon(samples[j], f.poly));
      if (inner.length) cs = track(cs.subtract(track(CrossSection.union(inner.map((g) => this.loopCS(g, track))))));
      for (const part of cs.decompose()) {
        track(part);
        const pt = interiorPoint(part.toPolygons());
        const r = pt && this.regionAt(pt);
        if (!r) continue;
        const key = r.inside.slice().sort().join('|');
        if (seen.has(key)) continue;
        const rcs = this.profile({ region: r }, track);
        if (rcs.area() < 1e-9) continue;
        seen.set(key, { ...r, polys: rcs.toPolygons(), area: rcs.area(), sample: pt });
      }
    }
    return [...seen.values()];
  }

  // Ordered chain of open curves → world-space polyline for sweeps.
  path(entityIds) {
    const ids = entityIds || this.sketch.entities.filter((e) => !e.construction && entityEnds(e).length).map((e) => e.id);
    const segs = ids.map((id) => {
      const e = this.byId.get(id);
      if (!e) throw new Error(`Sketch "${this.sketch.id}": no entity "${id}"`);
      if (e.type === 'circle') return { id, pts: this.polylines.get(id), closedCurve: true };
      return { id, pts: this.polylines.get(id) };
    });
    if (segs.length === 1 && segs[0].closedCurve) {
      return { points: segs[0].pts.slice(0, -1).map((p) => this.world(p)), closed: true };
    }
    const key = (p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
    const ends = new Map();
    for (const s of segs) for (const p of [s.pts[0], s.pts[s.pts.length - 1]]) ends.set(key(p), (ends.get(key(p)) || 0) + 1);
    let start = segs[0].pts[0];
    for (const s of segs) for (const p of [s.pts[0], s.pts[s.pts.length - 1]]) if (ends.get(key(p)) === 1) { start = p; break; }
    const used = new Set();
    const chain = [start];
    let cur = start;
    while (used.size < segs.length) {
      const s = segs.find((s) => !used.has(s) && (key(s.pts[0]) === key(cur) || key(s.pts[s.pts.length - 1]) === key(cur)));
      if (!s) throw new Error(`Sweep path in sketch "${this.sketch.id}" is not a single connected chain`);
      used.add(s);
      const pts = key(s.pts[0]) === key(cur) ? s.pts : s.pts.slice().reverse();
      chain.push(...pts.slice(1));
      cur = pts[pts.length - 1];
    }
    const closed = chain.length > 2 && key(chain[0]) === key(chain[chain.length - 1]);
    if (closed) chain.pop();
    return { points: chain.map((p) => this.world(p)), closed };
  }

  lineWorld(id) {
    const e = this.byId.get(id);
    if (!e || e.type !== 'line') throw new Error(`Sketch "${this.sketch.id}": "${id}" is not a line`);
    return { a: this.world(this.point(e.p1)), b: this.world(this.point(e.p2)), a2: this.point(e.p1), b2: this.point(e.p2) };
  }
}

// A point strictly inside a polygon set (outer + holes), found by scanning a horizontal line.
export function interiorPoint(polys) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of polys) for (const q of p) { minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]); }
  for (const f of [0.5, 0.37, 0.63, 0.23, 0.77, 0.11, 0.89]) {
    const y = minY + (maxY - minY) * f;
    const xs = [];
    for (const p of polys)
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
    xs.sort((a, b) => a - b);
    let best = null, bw = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > bw) { bw = xs[i + 1] - xs[i]; best = [(xs[i] + xs[i + 1]) / 2, y]; }
    if (best && bw > 1e-6) return best;
  }
  return null;
}
