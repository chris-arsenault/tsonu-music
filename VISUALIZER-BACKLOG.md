# Visualizer backlog

Open work, most likely to matter first. Findings and evidence live in
`docs/visualizer-audit-2026-07.md`; completed repairs in `VISUALIZER-REPAIR-PLAN.md`.

## Known regressions

**Saturation fell when particle count did.** Mean scene saturation measured 0.72
after the composition work and 0.47 after the particle rewrite. Solid contact at a
visible size caps the count at 4096, down from 16384, so coverage dropped. Point
size is the obvious lever and was deliberately not tuned in the same commit as the
rewrite.

## Unexplained measurements

**`DomainWarpTransform` layers render nearly black.** Measured mean luminance 6.8
and 14.4 against a particle layer at 76 in the same scene. Reported as "very simple
transforms, no warp". Cause unknown — the transforms are selected and running.

**`spectralCentroid` is pinned at its ceiling.** Median 0.999 against
`CENTROID_CEILING_HZ` of 8000, which makes it dead as a control signal. It drives
palette tint and complexity. Filed as tuning during the audit and skipped, which was
the wrong call: a measured-dead channel is a defect.

## Not built

**Fractalization.** No fractal source exists. `FractalFlameSource` and
`EscapeFractalSource` are deferred in spec §24, and `TilingTransform:recursive-frames`
is the only thing approximating it. Requested directly; deferred on spec grounds,
which is not a good reason.

**Rigid contact in dense packs.** The CPU solver is correct and converges, but the
grid stores one list per cell sized to one diameter. Deep pile-ups still need more
relaxation passes than a frame affords. Only matters if piles become a visual goal.

## Deliberate, recorded here so they are not mistaken for oversights

- **Persistence injection is 2–4% per frame**, attenuating a layer 30–40× between
  transients. Measured; left alone.
- **Excitation channels read as gates** (median 0.000, 95th percentile 1.000). That is
  what an excitation channel is for; binding kind-preservation makes it safe.
- **Seven severity-3 audit items** left in place with reasons, in
  `VISUALIZER-REPAIR-PLAN.md`. The notable one is a `smoothstep` with inverted edges —
  formally unspecified, correct on every mainstream driver, untestable here.

## Working notes

`frontend/devlab/` is the harness: gitignored, port 26010, five audio beds. The
inspect dropdown now covers the kernel's own stages (`kernel:composite`,
`kernel:motion`, `kernel:accumulate`) as well as plugin resources — the composition
was a black box between layers and canvas, and that is why the grade went
undiagnosed through sixteen commits of fixing things upstream of it.

Measure the middle of a chain, not its ends. Every wrong conclusion in this work came
from inferring a middle stage from its two ends.
