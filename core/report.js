// Human/LLM-readable summary of a rebuild: parameters, feature status, sketch solve state,
// and body measurements (volume, area, bounding box, centroid).

import { bodyStats } from './kernel.js';

export function buildReport(doc, R) {
  const rep = { name: doc.name || null, units: doc.units || 'mm', tolerance: R.tolerance, ok: R.errors.length === 0, params: {}, features: [], bodies: [] };
  for (const [k, v] of Object.entries(doc.params || {})) rep.params[k] = { expr: v, value: R.params[k], ...(R.paramErrors[k] ? { error: R.paramErrors[k] } : {}) };
  for (const f of doc.features || []) {
    const st = R.features.get(f.id) || { ok: false, error: 'not evaluated (after rollback marker)' };
    const item = { id: f.id, type: f.type, ok: st.ok };
    if (st.suppressed) item.suppressed = true;
    if (st.error) item.error = st.error;
    if (st.warnings?.length) item.warnings = st.warnings;
    if (f.type === 'sketch' && R.sketches.has(f.id)) {
      const sk = R.sketches.get(f.id), s = sk.solve;
      item.solved = s.ok;
      item.dof = s.dof;
      item.fullyConstrained = s.dof === 0;
      if (s.freePoints.size && s.freePoints.size <= 12) item.underconstrainedPoints = [...s.freePoints];
      else if (s.freePoints.size) item.underconstrainedPoints = s.freePoints.size;
      if (s.residuals.length) item.unsatisfied = s.residuals.map((r) => r.id);
      item.loops = sk.loops.map((l) => ({ id: l.id, area: round(l.area) }));
      if (sk.faces.length !== sk.loops.length || sk.faces.some((f, i) => f.id !== sk.loops[i]?.id)) item.regions = sk.faces.map((l) => ({ id: l.id, area: round(l.area) }));
      if (Object.keys(s.refValues).length) item.referenceDims = Object.fromEntries(Object.entries(s.refValues).map(([k, v]) => [k, round(v)]));
      const fr = sk.frame;
      item.plane = { origin: fr.o.map(round), normal: fr.n.map(round), xDir: fr.x.map(round) };
    }
    if (f.type === 'plane' && R.frames.has(f.id)) {
      const fr = R.frames.get(f.id);
      item.plane = { origin: fr.o.map(round), normal: fr.n.map(round), xDir: fr.x.map(round) };
    }
    if (st.targets) item.bodies = st.targets;
    if (st.edges !== undefined) item.edges = st.edges;
    rep.features.push(item);
  }
  for (const b of R.bodies.values()) rep.bodies.push({ id: b.id, name: b.name, visible: b.visible, ...bodyStats(b.manifold) });
  rep.errors = R.errors;
  return rep;
}

const round = (x) => Math.round(x * 1e6) / 1e6;
const fmt = (x) => (x === null || x === undefined ? '-' : Number.isInteger(x) ? String(x) : (Math.round(x * 1e4) / 1e4).toString());

export function reportText(rep) {
  const L = [];
  L.push(`${rep.ok ? '✓ OK' : '✗ ERRORS'}${rep.name ? ` — ${rep.name}` : ''} (units: ${rep.units}; curves within ${rep.tolerance} mm)`);
  const ps = Object.entries(rep.params);
  if (ps.length) L.push(`params: ${ps.map(([k, p]) => `${k}=${p.expr}${String(p.expr) !== String(fmt(p.value)) ? ` (${fmt(p.value)})` : ''}${p.error ? ` [ERROR ${p.error}]` : ''}`).join(', ')}`);
  L.push('timeline:');
  for (const f of rep.features) {
    let s = `  ${f.ok ? '✓' : '✗'} ${f.id} (${f.type})`;
    if (f.suppressed) s += ' [suppressed]';
    if (f.type === 'sketch' && f.dof !== undefined) {
      s += ` dof=${f.dof}${f.fullyConstrained ? ' fully-constrained' : ''}${f.solved ? '' : ' NOT-SOLVED'} loops=${f.loops.length}`;
      if (f.loops.length) s += ` [${f.loops.map((l) => `${l.id}:${fmt(l.area)}mm²`).join(', ')}]`;
      if (f.regions) s += ` regions=${f.regions.length} [${f.regions.map((l) => `${l.id}:${fmt(l.area)}`).join(', ')}]`;
      if (f.unsatisfied) s += ` unsatisfied=${f.unsatisfied.join(',')}`;
      if (f.referenceDims) s += ` ref=${JSON.stringify(f.referenceDims)}`;
    }
    if (f.edges !== undefined) s += ` ${f.edges} edge chain${f.edges === 1 ? '' : 's'}`;
    if (f.bodies) s += ` → ${f.bodies.join(', ')}`;
    if (f.error) s += `\n      ERROR: ${f.error}`;
    for (const w of f.warnings || []) s += `\n      warning: ${w}`;
    L.push(s);
  }
  L.push('bodies:');
  if (!rep.bodies.length) L.push('  (none)');
  for (const b of rep.bodies) {
    if (b.empty) { L.push(`  ${b.id}: EMPTY`); continue; }
    L.push(`  ${b.id}${b.name !== b.id ? ` "${b.name}"` : ''}${b.visible === false ? ' [hidden]' : ''}: size ${b.bbox.size.map(fmt).join(' × ')} mm, bbox min [${b.bbox.min.map(fmt).join(', ')}] max [${b.bbox.max.map(fmt).join(', ')}]`);
    L.push(`      volume ${fmt(b.volume)} mm³, area ${fmt(b.surfaceArea)} mm², centroid [${(b.centroid || []).map(fmt).join(', ')}], solids ${b.components}${b.cavities ? `, ${b.cavities} closed internal cavit${b.cavities === 1 ? 'y' : 'ies'}` : ''}, genus ${b.genus}, ${b.triangles} tris`);
  }
  return L.join('\n');
}
