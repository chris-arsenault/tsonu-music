/**
 * Diagnostics overlay (spec section 23), reached with `?viz-debug=1`.
 *
 * Replaces the temporary M0 readout. Reports the full section 23 surface and carries the controls most
 * section 26 criteria are actually checked with: reproduce a scene from its seed, disable one plugin,
 * freeze mutation while audio continues, inspect an intermediate target.
 */

import { useCallback, useState } from 'react';
import { useMusicPlayer } from '../../music/MusicPlayerContext';
import {
    createDiagnosticsControls,
    formatBytes,
    togglePluginDisabled,
    type DiagnosticsControls,
} from '../core/diagnostics';
import { collectFaults, describeFault, describeTier, selectTier } from '../core/fallback';
import { describeUnavailableReason } from '../host/capabilities';
import { useKernelReadout } from './use-kernel-readout';

const FEATURE_ORDER = [
    'rms', 'peak', 'subBass', 'bass', 'lowMid', 'mid', 'highMid', 'treble',
    'spectralCentroid', 'spectralFlux', 'beatConfidence', 'beatPhase',
    'leftLevel', 'rightLevel', 'stereoBalance',
] as const;

export default function DiagnosticsOverlay() {
    const player = useMusicPlayer();
    const [active, setActive] = useState(false);
    const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
    const [controls, setControls] = useState<DiagnosticsControls>(createDiagnosticsControls);
    const [seedInput, setSeedInput] = useState('');

    const { availability, readout, handle } = useKernelReadout(
        {
            getAudioElement: player.getAudioElement,
            trackId: player.selectedTrack?.trackId ?? null,
            trackDurationSeconds: player.selectedTrack?.durationSeconds ?? 0,
            canvas,
            getBufferHealth: player.getBufferHealth,
            artworkSrc: player.artworkSrc,
            controls,
        },
        active,
    );

    const update = useCallback((next: DiagnosticsControls) => {
        setControls(next);
    }, []);

    const faults = readout
        ? collectFaults({
            webgl2Available: readout.renderFailure !== 'no-webgl2',
            floatRenderTargets: readout.gpu?.floatRenderTargets ?? true,
            contextLost: false,
            shaderErrorCount: readout.render?.problems.length ?? 0,
            analysisFlatlined: readout.flatlined,
            audioContextState: readout.contextState,
            graphValid: readout.renderFailure !== 'invalid-scene',
            canvasWidth: readout.gpu?.renderWidth ?? 1,
            canvasHeight: readout.gpu?.renderHeight ?? 1,
            performanceSuspended: readout.performance?.profile.suspended ?? false,
            prefersReducedMotion: availability?.prefersReducedMotion ?? false,
        })
        : [];

    return (
        <aside className="viz-debug" aria-label="Visualizer diagnostics">
            <header className="viz-debug__header">
                <strong>Visualizer diagnostics</strong>
                <label className="viz-debug__toggle">
                    <input
                        type="checkbox"
                        checked={active}
                        disabled={availability !== undefined && !availability.available}
                        onChange={(event) => setActive(event.currentTarget.checked)}
                    />
                    <span>Run</span>
                </label>
            </header>

            {availability && !availability.available ? (
                <ul className="viz-debug__reasons">
                    {availability.reasons.map((reason) => (
                        <li key={reason}>{describeUnavailableReason(reason)}</li>
                    ))}
                </ul>
            ) : null}

            {active ? <canvas className="viz-debug__canvas" ref={setCanvas} /> : null}
            {active && !readout ? <p className="viz-debug__note">Starting…</p> : null}

            {readout ? (
                <>
                    <Section title="Playback">
                        <Row label="state" value={readout.clock.state} />
                        <Row label="frozen" value={readout.frozen ? 'yes' : 'no'} />
                        <Row label="generation" value={String(readout.clock.generation)} />
                        <Row label="position" value={`${readout.clock.playbackTime.toFixed(2)}s`} />
                        <Row label="duration" value={`${readout.clock.duration.toFixed(0)}s`} />
                    </Section>

                    <Section title="Audio">
                        <Row label="context" value={readout.contextState} />
                        <Row label="latency" value={`${(readout.latencySeconds * 1000).toFixed(1)}ms`} />
                        <Row label="analysis" value={readout.flatlined ? 'flatlined' : 'live'} />
                        <Row label="onsets" value={String(readout.bus.events.onset.length)} />
                        <Row label="beats" value={String(readout.bus.events.beat.length)} />
                    </Section>

                    <Section title="Features">
                        <div className="viz-debug__meters">
                            {FEATURE_ORDER.map((name) => (
                                <Meter key={name} label={name} value={readout.bus.continuous[name]} />
                            ))}
                        </div>
                    </Section>

                    <Section title="Performance">
                        <Row label="level" value={`L${readout.performance?.level ?? 0}`} />
                        <Row label="scale" value={(readout.performance?.profile.renderScale ?? 1).toFixed(2)} />
                        <Row label="frame" value={`${readout.frameTimeMs.toFixed(1)}ms`} />
                        <Row label="passes" value={String(readout.render?.passesExecuted ?? 0)} />
                        <Row label="targets" value={String(readout.render?.targetsAllocated ?? 0)} />
                        <Row label="downgrades" value={String(readout.performance?.downgrades ?? 0)} />
                        <Row label="buffer" value={readout.performance?.bufferConstrained ? 'constrained' : 'healthy'} />
                        <Row label="suspended" value={readout.performance?.profile.suspended ? 'yes' : 'no'} />
                    </Section>

                    <Section title="GPU">
                        <Row label="float targets" value={readout.gpu?.floatRenderTargets ? 'yes' : 'no'} />
                        <Row label="max texture" value={String(readout.gpu?.maxTextureSize ?? 0)} />
                        <Row label="pixel ratio" value={(readout.gpu?.maxPixelRatio ?? 1).toFixed(2)} />
                        <Row label="render" value={`${readout.gpu?.renderWidth ?? 0}x${readout.gpu?.renderHeight ?? 0}`} />
                        <Row label="textures" value={formatBytes(readout.scene?.estimatedTextureBytes ?? 0)} />
                    </Section>

                    <Section title="Scene">
                        <Row label="theme" value={readout.scene?.themeId ?? '—'} />
                        <Row label="seed" value={readout.scene?.seed ?? '—'} />
                        <Row label="assets" value={String(readout.scene?.assets.length ?? 0)} />
                        <Row label="tier" value={describeTier(selectTier(faults))} />
                    </Section>

                    {readout.scene && readout.scene.edges.length > 0 ? (
                        <details className="viz-debug__details">
                            <summary>Graph ({readout.scene.edges.length} edges)</summary>
                            <ul className="viz-debug__plugins">
                                {readout.scene.edges.map((edge) => <li key={edge}>{edge}</li>)}
                            </ul>
                        </details>
                    ) : null}

                    {readout.scene && readout.scene.instanceIds.length > 0 ? (
                        <details className="viz-debug__details" open>
                            <summary>Plugins ({readout.scene.instanceIds.length})</summary>
                            <ul className="viz-debug__plugins">
                                {readout.scene.instanceIds.map((instanceId) => (
                                    <li key={instanceId}>
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={!controls.disabledPlugins.includes(instanceId)}
                                                onChange={() => update(togglePluginDisabled(controls, instanceId))}
                                            />
                                            <span>{instanceId}</span>
                                        </label>
                                    </li>
                                ))}
                            </ul>
                        </details>
                    ) : null}

                    {readout.scene && readout.scene.activationHistory.length > 0 ? (
                        <details className="viz-debug__details">
                            <summary>Activation history ({readout.scene.activationHistory.length})</summary>
                            <ul className="viz-debug__plugins">
                                {readout.scene.activationHistory.map((entry, index) => (
                                    <li key={`${entry}-${index}`}>{entry}</li>
                                ))}
                            </ul>
                        </details>
                    ) : null}

                    {readout.render && readout.render.problems.length > 0 ? (
                        <details className="viz-debug__details" open>
                            <summary>Shader errors ({readout.render.problems.length})</summary>
                            <ul className="viz-debug__reasons">
                                {readout.render.problems.map((problem) => <li key={problem}>{problem}</li>)}
                            </ul>
                        </details>
                    ) : null}

                    {faults.length > 0 ? (
                        <ul className="viz-debug__reasons">
                            {faults.map((fault) => <li key={fault}>{describeFault(fault)}</li>)}
                        </ul>
                    ) : null}

                    <Section title="Controls">
                        <label className="viz-debug__control">
                            <input
                                type="checkbox"
                                checked={controls.freezeMutations}
                                onChange={(event) => update({ ...controls, freezeMutations: event.currentTarget.checked })}
                            />
                            <span>Freeze scheduler mutations</span>
                        </label>
                        <label className="viz-debug__control">
                            <input
                                type="checkbox"
                                checked={controls.freezeSimulation}
                                onChange={(event) => update({ ...controls, freezeSimulation: event.currentTarget.checked })}
                            />
                            <span>Freeze simulation (audio continues)</span>
                        </label>

                        <label className="viz-debug__control">
                            <span>Inspect</span>
                            <select
                                value={controls.inspectResource ?? ''}
                                onChange={(event) => update({
                                    ...controls,
                                    inspectResource: event.currentTarget.value || undefined,
                                })}
                            >
                                <option value="">Composed output</option>
                                {(readout.scene?.resourceIds ?? []).map((resource) => (
                                    <option key={resource} value={resource}>{resource}</option>
                                ))}
                            </select>
                        </label>

                        <div className="viz-debug__control">
                            <input
                                type="text"
                                value={seedInput}
                                placeholder={readout.scene?.seed ?? 'seed'}
                                onChange={(event) => setSeedInput(event.currentTarget.value)}
                                aria-label="Scene seed"
                            />
                            <button
                                type="button"
                                onClick={() => handle?.reproduceSeed(seedInput || (readout.scene?.seed ?? ''))}
                            >
                                Reproduce
                            </button>
                            <button type="button" onClick={() => handle?.rebuildCurrent()}>
                                Rebuild
                            </button>
                        </div>
                    </Section>
                </>
            ) : null}
        </aside>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="viz-debug__section">
            <h3>{title}</h3>
            <dl className="viz-debug__grid">{children}</dl>
        </section>
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
                <span className="viz-debug__meter-fill" style={{ left: `${offset}%`, width: `${magnitude}%` }} />
            </span>
            <span className="viz-debug__meter-value">{value.toFixed(2)}</span>
        </div>
    );
}
