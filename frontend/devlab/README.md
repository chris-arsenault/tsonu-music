# Visualizer lab

Checked-in development harness for looking at and editing the visualizer. It is never deployed with
the public site. Only `devlab/audio/` is gitignored because its music is local test material.

```bash
cd frontend && pnpm dev:visualizer
```

Serves on <http://127.0.0.1:26010> — the 26xxx range Sulion exposes, one along from
`catalyst-castellum` on 26007.

Click **Start** to create the audio context and run the kernel. The scene graph editor then opens
below the canvas. Its **Editor** button hides or restores the dock without losing the document being
edited.

The editor exists only here. The public `VisualizerPanel` does not import it, expose an editor button,
or respond to a debug query parameter.

## What it bypasses

The real surface reaches the kernel through the playback engine, an HLS switch, a React modal, and
the availability gate. This drives `startKernel` against a plain `<audio>` element instead, so a
constant can be changed and the page reloaded without any of that in the way.

Masks are served from the app's own `frontend/public/masks`, so mask-derived plugins are eligible
exactly as they are in the player. **Artwork** substitutes a mask PNG for a cover, which is what makes
the image-dream family reachable here.

## Audio

`audio/*.ogg` are the five mood beds from `../catalyst-castellum`, with their stems mixed down.
Regenerate with `bash ./sync-audio.sh`.

The stems are mixed rather than used individually on purpose: a single `pulse` or `noise` layer
occupies one part of the spectrum, so it exercises one band and leaves the rest of the feature bus at
zero. Mixed, each bed carries bass, midrange, and treble together, which is what the band levels and
excitation channels are built to separate.

## Reading the panel

- **persistence** and **drag** are what `core/persistence.ts` decided for this scene. A washed-out
  frame with high persistence is a different bug from one with low persistence.
- **level** meters against **excite** meters: a level bar pinned near full while its excitation bar
  stays near zero is the band-normalization failure that made the picture unresponsive.
- **branches** below two means the scene is not compositing anything, whatever it looks like.
