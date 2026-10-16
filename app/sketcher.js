// Interactive 2D sketch editor drawn on the sketch's plane inside the 3D viewport.

import { THREE } from './viewport.js';
import { frameMatrix, toWorld } from '../core/vec.js';
import { solveSketch, entityPoints } from '../core/solver.js';
import { discretize } from '../core/sketch.js';
import { evaluate } from '../core/expr.js';
import { trimEntity, filletCorner, chamferCorner } from '../core/sketchedit.js';

const COLORS = {
  free: 0x2f6fed, fixed: 0x1d2330, fixedDark: 0xe6e9ef, construction: 0xc0802a, selected: 0xf59e0b,
  hover: 0x60a5fa, bad: 0xd14343, preview: 0x7c8aa5, region: 0x2f6fed,
};
const GLYPH = {
  horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⊥', equal: '=', tangent: 'T', concentric: '◎',
  midpoint: 'M', coincident: '●', fix: '⚓', pointOnLine: '⊷', pointOnCircle: '⊷', symmetric: '⇋', collinear: '⋯',
};
const DIM_TYPES = new Set(['distance', 'distanceX', 'distanceY', 'length', 'radius', 'diameter', 'angle']);
const HINTS = {
  select: 'Click to select (Shift adds) · drag points/curves · double-click a dimension to edit · Del deletes',
  line: 'Click points to draw a polyline · click the start point or press Esc to finish',
  rect: 'Click two opposite corners',
  centerRect: 'Click the center, then a corner',
  circle: 'Click the center, then a point on the circle',
  arc: 'Click the center, the start point, then the end point (direction follows the mouse)',
  polygon: 'Click the center, then a corner',
  slot: 'Click the first center, the second center, then the width',
  bezier: 'Click the start and end points — then drag the control handles',
  point: 'Click to place a point',
  trim: 'Click the part of a curve to remove (between its intersections); a curve with no crossings is deleted',
  fillet2d: 'Click the corner point where two lines meet to round it (size in the box on the toolbar)',
  chamfer2d: 'Click the corner point where two lines meet to bevel it (size in the box on the toolbar)',
};

export class Sketcher {
  constructor(app) {
    this.app = app;
    this.vp = app.vp;
    this.id = null;
    this.tool = 'select';
    this.sel = new Set();      // entity / constraint ids
    this.hover = null;
    this.stage = 0;
    this.temp = {};
    this.overlayEls = [];
    this.group = this.vp.activeGroup;
    this.overlay = document.getElementById('overlay');
    this.toolbar = document.getElementById('sketch-toolbar');

    this.toolbar.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    this.toolbar.querySelectorAll('[data-con]').forEach((b) => b.addEventListener('click', () => this.applyConstraint(b.dataset.con)));
    document.getElementById('finish-sketch').addEventListener('click', () => app.finishSketch());
    this.vp.onRender(() => this.positionOverlay());

    const cv = this.vp.renderer.domElement;
    cv.addEventListener('pointerdown', (e) => this.active && this.onDown(e));
    cv.addEventListener('pointermove', (e) => this.active && this.onMove(e));
    window.addEventListener('pointerup', (e) => this.active && this.onUp(e));
    cv.addEventListener('dblclick', (e) => this.active && this.onDblClick(e));
    cv.addEventListener('contextmenu', (e) => { if (this.active && this.stage) { e.preventDefault(); this.cancelTool(); } });
  }

  get active() { return !!this.id; }
  get sketch() { return this.app.doc.features.find((f) => f.id === this.id); }
  get result() { return this.app.R?.sketches.get(this.id); }
  get frame() { return this.result?.frame || this.app.R?.frames.get(this.id); }

  enter(id) {
    this.id = id;
    this.sel.clear();
    this.setTool('select');
    this.toolbar.hidden = false;
    this.vp.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.render();
    if (this.frame) this.vp.view('normal', this.frame);
  }

  exit() {
    this.id = null;
    this.toolbar.hidden = true;
    this.vp.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.group.clear();
    this.clearOverlay();
    this.app.setHint('');
    this.vp.dirty();
  }

  setTool(t) {
    this.tool = t;
    this.stage = 0;
    this.temp = {};
    this.toolbar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    this.app.setHint(HINTS[t] || '');
    this.render();
  }
  cancelTool() { if (this.stage) { this.stage = 0; this.temp = {}; this.render(); } else this.setTool('select'); }

  // ---- model helpers ----
  map() { return new Map(this.sketch.entities.map((e) => [e.id, e])); }
  nextId(prefix) {
    const used = new Set([...this.sketch.entities.map((e) => e.id), ...this.sketch.constraints.map((c) => c.id)]);
    let i = 1;
    while (used.has(`${prefix}${i}`)) i++;
    return `${prefix}${i}`;
  }
  addPoint(u, v, extra = {}) { const id = this.nextId('p'); this.sketch.entities.push({ id, type: 'point', x: u, y: v, ...extra }); return id; }
  addEnt(e) { e.id = this.nextId(e.type === 'line' ? 'l' : e.type === 'circle' ? 'c' : e.type === 'arc' ? 'a' : 'b'); this.sketch.entities.push(e); return e.id; }
  addCon(c) { c.id = this.nextId('k'); this.sketch.constraints.push(c); return c.id; }

  quickSolve(opts = {}) {
    const sk = this.sketch;
    const values = this.app.R?.params || {};
    try { this.liveSolve = solveSketch(sk, (v) => evaluate(v, (n) => values[n]), { maxIter: 60, ...opts }); } catch { /* ignore */ }
  }

  // ---- geometry under cursor ----
  uv(ev) { return this.frame ? this.vp.planeUV(ev, this.frame) : null; }
  px() { const f = this.frame; return f ? this.vp.pixelSize(f.o) : 1; }

  hitTest(uv, { pointsOnly = false, exclude = new Set() } = {}) {
    if (!uv) return null;
    const px = this.px(), map = this.map();
    let best = null, bd = 9 * px;
    for (const e of this.sketch.entities) {
      if (e.type !== 'point' || exclude.has(e.id)) continue;
      const d = Math.hypot(e.x - uv[0], e.y - uv[1]);
      if (d < bd) { bd = d; best = { kind: 'point', id: e.id }; }
    }
    if (best || pointsOnly) return best;
    bd = 6 * px;
    for (const e of this.sketch.entities) {
      if (e.type === 'point' || exclude.has(e.id)) continue;
      const pts = discretize(map, e, 0.05);
      if (!pts) continue;
      const poly = e.type === 'circle' ? [...pts, pts[0]] : pts;
      for (let i = 0; i + 1 < poly.length; i++) {
        const d = segDist(uv, poly[i], poly[i + 1]);
        if (d < bd) { bd = d; best = { kind: 'entity', id: e.id }; }
      }
    }
    return best;
  }

  snap(uv, { exclude } = {}) {
    const h = this.hitTest(uv, { pointsOnly: true, exclude });
    if (h) { const p = this.map().get(h.id); return { uv: [p.x, p.y], point: h.id }; }
    let out = uv.slice();
    const curve = this.hitTest(uv, { exclude });
    if (document.getElementById('grid-snap').checked) {
      const step = Math.max(1e-6, Number(document.getElementById('grid-step').value) || 1);
      out = out.map((v) => Math.round(v / step) * step);
    }
    if (curve) return { uv: projectOn(this.map(), this.map().get(curve.id), uv), on: curve.id };
    return { uv: out };
  }

  // Point id for a snap result (creating a point and pointOn constraint if needed).
  ensurePoint(s) {
    if (s.point) return s.point;
    const id = this.addPoint(s.uv[0], s.uv[1]);
    if (s.on) {
      const e = this.map().get(s.on);
      if (e.type === 'line') this.addCon({ type: 'pointOnLine', point: id, line: e.id });
      else if (e.type === 'circle' || e.type === 'arc') this.addCon({ type: 'pointOnCircle', point: id, circle: e.id });
    }
    return id;
  }

  // ---- events ----
  onDown(ev) {
    if (ev.button !== 0) return;
    const raw = this.uv(ev);
    if (!raw) return;
    this.downAt = [ev.clientX, ev.clientY];
    if (this.tool === 'select') {
      const h = this.hitTest(raw);
      if (h) {
        if (ev.shiftKey) { this.sel.has(h.id) ? this.sel.delete(h.id) : this.sel.add(h.id); }
        else if (!this.sel.has(h.id)) { this.sel.clear(); this.sel.add(h.id); }
        const e = this.map().get(h.id);
        this.drag = { id: h.id, start: raw, kind: h.kind, moved: false, orig: this.snapshotPoints(e) };
      } else if (!ev.shiftKey) this.sel.clear();
      this.render();
      this.app.showSketchInspector();
      return;
    }
    const s = this.snap(raw);
    this.app.snapshot();
    this[`click_${this.tool}`]?.(s, raw, ev);
    this.app.changed();
    this.render();
    this.app.showSketchInspector();
  }

  snapshotPoints(e) {
    const map = this.map(), ids = e.type === 'point' ? [e.id] : entityPoints(e);
    return ids.map((id) => ({ id, x: map.get(id).x, y: map.get(id).y, r: e.r }));
  }

  onMove(ev) {
    const raw = this.uv(ev);
    if (!raw) return;
    this.mouse = raw;
    this.app.setStatusRight(`u ${raw[0].toFixed(2)}  v ${raw[1].toFixed(2)} mm`);
    if (this.drag) {
      if (!this.drag.moved && Math.hypot(ev.clientX - this.downAt[0], ev.clientY - this.downAt[1]) < 3) return;
      if (!this.drag.moved) { this.app.snapshot(); this.drag.moved = true; }
      const map = this.map(), e = map.get(this.drag.id);
      const du = raw[0] - this.drag.start[0], dv = raw[1] - this.drag.start[1];
      if (e.type === 'point') {
        if (!e.fixed) this.quickSolve({ drag: { point: e.id, to: raw } });
      } else if (e.type === 'circle' && this.drag.kind === 'entity') {
        const c = map.get(e.center);
        e.r = Math.max(1e-3, Math.hypot(raw[0] - c.x, raw[1] - c.y));
        this.quickSolve();
      } else {
        for (const o of this.drag.orig) { const p = map.get(o.id); if (!p.fixed) { p.x = o.x + du; p.y = o.y + dv; } }
        this.quickSolve();
      }
      this.render();
      return;
    }
    if (this.tool === 'select') {
      const h = this.hitTest(raw);
      const id = h?.id || null;
      if (id !== this.hover) { this.hover = id; this.render(); }
      return;
    }
    if (this.tool === 'trim') {
      const h = this.hitTest(raw);
      const id = h?.kind === 'entity' ? h.id : null;
      if (id !== this.hover) { this.hover = id; this.render(); }
      return;
    }
    this.hover = this.snap(raw).point || null;
    this.renderPreview(raw);
  }

  onUp() {
    if (!this.drag) return;
    const moved = this.drag.moved;
    this.drag = null;
    if (moved) { this.app.changed(); this.app.showSketchInspector(); }
  }

  onDblClick(ev) {
    if (this.tool === 'line') { this.stage = 0; this.temp = {}; this.render(); }
  }

  onKey(ev) {
    if (!this.active) return false;
    const k = ev.key;
    if (k === 'Escape') { this.cancelTool(); return true; }
    if (k === 'Delete' || k === 'Backspace') { this.applyConstraint('delete'); return true; }
    if (k === 'Enter' && !this.stage) { this.app.finishSketch(); return true; }
    const map = { l: 'line', r: 'rect', c: 'circle', a: 'arc', p: 'point', t: 'trim' };
    if (map[k]) { this.setTool(map[k]); return true; }
    if (k === 'd') { this.applyConstraint('dimension'); return true; }
    if (k === 'h') { this.applyConstraint('horizontal'); return true; }
    if (k === 'v') { this.applyConstraint('vertical'); return true; }
    if (k === 'x') { this.applyConstraint('construction'); return true; }
    return false;
  }

  // ---- drawing tools ----
  click_point(s) { this.ensurePoint(s); }

  click_trim(s, raw) {
    const h = this.hitTest(raw);
    if (!h || h.kind !== 'entity') return this.app.toast('Click on a curve to trim', 'warn');
    try { trimEntity(this.sketch, h.id, raw); this.sel.clear(); } catch (e) { this.app.toast(e.message, 'err'); }
  }

  cornerSize() {
    const v = document.getElementById('corner-size').value.trim() || '2';
    const n = evaluate(v, (k) => this.app.R?.params[k]);
    return { n, value: /^-?[\d.]+$/.test(v) ? n : v };
  }

  click_fillet2d(s, raw) { this.corner(raw, 'fillet'); }
  click_chamfer2d(s, raw) { this.corner(raw, 'chamfer'); }
  corner(raw, kind) {
    const h = this.hitTest(raw, { pointsOnly: true });
    if (!h) return this.app.toast('Click the corner point where two lines meet', 'warn');
    try {
      const { n, value } = this.cornerSize();
      if (kind === 'fillet') filletCorner(this.sketch, h.id, n, value);
      else chamferCorner(this.sketch, h.id, n, n, [value, value]);
    } catch (e) { this.app.toast(e.message, 'err'); }
  }

  click_line(s) {
    if (this.stage === 0) {
      this.temp.start = this.ensurePoint(s);
      this.temp.first = this.temp.start;
      this.stage = 1;
      return;
    }
    const map = this.map();
    const a = map.get(this.temp.start);
    if (s.point === this.temp.start) return;
    const closing = !!s.point;
    const b = this.ensurePoint(s);
    const B = this.map().get(b);
    const lid = this.addEnt({ type: 'line', p1: this.temp.start, p2: b });
    const ang = Math.abs(Math.atan2(B.y - a.y, B.x - a.x) * 180 / Math.PI);
    if (Math.min(ang, 180 - ang) < 2.5) this.addCon({ type: 'horizontal', line: lid });
    else if (Math.abs(ang - 90) < 2.5) this.addCon({ type: 'vertical', line: lid });
    if (closing) { this.stage = 0; this.temp = {}; }
    else this.temp.start = b;
  }

  click_rect(s) {
    if (this.stage === 0) { this.temp.a = s; this.stage = 1; return; }
    const a = this.temp.a, b = s;
    if (Math.abs(a.uv[0] - b.uv[0]) < 1e-6 || Math.abs(a.uv[1] - b.uv[1]) < 1e-6) return;
    const p0 = this.ensurePoint(a), p2 = this.ensurePoint(b);
    const A = this.map().get(p0), C = this.map().get(p2);
    const p1 = this.addPoint(C.x, A.y), p3 = this.addPoint(A.x, C.y);
    const l = [[p0, p1], [p1, p2], [p2, p3], [p3, p0]].map(([x, y]) => this.addEnt({ type: 'line', p1: x, p2: y }));
    this.addCon({ type: 'horizontal', line: l[0] }); this.addCon({ type: 'horizontal', line: l[2] });
    this.addCon({ type: 'vertical', line: l[1] }); this.addCon({ type: 'vertical', line: l[3] });
    this.stage = 0; this.temp = {};
  }

  click_centerRect(s) {
    if (this.stage === 0) { this.temp.c = s; this.stage = 1; return; }
    const c = this.temp.c.uv, w = Math.abs(s.uv[0] - c[0]), h = Math.abs(s.uv[1] - c[1]);
    if (w < 1e-6 || h < 1e-6) return;
    const P = [[c[0] - w, c[1] - h], [c[0] + w, c[1] - h], [c[0] + w, c[1] + h], [c[0] - w, c[1] + h]].map(([u, v]) => this.addPoint(u, v));
    const l = [0, 1, 2, 3].map((i) => this.addEnt({ type: 'line', p1: P[i], p2: P[(i + 1) % 4] }));
    this.addCon({ type: 'horizontal', line: l[0] }); this.addCon({ type: 'horizontal', line: l[2] });
    this.addCon({ type: 'vertical', line: l[1] }); this.addCon({ type: 'vertical', line: l[3] });
    const cp = this.ensurePoint(this.temp.c);
    const diag = this.addEnt({ type: 'line', p1: P[0], p2: P[2], construction: true });
    this.addCon({ type: 'midpoint', point: cp, line: diag });
    this.stage = 0; this.temp = {};
  }

  click_circle(s) {
    if (this.stage === 0) { this.temp.c = s; this.stage = 1; return; }
    const c = this.temp.c.uv, r = Math.hypot(s.uv[0] - c[0], s.uv[1] - c[1]);
    if (r < 1e-6) return;
    this.addEnt({ type: 'circle', center: this.ensurePoint(this.temp.c), r });
    this.stage = 0; this.temp = {};
  }

  click_arc(s, raw) {
    if (this.stage === 0) { this.temp.c = s; this.stage = 1; return; }
    if (this.stage === 1) { this.temp.s = s; this.temp.sweep = 0; this.temp.lastAng = null; this.stage = 2; return; }
    const c = this.temp.c.uv, st = this.temp.s.uv, r = Math.hypot(st[0] - c[0], st[1] - c[1]);
    if (r < 1e-6) return;
    const ang = Math.atan2(s.uv[1] - c[1], s.uv[0] - c[0]);
    const end = s.point ? s : { uv: [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)] };
    const cid = this.ensurePoint(this.temp.c), sid = this.ensurePoint(this.temp.s), eid = this.ensurePoint(end);
    const cw = (this.temp.sweep || 0) < 0;
    this.addEnt({ type: 'arc', center: cid, start: cw ? eid : sid, end: cw ? sid : eid });
    this.stage = 0; this.temp = {};
  }

  click_polygon(s) {
    if (this.stage === 0) { this.temp.c = s; this.stage = 1; return; }
    const c = this.temp.c.uv, r = Math.hypot(s.uv[0] - c[0], s.uv[1] - c[1]);
    const rot = Math.atan2(s.uv[1] - c[1], s.uv[0] - c[0]);
    const n = Math.max(3, Math.round(Number(this.app.polygonSides || 6)));
    if (r < 1e-6) return;
    const P = [];
    for (let i = 0; i < n; i++) P.push(this.addPoint(c[0] + r * Math.cos(rot + 2 * Math.PI * i / n), c[1] + r * Math.sin(rot + 2 * Math.PI * i / n)));
    const L = P.map((p, i) => this.addEnt({ type: 'line', p1: p, p2: P[(i + 1) % n] }));
    const cp = this.ensurePoint(this.temp.c);
    const circ = this.addEnt({ type: 'circle', center: cp, r, construction: true });
    P.forEach((p) => this.addCon({ type: 'pointOnCircle', point: p, circle: circ }));
    for (let i = 1; i < n; i++) this.addCon({ type: 'equal', a: L[0], b: L[i] });
    this.stage = 0; this.temp = {};
  }

  click_slot(s) {
    if (this.stage === 0) { this.temp.a = s.uv; this.stage = 1; return; }
    if (this.stage === 1) { this.temp.b = s.uv; this.stage = 2; return; }
    const [a, b] = [this.temp.a, this.temp.b];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) return;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy, ny = ux;
    const r = Math.max(1e-3, Math.abs((s.uv[0] - a[0]) * nx + (s.uv[1] - a[1]) * ny));
    const ca = this.addPoint(a[0], a[1]), cb = this.addPoint(b[0], b[1]);
    const p1 = this.addPoint(a[0] - nx * r, a[1] - ny * r), p2 = this.addPoint(b[0] - nx * r, b[1] - ny * r);
    const p3 = this.addPoint(b[0] + nx * r, b[1] + ny * r), p4 = this.addPoint(a[0] + nx * r, a[1] + ny * r);
    const l1 = this.addEnt({ type: 'line', p1, p2 }), a1 = this.addEnt({ type: 'arc', center: cb, start: p2, end: p3 });
    const l2 = this.addEnt({ type: 'line', p1: p3, p2: p4 }), a2 = this.addEnt({ type: 'arc', center: ca, start: p4, end: p1 });
    for (const [x, y] of [[l1, a1], [a1, l2], [l2, a2], [a2, l1]]) this.addCon({ type: 'tangent', a: x, b: y });
    this.addCon({ type: 'equal', a: a1, b: a2 });
    this.stage = 0; this.temp = {};
  }

  click_bezier(s) {
    if (this.stage === 0) { this.temp.a = s; this.stage = 1; return; }
    const a = this.temp.a.uv, b = s.uv;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return;
    const p0 = this.ensurePoint(this.temp.a), p1 = this.ensurePoint(s);
    const nx = -(b[1] - a[1]) * 0.25, ny = (b[0] - a[0]) * 0.25;
    const c1 = this.addPoint(a[0] + (b[0] - a[0]) / 3 + nx, a[1] + (b[1] - a[1]) / 3 + ny, { construction: true });
    const c2 = this.addPoint(a[0] + 2 * (b[0] - a[0]) / 3 + nx, a[1] + 2 * (b[1] - a[1]) / 3 + ny, { construction: true });
    this.addEnt({ type: 'bezier', p0, c1, c2, p1 });
    this.stage = 0; this.temp = {};
  }

  // ---- constraints from selection ----
  selection() {
    const map = this.map();
    const ents = [...this.sel].map((id) => map.get(id)).filter(Boolean);
    const cons = [...this.sel].filter((id) => !map.has(id));
    return {
      ents, cons,
      points: ents.filter((e) => e.type === 'point'),
      lines: ents.filter((e) => e.type === 'line'),
      rounds: ents.filter((e) => e.type === 'circle' || e.type === 'arc'),
      curves: ents.filter((e) => e.type !== 'point'),
    };
  }

  async applyConstraint(kind) {
    if (!this.active) return;
    const S = this.selection();
    const add = (cs) => {
      this.app.snapshot();
      for (const c of [].concat(cs)) this.addCon(c);
      this.sel.clear();
      this.app.changed();
      this.afterConstraint();
    };
    const fail = (msg) => this.app.toast(msg, 'warn');
    const P = S.points.map((p) => p.id), Ln = S.lines.map((l) => l.id), Rd = S.rounds.map((r) => r.id);
    switch (kind) {
      case 'delete': return this.deleteSelection();
      case 'construction':
        if (!S.curves.length && !S.points.length) return fail('Select curves to toggle construction');
        this.app.snapshot();
        for (const e of [...S.curves, ...S.points]) e.construction = !e.construction || undefined;
        this.app.changed(); this.render(); return;
      case 'coincident':
        if (P.length === 2) return add({ type: 'coincident', a: P[0], b: P[1] });
        if (P.length === 1 && S.curves.length === 1) return this.applyConstraint('pointOn');
        return fail('Coincident: select two points');
      case 'horizontal': case 'vertical':
        if (Ln.length >= 1 && !P.length) return add(Ln.map((l) => ({ type: kind, line: l })));
        if (P.length === 2) return add({ type: kind, a: P[0], b: P[1] });
        return fail(`${kind}: select line(s) or two points`);
      case 'parallel': case 'perpendicular': case 'collinear':
        if (Ln.length === 2) return add({ type: kind, a: Ln[0], b: Ln[1] });
        return fail(`${kind}: select two lines`);
      case 'equal':
        if (Ln.length >= 2) return add(Ln.slice(1).map((l) => ({ type: 'equal', a: Ln[0], b: l })));
        if (Rd.length >= 2) return add(Rd.slice(1).map((r) => ({ type: 'equal', a: Rd[0], b: r })));
        return fail('Equal: select two or more lines, or two or more circles/arcs');
      case 'tangent':
        if (S.curves.length === 2) return add({ type: 'tangent', a: S.curves[0].id, b: S.curves[1].id });
        return fail('Tangent: select a line and a circle/arc, two circles, or two curves sharing an endpoint');
      case 'concentric':
        if (Rd.length === 2) return add({ type: 'concentric', a: Rd[0], b: Rd[1] });
        return fail('Concentric: select two circles/arcs');
      case 'midpoint':
        if (P.length === 1 && Ln.length === 1) return add({ type: 'midpoint', point: P[0], line: Ln[0] });
        return fail('Midpoint: select a point and a line');
      case 'pointOn':
        if (P.length === 1 && Ln.length === 1) return add({ type: 'pointOnLine', point: P[0], line: Ln[0] });
        if (P.length === 1 && Rd.length === 1) return add({ type: 'pointOnCircle', point: P[0], circle: Rd[0] });
        return fail('Point on: select a point and a line or circle');
      case 'symmetric':
        if (P.length === 2 && Ln.length === 1) return add({ type: 'symmetric', a: P[0], b: P[1], line: Ln[0] });
        return fail('Symmetric: select two points and a line');
      case 'fix': {
        const pts = P.length ? P : S.curves.flatMap((e) => entityPoints(e));
        if (!pts.length) return fail('Fix: select points or curves');
        const map = this.map();
        return add([...new Set(pts)].map((p) => ({ type: 'fix', point: p, x: round6(map.get(p).x), y: round6(map.get(p).y) })));
      }
      case 'equation': {
        const r = await this.app.ask('Equation constraint', [{ key: 'expr', label: 'Equation', value: Ln.length >= 2 ? `len(${Ln[0]}) = 2*len(${Ln[1]})` : 'x(p1) = 10', wide: true }],
          'Use entity functions len(line), dist(p,q), x(p), y(p), r(circle), angle(line) and parameter names.');
        if (r) add({ type: 'equation', expr: r.expr });
        return;
      }
      case 'dimension': return this.dimensionSelection();
    }
  }

  afterConstraint() {
    const sk = this.app.R?.sketches.get(this.id);
    if (sk && !sk.solve.ok) this.app.toast(`Sketch is over-constrained or conflicting: ${sk.solve.residuals.map((r) => r.id).join(', ')}`, 'err');
    this.render();
  }

  async dimensionSelection() {
    const S = this.selection();
    const map = this.map();
    const P = S.points, L = S.lines, Rd = S.rounds;
    let spec = null;
    if (L.length === 1 && !P.length && !Rd.length) {
      const a = map.get(L[0].p1), b = map.get(L[0].p2);
      spec = { kinds: [['length', 'Length'], ['distanceX', 'Horizontal'], ['distanceY', 'Vertical']], base: { line: L[0].id },
        measure: { length: Math.hypot(b.x - a.x, b.y - a.y), distanceX: b.x - a.x, distanceY: b.y - a.y } };
    } else if (P.length === 2) {
      const [a, b] = P;
      spec = { kinds: [['distance', 'Aligned'], ['distanceX', 'Horizontal'], ['distanceY', 'Vertical']], base: { a: a.id, b: b.id },
        measure: { distance: Math.hypot(b.x - a.x, b.y - a.y), distanceX: b.x - a.x, distanceY: b.y - a.y } };
    } else if (Rd.length === 1 && !P.length && !L.length) {
      const e = Rd[0];
      const r = e.type === 'circle' ? e.r : Math.hypot(map.get(e.start).x - map.get(e.center).x, map.get(e.start).y - map.get(e.center).y);
      spec = { kinds: e.type === 'circle' ? [['diameter', 'Diameter'], ['radius', 'Radius']] : [['radius', 'Radius'], ['diameter', 'Diameter']], base: { circle: e.id }, measure: { radius: r, diameter: 2 * r } };
    } else if (L.length === 2) {
      const d = (l) => { const a = map.get(l.p1), b = map.get(l.p2); return [b.x - a.x, b.y - a.y]; };
      const a = d(L[0]), b = d(L[1]);
      spec = { kinds: [['angle', 'Angle (CCW from 1st to 2nd)']], base: { a: L[0].id, b: L[1].id },
        measure: { angle: Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) * 180 / Math.PI } };
    } else if (L.length === 1 && P.length === 1) {
      const l = L[0], a = map.get(l.p1), b = map.get(l.p2), p = P[0];
      const dx = b.x - a.x, dy = b.y - a.y;
      spec = { kinds: [['distance', 'Point–line distance']], base: { a: p.id, b: l.id },
        measure: { distance: Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / Math.hypot(dx, dy) } };
    } else if (P.length === 1 && !S.curves.length) {
      const p = P[0];
      spec = { kinds: [['distanceX', 'Horizontal from origin'], ['distanceY', 'Vertical from origin']], base: { a: '#origin', b: p.id }, measure: { distanceX: p.x, distanceY: p.y } };
    }
    if (!spec) return this.app.toast('Dimension: select a line, two points, a circle/arc, two lines, or a point and a line', 'warn');
    const r = await this.app.ask('Add dimension', [
      { key: 'kind', label: 'Type', type: 'select', options: spec.kinds, value: spec.kinds[0][0] },
      { key: 'value', label: 'Value', value: '', placeholder: 'number, parameter or expression', autofocus: true },
      { key: 'reference', label: 'Reference only', type: 'checkbox', value: false },
    ], 'Leave the value empty to keep the current measurement. Values may reference parameters, e.g. w/2 + 3.',
    (vals, setPlaceholder) => setPlaceholder('value', fmt(spec.measure[vals.kind])));
    if (!r) return;
    const c = { type: r.kind, ...spec.base, value: r.value.trim() || round6(spec.measure[r.kind]) };
    if (c.type === 'angle' && !r.value.trim()) c.value = round6(spec.measure.angle);
    if (r.reference) c.driving = false;
    this.app.snapshot();
    if (c.a === '#origin') c.a = this.originPoint();
    this.addCon(c);
    this.app.changed();
    const sk = this.app.R?.sketches.get(this.id);
    if (sk && !sk.solve.ok && !r.reference) {
      c.driving = false;
      this.app.changed();
      this.app.toast('That dimension over-constrains the sketch — added as a reference dimension instead', 'warn');
    }
    this.sel.clear();
    this.render();
  }

  // A fixed construction point at the sketch origin (created on demand).
  originPoint() {
    const e = this.sketch.entities.find((x) => x.type === 'point' && x.fixed && x.x === 0 && x.y === 0 && x.construction);
    if (e) return e.id;
    return this.addPoint(0, 0, { fixed: true, construction: true });
  }

  deleteSelection() {
    if (!this.sel.size) return;
    this.app.snapshot();
    const sk = this.sketch;
    const delEnts = new Set([...this.sel].filter((id) => sk.entities.some((e) => e.id === id)));
    const delCons = new Set([...this.sel].filter((id) => sk.constraints.some((c) => c.id === id)));
    // deleting a point deletes curves that use it
    for (const e of sk.entities) if (e.type !== 'point' && entityPoints(e).some((p) => delEnts.has(p))) delEnts.add(e.id);
    const orphanCandidates = new Set();
    for (const e of sk.entities) if (delEnts.has(e.id) && e.type !== 'point') entityPoints(e).forEach((p) => orphanCandidates.add(p));
    sk.entities = sk.entities.filter((e) => !delEnts.has(e.id));
    const used = new Set(sk.entities.flatMap((e) => (e.type === 'point' ? [] : entityPoints(e))));
    sk.entities = sk.entities.filter((e) => !(e.type === 'point' && orphanCandidates.has(e.id) && !used.has(e.id)));
    const alive = new Set(sk.entities.map((e) => e.id));
    const refs = (c) => ['a', 'b', 'line', 'point', 'circle'].map((k) => c[k]).filter(Boolean);
    sk.constraints = sk.constraints.filter((c) => !delCons.has(c.id) && refs(c).every((r) => alive.has(r)) && (c.type !== 'equation' || true));
    this.sel.clear();
    this.app.changed();
    this.render();
  }

  // ---- rendering ----
  status() {
    const r = this.result;
    const s = this.liveSolve && this.drag ? this.liveSolve : r?.solve;
    return s || { freePoints: new Set(), freeRadii: new Set(), residuals: [] };
  }

  render() {
    this.group.clear();
    this.clearOverlay();
    if (!this.active || !this.sketch || !this.frame) { this.vp.dirty(); return; }
    const frame = this.frame, sk = this.sketch, map = this.map();
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.matrix.fromArray(frameMatrix(frame));
    this.group.add(root);
    this.root = root;
    const st = this.status();
    const bad = new Set();
    for (const r of st.residuals || []) {
      const c = sk.constraints.find((x) => x.id === r.id);
      if (c) ['a', 'b', 'line', 'point', 'circle'].forEach((k) => c[k] && bad.add(c[k]));
    }
    const dark = this.vp.isDark;
    const constrainedColor = dark ? COLORS.fixedDark : COLORS.fixed;
    const isFree = (e) => entityPoints(e).some((p) => st.freePoints?.has(p)) || st.freeRadii?.has(e.id);

    // region fill (what an extrude of "all" would use)
    this.renderRegions(root);

    const mkLine = (pts, color, dashed, width = 1) => {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map(([u, v]) => new THREE.Vector3(u, v, 0)));
      const mat = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 2 * this.px(), gapSize: 1.5 * this.px(), depthTest: false })
        : new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: width });
      const l = new THREE.Line(g, mat);
      if (dashed) l.computeLineDistances();
      l.renderOrder = 10;
      return l;
    };

    for (const e of sk.entities) {
      if (e.type === 'point') continue;
      const pts = discretize(map, e, 0.02);
      if (!pts) continue;
      const poly = e.type === 'circle' ? [...pts, pts[0]] : pts;
      let color = e.construction ? COLORS.construction : isFree(e) ? COLORS.free : constrainedColor;
      if (bad.has(e.id)) color = COLORS.bad;
      if (this.hover === e.id) color = COLORS.hover;
      if (this.sel.has(e.id)) color = COLORS.selected;
      root.add(mkLine(poly, color, !!e.construction));
      if (e.type === 'bezier') {
        const P = (id) => [map.get(id).x, map.get(id).y];
        root.add(mkLine([P(e.p0), P(e.c1)], COLORS.preview, true));
        root.add(mkLine([P(e.p1), P(e.c2)], COLORS.preview, true));
      }
    }
    // points
    const pos = [], col = [];
    for (const e of sk.entities) {
      if (e.type !== 'point') continue;
      let c = e.fixed ? constrainedColor : st.freePoints?.has(e.id) ? COLORS.free : constrainedColor;
      if (e.construction) c = COLORS.construction;
      if (bad.has(e.id)) c = COLORS.bad;
      if (this.hover === e.id) c = COLORS.hover;
      if (this.sel.has(e.id)) c = COLORS.selected;
      pos.push(e.x, e.y, 0);
      const cc = new THREE.Color(c);
      col.push(cc.r, cc.g, cc.b);
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false }));
      pts.renderOrder = 11;
      root.add(pts);
    }
    // origin cross
    const o = 6 * this.px();
    root.add(mkLine([[-o, 0], [o, 0]], 0xd04545, false));
    root.add(mkLine([[0, -o], [0, o]], 0x2f9e55, false));

    this.previewRoot = new THREE.Group();
    root.add(this.previewRoot);
    this.buildOverlay(map, bad);
    this.updateStatus();
    this.vp.dirty();
  }

  renderRegions(root) {
    const res = this.result;
    if (!res || !this.app.wasm || this.drag) return;
    const arena = [];
    const track = (o) => { arena.push(o); return o; };
    try {
      if (!res.loops.length) return;
      const cs = res.autoProfile(track);
      const polys = cs.toPolygons();
      if (!polys.length) return;
      const tris = this.app.wasm.triangulate(polys);
      const flat = polys.flat();
      const pos = new Float32Array(tris.length * 9);
      tris.forEach((t, i) => t.forEach((vi, k) => { pos[i * 9 + k * 3] = flat[vi][0]; pos[i * 9 + k * 3 + 1] = flat[vi][1]; pos[i * 9 + k * 3 + 2] = -0.01; }));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: COLORS.region, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
      m.renderOrder = 9;
      root.add(m);
    } catch { /* no closed profile */ } finally { arena.forEach((o) => o.delete()); }
  }

  renderPreview(raw) {
    if (!this.previewRoot) return;
    this.previewRoot.clear();
    const s = this.snap(raw);
    const p = s.uv;
    const add = (pts, dashed = true) => {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map(([u, v]) => new THREE.Vector3(u, v, 0)));
      const mat = dashed ? new THREE.LineDashedMaterial({ color: COLORS.preview, dashSize: 2 * this.px(), gapSize: 1.5 * this.px(), depthTest: false }) : new THREE.LineBasicMaterial({ color: COLORS.preview, depthTest: false });
      const l = new THREE.Line(g, mat);
      if (dashed) l.computeLineDistances();
      l.renderOrder = 12;
      this.previewRoot.add(l);
    };
    const circ = (c, r, a0 = 0, sw = 2 * Math.PI) => {
      const n = 64, pts = [];
      for (let i = 0; i <= n; i++) pts.push([c[0] + r * Math.cos(a0 + sw * i / n), c[1] + r * Math.sin(a0 + sw * i / n)]);
      add(pts);
    };
    const t = this.temp, map = this.map();
    const P = (id) => [map.get(id).x, map.get(id).y];
    let info = '';
    switch (this.tool) {
      case 'line': if (this.stage) { const a = P(t.start); add([a, p], false); info = `L ${fmt(Math.hypot(p[0] - a[0], p[1] - a[1]))}  ∠ ${fmt(Math.atan2(p[1] - a[1], p[0] - a[0]) * 180 / Math.PI)}°`; } break;
      case 'rect': if (this.stage) { const a = t.a.uv; add([a, [p[0], a[1]], p, [a[0], p[1]], a], false); info = `${fmt(Math.abs(p[0] - a[0]))} × ${fmt(Math.abs(p[1] - a[1]))}`; } break;
      case 'centerRect': if (this.stage) { const c = t.c.uv, w = p[0] - c[0], h = p[1] - c[1]; add([[c[0] - w, c[1] - h], [c[0] + w, c[1] - h], [c[0] + w, c[1] + h], [c[0] - w, c[1] + h], [c[0] - w, c[1] - h]], false); info = `${fmt(Math.abs(2 * w))} × ${fmt(Math.abs(2 * h))}`; } break;
      case 'circle': if (this.stage) { const c = t.c.uv, r = Math.hypot(p[0] - c[0], p[1] - c[1]); circ(c, r); info = `⌀ ${fmt(2 * r)}`; } break;
      case 'polygon': if (this.stage) { const c = t.c.uv, r = Math.hypot(p[0] - c[0], p[1] - c[1]), n = Math.max(3, Math.round(this.app.polygonSides || 6)), rot = Math.atan2(p[1] - c[1], p[0] - c[0]); const pts = []; for (let i = 0; i <= n; i++) pts.push([c[0] + r * Math.cos(rot + 2 * Math.PI * i / n), c[1] + r * Math.sin(rot + 2 * Math.PI * i / n)]); add(pts, false); info = `${n} sides, R ${fmt(r)}`; } break;
      case 'arc':
        if (this.stage === 1) { const c = t.c.uv; add([c, p]); info = `R ${fmt(Math.hypot(p[0] - c[0], p[1] - c[1]))}`; }
        if (this.stage === 2) {
          const c = t.c.uv, st = t.s.uv, r = Math.hypot(st[0] - c[0], st[1] - c[1]);
          const a0 = Math.atan2(st[1] - c[1], st[0] - c[0]), a = Math.atan2(p[1] - c[1], p[0] - c[0]);
          if (t.lastAng !== null && t.lastAng !== undefined) { let d = a - t.lastAng; d = Math.atan2(Math.sin(d), Math.cos(d)); t.sweep += d; } else t.sweep = 0;
          t.lastAng = a;
          let sw = a - a0; sw = ((sw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          if (t.sweep < 0) sw -= 2 * Math.PI;
          circ(c, r, a0, sw);
          info = `${fmt(Math.abs(sw) * 180 / Math.PI)}°`;
        }
        break;
      case 'slot':
        if (this.stage === 1) add([t.a, p], false);
        if (this.stage === 2) { add([t.a, t.b], true); const [a, b] = [t.a, t.b]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; const nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L; const r = Math.abs((p[0] - a[0]) * nx + (p[1] - a[1]) * ny); circ(a, r); circ(b, r); info = `width ${fmt(2 * r)}`; }
        break;
      case 'bezier': if (this.stage) add([t.a.uv, p]); break;
    }
    // snap marker
    if (s.point || s.on) {
      const r = 5 * this.px();
      circ(p, r);
    }
    this.app.setHint(info ? `${HINTS[this.tool]} — ${info}` : HINTS[this.tool]);
    this.vp.dirty();
  }

  updateStatus() {
    const r = this.result;
    if (!r) return;
    const s = r.solve;
    const msg = !s.ok ? `<span class="err">✗ conflicting constraints (${s.residuals.map((x) => x.id).join(', ')})</span>`
      : s.dof === 0 ? '<span class="ok">✓ fully constrained</span>' : `<span class="warn">${s.dof} degree${s.dof === 1 ? '' : 's'} of freedom</span>`;
    this.app.setStatusLeft(`Sketch ${this.id} · ${msg} · ${r.loops.length} closed loop${r.loops.length === 1 ? '' : 's'}`);
  }

  // ---- overlay: dimension labels and constraint glyphs ----
  clearOverlay() { this.overlay.innerHTML = ''; this.overlayEls = []; }

  buildOverlay(map, bad) {
    const sk = this.sketch, st = this.status();
    const P = (id) => { const p = map.get(id); return p ? [p.x, p.y] : null; };
    const anchors = new Map();
    const params = this.app.R?.params || {};
    for (const c of sk.constraints) {
      let pos = null, text = '', kind = 'glyph';
      try {
        if (DIM_TYPES.has(c.type)) {
          kind = 'dim';
          let v = c.driving === false ? st.refValues?.[c.id] ?? this.result?.solve.refValues?.[c.id] : evaluate(c.value, (n) => params[n]);
          const isExpr = typeof c.value === 'string' && /[A-Za-z_]/.test(c.value);
          const prefix = c.type === 'diameter' ? '⌀' : c.type === 'radius' ? 'R' : c.type === 'distanceX' ? '↔ ' : c.type === 'distanceY' ? '↕ ' : '';
          text = `${prefix}${isExpr ? `${c.value} = ` : ''}${fmt(v)}${c.type === 'angle' ? '°' : ''}`;
          if (c.driving === false) text = `(${text})`;
          const off = 14 * this.px();
          if (c.type === 'length' || (c.line && (c.type === 'distanceX' || c.type === 'distanceY'))) {
            const l = map.get(c.line), a = P(l.p1), b = P(l.p2);
            pos = offsetMid(a, b, -off);
          } else if (c.type === 'distance' && map.get(c.a)?.type === 'point' && map.get(c.b)?.type === 'point') pos = offsetMid(P(c.a), P(c.b), off);
          else if (c.type === 'distance') { const pt = map.get(c.a).type === 'point' ? c.a : c.b; pos = P(pt).map((x) => x + off); }
          else if (c.type === 'distanceX') { const a = P(c.a), b = P(c.b); pos = [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - off]; }
          else if (c.type === 'distanceY') { const a = P(c.a), b = P(c.b); pos = [Math.max(a[0], b[0]) + off, (a[1] + b[1]) / 2]; }
          else if (c.type === 'radius' || c.type === 'diameter') {
            const e = map.get(c.circle), ctr = P(e.center);
            const r = e.type === 'circle' ? e.r : Math.hypot(P(e.start)[0] - ctr[0], P(e.start)[1] - ctr[1]);
            pos = [ctr[0] + r * 0.707 + off * 0.5, ctr[1] + r * 0.707 + off * 0.5];
          } else if (c.type === 'angle') {
            const l = map.get(c.a); const a = P(l.p1), b = P(l.p2);
            pos = offsetMid(a, b, -off * 1.5);
          }
        } else if (GLYPH[c.type]) {
          text = GLYPH[c.type];
          const anchorId = c.line || c.a || c.point || c.circle;
          const e = map.get(anchorId);
          if (!e) continue;
          if (e.type === 'point') pos = P(e.id);
          else if (e.type === 'line') pos = offsetMid(P(e.p1), P(e.p2), 9 * this.px());
          else if (e.type === 'circle') pos = [P(e.center)[0], P(e.center)[1] + e.r];
          else if (e.type === 'arc') pos = P(e.start);
          else pos = P(entityPoints(e)[0]);
          const k = `${anchorId}`;
          const n = anchors.get(k) || 0;
          anchors.set(k, n + 1);
          pos = [pos[0] + n * 11 * this.px(), pos[1] - 9 * this.px()];
        } else continue;
      } catch { continue; }
      if (!pos) continue;
      const el = document.createElement('div');
      el.className = kind === 'dim' ? `dim-label${c.driving === false ? ' ref' : ''}` : 'con-glyph';
      if (this.sel.has(c.id)) el.classList.add('sel');
      if ((st.residuals || []).some((r) => r.id === c.id)) el.classList.add('bad');
      el.textContent = text;
      el.title = `${c.id}: ${c.type}${c.value !== undefined ? ` = ${c.value}` : ''}`;
      el.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        if (ev.shiftKey) { this.sel.has(c.id) ? this.sel.delete(c.id) : this.sel.add(c.id); } else { this.sel.clear(); this.sel.add(c.id); }
        this.render();
        this.app.showSketchInspector();
      });
      if (kind === 'dim') el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); this.editDimension(c, el); });
      this.overlay.appendChild(el);
      this.overlayEls.push({ el, uv: pos });
    }
    this.positionOverlay();
  }

  positionOverlay() {
    if (!this.active || !this.frame) return;
    for (const o of this.overlayEls) {
      const s = this.vp.toScreen(toWorld(this.frame, o.uv));
      o.el.style.left = `${s.x}px`;
      o.el.style.top = `${s.y}px`;
      o.el.style.display = s.behind ? 'none' : '';
    }
  }

  editDimension(c, el) {
    const input = document.createElement('input');
    input.className = 'dim-input';
    input.value = c.value;
    input.style.left = el.style.left;
    input.style.top = el.style.top;
    this.overlay.appendChild(input);
    input.focus();
    input.select();
    const done = (ok) => {
      if (!input.isConnected) return;
      input.remove();
      if (!ok) return;
      const v = input.value.trim();
      if (!v || v === String(c.value)) return;
      try { evaluate(v, (n) => this.app.R.params[n]); } catch (e) { this.app.toast(e.message, 'err'); return; }
      this.app.snapshot();
      c.value = /^-?\d*\.?\d+(e-?\d+)?$/i.test(v) ? Number(v) : v;
      this.app.changed();
      this.afterConstraint();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', () => done(true));
  }
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function projectOn(map, e, p) {
  if (e.type === 'line') {
    const a = map.get(e.p1), b = map.get(e.p2), dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const t = L ? ((p[0] - a.x) * dx + (p[1] - a.y) * dy) / L : 0;
    return [a.x + t * dx, a.y + t * dy];
  }
  if (e.type === 'circle' || e.type === 'arc') {
    const c = map.get(e.center);
    const r = e.type === 'circle' ? e.r : Math.hypot(map.get(e.start).x - c.x, map.get(e.start).y - c.y);
    const ang = Math.atan2(p[1] - c.y, p[0] - c.x);
    return [c.x + r * Math.cos(ang), c.y + r * Math.sin(ang)];
  }
  return p;
}

function offsetMid(a, b, off) {
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  return [m[0] - dy / L * off, m[1] + dx / L * off];
}

export const fmt = (v) => (v === undefined || v === null || Number.isNaN(v) ? '?' : String(Math.round(v * 1000) / 1000));
const round6 = (v) => Math.round(v * 1e6) / 1e6;
