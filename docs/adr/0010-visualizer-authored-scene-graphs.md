# 0010 — Authored scene graphs bypass the scene grammar, never the graph compiler

- Status: Accepted
- Date: 2026-07-26

## Context

Every scene the visualizer renders comes from one producer. `assembleScene` picks plugins at random
under weights and grammar constraints, `wireScene` connects each input to the freshest compatible
output, `compileGraph` type-checks and orders the result, and `instantiate` creates the plugin
instances. Nothing else can put a graph on screen.

That is a poor position from which to find a bug. The scene under investigation was chosen by a die
roll, the scheduler mutates it while it is being watched, the quality ladder suppresses plugins out of
it as frame time moves, and a track change reseeds it entirely. Two of the structures deciding what
reaches the screen — the layer stack `buildLayers` derives from unconsumed colour outputs, and the
motion field `sumMotion` accumulates from every motion-typed resource — appear in no edge list, so the
graph as displayed is not the graph as executed. Narrowing a fault to one plugin means waiting for the
scheduler to produce a similar scene again.

The pieces for a second producer already exist and are already pure. `compileGraph` takes nodes,
edges, a present target, and asset bindings as plain data, and enforces port typing, required inputs,
undeclared cycles, resource assignment, and ping-pong allocation. `firstLightScene` is a hand-authored
graph in exactly that shape. `instantiate` reuses any instance whose id and definition are unchanged,
so a graph can be edited without resetting the simulations in it. What is missing is a document to
hold the graph and a path that reaches the compiler without passing through the scheduler.

Three properties of the generated path obstruct that document. Instance ids are positional
(`${definition.id}#${index}`), so inserting a node renumbers those after it and every instance is
recreated. Parameter overrides and distributed bindings are keyed by definition id, so two instances
of one plugin cannot hold different values. Compile failures reach `console.warn` and no further.

## Decision

An `AuthoredScene` document — a versioned, serializable record of nodes, edges, asset bindings,
per-node parameters, per-node bindings, and a present target — resolves to a `CompiledGraph` through
`compileGraph` and nothing else.

The scene grammar does not apply to it. Category ranges, `minimumSceneSize`,
`minimumMaterialBranches`, `maximumDominantPlugins`, contribution pruning, and the build-attempt
retry loop are all skipped: they exist to make random assembly coherent, and an authored graph is not
random. Everything `compileGraph` enforces continues to apply, because port typing, required inputs,
and undeclared cycles are correctness rather than taste, and a graph violating them cannot render.

Node ids belong to the document rather than to a position in a list. Parameters and bindings are keyed
by node id on both paths, generated and authored.

## Alternatives considered

- **A scheduler mode that accepts a fixed plugin list** — smallest change, and reuses the existing
  build path end to end. Rejected: the result still passes through the grammar, still auto-wires, and
  still assigns positional ids, so it can express "use these plugins" but not "connect this output to
  that input", which is the question a graph editor exists to answer.
- **Hand-coded fixture scenes in the `firstLightScene` style** — no new concepts, and the graphs are
  type-checked by the compiler at build time. Rejected: editing means a rebuild, there is no way to
  capture a scene the scheduler produced, and a fixture cannot be changed while watching it render.
- **Editing the live graph in place with no document** — avoids a serialization format entirely.
  Rejected: nothing can be saved, exported, replayed, or turned into a regression fixture, and a
  topology edit has to recompile regardless, so the document is doing no work it could avoid.

## Consequences

Two producers now emit a `CompiledGraph`, and both reach it through `compileGraph`, so the graph
invariants stay enforced in one place rather than in two.

A scene the scheduler generated can be captured into a document, frozen, edited a node at a time, and
exported. A fault found by watching becomes an artifact that reproduces without the die roll, and the
same document pastes into a test.

Incoherent scenes become expressible on purpose. A single source with no compositor, or nine symmetry
transforms in a row, will render — that is the point, and it means the editor can produce output the
grammar exists to prevent. Generated scenes are unaffected.

Keying parameters and bindings by node id corrects a defect on the generated path as well: two
instances of one plugin previously shared one set of bindings and one set of theme overrides, so the
scheduler could not tune them apart and reactivity distribution treated them as one plugin.

A committed document names plugin ids, and a plugin id can change. Resolution reports an unresolvable
node as a problem against that node rather than failing the whole document, so a stale document opens
with a gap in it instead of an error.
