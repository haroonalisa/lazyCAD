# Contributing to LazyCAD

Thanks for helping! LazyCAD is deliberately small: plain ES modules, two runtime dependencies, and no
build step.

## Setup

```bash
npm install
npm start          # app at http://localhost:8777 (reloads files on refresh, no build)
npm test           # test suite
```

Node.js 18+ is required.

## Where things live

`core/` is shared by the browser and the CLI, and must stay free of DOM and Node APIs. UI code lives in
`app/`, command-line code in `cli/`. See [docs/architecture.md](docs/architecture.md) for how the
pieces work.

## Guidelines

- **Test geometry against closed-form values.** Volumes, areas, bounding boxes and genus make good
  assertions. Add a case to `test/run.mjs` for every new feature or bug fix.
- **Keep the document format backward compatible.** Add optional fields instead of renaming existing
  ones. Every value may be a number or an expression string.
- **Free WASM memory.** Inside `rebuild`, pass every manifold object you create through `track()`.
  Outside it, call `.delete()`.
- **Report problems as feature errors or warnings** instead of throwing out of `rebuild`. One bad feature
  must not break the model.
- **Keep docs in sync.** When you add or change an API, update [docs/reference.md](docs/reference.md),
  and update [SKILL.md](SKILL.md) if Claude should use it.
- **Code style.** Two-space indent, single quotes, semicolons, small focused functions. Comment the *why*
  in the existing style.

## Ideas

- STEP import / export via an optional B-rep backend.
- Variable-radius fillets, and fillets on edges between curved faces with setbacks.
- Sketch dimensions with leader lines; box selection in the sketcher.
- Assemblies with mates; multi-body export as separate files.
