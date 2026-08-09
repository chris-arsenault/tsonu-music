# 0016 — The canonical state anchors a scene; bounded material memory composes beneath it

- Status: Accepted
- Date: 2026-08-09
- Amends: [0015](./0015-visualizer-single-graph-owned-scene-state.md)

## Context

ADR-0015 gave every complete scene one graph-owned recursive image state and made it the only
previous-frame image read the compiler accepts. Rendering the result and measuring it showed the
state alone does not produce development. With audio made exactly periodic at three seconds, the
state buffer *reduced* per-period frame divergence by 40–70% in every measured scene: `max(history *
survival, source * weight)` is a recurrence with a fixed point, bounded above by the brightest fresh
frame, so the picture converges to the audio's period within seconds. Every stage upstream of the
combine redraws from instantaneous audio, and a warp applied to a fresh redraw is invertible — the
image returns exactly when the parameter does.

The reported defects ADR-0015 responded to (trails satisfying the grammar while the screen showed
fresh material; no defined answer to "which image state is the scene") were real and its structural
answer stands. The exclusivity clauses — one image loop in the whole graph, no plugin-local image
history, one combine arithmetic — are what this decision amends: they removed the mechanisms by
which an image develops, and the measurements above are what remained.

## Decision

The canonical state of ADR-0015 is unchanged: exactly one temporal combine per scene, its output the
only presented resource, exactly one previous-frame read of that output, entering the scene history
warp and returning through the combine's history input, with every material root reaching the
combine's fresh input. `compileSceneGraph` still enforces all of it.

Three exclusivity clauses are relaxed, each with its own bound:

1. **Material memory is legal beneath the state.** Plugins may read previous-frame images again —
   nominated self-loop trails and drawn fold-back loops, including loops closed on a forward-fed
   port such as `LayerMixer.source`, whose displaced producer becomes a branch the settle loop's
   join rounds absorb. The bound is arithmetic rather than count-based: `compileSceneGraph` rejects
   any image cycle whose gain product reaches one, checked against each gain parameter's binding
   ceiling. The grammar's loop budget applies to material loops; the canonical loop counts toward
   the minimum and is exempt from the ceiling.
2. **The combine is an operator family.** `stamp` (luminance-keyed replacement over decaying warped
   history), `screen` (bounded energy accumulation), and `max` (flash afterimage) are drawn per
   scene. The bare `SceneStateCombine` id keeps the `max` arithmetic so documents written against
   ADR-0015 resolve to the operator they meant. Every operator keeps per-second survival and the
   numerical guard; none makes brightness grow with frame rate.
3. **The combine's history input declares its survival as the port gain**, so the loop-gain model
   sees the decay that actually governs the canonical cycle instead of reporting unity.

## Alternatives

Keeping ADR-0015's exclusivity and pursuing development through parameters alone was rejected by
measurement: value bindings are envelope followers of instantaneous features and release back, and
autonomous modulation is bounded to a fraction of each parameter's headroom — neither can make
second five differ structurally from second one when every pixel is redrawn each frame.

Reverting ADR-0015 entirely — returning to plugin-owned retention with no canonical state — would
reopen the defects it measured: scenes whose grammar-satisfying trails never reached the screen, and
no defined answer to which image state is the scene.

## Consequences

A scene's memory has layers: plugin trails accumulate their own past, fold-back loops compound the
composed image through lossy ports, and the canonical state carries the result between frames. The
compiler's guarantee shifts from "one loop exists" to "every image cycle converges and the displayed
state is the canonical one".

Captures written under ADR-0015 still resolve: the canonical pair compiles unchanged and the bare
combine id keeps its arithmetic. Captures naming plugins that ADR-0015 removed (`ParticleTrailInjector`,
`FeedbackInjector`) still fail to resolve; those plugins remain deleted.

The single-active-layer presentation, resource namespace scoping, sampler-level previous reads, and
lifecycle rules of ADR-0015 are unchanged.
