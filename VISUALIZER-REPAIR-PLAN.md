# Visualizer repair plan

Works through every item in `docs/visualizer-audit-2026-07.md`. Each numbered
step is one commit. Audit item references are in brackets.

The ordering is by dependency, not by severity: the feature pipeline is repaired
before anything that consumes it, because several downstream items can only be
judged once their inputs have a usable range.

| # | Step | Audit items | Status |
| --- | --- | --- | --- |
| 1 | Feature normalisation and band boundaries | 1.2, 2.11 | done |
| 2 | Binding input ranges and level/excitation compatibility | 1.2, 1.10 | done |
| 3 | Beat events, beat phase, and transient reachability | 1.1, S3 channels | done |
| 4 | Modulation depth as a fraction of headroom | 1.7 | done |
| 5 | Frame delta: kernel authority and clamping | 2.1, 2.2 | done |
| 6 | Quality ladder recovery | 1.6 | done |
| 7 | Particle lifetime, respawn, and emitters | 1.4 | done |
| 8 | Particle legibility: seeding, size, trails, seam | 1.5, 1.12 | done |
| 9 | Simulator/renderer wiring requirements | 2.6 | done |
| 10 | Composition reach: branch count, spectrum gain, injection | 1.8, 1.3, 1.11 | done |
| 11 | Sampler binding correctness | 1.9, 2.5, 2.13, 2.14 | done |
| 12 | Lifecycle: accumulation clear, context loss, activation, retirement | 2.3, 2.4, 2.7, 2.8 | done |
| 13 | Colour: accent assignment and policy strength | 2.10, 2.9 | done |
| 14 | Crossfades | 2.12 | done |
| 15 | Duplicated and discarded work | 2.15 | done |
| 16 | Severity-3 sweep | S3 | done |

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

## Measurements

Channel medians before and after step 1, over twenty-four seconds of a pink bed
with a kick every half second and a hat every eighth, run through the real
`core/` code:

| channel | p50 before | p50 after |
| --- | --- | --- |
| `treble` | 0.0002 | 0.638 |
| `highMid` | 0.0016 | 0.392 |
| `mid` | 0.0081 | 0.204 |
| `lowMid` | 0.038 | 0.138 |

## Severity-3 items, revisited 2026-08-08

Four of these were reasons rather than justifications, and the difference was
pointed out twice before it landed. Each is now either fixed or has a reason that
survives being read back. Deferring an item is fine; recording the deferral in a
file instead of saying it out loud is what made this a pattern.

**Fixed — `smoothstep` with inverted edges in `mask-fields.ts`.** The reason given
was that every mainstream driver implements the intended inversion and that
changing it without hardware to test on would trade a working behaviour for a
guess. Wrong twice. Undefined behaviour is not a working behaviour, and there was
no guess available to make: `smoothstep`'s curve is symmetric about its midpoint,
so `1 - smoothstep(-e, e, x)` is exactly equal to `smoothstep(e, -e, x)` wherever
the latter is defined. Both call sites now share one `fallingRamp` helper, which
also floors the width, since `edge0 == edge1` is undefined too and a softness of
zero is reachable. A contract test rejects the reversed form.

**Fixed — `totalImpactEnergy` and `packImpacts` have no non-test caller.** The
reason given was that deleting a correct, tested helper is a different judgement
from deleting a wrong one. It is, and that is an argument against deleting
carelessly rather than for keeping something indefinitely. Both are gone, with
their tests. Tests around code nothing calls are worse than the dead code alone,
because they make it read as supported to whoever asks next what the impact bus
does. Recoverable from git if a consumer appears.

**Fixed — `estimatedTextureBytes` overstating half-resolution fields.** The reason
given was that it is a diagnostics figure with no effect on rendering. True, and
a memory readout that is wrong by the share of a scene that is not colour is worth
less than no readout. It now sums the targets `planTargets` actually allocates, so
there is one implementation of the sizing rather than an approximation beside it.

**Fixed — `frameParity` advancing on frozen frames.** Recorded as resolved by
step 9 and left in the open list.

**Still open — `uResolution` declared and unused in 24 shader blocks.** Measured
across nine files. Genuinely cosmetic: GLSL strips an unused uniform, and
`setUniforms` no-ops on a location that does not exist. Removing the declarations
is 24 edits for no change in any pixel, which is the one case here where the cost
is real and the benefit is not.

**Still open — `presentSingle` leaving stale ramp uniforms.** Gated out by
`uChromatic: 0`, and that gate is what the diagnostics path depends on for a raw
view. No pixel differs either way.

**Still open — channels with no consumer**: `leftLevel`, `rightLevel`,
`beatConfidence`, `sectionChange`. Three are the raw material `stereoBalance` and
the beat path are derived from, so they are producer-side and cheap.
`sectionChange` is declared on the event bus and never emitted — checked, and it is
not in the bindable feature list, so no binding can be distributed onto a channel
that is always empty. It is an unimplemented feature rather than a dead binding.

## The original list, as written

**`frameParity` advancing on frozen frames.** The exposure was a ping-pong
producer being skipped while its consumers kept alternating slots at refresh
rate. Step 9 removes the case that produced it: a skipped producer now strands
its consumers, so they are skipped with it. Advancing parity on a frozen frame is
otherwise harmless, since a frozen frame still executes its passes with a zero
delta.

**`totalImpactEnergy` and `packImpacts` have no non-test caller.** Both are
plausible pieces of an impact-uniform path that a plugin could want, and both are
tested. Deleting a correct, tested helper on the grounds that nothing calls it yet
is a different judgement from deleting a duplicated constant that disagreed with
its twin. Left, and recorded here so they are not mistaken for live code.

**`presentSingle` leaving stale ramp uniforms.** Gated out by `uChromatic: 0`, and
that gate is the thing the diagnostics path depends on for a raw view. Fixing the
staleness would not change any pixel.

**`uResolution` declared and unused in about fifteen shader bodies.** Cosmetic.

**`smoothstep` with inverted edges in `mask-fields.ts`.** Formally unspecified in
GLSL ES 3.00 but implemented as the intended inversion on every mainstream
driver, and the audit could not test real hardware. Changing it on that basis
risks trading a working behaviour for a guess.

**`estimatedTextureBytes` overstating half-resolution fields.** A diagnostics
figure with no effect on rendering.

**Channels with no consumer** — `leftLevel`, `rightLevel`, `beatConfidence`,
`sectionChange`. These are producer-side and cheap, and three of the four are the
raw material for `stereoBalance` and the beat path. `sectionChange` is declared
and never emitted, which is honest about a feature that is not implemented rather
than wrong.

## Considered and not changed

**No `inputRange` was added to any binding.** The audit is right that no binding
sets one, but the reason every consumer sat at its floor was a producer that
emitted four channels in the bottom one percent of their nominal range. With that
fixed the ranges are usable, and adding per-binding input ranges on top would be
tuning against a distribution nobody has measured per parameter — the kind of
constant that silently goes stale. Revisit if a specific binding is shown to need
one.

**`EXCITATION_HEADROOM` was left at 2.** Excitation channels still read as gates
(median 0.000, 95th percentile 1.000) because two deviations above the running
mean is exceeded by any percussive hit. That is what an excitation channel is
for, and step 2 makes it safe by ensuring only bindings authored against one ever
receive one. Softening it would blur the event detection that `detail` and
`burst` depend on.

**Audit item 1.11, the two to four percent injection rate, was left alone.** The
particle layer inspected on its own has a mean luminance of 174 of 255 and
ninety percent coverage, and reaches the accumulation attenuated thirty to forty
times between transients. That is a persistence setting, and persistence
settings are explicitly out of scope for this pass at the user's direction. The
figure is recorded here so it is not mistaken for something nobody noticed.

**`CENTROID_CEILING_HZ` at 8000 saturates on bright material** — measured median
0.999 on the hat-heavy surrogate above. The surrogate is brighter than real
music, so this is not yet evidence of a defect; noted for the empirical pass in
step 10.

## Deferred

Nothing. Items judged not worth changing are recorded above with the reason,
rather than dropped silently.
