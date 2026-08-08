# Visualizer reactivity plan

Works through every item in `docs/visualizer-audit-2026-08.md`. Each numbered
step is one commit. Audit item references are in brackets.

The ordering is by dependency. The feature pipeline is repaired before anything
that consumes it, because the size of every downstream excursion is decided by
the distribution the channels present — and because the drift depths in step 3
cannot be judged until the audio has its real range back.

Steps 8 to 10 are held. They are mechanism design rather than repair, and each
has a decision in it that should be made deliberately rather than inside a fix.

| # | Step | Audit items | Status |
| --- | --- | --- | --- |
| 1 | Adaptive per-channel distribution mapping | R1 | done |
| 2 | Bipolar and saturating channels | R2 | done |
| 3 | Drift depth against the restored excursion | R3 | done |
| 4 | Particle bindings, and the contract guard re-armed | R4 | not started |
| 5 | Particle configuration nodes leave the field budget | R6 | not started |
| 6 | The mask-to-particle path, and the two red tests | R5 | not started |
| 7 | A palette reachable without album artwork | R8 (part) | not started |
| 8 | **[hold]** Accumulation transform | R9 | design first |
| 9 | **[hold]** `DomainWarpTransform` driver typing | R7 | design first |
| 10 | **[hold]** Scene selection fitness | R8 | design first |

## Principles for this pass

**Normalise at the producer, adaptively, not at the consumer against a
constant.** The obvious repair for R1 is to declare `inputRange` on every binding
from measured percentiles. It would work on the material it was measured against
and go stale on everything else — a quiet acoustic track and a loud mastered one
do not share a distribution, and neither shares one with the synthesised bed the
figures came from. A channel that reports where the current value sits within its
own recent behaviour needs no per-binding constant and cannot be over-fitted to a
sample.

**A channel's contract is its distribution, not its range.** `[0, 1]` was already
the stated contract and was already true; what was missing is that a consumer
mapping `[0, 1]` onto a working range needs the channel to *occupy* `[0, 1]`, not
merely to lie inside it. After step 1 the contract is: every continuous channel
is approximately uniform over `[0, 1]` across the recent listening window.

**Inter-band balance is preserved, not replaced.** The shared band ceiling exists
so that bass, midrange, and treble read differently from one another on the same
material, and step 1 must not undo it. The distribution stage is deliberately
slower than the ceiling and per-channel, so it corrects occupancy over tens of
seconds while short-term balance and dynamics still come from the stage beneath.

**Verify by measurement.** Each step is checked the same way the audit was: the
pure functions run in Node against a synthesised bed, and the figures go in the
Measurements section below. A step that only looks correct is what produced two
audits.

---

## Step 1 — Adaptive per-channel distribution mapping [R1]

A new pure reducer in `core/distribution.ts` maintains a decaying histogram per
channel and reports the empirical CDF of the current value. The output is uniform
over `[0, 1]` by construction, whatever scale or spread the input has.

- Window is long — tens of seconds — so a quiet verse still reads below a loud
  chorus. A short window would make every passage read full scale, which is the
  failure the shared band ceiling was written to avoid.
- A minimum spread guard degrades toward the identity when a channel genuinely
  does not vary, so a steady tone is not amplified into full-range noise.
- Warm-up blends from the identity as weight accumulates, so the first seconds of
  a session are not driven by three observations.
- Frozen-aware: a paused clock passes zero delta and the histogram neither decays
  nor accumulates.
- Applied to the level channels, `rms`, `peak`, `spectralFlux`, `transient`, and
  `spectralCentroid`. Not to the `*Excite` channels, which are gates by design
  and whose kind `distributeReactivity` already preserves; not to `beatPhase`,
  which is uniform by construction; not to `beatConfidence`.

## Step 2 — Bipolar and saturating channels [R2]

`stereoBalance` folds to `[0, 1]` before the distribution stage, so 0.5 is
centred and the negative half stops being clamped away. `spectralCentroid` loses
`CENTROID_CEILING_HZ` in favour of a wide logarithmic pre-map into `[0, 1]`
followed by the same distribution stage, so it cannot saturate.

The `lateral-force` role having exactly one admissible feature is left as it is
and recorded here: with `stereoBalance` alive the role works, but it has no
fallback, and a second lateral measure is worth having.

## Step 3 — Drift depth against the restored excursion [R3]

`ROLE_DYNAMICS` depths are re-measured and lowered against the excursion steps 1
and 2 give back. The target is a median audio share above 75 percent with no
parameter below 40 percent, measured the same three ways the audit measured it.

## Step 4 — Particle bindings, and the contract guard re-armed [R4]

Bindings are authored for every particle family, and `STATIC_FAMILIES` and
`CPU_VALUE_FAMILIES` come out of `shader-contract.test.ts` so the guard that
would have caught this works again.

Emission rate, speed, direction, spread, and body radius follow the music;
forces follow large-scale force; drag follows deformation; renderer brightness
follows the transient envelope. Emission rate rises far enough that the layer has
coverage: 144 bodies at 0.78 percent of the frame is not a layer.

## Step 5 — Particle configuration nodes leave the field budget [R6]

A plugin in the field category whose every output is a value port is a
configuration node, not a spatial field. It gets its own fill phase and its own
grammar range, so an emitter no longer spends the slot a vector field needs.
`isValuePortType` already names the ports, so the predicate is derived rather
than tabulated.

## Step 6 — The mask-to-particle path, and the two red tests [R5]

Section 26's collision row gets a passing expression again. The two failing
scenes are hand-authored and predate emitters being explicit; they gain one, and
the branch goes green.

## Step 7 — A palette reachable without album artwork [R8, part]

`PaletteMapper` is unreachable on any track with no artwork, which leaves the
kernel's per-branch ramp as the only colour in the scene. A palette producer that
needs no asset makes the stage selectable everywhere.

---

## Held for design

### Step 8 — Accumulation transform [R9]

The largest item, and the one that decides whether this reads as a Milkdrop-class
visualizer. The accumulation currently admits one transform: translation along a
motion field. Adding an audio-driven affine stage — zoom, rotation, centre,
anisotropic scale — on top of the existing field warp is what turns a two percent
musical excursion into visible motion, because it compounds frame over frame
instead of being rebuilt.

Open questions to settle before writing it:

- Where the affine parameters live. They are neither a plugin's nor the grade's;
  `PersistenceSettings` is the closest existing home, and it is currently three
  scalars derived from the theme and three audio channels rather than a bound
  parameter block.
- Whether survival rises with it, and how far. A warped feedback wants something
  near 0.9 per second where the ceiling is 0.25, and that changes what every
  existing scene looks like.
- Whether the per-scene affine character is drawn from the theme, from the
  entropy, or authored — the equivalent question to which preset is loaded.
- How this interacts with `motionScale` and the summed motion field, which is a
  second, per-pixel displacement of the same buffer.

### Step 9 — `DomainWarpTransform` driver typing [R7]

Four of six modes read a signed vector field through `luminance()`. The fix is
not merely to read `driver.rg`: two of the four want a scalar driver and there is
no scalar-image port for them to ask for. The decision is whether to add one,
whether to split the plugin, or whether to derive a scalar from the field's
magnitude — and the same question governs any later plugin that wants an image as
a control signal.

### Step 10 — Scene selection fitness [R8]

`buildFirstViableScene` returns the first legal candidate and discards up to
thirty-one others unexamined. Scoring them needs a fitness function, and what
belongs in it is the design question: bound-parameter count and feature diversity
across roles are measurable, branch contrast and focal structure are the ones
that actually decide whether a scene is worth looking at, and neither has a
measure yet.

---

## Measurements

Filled in as steps land, so a later reader can see what each one moved. Taken over a
110-second synthesised bed with a moving stereo image and alternating quiet and
loud sections, run through the real analysis chain and the real parameter
resolver, discarding the first thirty seconds so the distribution stage is warm.

| figure | before | after step 1–3 | after all |
| --- | --- | --- | --- |
| median binding range utilisation | 19% | **90%** | |
| bindings below 25% utilisation | 163 of 313 | **0 of 313** | |
| median audio share of parameter motion | 58% | **84%** | |
| minimum audio share | — | **59%** | |
| parameters where drift outweighs audio | 29 of 108 | **0 of 154** | |
| `stereoBalance` occupancy | 0% | **89%** | |
| `spectralCentroid` occupancy | 30%, pinned at 1.000 | **90%** | |
| particle bodies at equilibrium | 144 | | |
| particle frame coverage | 0.78% | | |
| scenes selecting a particle force or collider | 0% | | |
| visualizer suite | 2 failing | 2 failing | |

The audio-share figures count `value`-mode bindings only. `modulateParameters`
skips `rate` and `impulse` by design, so including them measured the integrator
and the envelope rather than the drift — which is what put the earlier figure at
58 percent across 108 parameters instead of 72 across 154. Both numbers were
taken the same way within each column.
