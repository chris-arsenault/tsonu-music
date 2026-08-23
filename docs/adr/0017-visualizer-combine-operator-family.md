# 0017 — The scene-state combine is an operator family with a verified energy model

- Status: Amended by [0019](./0019-visualizer-structure-preserving-recirculation.md)
- Date: 2026-08-10
- Amends: [0016](./0016-visualizer-canonical-state-with-material-memory.md)

## Context

Three captured scenes shared one failure mechanism: the sole combine, `max(history * survival,
source * weight)`, is winner-take-all per pixel. Fresh brightness erases warped history wherever
both are lit, so a static bright figure never moves and motion survives only in dark regions. The
standing direction is to debug the composition operator rather than treat either the max fixed
point or additive saturation as invariants. A previous operator family (stamp/screen) shipped
without render verification and failed in viewing; this decision's operators were adversarially
reviewed before implementation — the review removed a convex mix whose dark regions would have
lost their trails during loud passages, and an additive form whose fresh material would have been
invisible for tens of seconds after a track change — and are gated on rendered fixtures with
numeric thresholds.

## Decision

Three combine definitions, one drawn per scene:

- **`SceneStateCombine` (`max`)** — unchanged; the bare id keeps the arithmetic every existing
  document was written against. A flash afterimage: one character, drawn rarely.
- **`SceneStateCombine:flow`** — a softened max: `mix(history, max(history, source), share)` where
  `share` closes the gap to the envelope at an audio-driven per-second rate, with a void fill
  keyed on *history* luminance so a cleared state fills immediately. Bright regions hand over to
  fresh material at the inject rate instead of in one frame — history visibly fades inside lit
  figures. Dark regions decay on survival alone, so trails do not shorten when the music gets
  loud, and the declared history-port gain is literally the dark-region behaviour.
- **`SceneStateCombine:deposit`** — a normalized additive recurrence: injection is scaled by the
  survival complement so the steady state is exactly `inject` copies of the source
  (frame-rate-independent), bounded by a hue-preserving luminance knee at 1.6, with a `max`
  floor so fresh material is visible from its first frame.

Selection is weighted by material coverage: dense scenes lean `flow`, sparse scenes lean
`deposit`, `max` keeps a constant small weight; authored density misclassifies stencil-gated and
glyph scenes, so those force the sparse reading; no class is deterministically one operator. Flow
scenes raise the canonical warp strength floor (a one-copy takeover at crawling warp speed reads
as blur, not travel). Presentation clamps the composite at one, because the state is now
legitimately HDR and `screen`-blended crossfades invert above one.

### The ADR-0013 answer

ADR-0013 rejected convex blends because their fixed point holds exactly one copy of the source —
"a motion blur, never a tunnel". That critique is answered at the family level, not dodged:
`flow` is deliberately the legibility operator and never the only memory in a scene (material
trails and fold-backs carry accumulation under ADR-0016); `deposit`'s fixed point holds strictly
more than one copy — its inject binding floor is above 1, pinned by a contract test that is the
positive companion to the anti-complement shader rule.

## Alternatives

Keeping `max` alone preserves the failure signature by construction. Reintroducing the earlier
stamp/screen pair fails known analysis: source-coverage keying degenerates to passthrough on
dense material, and unnormalized screen accumulation saturates. A single "correct" operator was
rejected because the failure modes are complementary — the operator that keeps dense scenes
legible is the one that starves sparse scenes of accumulation.

## Consequences

Scene memory has an arithmetic character drawn per scene, bounded in every case: flow inside the
max envelope, deposit at its knee, both frame-rate-independent and frozen-clock safe. Rendered
verification is part of the contract: the fixture harness measures motion inside bright regions,
passthrough, post-clear rise time, and transient visibility against numeric thresholds at two
frame rates before any operator ships or changes. Each operator is one registry line to disable.
