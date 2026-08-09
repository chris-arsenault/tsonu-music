# 0014 — A colour pass transforms state; it never generates a frame

- Status: Rejected by [0015](./0015-visualizer-single-graph-owned-scene-state.md)
- Date: 2026-08-09
- Amends: [0013](./0013-visualizer-uniform-node-state.md)

## Context

[ADR-0013](./0013-visualizer-uniform-node-state.md) made every node output persistent and moved the
bound from the individual combine to the graph's loop gain. Scenes built on it still read as a
picture that responds instant by instant and then returns to where it started. The report from
watching them: "every translation or zoom is immediately met with the exact inverse — the image
bumps to the beat, but it never goes anywhere, because the parameters are always being treated as
absolute rendering, there's never any drift."

That is a literal description of what a source plugin does. It computes an image from the current
time and the current feature bus and writes it over the target. Its output at frame *N* is a
function of the features at frame *N* and nothing else, so when a feature returns to a value it held
before, the image returns with it. No accumulator downstream can recover history the producer never
had.

### The clear flag is not the mechanism

The obvious suspect is `clear: true`, which `defineShaderPlugin` applies by default and which every
geometry source sets explicitly. For a **fullscreen** pass it is a no-op: the quad covers the
viewport and `blend: 'none'` disables the blender, so the source replaces the destination whether or
not the target was cleared first. Flipping the flag on the fifty-odd fullscreen plugins would change
no pixel.

The clear does matter for a **geometry** pass. `SpectrumGeometrySource`, `SignalTraceSource`,
`TransientGlyphSource` and `ImpactCascadeSimulator` each wipe a persistent target and then draw a
sparse line strip into it. Everything the target held is destroyed every frame and replaced by a few
thousand lit pixels, which is why a spectrum in a scene reads as a thin spectrogram playing behind
the image, unwarped and uninteracting.

So there are two distinct destroyers — fullscreen replacement and sparse-draw-after-clear — and one
rule covers both.

### Measured state

Sixty built scenes, catalog as of this ADR, colour targets at 1920×1080 RGBA16F:

| producer category | colour targets/scene | of which ping-pong |
| --- | --- | --- |
| source | 2.37 | 0.12 |
| transformer | 3.07 | 0.45 |
| compositor | 4.62 | 0.42 |
| postprocess | 1.83 | 0.02 |
| **total** | **11.9** | **1.0** |

Target memory is 261 MB as planned today, and 442 MB if every colour resource were given a second
slot.

A transformer is not part of the problem. `warp(uSource)` is already a transform of an existing
image; the image arrives from upstream instead of from its own target, and the history in it is
whatever upstream carried. The 2.37 sources per scene are where a frame gets generated from nothing,
and 0.12 of them keep any history at all.

## Decision

**A colour pass's output must be a function of at least one colour texture** — its own previous
contents, an upstream one, or both. A pass that writes colour while reading none is generating a
frame, and no such pass may exist.

Two rules carry it, both decidable from the compiled graph without a GL context:

- **R1.** No colour pass clears its target.
- **R2.** No colour pass writes with `blend: 'none'` unless its node reads a colour texture.

Presentation stages are exempt. The tone mapper reads the composed image and writes the canvas; it
sits outside every accumulation cycle by construction and has no state to preserve.

### Persistence costs no memory

A target can be decayed without being sampled. A fullscreen quad of `vec3(pow(survival, uDelta))`
drawn with `blend: 'multiply'` leaves `dst · survival^Δt`: the fixed-function blender reads the
destination, so this needs no texture read and therefore no second slot. Emitted by
`defineShaderPlugin` ahead of a producer's own passes, it gives every colour target a per-second
survival for zero VRAM.

`survival` is an ordinary bound parameter and is bound to the music rather than left constant, with a
ceiling of 0.9 a second — comfortably below the 1 at which the decay stops being one. The binding is
inverted: a dense passage overwrites the frame whatever the survival is, so holding a long memory
through one buries the picture, while a sparse passage has nothing to show but what it remembers.

The pair is bounded without help. With a `lighten` combine the target never exceeds the brightest
contribution ever made to it, at any survival below 1. `core/loop-gain.ts` neither sees this loop nor
needs to: it closes through the fixed-function blender rather than through an edge, and `graphCycles`
only walks edges. A first draft of this ADR claimed the opposite.

### Sources composite rather than replace

With the target decaying, a source's own pass switches from `blend: 'none'` to `lighten`, so the
target holds `max(survival · previous, contribution)`. That is the sup-norm non-expansive combine
ADR-0013 settled on: bounded above by the brightest thing ever injected, and unlike a convex blend
it holds an arbitrarily long memory without the weights summing back to one copy of the source.

The four geometry sources drop the clear and take `lighten` too, rather than the `add` they had.
Additive injection into a decaying target has a steady state of `c / (1 − s_frame)`, and `s_frame`
approaches 1 as the frame rate rises for any fixed per-second decay — so the same scene would be
brighter on a 144 Hz display than on a 60 Hz one. A max combine has no such term.

Both are path dependent: what a target holds at second five depends on the whole sequence since
second zero, not on the feature values at second five.

### Drift needs a second slot, and only where a field is bound

Decay alone leaves a trail in place. Displacing what the target already holds requires sampling it,
which requires a ping-pong slot. An output declares `retained` to ask for one, and the compiler
grants it only to a node something is wired into — displacement by a field nothing produced is the
identity, and would buy a full-resolution buffer to copy a texture to itself.

Measured over sixty built scenes: **1.42** drifting producers a scene, at least one in **50 of 60**
scenes, and target memory from **261 MB to 287 MB**. Retaining every colour resource would have been
442 MB.

The ageing pass reads from behind. A field is a velocity in UV per second, so material travelling
along `+field` arrives from `uv − field·Δt` — the sign convention `GLSL_RESAMPLE_MOTION` already
states, where a transform reads at `source` and writes at `uv`. Where there is no field or no slot it
falls back to the multiply decay rather than sampling the target it is writing.

This is the part that turns a trail into motion that goes somewhere.

## Consequences

Every colour target in the graph becomes a memory whose contents outlive the frame, and every scene
gains as many bounded self-loops as it has colour producers. None of them reaches `divergentCycles`,
because none is an edge; each is bounded locally by a survival below 1 against a max combine.

Trails on every producer risks scenes reading as mush. `survival`'s range is the control, and the
harness decides rather than judgement: period-locked divergence against the null model, before and
after. With the feature bus on a fixed period and the graph unchanged, frames one period apart must
diverge by more than the null model accounts for, and the gap must widen with elapsed time. A
measurement that does not show this refutes the decision rather than needing tuning.

A contract test in `shader-contract.test.ts` enforces R1 and R2 over every registered definition, so
a producer added later cannot reintroduce a redraw by omission.
