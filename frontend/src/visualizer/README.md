# Visualizer

Real-time WebGL2 music visualizer for the public player. A microkernel owns playback
synchronization, audio feature extraction, GPU resources, render-graph construction, layer
composition, plugin scheduling, and performance budgeting. Every visual behavior is a plugin.

The whole subsystem loads as a dynamic chunk on first activation, so it costs nothing on the
initial player bundle.

## Layout

| Directory | Contents |
| --------- | -------- |
| [`core/`](./core) | Pure decision logic over plain data — clock, features, graph, scheduler, performance |
| [`host/`](./host) | Web Audio, WebGL2 device, and frame loop; gathers host state, applies core decisions |
| [`plugins/`](./plugins) | Plugin catalog, one directory per category |
| [`ui/`](./ui) | React surface in the player, plus the graph editor dock in [`ui/editor/`](./ui/editor) |

## Rules

- Decision logic belongs in `core/` and is unit-tested in the Node environment. `host/` holds no
  decisions. See [ADR-0003](../../../docs/adr/0003-visualizer-pure-core-thin-shell.md).
- The audio tap is created lazily, once, and never on the native-HLS path. See
  [ADR-0001](../../../docs/adr/0001-visualizer-audio-tap-policy.md).
- WebGL2 with `EXT_color_buffer_float` is required. See
  [ADR-0002](../../../docs/adr/0002-visualizer-webgl2-floor.md).
- HLS forward-buffer length throttles rendering. See
  [ADR-0004](../../../docs/adr/0004-visualizer-playback-supremacy.md).
- Visual time comes from the playback clock. `requestAnimationFrame` schedules frames and
  contributes nothing to visual time.
- Styling extends the player's `bottom-player__*` BEM classes in `frontend/src/App.css`. The Vite
  build publishes a single stylesheet, so visualizer styles join that graph rather than adding one.
