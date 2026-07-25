# 0003 — Visualizer decision logic lives in pure modules, host access in a logic-free shell

- Status: Accepted
- Date: 2026-07-25

## Context

`make ci` runs Vitest with no environment override, so the frontend test suite executes in Node.
Every existing test file is pure logic over plain data. There is no DOM, no `AudioContext`, and no
WebGL context available to any test the repository runs.

The visualizer's correctness requirements are concentrated in exactly the parts that need none of
those: the playback clock state machine and its freeze semantics across pause, stall, seek, and
track change; feature normalization, parameter binding curves, and beat-phase envelopes; port
typing, graph compilation, and feedback-cycle legality; scene grammar, character-based assembly,
activation rules, cooldowns, and mutation policy; and the quality downgrade ladder. Its
untestable parts — Web Audio wiring, GL device management, the frame loop — carry no decisions.

Left unstructured, these mix: a scheduler that reads GPU state directly, or a clock that consults
`requestAnimationFrame`, becomes unverifiable, and the requirements most likely to break silently
are precisely the ones about time and state transitions.

## Decision

All decision logic is written as pure modules over plain data with no host globals, covered by
Vitest in the Node environment. Web Audio, WebGL, and the frame loop live in a shell whose only
job is to gather host state into plain data, call the pure core, and apply the result.

## Alternatives considered

- **Add jsdom plus WebGL and Web Audio mocks** — allows testing the shell too, but mocks of a GL
  driver and an audio render thread assert against the mock's behavior rather than the browser's,
  giving confidence that does not transfer. Costs a dependency and a slower suite. Rejected.
- **Headless-browser tests via Playwright with a real GL context** — genuinely exercises shaders
  and the audio graph. Requires a browser in CI, meaningful runtime, and GPU behavior that varies
  by runner. Recorded in `docs/backlog.md` as the way to cover shader output once the catalog is
  stable; not a substitute for a testable core.
- **Accept low coverage and verify by eye in the browser** — cheapest, and adequate for visual
  taste, but the clock, grammar, and perf ladder are state machines whose bugs appear only in
  specific transition orders that manual play cannot reliably reach. Rejected.

## Consequences

The requirements that matter most are verifiable on every `make ci` run without a browser, and
regressions in freeze semantics or graph validity surface as failing unit tests rather than as
visual artifacts a reader might not notice.

Shader output, GL resource lifetime, and Web Audio wiring stay outside automated coverage and are
verified by hand against the diagnostics overlay. The shell must be kept genuinely thin for that
gap to stay small, which is a standing review obligation rather than something CI enforces.
