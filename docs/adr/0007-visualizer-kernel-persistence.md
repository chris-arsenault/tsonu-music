# 0007 — The kernel owns an accumulation buffer rather than leaving persistence to plugins

- Status: Accepted
- Date: 2026-07-25

## Context

The visualizer shipped rendering static compositions. Scenes changed only where an individual
shader read `uTime`, which reads as small local animation over a still picture rather than as
material in motion.

The cause was structural. Specification section 11 assigns feedback injection to the compositor and
gives `VisualLayer` a `feedbackParticipation` weight; section 24 lists feedback buffers under
Foundation; all nine example compositions in section 25 contain a persistence stage. The
implementation instead made persistence one optional plugin among roughly a hundred and fifty, and
`SceneGrammar` capped feedback loops at one without ever requiring any. Random selection therefore
produced a scene with no frame-to-frame memory most of the time, and every such scene regenerated
itself from nothing on every frame.

Two further consequences followed from the same gap. `composeLayers` computed `feedbackContributors`
that nothing consumed, because the layer stack was drawn straight to the default framebuffer and
there was no buffer for feedback to be injected into. And the feedback plugins that did exist used
bare per-frame decay constants, so the same scene smeared differently at thirty, sixty, and a
hundred and forty-four frames a second.

Raising the odds of selecting a feedback plugin would have left the behaviour probabilistic. Making
persistence a property of the composite is what sections 11 and 24 already describe.

## Decision

The kernel owns an accumulation buffer. Each frame the layer stack composites into an offscreen
target; that composite is then screened onto the accumulation, which has first been dragged through
the scene's motion field and decayed.

How strongly a scene accumulates is decided in `core/persistence.ts` from the theme's declared
persistence character and from the per-layer `feedbackParticipation` weights section 11 already
defines — the strongest participating layer rather than the mean, so a plugin that means to persist
is not averaged away by the post-processing stages beside it. Survival is expressed per second and
raised to the frame's own delta, which makes trail length a duration rather than a frame count. The
same correction is applied to the existing feedback plugins through a centrally supplied `uDelta`.

Survival has a floor, so no scene is ever completely static. It has a ceiling, so the accumulation
cannot become a smear that never clears. With survival at zero the recurrence returns the composite
unchanged, so a non-accumulating scene behaves exactly as it did before the buffer existed.

`FeedbackFlowTransform`, `FeedbackInjector`, and `ParticleTrailInjector` keep their roles unchanged.
They now shape a loop that is guaranteed to exist rather than being the only thing that can create
one. `SceneGrammar` gains `minimumFeedbackLoops` so the three families section 15 describes with an
explicit feedback stage still get one on top of the kernel's floor.

The arithmetic lives in `core/persistence.ts` as plain functions over numbers, per
[ADR-0003](./0003-visualizer-pure-core-thin-shell.md). `host/composite-shaders.ts` mirrors it in
GLSL.

## Consequences

Every scene has a memory, and the accumulation is what reaches the screen. A displacement applied
once to freshly generated material is a distortion; the same displacement applied to what it
produced last frame, for hundreds of frames, is flow.

Persistence is now a property a theme and its plugins express through character rather than a
capability a particular plugin has to have been selected for. Themes state persistence already, so
the intent was recorded and simply unread.

Four kernel-owned targets exist outside the render graph and outside the plan's lifecycle. They are
declared live explicitly, because releasing them on a scene change would discard every trail in the
buffer.

The composite recurrence is unit-tested in the Node environment against a small grid, which is what
makes "the image does not move" observable to CI at all — no test could see it before. What that
cannot check is whether the GPU path is wired to the same numbers. That remains a real-device check,
recorded in [backlog.md](../backlog.md) alongside the three other criteria needing hardware.

A genuinely unchanging source under a genuinely unchanging field is a fixed-point iteration and
settles after some seconds. This is correct — the reference implementations behave the same way — but
it means the accumulation amplifies variation rather than manufacturing it, so the audio features
driving the scene have to actually vary for the picture to keep reorganizing.
