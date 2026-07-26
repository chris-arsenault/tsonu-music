# Scene graph editor

The visualizer's node editor: a docked surface below the canvas that presents the running scene as a
graph and drives it. Development only — reached through `?viz-debug=1`, lazily imported, and absent
from an ordinary playback session.

This directory holds presentation only. The document model, its edit operations, resolution against
the plugin registry, and graph layout are pure modules in [`../../core/`](../../core), per
[ADR-0003](../../../../../docs/adr/0003-visualizer-pure-core-thin-shell.md).

Two rules shape what may be written here:

- **Node bodies render without a React Flow context.** They are presentational components over plain
  props, so `renderToStaticMarkup` covers them in the Node test environment. Only the canvas that
  hosts them depends on the library.
- **React Flow's stylesheet is injected at mount**, imported through Vite's `?inline` query. The
  production build publishes a single stylesheet and a debug surface does not join it. See
  [ADR-0011](../../../../../docs/adr/0011-visualizer-graph-editor-canvas.md).
