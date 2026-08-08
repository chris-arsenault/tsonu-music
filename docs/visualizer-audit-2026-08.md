# Visualizer audit — August 2026

A second measured pass over `frontend/src/visualizer/`, run after the repairs in
`VISUALIZER-REPAIR-PLAN.md` and the particle rewrite on `visualizer-continuation`.
Reported symptom: the image is still largely static and reads as uncorrelated
with the music; individual nodes appear not to work.

The previous audit found a producer that emitted four channels in the bottom one
percent of their range. That is fixed. This one finds the mirror image: the
consumers were authored against a distribution the producer has never had, an
oscillator that competes with the music for the little range left, and one
subsystem whose bindings were removed outright.

Every figure below comes from executing the real `core/` and plugin-definition
code in the Node environment — three hundred scene builds against the real
registry, the real FFT, onset and beat chain over twenty-four seconds of
synthesised material, and the real `resolveParameters` → `modulateParameters`
chain over the resulting feature stream. Findings marked **[source]** are read
from shader text and port declarations rather than from captured pixels; no
browser was run.

---

## R1 — Every binding traverses about a fifth of its authored range

`core/bindings.ts:83` defaults `inputRange` to `[0, 1]`. No binding in the
catalog sets one; `VISUALIZER-REPAIR-PLAN.md` records that as a deliberate
decision, on the grounds that the producer had been fixed. The producer was
fixed. The channels still do not occupy `[0, 1]`:

| channel | p05 | p50 | p95 |
| --- | --- | --- | --- |
| subBass | 0.051 | 0.125 | 0.240 |
| bass | 0.114 | 0.188 | 0.292 |
| lowMid | 0.087 | 0.138 | 0.214 |
| mid | 0.150 | 0.195 | 0.254 |
| highMid | 0.196 | 0.253 | 0.379 |
| treble | 0.349 | 0.419 | 0.884 |

A peak follower answers "where does this sit against the loudest thing lately",
and on mastered music the answer is close to constant. That is the correct
question for preserving balance between bands and the wrong distribution for a
consumer that maps `[0, 1]` onto its whole working range.

Consequences, computed per binding as the fraction of the output range the
measured p05–p95 can reach:

- `ProceduralVectorField.scale ← mid` over `[1.3, 4.5]` reaches **1.6 to 1.9**.
- `DomainWarpTransform.amount ← mid` over `[0.3, 2.0]` reaches **0.48 to 0.60**.
- `SymmetryTransform.spin ← mid` over `[0.05, 0.9]` reaches **0.14 to 0.22**.
- `FeedbackFlowTransform.rotation ← mid` over `[0.04, 0.55]` reaches **0.09 to 0.14**.

Across 313 continuous bindings the median utilisation is **19 percent**, and
**163 of them are below 25 percent**. Every one of those parameters is
distributed by the scheduler, smoothed by the resolver, and uploaded every
frame, while moving a fifth of the distance its author wrote.

## R2 — Two channels are dead, and one of them owns a binding role alone

**`stereoBalance`.** The measure is bipolar, `(R − L) / (R + L)`, and on real
material it sits inside roughly ±0.05. Normalising it through the default
`[0, 1]` clamps the whole negative half to zero. Measured utilisation: **0
percent**. Six bindings feed it, all on `AudioImpulseField`, including
`stereo-push`, whose entire field is `vec2(uStereo * 2.0, 0.0)` — a field of
exactly zero, in every scene that selects it.

`core/audio-mapping.ts:42` gives the `lateral-force` role exactly one feature, so
every binding distributed to that role lands on a dead channel with no
alternative to fall back to.

**`spectralCentroid`.** p05 **0.682**, p95 **1.000**, saturating at the ceiling.
`CENTROID_CEILING_HZ = 8000` is a linear cut over a magnitude-weighted mean
frequency taken across 512 bins to 24 kHz, so the broadband floor alone carries
it most of the way up. It drives palette movement and `FlowFieldCompositor.hue`.
`VISUALIZER-BACKLOG.md` already records this as measured-dead and skipped.

## R3 — The free-running drift moves parameters as much as the music does

Each scene was run three ways: live features with drift on (what ships), live
features with drift off, and features held constant with drift on. Comparing
standard deviations per parameter, over 108 bound parameters in six scenes:

```
median audio share of parameter motion:            58%
parameters where drift moves more than the music:  29 of 108
parameters where the music contributes under 25%:   1
```

`core/modulation.ts` was rewritten to take drift depth from the *remaining
headroom* rather than from the full span, which is correct and is what stops the
oscillator railing on its own. But headroom is large precisely because R1 leaves
the audio-resolved value close to the bottom of its range, so the correction is
undone by the defect upstream of it. The two findings have to be fixed together
or neither reads as an improvement.

## R4 — The particle subsystem has no bindings at all

All twenty particle definitions carry `defaultBindings: []`:

```
ParticleSimulator, ParticleEmitter:{point,region,line,ring,shape},
ParticleForceField:{attract,repel,vortex,gravity,wind,curl},
ParticleCollider:{frame,segment,circle,mask},
ParticleRenderer:{points,discs,sparks,comets}, ParticleTrailInjector
```

`distributeReactivity` maps over `defaultBindings ?? []`, so a scene's particle
nodes receive nothing; `resolveParameters` and `modulateParameters` both return
their input unchanged when handed an empty binding list. Every particle
parameter is therefore frozen at its declaration default for the life of the
scene. `ParticleSimulator` appears in 13 to 21 percent of assembled scenes.

What that renders: emitter at world origin, `direction: 0`, `spread: 20°`,
`speed: 160 px/s`, `rate: 24/s`, `radius: 5`, `lifetime: 6 s`. Equilibrium
population is rate times lifetime, **144 bodies**, against a declared
`particleCount` of 512 and a capacity of 4096. One hundred and forty-four discs
of radius five on a 1600×900 frame is **0.78 percent coverage**. It is a narrow
fixed jet from the centre of the screen toward the right edge, identical on every
track. `VISUALIZER-BACKLOG.md` attributes the fall in scene saturation to the
particle count; the count is not the cause, the emission rate is.

`shader-contract.test.ts` carried a test named *every parameter is bound to a
feature or listed as deliberately static*, written to stop exactly this. The
particle rewrite added `STATIC_FAMILIES` and `CPU_VALUE_FAMILIES` to exempt all
six particle families from it. The guard that existed to stop a plugin shipping
inert was switched off for the plugins that shipped inert.

## R5 — The branch is red, and the mask-to-particle path is gone

`main` passes 1016 of 1016. `visualizer-continuation` fails two:

```
acceptance.test.ts       > section 26 > collision, through a boundary deflection field
wiring-integration.test.ts > mask dimensions > a mask is a physics surface particles reflect from
                             ParticleSimulator#0.emitters (particle-emitter) unsatisfied
```

`ParticleSimulator.emitters` became `required: true` with no default emitter, so
every hand-authored scene that predates the rewrite fails to wire. Spec section
26's collision row has no passing expression.

## R6 — Particle configuration nodes consume the spatial-field budget

`ParticleEmitter`, `ParticleForceField`, and `ParticleCollider` are all
`category: 'field'`, but they produce `particle-emitter`, `particle-force`, and
`particle-collider` — value ports, already named by `isValuePortType` in
`core/plugin.ts:45`. They cost no GPU passes and produce no spatial data, and
they are rationed by `fieldCount` alongside `ProceduralVectorField`.

`ORGANIC_FLOW.fieldCount` is `[1, 2]` and `requireMotionSource` is true. A scene
that spends one field slot on an emitter has one left, which the motion
requirement claims. There is no slot for a force or a collider. Measured across
300 builds with masks and artwork loaded:

```
ParticleForceField:curl    0.0%
ParticleForceField:wind    0.0%
ParticleCollider:mask      0.0%
```

Particles are advected by nothing and collide with nothing in almost every scene
that contains them.

## R7 — `DomainWarpTransform` reads a vector field as if it were an image **[source]**

The `field` input is declared `vector-field`, and every field shader writes
`vec4(fx, fy, length(f), 1.0)` with components bounded to ±4. Four of the six
modes then treat it as a colour:

```glsl
offset = vec2(luminance(driver.rgb) - 0.5) * uAmount * 0.2;   // luminance
angle  = (luminance(driver.rgb) - 0.5) * uAmount * 3.0;       // angular
offset = (vUv - 0.5) * (luminance(driver.rgb) - 0.5) * ...;   // scale
offset = -(vUv - 0.5) * luminance(driver.rgb) * uAmount * 0.3;// local zoom
```

`luminance()` of a signed, roughly zero-mean vector is close to zero, so
`luminance − 0.5` is close to a constant −0.5: a fixed shift, a fixed rotation, a
fixed zoom. The `local zoom` mode reduces to the identity. This accounts for the
backlog's unexplained *"very simple transforms, no warp"*. Only `vector` and
`rotation` read the driver as a field.

## R8 — Selection checks legality and never asks whether a scene is good

`buildFirstViableScene` returns the **first** candidate that satisfies the
grammar. `assembleScene` fills category quotas by weight; `wireScene` connects
each input to the newest compatible producer, preferring one nothing has read.
Nothing scores the result.

Measured across 300 builds, no plugin exceeds 43 percent and most sit between 8
and 25 percent — selection is close to uniform-random within a category subject
to the counts. `familySize` division and the sixfold `prefersWith` bonus dominate
`characterFit`, so a theme's `targetCharacter` barely steers anything.
`MAX_BUILD_ATTEMPTS` already builds up to thirty-two candidates and discards
thirty-one of them unexamined.

`PaletteMapper` is selected **0 percent** of the time without album artwork,
because its `palette` input can only come from `AlbumArtPalette`, which requires
the asset. On a track with no artwork the catalog's only palette-mapping stage is
unreachable, and since every procedural and SDF source writes
`vec4(vec3(value), value)`, all colour comes from the kernel's per-branch ramp.
That is the monochrome report.

## R9 — Audio drives appearance, not the feedback transform

`PERSISTENCE_SHADER` offers the previous frame exactly one transform:
translation along a summed motion field, scaled by `motionScale`. There is no
audio-driven zoom, rotation, scale, or centre on the accumulation.

Measured mean survival across 300 scenes is **0.184 per second**, which at sixty
frames a second is 97.2 percent per frame and an injection of **2.8 percent**.
The accumulator is a low-pass with a time constant near 0.6 seconds. Everything
the audio touches is regenerated from nothing each frame and then attenuated
thirty-six fold on the way in.

Small parameter excursions (R1), applied to material that is rebuilt every frame,
entering a heavy low-pass, is a complete account of "static image uncorrelated to
the music". The comparison worth stating: in Milkdrop the per-frame audio
variables set the *coordinate transform applied to the previous frame* —
`zoom`, `rot`, `cx/cy`, `dx/dy`, `warp`, `sx/sy` — against a survival near 0.96
to 0.99 per frame. `zoom = 1 + 0.02 * bass_att` is a two percent change that
compounds across hundreds of frames into a tunnel. The mechanism that turns a
small musical excursion into large visible motion is not present here.

---

## Not defects

Recorded so a later pass does not spend time on them.

- The beat path works. Fifty-seven beat events over twenty-four seconds of
  120 bpm material, phase sweeping a full 0 to 1. Audit item 1.1 is fixed.
- Band normalisation works. The pink weighting removed the bottom-one-percent
  problem; what remains is the occupancy problem in R1, which is a different
  question.
- The FFT is windowed, the onset detector is adaptive, and the worklet and
  main-thread paths call the same pure functions.
- The plugin, graph, scheduler, and kernel separation; the render plan and
  ping-pong slots; the layer model; the metered grade. These are sound.

## Method

Three probes were run in the Node environment against the checked-in code and
deleted afterward: a catalog and scene-assembly census over 300 builds with and
without assets; a synthesised twenty-four second bed (pink floor, 55 Hz bass
line, kick at 120 bpm, hats at eighth notes, a mid-range pad) driven through the
real analysis chain at the worklet's own framing and then through the feature bus
at sixty frames a second; and a three-way parameter run isolating the audio and
drift contributions to every bound parameter in six assembled scenes.
