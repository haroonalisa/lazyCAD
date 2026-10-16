// LazyCAD app controller: document state, undo/redo, rebuild, panels, picking modes, live sync.

import { initKernel, rebuildSync, bodyStats } from '../core/kernel.js';
import { Builder } from '../core/builder.js';
import { buildReport, reportText } from '../core/report.js';
import { exportMeshes, sketchToDXF, sketchToSVG } from '../core/export.js';
import { evaluate, isValidName } from '../core/expr.js';
import { frameMatrix } from '../core/vec.js';
import { topology, edgeChains, selectChains, distToChain } from '../core/edges.js';
import { Viewport, THREE } from './viewport.js';
import { Sketcher, fmt } from './sketcher.js';
import { Inspector, FEATURE_ICONS, FEATURE_LABELS, h } from './inspector.js';

const EMPTY = () => ({ version: 1, units: 'mm', params: {}, features: [] });
const CLIENT_ID = Math.random().toString(36).slice(2);
const LS_KEY = 'lazycad.doc';

class App {
  async init() {
    this.wasm = await initKernel();
    this.vp = new Viewport(document.getElementById('viewport'));
    this.sketcher = new Sketcher(this);
    this.inspector = new Inspector(this);
    this.undoStack = [];
    this.redoStack = [];
    this.selected = null;   // feature id being edited
    this.pick = null;       // picking mode {type, ...}
    this.polygonSides = 6;
    this.examples = ['enclosure.js', 'bracket.js', 'flange.js', 'spring.js', 'bottle.js'];
    this.server = false;
    this.wireUI();
    this.doc = EMPTY();
    await this.connect();
    this.rebuild();
    this.vp.view('iso');
    requestAnimationFrame(() => this.vp.view('iso')); // again once layout has settled
    this.refreshInspector();
    window.cad = this.api();
  }

  // ---- document state & undo ----
  snapshot() { if (!this.pending) this.pending = JSON.stringify(this.doc); }
  changed({ save = true } = {}) {
    if (this.pending) {
      if (this.pending !== JSON.stringify(this.doc)) { this.undoStack.push(this.pending); this.redoStack = []; if (this.undoStack.length > 200) this.undoStack.shift(); }
      this.pending = null;
    }
    this.rebuild();
    if (save) this.save();
  }
  undo() { this.restore(this.undoStack, this.redoStack); }
  redo() { this.restore(this.redoStack, this.undoStack); }
  restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(from.pop());
    this.pending = null;
    if (this.sketcher.active && !this.doc.features.some((f) => f.id === this.sketcher.id)) this.sketcher.exit();
    this.rebuild();
    this.save();
    this.refreshInspector();
  }

  loadDoc(doc, { keepUndo = true, fit = false } = {}) {
    if (keepUndo) { this.undoStack.push(JSON.stringify(this.doc)); this.redoStack = []; }
    this.doc = doc;
    this.doc.params ||= {};
    this.doc.features ||= [];
    if (this.selected && !this.doc.features.some((f) => f.id === this.selected)) this.selected = null;
    if (this.sketcher.active && !this.doc.features.some((f) => f.id === this.sketcher.id)) this.sketcher.exit();
    this.rebuild();
    if (fit) this.vp.view('iso');
    this.refreshInspector();
  }

  // ---- rebuild & display ----
  rebuild() {
    const t0 = performance.now();
    const old = this.R;
    let R;
    try { R = rebuildSync(this.wasm, this.doc, { stopAt: this.rollback }); } catch (e) { console.error(e); this.toast(e.message, 'err'); return; }
    this.R = R;
    this.lastBuildMs = performance.now() - t0;
    const editing = this.selected && this.doc.features.find((f) => f.id === this.selected);
    const bodies = [...R.bodies.values()];
    this.vp.setBodies(bodies, { highlight: editing?.target || (editing && R.features.get(editing.id)?.targets?.[0]) });
    const planeFrames = new Map();
    for (const f of this.doc.features) if (f.type === 'plane' && !f.hidden && R.frames.has(f.id)) planeFrames.set(f.id, R.frames.get(f.id));
    this.vp.setDatums(planeFrames, this.selected);
    const passive = [];
    const highlightSketch = editing?.sketch || editing?.path?.sketch;
    for (const f of this.doc.features) {
      if (f.type !== 'sketch' || f.id === this.sketcher.id) continue;
      if (f.hidden && f.id !== highlightSketch) continue;
      const sk = R.sketches.get(f.id);
      if (!sk) continue;
      const curves = f.entities.filter((e) => e.type !== 'point' && sk.polylines.get(e.id)).map((e) => ({ pts: sk.polylines.get(e.id), construction: !!e.construction }));
      passive.push({ frame: sk.frame, curves, highlight: f.id === highlightSketch });
    }
    this.vp.setPassiveSketches(passive);
    if (this.pick?.type === 'regions') this.showRegions();
    if (this.pick?.type === 'edges') this.showEdges();
    if (this.pick?.type === 'faces') this.showFaceMarks();
    this.renderParams();
    this.renderTimeline();
    this.renderBodies();
    if (this.sketcher.active) this.sketcher.render();
    else this.updateStatus();
    old?.dispose();
  }

  updateStatus() {
    const R = this.R;
    if (!R) return;
    const n = R.bodies.size;
    const msg = R.errors.length ? `<span class="err">✗ ${R.errors.length} error${R.errors.length > 1 ? 's' : ''}: ${esc(R.errors[0].id)} — ${esc(R.errors[0].message)}</span>` : '<span class="ok">✓ rebuilt</span>';
    this.setStatusLeft(`${msg} · ${n} bod${n === 1 ? 'y' : 'ies'} · ${this.lastBuildMs.toFixed(0)} ms`);
  }
  setStatusLeft(html) { document.getElementById('status-left').innerHTML = html; }
  setStatusRight(t) { document.getElementById('status-right').textContent = t; }
  setHint(t) { document.getElementById('hint').textContent = t; }

  toast(msg, kind = 'ok') {
    const el = document.createElement('div');
    el.className = `msg ${kind}`;
    el.textContent = msg;
    Object.assign(el.style, { position: 'absolute', top: '56px', left: '50%', transform: 'translateX(-50%)', zIndex: 60, boxShadow: 'var(--shadow)', background: 'var(--panel)', maxWidth: '70%' });
    document.getElementById('viewport').append(el);
    setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3500);
  }

  // ---- left panel ----
  renderParams() {
    const box = document.getElementById('params');
    box.innerHTML = '';
    for (const [name, expr] of Object.entries(this.doc.params)) {
      const err = this.R?.paramErrors[name];
      const row = h('div', { class: `param-row${err ? ' err' : ''}`, title: err || '' },
        h('input', { value: name, onkeydown: (e) => e.stopPropagation(), onchange: (e) => this.renameParam(name, e.target.value.trim()) }),
        h('input', { value: expr, onkeydown: (e) => e.stopPropagation(), onchange: (e) => { this.snapshot(); this.doc.params[name] = e.target.value.trim(); this.changed(); this.refreshInspector(); } }),
        h('span', { class: 'val' }, err ? '✗' : fmt(this.R?.params[name])),
        h('button', { class: 'mini', title: 'Delete', onclick: () => { this.snapshot(); delete this.doc.params[name]; this.changed(); } }, '✕'));
      box.append(row);
    }
    if (!Object.keys(this.doc.params).length) box.append(h('div', { class: 'hint-inline' }, 'Named values usable in any field, e.g. width = 40, wall = width/10'));
  }

  renameParam(old, nu) {
    if (nu === old) return;
    if (!isValidName(nu) || nu in this.doc.params) { this.toast(`Invalid or duplicate name "${nu}"`, 'err'); this.renderParams(); return; }
    this.snapshot();
    const entries = Object.entries(this.doc.params).map(([k, v]) => [k === old ? nu : k, v]);
    this.doc.params = Object.fromEntries(entries);
    // rewrite references in all expression strings
    const re = new RegExp(`\\b${old}\\b`, 'g');
    const walk = (o) => {
      for (const k of Object.keys(o)) {
        if (typeof o[k] === 'string' && re.test(o[k]) && !['id', 'type', 'sketch', 'line', 'a', 'b', 'point', 'circle', 'center', 'start', 'end', 'p1', 'p2', 'p0', 'c1', 'c2', 'body', 'target', 'mode', 'shape', 'kind'].includes(k)) o[k] = o[k].replace(re, nu);
        else if (o[k] && typeof o[k] === 'object') walk(o[k]);
      }
    };
    walk(this.doc.params);
    walk(this.doc.features);
    this.changed();
  }

  async addParam() {
    const r = await this.ask('New parameter', [{ key: 'name', label: 'Name', value: '', autofocus: true }, { key: 'expr', label: 'Value', value: '10', placeholder: 'number or expression' }]);
    if (!r) return;
    if (!isValidName(r.name) || r.name in this.doc.params) return this.toast('Invalid or duplicate parameter name', 'err');
    this.snapshot();
    this.doc.params[r.name] = r.expr;
    this.changed();
  }

  renderTimeline() {
    const box = document.getElementById('timeline');
    box.innerHTML = '';
    const feats = this.doc.features;
    feats.forEach((f, i) => {
      const st = this.R?.features.get(f.id);
      let badge = null;
      if (f.type === 'sketch' && this.R?.sketches.get(f.id)) {
        const s = this.R.sketches.get(f.id).solve;
        badge = h('span', { class: `badge ${!s.ok ? '' : s.dof ? 'warn' : 'ok'}`, title: 'degrees of freedom' }, !s.ok ? '✗' : s.dof ? `${s.dof}` : '✓');
      }
      const item = h('div', {
        class: `tl-item${this.selected === f.id || this.sketcher.id === f.id ? ' selected' : ''}${f.suppressed ? ' suppressed' : ''}${st && !st.ok ? ' error' : ''}`,
        title: st?.error || st?.warnings?.join('\n') || '',
        onclick: () => {
          // double-click detection survives the re-render caused by the first click
          const dbl = this.lastTlClick?.id === f.id && performance.now() - this.lastTlClick.t < 450;
          this.lastTlClick = { id: f.id, t: performance.now() };
          if (dbl && f.type === 'sketch') this.editSketch(f.id); else this.selectFeature(f.id);
        },
      },
      h('span', { class: 'icon' }, FEATURE_ICONS[f.type] || '•'),
      h('span', { class: 'name' }, `${f.id}`, h('span', { style: 'color:var(--muted);font-size:11px' }, ` ${f.type === 'primitive' ? f.shape : FEATURE_LABELS[f.type] || f.type}${f.mode && f.mode !== 'new' ? ` · ${f.mode}` : ''}`)),
      badge,
      h('span', { class: 'acts' },
        f.type === 'sketch' ? h('button', { title: 'Edit sketch', onclick: (e) => { e.stopPropagation(); this.editSketch(f.id); } }, '✎') : null,
        (f.type === 'sketch' || f.type === 'plane') ? h('button', { title: f.hidden ? 'Show' : 'Hide', onclick: (e) => { e.stopPropagation(); this.snapshot(); f.hidden = f.hidden ? undefined : true; this.changed(); } }, f.hidden ? '◌' : '👁') : null,
        h('button', { title: 'Move up', disabled: i === 0, onclick: (e) => { e.stopPropagation(); this.moveFeature(i, -1); } }, '↑'),
        h('button', { title: 'Move down', disabled: i === feats.length - 1, onclick: (e) => { e.stopPropagation(); this.moveFeature(i, 1); } }, '↓'),
        h('button', { title: 'Delete', onclick: (e) => { e.stopPropagation(); this.deleteFeature(f.id); } }, '✕')));
      box.append(item);
    });
    if (!feats.length) box.append(h('div', { class: 'hint-inline' }, 'Empty. Use ✎ Sketch or a Solid to begin, or load an example (right panel).'));
  }

  renderBodies() {
    const box = document.getElementById('bodies');
    box.innerHTML = '';
    for (const b of this.R?.bodies.values() || []) {
      let vol = '';
      try { vol = `${fmt(b.manifold.volume())} mm³`; } catch { /* */ }
      box.append(h('div', { class: 'body-row' },
        h('input', { type: 'checkbox', checked: b.visible, title: 'Visible (also controls export)', onchange: (e) => this.setBodyMeta(b.id, { visible: e.target.checked ? undefined : false }) }),
        h('input', { type: 'color', value: b.color, onchange: (e) => this.setBodyMeta(b.id, { color: e.target.value }) }),
        h('span', { class: 'name' }, b.name), h('span', { class: 'meta' }, vol)));
    }
    if (!this.R?.bodies.size) box.append(h('div', { class: 'hint-inline' }, 'No bodies yet'));
  }

  setBodyMeta(id, meta) {
    this.snapshot();
    this.doc.bodies ||= {};
    const m = { ...(this.doc.bodies[id] || {}), ...meta };
    for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
    if (Object.keys(m).length) this.doc.bodies[id] = m; else delete this.doc.bodies[id];
    this.changed();
  }

  moveFeature(i, d) {
    this.snapshot();
    const f = this.doc.features;
    [f[i], f[i + d]] = [f[i + d], f[i]];
    this.changed();
  }

  deleteFeature(id) {
    const users = this.doc.features.filter((f) => JSON.stringify({ ...f, id: undefined }).includes(`"${id}"`) && f.id !== id).map((f) => f.id);
    this.snapshot();
    this.doc.features = this.doc.features.filter((f) => f.id !== id);
    if (this.selected === id) this.selected = null;
    if (this.sketcher.id === id) this.sketcher.exit();
    this.changed();
    this.refreshInspector();
    if (users.length) this.toast(`Deleted ${id}. Features that referenced it may now fail: ${users.join(', ')}`, 'warn');
  }

  renameFeature(f, nu) {
    if (!nu || nu === f.id) return;
    if (!/^[A-Za-z_][\w-]*$/.test(nu) || this.doc.features.some((x) => x.id === nu)) { this.toast('Invalid or duplicate id', 'err'); return; }
    this.snapshot();
    const old = f.id;
    const txt = JSON.stringify(this.doc.features).replaceAll(`"${old}"`, `"${nu}"`);
    this.doc.features = JSON.parse(txt);
    if (this.doc.bodies?.[old]) { this.doc.bodies[nu] = this.doc.bodies[old]; delete this.doc.bodies[old]; }
    if (this.selected === old) this.selected = nu;
    this.changed();
    this.refreshInspector();
  }

  // ---- selection / inspector ----
  selectFeature(id) {
    if (id && id === this.selected && !this.sketcher.active) return;
    if (this.sketcher.active) this.finishSketch(false);
    this.endPick();
    this.selected = id;
    this.rebuild();
    this.refreshInspector();
  }

  refreshInspector() {
    if (this.pick?.type === 'measure') return this.inspector.showMeasure(this.pick);
    if (this.sketcher.active) return this.inspector.showSketch();
    const f = this.selected && this.doc.features.find((x) => x.id === this.selected);
    if (f) this.inspector.showFeature(f);
    else this.inspector.showOverview();
  }
  showSketchInspector() { if (this.sketcher.active) this.inspector.showSketch(); }

  // ---- sketch mode ----
  editSketch(id) {
    this.endPick();
    this.selected = null;
    this.sketcher.enter(id);
    this.rebuild();
    this.vp.showOriginPlanes(false);
    this.refreshInspector();
  }

  finishSketch(refresh = true) {
    if (!this.sketcher.active) return;
    const id = this.sketcher.id;
    this.sketcher.exit();
    this.rebuild();
    if (refresh) { this.selected = null; this.refreshInspector(); }
    const sk = this.R?.sketches.get(id);
    if (refresh && sk?.loops.length) this.toast(`Sketch ${id}: ${sk.loops.length} closed loop(s) — ready to Extrude / Revolve`, 'ok');
  }

  newSketch() {
    if (this.sketcher.active) this.finishSketch();
    this.setPick({ type: 'sketch-plane' }, 'Click a plane (XY/XZ/YZ), a datum plane, or a face of the model to sketch on. Esc cancels.');
    this.vp.showOriginPlanes(true);
  }

  createSketchOn(plane) {
    this.endPick();
    this.snapshot();
    const id = uniqueId(this.doc, 'sketch');
    this.doc.features.push({ id, type: 'sketch', plane, entities: [], constraints: [] });
    this.changed();
    this.editSketch(id);
  }

  // ---- picking modes ----
  setPick(p, hint) {
    this.pick = p;
    this.setHint(hint || '');
    this.vp.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    document.body.style.cursor = 'crosshair';
  }
  endPick() {
    if (!this.pick) return;
    this.pick = null;
    if (this.rollback) { this.rollback = null; this.rebuild(); }
    this.vp.helperGroup.clear();
    this.vp.showOriginPlanes(false);
    this.setHint('');
    document.body.style.cursor = '';
    this.vp.dirty();
  }

  pickFace(cb) {
    this.setPick({ type: 'face', cb }, 'Click a face of the model. Esc cancels.');
  }

  startRegionPick(f) {
    this.setPick({ type: 'regions', feature: f.id }, 'Click regions of the sketch to add/remove them from the profile. Esc when done.');
    this.showRegions();
  }

  // ---- edge / face picking for fillet, chamfer, shell (shows the body before the feature) ----
  rollbackBefore(f) {
    const i = this.doc.features.indexOf(f);
    this.rollback = i > 0 ? this.doc.features[i - 1].id : undefined;
    if (!this.rollback) this.rollback = '__none__';
    this.rebuild();
  }

  startEdgePick(f) {
    this.setPick({ type: 'edges', feature: f.id }, 'Click edges to add/remove them (the body is shown before this feature). Esc when done.');
    this.rollbackBefore(f);
  }

  startFacePick(f) {
    this.setPick({ type: 'faces', feature: f.id }, 'Click faces to leave open (removed). Esc when done.');
    this.rollbackBefore(f);
  }

  pickBodyFor(f) {
    const id = f.body || this.R.lastBody;
    return this.R.bodies.get(id);
  }

  showEdges() {
    const p = this.pick;
    const f = this.doc.features.find((x) => x.id === p.feature);
    this.vp.helperGroup.clear();
    const b = f && this.pickBodyFor(f);
    if (!b) return;
    const chains = edgeChains(topology(b.manifold));
    let selected = new Set();
    try { selected = new Set(selectChains(chains, f.edges ?? [], (v) => evaluate(v, (n) => this.R.params[n]), (a) => ({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[a] || a))); } catch { /* empty selection */ }
    p.chains = chains;
    p.selected = selected;
    for (const c of chains) {
      const on = selected.has(c);
      const g = new THREE.BufferGeometry().setFromPoints(c.pts.map((q) => new THREE.Vector3(...q)));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: on ? 0xf59e0b : c.convex ? 0x2f6fed : 0x9b5de5, depthTest: false, transparent: true, opacity: on ? 1 : 0.75 }));
      line.renderOrder = 25;
      this.vp.helperGroup.add(line);
      if (on) {
        const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xf59e0b, size: 4, sizeAttenuation: false, depthTest: false }));
        pts.renderOrder = 26;
        this.vp.helperGroup.add(pts);
      }
    }
    this.vp.dirty();
  }

  showFaceMarks() {
    const p = this.pick;
    const f = this.doc.features.find((x) => x.id === p.feature);
    this.vp.helperGroup.clear();
    for (const o of f?.open || []) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...(o.point || o))]);
      const m = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xf59e0b, size: 12, sizeAttenuation: false, depthTest: false }));
      m.renderOrder = 30;
      this.vp.helperGroup.add(m);
    }
    this.vp.dirty();
  }

  showRegions() {
    const p = this.pick;
    const f = this.doc.features.find((x) => x.id === p.feature);
    const sk = f && this.R?.sketches.get(f.sketch);
    this.vp.helperGroup.clear();
    if (!sk) return;
    const arena = [];
    const track = (o) => { arena.push(o); return o; };
    try {
      const regs = sk.regions(track);
      const chosen = f.profile?.regions || [];
      const key = (r) => r.inside.slice().sort().join('|');
      const chosenKeys = new Set(chosen.map(key));
      p.regions = regs;
      const grp = new THREE.Group();
      grp.matrixAutoUpdate = false;
      grp.matrix.fromArray(frameMatrix(sk.frame));
      for (const r of regs) {
        const tris = this.wasm.triangulate(r.polys);
        const flat = r.polys.flat();
        const pos = new Float32Array(tris.length * 9);
        tris.forEach((t, i) => t.forEach((vi, k) => { pos[i * 9 + k * 3] = flat[vi][0]; pos[i * 9 + k * 3 + 1] = flat[vi][1]; pos[i * 9 + k * 3 + 2] = 0.05; }));
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const on = chosenKeys.has(key(r));
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: on ? 0xf59e0b : 0x2f6fed, transparent: true, opacity: on ? 0.55 : 0.18, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
        m.renderOrder = 20;
        m.userData.region = r;
        grp.add(m);
      }
      grp.updateMatrixWorld(true);
      this.vp.helperGroup.add(grp);
    } finally { arena.forEach((o) => o.delete()); }
    this.vp.dirty();
  }

  onViewportClick(ev) {
    const p = this.pick;
    if (!p) {
      if (this.sketcher.active) return;
      const hit = this.vp.pickBody(ev);
      if (hit) {
        const owner = this.R.bodies.get(hit.body)?.feature;
        this.setStatusRight(`body ${hit.body} · face normal [${hit.normal.map((v) => fmt(v)).join(', ')}] · at [${hit.point.map(fmt).join(', ')}]`);
        if (owner && owner !== this.selected) this.selectFeature(owner);
      }
      return;
    }
    if (p.type === 'sketch-plane') {
      const hit = this.vp.pickBody(ev);
      const plane = this.vp.pickOriginPlane(ev);
      if (hit) return this.createSketchOn({ face: { body: hit.body, point: hit.point.map(r4) } });
      if (plane) return this.createSketchOn(plane);
      return;
    }
    if (p.type === 'face') {
      const hit = this.vp.pickBody(ev);
      if (!hit) return;
      const cb = p.cb;
      this.endPick();
      cb({ body: hit.body, point: hit.point.map(r4) });
      return;
    }
    if (p.type === 'regions') {
      this.vp.raycaster.setFromCamera(this.vp.ndc(ev), this.vp.camera);
      const hit = this.vp.raycaster.intersectObjects(this.vp.helperGroup.children[0]?.children || [], false)[0];
      if (!hit) return;
      const r = hit.object.userData.region;
      const f = this.doc.features.find((x) => x.id === p.feature);
      const key = (x) => x.inside.slice().sort().join('|');
      this.snapshot();
      const list = (f.profile?.regions || []).slice();
      const i = list.findIndex((x) => key(x) === key(r));
      if (i >= 0) list.splice(i, 1); else list.push({ inside: r.inside, outside: r.outside });
      f.profile = { regions: list };
      this.changed();
      this.refreshInspector();
      return;
    }
    if (p.type === 'edges') {
      const r = this.vp.renderer.domElement.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      let best = null, bd = 10;
      for (const c of p.chains || []) {
        for (let i = 0; i + 1 < c.pts.length; i++) {
          const a = this.vp.toScreen(c.pts[i]), b = this.vp.toScreen(c.pts[i + 1]);
          const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
          const t = L ? Math.max(0, Math.min(1, ((mx - a.x) * dx + (my - a.y) * dy) / L)) : 0;
          const d = Math.hypot(a.x + t * dx - mx, a.y + t * dy - my);
          if (d < bd) { bd = d; best = c; }
        }
      }
      if (!best) return;
      const f = this.doc.features.find((x) => x.id === p.feature);
      this.snapshot();
      // normalise the selection to an explicit list of edges, then toggle
      const list = [...(p.selected || [])].map((c) => ({ near: c.mid.map(r4) }));
      const i = [...(p.selected || [])].indexOf(best);
      if (i >= 0) list.splice(i, 1); else list.push({ near: best.mid.map(r4) });
      f.edges = list;
      this.changed();
      this.refreshInspector();
      return;
    }
    if (p.type === 'faces') {
      const hit = this.vp.pickBody(ev);
      if (!hit) return;
      const f = this.doc.features.find((x) => x.id === p.feature);
      this.snapshot();
      const list = (f.open || []).slice();
      // toggle: a click on a face that already has a mark removes it
      const topo = topology(this.R.bodies.get(hit.body).manifold);
      const fid = (pt) => nearestFaceId(topo, pt);
      const target = fid(hit.point);
      const j = list.findIndex((o) => fid(o.point || o) === target);
      if (j >= 0) list.splice(j, 1); else list.push({ point: hit.point.map(r4) });
      if (list.length) f.open = list; else delete f.open;
      this.changed();
      this.refreshInspector();
      return;
    }
    if (p.type === 'measure') {
      const hit = this.vp.pickBody(ev);
      const v = this.vp.pickVertex(ev, 12);
      const pt = v || hit?.point;
      if (!pt) return;
      if (!p.a || p.b) { p.a = pt; p.b = null; p.na = hit?.normal; p.nb = null; }
      else { p.b = pt; p.nb = hit?.normal; }
      p.body = hit?.body;
      this.drawMeasure();
      this.inspector.showMeasure(p);
    }
  }

  drawMeasure() {
    const p = this.pick;
    this.vp.helperGroup.clear();
    const mk = (pt) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...pt)]);
      const m = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xf59e0b, size: 9, sizeAttenuation: false, depthTest: false }));
      m.renderOrder = 30;
      this.vp.helperGroup.add(m);
    };
    if (p.a) mk(p.a);
    if (p.b) {
      mk(p.b);
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...p.a), new THREE.Vector3(...p.b)]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xf59e0b, depthTest: false }));
      l.renderOrder = 30;
      this.vp.helperGroup.add(l);
    }
    this.vp.dirty();
  }

  // ---- feature creation ----
  addFeature(f, edit = true) {
    if (this.sketcher.active) this.finishSketch(false);
    this.endPick();
    this.snapshot();
    this.doc.features.push(f);
    this.selected = edit ? f.id : null;
    this.changed();
    this.refreshInspector();
  }

  lastSketchWithLoops() {
    for (let i = this.doc.features.length - 1; i >= 0; i--) {
      const f = this.doc.features[i];
      if (f.type === 'sketch' && this.R?.sketches.get(f.id)?.loops.length) return f.id;
    }
    return this.doc.features.filter((f) => f.type === 'sketch').pop()?.id;
  }

  lastSketchUnused() {
    const used = new Set(this.doc.features.flatMap((f) => [f.sketch, f.path?.sketch, ...(f.sections || []).map((s) => s.sketch)]).filter(Boolean));
    const sketches = this.doc.features.filter((f) => f.type === 'sketch' && this.R?.sketches.get(f.id)?.loops.length);
    return (sketches.filter((s) => !used.has(s.id)).pop() || sketches.pop())?.id;
  }

  command(cmd) {
    const d = this.doc;
    const sketchId = () => (this.sketcher.active ? this.sketcher.id : this.lastSketchUnused());
    const needSketch = () => { const s = sketchId(); if (!s) this.toast('Draw a sketch with a closed shape first', 'warn'); return s; };
    switch (cmd) {
      case 'new': if (confirm('Start a new empty document? (Undo can bring it back)')) { this.sketcher.exit(); this.selected = null; this.loadDoc(EMPTY()); this.save(); } break;
      case 'open': document.getElementById('file-input').click(); break;
      case 'save': download(`${(d.name || 'model').replace(/\W+/g, '_')}.cad.json`, JSON.stringify(d, null, 2), 'application/json'); break;
      case 'undo': this.undo(); break;
      case 'redo': this.redo(); break;
      case 'add-param': this.addParam(); break;
      case 'new-sketch': this.newSketch(); break;
      case 'new-extrude': { const s = needSketch(); if (s) this.addFeature({ id: uniqueId(d, 'extrude'), type: 'extrude', sketch: s, distance: 10, mode: d.features.some((f) => this.R?.features.get(f.id)?.targets) ? 'add' : 'new' }); break; }
      case 'new-revolve': { const s = needSketch(); if (s) this.addFeature({ id: uniqueId(d, 'revolve'), type: 'revolve', sketch: s, axis: 'v', angle: 360 }); break; }
      case 'new-sweep': { const s = needSketch(); if (s) this.addFeature({ id: uniqueId(d, 'sweep'), type: 'sweep', sketch: s, path: { sketch: '' } }); break; }
      case 'new-loft': {
        const sks = d.features.filter((f) => f.type === 'sketch' && this.R?.sketches.get(f.id)?.loops.length).slice(-2).map((f) => ({ sketch: f.id }));
        this.addFeature({ id: uniqueId(d, 'loft'), type: 'loft', sections: sks });
        break;
      }
      case 'new-fillet': case 'new-chamfer': case 'new-shell': {
        const body = this.R.lastBody || [...this.R.bodies.keys()].pop();
        if (!body) { this.toast('Create a solid first', 'warn'); break; }
        const kind = cmd.slice(4);
        const f = kind === 'fillet' ? { id: uniqueId(d, 'fillet'), type: 'fillet', body, radius: 2, edges: [] }
          : kind === 'chamfer' ? { id: uniqueId(d, 'chamfer'), type: 'chamfer', body, distance: 1, edges: [] }
          : { id: uniqueId(d, 'shell'), type: 'shell', body, thickness: 2 };
        this.addFeature(f);
        if (kind === 'shell') this.startFacePick(f); else this.startEdgePick(f);
        this.refreshInspector();
        break;
      }
      case 'new-box': this.addFeature({ id: uniqueId(d, 'box'), type: 'primitive', shape: 'box', size: [20, 20, 20] }); break;
      case 'new-cylinder': this.addFeature({ id: uniqueId(d, 'cyl'), type: 'primitive', shape: 'cylinder', r: 10, h: 20 }); break;
      case 'new-cone': this.addFeature({ id: uniqueId(d, 'cone'), type: 'primitive', shape: 'cone', r: 10, r2: 0, h: 20 }); break;
      case 'new-sphere': this.addFeature({ id: uniqueId(d, 'sphere'), type: 'primitive', shape: 'sphere', r: 10 }); break;
      case 'new-torus': this.addFeature({ id: uniqueId(d, 'torus'), type: 'primitive', shape: 'torus', R: 15, r: 4 }); break;
      case 'new-pattern': this.addFeature({ id: uniqueId(d, 'pattern'), type: 'pattern', of: [...d.features].reverse().find((f) => ['extrude', 'revolve', 'sweep', 'loft', 'primitive'].includes(f.type))?.id, kind: 'linear', direction: 'x', count: 3, spacing: 20 }); break;
      case 'new-mirror': this.addFeature({ id: uniqueId(d, 'mirror'), type: 'mirror', of: [...this.R.bodies.keys()].pop() ? { body: [...this.R.bodies.keys()].pop() } : undefined, plane: 'YZ' }); break;
      case 'new-transform': this.addFeature({ id: uniqueId(d, 'move'), type: 'transform', body: [...this.R.bodies.keys()].pop(), translate: [10, 0, 0] }); break;
      case 'new-boolean': { const b = [...this.R.bodies.keys()]; this.addFeature({ id: uniqueId(d, 'bool'), type: 'boolean', op: 'union', target: b[0], tools: b.slice(1) }); break; }
      case 'new-split': this.addFeature({ id: uniqueId(d, 'split'), type: 'split', body: [...this.R.bodies.keys()].pop(), plane: 'XY', keep: 'both' }); break;
      case 'new-plane': this.addFeature({ id: uniqueId(d, 'plane'), type: 'plane', base: 'XY', offset: 10 }); break;
      case 'measure':
        if (this.sketcher.active) this.finishSketch();
        this.selected = null;
        this.setPick({ type: 'measure' }, 'Click two points on the model to measure. Esc to exit.');
        this.refreshInspector();
        break;
      case 'export-stl': case 'export-stl-ascii': case 'export-obj': case 'export-3mf': this.exportModel(cmd.slice(7)); break;
      case 'export-sketch-dxf': this.exportSketch('dxf'); break;
      case 'export-sketch-svg': this.exportSketch('svg'); break;
    }
  }

  exportModel(fmtName) {
    const tol = Number(this.doc.settings?.exportTolerance ?? Math.min(0.002, this.doc.settings?.tolerance ?? 0.002));
    const RX = rebuildSync(this.wasm, JSON.parse(JSON.stringify(this.doc)), { tolerance: tol });
    const bodies = [...RX.bodies.values()].filter((b) => b.visible !== false);
    if (!bodies.length) { RX.dispose(); return this.toast('Nothing to export', 'warn'); }
    const data = exportMeshes(bodies, fmtName);
    RX.dispose();
    this.toast(`Exported at ${tol} mm curve tolerance`, 'ok');
    const ext = fmtName === 'stl-ascii' ? 'stl' : fmtName;
    download(`${(this.doc.name || 'model').replace(/\W+/g, '_')}.${ext}`, data, 'application/octet-stream');
  }

  exportSketch(kind) {
    const id = this.sketcher.id || (this.selected && this.doc.features.find((f) => f.id === this.selected && f.type === 'sketch')?.id);
    const sk = id && this.R.sketches.get(id);
    if (!sk) return this.toast('Open or select a sketch first', 'warn');
    download(`${id}.${kind}`, kind === 'dxf' ? sketchToDXF(sk) : sketchToSVG(sk), kind === 'dxf' ? 'application/dxf' : 'image/svg+xml');
  }

  async loadExample(name) {
    try {
      const mod = await import(`/examples/${name}?t=${Date.now()}`);
      const cad = new Builder();
      await mod.default(cad);
      this.sketcher.exit();
      this.selected = null;
      this.loadDoc(cad.toJSON(), { fit: true });
      this.save();
    } catch (e) { this.toast(`Example failed: ${e.message}`, 'err'); }
  }

  // ---- modal prompt ----
  ask(title, fields, help, onChange) {
    return new Promise((resolve) => {
      const modal = document.getElementById('modal');
      modal.innerHTML = '';
      const inputs = {};
      const box = h('div', { class: 'box' }, h('h2', {}, title));
      for (const f of fields) {
        let ctl;
        if (f.type === 'select') ctl = h('select', {}, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)));
        else if (f.type === 'checkbox') ctl = h('input', { type: 'checkbox', checked: !!f.value });
        else ctl = h('input', { value: f.value ?? '', placeholder: f.placeholder || '', style: f.wide ? 'min-width:320px' : '' });
        inputs[f.key] = ctl;
        box.append(h('div', { class: 'field' }, h('label', {}, f.label), h('div', { class: 'ctl' }, ctl)));
      }
      if (help) box.append(h('div', { class: 'hint-inline' }, help));
      const vals = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
      const setPh = (k, v) => { inputs[k].placeholder = v; };
      const close = (v) => { modal.hidden = true; modal.innerHTML = ''; resolve(v); };
      box.append(h('div', { class: 'btn-row' }, h('button', { class: 'primary', onclick: () => close(vals()) }, 'OK'), h('button', { onclick: () => close(null) }, 'Cancel')));
      modal.append(box);
      modal.hidden = false;
      if (onChange) { onChange(vals(), setPh); Object.values(inputs).forEach((el) => el.addEventListener('change', () => onChange(vals(), setPh))); }
      box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') close(vals()); if (e.key === 'Escape') close(null); });
      const af = fields.find((f) => f.autofocus);
      const target = af ? inputs[af.key] : Object.values(inputs)[0];
      target?.focus();
      setTimeout(() => target?.focus(), 30); // after the triggering click finishes
    });
  }

  // ---- persistence / live sync ----
  async connect() {
    const status = document.getElementById('live-status');
    try {
      const r = await fetch('/api/health');
      if (!r.ok) throw new Error();
      const doc = await (await fetch('/api/doc')).json();
      this.server = true;
      this.doc = doc;
      this.doc.params ||= {};
      this.doc.features ||= [];
      const es = new EventSource(`/api/events?client=${CLIENT_ID}`);
      es.onopen = () => { status.textContent = '● live'; status.classList.add('live'); };
      es.onerror = () => { status.textContent = '○ reconnecting'; status.classList.remove('live'); };
      es.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'doc' && msg.source !== CLIENT_ID) {
          const before = this.vp.boundsOfScene().getSize(new THREE.Vector3()).length();
          this.loadDoc(msg.doc);
          const after = this.vp.boundsOfScene().getSize(new THREE.Vector3()).length();
          if (!(after / before > 0.5 && after / before < 1.6)) this.vp.view('fit');
          this.toast(msg.source === 'file' ? 'Model updated from file' : 'Model updated', 'ok');
        }
      };
    } catch {
      status.textContent = '○ local';
      status.title = 'No LazyCAD server — the document is kept in this browser (localStorage)';
      try { const s = localStorage.getItem(LS_KEY); if (s) this.doc = JSON.parse(s); } catch { /* */ }
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const txt = JSON.stringify(this.doc);
      if (this.server) fetch('/api/doc', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID }, body: txt }).catch(() => {});
      else try { localStorage.setItem(LS_KEY, txt); } catch { /* */ }
    }, 300);
  }

  // ---- console / automation API ----
  api() {
    const app = this;
    return {
      get doc() { return app.doc; },
      load(doc) { app.loadDoc(JSON.parse(JSON.stringify(doc)), { fit: true }); app.save(); },
      async run(fn, { append = true } = {}) { const b = new Builder(append ? app.doc : undefined); await fn(b); app.loadDoc(b.toJSON()); app.save(); return app.report(); },
      report() { return buildReport(app.doc, app.R); },
      reportText() { return reportText(buildReport(app.doc, app.R)); },
      setParam(name, expr) { app.snapshot(); app.doc.params[name] = String(expr); app.changed(); return app.R.params[name]; },
      export(format = 'stl') { return exportMeshes([...app.R.bodies.values()], format); },
      stats(id) { const b = app.R.bodies.get(id); return b && bodyStats(b.manifold); },
      view(name) { app.vp.view(name); },
      Builder, evaluate,
    };
  }

  // ---- UI wiring ----
  wireUI() {
    document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => this.command(b.dataset.cmd)));
    document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.view;
      if (v === 'ortho') { this.vp.setOrtho(this.vp.camera !== this.vp.ortho); b.classList.toggle('active', this.vp.camera === this.vp.ortho); return; }
      this.vp.view(v, this.sketcher.frame);
    }));
    document.getElementById('file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try { this.sketcher.exit(); this.selected = null; this.loadDoc(JSON.parse(await file.text()), { fit: true }); this.save(); } catch (err) { this.toast(err.message, 'err'); }
      e.target.value = '';
    });
    const cv = this.vp.renderer.domElement;
    let down = null;
    cv.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    cv.addEventListener('pointerup', (e) => {
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved < 4) this.onViewportClick(e);
    });
    cv.addEventListener('pointermove', (e) => {
      if (this.sketcher.active) return;
      const hit = this.vp.pickBody(e);
      this.setStatusRight(hit ? `[${hit.point.map(fmt).join(', ')}]` : '');
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, textarea, select')) return;
      if (!document.getElementById('modal').hidden) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.command('save'); return; }
      if (this.sketcher.onKey(e)) { e.preventDefault(); return; }
      if (e.key === 'Escape') {
        if (this.pick) { const wasRegions = this.pick.type === 'regions'; this.endPick(); this.refreshInspector(); if (wasRegions) this.rebuild(); }
        else if (this.selected) this.selectFeature(null);
        return;
      }
      if (e.key === 'f') this.vp.view('fit');
      if (e.key === 's') this.command('new-sketch');
      if (e.key === 'e') this.command('new-extrude');
      if (e.key === 'm') this.command('measure');
      if (e.key === 'Delete' && this.selected) this.deleteFeature(this.selected);
    });
  }
}

function uniqueId(doc, prefix) {
  let i = 1;
  while (doc.features.some((f) => f.id === `${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}
const r4 = (v) => Math.round(v * 1e4) / 1e4;

// id of the planar face of a topology nearest to a point
function nearestFaceId(topo, p) {
  let best = -1, bd = Infinity;
  for (let k = 0; k < topo.nt; k++) {
    const [a, b, c] = topo.tri(k).map((i) => topo.V[i]);
    const m = [0, 1, 2].map((d) => (a[d] + b[d] + c[d]) / 3);
    const n = topo.N[k], dd = Math.abs((p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1] + (p[2] - a[2]) * n[2]) + 1e-3 * Math.hypot(p[0] - m[0], p[1] - m[1], p[2] - m[2]);
    if (dd < bd) { bd = dd; best = k; }
  }
  return best < 0 ? -1 : topo.face[best];
}
const esc = (s) => String(s).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function download(name, data, type) {
  const blob = new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const app = new App();
app.init().catch((e) => { console.error(e); document.getElementById('status-left').textContent = `Failed to start: ${e.message}`; });
export default app;
