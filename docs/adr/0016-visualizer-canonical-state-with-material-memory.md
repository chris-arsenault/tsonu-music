# 0016 — The canonical state anchors a scene; bounded material memory composes beneath it

- Status: Accepted
- Date: 2026-08-10
- Amends: [0015](./0015-visualizer-single-graph-owned-scene-state.md)

## Context

ADR-0015 gave every complete scene one graph-owned recursive image state and made it the only
previous-frame image read the compiler accepts. Its structural answer — one defined state, owned by
the graph, presented as the only layer — resolved real defects and stands. Its exclusivity clauses
did not survive contact with the output. Measured over 400 production-shaped builds, every scene
shared one recurrence topology: one warp family (five modes, two scalars) and one combine
arithmetic, and the standing defect reports — motion that never accumulates, warps whose small
per-frame displacement is rebuilt from nothing, layers that never interact — describe precisely
what a single bounded `max` recurrence produces. Rendered measurement agreed: with audio made
exactly periodic, the state buffer reduced per-period frame divergence rather than adding novelty.

This amendment is the direction the project owner has given consistently: frames are transformed,
not redrawn; motion accumulates; a scene's memory has parts.

## Decision

The canonical state of ADR-0015 is unchanged: exactly one temporal combine per scene, its output
the only presented resource, exactly one previous-frame read of that output entering the scene
history warp and returning through the combine's history input, every material root reaching the
combine's fresh input. `compileSceneGraph` still enforces all of it.

Three exclusivity clauses are relaxed, each with its own bound:

1. **Material memory is legal beneath the state.** Plugins may read previous-frame images —
   nominated self-loop trails and drawn fold-back loops, including loops closed on a forward-fed
   port such as `LayerMixer.source`, whose displaced producer becomes a branch the settle loop's
   join rounds absorb. The bound is arithmetic rather than count-based: `compileSceneGraph`
   rejects any image cycle whose gain product reaches one, checked against each gain parameter's
   binding ceiling. The grammar's loop budget applies to material loops; the canonical loop counts
   toward the minimum and is exempt from the ceiling.
2. **`TemporalTransform` returns to the catalog** as the history-port transformer: its `decay`
   parameter is the declared gain of any cycle closing on its optional `history` input, which is
   what gives drawn loops a converging port to land on.
3. **The combine's history input declares its survival as the port gain**, so the loop-gain model
   sees the decay that governs the canonical cycle instead of reporting unity.

The combine arithmetic is an open question, not a settled one. `max` is what ships today; it is a
winner-take-all recurrence in which fresh brightness erases warped history wherever both are lit,
so motion is only visible where the fresh frame is dark — static bright regions are its signature.
One alternative family (stamp/screen) was implemented hastily and read as washout in viewing;
that discredits those two implementations, not the direction, which stands as reported: the
composition operator needs to be debugged and alternatives designed rather than treated as an
invariant.

## Alternatives

Keeping the exclusivity and pursuing development through parameters alone was tried across two
passes (aperiodic modulation, per-scene expression draws). Both improved response variety and
neither produced accumulation: value bindings release back, and a warp applied to a fresh redraw
is invertible. The reported "the image bumps to the beat but never goes anywhere" is that
mechanism described from the couch.

Reverting ADR-0015 entirely — plugin-owned retention with no canonical state — would reopen the
defects it measured: grammar-satisfying trails that never reached the screen, and no defined
answer to which image state is the scene.

## Consequences

A scene's memory has layers: plugin trails accumulate their own past, fold-back loops compound the
composed image through lossy ports, and the canonical state carries the result between frames. The
compiler's guarantee shifts from "one loop exists" to "every image cycle converges and the
displayed state is the canonical one".

Captures written under ADR-0015 resolve unchanged. Captures naming plugins deleted at ADR-0015
(`ParticleTrailInjector`, `FeedbackInjector`) still fail; those plugins remain deleted. The
single-active-layer presentation, resource namespacing, sampler-level previous reads, and
lifecycle rules of ADR-0015 are unchanged.
