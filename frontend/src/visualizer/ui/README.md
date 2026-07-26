# Visualizer UI

The React surface in the public player and the development graph-editor components mounted only by
the checked-in Visualizer Lab.

- **Availability gate** — resolves whether the visualizer is offered at all, from the playback path
  in use, the WebGL2 capability probe, and reduced-motion preference.
- **Launcher** — one **Open visualizer** text button in the player, with no second artwork thumbnail
  or persisted enable state.
- **Modal** — expanded presentation. Opening it starts the kernel and closing it stops the kernel.
- **Fallback tiers** — the same slot renders a reduced plugin graph, a simple waveform, static
  release artwork, or an empty background, depending on what the runtime can support.
- **Editor dock** — imported only by `frontend/devlab/main.ts` and docked below the Lab canvas. Three
  tabs show the scene graph, audio feature meters, and playback, performance and GPU readouts.
  Capturing the running scene freezes it into a document and holds it still while it is examined;
  selecting a node routes its output to the canvas, and muting one excludes it. While a document is
  in control the graph is editable: nodes and links, parameters and bindings, seeds, layer overrides
  and the kernel tail's own values, with undo. A captured document is autosaved, exportable as JSON,
  importable from a file, and copyable as a test file that reproduces the scene.

Public styling extends the player's existing `bottom-player__*` BEM classes in
`frontend/src/App.css`; editor styling is injected only when the Lab mounts it.
