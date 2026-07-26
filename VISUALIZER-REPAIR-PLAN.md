# Visualizer repair plan

Works through every item in `docs/visualizer-audit-2026-07.md`. Each numbered
step is one commit. Audit item references are in brackets.

The ordering is by dependency, not by severity: the feature pipeline is repaired
before anything that consumes it, because several downstream items can only be
judged once their inputs have a usable range.

| # | Step | Audit items | Status |
| --- | --- | --- | --- |
| 1 | Feature normalisation and band boundaries | 1.2, 2.11 | pending |
| 2 | Binding input ranges and level/excitation compatibility | 1.2, 1.10 | pending |
| 3 | Beat events, beat phase, and transient reachability | 1.1, S3 channels | pending |
| 4 | Modulation depth as a fraction of headroom | 1.7 | pending |
| 5 | Frame delta: kernel authority and clamping | 2.1, 2.2 | pending |
| 6 | Quality ladder recovery | 1.6 | pending |
| 7 | Particle lifetime, respawn, and emitters | 1.4 | pending |
| 8 | Particle legibility: seeding, size, trails, seam | 1.5, 1.12 | pending |
| 9 | Simulator/renderer wiring requirements | 2.6 | pending |
| 10 | Composition reach: branch count, spectrum gain, injection | 1.8, 1.3, 1.11 | pending |
| 11 | Sampler binding correctness | 1.9, 2.5, 2.13, 2.14 | pending |
| 12 | Lifecycle: accumulation clear, context loss, activation, retirement | 2.3, 2.4, 2.7, 2.8 | pending |
| 13 | Colour: accent assignment and policy strength | 2.10, 2.9 | pending |
| 14 | Crossfades | 2.12 | pending |
| 15 | Duplicated and discarded work | 2.15 | pending |
| 16 | Severity-3 sweep | S3 | pending |

## Principles for this pass

**Fix the cause, not the reading.** Several items are a wrong number that could
be made right by adjusting a constant — the spectrum gain, the band ceilings.
Where the number is wrong because the quantity feeding it is wrong, the quantity
gets fixed. A gain of 400 papering over a mean-per-bin normalisation error is the
kind of repair that fails again the next time the FFT size changes.

**A channel's realistic range is part of its contract.** The audit's central
finding is that four of six band channels sit in the bottom 1% of a nominal
`[0,1]`, so every consumer is pinned at its floor. Normalising per band fixes the
producer; declaring `inputRange` at each binding is what makes a consumer robust
to the next producer change. Both, not either.

**Verify by measurement.** Every severity-1 item was established with numbers.
Each fix is checked the same way — against the `devlab` harness where the effect
is visual, against the pure `core/` functions where it is not. A fix that only
looks correct is what produced this audit.

## Deferred

Nothing. Items judged not worth changing are recorded in place with the reason,
rather than dropped silently.
