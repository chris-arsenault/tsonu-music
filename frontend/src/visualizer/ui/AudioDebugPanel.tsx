/**
 * Temporary M0 readout, reached with `?viz-debug=1`.
 *
 * Exists to verify by ear that features track audible music across pause, seek, buffering, and track
 * change. The full section 23 diagnostics overlay replaces it in M6.
 */

import { useState } from 'react';
import type { RendererFailure } from '../host/renderer';
import { useMusicPlayer } from '../../music/MusicPlayerContext';
import { describeUnavailableReason } from '../host/capabilities';
import { useKernelReadout } from './use-kernel-readout';

const CONTINUOUS_ORDER = [
    'rms',
    'peak',
    'subBass',
    'bass',
    'lowMid',
    'mid',
    'highMid',
    'treble',
    'spectralCentroid',
    'spectralFlux',
    'beatConfidence',
    'beatPhase',
    'leftLevel',
    'rightLevel',
    'stereoBalance',
] as const;

export default function AudioDebugPanel() {
    const player = useMusicPlayer();
    // Off until asked for, so opening the panel does not itself create the irreversible tap.
    const [active, setActive] = useState(false);
    // State rather than a ref, so the kernel restarts once the canvas actually exists.
    const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

    const { availability, readout } = useKernelReadout(
        {
            getAudioElement: player.getAudioElement,
            trackId: player.selectedTrack?.trackId ?? null,
            trackDurationSeconds: player.selectedTrack?.durationSeconds ?? 0,
            canvas,
            getBufferHealth: player.getBufferHealth,
        },
        active,
    );

    return (
        <aside className="viz-debug" aria-label="Visualizer audio diagnostics">
            <header className="viz-debug__header">
                <strong>Visualizer audio (M0)</strong>
                <label className="viz-debug__toggle">
                    <input
                        type="checkbox"
                        checked={active}
                        disabled={!availability?.available}
                        onChange={(event) => setActive(event.currentTarget.checked)}
                    />
                    <span>Analyse audio</span>
                </label>
            </header>

            {availability && !availability.available ? (
                <ul className="viz-debug__reasons">
                    {availability.reasons.map((reason) => (
                        <li key={reason}>{describeUnavailableReason(reason)}</li>
                    ))}
                </ul>
            ) : null}

            {availability?.prefersReducedMotion ? (
                <p className="viz-debug__note">Reduced motion is preferred; a low-energy profile applies.</p>
            ) : null}

            {active && !readout ? <p className="viz-debug__note">Starting analysis…</p> : null}

            {active ? (
                <canvas className="viz-debug__canvas" ref={setCanvas} />
            ) : null}

            {readout?.renderFailure ? (
                <p className="viz-debug__note">{describeRenderFailure(readout.renderFailure)}</p>
            ) : null}

            {readout?.render && readout.render.problems.length > 0 ? (
                <ul className="viz-debug__reasons">
                    {readout.render.problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                    ))}
                </ul>
            ) : null}

            {readout ? (
                <>
                    <dl className="viz-debug__grid">
                        <Row label="state" value={readout.clock.state} />
                        <Row label="frozen" value={readout.frozen ? 'yes' : 'no'} />
                        <Row label="generation" value={String(readout.clock.generation)} />
                        <Row label="playback" value={`${readout.clock.playbackTime.toFixed(2)}s`} />
                        <Row label="context" value={readout.contextState} />
                        <Row label="latency" value={`${(readout.latencySeconds * 1000).toFixed(1)}ms`} />
                        <Row label="frame" value={`${readout.frameTimeMs.toFixed(1)}ms`} />
                        <Row label="analysis" value={readout.flatlined ? 'flatlined' : 'live'} />
                        <Row label="passes" value={String(readout.render?.passesExecuted ?? 0)} />
                        <Row label="targets" value={String(readout.render?.targetsAllocated ?? 0)} />
                        {readout.render && readout.render.skippedPasses > 0 ? (
                            <Row label="skipped" value={String(readout.render.skippedPasses)} />
                        ) : null}
                        {readout.performance ? (
                            <>
                                <Row
                                    label="quality"
                                    value={`L${readout.performance.level}${readout.performance.profile.suspended ? ' suspended' : ''}`}
                                />
                                <Row label="scale" value={readout.performance.profile.renderScale.toFixed(2)} />
                                {readout.performance.bufferConstrained ? (
                                    <Row label="buffer" value="constrained" />
                                ) : null}
                            </>
                        ) : null}
                        {readout.scene ? (
                            <>
                                <Row label="theme" value={readout.scene.themeId} />
                                <Row label="seed" value={readout.scene.seed} />
                            </>
                        ) : null}
                    </dl>

                    {readout.scene && readout.scene.pluginIds.length > 0 ? (
                        <ul className="viz-debug__plugins">
                            {readout.scene.pluginIds.map((id) => (
                                <li key={id}>{id}</li>
                            ))}
                        </ul>
                    ) : null}

                    <div className="viz-debug__meters">
                        {CONTINUOUS_ORDER.map((name) => (
                            <Meter key={name} label={name} value={readout.bus.continuous[name]} />
                        ))}
                    </div>

                    <p className="viz-debug__note">
                        onsets {readout.bus.events.onset.length} · beats {readout.bus.events.beat.length}
                    </p>
                </>
            ) : null}
        </aside>
    );
}

function describeRenderFailure(failure: RendererFailure): string {
    switch (failure) {
        case 'no-webgl2':
            return 'The canvas could not provide a WebGL2 context.';
        case 'no-float-render-targets':
            return 'Floating-point render targets are unavailable.';
        case 'invalid-scene':
            return 'The scene graph failed validation; see the console for details.';
    }
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </>
    );
}

/** Signed features render from the centre; unsigned from the left. */
function Meter({ label, value }: { label: string; value: number }) {
    const signed = label === 'stereoBalance';
    const magnitude = Math.min(100, Math.abs(value) * (signed ? 50 : 100));
    const offset = signed ? (value >= 0 ? 50 : 50 - magnitude) : 0;

    return (
        <div className="viz-debug__meter">
            <span className="viz-debug__meter-label">{label}</span>
            <span className="viz-debug__meter-track">
                <span
                    className="viz-debug__meter-fill"
                    style={{ left: `${offset}%`, width: `${magnitude}%` }}
                />
            </span>
            <span className="viz-debug__meter-value">{value.toFixed(2)}</span>
        </div>
    );
}
