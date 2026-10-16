// Sketch editing operations shared by the UI and the scripting API: trim, corner fillet,
// corner chamfer. They work on a sketch object ({entities, constraints}) using current coordinates.

import { discretize } from './sketch.js';

const TAU = 2 * Math.PI;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const crs = (a, b) => a[0] * b[1] - a[1] * b[0];
const nrm = (a) => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };
const wrap = (a) => ((a % TAU) + TAU) % TAU;

function ctx(sketch) {
  const byId = new Map(sketch.entities.map((e) => [e.id, e]));
  const used = new Set([...sketch.entities.map((e) => e.id), ...sketch.constraints.map((c) => c.id)]);
  const nextId = (prefix) => { let i = 1; while (used.has(`${prefix}${i}`)) i++; used.add(`${prefix}${i}`); return `${prefix}${i}`; };
  const P = (id) => { const p = byId.get(id); return [p.x, p.y]; };
  const addPoint = (p, extra = {}) => { const e = { id: nextId('p'), type: 'point', x: p[0], y: p[1], ...extra }; sketch.entities.push(e); byId.set(e.id, e); return e.id; };
  const addEnt = (e) => { e.id = nextId(e.type === 'line' ? 'l' : e.type === 'arc' ? 'a' : e.type === 'circle' ? 'c' : 'b'); sketch.entities.push(e); byId.set(e.id, e); return e.id; };
  const addCon = (c) => { c.id = nextId('k'); sketch.constraints.push(c); return c.id; };
  return { byId, P, addPoint, addEnt, addCon };
}

// Parametric description of a curve: param s ∈ [0, 1] along it.
function geom(C, e) {
  if (e.type === 'line') {
    const a = C.P(e.p1), b = C.P(e.p2);
    return { kind: 'line', a, b, at: (s) => addv(a, mul(sub(b, a), s)) };
  }
  if (e.type === 'circle' || e.type === 'arc') {
    const c = C.P(e.center);
    let r, a0, sweep;
    if (e.type === 'circle') { r = e.r; a0 = 0; sweep = TAU; }
    else {
      const s = C.P(e.start), t = C.P(e.end);
      r = Math.hypot(s[0] - c[0], s[1] - c[1]);
      a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
      sweep = wrap(Math.atan2(t[1] - c[1], t[0] - c[0]) - a0) || TAU;
    }
    return { kind: 'arc', c, r, a0, sweep, full: e.type === 'circle', at: (s) => [c[0] + r * Math.cos(a0 + s * sweep), c[1] + r * Math.sin(a0 + s * sweep)] };
  }
  if (e.type === 'bezier') {
    const pts = discretize(C.byId, e, 1e-5);
    const n = pts.length - 1;
    const ctrl = [e.p0, e.c1, e.c2, e.p1].map(C.P);
    return { kind: 'poly', pts, n, ctrl, at: (s) => bez(ctrl, s) };
  }
  return null;
}

const bez = (q, t) => { const u = 1 - t; return [0, 1].map((k) => u * u * u * q[0][k] + 3 * u * u * t * q[1][k] + 3 * u * t * t * q[2][k] + t * t * t * q[3][k]); };

// Parameter of point p (assumed on/near the curve).
function paramOf(G, p) {
  if (G.kind === 'line') { const d = sub(G.b, G.a); return dot(sub(p, G.a), d) / dot(d, d); }
  if (G.kind === 'arc') {
    const rel = wrap(Math.atan2(p[1] - G.c[1], p[0] - G.c[0]) - G.a0);
    if (G.full) return rel / TAU;
    if (rel <= G.sweep + 1e-9) return rel / G.sweep;
    return rel - G.sweep < TAU - rel ? 1 + (rel - G.sweep) / G.sweep : -(TAU - rel) / G.sweep; // outside the arc
  }
  // polyline (bezier): nearest segment
  let best = 0, bd = Infinity;
  for (let i = 0; i < G.n; i++) {
    const a = G.pts[i], b = G.pts[i + 1], d = sub(b, a), L = dot(d, d);
    const t = L ? Math.max(0, Math.min(1, dot(sub(p, a), d) / L)) : 0;
    const q = addv(a, mul(d, t)), dd = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (dd < bd) { bd = dd; best = (i + t) / G.n; }
  }
  return best;
}

const inRange = (G, s) => s >= -1e-9 && s <= 1 + 1e-9;

// Intersection points of two curves.
function intersect(A, B) {
  const segsOf = (G) => (G.kind === 'poly' ? G.pts.slice(0, -1).map((p, i) => ({ kind: 'line', a: p, b: G.pts[i + 1] })) : [G]);
  const out = [];
  for (const a of segsOf(A)) for (const b of segsOf(B)) {
    for (const p of rawIntersect(a, b)) out.push(p);
  }
  return out;
}

function rawIntersect(A, B) {
  if (A.kind === 'line' && B.kind === 'line') {
    const d1 = sub(A.b, A.a), d2 = sub(B.b, B.a), den = crs(d1, d2);
    if (Math.abs(den) < 1e-14) return [];
    const w = sub(B.a, A.a), t = crs(w, d2) / den, u = crs(w, d1) / den;
    return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? [addv(A.a, mul(d1, t))] : [];
  }
  if (A.kind === 'arc' && B.kind === 'line') return rawIntersect(B, A);
  if (A.kind === 'line' && B.kind === 'arc') {
    const d = sub(A.b, A.a), f = sub(A.a, B.c);
    const a = dot(d, d), b = 2 * dot(f, d), c = dot(f, f) - B.r * B.r;
    const disc = b * b - 4 * a * c;
    if (disc < -1e-12 * a * B.r * B.r) return [];
    const sq = Math.sqrt(Math.max(0, disc));
    const ts = disc <= 1e-12 * a * B.r * B.r ? [-b / (2 * a)] : [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
    return ts.filter((t) => t >= -1e-9 && t <= 1 + 1e-9).map((t) => addv(A.a, mul(d, t))).filter((p) => inRange(B, paramOf(B, p)));
  }
  if (A.kind === 'arc' && B.kind === 'arc') {
    const d = sub(B.c, A.c), D = Math.hypot(d[0], d[1]);
    if (D < 1e-12 || D > A.r + B.r + 1e-9 || D < Math.abs(A.r - B.r) - 1e-9) return [];
    const x = (D * D + A.r * A.r - B.r * B.r) / (2 * D), h2 = A.r * A.r - x * x, h = Math.sqrt(Math.max(0, h2));
    const u = mul(d, 1 / D), m = addv(A.c, mul(u, x)), n = [-u[1], u[0]];
    const pts = h < 1e-12 ? [m] : [addv(m, mul(n, h)), addv(m, mul(n, -h))];
    return pts.filter((p) => inRange(A, paramOf(A, p)) && inRange(B, paramOf(B, p)));
  }
  return [];
}

// de Casteljau sub-curve of a cubic on [t0, t1]
function subBezier(q, t0, t1) {
  const split = (c, t) => {
    const l = (a, b) => addv(a, mul(sub(b, a), t));
    const ab = l(c[0], c[1]), bc = l(c[1], c[2]), cd = l(c[2], c[3]), abc = l(ab, bc), bcd = l(bc, cd), m = l(abc, bcd);
    return [[c[0], ab, abc, m], [m, bcd, cd, c[3]]];
  };
  const right = split(q, t0)[1];
  return split(right, t0 < 1 ? (t1 - t0) / (1 - t0) : 0)[0];
}

function removeUnusedPoints(sketch, candidates) {
  const used = new Set();
  for (const e of sketch.entities) for (const k of ['p1', 'p2', 'center', 'start', 'end', 'p0', 'c1', 'c2']) if (e[k]) used.add(e[k]);
  const dead = new Set([...candidates].filter((id) => !used.has(id)));
  sketch.entities = sketch.entities.filter((e) => !dead.has(e.id));
  dropConstraintsReferencing(sketch, dead);
}

function dropConstraintsReferencing(sketch, ids) {
  sketch.constraints = sketch.constraints.filter((c) => !['a', 'b', 'line', 'point', 'circle'].some((k) => ids.has(c[k])) &&
    !(c.type === 'equation' && [...ids].some((id) => new RegExp(`\\b${id}\\b`).test(c.expr))));
}

/**
 * Trim the part of a curve between its neighbouring intersections that contains `at` (or the
 * whole curve when nothing crosses it). Returns a description of what happened.
 */
export function trimEntity(sketch, id, at) {
  const C = ctx(sketch);
  const e = C.byId.get(id);
  if (!e || !['line', 'circle', 'arc', 'bezier'].includes(e.type)) throw new Error(`trim: "${id}" is not a curve`);
  const G = geom(C, e);
  const cuts = []; // {s, p, by}
  for (const o of sketch.entities) {
    if (o === e || !['line', 'circle', 'arc', 'bezier'].includes(o.type)) continue;
    const H = geom(C, o);
    for (const p of intersect(G, H)) {
      const s = paramOf(G, p);
      if (G.full || (s > 1e-7 && s < 1 - 1e-7)) cuts.push({ s: G.full ? wrap(s * TAU) / TAU : s, p, by: o });
    }
  }
  cuts.sort((a, b) => a.s - b.s);
  const uniq = cuts.filter((c, i) => i === 0 || c.s - cuts[i - 1].s > 1e-7);
  const s0 = paramOf(G, at);
  const onCut = (cut, ptId) => {
    if (!cut) return;
    const o = cut.by;
    if (o.type === 'line') C.addCon({ type: 'pointOnLine', point: ptId, line: o.id });
    else if (o.type === 'circle' || o.type === 'arc') C.addCon({ type: 'pointOnCircle', point: ptId, circle: o.id });
  };
  const oldPts = new Set(['p1', 'p2', 'start', 'end', 'p0', 'p1', 'c1', 'c2', 'center'].map((k) => e[k]).filter(Boolean));

  if (G.full) {
    if (uniq.length < 2) { deleteEntity(sketch, id); return { deleted: id }; }
    let hiIdx = uniq.findIndex((c) => c.s > s0);
    if (hiIdx < 0) hiIdx = 0;
    const hi = uniq[hiIdx], lo = uniq[(hiIdx - 1 + uniq.length) % uniq.length];
    const sp = C.addPoint(hi.p), ep = C.addPoint(lo.p);
    e.type = 'arc'; e.start = sp; e.end = ep; delete e.r;
    onCut(hi, sp); onCut(lo, ep);
    return { trimmed: id, became: 'arc' };
  }

  const lo = [...uniq].reverse().find((c) => c.s < s0) || null;
  const hi = uniq.find((c) => c.s > s0) || null;
  if (!lo && !hi) { deleteEntity(sketch, id); return { deleted: id }; }
  const startKey = e.type === 'line' ? 'p1' : e.type === 'arc' ? 'start' : 'p0';
  const endKey = e.type === 'line' ? 'p2' : e.type === 'arc' ? 'end' : 'p1';
  // constraints that no longer hold for a shortened curve
  sketch.constraints = sketch.constraints.filter((c) => !((c.line === id || c.a === id) && ['length', 'midpoint'].includes(c.type)) && !(c.line === id && ['distanceX', 'distanceY'].includes(c.type)));
  const ctrl = G.kind === 'poly' ? G.ctrl : null;
  const setBez = (ent, q) => { for (const [k, i] of [['c1', 1], ['c2', 2]]) { const pt = C.byId.get(ent[k]); pt.x = q[i][0]; pt.y = q[i][1]; } };
  if (!lo) { // keep [hi, 1]
    const np = C.addPoint(hi.p);
    if (ctrl) setBez(e, subBezier(ctrl, hi.s, 1));
    e[startKey] = np; onCut(hi, np);
  } else if (!hi) { // keep [0, lo]
    const np = C.addPoint(lo.p);
    if (ctrl) setBez(e, subBezier(ctrl, 0, lo.s));
    e[endKey] = np; onCut(lo, np);
  } else { // keep [0, lo] and [hi, 1]
    const a = C.addPoint(lo.p), b = C.addPoint(hi.p);
    const oldEnd = e[endKey];
    let nid;
    if (e.type === 'line') {
      nid = C.addEnt({ type: 'line', p1: b, p2: oldEnd });
      C.addCon({ type: 'collinear', a: id, b: nid });
    } else if (e.type === 'arc') {
      nid = C.addEnt({ type: 'arc', center: e.center, start: b, end: oldEnd });
      C.addCon({ type: 'equal', a: id, b: nid });
    } else {
      const q2 = subBezier(ctrl, hi.s, 1);
      nid = C.addEnt({ type: 'bezier', p0: b, c1: C.addPoint(q2[1], { construction: true }), c2: C.addPoint(q2[2], { construction: true }), p1: oldEnd });
      setBez(e, subBezier(ctrl, 0, lo.s));
    }
    if (e.construction) C.byId.get(nid).construction = true;
    e[endKey] = a;
    onCut(lo, a); onCut(hi, b);
  }
  removeUnusedPoints(sketch, oldPts);
  return { trimmed: id };
}

export function deleteEntity(sketch, id) {
  const e = sketch.entities.find((x) => x.id === id);
  if (!e) return;
  const pts = ['p1', 'p2', 'center', 'start', 'end', 'p0', 'c1', 'c2'].map((k) => e[k]).filter(Boolean);
  sketch.entities = sketch.entities.filter((x) => x !== e);
  dropConstraintsReferencing(sketch, new Set([id]));
  removeUnusedPoints(sketch, new Set(pts));
}

// Two lines meeting at point `pid` (shared endpoint).
function cornerLines(sketch, C, pid) {
  const lines = sketch.entities.filter((e) => e.type === 'line' && (e.p1 === pid || e.p2 === pid));
  if (lines.length !== 2) throw new Error(`Corner "${pid}" must join exactly two lines (found ${lines.length})`);
  const P = C.P(pid);
  const other = (l) => C.P(l.p1 === pid ? l.p2 : l.p1);
  const u1 = nrm(sub(other(lines[0]), P)), u2 = nrm(sub(other(lines[1]), P));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (theta < 1e-6 || theta > Math.PI - 1e-6) throw new Error(`Lines at "${pid}" are parallel — nothing to round`);
  return { lines, P, u1, u2, theta, len: lines.map((l) => Math.hypot(...sub(other(l), P))) };
}

// Keep the original corner as a construction "virtual sharp" point on both lines, so dimensions
// and fixes that referenced it stay meaningful; line-length dimensions become corner-to-corner
// distances.
function keepVirtualCorner(sketch, C, pid, lines, newEnds) {
  const P = C.byId.get(pid);
  P.construction = true;
  for (const [i, l] of lines.entries()) {
    const key = l.p1 === pid ? 'p1' : 'p2';
    const other = key === 'p1' ? l.p2 : l.p1;
    for (const c of sketch.constraints) {
      if (c.type === 'length' && c.line === l.id) { c.type = 'distance'; delete c.line; c.a = key === 'p1' ? pid : other; c.b = key === 'p1' ? other : pid; }
      if ((c.type === 'distanceX' || c.type === 'distanceY') && c.line === l.id) { delete c.line; c.a = l.p1 === pid ? pid : l.p1; c.b = l.p2 === pid ? pid : l.p2; }
    }
    l[key] = newEnds[i];
    C.addCon({ type: 'pointOnLine', point: pid, line: l.id });
  }
}

/** Round the corner at point `pid` (shared by two lines) with a tangent arc of radius r. */
export function filletCorner(sketch, pid, r, value = r) {
  const C = ctx(sketch);
  const { lines, P, u1, u2, theta, len } = cornerLines(sketch, C, pid);
  const d = r / Math.tan(theta / 2);
  if (d >= Math.min(...len) - 1e-9) throw new Error(`Fillet radius ${r} is too large for the corner at "${pid}"`);
  const T1 = addv(P, mul(u1, d)), T2 = addv(P, mul(u2, d));
  const Cc = addv(P, mul(nrm(addv(u1, u2)), r / Math.sin(theta / 2)));
  const t1 = C.addPoint(T1), t2 = C.addPoint(T2), c = C.addPoint(Cc, { construction: true });
  keepVirtualCorner(sketch, C, pid, lines, [t1, t2]);
  const ccw = crs(sub(T1, Cc), sub(T2, Cc)) > 0;
  const arc = C.addEnt({ type: 'arc', center: c, start: ccw ? t1 : t2, end: ccw ? t2 : t1 });
  C.addCon({ type: 'tangent', a: lines[0].id, b: arc });
  C.addCon({ type: 'tangent', a: lines[1].id, b: arc });
  C.addCon({ type: 'radius', circle: arc, value });
  return arc;
}

/** Cut the corner at point `pid` with a straight chamfer, `d` (and `d2`) along the lines. */
export function chamferCorner(sketch, pid, d, d2 = d, values = [d, d2]) {
  const C = ctx(sketch);
  const { lines, P, u1, u2, len } = cornerLines(sketch, C, pid);
  if (d >= len[0] - 1e-9 || d2 >= len[1] - 1e-9) throw new Error(`Chamfer is too large for the corner at "${pid}"`);
  const t1 = C.addPoint(addv(P, mul(u1, d))), t2 = C.addPoint(addv(P, mul(u2, d2)));
  keepVirtualCorner(sketch, C, pid, lines, [t1, t2]);
  const l = C.addEnt({ type: 'line', p1: t1, p2: t2 });
  C.addCon({ type: 'distance', a: pid, b: t1, value: values[0] });
  C.addCon({ type: 'distance', a: pid, b: t2, value: values[1] ?? values[0] });
  return l;
}
