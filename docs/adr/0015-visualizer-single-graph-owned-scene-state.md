# 0015 — Complete scenes own one explicit recursive image state

- Status: Amended by [0016](./0016-visualizer-canonical-state-with-material-memory.md)
- Date: 2026-08-09
- Supersedes: [0013](./0013-visualizer-uniform-node-state.md)
- Rejects: [0014](./0014-visualizer-colour-passes-transform-state.md)
- Amends: [0010](./0010-visualizer-authored-scene-graphs.md)

## Context

The reported defects all appeared within five seconds of creating a fresh scene, before any mutation.
The initial graph was therefore the system under test. Sampling 800 fresh builds found that 176 of
777 compilable scenes had no image cycle, 388 had only a plugin self-loop, and 213 had a multi-node
cycle. In 655 scenes, at least one terminal material branch bypassed the recursive path. No ordinary
field-category output was connected to a source.

The compiler treated any historical edge as evidence of feedback, although the edge could close no
cycle that returned to the displayed image. The renderer then found unconsumed colour outputs and
presented them as implicit layers. A local plugin trail could therefore satisfy the grammar while the
actual screen was mostly fresh material drawn outside that trail.

ADR-0013 proposed uniform persistence for every node output. ADR-0014 implemented part of that idea by
giving ordinary colour producers hidden destination-buffer memory. Both multiply the number of image
states without defining which one is the scene. They cannot establish that the image shown at frame
five evolved from the image shown at frame one.

## Decision

A complete visualizer scene has exactly one recursive image state. It is ordinary graph structure:

```text
fresh material ────────────────┐
                               v
previous(SceneStateCombine) -> SceneHistoryWarp -> SceneStateCombine -> present
```

`SceneHistoryWarp` performs only spatial resampling. Its `source` input is the sole previous-frame
image read. `SceneStateCombine` performs only the state transition, taking transformed history and the
fully joined fresh-material graph. Its output is both the next state and the only presented resource.
The combine uses `max(history * survival, source * weight)`, which admits new material immediately,
keeps history bounded, and does not make brightness grow with frame rate.

`compileSceneGraph` enforces the complete-scene contract:

- exactly one temporal combine;
- exactly one previous-frame image edge, from the combine output into the history warp;
- a forward path from that warp back to the combine's history input;
- every non-derived terminal colour branch reaches the combine's fresh-material input;
- the combine output is the graph's present resource.

`compileGraph` remains the low-level compiler for fragments and incomplete editor drafts. Generated
scenes and authored playback use `compileSceneGraph`. The Lab may hold an invalid draft, but the
renderer keeps the last valid scene until the draft satisfies the complete-scene contract.

Ordinary colour plugins produce current-frame values. They clear sparse targets before drawing and do
not allocate retained image outputs, decay their own destinations, or read private image history.
Simulation state such as particles and reaction-diffusion remains local because it is typed data, not
a second representation of the displayed image.

Each compiled complete scene scopes its render resources by scene entropy. Incremental rebuilds keep
the namespace and may reuse instances. A genuinely new scene receives disjoint target keys, so its
state cannot alias an outgoing scene that is still rendering during a crossfade. The first frame of a
new namespace explicitly clears its historical slots.

## Consequences

The grammar's feedback count is no longer the correctness boundary. A historical label, a self-loop,
or an attenuating plugin does not satisfy the complete-scene compiler unless it participates in the
one displayed recurrence.

The renderer presents one active scene layer. Branch interaction happens inside the graph before the
state transition; the host compositor only grades that state and crossfades it against another
scene's state.

There is no multi-region state model. Adding independently recursive regions would require a separate
decision with ownership and presentation rules; this repair does not introduce that feature.

Captured generated scenes include the two derived state nodes and their historical edge. The editor
shows them as normal graph structure, and playback rejects captures that omit or bypass them.
