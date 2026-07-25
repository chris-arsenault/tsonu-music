# 0002 — WebGL2 with float render targets is the visualizer floor, on raw GL

- Status: Accepted
- Date: 2026-07-25

## Context

The visualizer requires persistent simulator state (particles, reaction-diffusion, wave fields),
recursive feedback pipelines, and typed intermediate resources passed between plugins. All of
those rest on rendering into floating-point textures and ping-ponging between them, which needs
WebGL2 plus `EXT_color_buffer_float`. The specification names only "WebGL" and lists
"unsupported texture format" as a failure mode, leaving the floor unstated.

The rendering layer also needs a host. The kernel already owns a typed render graph, resource
lifetimes, layer composition, and pass scheduling, so a library owning those same concerns
duplicates rather than serves it. The surface is a music-streaming page where bundle weight is
paid by every listener.

## Decision

WebGL2 with `EXT_color_buffer_float` is a hard requirement, probed at activation; below it the
visualizer reports unavailable and the fallback hierarchy takes over. The rendering layer is raw
WebGL2 behind a small in-repo helper covering program caching, a framebuffer pool,
fullscreen-quad passes, and capability probing.

## Alternatives considered

- **three.js** — supplies glTF loading, depth targets, and camera rigs, making the parallax and
  raymarch sources cheap. Costs roughly 150KB gzipped on the player page, and its scene,
  material, and render-target model overlaps what the render graph already owns, so the two
  abstractions must be reconciled at every plugin boundary. Rejected for the initial scope; a 3D
  source may carry it inside its own dynamically imported chunk.
- **twgl or regl** — smaller than three.js and removes real boilerplate. Still introduces a
  command and state model competing with the kernel's graph for ownership of pass ordering and
  resource binding. Rejected as duplicated abstraction for modest savings.
- **WebGL1 with half-float extensions as a lower tier** — widens reach, but every simulator and
  feedback plugin needs a second code path, roughly doubling the catalog's shader surface to
  serve browsers that are already rare. Rejected.
- **WebGPU** — better compute story for the simulators and no extension dance for float targets.
  Availability across target browsers remains narrower than WebGL2, so WebGL2 would still be
  needed as a fallback, meaning two full backends. Recorded in `docs/backlog.md`.

## Consequences

The device helper stays small enough to read in one sitting and the visualizer adds no runtime
dependency, so the lazily loaded chunk carries only first-party code. Every GPU capability
question resolves to one probe at activation rather than per-plugin feature tests.

Plugins are written against a thin abstraction rather than a mature engine, so geometry handling,
camera math, and any model loading are first-party work. The secondary-scope 3D sources carry the
largest share of that cost.
