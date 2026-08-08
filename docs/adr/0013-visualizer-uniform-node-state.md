# 0013 — Every node output is state; blending is a node; the bound is global

- Status: Accepted
- Date: 2026-08-08
- Supersedes: [0007](./0007-visualizer-kernel-persistence.md)
- Amends: [0012](./0012-visualizer-historical-edges.md)

## Context

[ADR-0012](./0012-visualizer-historical-edges.md) made historical reads a property of edges and moved
displacement out of the kernel. It kept the kernel's accumulation buffer, on ADR-0007's argument that
memory has to be a guarantee rather than something selection might happen to provide.

Rendered, the result responds to the music frame by frame and does not compound. Scenes read as a
picture that pulses in place with a half-second lag. The cause is arithmetic, not tuning.

### The complement rule forbids accumulation

Both surviving accumulators — `PERSISTENCE_SHADER` and `FieldFeedbackTransform`, the latter closing
280 of 336 spatial loops in a 400-scene sample — combine history and source as a convex pair:

```glsl
out = past·s + incoming·(1 − s)
```

For a warp that displaces by `d` per frame, the steady state is

```
O(x) = (1 − s) · Σ sⁿ · S(x − n·d)
```

and the weights `(1−s)sⁿ` sum to exactly **1**. The image is `S` motion-blurred along the flow at
unchanged brightness. When the warp is small it converges to `S` in place. No sequence of frames
produces more than one copy of the source, which is the definition of not accumulating.

At the shipped default (`decay = 0.12/s`) that is a 0.47-second smear. The kernel then averages the
composite a second time over 0.26–0.72 s (`SURVIVAL_FLOOR`/`SURVIVAL_CEILING`) under the same rule
and **without displacing anything**, since ADR-0012 removed the drag and left the buffer. A
stationary average sits downstream of the one thing that moves.

### The rule exists because there is no global bound

ADR-0007 recorded the failure it was fixing: a screen-blended accumulation has no fixed point and
washed to white with a yellow cast within seconds on a real device. The complement is a correct fix
and an unnecessarily strong one. It makes every stage individually non-expansive, and non-expansive
is the formal statement of "cannot compound".

There are four local bounds doing this job — the kernel's complement, the plugin's complement,
`HISTORY_CEILING`'s clamp in `GLSL_HISTORY`, and `BLACK_FLOOR_PER_SECOND`'s subtraction — and one
global one that already exists and is not counted on: `METER_SHADER` measures average frame luminance
and `GRADE_SHADER` applies metered exposure with a knee roll-off and a final clamp. Compression is
already the last operation, after everything that can add light.

Two of the four are convex rules and are the actual defect. The other two are a saturation guard and a
floor, which bound a failure rather than forbidding accumulation, and the distinction matters below.

### And there are three state mechanisms with no model between them

`edge.feedback` plus `feedbackPort` makes one input historical. `clear: false` makes a pass
accumulate into its target. The kernel accumulator is a fourth buffer outside the graph. The
`previous`/`current` disambiguation defect fixed in `host/runtime.ts` was this ambiguity surfacing.

Images are values recomputed from a DAG each frame. Nothing in the model says an image is a state
that evolves; memory is a side effect of an edge attribute held by plugins that declared a specially
named port.

## Decision

### State is a uniform property of node outputs

Every node output persists across frames. Any edge may read a node's previous frame instead of its
current one. This is the default property of every buffer in the graph, not a privilege a plugin
declares.

`feedbackPort`, `deactivationPolicy: 'handoff-feedback'`, and the `SPATIAL_FEEDBACK` capability stop
gating where history may occur. `feedbackFrom` survives, unchanged in meaning: it names which output
a *self*-closing loop lands on when a plugin has several, which is a disambiguation and not a
permission.

Allocation stays derived. A resource gets its second slot when something reads it historically, which
`CompiledGraph.pingPong` already computes. Uniform semantics, unchanged VRAM.

### Blending is a node

`FieldFeedbackTransform` does three jobs in one fragment: read history, displace it, combine the
result with a source. Those are three nodes, and fusing them is why every loop-closing plugin had to
carry its own combine — and therefore had to be individually non-expansive.

Split, the loop is wired rather than hardcoded:

```
source ──────────────→ ┌───────┐
                       │ blend │ ──→ (terminal)
   ┌── advect ───────→ └───────┘
   └──── previous(blend) ←──────┘
```

The displacement is any transform in the catalog. The combine is a compositor with independent
`historyWeight` and `sourceWeight`, chosen by wiring from `add`, `over`, `max`, `screen`, and `lerp`.
MilkDrop's equation is one wiring of this rather than a mode inside a plugin.

### The bound is global, and the structural rule is loop gain

The four local bounds are removed. `GRADE_SHADER`'s metered exposure and knee are the compressor, as
they already are.

What replaces the complement rule is the weaker, true condition. A loop is stable when the product of
history weights around the cycle is below one — not when each blend is convex. At `sourceWeight = 1`
and `historyWeight = 0.95` the steady state is

```
O(x) = Σ (0.95)ⁿ · S(x − n·d)
```

with total mass `1/(1 − 0.95) = 20`. It converges, it is bounded, and unlike the convex case it
*accumulates*: twenty copies of the source laid along the flow path. That is the tunnel.

Loop gain is a number the wiring layer can check, so `attenuatesHistory` stops asking whether a
plugin carries the `feedback` capability and starts asking whether the cycle's gain is below one.
This is a precondition on wiring, checkable and checked — the shape ADR-0007 asked for, now applied to
the quantity that actually governs divergence.

What is removed is the *convex* rule specifically, not every constant. `GLSL_HISTORY` keeps its
per-second decay, because that decay is not a stage refusing to amplify — it is the loss that makes a
cycle converge, the number `gainParameter` names, and having it in one place is what keeps it
comparable between plugins. It keeps its ceiling too, raised from 8 to 256: the ceiling's job is to
stop a runaway short of `NaN`, and at 8 it had become an active constraint on the accumulation this
decision exists to allow.

Gains are per second throughout, raised to the frame's own delta. A survival of 0.4 per frame and 0.4
per second differ by a factor of forty in how long a loop remembers, and a check comparing both
against one would be right about stability and useless about anything else.

### The kernel accumulator is deleted

ADR-0007's guarantee is kept and its buffer is not. "Every scene has memory" is a statement about
graph structure, and the grammar already enforces it: `minimumFeedbackLoops ≥ 1` plus
`requireSpatialLoop`. A buffer outside the graph asserting the same thing is a second mechanism, and
since ADR-0012 removed its drag it has been a stationary temporal average applied after the moving
one.

Nothing in it is lost. `transientPunch` becomes an audio binding on a blend node's source weight,
where a hit arriving at full strength is a composition choice. `persistenceSettings`' derivation from
theme character and layer weights becomes parameter defaults on the same node. Both end up where a
scene can see them and an editor can change them.

The present path becomes: the graph's terminal resource → `METER_SHADER` → `GRADE_SHADER` → canvas.

## Consequences

**This is a real reduction in guarantees, and it is the point.** ADR-0007 could promise a fixed point
because the kernel owned the combine. ADR-0012 already gave that up for graph-closed loops and bounded
the failure instead. This finishes the move: no stage promises non-expansion, one stage promises
compression, and one structural check keeps loop gain below one. A wiring bug now shows as a bright
frame rather than a wrong one, which is a worse failure than ADR-0007's and the price of a system
where accumulation is expressible at all.

**The catalog shrinks where it was duplicating the kernel.** Nine `FeedbackFlowTransform` modes,
`FeedbackInjector`, and `ParticleTrailInjector` each carry a private combine. Those become
displacement-only transforms feeding shared blend nodes.

**Scene assembly gains another structural choice.** ADR-0012 added where a loop closes; this adds what
combines at the closure, and the second matters more. A loop through `add` and the same loop through
`lerp` are different visual systems built from identical plugins.

**Testability is unchanged.** Wiring, grammar, and scene building are graph-structure decisions and
stay pure. What becomes time-dependent is the rendered frame, which was never Node-testable. The loop
gain check is arithmetic over the graph, so the new invariant is testable where the old one was a
capability string.
