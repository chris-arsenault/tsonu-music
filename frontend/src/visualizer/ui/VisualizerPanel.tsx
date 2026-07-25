/**
 * The visualizer's surface in the player.
 *
 * A persisted toggle, a thumbnail beside the seek bar, and a modal. The thumbnail shows release artwork
 * and runs nothing: the kernel starts when the modal opens and stops when it closes, so a listener who
 * never opens it pays no GPU or main-thread cost at all.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useMusicPlayer } from '../../music/MusicPlayerContext';
import { collectFaults, describeFault, describeTier, selectTier, tierNeedsGpu } from '../core/fallback';
import { createDiagnosticsControls, type DiagnosticsControls } from '../core/diagnostics';
import { describeUnavailableReason } from '../host/capabilities';
import { createSimpleWaveform, type SimpleWaveform } from '../host/simple-waveform';
import { isVisualizerDebugEnabled } from './debug-flag';
import { readPreference, writePreference } from './preference';
import { useKernelReadout } from './use-kernel-readout';

// Lazy, so the diagnostics UI is not carried by listeners who never open it.
const DiagnosticsPanel = lazy(() => import('./DiagnosticsPanel'));

export default function VisualizerPanel() {
    const player = useMusicPlayer();
    const [enabled, setEnabled] = useState(() => readPreference());
    const [expanded, setExpanded] = useState(false);
    const [glCanvas, setGlCanvas] = useState<HTMLCanvasElement | null>(null);
    const [fallbackCanvas, setFallbackCanvas] = useState<HTMLCanvasElement | null>(null);
    // `?viz-debug=1` opens it immediately; otherwise it is one click away inside the modal.
    const [showDiagnostics, setShowDiagnostics] = useState(() => isVisualizerDebugEnabled());
    const [controls, setControls] = useState<DiagnosticsControls>(createDiagnosticsControls);

    // The kernel runs only while the modal is open. The diagnostics panel reports on this one rather
    // than starting a second.
    const { availability, readout, handle } = useKernelReadout(
        {
            getAudioElement: player.getAudioElement,
            trackId: player.selectedTrack?.trackId ?? null,
            trackDurationSeconds: player.selectedTrack?.durationSeconds ?? 0,
            canvas: glCanvas,
            getBufferHealth: player.getBufferHealth,
            artworkSrc: player.artworkSrc,
            controls,
        },
        enabled && expanded,
    );

    const toggle = useCallback((next: boolean) => {
        setEnabled(next);
        writePreference(next);
        if (!next) {
            setExpanded(false);
        }
    }, []);

    useEffect(() => {
        if (!expanded) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setExpanded(false);
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [expanded]);

    const faults = readout
        ? collectFaults({
            webgl2Available: readout.renderFailure !== 'no-webgl2',
            floatRenderTargets: readout.gpu?.floatRenderTargets
                ?? readout.renderFailure !== 'no-float-render-targets',
            contextLost: false,
            shaderErrorCount: readout.render?.problems.length ?? 0,
            analysisFlatlined: readout.flatlined,
            audioContextState: readout.contextState,
            graphValid: readout.renderFailure !== 'invalid-scene',
            canvasWidth: glCanvas?.clientWidth ?? 1,
            canvasHeight: glCanvas?.clientHeight ?? 1,
            performanceSuspended: readout.performance?.profile.suspended ?? false,
            prefersReducedMotion: availability?.prefersReducedMotion ?? false,
        })
        : [];

    const tier = selectTier(faults);
    const showFallbackCanvas = expanded && enabled && readout !== undefined && tier === 'waveform';
    const showArtworkOnly = expanded && enabled && (tier === 'artwork' || tier === 'empty');

    useFallbackWaveform(showFallbackCanvas ? fallbackCanvas : null, readout?.bus.waveform);

    if (availability && !availability.available) {
        return (
            <div className="bottom-player__visualizer" title={availability.reasons.map(describeUnavailableReason).join(' ')}>
                <span className="bottom-player__visualizer-unavailable" aria-hidden="true" />
            </div>
        );
    }

    return (
        <>
            <div className="bottom-player__visualizer">
                <label className="bottom-player__visualizer-toggle" title="Show visualizer">
                    <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(event) => toggle(event.currentTarget.checked)}
                    />
                    <span className="sr-only">Enable visualizer</span>
                </label>

                {enabled ? (
                    <button
                        type="button"
                        className="bottom-player__visualizer-thumb"
                        onClick={() => setExpanded(true)}
                        aria-label="Expand visualizer"
                        title="Expand visualizer"
                    >
                        <img src={player.artworkSrc} alt="" />
                    </button>
                ) : null}
            </div>

            {expanded ? (
                <div
                    className="visualizer-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Visualizer"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) {
                            setExpanded(false);
                        }
                    }}
                >
                    <div className="visualizer-modal__frame">
                        {tierNeedsGpu(tier) ? (
                            <canvas className="visualizer-modal__canvas" ref={setGlCanvas} />
                        ) : (
                            // The GL canvas stays mounted so the kernel keeps its device across a
                            // transient fault; it is simply covered by the active fallback tier.
                            <canvas className="visualizer-modal__canvas is-hidden" ref={setGlCanvas} />
                        )}

                        {showFallbackCanvas ? (
                            <canvas className="visualizer-modal__canvas" ref={setFallbackCanvas} />
                        ) : null}

                        {showArtworkOnly ? (
                            <img className="visualizer-modal__artwork" src={player.artworkSrc} alt={player.artworkAltText} />
                        ) : null}

                        <div className="visualizer-modal__status">
                            <span>{describeTier(tier)}</span>
                            {readout?.performance ? (
                                <span>
                                    L{readout.performance.level} · {readout.frameTimeMs.toFixed(0)}ms
                                </span>
                            ) : null}
                            {faults.length > 0 ? <span>{describeFault(faults[0])}</span> : null}
                        </div>

                        <div className="visualizer-modal__chrome">
                            <button
                                type="button"
                                className={`visualizer-modal__button${showDiagnostics ? ' is-active' : ''}`}
                                onClick={() => setShowDiagnostics((open) => !open)}
                                aria-pressed={showDiagnostics}
                                title="Diagnostics"
                            >
                                Diagnostics
                            </button>
                            <button
                                type="button"
                                className="visualizer-modal__button"
                                onClick={() => setExpanded(false)}
                                aria-label="Close visualizer"
                            >
                                ×
                            </button>
                        </div>

                        {showDiagnostics && readout ? (
                            <Suspense fallback={null}>
                                <DiagnosticsPanel
                                    readout={readout}
                                    faults={faults}
                                    controls={controls}
                                    onControls={setControls}
                                    handle={handle}
                                    onClose={() => setShowDiagnostics(false)}
                                />
                            </Suspense>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </>
    );
}

/** Drives the 2D fallback tier. Runs only while that tier is the active one. */
function useFallbackWaveform(canvas: HTMLCanvasElement | null, waveform: Float32Array | undefined): void {
    const waveformRef = useRef(waveform);
    waveformRef.current = waveform;

    useEffect(() => {
        if (!canvas) {
            return undefined;
        }

        let renderer: SimpleWaveform | undefined = createSimpleWaveform(canvas);
        if (!renderer) {
            return undefined;
        }

        let handle = 0;
        let start = 0;

        const frame = (now: number) => {
            if (start === 0) {
                start = now;
            }

            renderer?.render(
                {
                    continuous: {} as never,
                    events: { onset: [], beat: [], sectionChange: [] },
                    waveform: waveformRef.current ?? new Float32Array(0),
                    spectrum: new Float32Array(0),
                },
                (now - start) / 1000,
            );

            handle = requestAnimationFrame(frame);
        };

        handle = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(handle);
            renderer?.dispose();
            renderer = undefined;
        };
    }, [canvas]);
}
