// Right-hand inspector: generic form fields + per-feature editors.

import { evaluate } from '../core/expr.js';
import { bodyStats } from '../core/kernel.js';
import { fmt } from './sketcher.js';

const SOLID_TYPES = new Set(['extrude', 'revolve', 'sweep', 'loft', 'primitive']);
const MODES = [['new', 'New body'], ['add', 'Join (add)'], ['cut', 'Cut (subtract)'], ['intersect', 'Intersect']];

export const FEATURE_LABELS = {
  plane: 'Plane', sketch: 'Sketch', extrude: 'Extrude', revolve: 'Revolve', sweep: 'Sweep', loft: 'Loft',
  primitive: 'Solid', fillet: 'Fillet', chamfer: 'Chamfer', shell: 'Shell', pattern: 'Pattern', mirror: 'Mirror', transform: 'Move/Rotate', boolean: 'Boolean', split: 'Split', delete: 'Delete bodies',
};
export const FEATURE_ICONS = {
  plane: '▱', sketch: '✎', extrude: '⬆', revolve: '↻', sweep: '〰', loft: '⧖', primitive: '■', fillet: '◜', chamfer: '◸', shell: '▢', pattern: '⁂', mirror: '⇋',
  transform: '✥', boolean: '∪', split: '✂', delete: '✕',
};

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
export { h };

const asValue = (s) => {
  const t = String(s).trim();
  if (t === '') return undefined;
  return /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i.test(t) ? Number(t) : t;
};

export class Inspector {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('inspector');
  }

  clear() { this.el.innerHTML = ''; }

  // Set f[key] = value through the undo system.
  set(f, key, value) {
    this.app.snapshot();
    if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) delete f[key];
    else f[key] = value;
    this.app.changed();
    this.app.refreshInspector();
  }

  evalStr(v) {
    try { const x = evaluate(v, (n) => this.app.R?.params[n]); return Number.isFinite(x) ? fmt(x) : '?'; } catch { return '✗'; }
  }

  // ---- generic controls ----
  field(label, ctl, title) { return h('div', { class: 'field', title }, h('label', {}, label), h('div', { class: 'ctl' }, ctl)); }

  expr(f, key, label, { placeholder = '', title, def } = {}) {
    const cur = f[key];
    const out = h('span', { class: 'evald' }, cur !== undefined && typeof cur !== 'number' ? `= ${this.evalStr(cur)}` : '');
    const inp = h('input', { value: cur ?? '', placeholder: placeholder || (def !== undefined ? String(def) : ''),
      onchange: (e) => this.set(f, key, asValue(e.target.value)),
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation(); } });
    const wrap = this.field(label, [inp, out], title);
    if (cur !== undefined && this.evalStr(cur) === '✗') wrap.classList.add('bad');
    return wrap;
  }

  select(f, key, label, options, { def, title, allowEmpty } = {}) {
    const cur = f[key] ?? def ?? '';
    const sel = h('select', { onchange: (e) => this.set(f, key, e.target.value === '' ? undefined : e.target.value) },
      allowEmpty ? h('option', { value: '' }, allowEmpty) : null,
      options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(cur) }, l)));
    return this.field(label, sel, title);
  }

  bool(f, key, label, title) {
    return this.field(label, h('input', { type: 'checkbox', checked: !!f[key], onchange: (e) => this.set(f, key, e.target.checked || undefined) }), title);
  }

  vec3(f, key, label, def = [0, 0, 0]) {
    const cur = f[key] || def;
    const inputs = [0, 1, 2].map((i) => h('input', { value: cur[i] ?? 0, title: 'xyz'[i],
      onkeydown: (e) => e.stopPropagation(),
      onchange: () => this.set(f, key, inputs.map((x) => asValue(x.value) ?? 0)) }));
    return this.field(label, h('div', { class: 'vec3' }, inputs));
  }

  sketchOptions() { return this.app.doc.features.filter((x) => x.type === 'sketch').map((x) => [x.id, x.id]); }
  bodyOptions() { return [...(this.app.R?.bodies.keys() || [])].map((b) => [b, b]); }
  planeOptions(exclude) {
    const opts = [['XY', 'XY (top)'], ['XZ', 'XZ (front)'], ['YZ', 'YZ (right)'], ['-XY', '−XY'], ['-XZ', '−XZ'], ['-YZ', '−YZ']];
    for (const x of this.app.doc.features) if ((x.type === 'plane' || x.type === 'sketch') && x.id !== exclude) opts.push([x.id, `${x.id} (${x.type})`]);
    return opts;
  }

  // ---- feature editors ----
  showFeature(f) {
    const app = this.app;
    this.clear();
    const st = app.R?.features.get(f.id);
    const head = h('h2', {}, h('span', {}, FEATURE_ICONS[f.type] || '•'), `${FEATURE_LABELS[f.type] || f.type}`,
      h('input', { value: f.id, style: 'flex:1;font-weight:600', title: 'Feature id', onkeydown: (e) => e.stopPropagation(),
        onchange: (e) => app.renameFeature(f, e.target.value.trim()) }));
    this.el.append(head);
    if (st?.error) this.el.append(h('div', { class: 'msg err' }, st.error));
    for (const w of st?.warnings || []) this.el.append(h('div', { class: 'msg warn' }, w));
    const body = h('div');
    this.el.append(body);
    const add = (...els) => body.append(...els.flat().filter(Boolean));
    const mode = f.mode || 'new';

    const modeFields = () => [
      this.field('Operation', h('select', { onchange: (e) => {
        app.snapshot();
        f.mode = e.target.value;
        // Cutting from a sketch on a face: material is behind the face, so reverse by default.
        const sk = app.doc.features.find((x) => x.id === f.sketch);
        if (f.mode === 'cut' && sk?.plane?.face && !f.symmetric && f.distance !== 'through') f.reverse = true;
        if (f.mode !== 'cut' && sk?.plane?.face) delete f.reverse;
        app.changed(); app.refreshInspector();
      } }, MODES.map(([v, l]) => h('option', { value: v, selected: v === mode }, l)))),
      mode === 'new' ? this.textField(f, 'body', 'Body name', f.id) : null,
      mode !== 'new' ? this.select(f, 'target', 'Target body', this.bodyOptions(), { allowEmpty: mode === 'cut' ? 'All bodies' : 'Last body' }) : null,
    ];

    switch (f.type) {
      case 'plane': {
        const fromFace = !!f.face;
        add(h('div', { class: 'btn-row' },
          h('button', { onclick: () => app.pickFace((face) => { app.snapshot(); delete f.base; f.face = face; app.changed(); app.refreshInspector(); }) }, '⌖ Place on face…'),
          fromFace ? h('button', { onclick: () => { app.snapshot(); delete f.face; f.base = 'XY'; app.changed(); app.refreshInspector(); } }, 'Use base plane') : null));
        if (fromFace) add(h('div', { class: 'hint-inline' }, `On face of “${f.face.body}” near [${f.face.point.map(fmt).join(', ')}]`));
        else add(this.select(f, 'base', 'Base plane', this.planeOptions(f.id), { def: 'XY' }));
        add(this.expr(f, 'offset', 'Offset', { placeholder: '0', title: 'Distance along the plane normal (after rotation)' }));
        add(this.rotFields(f));
        add(this.bool(f, 'flip', 'Flip normal'));
        add(h('div', { class: 'hint-inline' }, 'Order: base → rotate about the plane’s own X/Y axes → offset along the new normal.'));
        break;
      }
      case 'sketch': {
        const planeDesc = typeof f.plane === 'object' ? (f.plane.face ? `face of ${f.plane.face.body}` : 'custom') : f.plane;
        add(h('div', { class: 'sub' }, `Plane: ${planeDesc}`));
        if (typeof f.plane !== 'object') add(this.select(f, 'plane', 'Plane', this.planeOptions(f.id), { def: 'XY' }));
        const sk = app.R?.sketches.get(f.id);
        if (sk) add(h('div', { class: 'stats' }, `${f.entities.length} entities, ${f.constraints.length} constraints\n${sk.solve.ok ? (sk.solve.dof ? `${sk.solve.dof} DOF free` : 'fully constrained') : 'CONFLICTING'}\n${sk.loops.length} closed loops`));
        add(h('div', { class: 'btn-row' }, h('button', { class: 'primary', onclick: () => app.editSketch(f.id) }, '✎ Edit sketch'),
          h('button', { onclick: () => this.set(f, 'hidden', f.hidden ? undefined : true) }, f.hidden ? 'Show' : 'Hide')));
        break;
      }
      case 'extrude':
        add(this.select(f, 'sketch', 'Sketch', this.sketchOptions()));
        add(this.profileField(f));
        add(this.expr(f, 'distance', 'Distance', { title: 'mm; negative goes the other way; "through" = through all' }));
        add(this.bool(f, 'symmetric', 'Symmetric'));
        if (!f.symmetric) add(this.expr(f, 'distance2', 'Other side', { placeholder: '0' }));
        add(this.bool(f, 'reverse', 'Reverse'));
        add(this.directionField(f));
        add(...modeFields());
        add(h('details', {}, h('summary', {}, 'Twist / taper'),
          this.expr(f, 'twist', 'Twist °', { placeholder: '0' }),
          this.expr(f, 'scaleTop', 'Top scale', { placeholder: '1', title: 'Scale of the far end, about the sketch origin' }),
          this.expr(f, 'offset', 'Start offset', { placeholder: '0' })));
        break;
      case 'revolve':
        add(this.select(f, 'sketch', 'Sketch', this.sketchOptions()));
        add(this.profileField(f));
        add(this.revolveAxisField(f));
        add(this.expr(f, 'angle', 'Angle °', { placeholder: '360' }));
        add(this.bool(f, 'symmetric', 'Symmetric'));
        add(...modeFields());
        break;
      case 'sweep':
        add(this.select(f, 'sketch', 'Profile sketch', this.sketchOptions()));
        add(this.profileField(f));
        add(this.pathField(f));
        add(...modeFields());
        break;
      case 'loft': {
        add(this.sectionsField(f));
        const smoothDefault = (f.sections || []).length > 2 || !!f.startTangent || !!f.endTangent;
        add(this.field('Smooth', h('input', { type: 'checkbox', checked: f.ruled ? false : (f.smooth ?? smoothDefault),
          onchange: (e) => { app.snapshot(); if (e.target.checked) { delete f.ruled; f.smooth = true; } else { f.ruled = true; delete f.smooth; } app.changed(); app.refreshInspector(); } }), 'Curved through the sections (off = straight/ruled between sections)'));
        add(this.expr(f, 'startTangent', 'Start tangency', { placeholder: '0', title: 'Leave the first section along its normal (weight, e.g. 1)' }));
        add(this.expr(f, 'endTangent', 'End tangency', { placeholder: '0', title: 'Arrive at the last section along its normal (weight)' }));
        add(...modeFields());
        break;
      }
      case 'fillet':
      case 'chamfer':
        add(this.select(f, 'body', 'Body', this.bodyOptions(), { allowEmpty: 'Last body' }));
        if (f.type === 'fillet') add(this.expr(f, 'radius', 'Radius'));
        else add(this.expr(f, 'distance', 'Distance'), this.expr(f, 'distance2', 'Distance 2', { placeholder: 'same', title: 'Second face (asymmetric chamfer)' }));
        add(this.edgesField(f));
        break;
      case 'shell': {
        add(this.select(f, 'body', 'Body', this.bodyOptions(), { allowEmpty: 'Last body' }));
        add(this.expr(f, 'thickness', 'Thickness'));
        add(this.bool(f, 'outside', 'Grow outward', 'Add the wall outside the current surface instead of hollowing inward'));
        const n = (f.open || []).length;
        add(h('div', { class: 'btn-row' },
          h('button', { class: app.pick?.type === 'faces' ? 'active' : '', onclick: () => (app.pick?.type === 'faces' ? (app.endPick(), app.refreshInspector()) : app.startFacePick(f)) }, app.pick?.type === 'faces' ? '✓ Done picking' : `⌖ Open faces (${n})`),
          n ? h('button', { onclick: () => this.set(f, 'open', undefined) }, 'Clear') : null));
        add(h('div', { class: 'hint-inline' }, 'Open faces are removed (e.g. the top of a box). With none, the solid becomes a closed hollow.'));
        break;
      }
      case 'primitive': {
        add(this.select(f, 'shape', 'Shape', [['box', 'Box'], ['cylinder', 'Cylinder'], ['cone', 'Cone'], ['sphere', 'Sphere'], ['torus', 'Torus']]));
        if (f.shape === 'box') add(this.vec3(f, 'size', 'Size', [10, 10, 10]));
        if (['cylinder', 'cone'].includes(f.shape)) add(this.expr(f, 'r', 'Radius'), this.expr(f, 'r2', 'Top radius', { placeholder: f.shape === 'cone' ? '0' : 'same' }), this.expr(f, 'h', 'Height'));
        if (f.shape === 'sphere') add(this.expr(f, 'r', 'Radius'));
        if (f.shape === 'torus') add(this.expr(f, 'R', 'Major R'), this.expr(f, 'r', 'Minor r'));
        if (f.shape !== 'sphere' && f.shape !== 'torus') add(this.bool(f, 'center', 'Centered'));
        add(this.vec3(f, 'at', 'Position'), this.vec3(f, 'rotate', 'Rotate XYZ°'));
        add(...modeFields());
        break;
      }
      case 'pattern':
        add(this.sourceField(f));
        add(this.select(f, 'kind', 'Kind', [['linear', 'Linear'], ['circular', 'Circular']], { def: 'linear' }));
        if ((f.kind || 'linear') === 'linear') {
          add(this.axisSelect(f, 'direction', 'Direction', 'x'));
          add(this.expr(f, 'count', 'Count', { def: 2 }), this.expr(f, 'spacing', 'Spacing', { def: 10 }));
          add(h('details', { open: !!f.direction2 }, h('summary', {}, 'Second direction'),
            this.axisSelect(f, 'direction2', 'Direction 2', undefined, true), this.expr(f, 'count2', 'Count 2', { def: 1 }), this.expr(f, 'spacing2', 'Spacing 2', { def: 10 })));
        } else {
          add(this.axisSelect(f, 'axis', 'Axis', 'z'));
          add(this.expr(f, 'count', 'Count', { def: 4 }), this.expr(f, 'angle', 'Total angle °', { placeholder: '360' }));
        }
        break;
      case 'mirror':
        add(this.sourceField(f));
        add(this.select(f, 'plane', 'Mirror plane', this.planeOptions(f.id), { def: 'YZ' }));
        break;
      case 'transform': {
        add(this.select(f, 'body', 'Body', this.bodyOptions()));
        add(this.vec3(f, 'translate', 'Translate'));
        const rot = f.rotate || {};
        add(this.field('Rotate axis', h('select', { onchange: (e) => this.set(f, 'rotate', { ...rot, axis: e.target.value, angle: rot.angle ?? 0 }) },
          ['x', 'y', 'z'].map((a) => h('option', { value: a, selected: (rot.axis || 'z') === a }, a.toUpperCase())))));
        add(this.field('Rotate °', h('input', { value: rot.angle ?? '', placeholder: '0', onkeydown: (e) => e.stopPropagation(),
          onchange: (e) => this.set(f, 'rotate', asValue(e.target.value) === undefined ? undefined : { axis: rot.axis || 'z', ...rot, angle: asValue(e.target.value) }) })));
        add(this.bool(f, 'copy', 'Copy'));
        break;
      }
      case 'boolean':
        add(this.select(f, 'op', 'Operation', [['union', 'Union'], ['subtract', 'Subtract'], ['intersect', 'Intersect']], { def: 'union' }));
        add(this.select(f, 'target', 'Target', this.bodyOptions()));
        add(this.chipsField(f, 'tools', 'Tools', this.bodyOptions().map(([b]) => b).filter((b) => b !== f.target)));
        add(this.bool(f, 'keepTools', 'Keep tools'));
        break;
      case 'split':
        add(this.select(f, 'body', 'Body', this.bodyOptions()));
        add(this.select(f, 'plane', 'Plane', this.planeOptions(f.id), { def: 'XY' }));
        add(this.select(f, 'keep', 'Keep', [['both', 'Both (2 bodies)'], ['front', 'Front side'], ['back', 'Back side']], { def: 'both' }));
        break;
      case 'delete':
        add(this.chipsField(f, 'bodies', 'Bodies', this.bodyOptions().map(([b]) => b)));
        break;
    }

    // Common footer
    const json = h('textarea', { rows: 10, onkeydown: (e) => e.stopPropagation() }, JSON.stringify(f, null, 2));
    this.el.append(
      h('div', { class: 'btn-row' },
        h('button', { class: 'primary', onclick: () => app.selectFeature(null) }, '✓ Done'),
        h('button', { onclick: () => this.set(f, 'suppressed', f.suppressed ? undefined : true) }, f.suppressed ? 'Unsuppress' : 'Suppress'),
        h('button', { class: 'danger', onclick: () => app.deleteFeature(f.id) }, 'Delete')),
      h('details', {}, h('summary', {}, 'Edit as JSON'), json,
        h('div', { class: 'btn-row' }, h('button', { onclick: () => {
          try { const nf = JSON.parse(json.value); app.snapshot(); Object.keys(f).forEach((k) => delete f[k]); Object.assign(f, nf); app.changed(); app.refreshInspector(); }
          catch (e) { app.toast(e.message, 'err'); }
        } }, 'Apply JSON'))));
  }

  edgesField(f) {
    const app = this.app;
    const e = f.edges;
    const kind = e === 'all' ? 'all' : Array.isArray(e) && e.every((x) => x && x.near) ? 'picked'
      : e && typeof e === 'object' && !Array.isArray(e) ? (e.convex ? 'convex' : e.concave ? 'concave' : e.parallel ? `par-${e.parallel}` : 'custom') : 'custom';
    const presets = [['picked', 'Picked edges'], ['all', 'All edges'], ['convex', 'All outside (convex) edges'], ['concave', 'All inside (concave) edges'],
      ['par-x', 'Straight edges ∥ X'], ['par-y', 'Straight edges ∥ Y'], ['par-z', 'Straight edges ∥ Z'], ['custom', 'Custom (JSON)']];
    const sel = h('select', { onchange: (ev) => {
      const v = ev.target.value;
      const val = v === 'picked' ? [] : v === 'all' ? 'all' : v === 'convex' ? { convex: true } : v === 'concave' ? { concave: true } : v.startsWith('par-') ? { parallel: v.slice(4) } : (f.edges ?? []);
      app.snapshot(); f.edges = val; app.changed(); app.refreshInspector();
      if (v === 'picked') app.startEdgePick(f);
    } }, presets.map(([v, l]) => h('option', { value: v, selected: v === kind }, l)));
    const st = app.R?.features.get(f.id);
    const out = [this.field('Edges', sel)];
    out.push(h('div', { class: 'btn-row' },
      h('button', { class: app.pick?.type === 'edges' ? 'active' : '', onclick: () => (app.pick?.type === 'edges' ? (app.endPick(), app.refreshInspector()) : app.startEdgePick(f)) },
        app.pick?.type === 'edges' ? '✓ Done picking' : `⌖ Pick edges${kind === 'picked' ? ` (${e.length})` : ''}`),
      st?.edges !== undefined ? h('span', { class: 'hint-inline', style: 'margin:0;align-self:center' }, `${st.edges} edge chain${st.edges === 1 ? '' : 's'} selected`) : null));
    if (kind === 'custom') {
      const ta = h('textarea', { rows: 3, onkeydown: (ev) => ev.stopPropagation() }, JSON.stringify(e ?? []));
      out.push(ta, h('div', { class: 'hint-inline' }, 'e.g. {"z": 10} (edges at z = 10), {"box": {"min": [..], "max": [..]}}, {"near": [x, y, z]}, {"parallel": "z", "convex": true}'),
        h('button', { onclick: () => { try { this.set(f, 'edges', JSON.parse(ta.value)); } catch (err) { app.toast(err.message, 'err'); } } }, 'Apply'));
    }
    out.push(h('div', { class: 'hint-inline' }, 'Blue = outside edges, purple = inside edges, orange = selected. Edges that join smoothly are picked as one chain.'));
    return out;
  }

  textField(f, key, label, placeholder) {
    return this.field(label, h('input', { value: f[key] ?? '', placeholder, onkeydown: (e) => e.stopPropagation(), onchange: (e) => this.set(f, key, e.target.value.trim() || undefined) }));
  }

  rotFields(f) {
    const rot = Array.isArray(f.rotate) ? Object.fromEntries(f.rotate.map((r) => (Array.isArray(r) ? r : [r.axis, r.angle]))) : (f.rotate || {});
    const mk = (axis) => this.field(`Tilt about ${axis.toUpperCase()}°`, h('input', { value: rot[axis] ?? '', placeholder: '0', onkeydown: (e) => e.stopPropagation(),
      onchange: (e) => {
        const r = { ...rot };
        const v = asValue(e.target.value);
        if (v === undefined) delete r[axis]; else r[axis] = v;
        this.set(f, 'rotate', Object.keys(r).length ? r : undefined);
      } }), 'Rotate the plane about its own axis');
    return [mk('x'), mk('y')];
  }

  chipsField(f, key, label, options) {
    const cur = new Set([].concat(f[key] || []));
    return this.field(label, h('div', { class: 'chips' }, options.map((o) => h('span', {
      class: `chip${cur.has(o) ? ' on' : ''}`,
      onclick: () => { cur.has(o) ? cur.delete(o) : cur.add(o); this.set(f, key, [...cur]); },
    }, o))));
  }

  profileField(f) {
    const app = this.app;
    const p = f.profile;
    const kind = p === undefined || p === 'all' || p === 'auto' ? 'all' : p?.regions ? 'regions' : 'custom';
    const sel = h('select', { onchange: (e) => {
      const v = e.target.value;
      if (v === 'all') this.set(f, 'profile', undefined);
      else if (v === 'regions') { this.set(f, 'profile', { regions: [] }); app.startRegionPick(f); }
      else this.set(f, 'profile', { union: (app.R?.sketches.get(f.sketch)?.loops || []).map((l) => l.id) });
    } }, [['all', 'All closed regions'], ['regions', 'Picked regions'], ['custom', 'Expression (JSON)']].map(([v, l]) => h('option', { value: v, selected: v === kind }, l)));
    const out = [this.field('Profile', sel)];
    if (kind === 'regions') {
      out.push(h('div', { class: 'btn-row' },
        h('button', { class: app.pick?.type === 'regions' ? 'active' : '', onclick: () => app.startRegionPick(f) }, `⌖ Pick regions (${p.regions.length})`)));
    }
    if (kind === 'custom') {
      const ta = h('textarea', { rows: 3, onkeydown: (e) => e.stopPropagation() }, JSON.stringify(p));
      out.push(ta, h('div', { class: 'hint-inline' }, 'e.g. {"subtract":["l1","c1"]}, {"union":[...]}, {"intersect":[...]}, {"point":[u,v]}, {"offset":2,"of":"l1"}'),
        h('button', { onclick: () => { try { this.set(f, 'profile', JSON.parse(ta.value)); } catch (e) { app.toast(e.message, 'err'); } } }, 'Apply'));
      const sk = app.R?.sketches.get(f.sketch);
      if (sk?.loops.length) out.push(h('div', { class: 'hint-inline' }, `Loops: ${sk.loops.map((l) => l.id).join(' · ')}`));
    }
    return out;
  }

  directionField(f) {
    const d = f.direction;
    const kind = !d || d === 'normal' ? 'normal' : typeof d === 'string' ? d : Array.isArray(d) ? 'vector' : d.tilt ? 'tilt' : d.line ? 'line' : 'normal';
    const sel = h('select', { onchange: (e) => {
      const v = e.target.value;
      this.set(f, 'direction', v === 'normal' ? undefined : v === 'vector' ? [0, 0, 1] : v === 'tilt' ? { tilt: [0, 15] } : v === 'line' ? { sketch: f.sketch, line: '' } : v);
    } }, [['normal', 'Sketch normal'], ['x', 'World X'], ['y', 'World Y'], ['z', 'World Z'], ['tilt', 'Tilted from normal'], ['vector', 'Vector'], ['line', 'Along a sketch line']]
      .map(([v, l]) => h('option', { value: v, selected: v === kind }, l)));
    const out = [this.field('Direction', sel)];
    if (kind === 'vector') out.push(this.vec3(f, 'direction', 'Vector'));
    if (kind === 'tilt') {
      const t = d.tilt;
      const mk = (i, lab) => this.field(lab, h('input', { value: t[i], onkeydown: (e) => e.stopPropagation(), onchange: (e) => { const nt = t.slice(); nt[i] = asValue(e.target.value) ?? 0; this.set(f, 'direction', { tilt: nt }); } }));
      out.push(mk(0, 'Tilt about X°'), mk(1, 'Tilt about Y°'));
    }
    if (kind === 'line') {
      const sk = this.app.doc.features.find((x) => x.id === (d.sketch || f.sketch));
      out.push(this.field('Line sketch', h('select', { onchange: (e) => this.set(f, 'direction', { ...d, sketch: e.target.value }) }, this.sketchOptions().map(([v]) => h('option', { value: v, selected: v === d.sketch }, v)))));
      out.push(this.field('Line', h('select', { onchange: (e) => this.set(f, 'direction', { ...d, line: e.target.value }) }, h('option', { value: '' }, '—'),
        (sk?.entities || []).filter((e) => e.type === 'line').map((e) => h('option', { value: e.id, selected: e.id === d.line }, e.id)))));
    }
    return out;
  }

  revolveAxisField(f) {
    const sk = this.app.doc.features.find((x) => x.id === f.sketch);
    const lines = (sk?.entities || []).filter((e) => e.type === 'line');
    const cur = typeof f.axis === 'string' ? f.axis : f.axis ? 'custom' : 'v';
    const opts = [['v', 'Sketch vertical (V) axis'], ['u', 'Sketch horizontal (U) axis'], ...lines.map((l) => [l.id, `Line ${l.id}${l.construction ? ' (construction)' : ''}`]), ['x', 'World X'], ['y', 'World Y'], ['z', 'World Z']];
    return this.select(f, 'axis', 'Axis', opts, { def: cur });
  }

  axisSelect(f, key, label, def, optional) {
    const v = f[key];
    const kind = v === undefined ? (optional ? '' : def) : typeof v === 'string' ? v : 'vector';
    const sel = h('select', { onchange: (e) => this.set(f, key, e.target.value === '' ? undefined : e.target.value === 'vector' ? [1, 0, 0] : e.target.value) },
      optional ? h('option', { value: '' }, '—') : null,
      [['x', 'X'], ['y', 'Y'], ['z', 'Z'], ['vector', 'Vector…']].map(([a, l]) => h('option', { value: a, selected: a === kind }, l)));
    const out = [this.field(label, sel)];
    if (kind === 'vector') out.push(this.vec3(f, key, 'Vector'));
    return out;
  }

  sourceField(f) {
    const feats = this.app.doc.features.filter((x) => SOLID_TYPES.has(x.type) && x.id !== f.id);
    const cur = f.of && typeof f.of === 'object' && !Array.isArray(f.of) ? `body:${f.of.body}` : f.of ?? '';
    const sel = h('select', { onchange: (e) => {
      const v = e.target.value;
      this.set(f, 'of', v.startsWith('body:') ? { body: v.slice(5) } : v || undefined);
    } }, h('option', { value: '' }, '—'),
    h('optgroup', { label: 'Features (re-applied with their operation)' }, feats.map((x) => h('option', { value: x.id, selected: cur === x.id }, `${x.id} (${x.type}${x.mode && x.mode !== 'new' ? `, ${x.mode}` : ''})`))),
    h('optgroup', { label: 'Whole bodies' }, this.bodyOptions().map(([b]) => h('option', { value: `body:${b}`, selected: cur === `body:${b}` }, `body ${b}`))));
    return this.field('Source', sel, 'Patterning a cut feature repeats the cut; patterning a body copies it');
  }

  pathField(f) {
    const p = f.path || {};
    const kind = p.helix ? 'helix' : p.points ? 'points' : 'sketch';
    const setPath = (np) => this.set(f, 'path', np);
    const out = [this.field('Path', h('select', { onchange: (e) => setPath(e.target.value === 'helix' ? { helix: { pitch: 5, turns: 4 } } : e.target.value === 'points' ? { points: [[0, 0, 0], [0, 0, 20]] } : { sketch: '' }) },
      [['sketch', 'Sketch curves'], ['helix', 'Helix'], ['points', '3D polyline']].map(([v, l]) => h('option', { value: v, selected: v === kind }, l))))];
    if (kind === 'sketch') {
      out.push(this.field('Path sketch', h('select', { onchange: (e) => setPath({ sketch: e.target.value }) }, h('option', { value: '' }, '—'),
        this.sketchOptions().filter(([v]) => v !== f.sketch).map(([v]) => h('option', { value: v, selected: v === p.sketch }, v)))));
      const sk = this.app.doc.features.find((x) => x.id === p.sketch);
      if (sk) {
        const curves = sk.entities.filter((e) => ['line', 'arc', 'bezier', 'circle'].includes(e.type) && !e.construction).map((e) => e.id);
        const on = new Set(p.entities || curves);
        out.push(this.field('Curves', h('div', { class: 'chips' }, curves.map((c) => h('span', { class: `chip${on.has(c) ? ' on' : ''}`, onclick: () => {
          on.has(c) ? on.delete(c) : on.add(c);
          setPath({ sketch: p.sketch, ...(on.size === curves.length ? {} : { entities: curves.filter((x) => on.has(x)) }) });
        } }, c)))));
      }
    } else if (kind === 'helix') {
      const hx = p.helix;
      const hf = (key, label, def) => this.field(label, h('input', { value: hx[key] ?? '', placeholder: def, onkeydown: (e) => e.stopPropagation(), onchange: (e) => setPath({ helix: { ...hx, [key]: asValue(e.target.value) } }) }));
      out.push(hf('pitch', 'Pitch', '5'), hf('turns', 'Turns', '4'));
      out.push(this.field('Axis', h('select', { onchange: (e) => setPath({ helix: { ...hx, axis: e.target.value } }) }, ['x', 'y', 'z'].map((a) => h('option', { value: a, selected: (hx.axis || 'z') === a }, a.toUpperCase())))));
      const o = hx.origin || [0, 0, 0];
      const ins = [0, 1, 2].map((i) => h('input', { value: o[i], onkeydown: (e) => e.stopPropagation(), onchange: () => setPath({ helix: { ...hx, origin: ins.map((x) => asValue(x.value) ?? 0) } }) }));
      out.push(this.field('Axis origin', h('div', { class: 'vec3' }, ins)));
      out.push(this.field('Left-handed', h('input', { type: 'checkbox', checked: !!hx.leftHanded, onchange: (e) => setPath({ helix: { ...hx, leftHanded: e.target.checked || undefined } }) })));
      out.push(h('div', { class: 'hint-inline' }, 'The profile is screwed around the axis: draw it in a plane containing the axis (e.g. XZ for a Z helix).'));
    } else {
      const ta = h('textarea', { rows: 4, onkeydown: (e) => e.stopPropagation() }, JSON.stringify(p.points));
      out.push(ta, h('button', { onclick: () => { try { setPath({ points: JSON.parse(ta.value), closed: p.closed }); } catch (e) { this.app.toast(e.message, 'err'); } } }, 'Apply points'));
    }
    return out;
  }

  sectionsField(f) {
    const secs = f.sections || [];
    const opts = this.sketchOptions();
    const rows = secs.map((s, i) => h('div', { class: 'field' }, h('label', {}, `Section ${i + 1}`), h('div', { class: 'ctl' },
      h('select', { onchange: (e) => { const n = secs.slice(); n[i] = { ...s, sketch: e.target.value }; this.set(f, 'sections', n); } }, opts.map(([v]) => h('option', { value: v, selected: v === s.sketch }, v))),
      h('button', { class: 'mini', disabled: i === 0, onclick: () => { const n = secs.slice(); [n[i - 1], n[i]] = [n[i], n[i - 1]]; this.set(f, 'sections', n); } }, '↑'),
      h('button', { class: 'mini', onclick: () => this.set(f, 'sections', secs.filter((_, k) => k !== i)) }, '✕'))));
    return [...rows, h('button', { onclick: () => this.set(f, 'sections', [...secs, { sketch: opts.find(([v]) => !secs.some((s) => s.sketch === v))?.[0] || opts[0]?.[0] }]) }, '+ Add section')];
  }

  // ---- overview (nothing selected) ----
  showOverview() {
    const app = this.app;
    this.clear();
    this.el.append(h('h2', {}, app.doc.name || 'Untitled model'));
    const R = app.R;
    if (R?.errors.length) this.el.append(h('div', { class: 'msg err' }, `${R.errors.length} error(s): ${R.errors.map((e) => `${e.id}: ${e.message}`).join('; ')}`));
    const bodies = R ? [...R.bodies.values()] : [];
    if (bodies.length) {
      for (const b of bodies) {
        const s = bodyStats(b.manifold);
        this.el.append(h('div', { class: 'sub' }, `Body ${b.id}`), h('div', { class: 'stats' },
          s.empty ? 'empty' : `size   ${s.bbox.size.map(fmt).join(' × ')} mm\nmin    ${s.bbox.min.map(fmt).join(', ')}\nmax    ${s.bbox.max.map(fmt).join(', ')}\nvolume ${fmt(s.volume)} mm³\narea   ${fmt(s.surfaceArea)} mm²\ncentroid ${s.centroid?.map(fmt).join(', ')}\nsolids ${s.components}, genus ${s.genus}`));
      }
    } else {
      this.el.append(h('div', { class: 'msg ok' }, 'Start with ✎ Sketch (pick a plane), draw a closed shape, then Extrude.'));
    }
    const settings = app.doc.settings || {};
    const setSetting = (k, v) => { app.snapshot(); app.doc.settings = { ...settings }; if (v === undefined) delete app.doc.settings[k]; else app.doc.settings[k] = v; if (!Object.keys(app.doc.settings).length) delete app.doc.settings; app.changed(); app.refreshInspector(); };
    const numIn = (k, ph, title) => h('input', { value: settings[k] ?? '', placeholder: ph, title, onkeydown: (e) => e.stopPropagation(),
      onchange: (e) => { const v = Number(e.target.value); setSetting(k, e.target.value.trim() && v > 0 ? v : undefined); } });
    this.el.append(h('details', {}, h('summary', {}, 'Document settings'),
      this.field('Name', h('input', { value: app.doc.name || '', onkeydown: (e) => e.stopPropagation(), onchange: (e) => { app.snapshot(); app.doc.name = e.target.value.trim() || undefined; app.changed(); app.refreshInspector(); } })),
      this.field('Curve tolerance', numIn('tolerance', '0.01', 'Max deviation (mm) of faceted curves from the true curve while modelling')),
      this.field('Export tolerance', numIn('exportTolerance', '0.002', 'Finer tolerance used when exporting STL/OBJ/3MF')),
      h('div', { class: 'hint-inline' }, 'Curves are exact polygons inscribed in the true curve; quadrant points of circles are always exact.')));
    this.el.append(h('details', { open: !app.doc.features.length }, h('summary', {}, 'Examples'),
      h('div', { class: 'btn-row' }, app.examples.map((ex) => h('button', { onclick: () => app.loadExample(ex) }, ex.replace('.js', ''))))));
    this.el.append(h('details', {}, h('summary', {}, 'Shortcuts'), h('div', { class: 'stats' },
      'Mouse: left = select/draw · middle = orbit · right = pan · wheel = zoom\n' +
      'S sketch · E extrude · M measure · F fit · Ctrl+Z / Ctrl+Shift+Z\n' +
      'In sketch: L line · R rect · C circle · A arc · P point · T trim · D dimension\n' +
      '           H/V horizontal/vertical · X construction · Del delete · Enter finish')));
  }

  // ---- measurement ----
  showMeasure(m) {
    this.clear();
    this.el.append(h('h2', {}, '📏 Measure'), h('div', { class: 'hint-inline' }, 'Click two points on the model (vertices snap). Esc to exit.'));
    if (m.a) this.el.append(h('div', { class: 'stats' }, `A  ${m.a.map(fmt).join(', ')}${m.b ? `\nB  ${m.b.map(fmt).join(', ')}` : ''}`));
    if (m.a && m.b) {
      const d = m.b.map((v, i) => v - m.a[i]);
      this.el.append(h('div', { class: 'stats', style: 'margin-top:6px;font-size:13px' },
        `distance ${fmt(Math.hypot(...d))} mm\nΔx ${fmt(d[0])}   Δy ${fmt(d[1])}   Δz ${fmt(d[2])}`));
      if (m.na && m.nb) {
        const dot = m.na.reduce((s, v, i) => s + v * m.nb[i], 0);
        this.el.append(h('div', { class: 'stats', style: 'margin-top:6px' }, `angle between faces ${fmt(Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI)}°`));
      }
    }
    if (m.body) {
      const b = this.app.R?.bodies.get(m.body);
      if (b) {
        const s = bodyStats(b.manifold);
        this.el.append(h('div', { class: 'sub', style: 'margin-top:10px' }, `Body ${b.id}`), h('div', { class: 'stats' },
          `volume ${fmt(s.volume)} mm³\narea ${fmt(s.surfaceArea)} mm²\nsize ${s.bbox.size.map(fmt).join(' × ')}`));
      }
    }
    this.el.append(h('div', { class: 'btn-row' }, h('button', { onclick: () => this.app.endPick() }, 'Done')));
  }

  // ---- sketch mode ----
  showSketch() {
    const app = this.app, S = app.sketcher;
    const f = S.sketch;
    if (!f) return;
    this.clear();
    const sk = S.result;
    this.el.append(h('h2', {}, '✎ Sketch', h('span', { class: 'sub', style: 'margin:0' }, f.id)));
    if (sk) {
      const s = sk.solve;
      this.el.append(h('div', { class: `msg ${!s.ok ? 'err' : s.dof ? 'warn' : 'ok'}` },
        !s.ok ? `Conflicting constraints: ${s.residuals.map((r) => r.id).join(', ')}` : s.dof ? `${s.dof} degrees of freedom remain (blue geometry can still move)` : 'Fully constrained'));
    }
    // selection details
    const sel = [...S.sel];
    const map = S.map();
    for (const id of sel.slice(0, 6)) {
      const e = map.get(id);
      const c = f.constraints.find((x) => x.id === id);
      if (e?.type === 'point') {
        const mk = (k) => h('input', { value: fmt(e[k]), onkeydown: (ev) => ev.stopPropagation(), onchange: (ev) => {
          const v = Number(ev.target.value); if (!Number.isFinite(v)) return;
          app.snapshot(); e[k] = v; app.changed(); S.render(); this.showSketch();
        } });
        this.el.append(this.field(`Point ${id}`, h('div', { class: 'vec3', style: 'grid-template-columns:1fr 1fr' }, mk('x'), mk('y'))));
      } else if (e?.type === 'line') {
        const a = map.get(e.p1), b = map.get(e.p2);
        this.el.append(h('div', { class: 'stats' }, `Line ${id}: ${e.p1} → ${e.p2}\nlength ${fmt(Math.hypot(b.x - a.x, b.y - a.y))}  angle ${fmt(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI)}°`));
      } else if (e?.type === 'circle') {
        this.el.append(h('div', { class: 'stats' }, `Circle ${id}: center ${e.center}\nradius ${fmt(e.r)}  ⌀ ${fmt(2 * e.r)}`));
      } else if (e) {
        this.el.append(h('div', { class: 'stats' }, `${e.type} ${id}`));
      } else if (c) {
        this.el.append(h('div', { class: 'stats' }, `${c.id}: ${c.type} ${JSON.stringify(c)}`));
      }
    }
    // polygon sides option
    this.el.append(this.field('Polygon sides', h('input', { type: 'number', min: 3, value: app.polygonSides, onkeydown: (e) => e.stopPropagation(), onchange: (e) => { app.polygonSides = Number(e.target.value) || 6; } })));
    // constraints list
    const list = h('div', { style: 'max-height:260px;overflow:auto' }, f.constraints.map((c) => h('div', { class: 'tl-item', onclick: () => { S.sel.clear(); S.sel.add(c.id); S.render(); this.showSketch(); } },
      h('span', { class: 'icon' }, c.driving === false ? '()' : ''), h('span', { class: 'name' }, `${c.id} ${c.type} ${[c.a, c.b, c.line, c.point, c.circle].filter(Boolean).join(',')}${c.value !== undefined ? ` = ${c.value}` : ''}${c.expr ? ` ${c.expr}` : ''}`),
      h('span', { class: 'acts' }, h('button', { title: 'Delete', onclick: (ev) => { ev.stopPropagation(); app.snapshot(); f.constraints = f.constraints.filter((x) => x !== c); app.changed(); S.render(); this.showSketch(); } }, '✕')))));
    this.el.append(h('details', { open: true }, h('summary', {}, `Constraints (${f.constraints.length})`), list));
    this.el.append(h('div', { class: 'btn-row' },
      h('button', { onclick: () => app.exportSketch('dxf') }, 'Export DXF'),
      h('button', { onclick: () => app.exportSketch('svg') }, 'Export SVG'),
      h('button', { class: 'primary', onclick: () => app.finishSketch() }, '✓ Finish sketch')));
  }
}
