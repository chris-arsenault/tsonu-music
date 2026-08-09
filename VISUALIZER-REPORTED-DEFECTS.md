# Visualizer — defects reported from watching it

Observations made while running the visualizer, recorded as stated. Quotes are verbatim.
No analysis, no proposed causes, no status.

## Motion over time

The visuals respond to the music instant by instant and do not develop.

> "they all have in the moemnt music responses, but none of them have milk drop like motion. they
> arn't ugly per se, just mid length temporaly static"

> "there is still no mid term anything"

> "there is nothing really approaching the milkdrop or g-force warping and transition"

> "5 has some motion but there's no warp effects"

Motion that does occur repeats rather than accumulating.

> "what's happening nearly all the time now is that the visuals that exhib motion do so with
> perodicity instead of additive chaos"

The expectation being measured against:

> "my expectation is that for a graph that has had no changes, seconds 1 and 5 look very diffrent
> because of historical effects"

Movement is cancelled as fast as it is applied.

> "it feels like every translation or zoom is immidiatly met with the exact inverse. so the image
> bumps to the beat, but it never goes anywhere because it's always draw image, draw image with
> +treble padding, draw image. the paramaters are always being treated as absolute rendering,
> there's never any drift"

Stated as an invariant the pipeline should hold:

> "we should not be redrawing the frame. we should only be applying tgransforms to an existing
> image. this should be a catagorically true invariaent"

## Layers not interacting

Elements share a frame without affecting one another.

> "it feel slik emost of the layers don't interact and there is little if any feedback"

> "these two layers are not interacting at all"

A spectrum source in a scene sits on top of it and does nothing.

> "the biggest tell that something is broken is anything there is a spectrum source it just blast the
> lines across the screen - no retion no warping, it just looks like very thin spectrogram playing
> behind the image"

> "the spectrograph just overlaying and doing nothing"

> "this scene paste blow doesn't do anything except disaply the spectrograph in a circle"

## No persistence

Nothing is retained between frames.

> "if you removed the tree, it would just be a shitty, janky, spectrogram. there is no memory or
> persitance. no smoothing, no color shifting.. no nothing."

## Degenerate output

Scenes that reduce to a single dominating element, a single hue, or nothing at all. Reported against
specific captured scene graphs.

> "this is just a mono-hue strobe light"

> "this one goes to only black within half a second"

> "this scene is dominated by a pulsating checkerboard"

> "still a pulsating hue"

> "just a signal trace against a stencil, no movement"

> "7 has a more intresting center, but is dominated by a static outside"

## Assets

> "right now, the only stencile is ever the tree of life. the album artwork never shows up."

## Colour

Reported as no longer a problem:

> "the color palettes look substnatially better. that has been fixed. the motion items have not been"

## Working method

Defects surfaced during work but not acted on.

> "i saw in there that you logged known defects multiple times without reporting them or fixing them"

> "you keep on highlighting deficicencesi and when i ask you to fix them you patch one or two
> paramters and then call it a day"

> "you've reported 45 of 46 colour sources for the last 10 or so turns and have not done anything
> about it despite my instgrtuctions to fix fundemental issues"

Symptom-level repair rather than corrected design.

> "it sounds like your trying to patch it instead of design the correct version"

> "i feel like you are patching this specific problem istnead of using it as an example to trace the
> foundational bugs"

Assumptions held as fixed that were not examined.

> "you seem to be taking long memory saturating to white as an invarient. have you ever looked at the
> composition code and debugged it or suggested alternatives? it feels like youve locked yourself
> into a pure adaitive model"

Direction given and not followed.

> "i though i instructed you to get rid of the kernel accumulator"

Evidence to be taken from rendered output rather than from reading the graph.

> "you need to use the render harneess or something to measure some scenes over time and look at
> their graphical output"

## The theme

Stated directly:

> "the reason i'm pointing out these defects is because the problem with motion is almost certainly
> structural bugs. not just algorithmic tweaks. i'm trying to get you to review and look at the
> problem in a diffrent way so that you can uncover it. your bias is to assume the code you write is
> error free, and it never actually is."

The individual reports above are treated as instances of the same underlying fault rather than as
separate items to be addressed one at a time. Each specific scene was supplied as an example to be
traced back to a structural cause, not as a case to be corrected in isolation.
