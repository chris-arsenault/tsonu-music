/**
 * Renders scenes for real and measures what happens to the picture over seconds.
 *
 * Every conclusion about this subsystem up to now came from reading the scene graph in Node: which
 * plugins were selected, how they were wired, what a loop's declared gain multiplied to. None of that
 * is the thing being judged. A graph can be correct in every structural sense and still produce a
 * picture that sits still, and repeatedly it did — the reported figures said the loops were fixed
 * while the screen said they were not.
 *
 * So this runs the actual kernel against a real WebGL2 context, drives it with a synthetic feature
 * bus at a fixed timestep, reads the framebuffer back at intervals, and computes statistics over the
 * resulting sequence. It answers three questions the graph cannot:
 *
 *   1. Does anything change at all, and how fast?
 *   2. Is the change *in place*, or is material travelling across the frame?
 *   3. How far back does the picture remember?
 *
 * The second is the one that separates a motion blur from a tunnel, and it is measured rather than
 * inferred: for a pair of frames a fixed time apart, search a window of candidate shifts for the one
 * that best aligns them. A picture that flows has a best shift that grows with the interval. A
 * picture that pulses in place has a best shift of zero at every interval, however much it changes.
 */

import { createRenderer, type Renderer } from '../src/visualizer/host/renderer';
import { silentFeatureBus } from '../src/visualizer/core/features';
import { profileFor } from '../src/visualizer/core/performance';
import { buildFirstViableScene, variedThemeOrder } from '../src/visualizer/core/scene-builder';
import { captureScene } from '../src/visualizer/core/scene-capture';
import { allDefinitions } from '../src/visualizer/plugins/registry';
import { THEMES } from '../src/visualizer/plugins/themes';
import type { AudioFeatureBus } from '../src/visualizer/core/features';
import type { PlaybackClock } from '../src/visualizer/core/clock';

/** Frames are compared at this resolution, not the render resolution. */
const GRID = 48;

/** Half-width of the shift search, in grid cells. */
const SEARCH = 10;

export interface MeasureOptions {
    entropy: string;
    /** Seconds of playback to simulate. */
    seconds: number;
    fps: number;
    width: number;
    height: number;
    /** Seconds between captured frames. */
    sampleInterval: number;
    /**
     * Repeat the whole feature bus on this period, so history can be told apart from the music.
     *
     * Zero leaves the bus free-running, which is what the correlation figures were measured against.
     */
    periodSeconds?: number;
    /**
     * Blank every historical slot each frame, so the scene keeps its structure and loses its memory.
     *
     * The control for the period-divergence figure. Plugins animate from their own accumulated
     * `uTime`, so two frames one audio period apart differ whether or not anything was remembered —
     * a procedural source running on a clock is enough. Measured against a run of the same scene with
     * no history at all, the difference between the two divergences is what memory actually
     * contributed, and the null model's own divergence is what the clocks contributed.
     */
    withoutHistory?: boolean;
}

export interface SceneMeasurement {
    entropy: string;
    themeId: string;
    plugins: string[];
    /** Mean luminance of each captured frame, 0 to 1. */
    luminance: number[];
    /** Fraction of the frame above a visibility floor, per captured frame. */
    coverage: number[];
    /** Mean absolute difference between consecutive captures. */
    changeRate: number[];
    /**
     * Difference between frames one, two, three periods apart while the audio repeats exactly.
     *
     * Zero means the picture is a function of the current audio and nothing else — it plays back
     * rather than accumulating, which reads as motion with a period instead of motion that goes
     * somewhere. Growth across periods is path dependence.
     */
    periodDivergence: { periods: number; difference: number }[];
    /**
     * The same figure for the same scene with its memory blanked every frame.
     *
     * Whatever divergence survives here is the plugins' own clocks, not history. Subtracting it is
     * what turns the period figure from a number into a measurement.
     */
    withoutHistory?: { periods: number; difference: number }[];
    /** Brightest cell in each capture. Separates "dim everywhere" from "black with a line in it". */
    peak: number[];
    /** The last captured frame as a PNG data URI, so a run can be looked at rather than inferred. */
    lastFrame?: string;
    /**
     * The scene document, so a measured scene can be opened and judged rather than taken on trust.
     *
     * A number saying one scene holds its picture four times longer than another is not the same
     * claim as that scene being worth watching, and the harness cannot tell the difference. This is
     * what gets pasted into the Lab.
     */
    document: unknown;
    /** Correlation between captures this many seconds apart, and the shift that best aligns them. */
    lags: {
        seconds: number;
        correlation: number;
        /** Correlation once the best shift is applied. Above `correlation` means material moved. */
        alignedCorrelation: number;
        shift: [number, number];
        /** Best translation as a fraction of the frame width. Blind to zoom and rotation. */
        travel: number;
        /**
         * How far the best similarity transform moves a point at mid-radius, as a fraction of the
         * frame. This is the one that can see a tunnel: growing with the interval means material is
         * being transported, flat near zero means the picture changes without going anywhere.
         */
        displacement: number;
        scale: number;
        rotation: number;
    }[];
    problems: string[];
}

/**
 * A synthetic bus with the shape of music rather than the shape of a test.
 *
 * Deterministic, so two runs of the same entropy are comparable, and periodic at several timescales
 * at once: a beat, a bar, and a slow section change. A constant bus would measure whether the scene
 * animates from `uTime`, which is not the question — the question is what the scene does with audio
 * that moves.
 */
function featuresAt(rawTime: number, periodSeconds = 0): AudioFeatureBus {
    // Wrapped, so the whole bus repeats exactly.
    //
    // This is what makes path dependence measurable. With the input exactly periodic, any difference
    // between a frame and the frame one period later is something the system remembered rather than
    // something the music did — and a picture that is a pure function of the current audio produces
    // no difference at all. Correlation cannot separate those two: an image that repeats with the
    // beat is highly self-similar, so it scores as though it had a long memory when it has none.
    const time = periodSeconds > 0 ? rawTime % periodSeconds : rawTime;
    const beat = 2.0;
    const beatPhase = (time % beat) / beat;
    const hit = Math.exp(-beatPhase * 9);
    const bar = 0.5 + 0.5 * Math.sin((time / (beat * 4)) * Math.PI * 2);
    const section = 0.5 + 0.5 * Math.sin((time / 24) * Math.PI * 2);

    const level = 0.25 + 0.55 * bar;
    const band = (offset: number) =>
        Math.max(0, Math.min(1, level * (0.6 + 0.5 * Math.sin((time / (3 + offset)) * Math.PI * 2))));

    const bus = silentFeatureBus({
        rms: level,
        peak: Math.min(1, level + hit * 0.4),
        subBass: band(0) * (0.5 + hit * 0.5),
        bass: band(1) * (0.5 + hit * 0.5),
        lowMid: band(2),
        mid: band(3),
        highMid: band(4),
        treble: band(5) * (0.4 + section * 0.6),
        rmsExcite: hit,
        subBassExcite: hit,
        bassExcite: hit,
        lowMidExcite: hit * 0.7,
        midExcite: hit * 0.5,
        highMidExcite: hit * 0.4,
        trebleExcite: hit * 0.3,
        spectralCentroid: 0.3 + 0.5 * section,
        spectralFlux: hit * 0.8,
        transient: hit,
        beatConfidence: 0.9,
        beatPhase,
        leftLevel: level,
        rightLevel: level,
        stereoBalance: 0.5 + 0.35 * Math.sin((time / 7) * Math.PI * 2),
    });

    // Events fire on the beat, so anything reading the impulse path sees the same rhythm.
    if (beatPhase < 0.05) {
        bus.events.beat.push({ playbackTime: time, strength: 1 });
        bus.events.onset.push({ playbackTime: time, strength: 0.8 });
    }

    // A spectrum that moves, for the geometry sources that read it directly.
    const spectrum = new Float32Array(64);
    for (let index = 0; index < spectrum.length; index += 1) {
        const fraction = index / spectrum.length;
        spectrum[index] = Math.max(0, level * (1 - fraction) * (0.5 + 0.5 * Math.sin(time * 3 + index * 0.4)));
    }
    const waveform = new Float32Array(256);
    for (let index = 0; index < waveform.length; index += 1) {
        waveform[index] = Math.sin((index / waveform.length) * Math.PI * 8 + time * 6) * level;
    }

    return { ...bus, spectrum, waveform };
}

function clockAt(time: number): PlaybackClock {
    return { trackId: 'harness', playbackTime: time, duration: 600, state: 'playing', generation: 1 };
}

/** Downsamples the canvas to a GRID by GRID luminance grid. */
function sampleGrid(gl: WebGL2RenderingContext, width: number, height: number): Float32Array {
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const grid = new Float32Array(GRID * GRID);
    const counts = new Float32Array(GRID * GRID);

    for (let y = 0; y < height; y += 1) {
        const gy = Math.min(GRID - 1, Math.floor((y / height) * GRID));
        for (let x = 0; x < width; x += 1) {
            const gx = Math.min(GRID - 1, Math.floor((x / width) * GRID));
            const offset = (y * width + x) * 4;
            const luminance =
                (0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2]) / 255;
            grid[gy * GRID + gx] += luminance;
            counts[gy * GRID + gx] += 1;
        }
    }

    for (let index = 0; index < grid.length; index += 1) {
        grid[index] /= Math.max(1, counts[index]);
    }

    return grid;
}

function mean(values: ArrayLike<number>): number {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) total += values[index];
    return total / values.length;
}

/** Pearson correlation of two grids, with one shifted by (dx, dy) cells. */
function correlationAt(a: Float32Array, b: Float32Array, dx: number, dy: number): number {
    let sumA = 0;
    let sumB = 0;
    let count = 0;

    for (let y = 0; y < GRID; y += 1) {
        const sy = y + dy;
        if (sy < 0 || sy >= GRID) continue;
        for (let x = 0; x < GRID; x += 1) {
            const sx = x + dx;
            if (sx < 0 || sx >= GRID) continue;
            sumA += a[y * GRID + x];
            sumB += b[sy * GRID + sx];
            count += 1;
        }
    }

    if (count === 0) return 0;
    const meanA = sumA / count;
    const meanB = sumB / count;

    let covariance = 0;
    let varianceA = 0;
    let varianceB = 0;

    for (let y = 0; y < GRID; y += 1) {
        const sy = y + dy;
        if (sy < 0 || sy >= GRID) continue;
        for (let x = 0; x < GRID; x += 1) {
            const sx = x + dx;
            if (sx < 0 || sx >= GRID) continue;
            const da = a[y * GRID + x] - meanA;
            const db = b[sy * GRID + sx] - meanB;
            covariance += da * db;
            varianceA += da * da;
            varianceB += db * db;
        }
    }

    const denominator = Math.sqrt(varianceA * varianceB);
    return denominator > 1e-9 ? covariance / denominator : 0;
}

/** The shift that best aligns two frames, searched over a window. */
function bestShift(a: Float32Array, b: Float32Array): { shift: [number, number]; correlation: number } {
    let best = { shift: [0, 0] as [number, number], correlation: -2 };

    for (let dy = -SEARCH; dy <= SEARCH; dy += 1) {
        for (let dx = -SEARCH; dx <= SEARCH; dx += 1) {
            const correlation = correlationAt(a, b, dx, dy);
            if (correlation > best.correlation) {
                best = { shift: [dx, dy], correlation };
            }
        }
    }

    return best;
}

/** Bilinear sample of a grid at fractional cell coordinates, zero outside. */
function sampleAt(grid: Float32Array, x: number, y: number): number {
    if (x < 0 || y < 0 || x > GRID - 1 || y > GRID - 1) return 0;

    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(GRID - 1, x0 + 1);
    const y1 = Math.min(GRID - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;

    return (
        grid[y0 * GRID + x0] * (1 - fx) * (1 - fy)
        + grid[y0 * GRID + x1] * fx * (1 - fy)
        + grid[y1 * GRID + x0] * (1 - fx) * fy
        + grid[y1 * GRID + x1] * fx * fy
    );
}

/**
 * The similarity transform that best aligns two frames: scale, rotation, and translation.
 *
 * A translation-only search cannot see the motion this subsystem is aiming at. MilkDrop's
 * characteristic movement is a per-frame zoom and rotation about a centre, and a zoom has no best
 * translation — every part of the frame moves in a different direction. Searched for translation
 * alone, a perfect tunnel reports a best shift of zero and reads as "nothing moved", which is the
 * same answer it would give for a picture that genuinely sat still.
 *
 * So the answer is the whole similarity: how much the frame grew, how far it turned, and how far it
 * slid. Reported as the displacement this transform gives a point at mid-radius, which puts zoom,
 * rotation and translation on one scale — a fraction of the frame — and makes them comparable across
 * scenes that do different things.
 */
function bestSimilarity(a: Float32Array, b: Float32Array): {
    scale: number;
    rotation: number;
    shift: [number, number];
    correlation: number;
    displacement: number;
} {
    const centre = (GRID - 1) / 2;
    const scales = [0.90, 0.94, 0.97, 0.99, 1.0, 1.01, 1.03, 1.06, 1.11];
    const rotations = [-0.20, -0.12, -0.06, -0.02, 0, 0.02, 0.06, 0.12, 0.20];
    const shifts = [-6, -4, -2, -1, 0, 1, 2, 4, 6];

    let best = {
        scale: 1,
        rotation: 0,
        shift: [0, 0] as [number, number],
        correlation: -2,
        displacement: 0,
    };

    // Correlation of A against B resampled by the candidate transform.
    const score = (scale: number, rotation: number, dx: number, dy: number): number => {
        const cos = Math.cos(rotation) / scale;
        const sin = Math.sin(rotation) / scale;

        let sumA = 0;
        let sumB = 0;
        let count = 0;
        const values: number[] = [];

        for (let y = 0; y < GRID; y += 1) {
            for (let x = 0; x < GRID; x += 1) {
                const ox = x - centre;
                const oy = y - centre;
                const sx = centre + (ox * cos - oy * sin) + dx;
                const sy = centre + (ox * sin + oy * cos) + dy;
                if (sx < 0 || sy < 0 || sx > GRID - 1 || sy > GRID - 1) continue;

                const va = a[y * GRID + x];
                const vb = sampleAt(b, sx, sy);
                values.push(va, vb);
                sumA += va;
                sumB += vb;
                count += 1;
            }
        }

        if (count < GRID * GRID * 0.4) return -2;

        const meanA = sumA / count;
        const meanB = sumB / count;
        let covariance = 0;
        let varianceA = 0;
        let varianceB = 0;

        for (let index = 0; index < values.length; index += 2) {
            const da = values[index] - meanA;
            const db = values[index + 1] - meanB;
            covariance += da * db;
            varianceA += da * da;
            varianceB += db * db;
        }

        const denominator = Math.sqrt(varianceA * varianceB);
        return denominator > 1e-9 ? covariance / denominator : -2;
    };

    for (const scale of scales) {
        for (const rotation of rotations) {
            for (const dx of shifts) {
                for (const dy of shifts) {
                    const correlation = score(scale, rotation, dx, dy);
                    if (correlation > best.correlation) {
                        // What this transform does to a point halfway to the edge, which is where a
                        // zoom and a rotation are both plainly visible.
                        const radius = GRID / 4;
                        const moved = Math.hypot(
                            radius * (scale * Math.cos(rotation) - 1) + dx,
                            radius * scale * Math.sin(rotation) + dy,
                        );

                        best = {
                            scale,
                            rotation,
                            shift: [dx, dy],
                            correlation,
                            displacement: moved / GRID,
                        };
                    }
                }
            }
        }
    }

    return best;
}

export function measureScene(options: MeasureOptions): SceneMeasurement {
    // In the document with a CSS size, not detached.
    //
    // `createRenderer` sizes the backing store from `clientWidth * devicePixelRatio`, and a canvas
    // that is not laid out reports zero — which the renderer floors at one, so a detached canvas
    // renders one pixel. The first run of this harness measured exactly that and reported a scene as
    // very nearly black, which is the harness lying rather than the picture being black. Anything
    // measuring this subsystem has to be checked against a case whose answer is already known.
    const canvas = document.createElement('canvas');
    canvas.style.width = `${options.width}px`;
    canvas.style.height = `${options.height}px`;
    canvas.style.position = 'fixed';
    canvas.style.left = '0';
    canvas.style.top = '0';
    document.body.appendChild(canvas);

    const profile = profileFor(0);
    const created = createRenderer(canvas, { profile, assets: [] });
    if (!created.ok) {
        throw new Error(`renderer unavailable: ${created.failure} ${created.detail ?? ''}`);
    }

    const renderer: Renderer = created.renderer;

    // Built from the entropy rather than captured from the renderer.
    //
    // This took whatever scene the renderer drew on creation and overwrote its `entropy` field, which
    // renames a scene without choosing one: the renderer seeds itself from a fresh browser UUID, so
    // the same harness entropy produced a different theme on every run and two runs could not be
    // compared. Measured that way, `harness-0` was collision-energy in one run and organic-flow in
    // the next.
    const built = buildFirstViableScene(
        options.entropy,
        variedThemeOrder(options.entropy, THEMES),
        {
            available: allDefinitions(),
            assets: [],
            capabilities: ['float-textures', 'webgl2'],
            history: {},
            playbackTime: 0,
        },
        profile,
    );

    if (!built.ok) {
        throw new Error(`scene did not build: ${built.failure.reason} ${built.failure.detail}`);
    }

    // Not named `document`: that shadows the DOM global this function uses to make its canvas, and
    // the shadow reaches back over the whole body.
    const sceneDocument = captureScene(built.scene);
    const problems = renderer.setAuthoredScene(sceneDocument);
    if (problems.length > 0) {
        throw new Error(`scene did not resolve: ${problems.map((entry) => entry.detail).join('; ')}`);
    }

    const gl = canvas.getContext('webgl2')!;
    const dt = 1 / options.fps;
    const totalFrames = Math.round(options.seconds * options.fps);
    const everyFrames = Math.max(1, Math.round(options.sampleInterval * options.fps));

    const grids: Float32Array[] = [];
    const luminance: number[] = [];
    const coverage: number[] = [];
    const peak: number[] = [];
    let lastFrame: string | undefined;

    for (let frame = 0; frame <= totalFrames; frame += 1) {
        const time = frame * dt;
        renderer.renderFrame({
            clock: clockAt(time),
            features: featuresAt(time, options.periodSeconds ?? 0),
            deltaSeconds: dt,
            profile,
            // Reaches `clearHistory` in the runtime, which blanks every ping-ponged slot before
            // anything reads one. The graph is unchanged; only its memory is gone.
            clearTransients: options.withoutHistory === true,
        });

        if (frame % everyFrames === 0) {
            const grid = sampleGrid(gl, canvas.width, canvas.height);
            grids.push(grid);
            luminance.push(mean(grid));
            peak.push(Math.max(...grid));
            let lit = 0;
            for (let index = 0; index < grid.length; index += 1) if (grid[index] > 0.02) lit += 1;
            coverage.push(lit / grid.length);
        }

        // Kept from the final frame, so a run can be looked at instead of being argued about from
        // summary statistics. Taken inside the loop because the drawing buffer is not preserved and
        // is gone once the browser composites.
        if (frame === totalFrames) {
            lastFrame = canvas.toDataURL('image/png');
        }
    }

    const changeRate: number[] = [];
    for (let index = 1; index < grids.length; index += 1) {
        let total = 0;
        for (let cell = 0; cell < grids[index].length; cell += 1) {
            total += Math.abs(grids[index][cell] - grids[index - 1][cell]);
        }
        changeRate.push(total / grids[index].length);
    }

    // How much of the picture is remembered rather than played back.
    //
    // With the bus repeating exactly on `periodSeconds`, the audio at t and at t+P is identical, so
    // any difference between those two frames came from the system's own state. Reported against the
    // frame-to-frame change as a floor: a divergence at or below that is noise, and a divergence that
    // grows with each period is a picture whose present depends on how it got here.
    //
    // A system with no memory scores zero here no matter how much it moves, which is the case the
    // correlation figures could not distinguish and the one that was actually shipping.
    const periodDivergence: { periods: number; difference: number }[] = [];
    if ((options.periodSeconds ?? 0) > 0) {
        const step = Math.round((options.periodSeconds ?? 0) / options.sampleInterval);
        const settle = Math.min(grids.length - 1, step);

        for (let periods = 1; settle + periods * step < grids.length; periods += 1) {
            let total = 0;
            let pairs = 0;

            for (let index = settle; index + periods * step < grids.length; index += 1) {
                const a = grids[index];
                const b = grids[index + periods * step];
                let sum = 0;
                for (let cell = 0; cell < a.length; cell += 1) sum += Math.abs(a[cell] - b[cell]);
                total += sum / a.length;
                pairs += 1;
            }

            periodDivergence.push({ periods, difference: total / Math.max(1, pairs) });
        }
    }

    // The alignment search costs a few thousand resampled correlations per pair, which is most of a
    // run. A path-dependence run does not need it and pays for the scene twice over already, so it is
    // skipped there rather than making every measurement wait for a statistic it is not using.
    const lags = (options.periodSeconds ?? 0) > 0 ? [] : [0.25, 0.5, 1, 2, 4]
        .filter((seconds) => seconds / options.sampleInterval < grids.length - 1)
        .map((seconds) => {
            const step = Math.round(seconds / options.sampleInterval);
            let correlation = 0;
            let aligned = 0;
            let shiftX = 0;
            let shiftY = 0;
            let pairs = 0;

            let displacement = 0;
            let scale = 0;
            let rotation = 0;

            for (let index = 0; index + step < grids.length; index += 1) {
                correlation += correlationAt(grids[index], grids[index + step], 0, 0);

                const translation = bestShift(grids[index], grids[index + step]);
                shiftX += translation.shift[0];
                shiftY += translation.shift[1];

                const similarity = bestSimilarity(grids[index], grids[index + step]);
                aligned += similarity.correlation;
                displacement += similarity.displacement;
                scale += similarity.scale;
                rotation += similarity.rotation;
                pairs += 1;
            }

            const meanShift: [number, number] = [shiftX / pairs, shiftY / pairs];
            return {
                seconds,
                correlation: correlation / pairs,
                alignedCorrelation: aligned / pairs,
                shift: meanShift,
                travel: Math.hypot(meanShift[0], meanShift[1]) / GRID,
                displacement: displacement / pairs,
                scale: scale / pairs,
                rotation: rotation / pairs,
            };
        });

    const scene = renderer.captureCurrentScene();
    renderer.dispose();
    canvas.remove();

    return {
        entropy: options.entropy,
        themeId: scene.themeId ?? 'unknown',
        plugins: scene.nodes.map((node) => node.pluginId),
        luminance,
        coverage,
        changeRate,
        peak,
        lastFrame,
        document: sceneDocument,
        periodDivergence,
        lags,
        problems: renderer.problems(),
    };
}
