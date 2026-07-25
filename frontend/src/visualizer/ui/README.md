# Visualizer UI

The React surface in the public player, plus the development diagnostics overlay.

- **Availability gate** — resolves whether the visualizer is offered at all, from the playback path
  in use, the WebGL2 capability probe, and reduced-motion preference.
- **Toggle** — a persisted opt-in control in the player. The visualizer is off for a first-time
  visitor, and no audio tap exists until it is enabled.
- **Thumbnail** — sits beside the player timeline. It presents release artwork while idle and does
  not run the kernel.
- **Modal** — expanded presentation. The kernel starts when it opens and stops when it closes.
- **Fallback tiers** — the same slot renders a reduced plugin graph, a simple waveform, static
  release artwork, or an empty background, depending on what the runtime can support.
- **Diagnostics overlay** — reached with `?viz-debug=1`. Exposes playback state and generation,
  audio-context state and latency estimate, raw and normalized features, beat and onset events,
  the active plugin set and graph, activation history, scene seed, assigned assets, render
  resolution, frame time, cost estimates, GPU capabilities, memory estimates, and shader errors.
  Controls freeze scheduler mutation, freeze simulation while audio continues, disable individual
  plugins, replace an active plugin, reproduce a scene from its seed, and display intermediate
  mask, field, depth, and motion textures.

Styling extends the player's existing `bottom-player__*` BEM classes in `frontend/src/App.css`.
