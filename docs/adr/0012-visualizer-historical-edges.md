# 0012 — Any edge may read the previous frame; the kernel guarantees memory but no longer transforms it

- Status: Accepted
- Date: 2026-08-08
- Supersedes: [0008](./0008-visualizer-motion-field-bus.md)
- Amends: [0007](./0007-visualizer-kernel-persistence.md)

## Context

[ADR-0007](./0007-visualizer-kernel-persistence.md) gave the kernel an accumulation buffer so that
every scene has frame-to-frame memory rather than most scenes having none.
[ADR-0008](./0008-visualizer-motion-field-bus.md) summed every spatial field into one displacement
and gathered the accumulation through it, so that a field was worth generating whether or not a
particle system consumed it.

Both decisions were right about the problem and both left the same gap: the only thing that can
happen to the accumulated image is a displacement. `sumMotion` produces a `vec2` per texel and
`PERSISTENCE_SHADER` gathers from `vUv - field · scale · dt`. That is one verb, fixed in the kernel.
Blurring the history, hue-rotating it, thresholding it, mixing two histories, feeding it through any
plugin at all — none of it is expressible, in a subsystem whose stated premise
([README](../../frontend/src/visualizer/README.md)) is that every visual behaviour is a plugin.

The gap is not in the machinery. `core/graph.ts` already treats `feedback` as an attribute of an
*edge*, excludes those edges from the topological order so they may close cycles, records
`previous[port] = resource` for any resource, and derives the ping-pong set generically;
`core/render-plan.ts` allocates the second slot; `host/runtime.ts` resolves previous against current
per pass. Every part of the execution path was built for arbitrary historical reads.

`core/wiring.ts` is where it narrows. `isFeedbackPort` matches the port *names* `history`,
`feedback`, and `previous`, and `ownOutputFor` then points the edge at the plugin's own output. A
general mechanism was reduced, at the wiring layer alone, to "a plugin may read itself if it declared
a specially named port".

ADR-0008 also recorded its own successor: it noted that a field filling a family's field slot without
reaching a consumer is closed properly by structural grammar predicates requiring that a scene's
fields actually reach one, and deferred that to the backlog.

## Decision

**Historical reads are a property of edges, chosen by wiring and by authoring, not declared by port
name.** Any input may be satisfied by another node's previous frame. A plugin's `feedbackFrom` and
its conventionally named ports remain honoured as a hint about where history is most useful to that
plugin, and stop being the definition of where history may occur.

Three consequences of that, decided here.

### Which edges may be historical is derived, and how many is grammar

Candidacy comes from the port type rather than a table: an input carrying an image or a field can
mean something as a previous frame, and a palette strip or a value port cannot. Derived, as
`isConfigurationNode` is, so a plugin added later cannot land in the wrong bucket by omission.

Necessity is unchanged: an edge that would otherwise close a cycle must be historical, which the
graph compiler already demands.

Expression becomes a grammar range. `minimumFeedbackLoops` counted *plugins carrying a capability*,
which is the probabilistic shape ADR-0007 rejected for persistence and which no longer describes what
matters. It is replaced by a count of historical edges, at least one of which must terminate at a
node that transforms space — a scene whose only loop is a colour mix has memory and no motion.

### The kernel guarantees memory and stops transforming it

ADR-0007's argument survives intact and is not reopened: persistence must be a guarantee, because
leaving it to selection meant most scenes had none. The kernel keeps the accumulation buffer, the
leaky integrator whose survival and injection are complements, the per-second black floor, and the
grade.

The kernel's *drag* is removed. Displacement is a visual behaviour, and visual behaviours are
plugins. A warp reading a historical edge does what `PERSISTENCE_SHADER`'s gather did, in a position
any other plugin could occupy instead.

This is the split the architecture already implies. The kernel owns *that* there is memory and that
it converges; the graph owns *what happens to it*.

### The motion-field bus is retired, and fields are wired to consumers instead

With displacement in the graph, a kernel pass that silently consumes every motion-typed resource is
a second mechanism for the thing the graph now does explicitly, and the reason for it goes away.
ADR-0008 adopted the bus partly to stop scene assembly producing orphan fields by giving every field
a universal consumer. Assembly now closes optional value inputs structurally, and the same discipline
covers fields: a field is worth generating when something reads it, and wiring is what makes that
true.

`producesMotion` and `requireMotionSource` accordingly stop asking whether a scene contains a field
and start asking whether one reaches a consumer, which is the predicate ADR-0008 deferred to the
backlog.

### Stability is bounded rather than guaranteed, and that is a real cost

ADR-0007's amendment records what arbitrary loops reintroduce. The first accumulation screened the
composite onto the history, which has no fixed point, and the image washed to white with a yellow
cast within seconds on a real device. The leaky integrator's complement is what fixed it, and it
works because the kernel owns the combine.

Once a plugin can close a loop, the kernel does not own the combine and cannot promise a fixed point.
A loop through an additive mixer converges, but to a multiple of its input rather than to its input.
Three bounds, in order of how much they carry:

1. Every resource read through a historical edge is decayed per second by the kernel, using the
   arithmetic already in `core/persistence.ts`. Every loop is lossy by construction, so no loop has
   unbounded gain from the history term alone.
2. Historical slots are clamped on write. A divergent loop saturates instead of reaching infinity or
   `NaN`, and a `NaN` would blank the frame — the worst available failure and the hardest to read.
3. The grade's roll-off remains the final compressor.

This bounds the failure; it does not eliminate it, and it is weaker than what ADR-0007 achieved for
the case ADR-0007 covered. That is the price of the composition, stated rather than hidden. The case
ADR-0007 covered — the kernel's own accumulation — keeps its exact fixed point, because the kernel
still owns that combine.

## Consequences

What the previous design expressed as one kernel stage with a knob becomes a graph: the wake of
moving material dragging the image beneath it is a vector field wired into a warp whose source is
historical, and the same position accepts a blur, a threshold, a colour operation, or a second mixer.
The vocabulary is the catalog rather than a `vec2`.

MilkDrop's compounding transform arrives without adopting its pipeline, which spec section 24 still
defers. `FeedbackFlowTransform` already computes zoom, rotation, translation, spiral, and pinch from
audio-bound parameters and applies them once to material that is discarded next frame. Closing that
loop through the graph is what makes the same numbers compound over hundreds of frames.

Scene assembly gains a degree of freedom it did not have, and it is a large one. Where a loop closes
changes a composition more than which plugins are in it, and the scheduler now chooses that. This is
the first structural choice in assembly that has no analogue in the category counts.

Memory follows the composition rather than being fixed. A resource gets a second slot exactly when
something reads it historically, which the render plan already derives; there is no per-layer buffer
and no fixed count.

Existing plugins are unaffected. `FeedbackFlowTransform`, `FeedbackInjector`, and
`ParticleTrailInjector` declare feedback ports that keep resolving to their own output, which is one
of the configurations the general rule admits.
