# Visualizer core

Pure decision logic. No DOM, no `AudioContext`, no WebGL, no host globals — every module here
takes plain data and returns plain data, and is unit-tested by `make ci` in the Node environment.

Contents:

- **Playback clock** — state machine over media events producing playback-authoritative time,
  playback state, and the generation counter; owns freeze semantics for pause, stall, seek, and
  track change.
- **Audio features** — band aggregation, normalization, spectral flux and onset detection over
  supplied sample buffers, beat tracking, beat-phase envelope shapes, and parameter-binding
  evaluation with attack, release, curve, range, and polarity.
- **Render graph** — port typing, connection validation, topological compilation, feedback-cycle
  legality, and intermediate-resource lifetime analysis.
- **Scheduler** — scene grammar constraints, character-based scene assembly, activation rules and
  cooldowns, the mutation model, deactivation policies, and fresh random scene selection.
- **Performance** — the quality profile and downgrade ladder as a function of frame-time statistics,
  buffer health, and the current profile.
- **Authored scenes** — the scene document, its resolution through the render graph compiler alone,
  the edit operations and their history, capture from a generated scene, graph layout, the editor's
  view of what runs, and reading and writing documents as text. See
  [ADR-0010](../../../../docs/adr/0010-visualizer-authored-scene-graphs.md).
