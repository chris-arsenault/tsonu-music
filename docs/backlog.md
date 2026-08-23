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
- Let dense particle piles settle. The CPU solver converges, but the broadphase grid stores one list
  per cell sized to a single diameter, so a deep pile needs more relaxation passes than a frame
  affords. Only worth doing if piles become a visual goal.

## Visualizer transforms and fields

- Add an optical flow field estimating motion between successive textures for particle advection
  and feedback dragging.
- Add a model depth field supplying depth-based force, collision, and occlusion from a 3D source.
- Add volumetric rendering.

## Visualizer scene structure

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
- Recover the structure the remaining five scenes in sixteen lose. Measured against each scene's own
  memory-blanked render, the median scene keeps 98% of its material's structure and these keep 31%
  to 47%. Three of the five carry a `GlowAndScatter` bloom and three carry a `TemporalTransform`
  trail, both of which are on the smoothing lint's list with line numbers. Making the trails
  accumulate rather than dilate was measured and did not pay: it gained twelve points on two scenes
  and lost thirteen on another.
- Compose the canonical chain's two transports into one pass. Each stage resamples, so a chain of
  two costs twice the sampling of one for a composition that is the same either way — two geometric
  transforms compose analytically, and the chain exists so the motion has no simple closed orbit
  rather than because it needs two passes.
- Ask whether a scene is any good, not only whether it is legal. `buildFirstViableScene` returns the
  first candidate satisfying the grammar and discards up to thirty-one others unexamined. Bound
  parameter count, expression diversity, `peakConcentration`, `materialBranchCount`, chain depth,
  structural-edge count, and the structure a scene keeps are all measurable now; branch contrast is
  reachable through `SelectionCharacter`, and focal structure through whether exactly one plugin is
  `dominance: 'primary'`.
- Decide whether a family may exempt itself from motion. `GEOMETRIC_SIGNAL` sets
  `requireSpatialLoop: false` and `requireMotionSource: false`, citing the specification's
  "restrained feedback" for that family, and it is a quarter of the rotation.
- Connect a spatial field the grammar asked for. `collision-energy` with masks loaded fails on
  roughly one seed in twenty because all thirty-two candidates leave their field unread, the prune
  removes it, and the field count then fails — a consumer is present in those candidates, so the gap
  is in wiring rather than selection, and a selection-side repair had no effect. Theme fallback
  covers it, so the cost is one family being unavailable for one entropy rather than a black frame.

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
