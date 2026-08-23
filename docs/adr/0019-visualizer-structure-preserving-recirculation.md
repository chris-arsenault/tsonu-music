# 0019 — Material that recirculates is read unfiltered, and operations that destroy structure are counted

- Status: Accepted
- Date: 2026-08-13
- Amends: [0016](./0016-visualizer-canonical-state-with-material-memory.md) and
  [0017](./0017-visualizer-combine-operator-family.md)

## Context

Scenes arrived as featureless mid-tone fields. The same scene rendered with its memory blanked every
frame was sharp and saturated; with its loop running it was a wash. The material was never the
problem — the loop was destroying it.

Two mechanisms, neither of which anyone chose:

Every render target is created with linear filtering, so a texture read at a coordinate between
texels returns a weighted mean of the four around it. Once that is a resample. Applied every frame
for as long as material survives it is a blur kernel run hundreds of times: measured on a grid with
no decay and no fresh material at all, a drift at 0.43 frame-widths per second leaves 2.8% of its
detail after one second and 0.1% after two. This is why raising the warp speed produced fog and
lowering it produced a still picture. The trade being made was never speed against smear length; it
was speed against filtering.

The `max` combine is a second mechanism that no rule about averaging can see. A running maximum
against displaced history is a morphological dilation — each frame every pixel takes the brightest
value in a neighbourhood the width of one displacement — and repeated over the life of the material
it smooths as thoroughly as a blur while containing no average anywhere.

Nothing caught either. Every other invariant in this subsystem is a computed number that fails a
build: loop gain has `divergentCycles`, terminal count has `structuralViolations`, a mixer reading
one branch twice has a test. Structure had no check, so it was the one property that could be
degraded to zero without anything going red — and it was, by round after round of work, each change
individually defensible.

## Decision

**A stage that displaces material it will read again samples one texel, not four.** The transports
and the shared `history()` helper read through a `resample` helper that snaps the coordinate to the
texel centre. Material moves in whole-texel steps, which at sixty frames a second is a sub-pixel
difference in where a thing is and the difference between a picture and a wash in what it is made
of.

**Assembly draws only the accumulating combine operators.** `flow` and `deposit` keep structure;
`max` does not. It stays in the catalog because an authored document may want a flash afterimage and
ADR-0017's arithmetic is what those documents were written against, but assembly no longer chooses
it.

**Operations that destroy structure are counted, and the count may only fall.**
`smoothing-lint.test.ts` scans every shader for weighted means, soft thresholds, blur kernels
including loops that sample a texture, exponential decay, dilation, and reads at a computed
coordinate. It is a ratchet rather than a clean sheet: the catalog holds hundreds of these and a
lint that fails from its first commit gets skipped rather than obeyed. One rule sits at zero
tolerance — a plugin that feeds its own output back may not read material through a filter — because
that is the class that compounds. A second test fails when a ceiling goes stale, so removing an
operation forces the number down instead of leaving slack.

## Alternatives

A detail gate in the render harness was the first proposal and was rejected: a render takes twenty
minutes, needs a GPU, and reports that a scene went to mush without naming the line that did it.
Prevention has to be cheap enough to run on every change. The harness keeps the measurement, as a
diagnostic rather than a gate.

Sharpening inside the loop to cancel the filtering was measured and rejected. At gains low enough to
stay stable it recovers little — an unsharp of 0.35 held 14% of detail at one second against 2.8% —
and at gains high enough to matter the loop amplifies its own noise, reaching four times the seed's
peak within three seconds.

Rationing the filtering by bounding how many times material is resampled before it decays was
rejected on arithmetic: sixty resamples already costs 97% of detail, and sixty frames is one second,
so any budget honest about the mechanism forbids trails entirely. The resample had to stop
destroying structure rather than be allowed less of it.

Shortening `max`'s afterimage so it dilates fewer times was implemented and reverted; the rendered
scenes were unchanged. Removing it from the draw was implemented and kept.

## Consequences

Across sixteen rendered scenes, each measured against its own memory-blanked render, the median
structure the loop keeps went from 52% to 98%, and the scenes keeping under a quarter went from four
to none. No scene got worse.

Nearest-texel reads alias where bilinear reads blurred, so a slow displacement steps rather than
glides and a hard edge stairsteps. That is the trade taken deliberately: aliasing is visible detail
and filtering is the absence of it.

The lint's ceilings are load-bearing. They record 971 operations across the catalog at the time of
writing, and each one lowered is a class of smoothing removed. They are not a target to drive to
zero — a soft threshold in a source that draws a glyph is not the defect this exists to catch — but
nothing may be added without a number moving.
