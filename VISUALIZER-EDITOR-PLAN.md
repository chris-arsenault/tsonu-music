# Visualizer scene graph editor — implementation plan

A ComfyUI-convention node editor, docked below the visualizer canvas, that presents the running scene
as a graph and drives it live. It exists to make the visualizer debuggable: capture whatever the
scheduler put on screen, freeze it, see the whole graph including the parts no view shows today, and
change one thing at a time while it renders. Development-only, behind `?viz-debug=1`. Authored graphs
do not reach ordinary playback; the document format is versioned and committable so that path stays
additive.

## Confirmed decisions

- The canvas is `@xyflow/react`, lazily imported behind the debug flag, its stylesheet injected at
  mount through Vite's `?inline` query. See [ADR-0011](./docs/adr/0011-visualizer-graph-editor-canvas.md).
- An `AuthoredScene` document resolves through `compileGraph` and nothing else. The scene grammar,
  minimum scene size, minimum material branches, and contribution pruning do not apply. Port typing,
  required inputs, and cycle declaration do. See [ADR-0010](./docs/adr/0010-visualizer-authored-scene-graphs.md).
- Authored graphs stay out of production playback. The document is versioned and repo-committable so
  curated scenes can ship later without a format change.
- Inspection is click-to-node, routed through the existing `controls.inspectResource`. Per-node
  thumbnails are backlogged.
- The kernel tail is editable, not merely visible: grade parameters take the same constant-or-binding
  treatment a plugin's do, and persistence and layer settings take pinned overrides.
- The dock absorbs the diagnostics panel. One surface with Graph, Meters, and Performance tabs; the
  floating `viz-diagnostics` aside is retired.

## Context / reuse map

The scene pipeline is already a data pipeline, and the editor is a second front end onto its back
half rather than a new renderer.

| Stage | Module | Editor's relationship |
| ----- | ------ | --------------------- |
| Plugin catalog | `plugins/registry.ts` | Reused as-is. The node search reads `registry.all()`. |
| Plugin contract | `core/plugin.ts` | Reused as-is. `inputs`/`outputs` are sockets; `parameters` are widgets. |
| Random assembly | `core/scheduler.ts` | Bypassed. An authored document replaces it. |
| Auto-wiring | `core/wiring.ts` | Bypassed for authored graphs; `instanceIdFor` changes for both paths (M0). |
| Grammar | `core/grammar.ts` | Bypassed for authored graphs, unchanged for generated ones. |
| Graph compiler | `core/graph.ts` | Reused unchanged, and is the only validator of an authored graph. |
| Bindings | `core/bindings.ts` | Reused as-is. A feature node's outgoing link *is* a `ParameterBinding`. |
| Parameter resolution | `core/parameters.ts`, `core/modulation.ts` | Reused as-is. A parameter with no binding is a constant. |
| Grade parameters | `core/composite-grade.ts` | Reused, retuned: `COMPOSITE_PARAMETERS`/`COMPOSITE_BINDINGS` become an authorable node. |
| Persistence | `core/persistence.ts` | Reused, extended with a pinned-override channel (M2). |
| Layer stack | `host/renderer.ts` `buildLayers` | Reused, extended with per-layer overrides (M2). |
| Instantiation | `host/renderer.ts` `instantiate` | Reused as-is. Instance reuse by id is what keeps simulation state across an edit. |
| Debug controls | `core/diagnostics.ts` | Reused and extended. Mute is `disabledPlugins`; inspect is `inspectResource`. |

Three structures decide what reaches the screen and appear in no edge list today. The editor draws all
three: the layer stack `buildLayers` derives from unconsumed colour outputs, the motion field
`sumMotion` accumulates from every motion-typed resource ([ADR-0008](./docs/adr/0008-visualizer-motion-field-bus.md)),
and the kernel tail — composite, motion, accumulation, meter, grade — that runs outside the graph
entirely ([ADR-0007](./docs/adr/0007-visualizer-kernel-persistence.md)).

Requirements: [spec section 23.1](./docs/visualizer-spec.md). Reserved home:
[`frontend/src/visualizer/ui/editor/`](./frontend/src/visualizer/ui/editor).

## Cross-cutting constraints

- **Decision logic is pure and lives in `core/`.** The document model, its edit operations,
  resolution, layout, and every override are plain functions over plain data, unit-tested in the Node
  environment. `ui/editor/` renders and dispatches. See
  [ADR-0003](./docs/adr/0003-visualizer-pure-core-thin-shell.md).
- **The test environment has no jsdom.** Components are verified with `renderToStaticMarkup`. Node
  bodies are therefore presentational components that render without a React Flow context; only the
  canvas hosting them is uncovered.
- **One entry stylesheet.** React Flow's CSS is injected at mount, never imported into the bundle.
- **Playback outranks the editor.** Live values never flow through React state at frame rate — the
  dock subscribes and writes to refs, and the readout runs at 20 Hz. The editor shares the main
  thread with the kernel; it must not be what makes a frame late. See
  [ADR-0004](./docs/adr/0004-visualizer-playback-supremacy.md).
- **Nothing authored reaches ordinary playback.** The dock and everything it imports sit behind
  `lazy()` gated on `isVisualizerDebugEnabled()`.
- **Every scene reaches the screen through `compileGraph`.** Skipping the grammar is deliberate;
  skipping the compiler is not.

## Milestones

### M0 — Stable instance identity, per-node keying

Two defects on the generated path that an authored document cannot work around. Independently
correct, and worth landing whether or not the editor follows.

- Derive an instance id from a definition's occurrence index rather than its global position, so
  inserting or removing an unrelated node stops renumbering every node after it and resetting its
  state.
- Key parameter overrides and distributed bindings by instance id rather than definition id, so two
  instances of one plugin can differ. Today they cannot, on either path.
- Exit: `make ci` green; a rebuild that adds one plugin preserves every unrelated instance; two
  instances of one definition carry distinct bindings.

### M1 — The authored document and its resolver [depends on M0]

The pure half of the feature, complete and tested before any pixel is drawn.

- `core/authored-scene.ts` — the versioned document (nodes with stable ids, positions, seeds,
  parameters, bindings, mute state; edges; asset bindings; present target) and
  `resolveAuthoredScene`, which reaches `compileGraph` and no other validator. Problems are anchored
  to the node or edge that caused them rather than returned as a flat list.
- `captureScene` — turn a `BuiltScene` the scheduler produced into an editable document.
- `core/authored-scene-edit.ts` — the edit reducer: add, remove, clone, connect, disconnect,
  set constant, bind feature, unbind, promote widget, mute, reseed. Snapshot-based undo and redo.
- `core/graph-layout.ts` — deterministic layered layout for documents carrying no positions, by
  longest-path depth over forward edges.
- **[DECISION]** Does the document capture the scene's palette and theme, or is colour left to the
  kernel? Capturing pins a colour bug for study and grows the schema; leaving it means a reopened
  document renders in a different scheme than it was saved in.
- Exit: `make ci` green; a captured generated scene resolves to a `CompiledGraph` identical to the one
  the scheduler compiled, and every edit operation has a test.

### M2 — Host entry points and authoring mode [depends on M1]

- `renderer.setAuthoredScene` / `clearAuthoredScene`, reusing `applyBuild`'s instance preservation so
  an edit keeps the state of everything it did not touch, and the previous graph when a compile fails.
- Hot writes: `setNodeParameter` and `setNodeBindings` take effect next frame with no teardown.
- Structured problems out of `renderer.problems()`, replacing the `console.warn` on rebuild failure.
- `DiagnosticsControls.authoring` — pins the quality profile so the ladder cannot suppress a plugin
  out of a graph under study, and suppresses mutation and rebuild-on-track-change.
- The kernel tail becomes addressable: pinned overrides over `persistenceSettings`, per-layer blend
  and opacity overrides over `buildLayers`, and the grade's parameters and bindings sourced from the
  document instead of the constants in `core/composite-grade.ts`.
- Exit: `make ci` green; a document drives the kernel end to end in a headless test; with authoring
  off, the modal behaves exactly as before.

### M3 — The dock, the tabs, and a read-only graph [depends on M2]

The point at which the instrument starts paying for itself: everything is visible, nothing is
editable yet.

- `GraphEditorDock` — bottom dock with a drag splitter, collapse, and persisted height, with Graph,
  Meters, and Performance tabs. The existing `DiagnosticsPanel` content moves into the latter two and
  the floating aside is retired.
- The React Flow canvas, with `?inline` stylesheet injection and presentational node bodies.
- Capture the running scene and draw it: plugin nodes, asset nodes, the implicit layer edges, the
  implicit motion edges, and the kernel tail, each node showing its live resolved values.
- Click a node to inspect its resource; mute a node.
- **[DECISION]** Does muting keep the existing `disabledPlugins` semantics, where everything left
  unreachable downstream also stops? Faithful to how suppression already behaves, but muting one
  source can blank half the graph, which may not be what you want while bisecting.
- Exit: `make ci` green; the dock shows the running scene including both implicit buses and the
  kernel tail; node bodies are covered by `renderToStaticMarkup`.

### M4 — Editing [depends on M3]

- Topology: add, remove, clone, connect, disconnect, with `isValidConnection` delegating to
  `portsCompatible`; node search on double-click and on drag-to-empty, filtered by socket type.
- Parameters: constant widgets, promote-to-input, feature nodes carrying mode, range, curve, attack,
  release and polarity, and constant nodes.
- Seed pinning and rerolling; per-layer blend and opacity; the kernel tail's own widgets.
- Undo and redo across every operation.
- Live apply — hot for parameters and bindings, recompile for topology — with problems surfaced on
  the offending node and the last valid graph retained on failure.
- **[DECISION]** Does a newly added node start at its plugin defaults or at the theme's colour-policy
  overrides? Defaults are predictable; overrides match what the same plugin would look like had the
  scheduler placed it.
- Exit: `make ci` green; every operation covered as a reducer test; a topology edit demonstrably
  preserves an untouched simulator's state.

### M5 — Persistence and repro export [depends on M4]

- JSON export and import, and localStorage autosave, with the document version carried and a
  migration hook for a format that will change.
- "Copy as fixture" — emit a compiling `AuthoredScene` literal that pastes straight into a vitest
  file, so a fault found by watching becomes a regression test.
- Document the editor as current state in `docs/visualizer.md`, `frontend/src/visualizer/README.md`,
  and `ui/README.md`. Deferred to here deliberately: those documents assert what exists.
- Exit: `make ci` green; a document exported, reimported, and resolved yields an identical compiled
  graph; a pasted fixture compiles and asserts in a test file.

### Decisions needing your input

| Where | Decision you own |
| ----- | ---------------- |
| M1 | Whether the document captures the scene's palette and theme, or leaves colour to the kernel |
| M3 | Whether muting a node also stops everything it leaves unreachable downstream |
| M4 | Whether a newly added node starts at plugin defaults or at the theme's parameter overrides |
