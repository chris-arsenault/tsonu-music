# Visualizer backlog

Open work, most likely to matter first. Findings and evidence live in
`docs/visualizer-audit-2026-07.md` and `docs/visualizer-audit-2026-08.md`;
completed repairs in `VISUALIZER-REPAIR-PLAN.md` and
`VISUALIZER-REACTIVITY-PLAN.md`.

## Open

**Nothing here has been rendered.** Every figure below and in the ADR-0013 commits
comes from Node execution over the scene graph. The rebuilt loop arithmetic is
measured; what it looks like is not.

**Selection checks legality and never asks whether a scene is good.**
`buildFirstViableScene` returns the first candidate satisfying the grammar and
discards up to thirty-one others unexamined. More is measurable than the previous
revision of this file claimed: bound-parameter count, role diversity,
`peakConcentration`, `materialBranchCount`, chain depth, and — through
`SelectionCharacter`, which is already declared — branch contrast as the distance
between branch producers' characters, and focal structure as whether exactly one
plugin is `dominance: 'primary'`. Only legibility needs a renderer. Held until the
rebuilt loops have been looked at, because a fitness function tuned against
unrendered output is guesswork.

**The layer stack dilutes whatever accumulates.** Median five material branches
against `maximumFeedbackLoops: 1`, and a measured median of 40 percent of branches
routing through the loop sink. The other 60 percent are regenerated at fixed screen
positions each frame and summed in at full weight, so even a deep loop arrives
diluted about 2.5 to 1. Untouched by ADR-0013, which changed what a loop does and
not how many branches pass through one.

**A quarter of scenes are exempt from motion by grammar.** `GEOMETRIC_SIGNAL` sets
`requireSpatialLoop: false` and `requireMotionSource: false`, citing spec §15's
"restrained feedback". Measured: 97 of its 101 scenes in a 400-scene sample read no
field, and 64 have a loop that only mixes colour. That is a decision to revisit
rather than a defect, and it is a quarter of the rotation.

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

- **No stage promises non-expansion any more** (ADR-0013). One stage compresses —
  the grade — and one structural check keeps every image cycle's gain below one. A
  wiring bug now shows as a bright frame rather than a wrong one, which is a worse
  failure than ADR-0007's and the price of accumulation being expressible at all.
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
- **Three severity-3 audit items** left in place, in `VISUALIZER-REPAIR-PLAN.md`.
  There were seven; four were reasons that did not survive being read back and are
  now fixed, including the `smoothstep` with inverted edges, which was undefined
  behaviour defended as working behaviour. The three remaining are an unused
  uniform declaration, a stale uniform behind a gate, and three producer-side
  channels — none of which changes a pixel.

## Resolved since the last revision

- The accumulation admitting one transform, and then admitting none: both
  accumulators combined history and source as a convex pair, whose weights sum to
  one however long the loop runs, so the steady state was the source
  motion-blurred at unchanged brightness. See ADR-0013. Measured after: every scene
  closes an image loop (was 336 of 400), 39 distinct plugins sit at a loop's
  closing end (was 10), and the median cycle memory is a 1.09-second time constant,
  65 frames at sixty a second, against a kernel that held 0.26 to 0.72 seconds and
  accumulated nothing at any depth.
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
inspect dropdown covers `kernel:composite` and every plugin resource — the
composition was a black box between layers and canvas, and that is why the grade
went undiagnosed through sixteen commits of fixing things upstream of it.
`kernel:motion` and `kernel:accumulate` were also on it; both stages are gone, so
their entries are too. The readout row that showed persistence per second now shows
each cycle's gain.

Measure the middle of a chain, not its ends. Every wrong conclusion in this work came
from inferring a middle stage from its two ends.

Check the arithmetic of a fix, not only its shape. The convex accumulator was the
right idea about washout, applied where it forbade the thing the subsystem exists
to do, and it survived two ADRs because every reading of it was about what it
prevented rather than about what its steady state actually was.

Measure the consumer as well as the producer. The July pass fixed a producer
emitting four channels in the bottom one percent of their range and stopped there;
the consumers were still authored against a distribution nothing had, and the
median binding traversed nineteen percent of its range for another month.
