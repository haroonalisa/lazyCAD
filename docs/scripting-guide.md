# LazyCAD scripting guide

Model scripts are short JavaScript modules that describe a part. The CLI evaluates them with the
same kernel the app uses, and reports exact measurements. Scripts are how Claude builds models, and they
are a fast, repeatable way for you to build them too.

This guide builds up from a plate to a finished enclosure. The [API reference](reference.md) lists every
method and option.

- [Anatomy of a script](#anatomy-of-a-script)
- [Running scripts](#running-scripts)
- [Step 1: a parametric plate](#step-1-a-parametric-plate)
- [Step 2: holes, slots and rounded corners](#step-2-holes-slots-and-rounded-corners)
- [Step 3: sketching on other planes and faces](#step-3-sketching-on-other-planes-and-faces)
- [Step 4: revolve, sweep and loft](#step-4-revolve-sweep-and-loft)
- [Step 5: fillet, chamfer and shell](#step-5-fillet-chamfer-and-shell)
- [Step 6: patterns, mirrors and booleans](#step-6-patterns-mirrors-and-booleans)
- [Verifying a model](#verifying-a-model)
- [Modifying an existing model](#modifying-an-existing-model)
- [Patterns for common parts](#patterns-for-common-parts)
- [Troubleshooting](#troubleshooting)

## Anatomy of a script

```js
export default (cad) => {
  cad.name('My part');                     // optional document name
  cad.params({ w: 40, t: 3 });             // named parameters

  const s = cad.sketch('XY');              // a sketch on a plane → SketchBuilder
  s.rect([0, 0], [40, 20]);                // geometry (returns ids)
  cad.extrude(s, { distance: 't' });       // features take sketches and options
};
```

- `cad` is a `Builder`. It records parameters, planes, sketches and features into a JSON document,
  which is the same format the app saves.
- Every method that creates something returns its **id**. Rectangles, polylines and slots return
  objects of ids. Ids are generated (`sketch1`, `l3`, `extrude2`…) unless you pass `{ id }`. Name the
  things you will refer to later.
- Any numeric value can be a number or an **expression string** using parameters: `'t'`, `'w/2 - 3'`,
  `'2*pi*r'`, `'1in'`.
- Units: millimetres and degrees.

## Running scripts

```bash
node cli/cad.mjs build my-part.js                        # build, save as the live document, print report
node cli/cad.mjs build my-part.js --png preview.png      # + render iso/front/top/right views
node cli/cad.mjs build my-part.js --3mf part.3mf --stl part.stl
node cli/cad.mjs build my-part.js --no-save --json       # just evaluate and print a JSON report
node cli/cad.mjs build more.js --append                  # run on top of the current document
```

`build` writes `models/current.cad.json`. If `npm start` is running, the browser shows the result
immediately. The previous document is backed up in `models/.history/`.

## Step 1: a parametric plate

```js
export default (cad) => {
  cad.params({ w: 60, d: 40, t: 5 });
  const s = cad.sketch('XY', { id: 'base' });
  const r = s.rect([0, 0], [60, 40]);   // 4 lines + horizontal/vertical constraints
  s.fix(r.bl, [0, 0]);                  // anchor the bottom-left corner
  s.length(r.bottom, 'w');              // driving dimensions
  s.length(r.left, 'd');
  cad.extrude(s, { id: 'plate', distance: 't' });
};
```

`rect` returns `{ points, lines, bottom, right, top, left, bl, br, tr, tl }`. With the corner fixed and
two lengths set, the sketch is **fully constrained** (`dof=0` in the report). Change `w` and the plate
follows:

```bash
node cli/cad.mjs set w=80
```

You don't have to constrain anything. Geometry given with exact coordinates is already exact. Constraints
make a design *editable*: by parameter, by Claude, or by dragging in the app.

## Step 2: holes, slots and rounded corners

```js
const h = s.circle([30, 20], 3.25, { id: 'hole' });
s.diameter(h, 'holeD');
s.hDistance(r.bl, s.centerOf(h), 'w/2');   // signed: centre.x − corner.x = w/2
s.vDistance(r.bl, s.centerOf(h), 'd/2');

s.slot([10, 10], [10, 30], 6.5);           // stadium between two centres, width 6.5
s.filletAll(r, 4);                         // round all four corners, r = 4 (or a parameter)
```

Nested closed shapes become holes when you extrude "all". To choose areas explicitly, use a
**profile**:

```js
cad.extrude(s, { distance: 5, profile: { subtract: ['l1', 'hole'] } });   // rectangle minus the hole
cad.extrude(s, { distance: 5, profile: { point: [5, 5] } });              // just the region at (5, 5)
cad.extrude(s, { distance: 5, profile: { offset: -1, of: 'l1' } });       // the outline shrunk by 1 mm
```

Trim and corner tools work in scripts too:

```js
const c = s.circle([30, 20], 8);
s.line([26, 5], [26, 26]);
s.trim(c, [30, 12]);          // remove the piece of the circle nearest (30, 12)
s.fillet(r.tl, 3);            // round one corner
s.chamfer(r.tr, 2);           // bevel another
```

## Step 3: sketching on other planes and faces

```js
// Standard planes: 'XY' (normal +Z), 'XZ' (front, normal −Y, u = X, v = Z), 'YZ' (normal +X)
const wall = cad.sketch({ base: 'XZ', offset: '-d' });      // XZ plane moved to y = d
const tilted = cad.sketch({ base: 'XY', offset: 10, rotate: { x: 30 } });

// A face of a body: the face nearest the point. Use parameters so it tracks size changes.
const top = cad.sketch({ face: { body: 'plate', point: [10, 10, 't'] } });
top.rect([5, 5], [15, 35]);
cad.cut(top, { distance: 2, reverse: true });   // cut into the material
```

- Face sketches use world-aligned coordinates: on a top face *u* = X and *v* = Y.
- Extrusions go along the sketch normal. On a face, that is outward, so cuts need `reverse: true` (or
  a negative distance). `distance: 'through'` cuts through everything.
- A datum plane (`{ base: 'XY', offset: 't' }`) is the most robust way to reach a face, because it does
  not depend on which face is nearest a point.

## Step 4: revolve, sweep and loft

```js
// Revolve a half cross-section drawn in XZ about the sketch's vertical axis (= world Z)
const prof = cad.sketch('XZ');
prof.polyline([[25, 0], [60, 0], [60, 14], [38, 14], [38, 36], [25, 36]], { closed: true });
cad.revolve(prof, { id: 'body', axis: 'v' });

// Sweep a circle along a path drawn in another sketch
const path = cad.sketch('XY');
path.polyline([[0, 0], [40, 0], [40, 30]]);
const pipe = cad.sketch('YZ');
pipe.circle([0, 0], 3);
cad.sweep(pipe, { path: { sketch: path } });

// Helix (springs, threads): draw the profile in a plane containing the axis
const wire = cad.sketch('XZ');
wire.circle([10, 0], 1);
cad.sweep(wire, { path: { helix: { pitch: 6, turns: 6 } } });

// Loft through sections (smooth with 3+), or between two with end tangency
const a = cad.sketch('XY'); a.centerRect([0, 0], 40, 40);
const b = cad.sketch({ base: 'XY', offset: 30 }); b.circle([0, 0], 14);
const c = cad.sketch({ base: 'XY', offset: 60 }); c.circle([0, 0], 8);
cad.loft([a, b, c]);
```

## Step 5: fillet, chamfer and shell

```js
cad.fillet({ body: 'box', edges: { parallel: 'z' }, radius: 6 });      // vertical edges
cad.shell({ body: 'box', thickness: 2, open: [{ point: ['L/2', 'W/2', 'H'] }] });  // open top
cad.fillet({ body: 'box', edges: { z: 'H' }, radius: 0.8 });           // round the rim
cad.chamfer({ body: 'box', edges: { z: 0 }, distance: 1 });            // bevel the bottom edge
```

Ways to select edges (combine filters in one object to AND them; use arrays to OR them):

| Selector | Meaning |
|---|---|
| `'all'` | Every edge |
| `{ near: [x, y, z] }` | The edge chain closest to a point |
| `{ z: 10 }` (or `x`, `y`) | Edges lying at that coordinate |
| `{ parallel: 'z' }` | Straight edges parallel to an axis or vector |
| `{ convex: true }` / `{ concave: true }` | Outside / inside edges |
| `{ kind: 'loop' }` | Closed chains such as circles (`'line'`, `'curve'` also) |
| `{ box: { min: [...], max: [...] } }` | Edges inside a box |

`node cli/cad.mjs edges --body box` lists every edge chain with a `near` point you can copy.
`node cli/cad.mjs faces --body box` lists flat faces with a point on each, for `open` and face sketches.

## Step 6: patterns, mirrors and booleans

```js
const hole = cad.cut(holeSketch, { id: 'hole', distance: 't', reverse: true });
cad.pattern({ of: 'hole', kind: 'circular', axis: 'z', count: 'bolts' });          // more holes
cad.pattern({ of: { body: 'peg' }, kind: 'linear', direction: 'x', count: 4, spacing: 12,
              direction2: 'y', count2: 2, spacing2: 20 });                          // grid of copies
cad.mirror({ of: { body: 'arm' }, plane: 'YZ' });
cad.boolean({ op: 'subtract', target: 'case', tools: ['insert'] });
cad.split({ body: 'case', plane: { base: 'XY', offset: 20 }, keep: 'both' });      // lid + base
```

Patterning a **feature** repeats its operation, so a pattern of a cut is more cuts. Patterning a
**body** copies it.

## Verifying a model

The build report is designed to make checking easy:

```
✓ OK — Enclosure (units: mm; curves within 0.01 mm)
params: L=80, W=50, H=30, wall=2, ...
timeline:
  ✓ outline (sketch) dof=0 fully-constrained loops=1 [a1+a2+a3+a4+l1+l2+l3+l4:3968.86mm²]
  ✓ box (extrude) → box
  ✓ rim (fillet) 2 edge chains → box
  ...
bodies:
  box: size 80 × 50 × 30 mm, bbox min [0, 0, 0] max [80, 50, 30]
      volume 24341.41 mm³, area 24209.22 mm², centroid [40, 25.06, 10.75], solids 1, genus 1
```

A checklist:
1. No `✗` and no unexpected warnings. `Cut removed no material` means the cut went the wrong way.
2. `size` / `bbox` match the intended outer dimensions.
3. `solids 1`, unless you meant separate pieces. `genus` equals the number of through-holes.
4. Look at the PNG (`--png`). It shows iso, front, top and right views with a size caption.
5. Check inside with a section: `node cli/cad.mjs section --axis z --at 15 --svg cut.svg`.

## Modifying an existing model

`--append` runs a script on top of the current document. The builder starts from the existing model:

```js
export default (cad) => {
  const s = cad.editSketch('base');          // continue an existing sketch
  s.circle([50, 30], 2);
  cad.param('t', 8);                          // change a parameter
  cad.feature('cut1').distance = 3;           // tweak an existing feature
  cad.fillet({ body: 'plate', edges: { z: 't' }, radius: 1 });   // add a new feature
};
```

For parameter-only changes, use `node cli/cad.mjs set name=value ...`.

## Patterns for common parts

**Rounded box with lid**: extrude a filleted rectangle, shell it with the top open, then `split` at
the lid height with `keep: 'both'`. Or model the lid as a second body.

**Screw bosses**: two concentric circles per boss on a datum plane at the floor (`{ base: 'XY', offset:
'wall' }`), extruded with `mode: 'add'`. Round the base with
`cad.fillet({ edges: { z: 'wall', concave: true, kind: 'loop' }, radius: 1 })`.

**Bolt circle**: one hole cut, then `pattern` it circularly with `count: 'n'`.

**Cutout in a side wall**: sketch on `'XZ'` (the front plane, *u* = X, *v* = Z) and cut with
`reverse: true` and a distance slightly larger than the wall.

**Thread-like features**: a small triangle in XZ at the radius, swept along a helix, then joined or cut.

**Laser-cut parts**: model in one sketch and export it with
`node cli/cad.mjs sketch --sketch base --out part.dxf`.

See `examples/` for complete, fully parametric scripts: `enclosure.js`, `bracket.js`, `flange.js`,
`spring.js` and `bottle.js`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Sketch "s" has no closed loops` | Curves must share end points (reuse point ids, or snap in the app), or cross each other. Check the `loops=` list in the report |
| `NOT-SOLVED` / `unsatisfied=k3,k7` | Conflicting constraints. Remove one or make a dimension `{ driving: false }` |
| A sketch jumps to a mirrored shape | Start coordinates were far from the solution. Give closer approximate coordinates |
| `Cut removed no material` | The extrude goes away from the body. Use `reverse: true` or a negative distance |
| Face sketch lands on the wrong face | The point is ambiguous or no longer on the face after a size change. Use parameter expressions in the point, or a datum plane |
| `The edge selection matched no edges` | Run `cli/cad.mjs edges` to see the real coordinates and chains |
| Fillet radius too large | The fillet must fit on both faces next to the edge. Reduce the radius |
| Revolve warns about crossing the axis | Keep the profile on one side of the axis |
