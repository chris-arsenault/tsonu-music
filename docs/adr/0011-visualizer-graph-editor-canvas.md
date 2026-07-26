# 0011 — The graph editor canvas is React Flow, mounted only by the Visualizer Lab

- Status: Accepted
- Date: 2026-07-26

## Context

The scene graph editor described in [ADR-0010](0010-visualizer-authored-scene-graphs.md) needs a
node canvas: pan, zoom, marquee selection, sockets, dragged links with type-aware validation, and
node bodies dense enough to hold a plugin's parameters. It follows ComfyUI conventions, so the
interaction vocabulary is fixed in advance rather than open to design.

Three properties of this repository bear on the choice. The Vite build publishes a single stylesheet
(`cssCodeSplit: false`) because the `website` Terraform module is configured with one `ENTRY_CSS`
value, so a dependency's stylesheet imported normally joins the bundle every visitor downloads. The
frontend test environment has no jsdom — React components are verified with `renderToStaticMarkup` in
the Node environment — so anything requiring a live DOM, `ResizeObserver`, or layout measurement
cannot be covered by the existing test style. And the visualizer is a dynamic chunk that costs a
listener nothing until they open it, a property the editor must not spend.

The editor is a development instrument. It is mounted by the checked-in `frontend/devlab` entry and
is never imported or exposed by the public player.

## Decision

`@xyflow/react` provides the canvas. The Lab imports the editor directly; the public
`VisualizerPanel` has no dependency edge to the editor or React Flow.

Its stylesheet is imported through Vite's `?inline` query and injected into a `<style>` element when
the editor mounts, so it stays out of the single entry stylesheet.

The library supplies the viewport, the selection model, and edge interaction. Node appearance, socket
typing, parameter widgets, and every edit operation are ours; `isValidConnection` delegates to
`portsCompatible`, the same function `compileGraph` validates with.

## Alternatives considered

- **A hand-rolled SVG canvas** — no dependency, complete control, and consistent with a visualizer
  that has taken on no UI libraries. Rejected: pan, zoom, hit-testing, marquee selection, and edge
  routing are roughly fifteen hundred lines carrying no domain value, and an instrument built to find
  bugs should not be the largest new source of them.
- **litegraph.js** — what ComfyUI itself runs on, so the conventions and the look come for free.
  Rejected: it is canvas-based and imperative, which means owning a second rendering surface and a
  manual bridge to React state, and the standalone package trails the fork ComfyUI maintains.

## Consequences

`@xyflow/react` is a runtime dependency rather than a development one because the Lab executes it in
the browser. The public Vite entry does not reach it, so it is absent from the deployed application
graph.

React Flow's own components cannot be rendered by `renderToStaticMarkup`, so node bodies are written
as presentational components that take plain props and render without a React Flow context. They are
covered by the existing test style; the canvas that hosts them is not, which is the same boundary
ADR-0003 already draws between decisions and the shell that applies them.

Connection validity has one definition. A link the canvas refuses to draw is a link `compileGraph`
would have rejected, because both call `portsCompatible`.

The single-stylesheet rule holds without exception, at the cost of the editor injecting its styles at
mount rather than having them present in the document from the start.
