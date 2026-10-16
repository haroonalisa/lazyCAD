#!/usr/bin/env node
// LazyCAD command-line interface — build, inspect, render and export parametric models.
// Run `node cli/cad.mjs help` for usage.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { rebuild, initKernel, bodyStats } from '../core/kernel.js';
import { Builder } from '../core/builder.js';
import { buildReport, reportText } from '../core/report.js';
import { exportMeshes, meshesOf, sketchToDXF, sketchToSVG } from '../core/export.js';
import { renderPNG } from './render.mjs';
import { topology, edgeChains } from '../core/edges.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DOC = path.join(ROOT, 'models', 'current.cad.json');

const HELP = `LazyCAD — parametric 3D CAD CLI (units: mm, angles: degrees)

  build <script.js|model.json> [options]   evaluate a script/model, save it as the live document
      --out <file>        document to write (default: models/current.cad.json → live app)
      --append            run the script on top of the existing document (cad = existing doc)
      --stl/--obj/--3mf <file>   also export
      --png <file>        also render a preview (iso/front/top/right grid)
      --tolerance <mm>    curve chord tolerance for this run (exports default to 0.002 mm)
      --json              print the report as JSON
      --no-save           don't write the document
  info [doc] [--json]                     report: params, timeline, sketch DOF, body measurements
  render [doc] --out <png> [--views iso|grid|front,top,...] [--size px] [--body id,...]
  export [doc] --out <file> [--format stl|stl-ascii|obj|3mf] [--body id,...] [--tolerance mm]
      exports are rebuilt at a finer curve tolerance (default settings.exportTolerance or 0.002 mm)
  edges [doc] [--body id] [--json]          list edge chains (for fillet/chamfer edge selection)
  faces [doc] [--body id] [--min-area a] [--all]   list planar faces (for shell open faces / face sketches)
  section [doc] --axis x|y|z --at <value> [--body id] [--svg out.svg]   cross-section area & bounds
  sketch [doc] --sketch <id> --out <file.svg|file.dxf>              export a sketch as 2D
  set [doc] name=expr ...                 change parameters, rebuild, save, report
  history [doc]                           list backups in models/.history

The live document (models/current.cad.json) is watched by the app server (node server.mjs);
any change is pushed to the open browser tab instantly.
`;

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

const readDoc = (file) => {
  const p = path.resolve(file || DEFAULT_DOC);
  if (!fs.existsSync(p)) throw new Error(`No document at ${p}`);
  return { doc: JSON.parse(fs.readFileSync(p, 'utf8')), file: p };
};

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const cur = fs.readFileSync(file, 'utf8');
  try { const d = JSON.parse(cur); if (!d.features?.length) return null; } catch { /* back up anyway */ }
  const dir = path.join(path.dirname(file), '.history');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${path.basename(file, '.cad.json')}-${new Date().toISOString().replace(/[:.]/g, '-')}.cad.json`;
  fs.writeFileSync(path.join(dir, name), cur);
  return path.join(dir, name);
}

function writeDoc(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
}

async function loadInput(input, opts) {
  if (input.endsWith('.json')) return JSON.parse(fs.readFileSync(input, 'utf8'));
  const mod = await import(pathToFileURL(path.resolve(input)).href + `?t=${Date.now()}`);
  const fn = mod.default;
  if (typeof fn !== 'function') throw new Error('Script must `export default (cad) => { ... }`');
  let base;
  if (opts.append) base = readDoc(opts.out).doc;
  const cad = new Builder(base);
  const ret = await fn(cad);
  return (ret && ret.features ? ret : cad.toJSON());
}

function exportTolerance(doc, opt) {
  return Number(opt.tolerance ?? doc.settings?.exportTolerance ?? Math.min(0.002, doc.settings?.tolerance ?? 0.002));
}

function bodiesFor(R, opt) {
  let bodies = [...R.bodies.values()];
  if (opt.body) { const ids = String(opt.body).split(','); bodies = bodies.filter((b) => ids.includes(b.id)).map((b) => ({ ...b, visible: true })); }
  return bodies;
}

async function exportTo(R, file, format, opt = {}) {
  const fmt = format || path.extname(file).slice(1).toLowerCase();
  const data = exportMeshes(bodiesFor(R, opt), fmt === 'stl' && opt.ascii ? 'stl-ascii' : fmt);
  fs.writeFileSync(file, data);
  return file;
}

function renderTo(R, file, opt = {}) {
  const bodies = bodiesFor(R, opt).filter((b) => b.visible !== false);
  const meshes = meshesOf(bodies).map((m, i) => ({ ...m, color: bodies[i].color }));
  let caption = '';
  if (bodies.length) {
    const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
    for (const b of bodies) { const bb = b.manifold.boundingBox(); for (let k = 0; k < 3; k++) { mins[k] = Math.min(mins[k], bb.min[k]); maxs[k] = Math.max(maxs[k], bb.max[k]); } }
    caption = `SIZE ${maxs.map((v, k) => (Math.round((v - mins[k]) * 100) / 100)).join(' x ')} mm`;
  }
  fs.writeFileSync(file, renderPNG(meshes, { views: opt.views || 'grid', size: opt.size ? +opt.size : undefined, caption }));
  return file;
}

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  if (cmd === 'help' || cmd === '--help') { console.log(HELP); return; }
  await initKernel();

  if (cmd === 'build') {
    if (!pos[0]) throw new Error('build needs a script (.js) or model (.json)');
    const out = path.resolve(opt.out || DEFAULT_DOC);
    opt.out = out;
    const doc = await loadInput(pos[0], opt);
    const R = await rebuild(doc, { tolerance: opt.tolerance ? Number(opt.tolerance) : undefined });
    const rep = buildReport(doc, R);
    if (!opt['no-save']) {
      const b = opt.append ? null : backup(out);
      writeDoc(out, doc);
      rep.saved = out;
      if (b) rep.backup = b;
    }
    if (opt.stl || opt.obj || opt['3mf']) {
      const RX = await rebuild(JSON.parse(JSON.stringify(doc)), { tolerance: exportTolerance(doc, opt) });
      if (opt.stl) rep.stl = await exportTo(RX, opt.stl, 'stl', opt);
      if (opt.obj) rep.obj = await exportTo(RX, opt.obj, 'obj', opt);
      if (opt['3mf']) rep['3mf'] = await exportTo(RX, opt['3mf'], '3mf', opt);
      rep.exportTolerance = RX.tolerance;
      RX.dispose();
    }
    if (opt.png) rep.png = renderTo(R, opt.png, opt);
    print(rep, opt);
    R.dispose();
    process.exitCode = rep.ok ? 0 : 2;
    return;
  }

  if (cmd === 'info') {
    const { doc } = readDoc(pos[0]);
    const R = await rebuild(doc, { tolerance: opt.tolerance ? Number(opt.tolerance) : undefined });
    print(buildReport(doc, R), opt);
    R.dispose();
    return;
  }

  if (cmd === 'set') {
    const docFile = pos[0] && !pos[0].includes('=') ? pos.shift() : undefined;
    const { doc, file } = readDoc(docFile);
    for (const kv of pos) {
      const i = kv.indexOf('=');
      if (i < 1) throw new Error(`Expected name=expr, got "${kv}"`);
      doc.params ||= {};
      doc.params[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    const R = await rebuild(doc, { tolerance: opt.tolerance ? Number(opt.tolerance) : undefined });
    writeDoc(file, doc);
    const rep = buildReport(doc, R);
    rep.saved = file;
    print(rep, opt);
    R.dispose();
    return;
  }

  if (cmd === 'render') {
    const { doc } = readDoc(pos[0]);
    const R = await rebuild(doc, { tolerance: opt.tolerance ? Number(opt.tolerance) : undefined });
    const file = renderTo(R, opt.out || 'preview.png', opt);
    console.log(`rendered ${file}`);
    R.dispose();
    return;
  }

  if (cmd === 'export') {
    const { doc } = readDoc(pos[0]);
    const R = await rebuild(doc, { tolerance: exportTolerance(doc, opt) });
    if (!R.bodies.size) throw new Error('Nothing to export: the model has no bodies');
    const file = opt.out || `model.${opt.format || 'stl'}`;
    await exportTo(R, file, opt.format, opt);
    console.log(`exported ${file} (${fs.statSync(file).size} bytes)`);
    R.dispose();
    return;
  }

  if (cmd === 'section') {
    const { doc } = readDoc(pos[0]);
    const R = await rebuild(doc, { tolerance: opt.tolerance ? Number(opt.tolerance) : undefined });
    const axis = (opt.axis || 'z').toLowerCase(), at = Number(opt.at ?? 0);
    const out = [];
    for (const b of bodiesFor(R, opt)) {
      // Rotate so the chosen axis becomes Z. x-sections use 2D coords (y, z); y-sections (x, z).
      let m = b.manifold, level = at;
      if (axis === 'x') m = m.transform([0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
      if (axis === 'y') { m = m.transform([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]); level = -at; }
      const cs = m.slice(level);
      const polys = cs.toPolygons();
      const bb = cs.bounds();
      out.push({ body: b.id, area: Math.round(cs.area() * 1e6) / 1e6, contours: polys.length, bounds2D: cs.isEmpty() ? null : bb });
      if (opt.svg && polys.length) {
        const W = bb.max[0] - bb.min[0], H = bb.max[1] - bb.min[1], mg = Math.max(W, H) * 0.05 + 1;
        const d = polys.map((p) => `M${p.map(([x, y]) => `${x},${-y}`).join('L')}Z`).join('');
        fs.writeFileSync(opt.svg, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bb.min[0] - mg} ${-bb.max[1] - mg} ${W + 2 * mg} ${H + 2 * mg}" width="600"><path d="${d}" fill="#8aa4c8" fill-rule="evenodd" stroke="#223" stroke-width="${Math.max(W, H) / 400}"/></svg>`);
      }
      cs.delete();
      if (m !== b.manifold) m.delete();
    }
    console.log(JSON.stringify({ axis, at, note: axis === 'x' ? '2D coords are (y, z)' : axis === 'y' ? '2D coords are (x, z)' : '2D coords are (x, y)', sections: out }, null, 2));
    R.dispose();
    return;
  }

  if (cmd === 'sketch') {
    const { doc } = readDoc(pos[0]);
    const R = await rebuild(doc, { tolerance: opt.tolerance ? Number(opt.tolerance) : undefined });
    const sk = R.sketches.get(opt.sketch);
    if (!sk) throw new Error(`No sketch "${opt.sketch}" (have: ${[...R.sketches.keys()].join(', ')})`);
    const file = opt.out || `${opt.sketch}.svg`;
    fs.writeFileSync(file, file.endsWith('.dxf') ? sketchToDXF(sk, { includeConstruction: !!opt.construction }) : sketchToSVG(sk, { includeConstruction: !!opt.construction }));
    console.log(`wrote ${file}`);
    R.dispose();
    return;
  }

  if (cmd === 'edges' || cmd === 'faces') {
    const { doc } = readDoc(pos[0]);
    const R = await rebuild(doc, { tolerance: opt.tolerance ? Number(opt.tolerance) : undefined });
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const out = {};
    for (const b of bodiesFor(R, opt)) {
      const topo = topology(b.manifold);
      if (cmd === 'edges') {
        out[b.id] = edgeChains(topo).map((c) => ({
          chain: c.id, kind: c.kind, convex: c.convex, length: r3(c.length), segments: c.segs.length,
          near: c.mid.map(r3), from: c.pts[0].map(r3), to: c.closed ? undefined : c.pts[c.pts.length - 1].map(r3),
          ...(c.kind === 'line' ? { dir: c.dir.map(r3) } : { bbox: [c.bbox.min.map(r3), c.bbox.max.map(r3)] }),
        }));
      } else {
        const maxA = Math.max(...topo.faces.map((f) => f.area));
        const minA = Number(opt['min-area'] ?? (opt.all ? 0 : 0.005 * maxA));
        out[b.id] = topo.faces.filter((f) => f.area >= minA).map((f) => {
          // a point guaranteed on the face: centroid of its largest triangle
          const k = f.tris.reduce((m, t) => (topo.area[t] > topo.area[m] ? t : m), f.tris[0]);
          const pts = topo.tri(k).map((i) => topo.V[i]);
          const c = [0, 1, 2].map((d) => (pts[0][d] + pts[1][d] + pts[2][d]) / 3);
          return { face: f.id, normal: f.normal.map(r3), area: r3(f.area), point: c.map(r3) };
        }).sort((a, b) => b.area - a.area).slice(0, opt.all ? undefined : 60);
      }
    }
    if (opt.json) console.log(JSON.stringify(out, null, 2));
    else for (const [body, list] of Object.entries(out)) {
      console.log(`body ${body}: ${list.length} ${cmd === 'edges' ? 'edge chains' : 'planar faces'}`);
      for (const x of list) {
        if (cmd === 'edges') console.log(`  #${x.chain} ${x.kind}${x.convex ? '' : ' concave'} len ${x.length} near [${x.near}]${x.to ? ` from [${x.from}] to [${x.to}]` : ''}`);
        else console.log(`  #${x.face} normal [${x.normal}] area ${x.area} point [${x.point}]`);
      }
    }
    R.dispose();
    return;
  }

  if (cmd === 'history') {
    const dir = path.join(path.dirname(path.resolve(pos[0] || DEFAULT_DOC)), '.history');
    console.log(fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((f) => path.join(dir, f)).join('\n') || '(empty)' : '(no history)');
    return;
  }

  throw new Error(`Unknown command "${cmd}". Run: node cli/cad.mjs help`);
}

function print(rep, opt) {
  if (opt.json) { console.log(JSON.stringify(rep, null, 2)); return; }
  console.log(reportText(rep));
  for (const k of ['saved', 'backup', 'stl', 'obj', '3mf', 'png']) if (rep[k]) console.log(`${k}: ${rep[k]}`);
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });

export { bodyStats };
