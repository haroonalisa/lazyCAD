# Using LazyCAD as a Claude skill

LazyCAD ships as a [Claude skill](https://docs.claude.com/en/docs/claude-code/skills): the repository
root contains a `SKILL.md` that teaches Claude how to model with LazyCAD. Once the skill is installed,
you can describe a part in plain language. Claude then:
1. writes a model script,
2. builds it,
3. checks the measurements and the rendered views,
4. iterates until the part is right,
5. leaves the model open in the app, where you can keep editing it.

## Install

```bash
git clone https://github.com/haroonalisa/lazyCAD.git lazyCAD
cd lazyCAD
npm install
ln -s "$PWD" ~/.claude/skills/lazycad        # or copy the folder there
```

Requirements: Node.js 18+. The skill name is `lazycad`. Claude Code discovers it automatically in
`~/.claude/skills/` (or a project's `.claude/skills/`).

## What Claude does

`SKILL.md` describes a fixed workflow:

1. **Start the live app** if needed (`node server.mjs` on port 8777) and open http://localhost:8777,
   so you can watch the model appear.
2. **Look at the current model** (`cli/cad.mjs info`). Claude extends your existing model when that's
   what you asked for, instead of overwriting it. Overwritten documents are backed up in
   `models/.history/`.
3. **Write a model script** in `models/<name>.js`, using parameters for the important sizes and
   constraints so the result stays editable.
4. **Build and verify.** The build report gives exact bounding boxes, volumes, solid counts, genus
   (the number of through-holes), sketch degrees of freedom and feature warnings. Claude also looks at the
   rendered PNG views and, when useful, takes cross-sections.
5. **Report** what it built, with the key dimensions, and export files on request (3MF / STL / OBJ for
   3D, DXF / SVG for 2D profiles).

Every change Claude makes appears live in the open browser tab and can be undone there. Every change
you make in the app is saved to the same file, so Claude sees it the next time it looks.

## Example prompts

- *"Design a 80 × 50 × 30 mm electronics enclosure with 2 mm walls, 6 mm corner radius, four M2.5 screw
  bosses and a USB-C cutout in the front. Export a 3MF."*
- *"Make a pipe flange: OD 120, bore 50, 14 mm thick, 6 × 11 mm bolt holes on a 95 mm circle."*
- *"Add a 1 mm chamfer to the bottom edge and round the top rim by 0.8 mm."*
- *"Change the wall thickness to 3 mm and make it 10 mm taller."*
- *"I moved the cutout in the app. Can you add a matching one on the back?"*
- *"Give me the base sketch as a DXF for the laser cutter."*

Tips:
- **State dimensions and what they mean**: outer vs inner, diameter vs radius, which direction. Claude
  will choose a coordinate system and tell you which way is front and up.
- **Ask for parameters** you expect to change later ("make the wall thickness a parameter").
- **Ask for checks** that matter to you, such as clearances, minimum wall thickness or the fit with
  another part. Claude can measure with cross-sections and bounding boxes.
- For 3D printing, ask for **3MF**, which carries units.

## How the pieces fit together

```
            ┌──────────────┐  writes   ┌──────────────────────────┐  watches  ┌──────────────┐
 Claude ──▶ │  cli/cad.mjs │ ────────▶ │ models/current.cad.json  │ ◀──────── │  server.mjs  │
 (skill)    │ (same kernel)│  reports  └──────────────────────────┘   SSE /   │  :8777       │
            └──────────────┘ ◀──────── exact measurements + PNG       PUT     └──────┬───────┘
                                                                                     │ live
                                                                              ┌──────▼───────┐
                                                                     you ───▶ │  browser app │
                                                                              └──────────────┘
```

- The CLI and the app share `core/`, so a model behaves exactly the same in both.
- The server pushes file changes to every open tab (Server-Sent Events) and saves app edits back with
  `PUT /api/doc`.
- The document is plain JSON: parameters, an ordered feature list and display settings. Claude can
  read it directly. Ids of features, entities and constraints stay stable across edits.

## Configuration

| Setting | How |
|---|---|
| Port | `node server.mjs --port 8778` or `LAZYCAD_PORT=8778`. The health check `GET /api/health` returns `{"app":"lazycad", ...}` |
| Document file | `node server.mjs --doc path/to/file.cad.json`. Pass `--out` to `cli/cad.mjs build` to match |
| Curve accuracy | `cad.settings({ tolerance, exportTolerance })` in a script, or *Document settings* in the app |

## Limits worth knowing

- The kernel is mesh-based. Exports are STL / OBJ / 3MF (3D) and DXF / SVG (2D), and there is **no
  STEP**. If you need STEP for a hand-off to another CAD system, LazyCAD can't provide it.
- Fillets apply to edges between faces. A radius larger than an adjacent face can produce poor
  results.
- Face references (`{ face: { body, point } }`) pick the face nearest a point. Datum planes are more
  robust when sizes change a lot.
