// The parametric rebuild: evaluates a CAD document (parameters + ordered feature timeline)
// into solid bodies using the manifold kernel. Pure logic — runs in Node and in the browser.

import Module from 'manifold-3d';
import { evaluate, evaluateParams } from './expr.js';
import {
  STD_PLANES, frameFromNormal, frameMatrix, toWorld, toLocal, add, sub, scale, dot, cross, norm, len,
  rotateAxis, D2R, mul, translation, rotation, rotationAbout, mirrorMatrix, eulerDeg, identity, applyPoint,
} from './vec.js';
import { evaluateSketch, DEFAULT_TOLERANCE } from './sketch.js';
import { sweepAlongPath, sweepHelix, loftSections } from './sweep.js';
import { topology, edgeChains, selectChains, edgeBlend, shellSolid, faceNear } from './edges.js';

let wasmPromise = null;
export function initKernel() {
  if (!wasmPromise) wasmPromise = Module().then((w) => { w.setup(); return w; });
  return wasmPromise;
}

export const BODY_COLORS = ['#8aa4c8', '#c8a36a', '#86b38a', '#c27d7d', '#9b8cc4', '#7fb7b7', '#c9b458', '#b08a6e'];

export const FEATURE_TYPES = ['plane', 'sketch', 'extrude', 'revolve', 'sweep', 'loft', 'primitive', 'fillet', 'chamfer', 'shell', 'pattern', 'mirror', 'transform', 'boolean', 'split', 'delete'];

// ---- result object ---------------------------------------------------------------------------

class BuildResult {
  constructor() {
    this.params = {};
    this.paramErrors = {};
    this.frames = new Map();   // plane/sketch id -> frame
    this.sketches = new Map(); // sketch id -> SketchResult
    this.bodies = new Map();   // body id -> {id, name, manifold, color, feature}
    this.features = new Map(); // feature id -> {ok, error, warnings, tool?}
    this.errors = [];
    this._arena = [];
  }
  dispose() {
    for (const o of this._arena) try { o.delete(); } catch { /* already freed */ }
    for (const b of this.bodies.values()) try { b.manifold.delete(); } catch { /* */ }
    this._arena = [];
    this.bodies.clear();
  }
  get ok() { return this.errors.length === 0; }
}

// ---- main entry ------------------------------------------------------------------------------

/**
 * Rebuild a document. The document's sketches are updated in place with solved positions.
 * @returns BuildResult (call dispose() when done to free WASM memory)
 */
export async function rebuild(doc, opts = {}) {
  const wasm = await initKernel();
  return rebuildSync(wasm, doc, opts);
}

export function rebuildSync(wasm, doc, opts = {}) {
  const { Manifold, CrossSection } = wasm;
  const R = new BuildResult();
  const track = (o) => { R._arena.push(o); return o; };
  const tol = opts.tolerance || doc.settings?.tolerance || DEFAULT_TOLERANCE;
  R.tolerance = tol;

  const { values, errors } = evaluateParams(doc.params || {});
  R.params = values;
  R.paramErrors = errors;
  for (const [k, msg] of Object.entries(errors)) R.errors.push({ id: `param:${k}`, message: msg });
  const valueOf = (v) => evaluate(v, (n) => values[n]);
  const num = (v, what) => {
    const x = valueOf(v);
    if (!Number.isFinite(x)) throw new Error(`${what}: "${v}" is not a finite number`);
    return x;
  };
  const vec3 = (v, what) => {
    if (!Array.isArray(v) || v.length !== 3) throw new Error(`${what} must be [x, y, z]`);
    return v.map((c, i) => num(c, `${what}[${i}]`));
  };

  // Body bookkeeping
  let lastBody = null;
  let colorIdx = 0;
  const bodyMeta = doc.bodies || {};
  const setBody = (id, manifold, feature) => {
    const prev = R.bodies.get(id);
    if (prev) { track(prev.manifold); prev.manifold = manifold; prev.feature = feature; }
    else {
      const meta = bodyMeta[id] || {};
      R.bodies.set(id, {
        id, name: meta.name || id, manifold, feature,
        color: meta.color || BODY_COLORS[colorIdx++ % BODY_COLORS.length],
        visible: meta.visible !== false,
      });
    }
    lastBody = id;
  };
  const bodyOf = (id) => {
    const b = R.bodies.get(id);
    if (!b) throw new Error(`No body "${id}" (bodies: ${[...R.bodies.keys()].join(', ') || 'none'})`);
    return b;
  };
  const targetsFor = (f, mode) => {
    if (f.target) return (Array.isArray(f.target) ? f.target : [f.target]).map((t) => bodyOf(t).id);
    if (mode === 'cut') return [...R.bodies.keys()];
    return lastBody ? [lastBody] : [];
  };

  let warnings = []; // per-feature warnings collected by helpers
  // Apply a tool solid with a boolean mode.
  const applyTool = (f, tool, modeOverride) => {
    const mode = modeOverride || f.mode || 'new';
    if (tool.isEmpty()) throw new Error('Feature produced an empty solid');
    if (mode === 'new') {
      const id = f.body || f.id;
      if (R.bodies.has(id)) setBody(id, track(R.bodies.get(id).manifold.add(tool)), f.id);
      else setBody(id, tool, f.id);
      return [id];
    }
    const targets = targetsFor(f, mode);
    if (!targets.length) {
      if (mode === 'add') { setBody(f.body || f.id, tool, f.id); return [f.body || f.id]; }
      throw new Error(`"${mode}" needs an existing body`);
    }
    let removed = 0;
    for (const t of targets) {
      const b = bodyOf(t);
      const m = mode === 'add' ? b.manifold.add(tool) : mode === 'cut' ? b.manifold.subtract(tool)
        : mode === 'intersect' ? b.manifold.intersect(tool) : null;
      if (!m) throw new Error(`Unknown mode "${mode}" (new | add | cut | intersect)`);
      const v0 = b.manifold.volume(), v1 = m.volume();
      if (mode === 'cut') removed += v0 - v1;
      if (mode === 'add' && Math.abs(v1 - (v0 + tool.volume())) < 1e-6 * Math.max(1, v1) && solidCount(m) > solidCount(b.manifold)) {
        warnings.push(`Joined solid does not touch body "${t}" — the body now has separate pieces`);
      }
      track(b.manifold);
      b.manifold = m;
      b.feature = f.id;
      if (mode !== 'cut') lastBody = t;
    }
    if (mode === 'cut' && removed < 1e-9) warnings.push('Cut removed no material — check the direction (try reverse or a negative distance)');
    return targets;
  };

  // ---- planes ----
  const resolvePlane = (ref, ctx = 'plane') => {
    if (ref === undefined || ref === null) ref = 'XY';
    if (typeof ref === 'string') {
      const key = ref.replace(/^-/, '');
      let f = STD_PLANES[key.toUpperCase()] || R.frames.get(key);
      if (!f) throw new Error(`${ctx}: unknown plane "${ref}"`);
      f = { ...f };
      if (ref.startsWith('-')) f = { o: f.o, x: f.x, y: scale(f.y, -1), n: scale(f.n, -1) };
      return f;
    }
    return planeFromSpec(ref, ctx);
  };

  function planeFromSpec(s, ctx) {
    let f;
    if (s.face) {
      const b = bodyOf(s.face.body);
      // The face is found from a point on it; the sketch origin is the projection of the world
      // origin onto that plane, so sketch (u, v) line up with world coordinates where possible.
      const hit = closestFace(b.manifold, vec3(s.face.point, `${ctx}.face.point`));
      f = frameFromNormal(scale(hit.normal, dot(hit.point, hit.normal)), hit.normal, s.xDir ? vec3(s.xDir, 'xDir') : undefined);
    } else if (s.points) {
      const [a, b, c] = s.points.map((p, i) => vec3(p, `${ctx}.points[${i}]`));
      const n = cross(sub(b, a), sub(c, a));
      if (len(n) < 1e-12) throw new Error(`${ctx}: the three points are collinear`);
      f = frameFromNormal(a, n, sub(b, a));
    } else if (s.normal) {
      f = frameFromNormal(s.origin ? vec3(s.origin, 'origin') : [0, 0, 0], vec3(s.normal, 'normal'), s.xDir ? vec3(s.xDir, 'xDir') : undefined);
    } else {
      f = resolvePlane(s.base || 'XY', ctx);
      if (s.origin) f = { ...f, o: vec3(s.origin, `${ctx}.origin`) };
    }
    if (s.shift) { const [du, dv] = s.shift.map((v) => num(v, 'shift')); f = { ...f, o: toWorld(f, [du, dv]) }; }
    for (const r of normalizeRotations(s.rotate)) {
      const a = num(r.angle, 'rotate.angle') * D2R;
      const axis = r.axis === 'x' || r.axis === 'u' ? f.x : r.axis === 'y' || r.axis === 'v' ? f.y : f.n;
      f = { o: f.o, x: rotateAxis(f.x, axis, a), y: rotateAxis(f.y, axis, a), n: rotateAxis(f.n, axis, a) };
    }
    if (s.offset !== undefined) f = { ...f, o: add(f.o, scale(f.n, num(s.offset, 'offset'))) };
    if (s.flip) f = { o: f.o, x: f.x, y: scale(f.y, -1), n: scale(f.n, -1) };
    return f;
  }

  // ---- axes / directions in world space ----
  const resolveAxis = (spec, ctx) => {
    if (typeof spec === 'string') {
      const ax = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[spec.toLowerCase()];
      if (ax) return { o: [0, 0, 0], d: ax };
      throw new Error(`${ctx}: unknown axis "${spec}"`);
    }
    if (Array.isArray(spec)) return { o: [0, 0, 0], d: norm(vec3(spec, ctx)) };
    if (spec?.sketch && spec.line) {
      const sk = sketchOf(spec.sketch);
      const { a, b } = sk.lineWorld(spec.line);
      return { o: a, d: norm(sub(b, a)) };
    }
    if (spec?.sketch && spec.axis) {
      const fr = sketchOf(spec.sketch).frame;
      return { o: fr.o, d: { u: fr.x, x: fr.x, v: fr.y, y: fr.y, n: fr.n, normal: fr.n }[spec.axis] };
    }
    if (spec?.plane) { const fr = resolvePlane(spec.plane, ctx); return { o: fr.o, d: fr.n }; }
    if (spec?.dir || spec?.direction) return { o: spec.origin ? vec3(spec.origin, `${ctx}.origin`) : [0, 0, 0], d: norm(vec3(spec.dir || spec.direction, `${ctx}.dir`)) };
    throw new Error(`${ctx}: cannot interpret axis ${JSON.stringify(spec)}`);
  };

  const sketchOf = (id) => {
    const s = R.sketches.get(id);
    if (!s) throw new Error(`No sketch "${id}" before this feature`);
    return s;
  };

  const profileOf = (f) => {
    const sk = sketchOf(f.sketch);
    const cs = sk.profile(f.profile, track, valueOf);
    if (cs.isEmpty() || cs.area() < 1e-12) throw new Error(`Profile of sketch "${f.sketch}" is empty`);
    return { sk, cs };
  };

  const bigExtent = () => {
    let r = 100;
    for (const b of R.bodies.values()) {
      const bb = b.manifold.boundingBox();
      r = Math.max(r, ...bb.min.map(Math.abs), ...bb.max.map(Math.abs));
    }
    return r * 4;
  };

  const circleSegs = (r, sweepDeg = 360) => {
    const step = r > tol ? 2 * Math.acos(1 - tol / r) : Math.PI / 4;
    const n = Math.ceil((2 * Math.PI) / Math.min(step, Math.PI / 8));
    return Math.max(16, Math.min(720, Math.ceil(n / 4) * 4));
  };

  // ---- features ----
  const handlers = {
    plane(f) {
      R.frames.set(f.id, planeFromSpec(f, `plane ${f.id}`));
    },

    sketch(f) {
      const frame = resolvePlane(f.plane, `sketch ${f.id}`);
      R.frames.set(f.id, frame);
      validateSketch(f);
      const res = evaluateSketch(f, frame, valueOf, wasm, { tolerance: tol, drag: opts.drag?.sketch === f.id ? opts.drag : undefined });
      R.sketches.set(f.id, res);
      const st = res.solve;
      const out = { warnings: [] };
      if (st.errors.length) throw new Error(st.errors.map((e) => `${e.id || ''}: ${e.message}`).join('; '));
      if (!st.ok) out.warnings.push(`Constraints not satisfied (max residual ${st.maxResidual.toExponential(2)}) — conflicting: ${st.residuals.map((r) => r.id).join(', ')}`);
      return out;
    },

    extrude(f) {
      const { sk, cs } = profileOf(f);
      const frame = sk.frame;
      // Direction in sketch-local coordinates
      let dl = [0, 0, 1];
      const dir = f.direction;
      if (dir && dir !== 'normal') {
        let dw;
        if (dir.tilt) {
          const [tx, ty] = dir.tilt.map((v) => num(v, 'tilt') * D2R);
          dl = norm([Math.sin(ty), -Math.sin(tx) * Math.cos(ty), Math.cos(tx) * Math.cos(ty)]);
        } else {
          dw = resolveAxis(dir, `extrude ${f.id} direction`).d;
          dl = [dot(dw, frame.x), dot(dw, frame.y), dot(dw, frame.n)];
        }
      }
      if (Math.abs(dl[2]) < 1e-6) throw new Error('Extrude direction is parallel to the sketch plane');
      // Travel range [t0, t1] along the direction. distance may be negative (other side);
      // distance2 extends the opposite way; symmetric centres the extrusion on the plane.
      let t0, t1;
      const through = (v) => v === 'through' || v === 'all';
      const amount = (v, what) => (through(v) ? bigExtent() : num(v, what));
      if (f.symmetric) {
        const d = amount(f.distance, 'distance');
        t0 = -d / 2; t1 = d / 2;
      } else {
        const d1 = amount(f.distance, 'distance') * (f.reverse ? -1 : 1);
        const d2 = f.distance2 === undefined ? 0 : amount(f.distance2, 'distance2');
        if (d1 >= 0) { t0 = -d2; t1 = d1; } else { t0 = d1; t1 = d2; }
      }
      const start = f.offset !== undefined ? num(f.offset, 'offset') : 0;
      t0 += start; t1 += start;
      if (t1 - t0 < 1e-9) throw new Error('Extrude distance is zero');
      const zA = Math.min(t0 * dl[2], t1 * dl[2]), zB = Math.max(t0 * dl[2], t1 * dl[2]);
      const twist = f.twist !== undefined ? num(f.twist, 'twist') : 0;
      // (manifold misreads a scalar scaleTop — always pass [sx, sy])
      const st = f.scaleTop !== undefined ? f.scaleTop : 1;
      const scaleTop = Array.isArray(st) ? st.map((v) => num(v, 'scaleTop')) : [num(st, 'scaleTop'), num(st, 'scaleTop')];
      const divisions = twist ? Math.max(8, Math.ceil(Math.abs(twist) / 3)) : 0;
      let m = track(cs.extrude(zB - zA, divisions, twist, scaleTop)).translate([0, 0, zA]);
      track(m);
      const shear = [1, 0, 0, 0, 0, 1, 0, 0, dl[0] / dl[2], dl[1] / dl[2], 1, 0, 0, 0, 0, 1];
      const M = mul(frameMatrix(frame), shear);
      const tool = track(m.transform(M));
      return { tool, targets: applyTool(f, tool) };
    },

    revolve(f) {
      const { sk, cs } = profileOf(f);
      const frame = sk.frame;
      let a2, d2;
      const ax = f.axis ?? 'v';
      if (typeof ax === 'string' && ['u', 'x'].includes(ax)) { a2 = [0, 0]; d2 = [1, 0]; }
      else if (typeof ax === 'string' && ['v', 'y'].includes(ax)) { a2 = [0, 0]; d2 = [0, 1]; }
      else if (typeof ax === 'string') { const l = sk.lineWorld(ax); a2 = l.a2; d2 = norm(sub(l.b2, l.a2)); }
      else if (ax.point2d || ax.point && ax.point.length === 2) { a2 = (ax.point2d || ax.point).map((v) => num(v, 'axis.point')); d2 = norm((ax.dir2d || ax.dir).map((v) => num(v, 'axis.dir'))); }
      else {
        const w = resolveAxis(ax, `revolve ${f.id} axis`);
        const lo = toLocal(frame, w.o), ld = [dot(w.d, frame.x), dot(w.d, frame.y), dot(w.d, frame.n)];
        if (Math.abs(ld[2]) > 1e-6 || Math.abs(lo[2]) > 1e-6) throw new Error('Revolve axis must lie in the sketch plane');
        a2 = [lo[0], lo[1]]; d2 = norm([ld[0], ld[1]]);
      }
      let e2 = [d2[1], -d2[0]];
      const toAxis = (e) => [e[0], d2[0], 0, e[1], d2[1], 0, -(e[0] * a2[0] + e[1] * a2[1]), -(d2[0] * a2[0] + d2[1] * a2[1]), 1];
      let local = track(cs.transform(toAxis(e2)));
      const bb = local.bounds();
      const warnings = [];
      if (bb.max[0] <= 1e-9) { e2 = [-e2[0], -e2[1]]; local = track(cs.transform(toAxis(e2))); }
      else if (bb.min[0] < -1e-9) warnings.push('Profile crosses the revolve axis — only the part on one side is used');
      const angle = f.angle !== undefined ? num(f.angle, 'angle') : 360;
      if (Math.abs(angle) < 1e-9) throw new Error('Revolve angle is zero');
      const rmax = Math.max(Math.abs(local.bounds().max[0]), 1e-3);
      const segs = circleSegs(rmax);
      let m = track(local.revolve(segs, Math.min(360, Math.abs(angle))));
      let pre = identity();
      if (f.symmetric) pre = rotation([0, 0, 1], -Math.abs(angle) / 2 * D2R);
      else if (angle < 0) pre = rotation([0, 0, 1], angle * D2R);
      const ew = add(scale(frame.x, e2[0]), scale(frame.y, e2[1]));
      const dw = add(scale(frame.x, d2[0]), scale(frame.y, d2[1]));
      const yw = cross(dw, ew);
      const aw = toWorld(frame, a2);
      const M = mul([...ew, 0, ...yw, 0, ...dw, 0, ...aw, 1], pre);
      const tool = track(m.transform(M));
      return { tool, targets: applyTool(f, tool), warnings };
    },

    sweep(f) {
      const { sk, cs } = profileOf(f);
      const polys = cs.toPolygons();
      const p = f.path || {};
      let tool;
      if (p.helix) {
        const h = p.helix;
        const axis = h.axis ? resolveAxis(h.axis, 'helix.axis') : { o: [0, 0, 0], d: [0, 0, 1] };
        const origin = h.origin ? vec3(h.origin, 'helix.origin') : axis.o;
        tool = sweepHelix(wasm, polys, sk.frame, {
          origin, axis: axis.d, pitch: num(h.pitch, 'helix.pitch'),
          turns: h.turns !== undefined ? num(h.turns, 'helix.turns') : undefined,
          height: h.height !== undefined ? num(h.height, 'helix.height') : undefined,
          leftHanded: !!h.leftHanded,
        }, tol);
      } else if (p.points) {
        tool = sweepAlongPath(wasm, polys, sk.frame, { points: p.points.map((q, i) => vec3(q, `path.points[${i}]`)), closed: !!p.closed });
      } else if (p.sketch) {
        // Start the path at the end nearest the profile.
        const path = sketchOf(p.sketch).path(p.entities);
        const bb = cs.bounds();
        const c = toWorld(sk.frame, [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2]);
        const pts = path.points;
        if (!path.closed && len(sub(pts[pts.length - 1], c)) < len(sub(pts[0], c))) pts.reverse();
        tool = sweepAlongPath(wasm, polys, sk.frame, path);
      } else throw new Error('Sweep needs path: {sketch, entities?} | {points:[...]} | {helix:{...}}');
      track(tool);
      return { tool, targets: applyTool(f, tool) };
    },

    loft(f) {
      if (!Array.isArray(f.sections) || f.sections.length < 2) throw new Error('Loft needs sections: [{sketch, profile?}, ...] (at least 2)');
      const secs = f.sections.map((s, i) => {
        const sk = sketchOf(s.sketch);
        const cs = sk.profile(s.profile, track, valueOf);
        const polys = cs.toPolygons();
        if (polys.length !== 1) throw new Error(`Loft section ${i} (sketch "${s.sketch}") must be a single closed contour without holes`);
        let poly = polys[0];
        const area = poly.reduce((acc, p, k) => { const q = poly[(k + 1) % poly.length]; return acc + p[0] * q[1] - q[0] * p[1]; }, 0);
        if (area < 0) poly = poly.slice().reverse();
        return { poly, frame: sk.frame };
      });
      const tool = track(loftSections(wasm, secs, {
        smooth: f.ruled ? false : f.smooth,
        startTangent: f.startTangent !== undefined ? num(f.startTangent, 'startTangent') : 0,
        endTangent: f.endTangent !== undefined ? num(f.endTangent, 'endTangent') : 0,
        steps: f.steps !== undefined ? Math.max(1, Math.round(num(f.steps, 'steps'))) : 16,
      }));
      return { tool, targets: applyTool(f, tool) };
    },

    primitive(f) {
      const shape = f.shape;
      let m;
      const center = !!f.center;
      if (shape === 'box') {
        const size = f.size !== undefined ? (Array.isArray(f.size) ? vec3(f.size, 'size') : Array(3).fill(num(f.size, 'size'))) : [10, 10, 10];
        m = Manifold.cube(size, center);
      } else if (shape === 'cylinder' || shape === 'cone') {
        const r = f.d !== undefined ? num(f.d, 'd') / 2 : num(f.r ?? 5, 'r');
        const r2 = f.r2 !== undefined ? num(f.r2, 'r2') : f.d2 !== undefined ? num(f.d2, 'd2') / 2 : shape === 'cone' ? 0 : r;
        m = Manifold.cylinder(num(f.h ?? 10, 'h'), r, r2, circleSegs(Math.max(r, r2)), center);
      } else if (shape === 'sphere') {
        const r = f.d !== undefined ? num(f.d, 'd') / 2 : num(f.r ?? 5, 'r');
        m = Manifold.sphere(r, circleSegs(r));
      } else if (shape === 'torus') {
        const R0 = num(f.R ?? 10, 'R'), r = num(f.r ?? 2, 'r');
        const c = track(CrossSection.circle(r, circleSegs(r)).translate([R0, 0]));
        m = c.revolve(circleSegs(R0 + r));
      } else throw new Error(`Unknown primitive shape "${shape}" (box | cylinder | cone | sphere | torus)`);
      track(m);
      let M = identity();
      if (f.rotate) M = mul(eulerDeg(vec3(f.rotate, 'rotate')), M);
      if (f.at) M = mul(translation(vec3(f.at, 'at')), M);
      const tool = track(m.transform(M));
      return { tool, targets: applyTool(f, tool) };
    },

    fillet(f) { return blend(f, 'fillet'); },
    chamfer(f) { return blend(f, 'chamfer'); },

    shell(f) {
      const b = bodyOf(f.body || lastBody);
      const t = num(f.thickness ?? 1, 'thickness');
      if (!(t > 0)) throw new Error('Shell thickness must be positive');
      const topo = topology(b.manifold);
      const openFaces = (f.open || []).map((o, i) => faceNear(topo, vec3(o.point || o, `open[${i}].point`)));
      const res = shellSolid(wasm, track, b.manifold, topo, t, { openFaces, outside: !!f.outside, segments: Math.max(12, Math.min(48, circleSegs(t) / 2)) });
      if (res.isEmpty()) throw new Error('Shell produced an empty solid (thickness too large?)');
      const cleaned = dropSlivers(res);
      track(b.manifold);
      b.manifold = cleaned;
      b.feature = f.id;
      lastBody = b.id;
      return { targets: [b.id] };
    },

    pattern(f) {
      const mats = patternMatrices(f);
      return replicate(f, mats);
    },

    mirror(f) {
      const fr = resolvePlane(f.plane || 'YZ', `mirror ${f.id}`);
      return replicate(f, [mirrorMatrix(fr.o, fr.n)]);
    },

    transform(f) {
      const ids = Array.isArray(f.body) ? f.body : [f.body];
      let M = identity();
      if (f.rotate) {
        const ax = resolveAxis(f.rotate.axis || 'z', 'rotate.axis');
        const o = f.rotate.origin ? vec3(f.rotate.origin, 'rotate.origin') : ax.o;
        M = mul(rotationAbout(o, ax.d, num(f.rotate.angle, 'rotate.angle') * D2R), M);
      }
      if (f.translate) M = mul(translation(vec3(f.translate, 'translate')), M);
      for (const id of ids) {
        const b = bodyOf(id);
        const moved = track(b.manifold.transform(M));
        if (f.copy) setBody(`${id}_${f.id}`, moved, f.id);
        else { track(b.manifold); b.manifold = moved; b.feature = f.id; }
      }
    },

    boolean(f) {
      const target = bodyOf(f.target);
      const tools = (Array.isArray(f.tools) ? f.tools : [f.tools]).map((t) => bodyOf(t));
      const op = f.op || 'union';
      let m = target.manifold;
      for (const t of tools) {
        m = track(op === 'union' ? m.add(t.manifold) : op === 'subtract' ? m.subtract(t.manifold)
          : op === 'intersect' ? m.intersect(t.manifold) : (() => { throw new Error(`Unknown op "${op}"`); })());
      }
      track(target.manifold);
      target.manifold = m;
      target.feature = f.id;
      if (!f.keepTools) for (const t of tools) { R.bodies.delete(t.id); track(t.manifold); }
      lastBody = target.id;
    },

    split(f) {
      const b = bodyOf(f.body);
      const fr = resolvePlane(f.plane, `split ${f.id}`);
      const offset = dot(fr.o, fr.n);
      const [front, back] = b.manifold.splitByPlane(fr.n, offset);
      track(front); track(back);
      const keep = f.keep || 'both';
      track(b.manifold);
      if (keep === 'front') b.manifold = front;
      else if (keep === 'back') b.manifold = back;
      else { b.manifold = front; setBody(`${b.id}_${f.id}`, back, f.id); }
      b.feature = f.id;
    },

    delete(f) {
      for (const id of f.bodies || []) { const b = bodyOf(id); track(b.manifold); R.bodies.delete(id); }
    },
  };

  function solidCount(m) {
    const parts = m.decompose();
    const total = Math.abs(m.volume());
    const n = parts.filter((p) => p.volume() > 1e-9 * Math.max(1, total)).length;
    parts.forEach((p) => p.delete());
    return n;
  }

  // Remove degenerate leftovers of booleans: zero/near-zero volume shells (slivers, fins) and
  // microscopic internal voids. decompose() splits by surface, so real cavities come back as
  // negative-volume shells: rebuild as (positive shells) − (flipped cavities).
  function dropSlivers(m) {
    const parts = m.decompose();
    if (parts.length < 2) { parts.forEach((p) => p.delete()); return m; }
    const vols = parts.map((p) => p.volume());
    const total = vols.filter((v) => v > 0).reduce((a, v) => a + v, 0);
    const thr = Math.max(1e-6 * total, 1e-12);
    const pos = parts.filter((p, i) => vols[i] > thr), neg = parts.filter((p, i) => vols[i] < -thr);
    if (pos.length + neg.length === parts.length || !pos.length) { parts.forEach((p) => p.delete()); return m; }
    parts.filter((p) => !pos.includes(p) && !neg.includes(p)).forEach((p) => p.delete());
    pos.forEach(track); neg.forEach(track);
    let res = pos.length === 1 ? pos[0] : track(Manifold.union(pos));
    if (neg.length) res = track(res.subtract(track(Manifold.union(neg.map(flipShell)))));
    return res;
  }
  function flipShell(p) {
    const mesh = p.getMesh();
    const tv = new Uint32Array(mesh.triVerts);
    for (let i = 0; i < tv.length; i += 3) { const x = tv[i + 1]; tv[i + 1] = tv[i + 2]; tv[i + 2] = x; }
    return track(new Manifold(new wasm.Mesh({ numProp: mesh.numProp, vertProperties: mesh.vertProperties, triVerts: tv })));
  }

  // Fillet / chamfer the selected edge chains of a body.
  function blend(f, kind) {
    const b = bodyOf(f.body || lastBody);
    const topo = topology(b.manifold);
    const chains = edgeChains(topo, f.angle !== undefined ? num(f.angle, 'angle') : undefined);
    const sel = selectChains(chains, f.edges, (v) => num(v, 'edges'), (a) => resolveAxis(a, 'edges.parallel').d);
    if (!sel.length) throw new Error('The edge selection matched no edges (run `cad edges` to list them)');
    const radius = kind === 'fillet' ? num(f.radius ?? 1, 'radius') : undefined;
    const distance = kind === 'chamfer' ? num(f.distance ?? 1, 'distance') : undefined;
    const distance2 = kind === 'chamfer' && f.distance2 !== undefined ? num(f.distance2, 'distance2') : undefined;
    if (kind === 'fillet' && !(radius > 0)) throw new Error('Fillet radius must be positive');
    if (kind === 'chamfer' && !(distance > 0)) throw new Error('Chamfer distance must be positive');
    const r = edgeBlend(wasm, track, topo, sel, { kind, radius, distance, distance2, tolerance: tol });
    let m = b.manifold;
    const v0 = m.volume();
    if (r.remove) m = track(m.subtract(r.remove));
    if (r.add) m = track(m.add(r.add));
    m = dropSlivers(m);
    if (Math.abs(m.volume() - v0) < 1e-9) r.warnings.push(`${kind} changed nothing — check the edge selection`);
    track(b.manifold);
    b.manifold = m;
    b.feature = f.id;
    lastBody = b.id;
    return { targets: [b.id], warnings: r.warnings, edges: sel.length };
  }

  // Matrices for pattern instances (excluding the original).
  function patternMatrices(f) {
    const mats = [];
    if ((f.kind || 'linear') === 'linear') {
      const d1 = resolveAxis(f.direction || 'x', 'pattern.direction').d;
      const n1 = Math.round(num(f.count ?? 2, 'count'));
      const s1 = num(f.spacing ?? 10, 'spacing');
      const d2 = f.direction2 ? resolveAxis(f.direction2, 'pattern.direction2').d : null;
      const n2 = d2 ? Math.round(num(f.count2 ?? 1, 'count2')) : 1;
      const s2 = d2 ? num(f.spacing2 ?? 10, 'spacing2') : 0;
      for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
        if (!i && !j) continue;
        mats.push(translation(add(scale(d1, i * s1), d2 ? scale(d2, j * s2) : [0, 0, 0])));
      }
    } else if (f.kind === 'circular') {
      const ax = resolveAxis(f.axis || 'z', 'pattern.axis');
      const n = Math.round(num(f.count ?? 4, 'count'));
      const total = f.angle !== undefined ? num(f.angle, 'angle') : 360;
      const step = Math.abs(Math.abs(total) - 360) < 1e-9 ? total / n : total / Math.max(1, n - 1);
      for (let i = 1; i < n; i++) mats.push(rotationAbout(ax.o, ax.d, step * i * D2R));
    } else throw new Error(`Unknown pattern kind "${f.kind}" (linear | circular)`);
    return mats;
  }

  // Re-apply a feature's tool (or copy a body) at each matrix.
  function replicate(f, mats) {
    const of = f.of;
    if (of && typeof of === 'object' && of.body) {
      const b = bodyOf(of.body);
      const copies = mats.map((M) => track(b.manifold.transform(M)));
      if (f.separate) copies.forEach((c, i) => setBody(`${b.id}_${f.id}_${i + 1}`, c, f.id));
      else { const u = track(Manifold.union([b.manifold, ...copies])); track(b.manifold); b.manifold = u; b.feature = f.id; }
      return {};
    }
    const ids = Array.isArray(of) ? of : [of];
    for (const id of ids) {
      const src = R.features.get(id);
      if (!src || !src.tool) throw new Error(`Cannot pattern "${id}": not a solid-producing feature (or it failed)`);
      const srcDef = (doc.features || []).find((x) => x.id === id);
      const mode = srcDef.mode || 'new';
      const tools = mats.map((M) => track(src.tool.transform(M)));
      const union = track(Manifold.union(tools));
      if (mode === 'new') {
        const bid = srcDef.body || srcDef.id;
        if (R.bodies.has(bid)) setBody(bid, track(bodyOf(bid).manifold.add(union)), f.id);
        else setBody(bid, union, f.id);
      } else {
        applyTool({ ...f, mode, target: srcDef.target ?? (mode === 'cut' ? undefined : src.targets) }, union);
      }
    }
    return {};
  }

  // ---- run timeline ----
  const features = doc.features || [];
  const seen = new Set();
  const stopAt = opts.stopAt; // rollback marker: evaluate features up to and including this id
  for (const f of features) {
    if (stopAt === '__none__') break; // rolled back before the first feature
    if (!f.id) { R.errors.push({ id: '?', message: `Feature of type ${f.type} has no id` }); continue; }
    if (seen.has(f.id)) R.errors.push({ id: f.id, message: `Duplicate id "${f.id}"` });
    seen.add(f.id);
    if (f.suppressed) { R.features.set(f.id, { ok: true, suppressed: true, warnings: [] }); continue; }
    const h = handlers[f.type];
    warnings = [];
    try {
      if (!h) throw new Error(`Unknown feature type "${f.type}"`);
      const out = h(f) || {};
      R.features.set(f.id, { ok: true, warnings: [...(out.warnings || []), ...warnings], tool: out.tool, targets: out.targets, edges: out.edges });
    } catch (e) {
      R.features.set(f.id, { ok: false, error: e.message, warnings: [] });
      R.errors.push({ id: f.id, message: e.message });
    }
    if (stopAt && f.id === stopAt) break;
  }
  R.lastBody = lastBody;
  // Free every intermediate solid; keep only the final bodies.
  const keep = new Set([...R.bodies.values()].map((b) => b.manifold));
  for (const o of R._arena) if (!keep.has(o)) try { o.delete(); } catch { /* already freed */ }
  R._arena = [];
  for (const fr of R.features.values()) delete fr.tool;
  return R;
}

function normalizeRotations(r) {
  if (!r) return [];
  if (Array.isArray(r)) return r.map((x) => (Array.isArray(x) ? { axis: x[0], angle: x[1] } : x));
  return Object.entries(r).map(([axis, angle]) => ({ axis, angle }));
}

function validateSketch(s) {
  const ids = new Set((s.entities || []).map((e) => e.id));
  for (const e of s.entities || []) {
    for (const k of ['p1', 'p2', 'center', 'start', 'end', 'p0', 'c1', 'c2']) {
      if (e[k] !== undefined && !ids.has(e[k])) throw new Error(`Entity "${e.id}" references missing point "${e[k]}"`);
    }
    if (e.type === 'point' && (!Number.isFinite(Number(e.x)) || !Number.isFinite(Number(e.y)))) throw new Error(`Point "${e.id}" needs numeric x and y`);
    if (e.type === 'point') { e.x = Number(e.x); e.y = Number(e.y); }
  }
}

// Closest triangle of a manifold to a point → {point, normal} (normal points outward).
export function closestFace(manifold, p) {
  const mesh = manifold.getMesh();
  const V = mesh.vertProperties, T = mesh.triVerts, np = mesh.numProp;
  let best = null, bd = Infinity;
  const v = (i) => [V[i * np], V[i * np + 1], V[i * np + 2]];
  for (let t = 0; t < T.length; t += 3) {
    const a = v(T[t]), b = v(T[t + 1]), c = v(T[t + 2]);
    const q = closestPointTriangle(p, a, b, c);
    const d = len(sub(q, p));
    if (d < bd - 1e-9) { bd = d; best = { point: q, normal: norm(cross(sub(b, a), sub(c, a))) }; }
  }
  if (!best) throw new Error('Body has no faces');
  return best;
}

function closestPointTriangle(p, a, b, c) {
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
  const denom = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

// ---- inspection ------------------------------------------------------------------------------

export function bodyStats(manifold) {
  const bb = manifold.boundingBox();
  const mesh = manifold.getMesh();
  const V = mesh.vertProperties, T = mesh.triVerts, np = mesh.numProp;
  let vol6 = 0, cx = 0, cy = 0, cz = 0;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * np, b = T[t + 1] * np, c = T[t + 2] * np;
    const ax = V[a], ay = V[a + 1], az = V[a + 2], bx = V[b], by = V[b + 1], bz = V[b + 2], qx = V[c], qy = V[c + 1], qz = V[c + 2];
    const d = ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
    vol6 += d;
    cx += d * (ax + bx + qx); cy += d * (ay + by + qy); cz += d * (az + bz + qz);
  }
  const r = (x) => Math.round(x * 1e6) / 1e6;
  const empty = manifold.isEmpty();
  return {
    volume: r(manifold.volume()),
    surfaceArea: r(manifold.surfaceArea()),
    bbox: empty ? null : { min: bb.min.map(r), max: bb.max.map(r), size: bb.max.map((v, i) => r(v - bb.min[i])) },
    centroid: vol6 ? [cx, cy, cz].map((v) => r(v / (4 * vol6))) : null,
    genus: manifold.genus(),
    triangles: manifold.numTri(),
    components: empty ? 0 : (() => {
      const parts = manifold.decompose();
      const total = Math.abs(manifold.volume());
      // count positive shells only (closed internal cavities appear as negative-volume shells)
      const n = parts.filter((p) => p.volume() > 1e-9 * Math.max(1, total)).length;
      parts.forEach((p) => p.delete());
      return n;
    })(),
    cavities: empty ? 0 : (() => {
      const parts = manifold.decompose();
      const total = Math.abs(manifold.volume());
      const n = parts.filter((p) => p.volume() < -1e-9 * Math.max(1, total)).length;
      parts.forEach((p) => p.delete());
      return n;
    })(),
    empty,
  };
}

export { evaluate, evaluateParams };
