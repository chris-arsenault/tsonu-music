# Visualizer

A real-time WebGL2 music visualizer on the public player. A microkernel owns playback
synchronization, audio feature extraction, GPU resources, render-graph construction, layer
composition, plugin scheduling, and performance budgeting. Every visual behavior is a plugin.

Requirements are specified in [visualizer-spec.md](./visualizer-spec.md); section numbers throughout
the code refer to it. Decisions are recorded in [adr/](./adr).

## Surface

An **Open visualizer** button sits beside the player's seek bar. The player's existing left-hand
artwork remains the only album thumbnail. Opening the modal starts the kernel; closing it stops the
kernel. Chromium and Firefox show the button because they can switch to the required hls.js playback
path. Safari remains on native HLS and does not offer the visualizer.

Diagnostics are a **Diagnostics** button in the modal's top-right corner, opening a panel over the
right-hand side. `?viz-debug=1` opens it immediately on load. It reports on the kernel the modal is
running rather than starting one of its own.

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

Chromium and Firefox start on native HLS when it is available and switch to `hls.js` only when the
listener opens the visualizer, preserving position and play state. Safari remains native and has
no audio-reactive visualizer. See
[ADR-0006](./adr/0006-hls-js-visualizer-playback-policy.md).

Each band and the overall level carry two channels. **Level** is the measure against the loudest
thing heard lately, which preserves the balance between bands. **Excitation** is how far the measure
sits above its own recent mean relative to its own recent deviation, measured per band from raw
energy so no band's dynamics are divided away by another's ceiling. Level answers what is there;
excitation answers what is happening. A steady measure reports no excitation however loud it is, and
excitation is dropped alongside the other short-term history on seek and track change.

Plugins consume normalized features through the feature bus and declare parameter bindings; feature
extraction is never duplicated inside a plugin.

A binding reaches its parameter in one of three modes. `value` drives the parameter directly.
`rate` treats the output range as units per second and the kernel integrates, which is how audio
changes the speed of a motion rather than the size of a displacement — `spin` is the convention for
an integrated phase velocity, folded into a shader plugin's `uPhase`. `impulse` fires a decaying
envelope from a detected onset or beat. A frozen clock passes zero delta and all three hold.

A binding also declares the role it plays, drawn from the specification's section 20 mapping table:
`intensity`, `large-scale-force`, `deformation`, `detail`, `burst`, `repeating-motion`, `complexity`,
`lateral-force`. A binding written against a feature in the table infers its role from that feature.
Reactivity is distributed within the role, so a scene spreads across features rather than pulsing
together on every beat, without a parameter ever being moved onto a signal that means something
else. A feature outside the table is left as authored.

## Time

Visual time comes from the playback clock, a state machine over media events.
`requestAnimationFrame` schedules frames and contributes nothing to visual time.

Simulators, feedback, mutation timers, and beat phase advance only while audio is playing. Every
other state passes zero delta, which holds them in place while retaining the current frame. Pause,
stall, and seek freeze; seek and track change additionally clear queued events, drop short-term
analysis history, and invalidate tempo. A track change increments a generation counter and selects a
new scene from fresh entropy.

## Rendering

WebGL2 with `EXT_color_buffer_float` is required; below it the fallback hierarchy takes over. See
[ADR-0002](./adr/0002-visualizer-webgl2-floor.md).

Plugins return declarative pass descriptors — shader, inputs, uniforms, output, blend mode, scale —
and the runtime executes them. No plugin touches the GL context. Pass structure is therefore
unit-testable, and the performance controller rewrites resolution and pass count without plugin
cooperation.

The render graph validates connections by port type, rejects over-subscribed ports and unsatisfied
required inputs, and requires that a cycle declare its closing edge as feedback. A declared feedback
edge reads the previous frame through alternating ping-pong slots. Compilation keeps a stable
execution order for the active graph; scene selection itself is fresh and non-repeatable.

Asset textures bind as graph resources separately from edges, since an asset has no execution order.
A derived texture always wins over the raw asset it came from.

## Composition and persistence

The compositor owns a stage the graph does not reach. Layers composite into an offscreen target
rather than onto the canvas, blending by a mode chosen from each plugin's declared character:
bright sparse material adds, bright material screens, dense material composites over so it can
occlude.

Every spatial field the scene produced — procedural, audio-driven, or mask-derived — is then summed
into one motion field, additively and weighted by the contributor count, so several fields compound
into one drag rather than one winning.

The kernel owns an accumulation buffer. Each frame it is gathered through that motion field, decayed,
and combined with the new composite as a leaky integrator: survival and injection are complements, so
a static image converges to exactly itself and a trail comes from the warp rather than from a
build-up. A small absolute amount is subtracted per second as well, so an abandoned trail reaches
true black instead of leaving a haze. How strongly a scene accumulates comes from its theme's
persistence character and its layers' feedback participation, floored so no scene is completely
static and capped where trails would stop being motion and start being lag. Survival is expressed per
second, so trail length is a duration rather than a frame count, and it is also the image's response
time. A frozen clock holds the accumulation exactly; a seek or track change clears it.

The accumulation is graded onto the canvas last, and that is the only stage that compresses.
Luminance is rolled off and the colour rescaled by the same factor, rather than each channel being
compressed on its own — per-channel compression pulls the brightest channel down hardest, which
desaturates exactly the material that was most saturated. `ToneMapper` still runs inside the graph,
but it cannot be the final word, because everything after it can still add light.

`FeedbackFlowTransform`, `FeedbackInjector`, and `ParticleTrailInjector` shape this loop rather than
being the only thing that creates one. See
[ADR-0007](./adr/0007-visualizer-kernel-persistence.md) and
[ADR-0008](./adr/0008-visualizer-motion-field-bus.md).

## Scenes

The scheduler assembles scenes from scene grammar and plugin character rather than compatibility
alone. A theme states the character it wants; category counts, dominant-generator caps, and feedback
and symmetry limits are enforced during assembly. The three families the specification describes with
an explicit feedback stage declare a feedback minimum as well as a maximum, and the scheduler repairs
a shortfall directly rather than leaving it to a retry.

The grammar also constrains how a scene is joined, not only what it contains. A family that names a
spatial field requires one to actually be produced — the field category alone does not guarantee it,
since a particle emitter sits there while producing a spawn buffer. And a scene must reach a minimum
number of distinct material branches, counted after wiring, so a compositor reading one branch twice
is rejected rather than counted as composing. A family built for clean geometry declares no field
requirement; its scenes accumulate and decay without being dragged. Full scenes require multiple material producers and
one or two explicit compositors. Candidate selection checks that a plugin's required inputs are
producible by what is already chosen, and candidates with orphan fields or simulations are discarded.

Wiring connects each required input to the freshest compatible output, but reserves distinct colour
producers for a mixer's two inputs. A flow-field compositor traces through force textures, warps
visible material, and derives chromatic ribbons from the same samples. Collision fields additionally
carry boundary proximity so particles reflect from mask-derived geometry.

Every `value`-bound parameter also receives independent, playback-clocked slow modulation across a
visible fraction of its authored range, clamped to that range. Several layers therefore breathe,
fold, and drift concurrently while their immediate response remains distributed across different
audio features. Rate and impulse bindings are exempt: an integrator is already in continuous motion,
and an envelope's value is its shape. Structural mutation operates at parameter, plugin,
branch, and scene granularity. Branch mutation rebuilds within the current family while retaining
compatible feedback and simulator state; scene mutation is rare. Stateful plugins declare a
deactivation policy so they leave gracefully rather than vanishing.

Each new scene varies visual-family priority before fallback, so the first viable family cannot
monopolize every track. At presentation, monochrome geometry and simulation textures receive a
time-varying audio-sensitive palette; already-saturated source material such as album art keeps its
own colour.

Every modal opening, track change, explicit **New scene**, and full scene mutation selects from fresh
entropy. Tracks do not map to repeatable scenes, and diagnostics do not expose a reproduction control.

## Assets

Album art and masks are synthesis material. Art can drive palette, edges, displacement, particles, or
nothing at all; a mask can drive containment, collision, stencilling, or distortion with no particle
system present. A plugin requiring an asset stays inactive until it loads.

Scene assembly treats a loaded asset as a producer, so a plugin whose required input only an asset
can satisfy — every mask field, since no plugin outputs a mask texture — is selectable rather than
judged unsatisfiable.

A mask becomes a signed distance field once and everything else reads it. Its boundary gradient is a
collision field, which is both the surface a simulator reflects particles from and one of the vectors
the composite drags the accumulated image along, so the same mask shapes physics and motion at once.
Two masks combine through the router's union, intersection, and subtraction. Every mask field's
routing parameters are audio-bound, so a silhouette breathes rather than holding one fixed cut.

Masks live in `frontend/public/masks/` with a manifest, generated by the `mask` asset type in
`illuminator` from the pack at `assets/visualizer-masks/`. See
[ADR-0005](./adr/0005-visualizer-mask-assets.md) and
[the mask-library authoring guide](./visualizer-masks.md).

## Performance and failure

The performance controller takes frame time and HLS forward-buffer length. A stall or starved buffer
suspends rendering immediately rather than waiting out a frame counter; recovery is slower than
degradation. At reduced levels the scene grammar itself gets cheaper, particle counts fall, field
resolution drops, and a plugin holding frame history keeps less of it. See
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
