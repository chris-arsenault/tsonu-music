/**
 * The audio tap (ADR-0001).
 *
 * `createMediaElementSource` permanently reroutes an element's output through the Web Audio graph,
 * and the player's element lives for the whole page. So: one tap, created on first activation, and
 * audio wired `source -> gain(1.0) -> destination` unconditionally with the analysis worklet hanging
 * off a parallel branch that terminates in nothing. Nothing on the analysis side can reach output.
 */

import { createAnalyserAnalysis, type AnalyserAnalysis } from './analyser-fallback';
import type { FeatureSnapshot } from '../core/features';
import type { AnalysisCommand } from './analysis-worklet';
// Bundled by `vite-plugins/audio-worklet.ts` into a single import-free script, because an
// `AudioWorkletGlobalScope` has no module graph and no `window`. Vite's worker pipeline satisfies
// that only in a production build; in dev it serves an unbundled module that `addModule` rejects.
import workletUrl from './analysis-worklet.ts?audio-worklet';

/** Output latency estimate used when the browser does not report `outputLatency`. */
const FALLBACK_OUTPUT_LATENCY_SECONDS = 0.02;

/** Consecutive silent frames during unpaused playback before analysis is called dead. */
const FLATLINE_FRAME_LIMIT = 60;

export interface AudioTap {
    readonly context: AudioContext;
    /** Where analysis is running. `main-thread` means the worklet was unavailable. */
    analysisPath(): 'worklet' | 'main-thread';
    /** Latest snapshot, or undefined if none has arrived since the last read. */
    takeSnapshot(): FeatureSnapshot | undefined;
    /** `outputLatency + baseLatency`, with a fallback where `outputLatency` is unreported. */
    latencySeconds(): number;
    /** Drops the worklet's short-term history. Called on seek and track change. */
    reset(): void;
    /** True once analysis has been silent for long enough to be considered dead. */
    isFlatlined(): boolean;
    resume(): Promise<void>;
    dispose(): void;
}

/** One tap per element, for the element's lifetime. */
const taps = new WeakMap<HTMLMediaElement, Promise<AudioTap>>();

export function existingTap(element: HTMLMediaElement): Promise<AudioTap> | undefined {
    return taps.get(element);
}

/**
 * Creates the tap, or returns the one this element already has.
 *
 * Must be called from a user gesture so the context can start. The caller is responsible for having
 * checked availability first — this function does not gate.
 */
export function acquireTap(element: HTMLMediaElement): Promise<AudioTap> {
    const existing = taps.get(element);
    if (existing) {
        return existing;
    }

    const created = createTap(element);
    taps.set(element, created);

    return created;
}

async function createTap(element: HTMLMediaElement): Promise<AudioTap> {
    const context = new AudioContext();

    // Audio path first, and unconditionally. If anything below this throws, sound still reaches the
    // speakers through a gain node that no analysis code touches.
    const source = context.createMediaElementSource(element);
    const outputGain = context.createGain();
    outputGain.gain.value = 1;
    source.connect(outputGain);
    outputGain.connect(context.destination);

    let latest: FeatureSnapshot | undefined;
    let silentFrames = 0;
    let flatlined = false;
    let analysis: AudioWorkletNode | undefined;
    let analysisConnected = false;
    /** Used when the worklet is unavailable — most often because this is not a secure context. */
    let fallback: AnalyserAnalysis | undefined;

    const noteSilence = (level: number) => {
        if (level === 0 && !element.paused) {
            silentFrames += 1;
            if (silentFrames >= FLATLINE_FRAME_LIMIT) {
                flatlined = true;
            }
        } else {
            silentFrames = 0;
            flatlined = false;
        }
    };

    const handleSnapshot = (event: MessageEvent<FeatureSnapshot>) => {
        latest = event.data;
        noteSilence(event.data.rms);
    };

    try {
        if (!context.audioWorklet) {
            // `AudioWorklet` is a secure-context API. Named explicitly because the alternative is a
            // `TypeError` about `addModule` on undefined, which says nothing about the actual cause.
            throw new Error('AudioWorklet requires a secure context');
        }

        await context.audioWorklet.addModule(workletUrl);

        analysis = new AudioWorkletNode(context, 'tsonu-analysis', {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            channelCount: 2,
            channelCountMode: 'explicit',
        });

        analysis.port.onmessage = handleSnapshot;

        // The parallel branch. `numberOfOutputs: 0` is what makes it a dead end: the node consumes
        // the signal and produces nothing, so it cannot contribute to or interrupt output.
        source.connect(analysis);
        analysisConnected = true;
    } catch (error) {
        // The render thread is unavailable, so analysis moves to the main thread. Less precise, and
        // still incomparably better than a visualizer whose every feature reads zero.
        fallback = createAnalyserAnalysis(context, source);
        console.warn('[visualizer] analysis running on the main thread', error);
    }

    return {
        context,

        analysisPath() {
            return fallback ? 'main-thread' : 'worklet';
        },

        takeSnapshot() {
            if (fallback) {
                // Pulled rather than pushed: the frame loop already asks once per frame, so the
                // fallback needs no timer of its own.
                const snapshot = fallback.pull();
                noteSilence(snapshot.rms);
                return snapshot;
            }

            const snapshot = latest;
            latest = undefined;
            return snapshot;
        },

        latencySeconds() {
            const output = typeof context.outputLatency === 'number' && Number.isFinite(context.outputLatency)
                ? context.outputLatency
                : FALLBACK_OUTPUT_LATENCY_SECONDS;

            return output + context.baseLatency;
        },

        reset() {
            fallback?.reset();

            const command: AnalysisCommand = { kind: 'reset' };
            analysis?.port.postMessage(command);
        },

        isFlatlined() {
            return flatlined;
        },

        async resume() {
            fallback?.connect();

            if (analysis && !analysisConnected) {
                latest = undefined;
                silentFrames = 0;
                flatlined = false;
                analysis.port.onmessage = handleSnapshot;
                source.connect(analysis);
                analysisConnected = true;
            }

            if (context.state !== 'running') {
                await context.resume();
            }
        },

        dispose() {
            // The tap itself is never torn down — the source node cannot be detached from the
            // element. Pause its reusable analysis branch; audio keeps flowing through the gain.
            fallback?.disconnect();

            if (analysis && analysisConnected) {
                analysis.port.onmessage = null;
                source.disconnect(analysis);
                analysisConnected = false;
                latest = undefined;
            }
        },
    };
}
