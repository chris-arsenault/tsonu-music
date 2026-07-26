# Scene graph editor

The visualizer's node editor: a docked surface below the canvas that presents the running scene as a
graph and drives it. Development only — reached through `?viz-debug=1`, lazily imported, and absent
from an ordinary playback session.

This directory holds presentation only. The document model, its edit operations, resolution against
the plugin registry, graph layout, what the canvas draws, and what each gesture means are pure modules
in [`../../core/`](../../core), per
[ADR-0003](../../../../../docs/adr/0003-visualizer-pure-core-thin-shell.md). In particular
`editor-view.ts` derives everything on the canvas from what actually runs, and `editor-actions.ts`
decides whether a link may be drawn and what drawing it does to the document — so connection validity
has one definition, shared with the graph compiler.

Two rules shape what may be written here:

- **Node bodies render without a React Flow context.** They are presentational components over plain
  props, so `renderToStaticMarkup` covers them in the Node test environment. Only the canvas that
  hosts them depends on the library.
- **React Flow's stylesheet is injected at mount**, imported through Vite's `?inline` query. The
  production build publishes a single stylesheet and a debug surface does not join it. See
  [ADR-0011](../../../../../docs/adr/0011-visualizer-graph-editor-canvas.md).
