/**
 * Temporary M0 readout, reached with `?viz-debug=1`.
 *
 * Exists to verify by ear that features track audible music across pause, seek, buffering, and track
 * change. The full section 23 diagnostics overlay replaces it in M6.
 */

import { useState } from 'react';
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

    const { availability, readout } = useKernelReadout(
        {
            getAudioElement: player.getAudioElement,
            trackId: player.selectedTrack?.trackId ?? null,
            trackDurationSeconds: player.selectedTrack?.durationSeconds ?? 0,
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
                    </dl>

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
