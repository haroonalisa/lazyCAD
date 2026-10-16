# LazyCAD user guide

This guide covers the browser app. For building models from code, see the
[scripting guide](scripting-guide.md). For every option in detail, see the [API reference](reference.md).

- [Starting the app](#starting-the-app)
- [The screen](#the-screen)
- [Navigating the 3D view](#navigating-the-3d-view)
- [Parameters](#parameters)
- [Sketching](#sketching)
- [Constraints and dimensions](#constraints-and-dimensions)
- [Solid features](#solid-features)
- [Fillet, chamfer and shell](#fillet-chamfer-and-shell)
- [Modify features](#modify-features)
- [The timeline](#the-timeline)
- [Measuring](#measuring)
- [Saving and exporting](#saving-and-exporting)
- [Live sync with the CLI and Claude](#live-sync-with-the-cli-and-claude)
- [Keyboard and mouse reference](#keyboard-and-mouse-reference)

## Starting the app

```bash
npm install
npm start            # or: node server.mjs --port 8777 --doc models/current.cad.json
```

Open http://localhost:8777. The server keeps the app in sync with one document file, by default
`models/current.cad.json`. The status at the top right shows **● live** when the app is connected.

If you open `app/index.html` some other way, without the server, the status shows **○ local**. The
document is then kept in your browser's local storage instead.

## The screen

| Area | What it holds |
|---|---|
| **Top bar** | File (New, Open, Save, Export ▾), Undo / Redo, and the feature tools: Sketch, Extrude, Revolve, Sweep, Loft, Fillet, Chamfer, Shell, Solid ▾ (box, cylinder, cone, sphere, torus), Modify ▾ (pattern, mirror, move / rotate, boolean, split), Plane, Measure |
| **Left: Parameters** | Named values and formulas used anywhere in the model |
| **Left: Timeline** | The ordered list of planes, sketches and features, which is the model's history |
| **Left: Bodies** | Every solid, with visibility (which also controls export), colour and volume |
| **Centre: Viewport** | The 3D view, with view buttons at the bottom right and a status bar at the bottom |
| **Right: Inspector** | Context panel: model overview, the editor for the selected feature, the sketch inspector, or measurement results |

With nothing selected, the inspector shows:
- each body's exact size, bounding box, volume, area and centroid,
- **Document settings**: name, curve tolerance and export tolerance,
- the built-in **Examples**,
- a shortcut list.

## Navigating the 3D view

| Action | Mouse |
|---|---|
| Orbit | Left-drag on empty space (outside a sketch), or middle-drag |
| Pan | Right-drag |
| Zoom | Mouse wheel (zooms toward the cursor) |
| Select a feature | Click a body. The feature that last shaped it opens in the inspector |

The view buttons are **Iso**, **Front** (looking along +Y), **Top**, **Right**, **⊥ Plane** (look straight
at the active sketch), **Fit** (`F`) and **Ortho**, which toggles between orthographic and perspective.
The status bar shows the rebuild result and time, and the coordinates under the cursor.

## Parameters

Press **+** in the Parameters panel and give a name and a value. A value can be a formula:

```
width   = 80
wall    = 2
inner   = width - 2*wall
hole    = 1/8in            → 3.175
angle   = atan2(3, 4)      → 36.87  (degrees)
```

You can use parameter names in every numeric field: dimensions, distances, counts, angles, positions.
The evaluated value is shown next to each field. Renaming a parameter updates every formula that uses
it. A parameter with an error, such as an unknown name or a circular reference, is outlined in red.

Units: lengths are **millimetres**, angles are **degrees**. Number suffixes `mm cm m in ft deg rad` convert
to these units. Trigonometric functions take and return degrees.

## Sketching

### Creating and editing a sketch

1. Press **Sketch** (`S`).
2. Click where to sketch:
   - one of the three origin planes (XY, XZ, YZ),
   - a datum plane,
   - any flat or curved **face of the model**.
3. The view turns to face the plane and the sketch toolbar appears.
4. Draw, constrain and dimension.
5. Press **✓ Finish** (`Enter`).

To edit a sketch later, double-click it in the timeline or use its **✎** button.

On a face, sketch coordinates line up with the world. On a top face, *u* is X and *v* is Y. The
origin is the world origin projected onto the face.

### Drawing tools

| Tool | How to use |
|---|---|
| **Line** (`L`) | Click points to draw a connected polyline. Click the start point (or any existing point) to close it. `Esc` or double-click ends the chain. Lines within 2.5° of horizontal or vertical get that constraint automatically |
| **Rect** (`R`) | Two opposite corners. Comes with horizontal / vertical constraints |
| **C-Rect** | Centre, then a corner. The centre is tied with a construction diagonal |
| **Circle** (`C`) | Centre, then a point on the circle |
| **Arc** (`A`) | Centre, start point, end point. The direction follows your mouse |
| **Polygon** | Centre, then a corner. Set the number of sides in the inspector. It has equal sides on a construction circle |
| **Slot** | First centre, second centre, then the width |
| **Spline** | Start and end point. Then drag the two control handles |
| **Point** | A standalone point, for example a reference for dimensions |

**Snapping**
- The cursor snaps to existing points. Clicking one reuses it, which is how curves connect.
- It snaps to the grid (toggle and step size in the toolbar).
- It snaps onto curves. A new point placed on a curve gets a point-on constraint.

A small circle marks an active snap. The hint at the bottom of the screen shows live lengths, angles
and sizes while you draw.

### Editing tools

| Tool | How to use |
|---|---|
| **✂ Trim** (`T`) | Click the part of a curve to remove. It is cut back to the neighbouring intersections. A curve that crosses nothing is deleted, and a circle cut at two points becomes an arc. The new end points stay attached to the curves that cut them |
| **⌒ Fillet** | Click the corner point where two lines meet. The size comes from the box next to the tool, which can be a number or a parameter formula. A tangent arc with a radius dimension replaces the corner |
| **◺ Chamfer** | Click a corner point to bevel it by the size in the box |
| **┄ Construction** (`X`) | Toggles construction on the selection. Construction geometry (dashed orange) helps constrain the sketch but never becomes a profile |
| **🗑 Delete** (`Del`) | Deletes the selection. Deleting a point deletes the curves that use it, and orphaned end points are cleaned up |

Filleting or chamfering a corner keeps the original sharp corner as a construction point on both
lines. Dimensions and fixes that referred to the corner keep working, and line-length dimensions become
corner-to-corner distances.

### Selecting and dragging

With **Select** active (`Esc` returns to it):
- Click a point, curve, dimension or constraint symbol to select it. **Shift**-click adds to the
  selection.
- **Drag a point or curve** to move it. The solver keeps every constraint satisfied while you drag.
  Dragging the edge of a circle changes its radius.
- The inspector shows the selection. Point coordinates can be typed in directly.

### Colours

| Colour | Meaning |
|---|---|
| Blue | Still free to move (under-constrained) |
| Black / white (theme) | Fully constrained |
| Dashed orange | Construction geometry |
| Red | Involved in conflicting constraints |
| Amber | Selected |

The light blue fill shows the area an extrude of "all closed regions" would use. The status bar shows
the sketch's remaining **degrees of freedom** and the number of closed loops. A sketch with 0 degrees of
freedom (✓ in the timeline) cannot change unless a dimension or parameter changes.

### Closed regions

Curves that share end points form closed shapes. Curves that cross each other split into separate
**regions**. For example, a line drawn across a rectangle makes two regions, and two overlapping circles
make three. When you extrude, you can use every closed region or click individual regions (see
[Profiles](#profiles)).

## Constraints and dimensions

Select the geometry, then press a constraint button:

| Button | Needs | Effect |
|---|---|---|
| **⟷ Dim** (`D`) | See below | Adds a dimension |
| **●** Coincident | 2 points | Same position |
| **H** / **V** | Line(s) or 2 points | Horizontal / vertical |
| **∥** / **⊥** | 2 lines | Parallel / perpendicular |
| **=** Equal | 2+ lines, or 2+ circles / arcs | Equal length / radius |
| **T** Tangent | Line + circle / arc, two circles, or two curves sharing an end point | Tangent (smooth at a shared end point) |
| **◎** Concentric | 2 circles / arcs | Same centre |
| **M** Midpoint | Point + line | Point at the line's middle |
| **⊷** Point on | Point + line or circle | Point lies on the curve |
| **⋯** Collinear | 2 lines | On one infinite line |
| **⇋** Symmetric | 2 points + line | Mirror images about the line |
| **⚓** Fix | Points or curves | Locked in place |
| **ƒ=** Equation | Nothing | Any equation, for example `len(l1) = 2*len(l2)` or `x(p3) = width/2` |

Constraint symbols appear next to the geometry. Click one to select it, then press `Del` to remove it.
The sketch inspector also lists every constraint.

**Dimensions.** Select the geometry and press `D`:

| Selection | Dimension types offered |
|---|---|
| One line | Length, horizontal, vertical |
| Two points | Aligned, horizontal, vertical distance |
| Circle / arc | Diameter, radius |
| Two lines | Angle (counter-clockwise from the first to the second) |
| Point + line | Perpendicular distance |
| One point | Horizontal / vertical distance from the sketch origin |

How the dimension dialog works:
- The **Value** can be a number, a parameter name or a formula. Leave it empty to keep the current
  measurement.
- Tick **Reference only** to show a measurement without enforcing it. Reference dimensions are shown in
  parentheses.
- If a new dimension would over-constrain the sketch, it is added as a reference dimension instead and
  you are told.
- **Double-click a dimension label** to edit its value in place.

## Solid features

Creating a feature adds it to the timeline and opens its editor in the inspector. The model rebuilds
live as you change fields, so the editor doubles as a preview. Press **✓ Done** when finished. Every
editor also has **Suppress**, **Delete** and **Edit as JSON**, which exposes every option, even ones
without a form field.

### Operation

Every solid feature has an **Operation**:
- **New body**: creates a body. You can name it.
- **Join**: unions with a body. The default target is the last body.
- **Cut**: subtracts from bodies. The default is all bodies.
- **Intersect**: keeps only the overlap.

When you switch a feature on a face sketch to **Cut**, LazyCAD reverses it automatically, so it cuts
into the material. If a cut removes nothing, the feature shows a warning ("Cut removed no material").

### Extrude (`E`)

- **Sketch** and **Profile** (see below).
- **Distance**: a negative value goes the other way, and `through` cuts through everything.
- **Symmetric** or **Other side** for two-sided extrudes, and **Reverse** to flip the direction.
- **Direction**:
  - the sketch normal (default),
  - world X / Y / Z,
  - a **tilt** from the normal (for angled extrusions),
  - any vector,
  - along a line in a sketch.
- **Twist / taper**: twist angle, top scale and start offset.

### Profiles

How the **Profile** field chooses the area to extrude:
- **All closed regions** (default). Nested shapes alternate: a circle inside a rectangle becomes a
  hole.
- **Picked regions**. Press **⌖ Pick regions**, then click areas of the sketch in the viewport to add or
  remove them (picked regions turn amber). `Esc` when done.
- **Expression (JSON)**. Boolean combinations of shapes, for example `{"subtract": ["l1", "c1"]}`,
  `{"intersect": [...]}`, `{"xor": [...]}`, `{"offset": 2, "of": "l1"}` or `{"point": [u, v]}`. Any
  entity id stands for the closed shape it belongs to. The editor lists the sketch's loop ids.

### Revolve

Pick the axis: the sketch's vertical or horizontal axis, any line in the sketch, or a world axis. Set
the **Angle**, which defaults to 360°; a negative angle goes the other way. **Symmetric** centres it on
the sketch. The profile must lie on one side of the axis.

### Sweep

Sweeps the profile along one of these paths:
- **Sketch curves**: a path drawn in another sketch. Pick which curves with the chips. The sweep starts
  at the end nearest the profile, and corners are mitred.
- **Helix**: pitch, turns, axis, origin, handedness. Draw the profile in a plane that contains the
  axis, for example XZ for a Z helix.
- **3D polyline**: explicit points.

### Loft

Add sections, which are sketches each with one closed shape, in order. **Smooth** curves the surface
through 3+ sections. Turn it off for straight (ruled) segments. **Start / End tangency** (weights such as
1) make the loft leave the first section, or arrive at the last one, square to it, which gives
vase-like shapes.

### Solid primitives

Box, cylinder, cone, sphere and torus, with dimensions, **Centered**, **Position** and **Rotate XYZ°**.

### Plane

A datum plane:
- based on another plane, or placed on a face (**⌖ Place on face…**),
- with an **Offset**,
- tilted about its own X / Y axes,
- optionally flipped.

The order of operations is: base, then tilt, then offset along the new normal. You can sketch on a
datum plane, mirror across it or split with it.

## Fillet, chamfer and shell

### Fillet and chamfer

1. Press **Fillet** or **Chamfer**. The editor opens in edge-picking mode, showing the body as it was
   **before** this feature.
2. Click edges to select them.
   - Blue edges are outside (convex), purple edges are inside (concave), and orange edges are selected.
   - Edges that meet smoothly, such as a whole circle or a rounded outline, are selected as one chain.
3. Set **Radius** (fillet) or **Distance** (chamfer). A chamfer can have a second distance for an
   asymmetric bevel.
4. Press **✓ Done picking** to see the result.

The **Edges** menu offers rules instead of picking: all edges, all outside edges, all inside edges,
straight edges parallel to X / Y / Z, or a custom JSON rule such as `{"z": 30}` for every edge at
height 30.

How it behaves:
- Outside edges are rounded by removing material. Inside edges, such as where a boss meets a plate,
  get material added.
- Where three filleted edges meet at a corner, the corner becomes a smooth sphere.

### Shell

1. Press **Shell**, then click the faces to leave **open**. These are removed, for example the top of
   a box. With no open faces, the solid becomes a closed hollow.
2. Set the **Thickness**.

**Grow outward** adds the wall outside the current surface instead of hollowing inward. Flat walls are
exactly the given thickness.

Order matters as in any CAD:
- round vertical edges *before* shelling to get rounded inside corners,
- fillet the rim *after* shelling.

## Modify features

| Feature | What it does |
|---|---|
| **Pattern** | Repeats a **feature** (re-applying its operation, so patterning a hole cut gives more holes) or copies a whole **body**. Linear (one or two directions, count, spacing) or circular (axis, count, total angle) |
| **Mirror** | Mirrors a feature or body across a plane and joins the copy |
| **Move / Rotate** | Translates and / or rotates a body. Optionally makes a copy |
| **Boolean** | Union / subtract / intersect between bodies |
| **Split** | Cuts a body with a plane, keeping the front side, the back side, or both as two bodies |

## The timeline

The timeline is the model's history, evaluated top to bottom. Hover an item for its actions:
- **✎**: edit sketch
- **👁 / ◌**: show / hide sketches and planes
- **↑ ↓**: reorder
- **✕**: delete

Click an item to edit it. Failed features are shown in red, with the error in the tooltip and the
inspector. The rest of the model still builds. Sketches show a badge: **✓** for fully constrained,
a number for the remaining degrees of freedom, or **✗** for conflicting constraints.

**Undo / Redo** (`Ctrl+Z` / `Ctrl+Shift+Z`) covers every change, including changes pushed from the CLI
or Claude.

## Measuring

Press **Measure** (`M`) and click two points on the model. Vertices within a few pixels snap. The
inspector shows:
- the distance,
- Δx, Δy and Δz,
- the angle between the two faces you clicked,
- the volume, area and size of the body.

`Esc` exits.

## Saving and exporting

- **Save** downloads the document as `.cad.json`. **Open** loads one, and **New** starts an empty
  document (undo can bring the old one back).
- **Export ▾**:
  - **STL** (binary or ASCII), **OBJ** and **3MF** for 3D printing and other tools. 3MF carries
    millimetre units and is the best choice for slicers.
  - Only visible bodies are exported. Use the checkboxes in the Bodies panel to choose.
  - Exports are rebuilt at the **export tolerance** (0.002 mm by default; set it in Document settings),
    so curves come out smoother than on screen.
- **Active sketch → DXF / SVG** exports the sketch you are editing (or the selected sketch) as 2D, with
  true arcs and circles, for laser cutting or CNC.

## Live sync with the CLI and Claude

The server watches the document file:
- When the CLI or Claude writes a new model, the open tab reloads it within a fraction of a second
  ("Model updated from file"). The change goes onto the undo stack, so you can undo it.
- Your edits in the app are saved back to the same file about 0.3 s after each change.

Ids of features, sketch entities (`p1`, `l3`, `c1`…) and constraints (`k4`) stay stable, so you and
Claude can refer to the same things.

The browser console also exposes the model API as `window.cad`: `cad.doc`, `cad.run(fn)`, `cad.report()`,
`cad.setParam(name, value)`, `cad.export('stl')` and more. See the [reference](reference.md#browser-automation-windowcad-in-the-app).

## Keyboard and mouse reference

| Context | Keys |
|---|---|
| Anywhere | `Ctrl+Z` undo · `Ctrl+Shift+Z` / `Ctrl+Y` redo · `Ctrl+S` save · `F` fit · `Esc` cancel / deselect |
| 3D mode | `S` sketch · `E` extrude · `M` measure · `Del` delete the selected feature |
| Sketch | `L` line · `R` rectangle · `C` circle · `A` arc · `P` point · `T` trim · `D` dimension · `H` / `V` horizontal / vertical · `X` construction · `Del` delete · `Enter` finish · `Esc` cancel tool |
| Mouse | Left: select / draw / orbit on empty space (outside sketches) · Middle: orbit · Right: pan, or cancel the current drawing step · Wheel: zoom |
