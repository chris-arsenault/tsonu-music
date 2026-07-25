# 0008 — Spatial fields sum into one motion field that drags the accumulation

- Status: Accepted
- Date: 2026-07-25

## Context

`PortType` declared `motion-field` and `core/render-plan.ts` gave it a sizing rule, but nothing in
the catalog produced one and nothing consumed one. The type system had anticipated a displacement
bus that was never built.

Meanwhile the fields that did exist were nearly orphaned. A `vector-field` was consumed only by
particle advection, so scene assembly routinely selected a field that nothing looked at — enough that
`core/scene-builder.ts` had to prune non-contributing plugins after assembly and discard whole scenes
to remove them. Specification section 12.2 lists distortion regions among the things a mask should
control, and nothing implemented it.

Composition had the same shape of problem one level up. Every layer above the base blended with
`screen`, a lighten operator, so two branches accumulated toward white and read as superposition
rather than interaction, however different the material.

## Decision

After the graph runs, the runtime sums every resource whose type is a motion source —
`motion-field`, `vector-field`, `collision-field` — into one kernel-owned motion field, additively,
each contribution weighted by one over the contributor count. The accumulation buffer is then
gathered through that sum.

Contributions add rather than overwrite, so two fields compound into a single coherent drag instead
of one winning. Summing happens in a kernel pass over the graph's existing resources, so no plugin
and no graph rule changes: every field a scene already produces becomes a motion contributor in
addition to whatever else consumes it. That includes the mask-derived ones, which is section 12.2's
distortion-regions row reached without a new plugin.

Top-level layer blending is chosen from the `SelectionCharacter` a plugin already declares: bright
sparse material adds, bright material screens, dense material composites over so it can occlude.
`multiply` is deliberately not selectable here — against a dark base it collapses the frame to black,
and section 19.9 already offers it inside `LayerMixer` behind a mix factor, which is the safe place
for it.

## Consequences

Several fields contribute to one sense of flow rather than each producing a separate picture to be
blended. This is the general form of what a flow-field visualizer does, arrived at through the port
type the specification already declared, without adopting another engine's pipeline — section 24
defers MilkDrop and projectM compatibility and this does not change that.

A field is worth generating whether or not a particle system consumes it, which removes the reason
scene assembly kept producing orphans.

Not every scene is dragged. `ParticleEmitter` is categorised as a field but produces a spawn buffer
rather than a spatial field, so it can fill a family's field slot without contributing motion.
Recategorising it would disturb the particle chain, so it is left alone; a scene with no spatial
field still accumulates and decays, it is simply not dragged. Closing this properly belongs to the
structural grammar predicates recorded in [backlog.md](../backlog.md), which will require that a
scene's fields actually reach a consumer.

The motion field is allocated at half the render resolution. It is a force, not an image, and
nothing samples it for detail.
