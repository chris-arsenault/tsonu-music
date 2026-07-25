# Visualizer Motion and Reactivity — Remediation Plan

The visualizer subsystem described in [`VISUALIZER-PLAN.md`](./VISUALIZER-PLAN.md) is built and
shipped, but it does not produce the intended result: scenes read as static compositions with small
per-layer animation rather than as material in continuous, musically driven motion. This plan
restores motion and musical response **inside** the existing microkernel plugin-graph architecture.

Source of truth for requirements remains [`docs/visualizer-spec.md`](./docs/visualizer-spec.md);
section numbers below refer to it.

## Diagnosis

Three structural facts explain nearly everything observable.

**The plugin contract cannot express evolving state.** `RenderContext` (`core/plugin.ts`) carries no
clock, no features, and no parameters. A plugin's `render` can only emit what it captured during
`update`, and twelve of sixteen plugin modules capture nothing. `FeedbackFlowTransform` — the
foundational feedback plugin per §19.8 — has an empty `update` and is documented as "stateless
between frames."

**Bindings can scale a displacement but never a velocity.** A `ParameterBinding` maps
`feature → parameter → uniform`. There is no path from audio to a *rate of change*. Music can change
how far something is offset; it can never change how fast something moves. No amount of retuning
reaches this, because the expression does not exist.

**Four declared port types have no producers and no consumers.** `motion-field`, `depth-texture`,
`event-feature`, and `event-stream` are declared in `core/plugin.ts`. `motion-field` even has a
sizing rule in `core/render-plan.ts`. The type system anticipated a displacement bus and an event
bus; neither was built.

On top of that sit ten narrower defects, several of which are unimplemented spec rather than design
disagreement — §11 assigns feedback injection and crossfades to the compositor and neither exists;
§19.8 lists nine `FeedbackFlowTransform` modes and eight are implemented; §19.9 lists nine
`MaskRouter` operations and six are implemented; §20 gives an explicit feature-to-target table that
`core/audio-mapping.ts` overwrites at random.

## What is preserved

Not up for negotiation, and not incidentally — this is the part of the design that is working:

- The six plugin categories of §8.1 and the typed port system of §9.1, extended rather than replaced.
- The complete plugin catalog. No plugin is deleted. None is rewritten except to gain optional ports
  and bindings.
- The particle and physics stack: `ParticleSimulator`, `ParticleEmitter` (including the `shape` mode
  that is §25's `MaskParticleEmitter`), `ParticleForceField`, `ParticleRenderer`,
  `ParticleTrailInjector`, `ImpactCascadeSimulator`, and the `collision-field` path into
  `ParticleSimulator.boundary`.
- The mask pipeline and every dimension §12.2 lists for it: particle spawn, collision boundaries,
  containment, feedback visibility, distortion regions, colour injection, wave clipping, symmetry
  anchors, parallax influence.
- Scheduler, scene grammar, mutation model, deactivation policies, performance ladder, fallback
  hierarchy, and playback-clock freeze semantics.
- The pure-core / thin-shell split of [ADR-0003](./docs/adr/0003-visualizer-pure-core-thin-shell.md).

MilkDrop and projectM compatibility remain deferred per §24. The persistence and displacement work
below is the general form the spec already implies, not an import of another engine's pipeline.

## Design changes

Five contract-level changes make the missing behaviour expressible. Each is additive.

### C1 — `motion-field` becomes a summing displacement bus

Fields and transformers gain an optional `motion-field` output carrying a per-pixel displacement
contribution. Contributions **sum** into one field; the compositor performs **one gather** through
the sum. This is what makes several layers compound into a single coherent flow instead of blending
into a flat superposition.

It also fixes the orphan-field problem structurally. `core/scene-builder.ts` currently discards
whole scenes containing fields nothing consumes — the assembler routinely produces them, and the
remedy was to throw the scene away. Once displacement is a consumable bus, `ProceduralVectorField`,
`MaskBoundaryField`, `AudioImpulseField`, and mask and artwork gradients all become motion
contributors in addition to their existing roles, and the `field` category carries load.

### C2 — Persistence becomes a kernel-owned stage

§11 assigns feedback injection to the compositor and §24 lists feedback buffers under Foundation.
All nine example compositions in §25 contain a persistence plugin. The implementation made
persistence one optional plugin among roughly 150, gated by a grammar ceiling with no floor.

The kernel gains a composite accumulation buffer, gathered each frame through C1's motion field,
decayed, then accumulated into. `feedbackParticipation` — already a field on `VisualLayer` in §11,
already computed by `composeLayers`, currently consumed by nothing — becomes its real weight.

`FeedbackFlowTransform`, `FeedbackInjector`, and `ParticleTrailInjector` keep their roles unchanged.
They now *shape* a guaranteed loop rather than being the only thing that can create one. A scene
without them is calmer, not frozen.

C1 without C2 is a warped still image. C2 without C1 is motion blur. They ship together.

### C3 — Integrator bindings

`ParameterBinding` gains `mode?: 'value' | 'rate' | 'impulse'`, defaulting to `value` so every
existing binding is unchanged. Under `rate`, `outputRange` expresses units per second and the kernel
integrates: `parameter += target * deltaSeconds`. Frozen-clock semantics come free, because delta is
already zero when frozen.

This is what turns "warped five percent because the bass is loud" into "spinning faster because the
bass is loud."

### C4 — Event bindings

Under `impulse`, an onset or beat fires a decaying envelope on any parameter of any plugin. Today
only two plugins declare `impactDriven` and the `event-feature` and `event-stream` port types have
no producers, while §20 explicitly wants onsets driving bursts, impulses, and collision launches.

### C5 — Structural grammar predicates

`core/grammar.ts` constrains category counts, dominance, and ceilings — nothing about signal flow.
It gains predicates: a persistence stage is required; at least one field must be consumed by a
non-field; at least two material branches must meet at a compositor that is not `screen`. This is
what "reads as one composition" actually means, and it lets `contributingPluginIds` stop being a
post-hoc salvage pass.

## Defects

| Id | Defect | Milestone |
| --- | --- | --- |
| D1 | `SceneGrammar` has `maximumFeedbackLoops` but no floor, so most scenes have no persistence | M2 |
| D2 | §11 compositor duties unimplemented: `feedbackContributors` computed and unused, `crossfades` never supplied, `buildLayers` hardcodes `screen` | M2 |
| D3 | `FeedbackFlowTransform` missing §19.8's ninth mode, vector-field flow | M3 |
| D4 | `MaskRouter` missing §19.9's union, intersection, and subtraction | M3 |
| D5 | All four mask fields declare zero bindings and emit literal uniforms, so the mask pipeline is frozen | M3 |
| D6 | `distributeReactivity` overwrites `binding.feature` at random, discarding §20's mapping table | M1 |
| D7 | One shared band ceiling compresses every band level into a narrow range; treble is never usable | M1 |
| D8 | Modulation depth is 4.5–10% of a binding's range, below the visible threshold | M1 |
| D9 | Feedback decay and strength are per-frame constants with no delta term | M2 |
| D10 | No test can observe motion, which is why this shipped green | M2 |

## Milestones

### M1 — Signal chain — **done**

D6, D7, D8, C3, C4. Confined to `core/`, no contract break, fully testable in the Node environment.
The existing catalog becomes measurably more musical with no other change, which is why this goes
first.

- Add per-band **excitation** features alongside the existing level features. Excitation measures how
  far a band sits above its own recent mean relative to its own recent deviation, computed from raw
  band energy so bands do not couple through a shared ceiling. Level channels keep their current
  semantics and relative balance; excitation supplies the dynamics that level cannot.
- Replace random feature assignment with **role-based** distribution. A binding declares a role drawn
  from §20's table — `intensity`, `large-scale-force`, `deformation`, `detail`, `burst`,
  `repeating-motion`, `complexity`, `lateral-force`. The scheduler distributes *which plugin gets
  which feature within its role*, preserving anti-monotony without violating the target column. A
  binding with no declared role infers one from its authored feature, so no plugin definition has to
  change for this to take effect.
- Add `rate` and `impulse` binding modes, and apply them where they earn their place immediately
  rather than landing as unused capability.
- Raise modulation depth to a visible fraction of a binding's range. Rate and impulse bindings are
  exempt: an integrator already moves continuously, and an envelope should not be smeared.

*Verifiable:* feature traces over synthetic and real audio show per-band dynamic range; a `rate`
binding integrates and holds under a frozen clock; an `impulse` binding fires and decays; role
distribution never assigns a feature outside its role's family.

### M2 — Motion and persistence — **done**

C1, C2, D1, D2, D9, D10. Recorded in
[ADR-0007](./docs/adr/0007-visualizer-kernel-persistence.md) and
[ADR-0008](./docs/adr/0008-visualizer-motion-field-bus.md).

Delivered as designed, with three deviations worth stating:

- **No plugin gained a `motion-field` output.** Summing happens in a kernel pass over the graph's
  existing resources, so every `vector-field` and `collision-field` a scene already produces became a
  motion contributor with no plugin edit and no graph rule change. The declared port type is reserved
  for a plugin that wants to emit displacement and nothing else.
- **`multiply` is not selectable at the top level.** Against a dark base it collapses the frame to
  black. Section 19.9 already offers it inside `LayerMixer` behind a mix factor, which is where it is
  safe. Top-level layers choose between `add`, `screen`, and `normal` from declared character.
- **D10 tests the recurrence, not the GPU.** Headless WebGL2 with float render targets is not
  available to the Node suite, so `core/persistence.ts` holds the arithmetic and is run against a
  small grid; the shader mirrors it. That the GPU path is wired to the same numbers is a real-device
  check, recorded in [backlog.md](./docs/backlog.md) beside the three criteria already there.

One gap moved to M4: `ParticleEmitter` is categorised as a field but produces a spawn buffer rather
than a spatial field, so it can fill a family's field slot and leave a scene accumulating but never
dragged — about one scene in five. Recategorising it would disturb the particle chain, so it is
closed by C5's structural predicates instead.

### M3 — Mask dimensions

D3, D4, D5, plus wiring mask-derived fields into the motion bus. This is the milestone that delivers
masks as scene modifiers across dimensions: colour, animation and feedback, physics surface,
stencil, containment — composable through the restored set operations.

*Verifiable:* one scene per dimension in §12.2's list, each asserted to compile and to produce
motion.

### M4 — Grammar and catalog depth

C5, then extension toward §24's secondary scope now that fields and events carry load.

## Spec deltas

C1 through C5 are additions the spec does not currently describe and need ADRs rather than silent
folding in:

- Motion-field as a summing displacement bus (§9.1, §10).
- Kernel-owned persistence and composite feedback injection (§11).
- Binding modes: value, rate, impulse (§7.3).
- Structural grammar predicates over signal flow (§15).

D3 and D4 need no spec change. Those modes are already written and merely unimplemented.
