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

## Visualizer analysis

- Detect section changes and publish them on the feature bus `sectionChange` channel, so the
  scheduler can drive branch mutation from musical structure.

## Visualizer platform reach

- Recover desktop Safari by probing analysis on a throwaway hidden audio element with its own
  context and a silent gain stage, caching the verdict by user-agent version. See
  [ADR-0001](./adr/0001-visualizer-audio-tap-policy.md).
- Move visualizer rendering to an `OffscreenCanvas` in a worker so main-thread contention cannot
  reach the HLS buffer-append path. See
  [ADR-0004](./adr/0004-visualizer-playback-supremacy.md).
- Add a WebGPU backend for the simulator plugins, keeping WebGL2 as the fallback. See
  [ADR-0002](./adr/0002-visualizer-webgl2-floor.md).
- Add headless-browser tests with a real GL context to cover shader output and resource lifetime.
  See [ADR-0003](./adr/0003-visualizer-pure-core-thin-shell.md).
- Serve the mask library from the media CDN with a publish path once it outgrows the frontend
  bundle. See [ADR-0005](./adr/0005-visualizer-mask-assets.md).
- Add a MilkDrop and projectM compatibility adapter over the plugin contract.

## Frontend platform

- Bundle Tailwind through the Vite build, or replace its remaining usage with the project's own
  CSS, so `frontend/index.html` no longer loads it from a CDN.
- Reduce `CLAUDE.md` to an `@AGENTS.md` import plus Claude-Code-specific overrides.
