/**
 * The visualizer's surface in the player.
 *
 * One launcher beside the seek bar and a modal. The kernel starts when the modal opens and stops when
 * it closes, so a listener who never opens it pays no GPU or main-thread cost at all.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMusicPlayer } from '../../music/MusicPlayerContext';
import { collectFaults, describeFault, describeTier, selectTier, tierNeedsGpu } from '../core/fallback';
import { createDiagnosticsControls } from '../core/diagnostics';
import { describeUnavailableReason } from '../host/capabilities';
import { createSimpleWaveform, type SimpleWaveform } from '../host/simple-waveform';
import { useKernelReadout } from './use-kernel-readout';

const PUBLIC_CONTROLS = createDiagnosticsControls();

export default function VisualizerPanel() {
    const player = useMusicPlayer();
    const [expanded, setExpanded] = useState(false);
    const [glCanvas, setGlCanvas] = useState<HTMLCanvasElement | null>(null);
    const [fallbackCanvas, setFallbackCanvas] = useState<HTMLCanvasElement | null>(null);

    // The public kernel runs only while the modal is open. Authoring and diagnostics controls belong
    // to the checked-in Visualizer Lab, never to this playback surface.
    const { availability, readout } = useKernelReadout(
        {
            getAudioElement: player.getAudioElement,
            playbackEngine: player.playbackEngine,
            trackId: player.selectedTrack?.trackId ?? null,
            trackDurationSeconds: player.selectedTrack?.durationSeconds ?? 0,
            canvas: glCanvas,
            getBufferHealth: player.getBufferHealth,
            artworkSrc: player.artworkSrc,
            controls: PUBLIC_CONTROLS,
        },
        expanded,
    );
    const unavailableMessage = availability && !availability.available
        ? availability.reasons.map(describeUnavailableReason).join(' ')
        : undefined;

    const openVisualizer = useCallback(() => {
        if (player.prepareVisualizerPlayback()) {
            setExpanded(true);
        }
    }, [player]);

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
            // Reported by the device rather than hardcoded. Pinned false, a lost context selected no
            // fallback tier at all, so a driver reset left a black rectangle with no degradation.
            contextLost: readout.gpu?.contextLost ?? false,
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
    const showFallbackCanvas = expanded && readout !== undefined && tier === 'waveform';
    const showArtworkOnly = expanded && (tier === 'artwork' || tier === 'empty');

    useFallbackWaveform(showFallbackCanvas ? fallbackCanvas : null, readout?.bus.waveform);

    const modal = expanded ? (
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
                {unavailableMessage ? null : tierNeedsGpu(tier) ? (
                    <canvas className="visualizer-modal__canvas" ref={setGlCanvas} />
                ) : (
                    // The GL canvas stays mounted so the kernel keeps its device across a
                    // transient fault; it is simply covered by the active fallback tier.
                    <canvas className="visualizer-modal__canvas is-hidden" ref={setGlCanvas} />
                )}

                {!unavailableMessage && showFallbackCanvas ? (
                    <canvas className="visualizer-modal__canvas" ref={setFallbackCanvas} />
                ) : null}

                {unavailableMessage || showArtworkOnly ? (
                    <img className="visualizer-modal__artwork" src={player.artworkSrc} alt={player.artworkAltText} />
                ) : null}

                {unavailableMessage ? (
                    <div className="visualizer-modal__notice" role="status">
                        <strong>Visualizer unavailable in this playback mode</strong>
                        <span>{unavailableMessage}</span>
                    </div>
                ) : (
                    <div className="visualizer-modal__status">
                        <span>{describeTier(tier)}</span>
                        {readout?.performance ? (
                            <span>
                                L{readout.performance.level} · {readout.frameTimeMs.toFixed(0)}ms
                            </span>
                        ) : null}
                        {faults.length > 0 ? <span>{describeFault(faults[0])}</span> : null}
                    </div>
                )}

                <div className="visualizer-modal__chrome">
                    <button
                        type="button"
                        className="visualizer-modal__button"
                        onClick={() => setExpanded(false)}
                        aria-label="Close visualizer"
                    >
                        ×
                    </button>
                </div>

            </div>
        </div>
    ) : null;

    return (
        <>
            {player.visualizerSupported ? (
                <button
                    type="button"
                    className="bottom-player__visualizer"
                    onClick={openVisualizer}
                >
                    Open visualizer
                </button>
            ) : null}

            {modal && typeof document !== 'undefined' ? createPortal(modal, document.body) : modal}
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
