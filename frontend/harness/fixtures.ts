/**
 * Verification fixtures for the scene-state combine family.
 *
 * The three operators — `SceneStateCombine` (max), `:flow`, `:deposit` — differ in exactly one
 * shader, so the fixtures hold everything else still: one dense base scene and one sparse base
 * scene are built deterministically, captured, and rewritten three ways by swapping the combine
 * node's definition. Every variant of a fixture then measures the same document with the same
 * synthetic audio, and the metric differences are attributable to the operator alone.
 *
 * The plan's fixture list (docs plan `cosmic-splashing-beaver`) numbers nine; this file runs the
 * decisive subset — 1 (motion inside bright regions), 3 (the stamp/passthrough catcher), 5
 * (post-clear rise), 6 (single-frame transient) — plus post-grade p95 and saturation on every run,
 * which covers the presentation halves of fixtures 2 and 4.
 *
 * No buildable scene in a 40-entropy probe contained `MaskEffectStencil`, so fixture 1 uses the
 * pre-approved dense fallback: the bright mask is the set of grid cells above 0.5 luminance at
 * t = 3 s in the SAME scene under bare max, and the flow threshold is 3x rather than the stencil
 * variant's 10x.
 */

import { GRID, measureScene, type MeasureOptions, type SceneMeasurement } from './measure';
import { profileFor } from '../src/visualizer/core/performance';
import { buildFirstViableScene, variedThemeOrder } from '../src/visualizer/core/scene-builder';
import { captureScene } from '../src/visualizer/core/scene-capture';
import { edgeIdFor, type AuthoredScene } from '../src/visualizer/core/authored-scene';
import { allDefinitions } from '../src/visualizer/plugins/registry';
import { THEMES } from '../src/visualizer/plugins/themes';

/**
 * Chosen by probing `fixture-base-0..39` through `buildFirstViableScene` (deterministic, so the
 * probe's answer holds here). Dense: ProceduralTextureSource:curl-noise + ReactionDiffusion +
 * FlowFieldCompositor — full-frame bright material for fixtures 1 and 3. Sparse:
 * ParametricCurveSource:hypotrochoid + particle renderers — trace-dominated material for 5 and 6.
 * Both build with the bare `SceneStateCombine`, so the rewrite starts from max in both cases.
 */
const DENSE_ENTROPY = 'fixture-base-3';
const SPARSE_ENTROPY = 'fixture-base-37';

const OPERATORS = ['max', 'flow', 'deposit'] as const;
export type CombineOperator = typeof OPERATORS[number];

const RENDER_SECONDS = 8;
const WARMUP_SECONDS = 3;
/** Delta metrics compare samples this far apart, so 60 and 30 fps measure the same interval. */
const DELTA_SPACING_SECONDS = 0.1;

export interface FixtureRunStats {
    fixture: string;
    operator: CombineOperator;
    /** Post-grade luminance p95, pooled over all cells of every 0.1 s sample after warm-up. */
    p95: number;
    /** Mean over lit cells (max channel > 0.02) of (max-min)/max, averaged over post-warm-up samples. */
    meanSaturation: number;
    meanLuminance: number;
    problems: string[];
    /** Final frame PNG data URI, extracted to a file by the runner. */
    lastFrame?: string;
}

export interface FixtureReport {
    fps: number;
    width: number;
    height: number;
    dense: { entropy: string; themeId: string; plugins: string[] };
    sparse: { entropy: string; themeId: string; plugins: string[] };
    stencilAvailable: false;
    f1: {
        maskCells: number;
        /** Mean |frame delta| inside the bright mask per 0.1 s, t in [3, 8], per operator. */
        maskedDeltaPerTenth: Record<CombineOperator, number>;
        /** The same figure per second, the cross-fps comparable form. */
        maskedDeltaPerSecond: Record<CombineOperator, number>;
        flowOverMax: number;
        depositOverMax: number;
    };
    f3: {
        /** Mean full-frame |delta| per 0.1 s after warm-up, per operator. */
        frameDeltaPerTenth: Record<CombineOperator, number>;
        frameDeltaPerSecond: Record<CombineOperator, number>;
        /** Final-frame correlation of each operator's run against the memoryless max control. */
        controlCorrelation: Record<CombineOperator, number>;
    };
    f5: {
        /** Mean luminance just before the clear (t = 3.5 s), per operator. */
        steadyLuminance: Record<CombineOperator, number>;
        /** Frames from the clear until mean luminance regains 63% of steady. -1 = never within the run. */
        riseFrames: Record<CombineOperator, number>;
        riseSeconds: Record<CombineOperator, number>;
        /** Lowest mean luminance after the clear, so the dip itself is visible in the numbers. */
        postClearMinimum: Record<CombineOperator, number>;
    };
    f6: {
        /** Mean luminance over t in [4.6, 4.98], the steady level before the impulse. */
        preImpulseLuminance: Record<CombineOperator, number>;
        /** Peak mean luminance in t in [5, 5.3] minus the pre-impulse level. */
        bump: Record<CombineOperator, number>;
        flowOverMax: number;
        depositOverMax: number;
    };
    runs: FixtureRunStats[];
}

/** Builds a deterministic scene and freezes it into a document, exactly as the scene path does. */
function buildBaseDocument(entropy: string): AuthoredScene {
    const built = buildFirstViableScene(
        entropy,
        variedThemeOrder(entropy, THEMES),
        {
            available: allDefinitions(),
            assets: [],
            capabilities: ['float-textures', 'webgl2'],
            history: {},
            playbackTime: 0,
        },
        profileFor(0),
    );

    if (!built.ok) {
        throw new Error(`fixture base did not build: ${built.failure.reason} ${built.failure.detail}`);
    }

    return captureScene(built.scene);
}

/**
 * Rewrites a captured document to run a chosen combine operator.
 *
 * Node ids are `<DefinitionId>#<n>`, so the combine node gets a new id alongside its new plugin id,
 * and every edge, asset binding and present reference naming the old id is rewritten to match. The
 * node's captured parameters and bindings are dropped rather than carried across: they were the max
 * definition's values, and the fixture should measure the target operator as it ships — its own
 * defaults, including the inject binding max does not have.
 */
export function withOperator(base: AuthoredScene, operator: CombineOperator): AuthoredScene {
    const targetPluginId = operator === 'max' ? 'SceneStateCombine' : `SceneStateCombine:${operator}`;
    const combine = base.nodes.find(
        (node) => node.pluginId === 'SceneStateCombine' || node.pluginId.startsWith('SceneStateCombine:'),
    );
    if (!combine) {
        throw new Error(`no SceneStateCombine node in scene ${base.entropy}`);
    }

    const hash = combine.id.indexOf('#');
    const suffix = hash >= 0 ? combine.id.slice(hash) : '';
    const oldId = combine.id;
    const newId = `${targetPluginId}${suffix}`;
    const renamed = (node: string): string => (node === oldId ? newId : node);

    const rewritten: AuthoredScene = structuredClone(base);

    for (const node of rewritten.nodes) {
        if (node.id !== oldId) continue;
        node.id = newId;
        node.pluginId = targetPluginId;
        delete node.parameters;
        delete node.bindings;
    }

    for (const edge of rewritten.edges) {
        edge.from = { ...edge.from, node: renamed(edge.from.node) };
        edge.to = { ...edge.to, node: renamed(edge.to.node) };
        edge.id = edgeIdFor(edge.from, edge.to, edge.feedback === true);
    }

    rewritten.assetBindings = rewritten.assetBindings.map((binding) => ({
        ...binding,
        node: renamed(binding.node),
    }));

    if (rewritten.present) {
        // Flow and deposit present their display output — the state with fresh material riding
        // on top — while max presents the state itself (ADR-0017).
        const presentPort = targetPluginId === 'SceneStateCombine' ? 'color' : 'display';
        rewritten.present = { node: renamed(rewritten.present.node), port: presentPort };
    }

    return rewritten;
}

function pearson(a: Float32Array, b: Float32Array): number {
    const meanOf = (values: Float32Array): number => {
        let total = 0;
        for (let index = 0; index < values.length; index += 1) total += values[index];
        return total / values.length;
    };
    const meanA = meanOf(a);
    const meanB = meanOf(b);

    let covariance = 0;
    let varianceA = 0;
    let varianceB = 0;
    for (let index = 0; index < a.length; index += 1) {
        const da = a[index] - meanA;
        const db = b[index] - meanB;
        covariance += da * db;
        varianceA += da * da;
        varianceB += db * db;
    }

    const denominator = Math.sqrt(varianceA * varianceB);
    return denominator > 1e-9 ? covariance / denominator : 0;
}

/** Mean |a - b| over the cells the mask admits, or over every cell when the mask is absent. */
function maskedDelta(a: Float32Array, b: Float32Array, mask?: Uint8Array): number {
    let total = 0;
    let count = 0;
    for (let index = 0; index < a.length; index += 1) {
        if (mask && mask[index] === 0) continue;
        total += Math.abs(a[index] - b[index]);
        count += 1;
    }
    return count > 0 ? total / count : 0;
}

/**
 * Mean sample-pair delta at DELTA_SPACING_SECONDS spacing over [fromSeconds, run end].
 *
 * Fixed spacing in seconds, not frames: the per-second normalization the cross-fps agreement check
 * relies on. Samples are one per rendered frame, so the spacing in samples is spacing * fps.
 */
function deltaOverWindow(
    measurement: SceneMeasurement,
    fps: number,
    fromSeconds: number,
    mask?: Uint8Array,
): number {
    const grids = measurement.grids!;
    const step = Math.max(1, Math.round(DELTA_SPACING_SECONDS * fps));
    const start = Math.round(fromSeconds * fps);
    let total = 0;
    let pairs = 0;
    for (let index = start; index + step < grids.length; index += step) {
        total += maskedDelta(grids[index], grids[index + step], mask);
        pairs += 1;
    }
    return pairs > 0 ? total / pairs : 0;
}

function percentile(values: number[], q: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const position = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
    return sorted[position];
}

/** Post-warm-up presentation stats: pooled luminance p95 and mean saturation over lit cells. */
function runStats(
    fixture: string,
    operator: CombineOperator,
    measurement: SceneMeasurement,
    fps: number,
): FixtureRunStats {
    const grids = measurement.grids!;
    const rgb = measurement.rgbGrids!;
    const poolStep = Math.max(1, Math.round(0.1 * fps));
    const start = Math.round(WARMUP_SECONDS * fps);

    const pooled: number[] = [];
    let saturationTotal = 0;
    let saturationSamples = 0;

    for (let index = start; index < grids.length; index += poolStep) {
        const grid = grids[index];
        for (let cell = 0; cell < grid.length; cell += 1) pooled.push(grid[cell]);

        const planes = rgb[index];
        let litSaturation = 0;
        let lit = 0;
        for (let cell = 0; cell < planes.r.length; cell += 1) {
            const top = Math.max(planes.r[cell], planes.g[cell], planes.b[cell]);
            if (top <= 0.02) continue;
            const bottom = Math.min(planes.r[cell], planes.g[cell], planes.b[cell]);
            litSaturation += (top - bottom) / top;
            lit += 1;
        }
        if (lit > 0) {
            saturationTotal += litSaturation / lit;
            saturationSamples += 1;
        }
    }

    const luminanceTail = measurement.luminance.slice(start);

    return {
        fixture,
        operator,
        p95: percentile(pooled, 0.95),
        meanSaturation: saturationSamples > 0 ? saturationTotal / saturationSamples : 0,
        meanLuminance: luminanceTail.reduce((sum, value) => sum + value, 0) / Math.max(1, luminanceTail.length),
        problems: measurement.problems,
        lastFrame: measurement.lastFrame,
    };
}

/** Frees the bulk data once a run's metrics are extracted, so ten runs do not hold ten runs of grids. */
function dropGrids(measurement: SceneMeasurement): void {
    delete measurement.grids;
    delete measurement.rgbGrids;
}

const emptyRecord = (): Record<CombineOperator, number> => ({ max: 0, flow: 0, deposit: 0 });

export async function runFixtureMatrix(options: {
    fps: number;
    width: number;
    height: number;
}): Promise<FixtureReport> {
    const { fps, width, height } = options;
    const dt = 1 / fps;

    const denseBase = buildBaseDocument(DENSE_ENTROPY);
    const sparseBase = buildBaseDocument(SPARSE_ENTROPY);

    const common: Omit<MeasureOptions, 'entropy'> = {
        seconds: RENDER_SECONDS,
        fps,
        width,
        height,
        sampleInterval: dt,
        keepGrids: true,
        skipAlignment: true,
    };

    const yieldFrame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    // Runtime problems ride along on each run record; `measureScene` already throws when a
    // rewritten document fails to resolve, which is the verification the rewrite owes.
    const measure = async (
        label: string,
        scene: AuthoredScene,
        extra: Partial<MeasureOptions>,
    ): Promise<SceneMeasurement> => {
        const measured = measureScene({ ...common, entropy: label, scene, ...extra });
        await yieldFrame();
        return measured;
    };

    const report: FixtureReport = {
        fps,
        width,
        height,
        dense: { entropy: DENSE_ENTROPY, themeId: '', plugins: [] },
        sparse: { entropy: SPARSE_ENTROPY, themeId: '', plugins: [] },
        stencilAvailable: false,
        f1: {
            maskCells: 0,
            maskedDeltaPerTenth: emptyRecord(),
            maskedDeltaPerSecond: emptyRecord(),
            flowOverMax: 0,
            depositOverMax: 0,
        },
        f3: {
            frameDeltaPerTenth: emptyRecord(),
            frameDeltaPerSecond: emptyRecord(),
            controlCorrelation: emptyRecord(),
        },
        f5: {
            steadyLuminance: emptyRecord(),
            riseFrames: emptyRecord(),
            riseSeconds: emptyRecord(),
            postClearMinimum: emptyRecord(),
        },
        f6: {
            preImpulseLuminance: emptyRecord(),
            bump: emptyRecord(),
            flowOverMax: 0,
            depositOverMax: 0,
        },
        runs: [],
    };

    // --- Dense scene: fixtures 1 and 3 share one 8 s free-audio run per operator. ---

    const denseFinal: Partial<Record<CombineOperator, Float32Array>> = {};
    let brightMask: Uint8Array | undefined;

    for (const operator of OPERATORS) {
        const scene = withOperator(denseBase, operator);
        const measured = await measure(`dense-${operator}`, scene, {});

        if (operator === 'max') {
            report.dense.themeId = measured.themeId;
            report.dense.plugins = measured.plugins;
            // The bright mask comes from the same scene under bare max at t = 3 s.
            const at3 = measured.grids![Math.round(WARMUP_SECONDS * fps)];
            brightMask = new Uint8Array(GRID * GRID);
            let cells = 0;
            for (let index = 0; index < at3.length; index += 1) {
                if (at3[index] > 0.5) {
                    brightMask[index] = 1;
                    cells += 1;
                }
            }
            report.f1.maskCells = cells;
        }

        const mask = brightMask!;
        report.f1.maskedDeltaPerTenth[operator] = deltaOverWindow(measured, fps, WARMUP_SECONDS, mask);
        report.f1.maskedDeltaPerSecond[operator] =
            report.f1.maskedDeltaPerTenth[operator] / DELTA_SPACING_SECONDS;
        report.f3.frameDeltaPerTenth[operator] = deltaOverWindow(measured, fps, WARMUP_SECONDS);
        report.f3.frameDeltaPerSecond[operator] =
            report.f3.frameDeltaPerTenth[operator] / DELTA_SPACING_SECONDS;
        // The final grid survives `dropGrids`: it is a direct Float32Array reference, and deleting
        // the array that also pointed at it does not free it.
        denseFinal[operator] = measured.grids![measured.grids!.length - 1];

        report.runs.push(runStats('f1+f3-dense', operator, measured, fps));
        dropGrids(measured);
    }

    // The memoryless control: the same dense document under max with every history slot blanked
    // every frame. An operator whose picture equals this one is a passthrough wearing a combine.
    const control = await measure('dense-max-memoryless', withOperator(denseBase, 'max'), {
        withoutHistory: true,
    });
    const controlFinal = control.grids![control.grids!.length - 1];
    for (const operator of OPERATORS) {
        report.f3.controlCorrelation[operator] = pearson(denseFinal[operator]!, controlFinal);
    }
    report.runs.push(runStats('f3-control', 'max', control, fps));
    dropGrids(control);

    // --- Sparse scene, fixture 5: loud throughout, history blanked once at t = 4 s. ---

    for (const operator of OPERATORS) {
        const scene = withOperator(sparseBase, operator);
        const measured = await measure(`sparse-clear-${operator}`, scene, {
            impulseWindows: [[0, RENDER_SECONDS + 1]],
            clearAtSeconds: 4,
        });

        if (operator === 'max' && report.sparse.plugins.length === 0) {
            report.sparse.themeId = measured.themeId;
            report.sparse.plugins = measured.plugins;
        }

        const clearIndex = Math.ceil(4 * fps - 1e-6);
        const steady = measured.luminance[Math.round(3.5 * fps)];
        report.f5.steadyLuminance[operator] = steady;

        let rise = -1;
        let minimum = Number.POSITIVE_INFINITY;
        for (let index = clearIndex; index < measured.luminance.length; index += 1) {
            minimum = Math.min(minimum, measured.luminance[index]);
            if (measured.luminance[index] >= 0.63 * steady) {
                rise = index - clearIndex;
                break;
            }
        }
        report.f5.riseFrames[operator] = rise;
        report.f5.riseSeconds[operator] = rise < 0 ? -1 : rise / fps;
        report.f5.postClearMinimum[operator] = Number.isFinite(minimum) ? minimum : 0;

        report.runs.push(runStats('f5-clear', operator, measured, fps));
        dropGrids(measured);
    }

    // --- Sparse scene, fixture 6: one loud frame at t = 5 s over a steady moderate floor. ---
    //
    // The window closes half a frame after it opens, so exactly the frame rendered at t = 5.0 s is
    // loud at either rate — the plan's [5.0, 5.017] admits two frames at 60 fps.

    for (const operator of OPERATORS) {
        const scene = withOperator(sparseBase, operator);
        const measured = await measure(`sparse-impulse-${operator}`, scene, {
            impulseWindows: [[5.0, 5.0 + 0.5 * dt]],
        });

        const preStart = Math.round(4.6 * fps);
        const preEnd = Math.round(4.98 * fps);
        let preTotal = 0;
        let preCount = 0;
        for (let index = preStart; index <= preEnd && index < measured.luminance.length; index += 1) {
            preTotal += measured.luminance[index];
            preCount += 1;
        }
        const pre = preCount > 0 ? preTotal / preCount : 0;

        let peak = 0;
        const bumpStart = Math.round(5.0 * fps);
        const bumpEnd = Math.round(5.3 * fps);
        for (let index = bumpStart; index <= bumpEnd && index < measured.luminance.length; index += 1) {
            peak = Math.max(peak, measured.luminance[index]);
        }

        report.f6.preImpulseLuminance[operator] = pre;
        report.f6.bump[operator] = Math.max(0, peak - pre);

        report.runs.push(runStats('f6-impulse', operator, measured, fps));
        dropGrids(measured);
    }

    const safeRatio = (numerator: number, denominator: number): number =>
        denominator > 1e-9 ? numerator / denominator : Number.POSITIVE_INFINITY;

    report.f1.flowOverMax = safeRatio(report.f1.maskedDeltaPerTenth.flow, report.f1.maskedDeltaPerTenth.max);
    report.f1.depositOverMax = safeRatio(
        report.f1.maskedDeltaPerTenth.deposit,
        report.f1.maskedDeltaPerTenth.max,
    );
    report.f6.flowOverMax = safeRatio(report.f6.bump.flow, report.f6.bump.max);
    report.f6.depositOverMax = safeRatio(report.f6.bump.deposit, report.f6.bump.max);

    return report;
}
