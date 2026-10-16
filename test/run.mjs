// Test suite: node test/run.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, evaluateParams } from '../core/expr.js';
import { solveSketch } from '../core/solver.js';
import { rebuild, bodyStats, initKernel } from '../core/kernel.js';
import { Builder } from '../core/builder.js';
import { exportMeshes, meshesOf, sketchToDXF } from '../core/export.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const near = (a, b, tol = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg} expected ${b}, got ${a}`);

async function build(fn) {
  const cad = new Builder();
  fn(cad);
  const doc = cad.toJSON();
  const R = await rebuild(doc);
  if (R.errors.length) throw new Error(R.errors.map((e) => `${e.id}: ${e.message}`).join('; '));
  return { R, doc, stats: (id) => bodyStats(R.bodies.get(id).manifold) };
}

// ---------------- expressions ----------------
test('expr: precedence, power, unary minus, units', () => {
  assert.equal(evaluate('2+3*4'), 14);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('(1+2)*3'), 9);
  assert.equal(evaluate('1in'), 25.4);
  assert.equal(evaluate('2cm + 5mm'), 25);
  near(evaluate('sin(30)'), 0.5);
  near(evaluate('atan2(1,1)'), 45);
  assert.equal(evaluate('max(3, 7, 2)'), 7);
});
test('expr: parameters, dependencies, cycles', () => {
  const { values, errors } = evaluateParams({ a: '10', b: 'a*2', c: 'b + a', p: 'q', q: 'p', f: 'nope + 1', pi: '3' });
  assert.equal(values.c, 30);
  assert.ok(errors.p && errors.q, 'cycle detected');
  assert.ok(errors.pi, 'reserved name rejected');
  assert.ok(errors.f, 'unknown name reported');
});

// ---------------- solver ----------------
const pts = (o) => Object.entries(o).map(([id, [x, y]]) => ({ id, type: 'point', x, y }));
const rectSketch = () => ({
  entities: [...pts({ a: [0.3, -0.2], b: [9, 1], c: [11, 6], d: [-1, 4] }),
    { id: 'l1', type: 'line', p1: 'a', p2: 'b' }, { id: 'l2', type: 'line', p1: 'b', p2: 'c' },
    { id: 'l3', type: 'line', p1: 'c', p2: 'd' }, { id: 'l4', type: 'line', p1: 'd', p2: 'a' }],
  constraints: [{ id: 'h1', type: 'horizontal', line: 'l1' }, { id: 'h2', type: 'horizontal', line: 'l3' },
    { id: 'v1', type: 'vertical', line: 'l2' }, { id: 'v2', type: 'vertical', line: 'l4' }],
});
test('solver: rectangle DOF counting and full constraint', () => {
  const s = rectSketch();
  let r = solveSketch(s, Number);
  assert.equal(r.dof, 4);
  s.constraints.push({ id: 'f', type: 'fix', point: 'a', x: 0, y: 0 }, { id: 'w', type: 'length', line: 'l1', value: 40 }, { id: 'hh', type: 'distanceY', a: 'a', b: 'd', value: 20 });
  r = solveSketch(s, Number);
  assert.ok(r.ok);
  assert.equal(r.dof, 0);
  const c = s.entities.find((e) => e.id === 'c');
  near(c.x, 40, 1e-9); near(c.y, 20, 1e-9);
});
test('solver: conflicting constraints are reported', () => {
  const s = rectSketch();
  s.constraints.push({ id: 'L1', type: 'length', line: 'l1', value: 10 }, { id: 'L3', type: 'length', line: 'l3', value: 12 });
  const r = solveSketch(s, Number);
  assert.equal(r.ok, false);
  assert.ok(r.residuals.length > 0);
});
test('solver: tangent arc, circle radius, angle, equation', () => {
  const s = {
    entities: [...pts({ o: [0, 0], p: [10, 0], q: [0, 10], m: [3, 3], n: [20, 5] }),
      { id: 'c', type: 'circle', center: 'o', r: 4 },
      { id: 'l', type: 'line', p1: 'm', p2: 'n' }],
    constraints: [{ type: 'fix', point: 'o', x: 0, y: 0 }, { id: 'r', type: 'radius', circle: 'c', value: 5 },
      { id: 't', type: 'tangent', a: 'l', b: 'c' }, { id: 'ang', type: 'angle', a: 'l', value: 30 },
      { id: 'eq', type: 'equation', expr: 'len(l) = 4 * r(c)' }],
  };
  const r = solveSketch(s, Number);
  assert.ok(r.ok, JSON.stringify(r.residuals));
  const E = Object.fromEntries(s.entities.map((e) => [e.id, e]));
  near(E.c.r, 5, 1e-9);
  near(Math.hypot(E.n.x - E.m.x, E.n.y - E.m.y), 20, 1e-8);
  near(Math.atan2(E.n.y - E.m.y, E.n.x - E.m.x) * 180 / Math.PI, 30, 1e-7);
  const dx = E.n.x - E.m.x, dy = E.n.y - E.m.y;
  near(Math.abs(dx * (0 - E.m.y) - dy * (0 - E.m.x)) / Math.hypot(dx, dy), 5, 1e-8);
});

// ---------------- kernel ----------------
test('box primitive is exact', async () => {
  const { stats } = await build((cad) => cad.box({ id: 'b', size: [10, 20, 30] }));
  const s = stats('b');
  assert.equal(s.volume, 6000);
  assert.deepEqual(s.bbox.size, [10, 20, 30]);
});
test('extrude with auto hole, parametric', async () => {
  const { R, stats } = await build((cad) => {
    cad.param('w', 40);
    const s = cad.sketch('XY');
    const r = s.rect([0, 0], [40, 20]);
    s.fix(r.bl, [0, 0]);
    s.length(r.bottom, 'w * 1.5');
    s.circle([20, 10], 4);
    cad.extrude(s, { id: 'e', distance: 5 });
  });
  const loopArea = R.sketches.get('sketch1').loops.find((l) => l.id === 'c1').area;
  const s = stats('e');
  near(s.bbox.size[0], 60, 1e-9);
  near(s.volume, (60 * 20 - loopArea) * 5, 1e-6);
  assert.equal(s.genus, 1);
});
test('extrude: symmetric, reverse, two-sided, angled direction keeps volume', async () => {
  const { stats } = await build((cad) => {
    const s = cad.sketch('XY');
    s.rect([0, 0], [10, 10]);
    cad.extrude(s, { id: 'sym', distance: 20, symmetric: true });
    cad.extrude(s, { id: 'two', distance: 5, distance2: 3, body: 'two' });
    cad.extrude(s, { id: 'tilt', distance: 10, direction: { tilt: [0, 30] } });
  });
  assert.deepEqual([stats('sym').bbox.min[2], stats('sym').bbox.max[2]], [-10, 10]);
  assert.deepEqual([stats('two').bbox.min[2], stats('two').bbox.max[2]], [-3, 5]);
  const t = stats('tilt');
  near(t.volume, 100 * 10 * Math.cos(Math.PI / 6), 1e-6, 'sheared prism volume');
  near(t.bbox.max[2], 10 * Math.cos(Math.PI / 6), 1e-6);
});
test('profile booleans: subtract, intersect, xor, point, offset', async () => {
  const { R } = await build((cad) => {
    const s = cad.sketch('XY', { id: 's' });
    s.rect([0, 0], [10, 10]);
    s.rect([5, 5], [15, 15]);
    cad.extrude(s, { id: 'u', distance: 1, profile: ['l1', 'l5'] });
    cad.extrude(s, { id: 'd', distance: 1, profile: { subtract: ['l1', 'l5'] } });
    cad.extrude(s, { id: 'i', distance: 1, profile: { intersect: ['l1', 'l5'] } });
    cad.extrude(s, { id: 'x', distance: 1, profile: { xor: ['l1', 'l5'] } });
    cad.extrude(s, { id: 'p', distance: 1, profile: { point: [7, 7] } });
    cad.extrude(s, { id: 'o', distance: 1, profile: { offset: 1, of: 'l1', join: 'miter' } });
  });
  const v = (id) => R.bodies.get(id).manifold.volume();
  near(v('u'), 175); near(v('d'), 75); near(v('i'), 25); near(v('x'), 150); near(v('p'), 25); near(v('o'), 144);
});
test('revolve about sketch axis, partial angle', async () => {
  const { stats } = await build((cad) => {
    const s = cad.sketch('XZ');
    s.rect([10, 0], [20, 5]);
    cad.revolve(s, { id: 'r', angle: 90 });
  });
  const st = stats('r');
  near(st.volume, Math.PI * (400 - 100) * 5 / 4, 2e-3);
  near(st.bbox.max[2], 5, 1e-9);
});
test('cut through all + circular pattern of the cut', async () => {
  const { stats } = await build((cad) => {
    cad.cylinder({ id: 'disc', r: 30, h: 5 });
    const s = cad.sketch({ base: 'XY', offset: 5 });
    s.circle([20, 0], 2);
    cad.cut(s, { id: 'hole', distance: 'through', symmetric: true });
    cad.pattern({ id: 'pat', of: 'hole', kind: 'circular', axis: 'z', count: 6 });
  });
  assert.equal(stats('disc').genus, 6);
});
test('linear 2D pattern of body, mirror, split', async () => {
  const { R, stats } = await build((cad) => {
    cad.box({ id: 'b', size: [2, 2, 2] });
    cad.pattern({ of: { body: 'b' }, kind: 'linear', direction: 'x', count: 3, spacing: 5, direction2: 'y', count2: 2, spacing2: 5 });
    cad.mirror({ of: { body: 'b' }, plane: { base: 'YZ', offset: -1 } });
    cad.box({ id: 'c', size: [10, 10, 10], at: [100, 0, 0] });
    cad.split({ body: 'c', plane: { base: 'XY', offset: 4 }, keep: 'both' });
  });
  assert.equal(stats('b').components, 12);
  near(stats('b').volume, 96);
  near(stats('c').volume, 600); // front part (z > 4)
  assert.equal(R.bodies.size, 3);
});
test('sweep along a mitred path and a helix', async () => {
  const { stats } = await build((cad) => {
    const prof = cad.sketch('YZ');
    prof.rect([-1, -1], [1, 1]);
    const path = cad.sketch('XY');
    path.polyline([[0, 0], [20, 0], [20, 20]]);
    cad.sweep(prof, { id: 'bar', path: { sketch: path } });
    const t = cad.sketch('XZ');
    t.circle([10, 50], 1);
    cad.sweep(t, { id: 'coil', path: { helix: { pitch: 4, turns: 3 } } });
  });
  near(stats('bar').volume, 4 * 40, 1e-6); // mitred square tube: area × centreline length
  near(stats('coil').bbox.size[2], 3 * 4 + 2, 1e-6);
});
test('loft square to square (exact frustum)', async () => {
  const { stats } = await build((cad) => {
    const a = cad.sketch('XY'); a.rect([-10, -10], [10, 10]);
    const b = cad.sketch({ base: 'XY', offset: 30 }); b.rect([-5, -5], [5, 5]);
    cad.loft([a, b], { id: 'l' });
  });
  near(stats('l').volume, 30 / 3 * (400 + 100 + 200), 1e-6);
});
test('datum planes: offset + rotation, face plane is world aligned', async () => {
  const { R } = await build((cad) => {
    cad.box({ id: 'b', size: [10, 10, 10] });
    cad.plane({ base: 'XY', offset: 5, rotate: { x: 90 } }, 'tilted');
    const s = cad.sketch({ face: { body: 'b', point: [5, 5, 10] } }, { id: 'top' });
    s.circle([5, 5], 1);
  });
  const f = R.frames.get('tilted');
  near(f.o[2], 0); near(f.n[1], -1); // rotate first, then offset along the new normal
  const t = R.frames.get('top');
  assert.deepEqual(t.o.map((v) => Math.round(v * 1e9) / 1e9), [0, 0, 10]);
  assert.deepEqual(t.n, [0, 0, 1]);
});
test('errors are reported per feature without stopping the rebuild', async () => {
  const cad = new Builder();
  cad.box({ id: 'ok1', size: 5 });
  cad.extrude('missing', { id: 'bad', distance: 5 });
  cad.box({ id: 'ok2', size: 5, at: [10, 0, 0] });
  const R = await rebuild(cad.toJSON());
  assert.equal(R.errors.length, 1);
  assert.equal(R.errors[0].id, 'bad');
  assert.ok(R.bodies.has('ok2'));
});
test('no-op cut produces a warning', async () => {
  const cad = new Builder();
  cad.box({ id: 'b', size: 10 });
  const s = cad.sketch({ base: 'XY', offset: 10 }); s.circle([5, 5], 1);
  cad.cut(s, { id: 'c', distance: 5 });
  const R = await rebuild(cad.toJSON());
  assert.ok(R.features.get('c').warnings.some((w) => /removed no material/.test(w)));
});

// ---------------- solid edits: fillet, chamfer, shell ----------------
test('fillet all box edges (rounded corners) matches the analytic volume', async () => {
  const { stats } = await build((cad) => { cad.box({ id: 'b', size: [40, 30, 20] }); cad.fillet({ body: 'b', edges: 'all', radius: 4 }); });
  const r = 4, edges = 4 * (40 + 30 + 20) - 24 * r;
  const expected = 24000 - edges * r * r * (1 - Math.PI / 4) - (8 * r ** 3 - 4 / 3 * Math.PI * r ** 3);
  const s = stats('b');
  near(s.volume, expected, 2e-3);
  assert.deepEqual(s.bbox.size, [40, 30, 20]);
  assert.equal(s.components, 1);
});
test('fillet a circular edge, concave base fillet, chamfer', async () => {
  const { R, stats } = await build((cad) => {
    cad.box({ id: 'p', size: [40, 40, 5] });
    cad.cylinder({ id: 'boss', r: 8, h: 15, at: [20, 20, 5], mode: 'add', target: 'p' });
    cad.fillet({ id: 'top', body: 'p', edges: { near: [28, 20, 20] }, radius: 2 });
    cad.fillet({ id: 'base', body: 'p', edges: { near: [28, 20, 5] }, radius: 2 });
    cad.box({ id: 'c', size: [10, 10, 10], at: [100, 0, 0] });
    cad.chamfer({ body: 'c', edges: { parallel: 'z' }, distance: 2 });
  });
  const torusArea = 4 * (1 - Math.PI / 4); // r²(1 − π/4) cross-section
  const before = 40 * 40 * 5 + Math.PI * 64 * 15;
  near(stats('p').volume, before - 2 * Math.PI * (8 - 2 + 2 * 0.2234) * torusArea + 2 * Math.PI * (8 + 2 * 0.2234) * torusArea, 4e-3);
  assert.equal(R.features.get('top').edges, 1);
  assert.equal(stats('p').components, 1);
  near(stats('c').volume, 1000 - 4 * 10 * 2, 1e-6);
});
test('shell: open top, exact planar walls', async () => {
  const { R, stats } = await build((cad) => {
    cad.box({ id: 'b', size: [40, 30, 20] });
    cad.shell({ body: 'b', thickness: 2, open: [{ point: [20, 15, 20] }] });
  });
  near(stats('b').volume, 24000 - 36 * 26 * 18, 1e-6);
  const sec = R.bodies.get('b').manifold.slice(10);
  near(sec.area(), 40 * 30 - 36 * 26, 1e-6);
});
test('shell: closed hollow keeps its cavity through later booleans', async () => {
  const { stats } = await build((cad) => {
    cad.sphere({ id: 's', r: 10 });
    cad.shell({ body: 's', thickness: 1 });
    cad.box({ id: 'cut', size: [5, 5, 5], at: [30, 0, 0], mode: 'add', target: 's' });
  });
  const st = stats('s');
  assert.equal(st.cavities, 1);
  near(st.volume, 4 / 3 * Math.PI * (1000 - 729) + 125, 2e-2);
});

// ---------------- sketch editing ----------------
test('crossing curves form regions; {point} picks one', async () => {
  const { R } = await build((cad) => {
    const s = cad.sketch('XY', { id: 's' });
    s.rect([0, 0], [20, 10]);
    s.line([10, -5], [10, 15]);
    cad.extrude(s, { id: 'half', distance: 2, profile: { point: [5, 5] } });
    cad.extrude(s, { id: 'all', distance: 2, body: 'all' });
  });
  near(R.bodies.get('half').manifold.volume(), 200);
  near(R.bodies.get('all').manifold.volume(), 400);
});
test('trim, corner fillet and chamfer keep dimensions exact', async () => {
  const { R, stats } = await build((cad) => {
    cad.param('rf', 4);
    const s = cad.sketch('XY', { id: 's' });
    const r = s.rect([0, 0], [60, 40]);
    s.fix(r.bl, [0, 0]); s.length(r.bottom, 60); s.length(r.left, 40);
    s.filletAll(r, 'rf');
    s.circle([30, 20], 8);
    s.line([26, 5], [26, 26]); s.line([34, 5], [34, 26]); s.line([26, 5], [34, 5]);
    s.trim('c1', [30, 12]); s.trim('l5', [26, 25]); s.trim('l6', [34, 25]);
    cad.extrude(s, { id: 'e', distance: 1 });
  });
  const sk = R.sketches.get('s');
  assert.ok(sk.solve.ok);
  assert.deepEqual(stats('e').bbox.size, [60, 40, 1]);
  near(sk.loops.find((l) => l.entities.includes('a1')).area, 2400 - 4 * 16 * (1 - Math.PI / 4), 1e-3);
  assert.equal(stats('e').genus, 1);
});
test('smooth loft passes through all sections', async () => {
  const { stats } = await build((cad) => {
    const a = cad.sketch('XY'); a.circle([0, 0], 10);
    const b = cad.sketch({ base: 'XY', offset: 20 }); b.circle([0, 0], 5);
    const c = cad.sketch({ base: 'XY', offset: 40 }); c.circle([0, 0], 10);
    cad.loft([a, b, c], { id: 'l' });
    cad.loft([a, c], { id: 'r', ruled: true, body: 'r' });
  });
  near(stats('l').bbox.size[2], 40);
  assert.ok(stats('l').volume < stats('r').volume * 0.8, 'waisted smooth loft is smaller than the straight one');
});

// ---------------- export ----------------
test('exports: STL/OBJ/3MF/DXF structure', async () => {
  const { R } = await build((cad) => { const s = cad.sketch('XY'); s.rect([0, 0], [5, 5]); s.circle([2.5, 2.5], 1); cad.extrude(s, { id: 'e', distance: 2 }); });
  const bodies = [...R.bodies.values()];
  const ntri = meshesOf(bodies)[0].indices.length / 3;
  const stl = exportMeshes(bodies, 'stl');
  assert.equal(stl.length, 84 + 50 * ntri);
  const obj = exportMeshes(bodies, 'obj');
  assert.equal(obj.split('\n').filter((l) => l.startsWith('f ')).length, ntri);
  const tmf = exportMeshes(bodies, '3mf');
  assert.deepEqual([...tmf.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const dxf = sketchToDXF(R.sketches.get('sketch1'));
  assert.ok(dxf.includes('CIRCLE') && dxf.split('LINE').length - 1 === 4);
});

// ---------------- CLI ----------------
test('CLI builds every example', () => {
  for (const ex of ['bracket', 'flange', 'spring', 'bottle', 'enclosure']) {
    const out = execFileSync('node', [path.join(ROOT, 'cli/cad.mjs'), 'build', path.join(ROOT, 'examples', `${ex}.js`), '--no-save', '--json'], { encoding: 'utf8' });
    const rep = JSON.parse(out);
    assert.ok(rep.ok, `${ex}: ${JSON.stringify(rep.errors)}`);
    assert.ok(rep.bodies.length >= 1);
  }
});

await initKernel();
for (const t of tests) {
  try { await t.fn(); pass++; console.log(`  ✓ ${t.name}`); }
  catch (e) { fail++; console.log(`  ✗ ${t.name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
