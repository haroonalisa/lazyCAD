// Fluent scripting API that produces a CAD document (JSON). This is what model scripts use:
//
//   export default (cad) => {
//     cad.param('w', 40);
//     const s = cad.sketch('XY');
//     const r = s.rect([0, 0], [40, 20]);
//     s.length(r.bottom, 'w');
//     cad.extrude(s, { distance: 10 });
//   };
//
// Every method that creates something returns its id (or an object of ids for compound shapes).

import { trimEntity, filletCorner, chamferCorner } from './sketchedit.js';
import { evaluate, evaluateParams } from './expr.js';

const isPt = (v) => Array.isArray(v) && v.length === 2;

export class SketchBuilder {
  constructor(cad, feature) {
    this.cad = cad;
    this.f = feature;
    this.id = feature.id;
    this.counters = {};
    for (const e of feature.entities) this._bump(e.id);
    for (const c of feature.constraints) if (c.id) this._bump(c.id);
  }
  _bump(id) {
    const m = /^([a-z]+)(\d+)$/i.exec(id || '');
    if (m) this.counters[m[1]] = Math.max(this.counters[m[1]] || 0, +m[2]);
  }
  _id(prefix, wanted) {
    if (wanted) { if (this.has(wanted)) throw new Error(`Sketch ${this.id}: id "${wanted}" already used`); this._bump(wanted); return wanted; }
    let id;
    do { this.counters[prefix] = (this.counters[prefix] || 0) + 1; id = `${prefix}${this.counters[prefix]}`; } while (this.has(id));
    return id;
  }
  has(id) { return this.f.entities.some((e) => e.id === id) || this.f.constraints.some((c) => c.id === id); }
  get(id) { return this.f.entities.find((e) => e.id === id); }
  _ent(e) { this.f.entities.push(e); return e.id; }
  _con(c) { c.id = this._id('k', c.id); this.f.constraints.push(c); return c.id; }
  _pt(p, opts = {}) { // accept [x,y] (creates a point) or an existing point id
    if (typeof p === 'string') { if (!this.get(p)) throw new Error(`Sketch ${this.id}: no point "${p}"`); return p; }
    if (!isPt(p)) throw new Error(`Expected [x, y] or a point id, got ${JSON.stringify(p)}`);
    return this.point(p[0], p[1], opts);
  }

  // ---- geometry ----
  point(x, y, { id, fixed, construction } = {}) {
    const e = { id: this._id('p', id), type: 'point', x: +x, y: +y };
    if (fixed) e.fixed = true;
    if (construction) e.construction = true;
    return this._ent(e);
  }
  line(a, b, { id, construction } = {}) {
    const e = { id: this._id('l', id), type: 'line', p1: this._pt(a), p2: this._pt(b) };
    if (construction) e.construction = true;
    return this._ent(e);
  }
  circle(center, r, { id, construction } = {}) {
    const e = { id: this._id('c', id), type: 'circle', center: this._pt(center), r: +r };
    if (construction) e.construction = true;
    return this._ent(e);
  }
  // Arc from start to end, counter-clockwise around center. Start/end may be points or ids.
  arc(center, start, end, { id, construction } = {}) {
    const c = this._pt(center);
    const s = this._pt(start);
    let en = end;
    if (isPt(end)) { // snap the end point onto the circle through start
      const C = this.get(c), S = this.get(s), r = Math.hypot(S.x - C.x, S.y - C.y);
      const a = Math.atan2(end[1] - C.y, end[0] - C.x);
      en = [C.x + r * Math.cos(a), C.y + r * Math.sin(a)];
    }
    const e = { id: this._id('a', id), type: 'arc', center: c, start: s, end: this._pt(en) };
    if (construction) e.construction = true;
    return this._ent(e);
  }
  // Arc by center, radius and start/end angles (degrees, CCW).
  arcAngles(center, r, a0, a1, opts = {}) {
    const c = isPt(center) ? center : [this.get(center).x, this.get(center).y];
    const P = (a) => [c[0] + r * Math.cos(a * Math.PI / 180), c[1] + r * Math.sin(a * Math.PI / 180)];
    return this.arc(center, P(a0), P(a1), opts);
  }
  bezier(p0, c1, c2, p1, { id, construction } = {}) {
    const e = { id: this._id('b', id), type: 'bezier', p0: this._pt(p0), c1: this._pt(c1, { construction: true }), c2: this._pt(c2, { construction: true }), p1: this._pt(p1) };
    if (construction) e.construction = true;
    return this._ent(e);
  }
  polyline(pts, { closed = false, construction } = {}) {
    const ids = pts.map((p) => this._pt(p));
    const lines = [];
    for (let i = 0; i < ids.length - 1; i++) lines.push(this.line(ids[i], ids[i + 1], { construction }));
    if (closed) lines.push(this.line(ids[ids.length - 1], ids[0], { construction }));
    return { points: ids, lines };
  }
  // Axis-aligned rectangle between two corners. constrain:true (default) adds horizontal/vertical.
  rect(c0, c1, { constrain = true, construction } = {}) {
    const [x0, y0] = c0, [x1, y1] = c1;
    const xa = Math.min(x0, x1), xb = Math.max(x0, x1), ya = Math.min(y0, y1), yb = Math.max(y0, y1);
    const { points, lines } = this.polyline([[xa, ya], [xb, ya], [xb, yb], [xa, yb]], { closed: true, construction });
    if (constrain) { this.horizontal(lines[0]); this.horizontal(lines[2]); this.vertical(lines[1]); this.vertical(lines[3]); }
    return { points, lines, bottom: lines[0], right: lines[1], top: lines[2], left: lines[3], bl: points[0], br: points[1], tr: points[2], tl: points[3] };
  }
  // Rectangle centred on a point; with constrain, the centre point is tied by symmetry.
  centerRect(center, w, h, { constrain = true, construction } = {}) {
    const [cx, cy] = isPt(center) ? center : [this.get(center).x, this.get(center).y];
    const r = this.rect([cx - w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], { constrain, construction });
    if (constrain) {
      const c = isPt(center) ? this.point(cx, cy, { construction: true }) : center;
      const diag = this.line(r.bl, r.tr, { construction: true });
      this.midpoint(c, diag);
      r.center = c;
    }
    return r;
  }
  // Regular polygon: n sides, circumradius r (or apothem if inscribedIn:false is wanted use r/cos(pi/n)).
  polygon(center, r, n, { rotation = 90, constrain = true, construction } = {}) {
    const [cx, cy] = isPt(center) ? center : [this.get(center).x, this.get(center).y];
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (rotation + 360 * i / n) * Math.PI / 180;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    const res = this.polyline(pts, { closed: true, construction });
    if (constrain) {
      const c = isPt(center) ? this.point(cx, cy, { construction: true }) : center;
      const circ = this.circle(c, r, { construction: true });
      res.points.forEach((p) => this.pointOnCircle(p, circ));
      for (let i = 1; i < n; i++) this.equal(res.lines[0], res.lines[i]);
      res.center = c; res.circle = circ;
    }
    return res;
  }
  // Slot (stadium) between two centre points with given width.
  slot(a, b, width, { construction } = {}) {
    const r = width / 2;
    const [ax, ay] = a, [bx, by] = b;
    const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy, ny = ux;
    const ca = this.point(ax, ay, { construction: true }), cb = this.point(bx, by, { construction: true });
    const p1 = this.point(ax - nx * r, ay - ny * r), p2 = this.point(bx - nx * r, by - ny * r);
    const p3 = this.point(bx + nx * r, by + ny * r), p4 = this.point(ax + nx * r, ay + ny * r);
    const l1 = this.line(p1, p2, { construction }), l2 = this.line(p3, p4, { construction });
    const a1 = this.arc(cb, p2, p3, { construction }), a2 = this.arc(ca, p4, p1, { construction });
    this.tangent(l1, a1); this.tangent(a1, l2); this.tangent(l2, a2); this.tangent(a2, l1);
    this.equal(a1, a2);
    return { lines: [l1, l2], arcs: [a1, a2], centers: [ca, cb] };
  }
  // ---- editing ----
  _num(v) { return typeof v === 'number' ? v : evaluate(v, evaluateParams(this.cad.doc.params).values); }
  // Remove the piece of a curve between its neighbouring intersections nearest to [u, v].
  trim(id, at) { return trimEntity(this.f, id, at); }
  // Round / bevel the corner at a point shared by two lines. Returns the new arc / line id.
  fillet(point, r) { return filletCorner(this.f, point, this._num(r), r); }
  chamfer(point, d, d2 = d) { return chamferCorner(this.f, point, this._num(d), this._num(d2), [d, d2]); }
  // Round every corner of a polyline / rectangle result (or a list of point ids).
  filletAll(points, r) { return (points.points || points).map((p) => this.fillet(p, r)); }

  // Mark entities as construction geometry (excluded from profiles).
  construction(...ids) { for (const id of ids.flat()) { const e = this.get(id); if (e) e.construction = true; } }

  // Read helpers
  pos(id) { const e = this.get(id); return [e.x, e.y]; }
  ends(id) { const e = this.get(id); return e.type === 'line' ? [e.p1, e.p2] : e.type === 'arc' ? [e.start, e.end] : [e.p0, e.p1]; }
  centerOf(id) { return this.get(id).center; }

  // ---- constraints ----
  coincident(a, b) { return this._con({ type: 'coincident', a, b }); }
  fix(point, at) {
    const c = { type: 'fix', point };
    if (at) { c.x = at[0]; c.y = at[1]; }
    return this._con(c);
  }
  horizontal(lineOrA, b) { return this._con(b ? { type: 'horizontal', a: lineOrA, b } : { type: 'horizontal', line: lineOrA }); }
  vertical(lineOrA, b) { return this._con(b ? { type: 'vertical', a: lineOrA, b } : { type: 'vertical', line: lineOrA }); }
  parallel(a, b) { return this._con({ type: 'parallel', a, b }); }
  perpendicular(a, b) { return this._con({ type: 'perpendicular', a, b }); }
  collinear(a, b) { return this._con({ type: 'collinear', a, b }); }
  equal(a, b) { return this._con({ type: 'equal', a, b }); }
  tangent(a, b) { return this._con({ type: 'tangent', a, b }); }
  concentric(a, b) { return this._con({ type: 'concentric', a, b }); }
  midpoint(point, line) { return this._con({ type: 'midpoint', point, line }); }
  symmetric(a, b, line) { return this._con({ type: 'symmetric', a, b, line }); }
  pointOnLine(point, line) { return this._con({ type: 'pointOnLine', point, line }); }
  pointOnCircle(point, circle) { return this._con({ type: 'pointOnCircle', point, circle }); }
  distance(a, b, value, opts = {}) { return this._con({ type: 'distance', a, b, value, ...opts }); }
  hDistance(a, b, value, opts = {}) { return this._con({ type: 'distanceX', a, b, value, ...opts }); }
  vDistance(a, b, value, opts = {}) { return this._con({ type: 'distanceY', a, b, value, ...opts }); }
  length(line, value, opts = {}) { return this._con({ type: 'length', line, value, ...opts }); }
  radius(circle, value, opts = {}) { return this._con({ type: 'radius', circle, value, ...opts }); }
  diameter(circle, value, opts = {}) { return this._con({ type: 'diameter', circle, value, ...opts }); }
  angle(a, b, value, opts = {}) { // angle(line, value) = absolute angle; angle(l1, l2, value) = from l1 to l2 (CCW)
    if (value === undefined || typeof value === 'object') return this._con({ type: 'angle', a, value: b, ...(value || {}) });
    return this._con({ type: 'angle', a, b, value, ...opts });
  }
  equation(expr) { return this._con({ type: 'equation', expr }); }
}

export class Builder {
  constructor(doc) {
    this.doc = doc ? JSON.parse(JSON.stringify(doc)) : { version: 1, units: 'mm', params: {}, features: [] };
    this.doc.params ||= {};
    this.doc.features ||= [];
    this.counters = {};
    for (const f of this.doc.features) this._bump(f.id);
  }
  static from(doc) { return new Builder(doc); }
  _bump(id) {
    const m = /^([a-z]+)(\d+)$/i.exec(id || '');
    if (m) this.counters[m[1]] = Math.max(this.counters[m[1]] || 0, +m[2]);
  }
  _id(prefix, wanted) {
    if (wanted) {
      if (this.doc.features.some((f) => f.id === wanted)) throw new Error(`Feature id "${wanted}" already used`);
      this._bump(wanted);
      return wanted;
    }
    let id;
    do { this.counters[prefix] = (this.counters[prefix] || 0) + 1; id = `${prefix}${this.counters[prefix]}`; }
    while (this.doc.features.some((f) => f.id === id));
    return id;
  }
  _ref(x) { return x instanceof SketchBuilder ? x.id : x; }
  _add(type, prefix, opts) {
    const f = { id: this._id(prefix, opts.id), type };
    for (const [k, v] of Object.entries(opts)) if (k !== 'id' && v !== undefined) f[k] = this._ref(v);
    if (f.sections) f.sections = f.sections.map((s) => (s instanceof SketchBuilder ? { sketch: s.id } : { ...s, sketch: this._ref(s.sketch) }));
    if (f.path?.sketch) f.path = { ...f.path, sketch: this._ref(f.path.sketch) };
    if (f.direction?.sketch) f.direction = { ...f.direction, sketch: this._ref(f.direction.sketch) };
    if (f.axis?.sketch) f.axis = { ...f.axis, sketch: this._ref(f.axis.sketch) };
    this.doc.features.push(f);
    return f.id;
  }

  name(n) { this.doc.name = n; return this; }
  settings(s) { this.doc.settings = { ...this.doc.settings, ...s }; return this; }
  param(name, expr) { this.doc.params[name] = typeof expr === 'number' ? String(expr) : expr; return name; }
  params(obj) { for (const [k, v] of Object.entries(obj)) this.param(k, v); return this; }

  // Datum plane: cad.plane({base:'XY', offset: 10, rotate: {x: 30}}) → id
  plane(spec, id) { return this._add('plane', 'plane', { id, ...spec }); }
  // cad.sketch(plane, {id}) → SketchBuilder. plane: 'XY'|'XZ'|'YZ'|planeId|sketchId|spec object
  sketch(plane = 'XY', { id } = {}) {
    const f = { id: this._id('sketch', id), type: 'sketch', plane: this._ref(plane), entities: [], constraints: [] };
    this.doc.features.push(f);
    return new SketchBuilder(this, f);
  }
  // Continue editing an existing sketch.
  editSketch(id) {
    const f = this.doc.features.find((x) => x.id === id && x.type === 'sketch');
    if (!f) throw new Error(`No sketch "${id}"`);
    f.entities ||= []; f.constraints ||= [];
    return new SketchBuilder(this, f);
  }
  feature(id) { return this.doc.features.find((f) => f.id === id); }
  remove(id) { this.doc.features = this.doc.features.filter((f) => f.id !== id); }

  extrude(sketch, opts = {}) { return this._add('extrude', 'extrude', { sketch, ...opts }); }
  cut(sketch, opts = {}) { return this._add('extrude', 'cut', { sketch, mode: 'cut', ...opts }); }
  revolve(sketch, opts = {}) { return this._add('revolve', 'revolve', { sketch, ...opts }); }
  sweep(sketch, opts = {}) { return this._add('sweep', 'sweep', { sketch, ...opts }); }
  loft(sections, opts = {}) { return this._add('loft', 'loft', { sections, ...opts }); }
  box(opts = {}) { return this._add('primitive', 'box', { shape: 'box', ...opts }); }
  cylinder(opts = {}) { return this._add('primitive', 'cyl', { shape: 'cylinder', ...opts }); }
  cone(opts = {}) { return this._add('primitive', 'cone', { shape: 'cone', ...opts }); }
  sphere(opts = {}) { return this._add('primitive', 'sphere', { shape: 'sphere', ...opts }); }
  torus(opts = {}) { return this._add('primitive', 'torus', { shape: 'torus', ...opts }); }
  fillet(opts) { return this._add('fillet', 'fillet', opts); }
  chamfer(opts) { return this._add('chamfer', 'chamfer', opts); }
  shell(opts) { return this._add('shell', 'shell', opts); }
  pattern(opts) { return this._add('pattern', 'pattern', opts); }
  mirror(opts) { return this._add('mirror', 'mirror', opts); }
  transform(opts) { return this._add('transform', 'move', opts); }
  boolean(opts) { return this._add('boolean', 'bool', opts); }
  split(opts) { return this._add('split', 'split', opts); }
  deleteBodies(...bodies) { return this._add('delete', 'del', { bodies: bodies.flat() }); }
  body(id, meta) { this.doc.bodies = { ...this.doc.bodies, [id]: { ...(this.doc.bodies?.[id] || {}), ...meta } }; return id; }

  toJSON() { return this.doc; }
}
