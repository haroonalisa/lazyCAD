// 2D geometric constraint solver (damped least squares / Levenberg–Marquardt).
//
// Unknowns: x,y of every non-fixed point, and the radius of every circle.
// Each constraint contributes one or more residual equations; the solver drives them to zero
// while moving geometry as little as possible (so under-constrained sketches stay put).
// After solving it reports degrees of freedom and which points are fully determined.

import { parseCached, evalAst, entityRefs } from './expr.js';

const D2R = Math.PI / 180;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class SolveError extends Error {}

// Normalise a sketch's entity list into lookup maps.
export function indexEntities(entities) {
  const byId = new Map();
  for (const e of entities) {
    if (!e.id) throw new SolveError('Every sketch entity needs an id');
    if (byId.has(e.id)) throw new SolveError(`Duplicate entity id "${e.id}"`);
    byId.set(e.id, e);
  }
  return byId;
}

// Which point ids does an entity reference?
export function entityPoints(e) {
  switch (e.type) {
    case 'point': return [e.id];
    case 'line': return [e.p1, e.p2];
    case 'circle': return [e.center];
    case 'arc': return [e.center, e.start, e.end];
    case 'bezier': return [e.p0, e.c1, e.c2, e.p1];
    default: return [];
  }
}

// Endpoints of a curve entity (where it can connect to others).
export function entityEnds(e) {
  switch (e.type) {
    case 'line': return [e.p1, e.p2];
    case 'arc': return [e.start, e.end];
    case 'bezier': return [e.p0, e.p1];
    default: return [];
  }
}

/**
 * Solve a sketch in place.
 * @param sketch {entities, constraints}
 * @param valueOf (exprOrNumber) => number   evaluates dimension values with document params
 * @param opts {drag: {point, to:[u,v]}, maxIter}
 * @returns {ok, maxResidual, dof, freePoints:Set, residuals:[{id, r}], iterations, errors}
 */
export function solveSketch(sketch, valueOf, opts = {}) {
  const entities = sketch.entities || [];
  const constraints = sketch.constraints || [];
  const byId = indexEntities(entities);
  const errors = [];

  // ---- unknown vector ----
  const vars = []; // {ent, key}
  const varIndex = new Map(); // "id.key" -> index
  const addVar = (e, key) => { varIndex.set(`${e.id}.${key}`, vars.length); vars.push({ e, key }); };
  for (const e of entities) {
    if (e.type === 'point' && !e.fixed) { addVar(e, 'x'); addVar(e, 'y'); }
    if (e.type === 'circle') {
      if (typeof e.r !== 'number') e.r = Number(e.r) || 1;
      addVar(e, 'r');
    }
  }
  const X = vars.map((v) => v.e[v.key]);
  for (let i = 0; i < X.length; i++) if (!Number.isFinite(X[i])) X[i] = 0;

  const get = (id, kind) => {
    const e = byId.get(id);
    if (!e) throw new SolveError(`Unknown entity "${id}"`);
    if (kind && e.type !== kind && !(kind === 'curve' && (e.type === 'circle' || e.type === 'arc')))
      throw new SolveError(`"${id}" is a ${e.type}, expected ${kind}`);
    return e;
  };

  // Accessors read from X when the quantity is a variable, otherwise from the entity.
  const P = (id) => {
    const i = varIndex.get(`${id}.x`);
    if (i !== undefined) return [X[i], X[i + 1]];
    const e = byId.get(id);
    return [e.x, e.y];
  };
  const radius = (id) => {
    const e = byId.get(id);
    if (e.type === 'circle') { const i = varIndex.get(`${id}.r`); return i !== undefined ? X[i] : e.r; }
    if (e.type === 'arc') { const c = P(e.center), s = P(e.start); return Math.hypot(s[0] - c[0], s[1] - c[1]); }
    throw new SolveError(`"${id}" has no radius`);
  };
  const center = (id) => P(byId.get(id).center);
  const lineDir = (id) => { const l = byId.get(id); const a = P(l.p1), b = P(l.p2); return [b[0] - a[0], b[1] - a[1]]; };
  const lineLen = (id) => Math.hypot(...lineDir(id));

  // Tangent direction of a curve leaving the given endpoint.
  const tangentAt = (id, pid) => {
    const e = byId.get(id);
    if (e.type === 'line') { const d = lineDir(id); return e.p1 === pid ? d : [-d[0], -d[1]]; }
    if (e.type === 'arc') {
      const c = P(e.center), p = P(pid), r = [p[0] - c[0], p[1] - c[1]];
      return pid === e.start ? [-r[1], r[0]] : [r[1], -r[0]]; // arcs run CCW start→end
    }
    if (e.type === 'bezier') {
      const a = pid === e.p0 ? P(e.p0) : P(e.p1), b = pid === e.p0 ? P(e.c1) : P(e.c2);
      return [b[0] - a[0], b[1] - a[1]];
    }
    throw new SolveError(`"${id}" has no endpoint tangent`);
  };

  // Union-find of coincident points so tangency etc. can detect shared endpoints.
  const parent = new Map();
  const find = (a) => { while (parent.has(a) && parent.get(a) !== a) a = parent.get(a); return a; };
  for (const c of constraints) if (c.type === 'coincident') parent.set(find(c.a), find(c.b));
  const sharedEnd = (a, b) => {
    for (const pa of entityEnds(byId.get(a))) for (const pb of entityEnds(byId.get(b)))
      if (find(pa) === find(pb)) return [pa, pb];
    return null;
  };

  const entityFn = (f, ids) => {
    switch (f) {
      case 'len': return lineLen(ids[0]);
      case 'dist': { const a = P(ids[0]), b = P(ids[1]); return Math.hypot(a[0] - b[0], a[1] - b[1]); }
      case 'x': return P(ids[0])[0];
      case 'y': return P(ids[0])[1];
      case 'r': return radius(ids[0]);
      case 'angle': { const d = lineDir(ids[0]); return Math.atan2(d[1], d[0]) / D2R; }
    }
    throw new SolveError(`Unknown function ${f}`);
  };

  // ---- residual builders: each returns {id, n, deps:[varIdx], f: () => number[]} ----
  const depsOf = (ids) => {
    const out = new Set();
    const addPt = (pid) => {
      const i = varIndex.get(`${pid}.x`);
      if (i !== undefined) { out.add(i); out.add(i + 1); }
    };
    for (const id of ids) {
      const e = byId.get(id);
      if (!e) continue;
      for (const pid of entityPoints(e)) addPt(pid);
      const ri = varIndex.get(`${id}.r`);
      if (ri !== undefined) out.add(ri);
    }
    return [...out];
  };

  const eqs = [];
  const add = (id, ids, f, n = 1, weight = 1) => eqs.push({ id, deps: depsOf(ids), f, n, weight });

  // Implicit: arc endpoints equidistant from centre.
  for (const e of entities) {
    if (e.type !== 'arc') continue;
    add(`${e.id}#radius`, [e.id], () => {
      const c = P(e.center), s = P(e.start), t = P(e.end);
      return [Math.hypot(s[0] - c[0], s[1] - c[1]) - Math.hypot(t[0] - c[0], t[1] - c[1])];
    });
  }

  const refValues = {}; // reference (non-driving) dimension values for display
  for (const c of constraints) {
    try {
      buildConstraint(c);
    } catch (err) {
      errors.push({ id: c.id, message: err.message });
    }
  }

  function val(c) {
    const v = valueOf(c.value);
    if (!Number.isFinite(v)) throw new SolveError(`Constraint ${c.id || c.type}: value "${c.value}" is not a number`);
    return v;
  }

  function buildConstraint(c) {
    const id = c.id || c.type;
    if (c.driving === false) return; // reference dimension — measured after solve
    switch (c.type) {
      case 'coincident':
        get(c.a, 'point'); get(c.b, 'point');
        return add(id, [c.a, c.b], () => { const a = P(c.a), b = P(c.b); return [a[0] - b[0], a[1] - b[1]]; }, 2);
      case 'fix': {
        const e = get(c.point, 'point');
        const tx = c.x !== undefined ? valueOf(c.x) : e.x, ty = c.y !== undefined ? valueOf(c.y) : e.y;
        return add(id, [c.point], () => { const p = P(c.point); return [p[0] - tx, p[1] - ty]; }, 2);
      }
      case 'horizontal':
      case 'vertical': {
        const k = c.type === 'horizontal' ? 1 : 0;
        if (c.line) {
          const l = get(c.line, 'line');
          return add(id, [c.line], () => [P(l.p2)[k] - P(l.p1)[k]]);
        }
        return add(id, [c.a, c.b], () => [P(c.b)[k] - P(c.a)[k]]);
      }
      case 'parallel':
        get(c.a, 'line'); get(c.b, 'line');
        return add(id, [c.a, c.b], () => {
          const a = lineDir(c.a), b = lineDir(c.b);
          return [(a[0] * b[1] - a[1] * b[0]) / (Math.hypot(...a) * Math.hypot(...b) + 1e-12)];
        });
      case 'perpendicular':
        get(c.a, 'line'); get(c.b, 'line');
        return add(id, [c.a, c.b], () => {
          const a = lineDir(c.a), b = lineDir(c.b);
          return [(a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b) + 1e-12)];
        });
      case 'collinear': {
        const la = get(c.a, 'line'), lb = get(c.b, 'line');
        return add(id, [c.a, c.b], () => {
          const a1 = P(la.p1), d = lineDir(c.a), L = Math.hypot(...d) + 1e-12;
          const r = (p) => (d[0] * (p[1] - a1[1]) - d[1] * (p[0] - a1[0])) / L;
          return [r(P(lb.p1)), r(P(lb.p2))];
        }, 2);
      }
      case 'pointOnLine': {
        const l = get(c.line, 'line'); get(c.point, 'point');
        return add(id, [c.point, c.line], () => {
          const a = P(l.p1), d = lineDir(c.line), p = P(c.point);
          return [(d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0])) / (Math.hypot(...d) + 1e-12)];
        });
      }
      case 'pointOnCircle': {
        get(c.point, 'point'); get(c.circle, 'curve');
        return add(id, [c.point, c.circle], () => {
          const p = P(c.point), o = center(c.circle);
          return [Math.hypot(p[0] - o[0], p[1] - o[1]) - radius(c.circle)];
        });
      }
      case 'midpoint': {
        const l = get(c.line, 'line'); get(c.point, 'point');
        return add(id, [c.point, c.line], () => {
          const a = P(l.p1), b = P(l.p2), p = P(c.point);
          return [p[0] - (a[0] + b[0]) / 2, p[1] - (a[1] + b[1]) / 2];
        }, 2);
      }
      case 'symmetric': {
        const l = get(c.line, 'line'); get(c.a, 'point'); get(c.b, 'point');
        return add(id, [c.a, c.b, c.line], () => {
          const a = P(c.a), b = P(c.b), o = P(l.p1), d = lineDir(c.line), L = Math.hypot(...d) + 1e-12;
          const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ab = [b[0] - a[0], b[1] - a[1]];
          return [(d[0] * (m[1] - o[1]) - d[1] * (m[0] - o[0])) / L, (ab[0] * d[0] + ab[1] * d[1]) / L];
        }, 2);
      }
      case 'equal': {
        const ea = get(c.a), eb = get(c.b);
        if (ea.type === 'line' && eb.type === 'line') return add(id, [c.a, c.b], () => [lineLen(c.a) - lineLen(c.b)]);
        return add(id, [c.a, c.b], () => [radius(c.a) - radius(c.b)]);
      }
      case 'concentric':
        get(c.a, 'curve'); get(c.b, 'curve');
        return add(id, [c.a, c.b], () => { const a = center(c.a), b = center(c.b); return [a[0] - b[0], a[1] - b[1]]; }, 2);
      case 'tangent': {
        const ea = get(c.a), eb = get(c.b);
        const shared = sharedEnd(c.a, c.b);
        if (shared) {
          // G1 at a shared endpoint: tangent directions parallel.
          return add(id, [c.a, c.b], () => {
            const ta = tangentAt(c.a, shared[0]), tb = tangentAt(c.b, shared[1]);
            return [(ta[0] * tb[1] - ta[1] * tb[0]) / (Math.hypot(...ta) * Math.hypot(...tb) + 1e-12)];
          });
        }
        const isRound = (e) => e.type === 'circle' || e.type === 'arc';
        if (ea.type === 'line' && isRound(eb) || eb.type === 'line' && isRound(ea)) {
          const [ln, cr] = ea.type === 'line' ? [c.a, c.b] : [c.b, c.a];
          const l = byId.get(ln);
          return add(id, [ln, cr], () => {
            const a = P(l.p1), d = lineDir(ln), o = center(cr);
            const dd = Math.abs(d[0] * (o[1] - a[1]) - d[1] * (o[0] - a[0])) / (Math.hypot(...d) + 1e-12);
            return [dd - radius(cr)];
          });
        }
        if (isRound(ea) && isRound(eb)) {
          const o1 = center(c.a), o2 = center(c.b), r1 = radius(c.a), r2 = radius(c.b);
          const d0 = Math.hypot(o1[0] - o2[0], o1[1] - o2[1]);
          const internal = c.internal ?? Math.abs(d0 - Math.abs(r1 - r2)) < Math.abs(d0 - (r1 + r2));
          return add(id, [c.a, c.b], () => {
            const p = center(c.a), q = center(c.b), d = Math.hypot(p[0] - q[0], p[1] - q[1]);
            return [internal ? d - Math.abs(radius(c.a) - radius(c.b)) : d - radius(c.a) - radius(c.b)];
          });
        }
        throw new SolveError(`tangent needs line/circle/arc, or curves sharing an endpoint`);
      }
      case 'distance': {
        const v = val(c);
        const ea = get(c.a), eb = get(c.b);
        if (ea.type === 'point' && eb.type === 'point')
          return add(id, [c.a, c.b], () => { const a = P(c.a), b = P(c.b); return [Math.hypot(a[0] - b[0], a[1] - b[1]) - v]; });
        const [pt, ln] = ea.type === 'point' ? [c.a, c.b] : [c.b, c.a];
        const l = get(ln, 'line');
        return add(id, [pt, ln], () => {
          const a = P(l.p1), d = lineDir(ln), p = P(pt);
          return [Math.abs(d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0])) / (Math.hypot(...d) + 1e-12) - v];
        });
      }
      case 'distanceX':
      case 'distanceY': {
        const v = val(c), k = c.type === 'distanceX' ? 0 : 1;
        // Signed: b - a = value. A line may be given instead of two points.
        let a = c.a, b = c.b;
        if (c.line) { const l = get(c.line, 'line'); a = l.p1; b = l.p2; }
        get(a, 'point'); get(b, 'point');
        return add(id, [a, b], () => [P(b)[k] - P(a)[k] - v]);
      }
      case 'length': {
        const v = val(c); get(c.line, 'line');
        return add(id, [c.line], () => [lineLen(c.line) - v]);
      }
      case 'radius':
      case 'diameter': {
        const v = val(c) / (c.type === 'diameter' ? 2 : 1);
        get(c.circle, 'curve');
        return add(id, [c.circle], () => [radius(c.circle) - v]);
      }
      case 'angle': {
        const v = val(c) * D2R;
        get(c.a, 'line');
        if (!c.b) // absolute angle of a line, measured CCW from the +u axis
          return add(id, [c.a], () => { const d = lineDir(c.a); return [wrapAngle(Math.atan2(d[1], d[0]) - v)]; });
        get(c.b, 'line');
        return add(id, [c.a, c.b], () => {
          const a = lineDir(c.a), b = lineDir(c.b);
          return [wrapAngle(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) - v)];
        });
      }
      case 'equation': {
        const [lhs, rhs] = String(c.expr).split('=');
        if (rhs === undefined) throw new SolveError(`equation "${c.expr}" needs "="`);
        const la = parseCached(lhs), ra = parseCached(rhs);
        const ids = [...entityRefs(la), ...entityRefs(ra)];
        ids.forEach((i) => get(i));
        const scope = (n) => valueOf(n);
        return add(id, ids, () => [evalAst(la, scope, entityFn) - evalAst(ra, scope, entityFn)]);
      }
      default:
        throw new SolveError(`Unknown constraint type "${c.type}"`);
    }
  }

  // Drag: soft-ish target for one point (solved first, then released and re-solved).
  const dragEq = opts.drag && varIndex.has(`${opts.drag.point}.x`) ? {
    id: '#drag', deps: depsOf([opts.drag.point]), n: 2, weight: 1e-2,
    f: () => { const p = P(opts.drag.point); return [p[0] - opts.drag.to[0], p[1] - opts.drag.to[1]]; },
  } : null;

  const m = eqs.reduce((s, q) => s + q.n, 0);
  const n = X.length;

  const residualVec = (list) => {
    const r = [];
    for (const q of list) for (const v of q.f()) r.push(v * q.weight);
    return r;
  };
  const norm2 = (r) => r.reduce((s, v) => s + v * v, 0);

  function jacobian(list, rows) {
    const J = Array.from({ length: rows }, () => new Float64Array(n));
    let row = 0;
    for (const q of list) {
      for (const j of q.deps) {
        const h = 1e-7 * Math.max(1, Math.abs(X[j]));
        const x0 = X[j];
        X[j] = x0 + h; const rp = q.f();
        X[j] = x0 - h; const rm = q.f();
        X[j] = x0;
        for (let k = 0; k < q.n; k++) J[row + k][j] = (rp[k] - rm[k]) / (2 * h) * q.weight;
      }
      row += q.n;
    }
    return J;
  }

  function lm(list, maxIter = opts.maxIter || 200) {
    const rows = list.reduce((s, q) => s + q.n, 0);
    let r = residualVec(list), f = norm2(r), lambda = 1e-6, it = 0;
    for (; it < maxIter && f > 1e-22 && n > 0; it++) {
      const J = jacobian(list, rows);
      // Normal equations A = JᵀJ + λI, g = Jᵀr
      const A = Array.from({ length: n }, () => new Float64Array(n));
      const g = new Float64Array(n);
      for (let i = 0; i < rows; i++) {
        const Ji = J[i], ri = r[i];
        const nz = [];
        for (let j = 0; j < n; j++) if (Ji[j] !== 0) nz.push(j);
        for (const a of nz) {
          g[a] += Ji[a] * ri;
          for (const b of nz) A[a][b] += Ji[a] * Ji[b];
        }
      }
      let improved = false;
      for (let tries = 0; tries < 12; tries++) {
        const M = A.map((row) => Float64Array.from(row));
        for (let i = 0; i < n; i++) M[i][i] += lambda;
        const d = choleskySolve(M, g);
        if (!d) { lambda *= 10; continue; }
        const X0 = X.slice();
        for (let i = 0; i < n; i++) X[i] -= d[i];
        const r2 = residualVec(list), f2 = norm2(r2);
        if (f2 < f) { r = r2; f = f2; lambda = Math.max(lambda / 10, 1e-10); improved = true; break; }
        for (let i = 0; i < n; i++) X[i] = X0[i];
        lambda *= 10;
      }
      if (!improved) break;
    }
    return { f, it };
  }

  let iterations = 0;
  if (dragEq) iterations += lm([...eqs, dragEq], 60).it;
  const { f, it } = lm(eqs);
  iterations += it;

  // Write solution back.
  vars.forEach((v, i) => { v.e[v.key] = X[i]; });

  // Residual report.
  const residuals = [];
  let maxResidual = 0;
  for (const q of eqs) {
    const r = Math.max(...q.f().map(Math.abs));
    maxResidual = Math.max(maxResidual, r);
    if (r > 1e-6) residuals.push({ id: q.id, r });
  }

  // Reference dimensions: measure.
  for (const c of constraints) {
    if (c.driving !== false) continue;
    try { refValues[c.id] = measureConstraint(c); } catch { /* ignore */ }
  }
  function measureConstraint(c) {
    switch (c.type) {
      case 'distance': {
        const ea = byId.get(c.a), eb = byId.get(c.b);
        if (ea.type === 'point' && eb.type === 'point') return entityFn('dist', [c.a, c.b]);
        const [pt, ln] = ea.type === 'point' ? [c.a, c.b] : [c.b, c.a];
        const l = byId.get(ln), a = P(l.p1), d = lineDir(ln), p = P(pt);
        return Math.abs(d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0])) / Math.hypot(...d);
      }
      case 'distanceX': case 'distanceY': {
        const k = c.type === 'distanceX' ? 0 : 1;
        let a = c.a, b = c.b;
        if (c.line) { const l = byId.get(c.line); a = l.p1; b = l.p2; }
        return P(b)[k] - P(a)[k];
      }
      case 'length': return lineLen(c.line);
      case 'radius': return radius(c.circle);
      case 'diameter': return 2 * radius(c.circle);
      case 'angle': {
        const a = lineDir(c.a);
        if (!c.b) return Math.atan2(a[1], a[0]) / D2R;
        const b = lineDir(c.b);
        return Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) / D2R;
      }
    }
    return NaN;
  }

  // DOF analysis: rank of the Jacobian and which variables lie in its null space.
  let dof = n, freeVars = new Set(vars.map((_, i) => i));
  if (n > 0 && m > 0) {
    const J = jacobian(eqs, m);
    const res = nullSpace(J, n);
    dof = res.basis.length;
    freeVars = new Set();
    for (const v of res.basis) v.forEach((x, i) => { if (Math.abs(x) > 1e-7) freeVars.add(i); });
  }
  const freePoints = new Set();
  const freeRadii = new Set();
  freeVars.forEach((i) => (vars[i].key === 'r' ? freeRadii : freePoints).add(vars[i].e.id));

  const ok = maxResidual < 1e-6 && errors.length === 0;
  return {
    ok, maxResidual, residual: Math.sqrt(f), dof, freePoints, freeRadii, residuals, errors,
    iterations, refValues, equations: m, unknowns: n,
  };
}

function choleskySolve(A, b) {
  const n = b.length;
  const L = A; // in place
  for (let j = 0; j < n; j++) {
    let s = L[j][j];
    for (let k = 0; k < j; k++) s -= L[j][k] * L[j][k];
    if (s <= 1e-300) return null;
    const d = Math.sqrt(s);
    L[j][j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = L[i][j];
      for (let k = 0; k < j; k++) t -= L[i][k] * L[j][k];
      L[i][j] = t / d;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let t = b[i];
    for (let k = 0; k < i; k++) t -= L[i][k] * y[k];
    y[i] = t / L[i][i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let t = y[i];
    for (let k = i + 1; k < n; k++) t -= L[k][i] * x[k];
    x[i] = t / L[i][i];
  }
  return x;
}

// Null space of an m×n matrix via reduced row echelon form with partial pivoting.
function nullSpace(Jrows, n) {
  const M = Jrows.map((r) => Float64Array.from(r));
  const m = M.length;
  let scaleMax = 0;
  for (const r of M) for (const v of r) scaleMax = Math.max(scaleMax, Math.abs(v));
  const tol = 1e-8 * Math.max(1, scaleMax);
  const pivCols = [];
  let row = 0;
  for (let col = 0; col < n && row < m; col++) {
    let best = row, bv = Math.abs(M[row][col]);
    for (let i = row + 1; i < m; i++) if (Math.abs(M[i][col]) > bv) { bv = Math.abs(M[i][col]); best = i; }
    if (bv < tol) continue;
    [M[row], M[best]] = [M[best], M[row]];
    const pv = M[row][col];
    for (let j = col; j < n; j++) M[row][j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === row) continue;
      const f = M[i][col];
      if (f !== 0) for (let j = col; j < n; j++) M[i][j] -= f * M[row][j];
    }
    pivCols.push(col);
    row++;
  }
  const isPiv = new Set(pivCols);
  const basis = [];
  for (let f = 0; f < n; f++) {
    if (isPiv.has(f)) continue;
    const v = new Float64Array(n);
    v[f] = 1;
    pivCols.forEach((pc, r) => { v[pc] = -M[r][f]; });
    basis.push(v);
  }
  return { rank: pivCols.length, basis };
}
