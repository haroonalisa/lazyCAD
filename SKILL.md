---
name: lazycad
description: Design dimensionally exact, parametric 3D parts (brackets, enclosures, boxes with lids, flanges, mounts, knobs, springs, adapters, fixtures, 3D-print parts) with constrained 2D sketches, extrude/revolve/sweep/loft, fillets, chamfers, shell, booleans and patterns, then export STL/OBJ/3MF or sketch DXF/SVG. Use whenever the user asks Claude to model, design, CAD, dimension, modify or export a 3D part or a 2D profile for cutting, mentions "LazyCAD", "lazycad", "the CAD app" or "my model", or wants a printable/manufacturable file with specific measurements.
---

# LazyCAD — parametric CAD that Claude drives

LazyCAD is a constraint-based parametric CAD app that ships in this folder: a browser UI (sketch on
planes or faces, constraints, dimensions, features, measure, export) and a headless CLI that runs the
**same kernel**. You describe a model as a short **model script** (JavaScript calling the builder
API below). The CLI solves every sketch, builds exact solids (manifold kernel), reports
measurements, renders a preview PNG and writes `models/current.cad.json`. The live server pushes that
file to the open browser tab, and the user's edits in the app are saved back to the same file.

`CAD` below is this skill's base directory (the folder containing this SKILL.md). Set it per command:

```bash
CAD=~/.claude/skills/lazycad   # replace with the actual base directory if different
```

Requirements: Node.js 18+. First run only: `cd $CAD && npm install` (three, manifold-3d).

## 1. Make sure the live app is running (when the user wants to see/edit it)

```bash
curl -s localhost:8777/api/health || (cd $CAD && nohup node server.mjs > /tmp/lazycad-server.log 2>&1 &) ; sleep 0.7; curl -s localhost:8777/api/health
```

The response should contain `"app":"lazycad"` (if port 8777 is taken by something else, start
the server with `--port 8778` and use that port everywhere). `"clients"` is the number of open app tabs. If it is 0, open
**http://localhost:8777** once (built-in browser pane via `preview_start` with `url` if available,
otherwise `xdg-open` / `open`). If ≥ 1, the open tab updates live — don't open another. Always
mention the link. Start the server with `nohup … &` (not a tool's background option) so it outlives
the session. The CLI works without the server (headless use, CI, exports).

## 2. Check what is already there

```bash
node $CAD/cli/cad.mjs info          # params, timeline, sketch DOF, bodies with exact measurements
```

- To **modify** the user's model → script with `--append` (the builder starts from the current
  document: `cad.editSketch('id')`, `cad.feature('id')`, add new features), or `set name=expr` for
  parameter changes, or edit the JSON directly.
- For a **new** model → build without `--append` (the previous document is backed up to
  `models/.history/` automatically; mention it if it had content).

## 3. Write the model script

Save as `$CAD/models/<name>.js` so it can be re-run and tweaked:

```js
export default (cad) => {
  cad.name('Wall bracket');
  cad.params({ w: 60, d: 40, t: 5, hole: 6.5 });          // named, editable parameters

  const s = cad.sketch('XY', { id: 'base' });              // sketch on a plane
  const r = s.rect([0, 0], [60, 40]);                      // auto horizontal/vertical constraints
  s.fix(r.bl, [0, 0]);                                     // anchor
  s.length(r.bottom, 'w');                                 // driving dimensions (expressions ok)
  s.length(r.left, 'd');
  const h = s.circle([30, 20], 3.25);
  s.diameter(h, 'hole');
  s.hDistance(r.bl, s.centerOf(h), 'w/2');
  s.vDistance(r.bl, s.centerOf(h), 'd/2');
  cad.extrude(s, { id: 'plate', distance: 't' });          // nested loops become holes

  const top = cad.sketch({ face: { body: 'plate', point: [10, 10, 't'] } }); // sketch on the top face
  top.rect([5, 5], [15, 35]);
  cad.cut(top, { distance: 2, reverse: true });            // into the material
};
```

Rules that keep dimensions exact:
- **All lengths in mm, all angles in degrees.** Any numeric field can be an expression of
  parameters: `'w/2 + 3'`, `'sqrt(a^2+b^2)'`, `'2*pi*r'`, `'1in'`. Trig uses degrees.
- Give **exact coordinates** when you know them — geometry is exact without any constraints.
  Add constraints/dimensions to make the design *parametric* (editable by parameter or by the user
  in the app). Put the key sizes in `cad.params` and drive dimensions with them.
- When you constrain, start from sensible coordinates (the solver moves things minimally) and anchor
  with `fix(...)`. Aim for `dof=0` (fully constrained) on sketches you care about; `info` shows it.
- Closed loops are found automatically (shared endpoints / coincident points). Profile default
  `"all"` = every closed region, nested loops alternate solid/hole. Choose regions explicitly with
  profile expressions (see reference) — e.g. `{ subtract: ['l1', 'c1'] }`, `{ point: [u, v] }`.
- **Extrude direction**: along the sketch normal (XY→+Z, XZ→−Y, YZ→+X, face→outward). For cuts from
  a face sketch use `reverse: true` (or a negative distance). `distance: 'through'` cuts through all.
- Face sketches: `{ face: { body, point } }` picks the face nearest `point`; sketch coordinates are
  world-aligned (origin = projection of the world origin; on a top face u = X, v = Y). Write the
  point with parameter expressions (`[10, 10, 't']`) so it stays on the face when sizes change, and
  keep it away from edges. A datum plane (`{ base: 'XY', offset: 't' }`) is the most robust choice.
- Feature `mode`: `'new'` (default, new body named by `body` or the id), `'add'`, `'cut'`,
  `'intersect'`; `target` picks the body (default: last body; cuts default to all bodies).

The full API (all sketch entities, every constraint, all features and options, plane specs,
profile expressions, JSON format) is in **[docs/reference.md](docs/reference.md)** — read it before using
anything not shown above. Worked examples: `$CAD/examples/*.js` (enclosure — shell, fillets, chamfer, bosses, cutout;
bracket; flange; spring; bottle).

## 4. Build, then verify

```bash
node $CAD/cli/cad.mjs build $CAD/models/<name>.js --png /tmp/lazycad-preview.png
```

The report lists every feature (✓/✗ with errors and warnings), each sketch's degrees of freedom and
closed loops, and each body's **exact size, bounding box, volume, surface area, centroid, number of
solids and genus (= number of through-holes)**. Exit code 2 = some feature failed.

Always verify before telling the user it's done:
1. No `✗` and no warnings you didn't expect (`Cut removed no material` = wrong direction).
2. Bounding box / size match the intended dimensions; volume is plausible; `solids 1` unless you
   meant several pieces; genus equals the number of through-holes you intended.
3. Look at the PNG (`Read` it): iso + front/top/right views with a size caption.
4. For internal features use `section`: `node $CAD/cli/cad.mjs section --axis z --at 2.5 --svg /tmp/s.svg`
   (area, contour count, 2D bounds of the cut at that height).

Fix and rebuild until it checks out. Then tell the user what you built with the key dimensions,
and point them to the app.

## 5. Changes, parameters, export

```bash
node $CAD/cli/cad.mjs set w=80 t=6                      # change parameters, rebuild, save, report
node $CAD/cli/cad.mjs build $CAD/models/x.js --append   # extend the current document
node $CAD/cli/cad.mjs export --out part.stl             # stl | stl-ascii | obj | 3mf (by extension or --format); 0.002 mm curves
node $CAD/cli/cad.mjs export --out part.3mf --body plate
node $CAD/cli/cad.mjs sketch --sketch base --out base.dxf   # 2D profile for laser/CNC (also .svg)
node $CAD/cli/cad.mjs render --out view.png --views iso,front,top,right
node $CAD/cli/cad.mjs edges --body box                  # edge chains (+ near points) for fillet/chamfer
node $CAD/cli/cad.mjs faces --body box                  # planar faces (+ a point on each) for shell/face sketches
node $CAD/cli/cad.mjs history                           # backups of previous documents
```

Prefer 3MF for 3D printing (carries millimetre units), STL for compatibility. Exports include visible
bodies; `--body a,b` picks bodies.

## 6. Working with the user's edits

The user may edit in the app at any time (sketches, dimensions, features, parameters). Their changes
are saved to `models/current.cad.json`. Before modifying, run `info` (or read the JSON) and build
on what's there instead of overwriting it. Feature ids, sketch entity ids (`p1`, `l3`, `c1`…) and
constraint ids (`k4`) are stable — refer to them in `--append` scripts:

```js
export default (cad) => {
  const s = cad.editSketch('base');      // existing sketch
  s.circle([50, 30], 2);                  // add a hole
  cad.param('t', 8);                      // change a parameter
  cad.feature('cut1').distance = 3;       // tweak an existing feature (ids from `info`)
};
```

## Fillets, chamfers, shell, trim (solid and sketch editing)

```js
cad.fillet({ body: 'box', edges: { z: 'H' }, radius: 1 });          // round all edges lying at z = H
cad.fillet({ body: 'box', edges: 'all', radius: 2 });               // every edge; corners become spherical
cad.chamfer({ body: 'box', edges: { parallel: 'z' }, distance: 1 }); // vertical edges
cad.fillet({ body: 'p', edges: { near: [28, 20, 5] }, radius: 2 });  // one edge chain nearest a point
cad.shell({ body: 'box', thickness: 2, open: [{ point: [40, 25, 30] }] }); // hollow, top face removed
```

- **Edge selection** (`edges`): `'all'`, `{ near: [x,y,z] }` (the chain closest to a point),
  or filters combined with AND: `{ x | y | z: value }` (edge lies at that coordinate),
  `{ box: { min, max } }`, `{ parallel: 'z' | [dx,dy,dz] }`, `{ convex: true }` / `{ concave: true }`
  (outside / inside edges), `{ kind: 'line' | 'loop' | 'curve' }`, `{ minLength, maxLength }`.
  Arrays are unions. Edges joining smoothly (e.g. a whole circle, a rounded outline) form one chain.
  To see the chains with their `near` points: `node $CAD/cli/cad.mjs edges [--body id]`.
  Convex edges are rounded by removing material; concave edges get material added (inside
  fillets, e.g. where a boss meets a plate). Three or more selected edges meeting at a corner get a
  spherical corner. The report shows how many edge chains were affected; a warning appears if nothing
  changed.
- **Shell**: `thickness`, `open` = faces to remove (points on them; `cli/cad.mjs faces` lists faces with a point
  on each), `outside: true` to grow a skin outward instead. Planar walls are offset exactly; the
  report shows `closed internal cavities` for a fully closed hollow.
- **Order matters** like in any CAD: round vertical edges before shelling to get a rounded inside, and
  fillet the rim after shelling.
- **Sketch editing**: `s.trim(entityId, [u, v])` removes the piece of a curve between its neighbouring
  intersections nearest `[u, v]` (a curve that crosses nothing is deleted); `s.fillet(pointId, r)` and
  `s.chamfer(pointId, d)` round / bevel the corner where two lines meet (`s.filletAll(rect, r)` does
  every corner). The original corner stays as a construction point, so existing dimensions and fixes
  keep working. Crossing curves split each other into regions: `profile: { point: [u, v] }` picks
  one region (e.g. half a rectangle crossed by a line).
- **Smooth lofts**: lofts through 3+ sections are smooth by default; `startTangent` / `endTangent`
  (weights, e.g. 1) make a 2-section loft leave/arrive along the section normals; `ruled: true` gives
  straight sections.

## Accuracy

Solids are exact polyhedra: planar faces, straight edges and every dimension you give are exact;
curved surfaces are faceted within `settings.tolerance` (default 0.01 mm) and circles always include
their quadrant points (so diameters/bounding boxes of round features are exact). Exports are rebuilt
finer (`settings.exportTolerance`, default 0.002 mm; override with `--tolerance`). Set
`cad.settings({ tolerance: 0.005 })` for finer modelling. The kernel is mesh-based: there is no
STEP/NURBS export — if the user needs STEP for a CAD hand-off, say so and offer STL/3MF/OBJ (3D) or
DXF/SVG (2D sketches, true arcs and circles).
