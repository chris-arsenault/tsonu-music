# Visualizer

A real-time WebGL2 music visualizer on the public player. A microkernel owns playback
synchronization, audio feature extraction, GPU resources, render-graph construction, layer
composition, plugin scheduling, and performance budgeting. Every visual behavior is a plugin.

Requirements are specified in [visualizer-spec.md](./visualizer-spec.md); section numbers throughout
the code refer to it. Decisions are recorded in [adr/](./adr).

## Surface

A persisted toggle sits beside the player's seek bar with an artwork thumbnail. The visualizer is
off for a first-time visitor. The thumbnail shows release artwork and runs nothing; the kernel starts
when the expanded modal opens and stops when it closes.

Development diagnostics are reached with `?viz-debug=1`.

## Layout

`frontend/src/visualizer/` splits along the boundary
[ADR-0003](./adr/0003-visualizer-pure-core-thin-shell.md) draws.

| Directory | Contents |
| --------- | -------- |
| `core/` | Pure decision logic over plain data, unit-tested in the Node environment |
| `host/` | Web Audio, WebGL2 device, frame loop; gathers state and applies core decisions |
| `plugins/` | The plugin catalog, one directory per category |
| `ui/` | React surface in the player, plus the diagnostics overlay |

The whole subsystem loads as a dynamic chunk on first activation and is absent from the initial
player bundle.

## Audio

Analysis runs in an AudioWorklet on the audio render thread. It computes level, six frequency bands,
spectral centroid, spectral flux, onsets, and beat tracking, and posts decimated snapshots to the
main thread. Detected events are held until they are audible, using `outputLatency` plus
`baseLatency`.

The tap is created lazily on first activation, once per element, and never on the native-HLS playback
path. Audio flows `source → gain(1.0) → destination` unconditionally with the worklet on a parallel
branch declaring zero outputs. See
[ADR-0001](./adr/0001-visualizer-audio-tap-policy.md).

Plugins consume normalized features through the feature bus and declare parameter bindings; feature
extraction is never duplicated inside a plugin. Reactivity is distributed per binding, so a scene
spreads across features rather than pulsing together on every beat.

## Time

Visual time comes from the playback clock, a state machine over media events.
`requestAnimationFrame` schedules frames and contributes nothing to visual time.

Simulators, feedback, mutation timers, and beat phase advance only while audio is playing. Every
other state passes zero delta, which holds them in place while retaining the current frame. Pause,
stall, and seek freeze; seek and track change additionally clear queued events, drop short-term
analysis history, and invalidate tempo. A track change increments a generation counter and reseeds
the scene.

## Rendering

WebGL2 with `EXT_color_buffer_float` is required; below it the fallback hierarchy takes over. See
[ADR-0002](./adr/0002-visualizer-webgl2-floor.md).

Plugins return declarative pass descriptors — shader, inputs, uniforms, output, blend mode, scale —
and the runtime executes them. No plugin touches the GL context. Pass structure is therefore
unit-testable, and the performance controller rewrites resolution and pass count without plugin
cooperation.

The render graph validates connections by port type, rejects over-subscribed ports and unsatisfied
required inputs, and requires that a cycle declare its closing edge as feedback. A declared feedback
edge reads the previous frame through alternating ping-pong slots. Compilation is deterministic for a
given scene.

Asset textures bind as graph resources separately from edges, since an asset has no execution order.
A derived texture always wins over the raw asset it came from.

## Scenes

The scheduler assembles scenes from scene grammar and plugin character rather than compatibility
alone. A theme states the character it wants; category counts, dominant-generator caps, and feedback
and symmetry limits are enforced during assembly. Candidate selection checks that a plugin's required
inputs are producible by what is already chosen.

Wiring connects each required input to the freshest compatible output, chaining transformers, and
closes a feedback-capable transformer onto its own previous frame.

Scenes evolve by mutation at parameter, plugin, branch, and scene granularity. Scene mutation is the
rarest, since it discards accumulated feedback and simulator state. Stateful plugins declare a
deactivation policy so they leave gracefully rather than vanishing.

All randomness is seeded from the track and generation, so a scene is reproducible.

## Assets

Album art and masks are synthesis material. Art can drive palette, edges, displacement, particles, or
nothing at all; a mask can drive containment, collision, stencilling, or distortion with no particle
system present. A plugin requiring an asset stays inactive until it loads.

Masks live in `frontend/public/masks/` with a manifest, generated by the `mask` asset type in
`illuminator` from the pack at `assets/visualizer-masks/`. See
[ADR-0005](./adr/0005-visualizer-mask-assets.md) and
[`frontend/public/masks/README.md`](../frontend/public/masks/README.md).

## Performance and failure

The performance controller takes frame time and HLS forward-buffer length. A stall or starved buffer
suspends rendering immediately rather than waiting out a frame counter; recovery is slower than
degradation. At reduced levels the scene grammar itself gets cheaper. See
[ADR-0004](./adr/0004-visualizer-playback-supremacy.md).

Every failure mode resolves to a fallback tier: full graph, reduced graph, simple waveform, static
artwork, or empty background. The waveform tier draws on a 2D context, so losing the GL context still
leaves something moving. Playback continues regardless of what the visualizer is doing.

`prefers-reduced-motion` selects a low-energy profile rather than uniformly slower animation.
Rendering stops when the page is hidden.

## Verification

`make ci` runs the visualizer's unit tests in the Node environment. `acceptance.test.ts` asserts the
specification's section 26 criteria, one test per criterion.

Three criteria are outside its reach, needing a real GPU or a listener: a 3D source outputting colour
and depth, perceived beat synchronisation, and shaders producing the intended image. They are tracked
in [backlog.md](./backlog.md).
