# Backlog

Planned-but-not-built work. Each item is a positive assertion of future-state behavior.

## Visualizer sources

- Add a depth-parallax source that renders an image plus depth map with drift, orbit, push-pull,
  pan, and roll camera modes.
- Add a GLB parallax source that renders a simple 3D model into color and depth textures, mapping
  bass to depth movement, midrange to rotation, treble to emissive response, and onsets to camera
  impulse.
- Add a point-cloud source generating point representations from artwork, depth images, model
  vertices, masks, or procedural fields.
- Add a wireframe geometry source covering polygon tunnels, grid landscapes, polyhedra, spherical
  grids, audio-deformed meshes, and contour surfaces.
- Add a fractal flame source over iterated nonlinear transforms.
- Add an escape-time fractal source covering Mandelbrot, Julia, Burning Ship, Newton basins, and
  orbit traps.
- Add a raymarched SDF source for procedural 3D scenes.

## Visualizer simulation

- Add a boid swarm simulator with separation, alignment, cohesion, obstacle avoidance, and
  attractor following.
- Add a spring mesh simulator producing webs, membranes, constellations, and elastic image meshes.
- Add a fluid advection simulator over a reduced-resolution dye and velocity field.
- Add a physarum trail simulator whose agents deposit and follow a diffusing field.
- Add a particle life simulator with multiple classes and inter-class attraction relationships.
- Add a cellular field simulator covering Conway-like, cyclic, excitable-media, and continuous
  growth behavior.

## Visualizer transforms and fields

- Add a temporal transform maintaining bounded frame history for echo, slit scan, time slices,
  directional smear, and delayed mirror modes.
- Add an optical flow field estimating motion between successive textures for particle advection
  and feedback dragging.
- Add a model depth field supplying depth-based force, collision, and occlusion from a 3D source.
- Add volumetric rendering.

## Visualizer scene structure

- Verify on real hardware that the composite stage renders what `core/persistence.ts` computes. The
  recurrence is unit-tested against a grid in the Node environment; that the GPU path is wired to the
  same numbers is not observable there.
- Normalize selection weight across a plugin family's variants, so a long mode list buys coverage
  rather than influence. Activation weight is per variant, so a family's effect on selection is its
  weight times how many modes it happens to have: `MaskRouter` at weight one across nine modes
  outweighs `FlowFieldCompositor`'s deliberate five, and `LayerMixer` and `ColorTransform` are
  distorted the same way.
- Decide what a family's feedback-loop minimum should count. `minimumFeedbackLoops` and
  `requireSpatialLoop` are checked against every image loop in the finished scene, and the canonical
  image state supplies a displacing loop unconditionally (ADR-0016), so both are satisfied before
  the check runs — measured over 318 builds, the smallest image-loop count was two. Counting
  material loops instead would make the flags a statement about the scene's own memory, matching
  `maximumFeedbackLoops`, and would reject the 42% of scenes that currently keep none.
- Stop the scene state filtering its own contents away. Every pass through the loop resamples the
  state with bilinear filtering, and the canonical chain resamples twice per frame with the trail
  transports adding more; material then survives ten to twenty-five seconds, so a picture is
  filtered several hundred times before it decays. Measured on a grid with no decay and no fresh
  material, a drift at 0.43 frame-widths per second leaves 2.8% of its detail after one second and
  0.1% after two. Rendered scenes show the consequence directly: with memory blanked they are sharp
  and saturated, and with the loop running the same scenes are featureless grey. This is why every
  attempt to raise the warp speed produced fog and every attempt to reduce it produced a still
  picture — the trade being made was against filtering, not against smear length. Candidate
  repairs, in order of how much they promise: compose the canonical chain's transforms and resample
  once instead of once per stage; snap a translation's per-frame offset to whole texels, which makes
  bilinear sampling exact and held 85.7% of detail at one second against 2.8%; bound how long
  material stays in the loop by how long it stays sharp; sharpen inside the loop, which helps but
  needs a stability bound.

## Visualizer analysis

- Detect section changes and publish them on the feature bus `sectionChange` channel, so the
  scheduler can drive branch mutation from musical structure.

## Visualizer tooling

- Draw a live thumbnail of each node's output in the scene graph editor, refreshed on a budgeted
  rotation, so an empty branch is visible without inspecting nodes one at a time. See
  [ADR-0010](./adr/0010-visualizer-authored-scene-graphs.md).
- Add a bypass state to the editor distinct from mute, passing a node's input through to the output
  of matching type so a stage can be removed from the chain without breaking what follows it.
- Let curated scene documents ship in the catalog and be selected alongside generated scenes, giving
  hand-tuned compositions to tracks that deserve them. See
  [ADR-0010](./adr/0010-visualizer-authored-scene-graphs.md).
- Compare two captured scene documents in the editor, highlighting the nodes, edges, parameters, and
  bindings that differ, so a working scene and a broken one can be diffed directly.
- Group nodes into named, collapsible regions in the editor, so a large graph can be read by branch.

## Visualizer platform reach

- Evaluate future desktop Safari support by probing analysis on a throwaway hidden audio element
  with its own context and a silent gain stage, caching the verdict by user-agent version. The
  production player remains native-only on Safari unless that work proves the tap safe. See
  [ADR-0001](./adr/0001-visualizer-audio-tap-policy.md).
- Move visualizer rendering to an `OffscreenCanvas` in a worker so main-thread contention cannot
  reach the HLS buffer-append path. See
  [ADR-0004](./adr/0004-visualizer-playback-supremacy.md).
- Add a WebGPU backend for the simulator plugins, keeping WebGL2 as the fallback. See
  [ADR-0002](./adr/0002-visualizer-webgl2-floor.md).
- Add headless-browser tests with a real GL context to cover shader output and resource lifetime,
  which is the remaining section 26 criterion that automated tests cannot reach.
  See [ADR-0003](./adr/0003-visualizer-pure-core-thin-shell.md).
- Measure perceived beat synchronisation against played audio and tune onset sensitivity, beat
  confidence thresholds, and envelope defaults from what is heard.
- Serve the mask library from the media CDN with a publish path once it outgrows the frontend
  bundle. See [ADR-0005](./adr/0005-visualizer-mask-assets.md).
- Add a MilkDrop and projectM compatibility adapter over the plugin contract.

## Frontend platform

- Bundle Tailwind through the Vite build, or replace its remaining usage with the project's own
  CSS, so `frontend/index.html` no longer loads it from a CDN.
