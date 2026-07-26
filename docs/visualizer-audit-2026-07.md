# Visualizer audit — July 2026

Three independent reviews of `frontend/src/visualizer/`, run after the motion and
colour work of `VISUALIZER-MOTION-PLAN.md` failed to produce a satisfactory
image. Reported symptoms: near-monochrome output, frames that are either almost
entirely black with a thin line in them or a single saturated colour, and
particles that never appear to move even when a particle simulator is in the
active scene graph.

Two of the three reviews were given no symptoms and no prior diagnosis — only
the subsystem path and an instruction to find defects. The third was pointed at
the particle claim and told to establish the facts empirically. Findings that
two reviews reached independently are marked **[corroborated]**.

This document is the durable record. Each item carries the evidence that
established it, because several of these look correct on inspection and are only
provably wrong once measured.

---

## The headline result: the particles were never the problem

The particle simulation is correct. Measured Δposition per frame matches
`velocity × delta` to within 2%:

| force plugin | mean speed (clip/s) | dt (s) | predicted step | measured step |
| --- | --- | --- | --- | --- |
| `ProceduralVectorField:domain-warp` | 1.3612 | 0.02909 | 0.03960 | 0.03889 |
| `ProceduralVectorField:lattice` | 0.6006 | 0.03514 | 0.02111 | 0.02104 |
| `MaskBoundaryField` | 1.4264 | 0.03150 | 0.04493 | 0.04489 |

Clip span 2.0 is the full canvas width, so 0.15–1.4 clip/s is 480–1100 px/s on a
1600 px target — one scene measured 5–8.5% of screen width *per frame*. Forces
are applied (mean |F| 1.98, cos(F,v) 0.639), `uDrag` and `uStrength` are live,
ping-pong alternates correctly on `frameParity`, and 0.000 texels remain at the
origin after frame 1.

Every particle is fast. The ensemble is stationary. The defects are in what is
done with the simulation, not in the simulation — which is why every previous
attempt to fix "the particles" found nothing wrong with them.

---

## Severity 1 — causes a reported symptom directly

### 1.1 Beat events are dead; beat phase never completes a cycle **[corroborated]**

`core/features.ts:449`. `advanceBeat` computes
`beatIndex = floor((audible − anchorAudioTime) / period)` and gates emission on
`beatIndex > lastEmittedBeatIndex`, a monotone high-water mark. But
`anchorAudioTime` is re-read from every snapshot (`features.ts:363`), and the
worklet's tracker sets `anchorTime = time` on **every onset**
(`analysis.ts:352/374/381`, posted at `analysis-worklet.ts:143`). Each onset
rebases the index to ~0 while the high-water mark stays high, and line 450
ratchets the mark further even on the suppressed path.

Reproduced: 20 s of 120 bpm audio with onsets every 0.25 s emits **1 beat event**
where ~40 are expected, and `beatPhase` peaks at 0.47 instead of sweeping 0→1.

Half of every scene's impulse bindings are assigned `'beat'`
(`audio-mapping.ts:40`) and go silent. Every `repeating-motion` binding reads
`beatPhase` (`audio-mapping.ts:34`) and gets a stunted sawtooth.

The existing test passes only because it pins `beatAnchorAudioTime: 100` across
all frames (`features.test.ts:272`) — a fixture that cannot occur at runtime.

### 1.2 Four of six band channels never leave the bottom 1% of their range

`core/features.ts:304-333` divides all six bands by one shared ceiling taken from
the loudest band. `bandEnergy` (`core/analysis.ts:62`) returns a **mean per bin**,
and the bands span from 3 bins (subBass) to 258 (treble), so for any spectrum
with rolloff the treble mean is structurally ~10⁻² of the bass mean.

Measured over 20 s of pink-spectrum-plus-percussion:

```
subBass  p50 0.355   p95 0.959        mid      p50 0.0081  p95 0.0122
bass     p50 0.204   p95 0.402        highMid  p50 0.0016  p95 0.0082
lowMid   p50 0.038   p95 0.062        treble   p50 0.0002  p95 0.0080
```

`core/bindings.ts:83` defaults `inputRange` to `[0, 1]`, and **no binding in
non-test source sets `inputRange` at all**. Every consumer of these channels is
therefore pinned at its output floor:

- `plugins/compositors/composition.ts:584` — `highMid` → `ColorTransform.amount`
  over `[0.1, 0.8]`. Actual value 0.100001. **The colour transform is a permanent
  no-op.** This is the monochrome symptom.
- `plugins/sources/signal-trace.ts:199` — `treble` → `brightness` over
  `[0.9, 2.2]`. Actual value 0.9003. A constant.
- `plugins/transformers/transforms.ts:400`, `:619` — `mid` → warp amounts.
- `plugins/simulators/continuous.ts:188` — `mid` → Gray-Scott `kill`, which the
  comment at `:206` says is deliberately tight; this one is defensible.

### 1.3 `SpectrumGeometrySource` gain is ~100× too small

`plugins/sources/spectrum.ts:92`: `magnitude = min(1, spectrum[logIndex] * gain)`
with `gain` bound over `[3.5, 9.5]` (`:182`). But `spectrum` is raw FFT magnitude
at `scale = 2/N` (`core/fft.ts:132`), averaged a further 8:1 by the worklet.
Measured posted bin magnitudes: p50 7.7e-5, p95 5.4e-3, max 0.21.

Running the real `spectrumVertices` on real spectrum data:

- `contour` — vertex `y` over a usable clip range of −1…0.8: **p50 −0.9933**,
  p95 −0.075. Half the vertices sit within 0.4% of the bottom edge.
- `radial` — radius over a nominal 0.30…0.95: **p50 0.3024**. The spectrum
  renders as a near-perfect circle.

Intensity fails the same way: `vertices[write+2] = max(0.05, magnitude)`
(`:157`) yields the 0.05 floor for most vertices, and `SPECTRUM_FRAGMENT:35`
multiplies it by `uBrightness ≈ 0.9` (item 1.2), giving ~0.045. The gain needs to
be in the hundreds. This is the thin-line-on-black symptom.

### 1.4 Particles are never re-seeded, so emitters do nothing **[corroborated]**

`plugins/simulators/particles.ts:38`. `uLifetime` is declared and supplied twice
(`:319` statically, `:264` live) and referenced **nowhere** in
`SIMULATOR_FRAGMENT`. All four RGBA16F channels are consumed by
`position.xy`/`velocity.zw`, so the header comment at `:22-25` about age riding
in an alpha channel describes storage that does not exist.

`uSpawn` is sampled only inside
`if (position == vec2(0.0) && velocity == vec2(0.0))`, true only on the first one
or two frames. After that `ParticleEmitter` — including its `rate` binding to
`spectralFlux` — has no effect at all, and its shape, ring, and line patterns are
never visible. Particles are immortal and advected forever from their initial
seed.

`shader-contract.test.ts:46` hides this behind a false exemption claiming
`uLifetime` "bounds particle age in the simulation step".

### 1.5 The particle field is spatially unstructured noise

16384 particles seeded from `hash(vUv + uSeed)` — uniform random over the entire
clip square — drawn at a fixed `gl_PointSize` of 2.5 device pixels with no
trails. Isolated captures of `ParticleRenderer:*.color` are indistinguishable
from TV static, and two frames 400 ms apart are statistically identical.

A uniform random dot field that reshuffles has no trackable structure. Dots
jumping 8–30 px/frame with no trail read as twinkle, not travel. This is the
mechanism behind "particles don't move" despite 1.1 above.

### 1.6 The quality ladder is one-way, and drops particles on the way down

`core/performance.ts`. `frameTimeMs` is the rAF interval, and
`DEFAULT_THRESHOLDS.recoveryBudgetMs = 12` requires a frame under 12 ms — which
is unreachable at 60 Hz's 16.7 ms floor. Downgrades therefore never recover.
Observed progression 0 → 1 → 3 → 6 → 9 with no recovery.

At level ≥ 6 `isSuppressedByQuality` drops `ParticleRenderer` outright (gpu 2,
dominance `supporting`). Particles *vanish* rather than degrade. At 9 everything
suspends. This is "particles don't exist at all, even when they're in the scene
graph".

### 1.7 The free-running LFO covers the entire parameter range

`core/modulation.ts:103-108`: `modulated = current + motion * depth`, where
`motion` reaches ±1.0 and `depth = span * lerp(dynamics.depth)`. For
`large-scale-force` the depth fraction is 0.45–0.8 (`:26`) at 0.012–0.045 Hz.

Measured on the real function with the audio-resolved value held constant at 0.5
on a `[0,1]` binding: output spans **0.000 → 1.000**, pinned at a rail 18% of the
time, on a 22–83 s cycle. Moving the audio value by 0.6 shifts the output by only
0.464 — the clamp eats 23%.

Audio contributes a DC offset to an oscillator that already sweeps everything.
This is the "movement disconnected from the music" failure that
`core/persistence.ts:8` describes and was supposed to have fixed.

### 1.8 One visible source can satisfy the two-branch minimum

`core/scene-builder.ts:235`. `materialBranchCount` reads only `scene.nodes` and
never `scene.edges`, despite a docstring claiming the count happens after wiring
"so a mixer wired to the same texture on both inputs counts once". Every
compositor outputs `color-texture` and is not `postprocess` (verified across
`composition.ts:355/417/450/497`), so the compositor counts itself as a material
branch. A scene with one source and one compositor reports 2 and passes
`minimumMaterialBranches: 2` while composing a single branch.

### 1.9 An unbound optional sampler silently reads texture unit 0

`plugins/simulators/continuous.ts:179` declares `seed` as `required: false`;
`plugins/define.ts:181-186` omits the sampler entry entirely when the resource is
absent; `host/runtime.ts:209-217` only calls `bindTexture` for entries that are
present. So `uSeedTexture` keeps the GL default of unit 0 — the unit `uHistory`
was just bound to, being the first entry of `spec.inputs`.

`continuous.ts:54` then samples it unconditionally:
`seed = texture(uSeedTexture, vUv).r` reads chemical A, primed to 1.0 at `:50`.
The `seed > 0.7` test is true across the whole field, and `:55` floors chemical B
at `uImpulse` — envelope floor 0.2 (`:200`) — everywhere, every frame. Gray-Scott
cannot form spots or stripes when B is continuously replenished globally.

This fires whenever nothing supplies a `mask-texture`: always before
`loadMaskAssets()` resolves (`host/kernel-loop.ts:213`), and permanently if the
manifest fetch fails.

The same unbound-sampler shape exists at `composition.ts:98`, `particles.ts:205`,
and `transforms.ts:532`, though `core/wiring.ts:138-156` auto-closes those in
practice. `plugins/transformers/feedback-flow.ts:227` is the only site that
guards explicitly.

### 1.10 Reactivity distribution swaps level channels for excitation channels without rescaling

`core/audio-mapping.ts:114` replaces `binding.feature` while leaving
`inputRange`, `outputRange`, and `curve` untouched. The role pools mix the two
kinds freely — `large-scale-force: ['bass','subBass','bassExcite','subBassExcite']`.

They have incompatible distributions. `bass` is a continuous level, p50 0.204 /
p95 0.402. `bassExcite` is p50 **0.000** / p95 **1.000** — a gate, not a level,
because `EXCITATION_HEADROOM = 2` (`core/analysis.ts:176`) is exceeded on any
percussive material. A parameter authored to ride smoothly at ~20% of its range
becomes a binary toggle between its extremes, decided by a per-scene RNG draw.

### 1.11 The particle layer enters the accumulation at 2–4% per frame

Observed `survivalPerSecond` 0.108–0.246 → per-frame survival 0.964–0.977 at
60 fps → injection 2.3–3.6% per frame. Inspected in isolation the particle layer
has meanLum 174/255 and 90% non-black coverage with peak values 41–95; between
transients it is attenuated 30–40× before it is seen.

### 1.12 The wrap seam is a trap for divergent fields

`plugins/simulators/particles.ts:82`: `position = mod(position + 1.0, 2.0) - 1.0`.
For a divergent field (repel, attract, spiral, gravity, wind) crossing the seam
reverses the force relative to velocity, so particles oscillate about the
boundary. Measured seam fraction (|x| or |y| > 0.97) 0.13–0.18 in repel scenes
against 0.0003 in a bass-compression scene; ensemble mean speed decayed
0.242 → 0.042 clip/s over ~250 frames, leaving a hollow rectangle of noise around
the border with a black centre, identical frame to frame. The comment claiming
wrapping avoids edge pile-up is wrong in practice.

---

## Severity 2 — wrong behaviour, no reported symptom yet

### 2.1 Plugin static `uDelta` overrides the kernel's real delta **[corroborated]**

`host/runtime.ts:221-228` sets `uDelta` **before** spreading
`mergeUniforms(pass.uniforms, parameters)`, so a pass-level `uDelta` wins.
`plugins/simulators/continuous.ts:184` and `:274` both declare
`uniforms: { …, uDelta: 1 / 60 }` and neither declares a `delta` parameter to
displace it. Both shaders use it as their integration step (`:64`, `:138`), where
`step_scale = clamp(uDelta * 60.0, 0.0, 1.5)` is therefore always 1.0.

`ReactionDiffusionSimulator` and `WaveFieldSimulator` are frame-rate dependent —
2.4× fast on a 144 Hz display — and, contradicting spec §6.2 and the file's own
header at `continuous.ts:4-6`, **keep evolving while the track is paused**,
because the kernel's frozen `uDelta = 0` never reaches the shader.
`particles.ts:317` does it correctly, which makes the divergence self-evident.

### 2.2 Frame delta is never clamped **[corroborated]**

`host/kernel-loop.ts:276, 289`: `deltaSeconds = frozen ? 0 : wallDelta`, no
ceiling, and `lastFrameTime` is not reset on visibility change. Audio in a
background tab keeps `clock.state === 'playing'`, so returning after two minutes
delivers `deltaSeconds ≈ 120` to every `instance.update()` and to
`blackFloorFor(120) = 10.8`, wiping the accumulation and launching every Euler
integrator off-screen in one step.

Observed live: `uDelta` up to 1.4 s. With drag bound as high as 0.9,
`1 - uDrag*uDelta` goes negative above dt ≈ 1.11 s — velocity inverts and the
ensemble collapses. One hitch (tab return, GC, shader compile) resets everything.

### 2.3 `clearAccumulation` preserves the accumulation instead of clearing it

`host/runtime.ts:407` only sets `accumulationPrimed = false`, which *forces the
accumulation pass to run*; nothing ever clears `ACCUMULATE_KEYS`. On a seek the
clock is frozen, so `frameSurvival(s, 0)` returns exactly 1 and `blackFloorFor(0)`
returns 0 — the pass copies the full pre-seek image forward with 1% of the new
composite mixed in. Precisely the outcome `renderer.ts:523` claims to prevent.

### 2.4 WebGL context loss is unrecoverable and invisible

`host/device.ts:152` sets `lost` on `webglcontextlost` and never clears it, and
there is no `webglcontextrestored` handler in the repo. `registerShader`
early-returns on `lost` (`:215`), so the recovery block at
`renderer.ts:450-459` re-registers nothing and `isLost()` stays true forever.
`VisualizerPanel.tsx:76` hardcodes `contextLost: false`, so no fallback tier is
selected either. A driver reset leaves a permanently black rectangle.

### 2.5 `ImageLuminanceField` emits a gradient where consumers read a mask

`plugins/sources/album-art.ts:396` declares
`outputs: [{ name: 'luminance', type: 'mask-texture' }]` but reuses
`DISPLACEMENT_FRAGMENT`, which writes `vec4(displacement, scalar, 1.0)` — `.r` is
∂L/∂x and the luminance is in `.b`. Only the shader *id* differs from
`AlbumArtDisplacement`. Every `mask-texture` consumer reads `.r`
(`mask-fields.ts:37`, `composition.ts:66/82`, `particles.ts:157`,
`continuous.ts:54`), so wiring this into `MaskSignedDistanceField` gives
`step(0.5, ~0)` → mask identically 0, no boundary, constant SDF.

### 2.6 A simulator can be scheduled with no renderer

1 of 8 surveyed particle scenes had `ParticleSimulator` and no
`ParticleRenderer`. `state` is a `particle-buffer`, never a `color-texture`, so
`buildLayers` gives it no layer and the simulation contributes zero pixels.
`prefersWith` is a preference, not a requirement.

Related, seen twice: `MaskBoundaryField.deflection` wired as the simulator's
`force`. A collision field is zero away from the mask edge, so most particles get
zero force, decay to rest under drag, and freeze below half-ulp — **44% of
particles with exactly zero Δposition per frame** in that scene.

### 2.7 `activatedAt` is deleted immediately after being set

`host/renderer.ts:416-424`. The set loop guards on `!activatedAt.has(id)`, then
the delete loop removes every departing id. On the `preserveInstances = false`
path `departingInstances` is *all* previous instances, and ids are
`${definition.id}#${index}` — so any plugin landing at the same index (e.g.
`ToneMapper`, `activationWeight: 10`) is never set and then deleted, falling back
to `activationTime: 0`. `scheduler.ts:513` then treats a one-second-old plugin as
mature, voiding `minimumPluginAgeSeconds`.

### 2.8 Suspended frames leak retiring instances

`host/renderer.ts:446` returns before the retirement drain loop when
`profile.suspended`, but `kernel-loop.ts:349` still runs `renderer.mutate(...)`,
pushing entries onto `retiring` that are never advanced or destroyed. Fed by
`kernel-loop.ts:330`, where
`profileFor(previousLevel).reducedGrammar !== profile.reducedGrammar` compares a
ladder rung against `suspendedProfile()` (rung 9, `reducedGrammar: true`), so
every frame that runs while `document.hidden` triggers a full `rebuildCurrent`.

### 2.9 The theme's colour policy is overwritten within a second

`core/scene-builder.ts:42-60` turns `colorPolicy.strength` into
`parameterOverrides` for `PaletteMapper.strength` and `ColorTransform:*.amount`;
`host/renderer.ts:771` seeds `active.parameters` from them. But both parameters
are *bound* (`composition.ts:549`, `:584`), so `resolveParameters` treats the
override as an initial condition and smooths it away over the binding's 0.2–0.8 s
attack/release. The declared colour strength has no steady-state effect.

### 2.10 The palette accent usually does not land on the last branch

`core/palette.ts:136`. `assignment[index % assignment.length]` with `count = 4`
(fixed at `renderer.ts:250`) only puts the accent last when the ink count divides
4. For `crimson-dynasty` (3 inks) the accent lands on branch 2 and branch 3
repeats a supporting colour; with fewer than 4 inks in a 5-swatch palette the
accent can be dropped entirely — defeating the "accents sparingly" rule stated at
`:83` and in `docs/visualizer.md`.

### 2.11 Adjacent spectral bands share bins, and `subBass` includes DC

`core/analysis.ts:69-70` uses `floor` for the low edge and `ceil` for the high.
At 48 kHz with a 1024-point FFT (46.9 Hz per bin), `subBass` = bins {0,1,2} and
`bass` = bins {1…6} — two of three subBass bins are also bass bins, and bin 0 is
DC, so any signal offset reads as sub-bass. `lowMid` = {5…11} overlaps `bass` by
two. `bass` and `subBass` are offered as distinct alternatives inside the same
role pool while being near-duplicates.

### 2.12 The crossfade subsystem is fully implemented and never invoked

`core/layers.ts:28-34` defines `Crossfade`; `:131`, `:149`, `:160` implement
weight, advance, and completion; `host/runtime.ts:513` reads `frame.crossfades`.
But `host/renderer.ts:506-534` — the only caller of `runtime.renderFrame` — never
sets the field. Spec §10 crossfades never happen; transitions run entirely
through the retirement path.

### 2.13 `uCentre` is overwritten by the impact centre

`plugins/transformers/transforms.ts:253` reads
`centre = hasImpact ? uImpactCentre : uCentre` and `:484` supplies the static
`uCentre: [0.5, 0.5]`. But `plugins/define.ts:202-207` spreads the impact block
*after* `spec.uniforms` and writes `uCentre: impact.centre` — the same value as
`uImpactCentre` — and `define.ts:158` retains the last centre when energy decays
to zero. The ternary is a no-op and the static value never reaches GL.

### 2.14 Mask SDF search never samples its outermost ring

`plugins/fields/mask-fields.ts:52`. `nearest` starts at `uSearchRadius`, and at
`step_index == 12` the sample distance is exactly `uSearchRadius`, so
`distance >= nearest` breaks before sampling. Maximum measurable distance is
`11/12 · uSearchRadius`.

### 2.15 Dead, duplicated, and discarded

- `plugins/transformers/transforms.ts:31-32` — `SymmetryTransform:bilateral` is
  byte-identical to `:horizontal` (both `p.x = abs(p.x)`), yet both are
  registered as separate plugins at `:288-290`, so the scheduler weights two
  indistinguishable transforms independently.
- `plugins/sources/spectrum.ts:20-27` — `SPECTRUM_VERTEX` never assigns
  `gl_PointSize`, yet `:244` selects `primitive: 'points'` for `cell-matrix`.
  Undefined in GLSL ES 3.00. The other three point-drawing plugins all write it.
- `plugins/sources/procedural.ts:225` —
  `fragColor = vec4(colour * fill, fill) + vec4(0.0, gradient, 0.0) * 0.0 + vec4(0.0);`
  Four `circle()` evaluations per pixel multiplied by zero, under a comment
  declaring a four-channel contract the plugin does not honour.
- `plugins/simulators/impact-cascade.ts:243-244` — `boundary-slam` uses
  `x: jitter * 0.5, y: jitter * 0.5`, putting all 48 projectiles exactly on
  `y = x`.
- `plugins/sources/spectrum.ts:363` — `TransientGlyphSource` normalises
  `impactAge` against `IMPACT_LIFETIME_SECONDS = 1.5`, so `age < 0.05` is a 75 ms
  window with no per-impact dedupe: each impact spawns 4–5 glyphs, which then
  evict still-live ones through `glyphs.slice(-MAX_GLYPHS)`.
- `host/renderer.ts:687` — `runtime.dispose()` iterates only the runtime's
  `instances`; the renderer-local `retiring` array is untouched, so closing the
  modal mid-drain skips `destroy()`.
- `host/device.ts:132` — `maxPixelRatio` is read once from `capabilities` and
  never invalidated, so moving to a retina display or zooming recomputes the
  backing store at the stale ratio.
- `core/passes.ts:53` — `pass.scale` is declared, forwarded by
  `plugins/define.ts:195`, set by five plugins, and read by nothing;
  `resolvePassScale` (`:119`) has no non-test caller. Harmless only because
  `RESOURCE_SIZING` already assigns 0.5 to those port types.

---

## Severity 3 — latent, cosmetic, or dead code

- `core/persistence.ts:146` — `Math.min(survival, 0.35)` is dead;
  `SURVIVAL_CEILING` is 0.25, a stale constant from when the ceiling was 0.8.
- `core/scheduler.ts:437` — the visible-source repair omits the `wouldViolate`
  check the feedback and motion repairs both perform, so it can push
  `sourceCount` over its maximum and fail the attempt it was meant to save.
- `host/audio-tap.ts:96` — on the worklet path `noteSilence` is reachable only
  from `handleSnapshot`, so a worklet that stops posting can never set
  `flatlined`. The fallback path (`:142`) is fine.
- `host/runtime.ts:264` — `frameParity` increments on every frame including
  frozen ones, so a ping-pong producer that is skipped leaves its consumers
  alternating between two never-updated slots at refresh rate.
- `core/layers.ts:109` — `index === 0 ? 'normal' : layer.blendMode` uses the
  pre-filter index, so a zero-opacity bottom layer lets the real bottom layer
  keep its own blend mode. Masked because `runtime.ts:544` overrides step 0.
- `core/scene-builder.ts:156` — `contributing.size` (a set of *definition* ids)
  is compared against `wired.nodes.length`, so duplicate definitions trigger a
  spurious prune pass.
- `host/runtime.ts:488-494` — `presentSingle` leaves `uShadow`, `uMid`,
  `uHighlight`, `uTint` at whatever the previous `composite()` left. Benign only
  because `uChromatic: 0` gates them out.
- `host/device.ts:458-470` — array uniforms dispatch on JS array length, not
  `slot.type`, so a `float[9]` or `vec4[4]` would upload via
  `uniformMatrix3fv`/`uniformMatrix4fv`. No current caller.
- `host/device.ts:288` — a changed attribute layout for an existing geometry id
  is ignored. `:305-316` binds vertex attributes by array index and never calls
  `bindAttribLocation`, so every geometry plugin depends on the linker assigning
  locations in GLSL declaration order; the `name` field in
  `GeometryUpload.attributes` is read by nothing.
- `plugins/sources/album-art.ts:230` — a `uniforms` object is passed into
  `derivation()` whose `render` is replaced at `:235`. It never reaches GL.
- `uResolution` is supplied to every pass but declared-and-unused in
  `MOTION_SUM_SHADER`, `PERSISTENCE_SHADER`, `PRESENT_SHADER`, and ~15 plugin
  fragments.
- `uImpulse` is a `float` in `ReactionDiffusionSimulator` (`continuous.ts:27`)
  and a `sampler2D` in `WaveFieldSimulator` (`:104`). Legal today because they
  are separate programs; if either plugin gained the other's member it would be
  an instant silent collision of the class that forced the `uSeed`/`uSeedTexture`
  rename.
- `host/renderer.ts:672` — `estimatedTextureBytes()` ignores `RESOURCE_SIZING`,
  overstating half-res fields and fixed-size buffers.

### Channels produced with no consumer

| Channel | Status |
| --- | --- |
| `leftLevel`, `rightLevel` | `features.ts:343-344`. No binding, no role pool, no direct read. Only folded into `stereoBalance`. |
| `beatConfidence` | `features.ts:346`. No non-test consumer; not in any role pool, so unreachable even dynamically. |
| `sectionChange` | `features.ts:423` always emits `[]` — not implemented. No consumers. |
| `transient` | Live and well-behaved (p50 0.347) but in **no** role pool and bound by nothing. Reachable only via three hard-coded reads. `audio-mapping.ts:24` claims "detail and burst want the transient"; those pools contain only `*Excite` channels. |
| `beat` | No authored binding; reachable only if `IMPULSE_FEATURES` claims it over `onset` — and see 1.1. |
| `subBassExcite`, `lowMidExcite`, `midExcite` | No authored binding; pool-reachable only. |

Dead exports on the same path: `core/parameters.ts:72` `IMPULSE_FEATURES` is
never imported and diverges from the private list at `audio-mapping.ts:40` (it
includes `sectionChange`, which cannot fire); `core/features.ts:161`
`excitationFeatureName` has no callers; `core/impact.ts:75`
`totalImpactEnergy` and `:115` `packImpacts` have no non-test callers.

No consumed-but-never-produced feature name exists — every literal and every
dynamically reachable name is a member of `ContinuousFeatures` or is
`onset`/`beat`.

### Unverified

- `plugins/fields/mask-fields.ts:86/103` call `smoothstep` with `edge0 > edge1`,
  undefined in GLSL ES 3.00 but implemented as the intended inversion on all
  mainstream drivers. A portability hazard, untested on real hardware.
- `plugins/simulators/particles.ts:192` adds `field * 0.5` on top of the curl
  mode's own `field * uStrength`, so that mode cannot go below half the raw
  field. Plausibly intentional.

---

## Method

Reviews 1 and 2 were read-and-reason plus unit tests, given no symptoms and no
prior diagnosis. Review 3 ran Playwright against the `devlab` harness with
SwiftShader, patching `WebGL2RenderingContext.prototype` before app load to
capture program→shader-source mappings and uniform-location→name pairs, and
calling `readPixels` on the bound framebuffer immediately after each
`drawArrays`. The simulator's 128×128 RGBA16F state target was decoded from half
float every frame, giving exact per-particle position and velocity across ~12
particle scenes.
