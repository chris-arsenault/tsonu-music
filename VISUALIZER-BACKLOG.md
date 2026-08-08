# Visualizer backlog

Open work, most likely to matter first. Findings and evidence live in
`docs/visualizer-audit-2026-07.md` and `docs/visualizer-audit-2026-08.md`;
completed repairs in `VISUALIZER-REPAIR-PLAN.md` and
`VISUALIZER-REACTIVITY-PLAN.md`.

## Held for design

Three items from the August audit are repairs only in the sense that something is
wrong. Each has a decision inside it that should be made deliberately rather than
inside a fix, and each is written up in `VISUALIZER-REACTIVITY-PLAN.md`.

**The accumulation admits one transform.** The previous frame is translated along
a motion field and nothing else — no audio-driven zoom, rotation, centre, or
anisotropic scale. Everything the audio touches is regenerated from nothing each
frame and then attenuated thirty-six fold on the way into a buffer with a
0.6-second time constant. This is the largest open item and the one that decides
whether the output reads as a Milkdrop-class visualizer: there, the per-frame
audio variables set the coordinate transform applied to the previous frame, so a
two percent change compounds across hundreds of frames into a tunnel.

**Selection checks legality and never asks whether a scene is good.**
`buildFirstViableScene` returns the first candidate satisfying the grammar and
discards up to thirty-one others unexamined. Scoring them needs a fitness
function; bound-parameter count and role diversity are measurable, but branch
contrast and focal structure are what decide whether a scene is worth looking at,
and neither has a measure yet.

## Not built

**Fractalization.** No fractal source exists. `FractalFlameSource` and
`EscapeFractalSource` are deferred in spec §24, and `TilingTransform:recursive-frames`
is the only thing approximating it. Requested directly; deferred on spec grounds,
which is not a good reason.

**Rigid contact in dense packs.** The CPU solver is correct and converges, but the
grid stores one list per cell sized to one diameter. Deep pile-ups still need more
relaxation passes than a frame affords. Only matters if piles become a visual goal.

**A second lateral measure.** The `lateral-force` role admits exactly one feature,
`stereoBalance`, so a binding distributed there has nothing to fall back to. The
channel works now, but on near-mono material it correctly reports no movement and
the role goes quiet with it.

## Deliberate, recorded here so they are not mistaken for oversights

- **Persistence injection is 2–4% per frame**, attenuating a layer 30–40× between
  transients. Measured; left alone, and now part of the accumulation-transform
  item above rather than a tuning question on its own.
- **Excitation channels read as gates** (median 0.000, 95th percentile 1.000). That
  is what an excitation channel is for; binding kind-preservation makes it safe,
  and they are deliberately excluded from the occupancy normalisation for the same
  reason.
- **Level channels no longer express inter-band balance as amplitude.** Each is
  normalised against its own distribution, so a treble-bound parameter is
  expressive on a bass-heavy mix. Balance survives in the raw material every later
  stage derives from and in excitation, which is measured from raw energy. This
  reverses a decision recorded in `core/features.ts`, on purpose.
- **Positions in the particle catalog are world pixels**, so emitter origins,
  force centres, and collider geometry are unbound: any range would be a different
  fraction of the frame at every render size. Worth revisiting if these become
  normalised coordinates.
- **Seven severity-3 audit items** left in place with reasons, in
  `VISUALIZER-REPAIR-PLAN.md`. The notable one is a `smoothstep` with inverted
  edges — formally unspecified, correct on every mainstream driver, untestable
  here.

## Resolved since the last revision

- Saturation falling with the particle count: the count was never the limit. The
  emission rate was, and the whole subsystem was unbound. See step 4.
- `spectralCentroid` pinned at its ceiling: the linear 8 kHz cut is gone. See step 2.
- `DomainWarpTransform` rendering nearly black with "no warp": fixed. It read a
  signed vector field through `luminance()`; the scalar its four broken modes
  wanted was in `.b`, which every field producer has always written. The held
  design question — whether to add a scalar-image port — rested on a premise that
  was never true. See step 9.

## Working notes

`frontend/devlab/` is the harness: gitignored, port 26010, five audio beds. The
inspect dropdown covers the kernel's own stages (`kernel:composite`,
`kernel:motion`, `kernel:accumulate`) as well as plugin resources — the composition
was a black box between layers and canvas, and that is why the grade went
undiagnosed through sixteen commits of fixing things upstream of it.

Measure the middle of a chain, not its ends. Every wrong conclusion in this work came
from inferring a middle stage from its two ends.

Measure the consumer as well as the producer. The July pass fixed a producer
emitting four channels in the bottom one percent of their range and stopped there;
the consumers were still authored against a distribution nothing had, and the
median binding traversed nineteen percent of its range for another month.
