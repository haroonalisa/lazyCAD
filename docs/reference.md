# LazyCAD API reference

Units: millimetres and degrees everywhere. Every numeric value may be a number or an expression
string. Ids are any `[A-Za-z_][\w-]*` strings; builders generate them when omitted.

## Expressions

`+ - * / % ^`, parentheses, unary minus, unit suffixes `mm cm m in ft deg rad` (`rad` converts to
degrees), constants `pi e`, functions `sin cos tan` (degrees) `asin acos atan atan2` (return
degrees) `sqrt abs min max floor ceil round(x, digits) pow log ln exp hypot clamp sign`. Parameter
names (letters, digits, `_`, not reserved) refer to `params`, which may reference each other.
In sketch `equation` constraints you can also use `len(line) dist(p, q) x(p) y(p) r(circle)
angle(line)` (angle CCW from +u, degrees).

## Document format (`models/current.cad.json`)

```jsonc
{
  "version": 1, "name": "Part", "units": "mm",
  "settings": { "tolerance": 0.01, "exportTolerance": 0.002 },  // chord error for curves (mm)
  "params": { "w": "40", "h": "w/2" },
  "bodies": { "plate": { "color": "#8aa4c8", "visible": true, "name": "Plate" } },  // optional display meta
  "features": [ /* ordered timeline: planes, sketches, solid features … */ ]
}
```

Every feature has `id`, `type`, optional `suppressed: true`. The timeline is evaluated in order; a
feature can only reference earlier ones. Failing features are reported and skipped.

## Builder API (model scripts)

```js
export default (cad) => { ... }     // cad is a Builder; may also return a plain document object
```

| Builder | Result |
|---|---|
| `cad.name(str)`, `cad.settings({tolerance})` | document meta |
| `cad.param(name, expr)`, `cad.params({...})` | parameters |
| `cad.plane(spec, id?)` | datum plane id |
| `cad.sketch(plane, {id}?)` | `SketchBuilder` |
| `cad.editSketch(id)` | `SketchBuilder` for an existing sketch (append mode) |
| `cad.extrude(sketch, opts)` / `cad.cut(sketch, opts)` | feature id (`cut` = extrude with `mode:'cut'`) |
| `cad.revolve(sketch, opts)`, `cad.sweep(sketch, opts)`, `cad.loft([sketches or {sketch, profile}], opts)` | feature id |
| `cad.box(opts)`, `cad.cylinder(opts)`, `cad.cone(opts)`, `cad.sphere(opts)`, `cad.torus(opts)` | feature id |
| `cad.fillet(opts)`, `cad.chamfer(opts)`, `cad.shell(opts)` | feature id |
| `cad.pattern(opts)`, `cad.mirror(opts)`, `cad.transform(opts)`, `cad.boolean(opts)`, `cad.split(opts)`, `cad.deleteBodies(...ids)` | feature id |
| `cad.body(id, {color, visible, name})` | display meta |
| `cad.feature(id)` → the feature object (mutable), `cad.remove(id)`, `cad.toJSON()` | |

Anywhere a sketch id is expected you may pass the `SketchBuilder`.

## Planes

A plane is a string — `'XY'` (normal +Z, u=X, v=Y), `'XZ'` (normal −Y, u=X, v=Z), `'YZ'` (normal +X,
u=Y, v=Z), the same with a leading `-` to flip (`'-XY'`), a datum plane id, or a sketch id (its
plane) — or a spec object:

```js
{ base: 'XY', offset: 10 }                         // parallel, 10 along the normal
{ base: 'XZ', rotate: { x: 30 }, offset: 5 }       // tilt about the plane's own u axis, then offset along the new normal
{ base: 'XY', rotate: [['y', 15], ['x', 10]] }     // several rotations in order (axes x|u, y|v, z|n)
{ base: 'XY', shift: [10, 5] }                     // move the origin within the plane
{ origin: [0, 0, 10], normal: [0, 1, 1], xDir: [1, 0, 0] }   // explicit
{ points: [[0,0,0], [10,0,0], [0,10,5]] }           // through three points (u along p0→p1)
{ face: { body: 'plate', point: [5, 5, 10] } }      // face of a body nearest the point (normal outward)
{ ..., flip: true }                                 // reverse the normal
```

Order of operations: base/explicit/face → `shift` → `rotate` → `offset` → `flip`.
Face planes: origin = projection of the world origin onto the face plane; u = world X projected
(or world Y if X is normal to the face). So on a top face sketch coords equal world X/Y; on a −Y
front face u = X, v = Z. `info` prints every sketch's plane origin/normal/xDir.

## Sketches

```js
const s = cad.sketch('XY', { id: 'base' });
```

Entities (return ids). Point arguments are `[u, v]` (creates a point) or an existing point id
(shares it — that's how curves connect):

| Method | Notes |
|---|---|
| `s.point(u, v, {id, fixed, construction})` | `fixed` locks it |
| `s.line(a, b, {construction})` | |
| `s.circle(center, r)` | `s.centerOf(id)` → center point id |
| `s.arc(center, start, end)` | counter-clockwise from start to end; end is snapped onto the circle |
| `s.arcAngles(center, r, a0, a1)` | CCW from angle a0 to a1 (deg) |
| `s.bezier(p0, c1, c2, p1)` | cubic; control points are construction points |
| `s.polyline(pts, {closed})` | → `{points, lines}` |
| `s.rect(c0, c1, {constrain=true})` | → `{points, lines, bottom, right, top, left, bl, br, tr, tl}` |
| `s.centerRect(center, w, h)` | + `center` point (midpoint of a construction diagonal) |
| `s.polygon(center, r, n, {rotation=90})` | regular n-gon, circumradius r, equal sides, on a construction circle |
| `s.slot(a, b, width)` | stadium between centre points a and b; tangent arcs |
| `s.construction(...ids)` | exclude from profiles (still usable as references / axes / paths) |
| `s.trim(id, [u, v])` | remove the piece of curve `id` between its neighbouring intersections nearest [u, v]; deletes a curve that crosses nothing; circles become arcs; end points get point-on constraints to the cutting curves |
| `s.fillet(pointId, r)` / `s.chamfer(pointId, d, d2?)` | round / bevel the corner where two lines share `pointId`; r and d may be expressions; the corner stays as a construction point on both lines, line lengths become corner-to-corner distances |
| `s.filletAll(rectOrPolylineResult, r)` | fillet every corner point of a `rect`/`polyline` result (or a list of point ids) |
| `s.pos(id)`, `s.ends(id)`, `s.get(id)` | read back |

Constraints (return constraint ids). Values are expressions:

| Method | Meaning |
|---|---|
| `coincident(p, q)` | same point (prefer sharing point ids instead) |
| `fix(p, [u, v]?)` | lock at the given / current position |
| `horizontal(line)` / `horizontal(p, q)`; `vertical(...)` | |
| `parallel(l1, l2)`, `perpendicular(l1, l2)`, `collinear(l1, l2)` | |
| `equal(a, b)` | equal length (lines) or radius (circles/arcs) |
| `tangent(a, b)` | line–circle/arc, circle–circle, or G1 at a shared endpoint (incl. beziers) |
| `concentric(c1, c2)`, `midpoint(p, line)`, `symmetric(p, q, line)` | |
| `pointOnLine(p, line)`, `pointOnCircle(p, circleOrArc)` | |
| `distance(p, q, v)` | point–point, or point–line perpendicular distance |
| `hDistance(p, q, v)` / `vDistance(p, q, v)` | **signed**: q.u − p.u = v (resp. v-coordinates) |
| `length(line, v)`, `radius(c, v)`, `diameter(c, v)` | |
| `angle(line, v)` | absolute angle CCW from +u |
| `angle(l1, l2, v)` | CCW angle from l1's direction to l2's direction |
| `equation('len(l1) = 2*len(l2)')` | any equation over entity functions and params |
| any dimension with `{ driving: false }` | reference dimension: measured, reported, not enforced |

Solver: damped least squares from the given positions; moves geometry minimally; reports `dof`
(remaining degrees of freedom), under-constrained points, and unsatisfied (conflicting) constraints.

JSON form of entities: `{id, type:'point', x, y, fixed?, construction?}`, `{id, type:'line', p1, p2}`,
`{id, type:'circle', center, r}`, `{id, type:'arc', center, start, end}`,
`{id, type:'bezier', p0, c1, c2, p1}`. Constraints: `{id, type, ...fields as above}` with fields
`a, b, line, point, circle, value, x, y, expr, driving` (hDistance → `distanceX`, vDistance → `distanceY`).

## Profiles (which closed regions a feature uses)

Two views of a sketch's closed areas:
- **loops** (shapes as drawn) — curves connected at shared/coincident endpoints, full circles, closed
  curves. Id = the entity ids joined with `+`. Entity references and `'all'` use these.
- **regions** — the planar arrangement where crossing curves split each other (a line across a
  rectangle makes two regions). `{ point }` and `{ region }` use these. Ids are like loop ids, with
  `#2`, `#3` … when several regions come from the same entities. `info` lists both when they differ.

Profile values:

| Profile | Region |
|---|---|
| omitted / `'all'` | all loops; nested loops alternate solid / hole (if nothing closes except by crossing, all regions) |
| `'l1'` | the loop(s) containing entity `l1` (or a loop id like `'l1+l2+l3+l4'`) |
| `['l1', 'c2']` or `{ union: [...] }` | union |
| `{ subtract: [a, b, ...] }` | a minus the rest |
| `{ intersect: [...] }`, `{ xor: [...] }` | |
| `{ point: [u, v] }` | the smallest region containing the point (inside every loop around it, outside all others) |
| `{ region: { inside: [...], outside: [...] } }`, `{ regions: [...] }` | explicit atomic regions (what the app's region picker stores) |
| `{ offset: d, of: profile, join: 'round' \| 'miter' \| 'square' }` | grown (+) / shrunk (−) by d |

Nesting is allowed: `{ subtract: [{ offset: 2, of: 'l1' }, 'l1'] }` is a 2 mm rim around loop l1.

## Solid features

Common options: `id`, `mode: 'new' | 'add' | 'cut' | 'intersect'` (default `'new'`),
`body` (name of the new body, default = feature id), `target` (body id or list; default: last body,
cuts: all bodies).

**extrude** `{ sketch, profile?, distance, distance2?, symmetric?, reverse?, direction?, offset?, twist?, scaleTop? }`
- `distance` along the sketch normal (negative = other side); `'through'` = beyond all bodies.
- `distance2` extends the opposite side; `symmetric: true` centres on the plane; `reverse: true` flips.
- `direction`: `'normal'` | `'x'|'y'|'z'` | `[dx, dy, dz]` | `{ tilt: [degAboutU, degAboutV] }` |
  `{ sketch, line }` (along a sketch line). Non-normal directions shear the prism (oblique extrude);
  `distance` is the travel length along the direction.
- `offset`: start the extrusion at this distance from the plane. `twist` (deg) and `scaleTop`
  (number or `[sx, sy]`, about the sketch origin) make twisted / tapered extrusions.

**revolve** `{ sketch, profile?, axis?, angle = 360, symmetric? }`
- `axis`: `'v'` (sketch vertical axis through the sketch origin, default), `'u'`, a line id in the same
  sketch, `{ point: [u, v], dir: [du, dv] }`, or a world axis in the sketch plane (`'x'|'y'|'z'`,
  `{origin, dir}`). The profile must lie on one side of the axis. Negative angle reverses.

**sweep** `{ sketch, profile?, path }`
- `path: { sketch, entities? }` — open or closed chain of lines/arcs/beziers (all non-construction
  curves of that sketch when `entities` is omitted); starts at the end nearest the profile. Joints are
  mitred (rotation-minimising). Draw the profile in a plane through the path start, ideally
  perpendicular to it.
- `path: { helix: { pitch, turns | height, axis = 'z', origin = [0,0,0], leftHanded? } }` — exact screw
  motion; draw the profile in a plane containing the axis (e.g. `'XZ'` at u = radius for a Z helix).
- `path: { points: [[x,y,z], ...], closed? }` — explicit 3D polyline.

**loft** `{ sections: [{ sketch, profile? }, ...], smooth?, ruled?, startTangent?, endTangent?, steps = 16 }` —
loft through single-contour sections (each section's profile must be one closed contour without
holes). Corners of every section are kept. With 3+ sections the surface is smooth (Catmull–Rom through
the sections) unless `ruled: true`; `startTangent` / `endTangent` (weights, ~0.5–2) leave the first /
arrive at the last section along its normal; `steps` = interpolated rings per span.

**primitive** `{ shape, ..., center?, at: [x,y,z], rotate: [rx, ry, rz] }` (rotate in degrees about world X, then Y, then Z, then translate by `at`)
- `box`: `size: [x, y, z]` (corner at origin unless `center: true`)
- `cylinder`: `r` or `d`, `h`, optional `r2`/`d2` (top) — along +Z; `cone`: same with `r2` default 0
- `sphere`: `r` or `d` (centred); `torus`: `R` (major), `r` (minor), around Z

## Edge and face operations

**fillet** `{ body?, edges, radius, angle? }` · **chamfer** `{ body?, edges, distance, distance2? }`
- `body`: target body (default: last body). `edges`: selection (below). `angle`: dihedral threshold
  in degrees for what counts as an edge (default 30 — facets of curved surfaces are never edges).
- Convex (outside) edges lose material, concave (inside) edges gain it. 3+ selected convex chains meeting
  at a vertex with three faces get a spherical corner. `distance2` = asymmetric chamfer (second face).
- Edge selection: `'all'` · `{ near: [x,y,z], tolerance? }` · filters `{ x|y|z: v, box: {min,max},
  parallel: axis, convex: true, concave: true, kind: 'line'|'loop'|'curve', minLength, maxLength }`
  (AND) · arrays (union). Values may be expressions. `cad edges` lists chains: kind, convexity, length,
  a `near` point, end points.

**shell** `{ body?, thickness, open?: [{ point: [x,y,z] }, ...], outside? }`
- Keeps material within `thickness` of the surface; faces nearest the `open` points are removed
  (no wall there). `outside: true` adds a skin of that thickness around the body instead. Planar faces
  are offset exactly; sharp convex corners stay sharp inside, concave edges get a rounded inner blend.

## Modify features

**pattern** `{ of, kind: 'linear' | 'circular', ... }`
- `of`: a feature id (or list) — its tool solid is re-applied with the same mode (pattern a hole cut
  → more holes), or `{ body: id }` to copy a whole body (merged, or `separate: true` for new bodies).
- linear: `direction` (axis spec), `count`, `spacing`, optional `direction2`, `count2`, `spacing2`.
- circular: `axis` (`'z'` / `{origin, dir}` / `{sketch, line}`), `count`, `angle` (total, default 360;
  if < 360 the instances span the angle inclusively).

**mirror** `{ of, plane }` — same `of` semantics; `plane` is any plane spec; the result is unioned.

**transform** `{ body, translate?: [x,y,z], rotate?: { axis, angle, origin? }, copy? }`

**boolean** `{ op: 'union' | 'subtract' | 'intersect', target, tools: [...], keepTools? }`

**split** `{ body, plane, keep: 'both' | 'front' | 'back' }` — front = the side the normal points to;
`both` creates body `<body>_<featureId>` for the back part.

**delete** `{ bodies: [...] }`

**plane** `{ ...plane spec }` — datum plane usable by id in sketches, mirrors, splits.

Axis specs (pattern/transform/extrude direction): `'x'|'y'|'z'`, `[dx,dy,dz]`,
`{ origin: [x,y,z], dir: [dx,dy,dz] }`, `{ sketch, line }`, `{ sketch, axis: 'u'|'v'|'n' }`,
`{ plane: planeSpec }` (its normal through its origin).

## CLI

```
node cli/cad.mjs build <script.js|model.json> [--out file] [--append] [--png f] [--stl f] [--obj f] [--3mf f] [--json] [--no-save]
node cli/cad.mjs info [doc] [--json]
node cli/cad.mjs set [doc] name=expr ...
node cli/cad.mjs render [doc] --out f.png [--views iso|grid|front,top,right,back,left,bottom,iso2] [--size px] [--body ids]
node cli/cad.mjs export [doc] --out f.(stl|obj|3mf) [--format stl|stl-ascii|obj|3mf] [--body ids]
node cli/cad.mjs section [doc] --axis x|y|z --at value [--body id] [--svg f.svg]
node cli/cad.mjs sketch [doc] --sketch id --out f.(dxf|svg) [--construction]
node cli/cad.mjs edges [doc] [--body id] [--json]
node cli/cad.mjs faces [doc] [--body id] [--min-area a] [--all] [--json]
node cli/cad.mjs history
```
`--tolerance mm` works on every command; `export` and `build --stl/--obj/--3mf` default to
`settings.exportTolerance` or 0.002 mm.

`--json` reports include per feature `{id, type, ok, error?, warnings?, bodies?}`, per sketch
`{dof, fullyConstrained, solved, underconstrainedPoints, unsatisfied, loops:[{id, area}], plane}`,
per body `{volume, surfaceArea, bbox:{min,max,size}, centroid, genus, components, cavities, triangles}`;
fillet/chamfer features also report `edges` (number of edge chains affected).

## Browser automation (`window.cad` in the app)

`cad.doc`, `cad.load(doc)`, `await cad.run(fn, {append})` (fn receives a Builder), `cad.report()`,
`cad.reportText()`, `cad.setParam(name, expr)`, `cad.export(format)`, `cad.stats(bodyId)`,
`cad.view('iso'|'front'|'top'|'right'|'fit')`.

## HTTP API (server.mjs, default port 8777)

`GET /api/health` → `{ok, clients, doc, version}` · `GET /api/doc` · `PUT /api/doc` (JSON body;
saved and pushed to all tabs) · `GET /api/events` (SSE: `{type:'doc', doc, source}`).
Options: `node server.mjs --port 8777 --doc path/to/file.cad.json` (env `LAZYCAD_PORT`).
