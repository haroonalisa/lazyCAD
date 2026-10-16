# LazyCAD architecture

How LazyCAD is put together, and why. Read this before changing the kernel, the solver or the
document format.

- [Overview](#overview)
- [Repository layout](#repository-layout)
- [The document model](#the-document-model)
- [Rebuild pipeline](#rebuild-pipeline)
- [Expressions and parameters](#expressions-and-parameters)
- [The 2D constraint solver](#the-2d-constraint-solver)
- [Sketch topology: loops and regions](#sketch-topology-loops-and-regions)
- [Solid kernel](#solid-kernel)
- [Fillets and chamfers](#fillets-and-chamfers)
- [Shell](#shell)
- [Sweeps and lofts](#sweeps-and-lofts)
- [Mesh hygiene](#mesh-hygiene)
- [The browser app](#the-browser-app)
- [CLI, renderer and server](#cli-renderer-and-server)
- [Testing](#testing)
- [Design decisions and limits](#design-decisions-and-limits)

## Overview

```
                ┌────────────────────────── core/ (pure ES modules) ──────────────────────────┐
 model script → │ builder.js → document JSON → kernel.rebuild()                                │
                │                 │             ├─ expr.js        parameters & expressions     │
                │                 │             ├─ solver.js      sketch constraints           │
                │                 │             ├─ sketch.js      loops, regions, profiles     │
                │                 │             ├─ sweep.js       sweep / helix / loft meshes  │
                │                 │             ├─ edges.js       topology, fillet, shell      │
                │                 │             └─ manifold-3d    exact mesh booleans (WASM)   │
                │                 └─ report.js / export.js                                   │
                └──────────────────────────────────────────────────────────────────────────────┘
                     ▲                                   ▲
           cli/cad.mjs (Node)                   app/ (browser, three.js)
```

`core/` has no DOM or Node dependencies, so the browser and the CLI evaluate a document identically.
The only runtime dependencies are [`manifold-3d`](https://github.com/elalish/manifold) (geometry
kernel) and [`three`](https://threejs.org) (viewport). There is no bundler: the browser loads the ES
modules directly through an import map in `app/index.html`.

## Repository layout

| Path | Purpose |
|---|---|
| `core/expr.js` | Expression tokenizer / Pratt parser / evaluator, parameter resolution with cycle detection |
| `core/vec.js` | Vector and 4×4 matrix helpers, plane frames |
| `core/solver.js` | Sketch constraint solver (Levenberg–Marquardt), degree-of-freedom and conflict analysis |
| `core/sketch.js` | Curve discretisation, loop and region detection (planar arrangement), profile booleans, sweep paths |
| `core/sketchedit.js` | Trim, corner fillet and corner chamfer on sketch data |
| `core/kernel.js` | `rebuild()`: evaluates the timeline into bodies. Planes, all features, body bookkeeping, measurements |
| `core/edges.js` | Mesh topology (welding, faces, edge chains), edge selection, fillet / chamfer cutters, shell |
| `core/sweep.js` | Mesh builders for sweeps, helices and lofts; `stitch()` and `meshToManifold()` |
| `core/builder.js` | The scripting API (`Builder`, `SketchBuilder`) |
| `core/report.js` | Build report (JSON and text) |
| `core/export.js` | STL, OBJ, 3MF (stored zip), DXF, SVG |
| `app/` | Browser UI: `main.js` (controller, undo, picking, live sync), `viewport.js`, `sketcher.js`, `inspector.js` |
| `cli/cad.mjs` | Command-line interface |
| `cli/render.mjs` | Software rasteriser that renders PNG previews without a GPU |
| `server.mjs` | Static file server plus document sync (SSE + PUT) |
| `examples/` | Model scripts used by the app's example menu and by the tests |
| `test/run.mjs` | Test suite (no framework, `node:assert`) |
| `SKILL.md` | Instructions Claude follows when the repository is installed as a skill |

## The document model

A document is plain JSON:

```jsonc
{
  "version": 1, "name": "Part", "units": "mm",
  "settings": { "tolerance": 0.01, "exportTolerance": 0.002 },
  "params": { "w": "40", "h": "w/2" },
  "features": [ { "id": "sketch1", "type": "sketch", "plane": "XY", "entities": [...], "constraints": [...] },
                { "id": "extrude1", "type": "extrude", "sketch": "sketch1", "distance": "h" } ],
  "bodies": { "extrude1": { "color": "#8aa4c8" } }
}
```

- **Features form one ordered timeline.** Planes and sketches are features too, so a sketch on a face
  is evaluated after the solid that owns the face.
- **Sketches store their solved coordinates.** Each rebuild starts the solver from the last solution,
  which keeps sketches stable and lets the app drag geometry smoothly.
- **Ids are stable strings.** The UI, the builder and Claude all refer to the same `p3`, `l2` and
  `extrude1`.
- Values are numbers or expression strings. Nothing is evaluated at save time.

## Rebuild pipeline

`rebuildSync(wasm, doc, { stopAt, tolerance })` in `core/kernel.js`:

1. Evaluate parameters (`evaluateParams`). Errors are collected per parameter.
2. For each feature in order, call its handler. A failing feature records its error and the rebuild
   continues, so one bad feature doesn't blank the model.
   - `plane`: computes a frame `{o, x, y, n}`.
   - `sketch`: resolves its plane, solves its constraints, finds loops and regions.
   - Solid features build a **tool** solid and apply it with their `mode`: `new` / `add` / `cut` /
     `intersect`.
   - `pattern` and `mirror` re-apply a feature's tool under transforms, or copy bodies.
3. Collect warnings. Examples: a cut that removed nothing, a join that created separate pieces, an
   edge selection that changed nothing.
4. Free every intermediate WASM object. Only the final bodies survive, and `BuildResult.dispose()`
   frees those.

`stopAt` evaluates up to a feature. The app uses it to show a body *before* a fillet or shell while you
pick its edges or faces. Memory is managed with an arena (`track()`): every manifold object created
during a rebuild is registered and deleted at the end, unless it became a body.

## Expressions and parameters

`core/expr.js` is a Pratt parser with:
- the usual operators, including `^` (right-associative power),
- unit suffixes (`mm cm m in ft deg rad`),
- functions such as `sin` / `cos` / `tan` in degrees, `atan2`, `sqrt`, `min`, `max`, `round` and
  `clamp`,
- the constants `pi` and `e`.

Parameters are resolved recursively with cycle detection. Sketch equation constraints can also call
*entity functions* (`len(l1)`, `dist(p,q)`, `x(p)`, `y(p)`, `r(c)`, `angle(l)`), which read the solver's
current unknowns.

## The 2D constraint solver

`core/solver.js` solves each sketch independently.

**Unknowns.** The x and y of every non-fixed point, and the radius of every circle. Arcs have no
radius unknown: one implicit equation keeps both arc end points at the same distance from the centre.

**Equations.** Each constraint contributes residual functions that are zero when it is satisfied:
- coincident adds 2 equations,
- point-on-line uses the signed area,
- tangent uses one of three forms: line-to-centre distance minus radius, the centre distance (internal
  or external, whichever is closest initially), or a G1 cross product at a shared end point,
- equation constraints contribute `lhs − rhs`.

Each residual declares which unknowns it depends on, so the Jacobian is built by central finite
differences over those columns only.

**Method.** Levenberg–Marquardt with damping `λI`. The step is computed from the normal equations with
a Cholesky decomposition. Because damping penalises the step size, an under-constrained sketch moves
**as little as possible**. That is what you want for interactive editing and for scripts whose starting
coordinates are already sensible.

**Dragging.** A weak extra residual pulls the dragged point toward the cursor. The solver solves with
it, then solves again without it, so the final state satisfies every real constraint.

**Analysis.** After solving, the Jacobian is reduced to row-echelon form:
- its rank gives the remaining **degrees of freedom**,
- its null space shows which points can still move (drawn blue in the app),
- residuals that did not converge identify **conflicting** constraints.

## Sketch topology: loops and regions

`core/sketch.js` turns curves into closed areas in two ways:

- **Loops** are shapes as drawn: curves joined at shared or coincident end points, found by half-edge
  face traversal of the planar graph after pruning dangling edges. Full circles and self-closing curves
  are loops on their own. Entity references and the default `"all"` profile use loops. Nesting depth
  decides solid vs hole (even depth is solid, odd is hole).
- **Regions** are the planar arrangement: every non-construction curve is split at its intersections
  with the others (segment-against-segment, with tolerance, collinear overlaps and T-junctions). Faces
  are then traced the same way. `{ point }` profiles and the app's region picker use regions, which is
  why a line across a rectangle gives two pickable halves.

Profiles are evaluated to a manifold `CrossSection`, using unions, differences, intersections, xor and
offsets of loops and regions. Curves are discretised by chord tolerance. Circles always use a multiple of
4 segments so their extreme points are exact.

## Solid kernel

All 3D geometry is produced by [manifold](https://github.com/elalish/manifold). Manifold guarantees
watertight, manifold output from booleans, including coplanar and touching cases. The kernel builds
tool solids like this:

- **extrude**: `CrossSection.extrude` in sketch space, then an affine shear for tilted or vector
  directions (travel length along the direction), then the plane frame matrix.
- **revolve**: transform the profile so the axis becomes Y, `CrossSection.revolve`, then map the
  result back. Partial and negative angles are handled with a pre-rotation.
- **primitives**: manifold's cube, cylinder and sphere. The torus is a revolved circle. Segment counts
  come from the tolerance.
- **sweep / loft**: explicit meshes from `core/sweep.js`.

Face references (`{ face: { body, point } }`) find the triangle nearest the point and take its plane.
The sketch origin is the projection of the world origin onto that plane, so coordinates on a top face
equal world X / Y.

## Fillets and chamfers

Mesh kernels have no B-rep edges, so `core/edges.js` reconstructs them:

1. **Topology.** Weld coincident vertices, which booleans can duplicate. Give zero-area "needle"
   triangles the normal of their neighbour across the longest edge. Group triangles into planar faces.
2. **Feature edges** are mesh edges whose two faces meet at more than 30°. Tessellated curved surfaces
   are always finer than 22.5° per facet, so they never produce false edges.
3. **Chains.** Feature edges are linked through vertices where exactly two of them meet with a gentle
   turn, so a whole circle or a tangent line–arc outline becomes one chain. Each chain records its kind
   (line / loop / curve), whether it is convex, its length, its midpoint and its bounding box.
4. **Selection** filters the chains (`near`, coordinate planes, `parallel`, `box`, `convex` / `concave`,
   `kind`, length).
5. **Cutter.** At every chain vertex a cross-section is built in the plane perpendicular to the edge:
   - `dL` and `dR` are the in-face directions away from the edge, and θ is the angle between them.
   - The tangent points sit at distance `r / tan(θ/2)` along each face.
   - The fillet arc is centred on the bisector at `r / sin(θ/2)`.
   - The section polygon is apex → tangent point → arc → tangent point.
   The sections are **stitched into one swept mesh**. A single mesh avoids the hundreds of sliver
   triangles that per-segment hulls produce. Convex chains are subtracted and concave chains are
   unioned. The cutter is pushed a hair outside the faces so no cutter face is coplanar with the body.
6. **Corners.** Where three or more selected convex chains meet at a vertex with three face planes, the
   sphere centre that is `r` behind all three planes is solved. A hull-minus-sphere corner cutter is
   added.

Chamfers use a triangle section with no arc. The chamfer tips slide along the chamfer line so the
chamfer plane stays exact.

## Shell

Minkowski-based offsetting in manifold took 2–25 s per part and was inexact on planar faces, so shell
is built directly. It keeps every point within `t` of the surface, except near open faces:

1. Split the surface into **smooth patches**: triangles connected across non-feature edges, with open
   faces excluded.
2. For each patch, build one **offset band**: the patch, its offset copy and side walls. Vertex offsets
   keep every incident facet plane exactly `t` away. A single plane gives `t·n`. Nearly parallel normals
   give `t·n̄ / min(n_i·n̄)`. Spread normals use a least-squares solve, which is exact for up to three
   planes. If the offset would fold over (curvature tighter than `t`), the patch falls back to per-facet
   slabs.
3. Add **capsules** along patch boundaries. These fill the gaps where neighbouring bands diverge (the
   rounded inner blend at concave edges) and are always inside the true offset region.
4. Result: `body ∩ ∪(bands, capsules)` for an inward shell, or `(body ∪ skin) − (body ∪ open-face slabs)`
   for an outward one.

Flat walls come out exactly `t` thick. Typical parts shell in 0.1–2 s.

## Sweeps and lofts

- **Sweep along a path.** The profile is carried from vertex to vertex of the path polyline and
  projected onto each **mitre plane**, whose normal is the bisector of the incoming and outgoing
  directions. This gives a rotation-minimising sweep that is exact for polyline paths and preserves
  volume (Pappus) for smooth ones. The path is oriented to start at the end nearest the profile.
- **Helix.** An exact screw motion (rotation plus rise) of the profile, so threads and springs don't
  drift.
- **Loft.**
  - Sections are oriented consistently, and their start vertices are aligned.
  - Each section is resampled at the **union of all sections' vertex arc-length fractions**, so every
    corner of every section is kept.
  - With 3+ sections, or with end tangency, rings are interpolated with Hermite / Catmull–Rom
    (`steps` per span).
- `stitch()` connects rings into side walls and triangulates the end caps (manifold `triangulate`).
  `meshToManifold()` fixes the global orientation from the signed volume.

## Mesh hygiene

Exact booleans on faceted geometry can still leave degenerate leftovers: zero-volume shells along
near-coplanar seams, or microscopic voids. After fillet, chamfer and shell, `dropSlivers()` decomposes
the body. `decompose()` splits by **surface**, so closed cavities appear as negative-volume shells.
The body is rebuilt as *(positive shells) − (flipped real cavities)*, dropping anything below 10⁻⁶ of
the body volume. Body statistics count positive shells as **solids** and negative ones as **cavities**.

## The browser app

- **`main.js`** holds the document, undo / redo (JSON snapshots, committed only when something changed),
  rebuild on every change, the timeline, parameter and body panels, picking modes (sketch plane, face,
  regions, edges, faces, measure) and live sync.
- **`viewport.js`** is the three.js scene: Z-up orbit controls, perspective and orthographic cameras,
  flat-shaded bodies with feature-edge lines, datum planes, passive sketches, ray picking and view
  presets.
- **`sketcher.js`** draws the active sketch in plane space and handles snapping, all drawing and editing
  tools, the constraint buttons, dimension dialogs, HTML overlays for dimension labels and constraint
  symbols, and dragging through the solver.
- **`inspector.js`** contains generic field controls (expressions with evaluated values, selects,
  vectors, chips) and an editor per feature type, plus "Edit as JSON".

## CLI, renderer and server

- **`cli/cad.mjs`** has the commands `build`, `info`, `set`, `render`, `export`, `section`, `sketch`,
  `edges`, `faces` and `history`. `build` imports a script, runs it against a `Builder`, rebuilds, saves
  the document atomically (write to a temp file, then rename) and prints the report.
- **`cli/render.mjs`** is a z-buffered software rasteriser. It draws flat shading, feature and
  silhouette edges (skipping sliver triangles), an axis triad and labels in a built-in 5×7 bitmap font,
  and encodes PNG with zlib. It needs no GPU or browser, so Claude can render previews anywhere.
- **`server.mjs`** serves `app/`, `core/`, `examples/` and the two dependencies. It watches the document
  file (polling, robust to atomic renames) and broadcasts changes over SSE. `PUT /api/doc` saves edits
  from the app and forwards them to the other tabs, and `GET /api/health` reports the app and its
  clients.

## Testing

`npm test` runs `test/run.mjs`. It covers:
- **Expressions:** precedence, units, cycles and reserved names.
- **Solver:** degrees of freedom, conflicts, tangency and equations.
- **Every feature type**, checked against analytic volumes: boxes, holes, sheared prisms, frustum lofts,
  partial revolves, mitred sweeps, filleted boxes with spherical corners, shells with exact walls.
- **Profile booleans, regions, trim and corner fillets.**
- **Exports:** byte layouts of STL / OBJ / 3MF / DXF.
- **Examples:** every example built through the CLI.

Prefer checking geometry against closed-form values over snapshot comparisons.

## Design decisions and limits

- **Mesh kernel instead of B-rep.** manifold is small, fast, has no native build and gives
  guaranteed-valid booleans in both Node and the browser. The cost is no exact curved surfaces and no
  STEP export, and fillets, chamfers and shell had to be reconstructed from mesh topology (above). Curves
  are faceted to a chord tolerance, and exports are rebuilt finer.
- **No bundler or framework.** The app is plain ES modules, so the skill works anywhere Node.js does,
  and core code is shared verbatim.
- **Explicit references.** Faces are referenced by a point, which is robust to most parametric changes
  but not to every one; datum planes are fully robust. Edges are referenced by rule or by nearest point.
  This sidesteps the topological naming problem rather than solving it.
- **Single-sketch solving.** Sketches are solved independently, in timeline order. There is no
  cross-sketch or assembly constraint solving.
