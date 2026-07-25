# Visualizer host

The shell between browser APIs and [`../core`](../core). It gathers host state into plain data,
calls the core, and applies what the core decides. It holds no decisions of its own.

Contents:

- **Audio** — capability gate, the lazily created media-element tap with its parallel dead-end
  analyser branch, the AudioWorklet processor that timestamps onsets on the audio render thread,
  output-latency compensation, and the dead-analysis watchdog.
- **Device** — WebGL2 context and capability probe, program cache, framebuffer pool,
  fullscreen-quad passes, context-loss and restoration.
- **Runtime** — the frame loop, execution of the compiled graph, the layer compositor, feedback
  ping-pong buffers, and the resource manager.

Nothing here is covered by automated tests; it is verified by hand against the diagnostics
overlay. Keeping it thin is what keeps that gap small.
