/**
 * Diagnostics panel (spec section 23), shown inside the visualizer modal.
 *
 * Purely presentational: it reports on the kernel the modal is already running and drives that kernel's
 * controls. It deliberately owns no kernel of its own, because diagnostics that describe a second
 * visualizer running in a second GL context describe the wrong thing.
 */

import type { ReactNode } from 'react';
import {
    formatBytes,
    togglePluginDisabled,
    type DiagnosticsControls,
} from '../core/diagnostics';
import { describeFault, describeTier, selectTier, type VisualizerFault } from '../core/fallback';
import type { KernelControlHandle, KernelReadout } from '../host/kernel-loop';

const FEATURE_ORDER = [
    'rms', 'peak', 'subBass', 'bass', 'lowMid', 'mid', 'highMid', 'treble',
    'spectralCentroid', 'spectralFlux', 'beatConfidence', 'beatPhase',
    'leftLevel', 'rightLevel', 'stereoBalance',
] as const;

export interface DiagnosticsPanelProps {
    readout: KernelReadout;
    faults: readonly VisualizerFault[];
    controls: DiagnosticsControls;
    onControls: (controls: DiagnosticsControls) => void;
    handle?: KernelControlHandle;
    onClose: () => void;
}

export default function DiagnosticsPanel({
    readout,
    faults,
    controls,
    onControls,
    handle,
    onClose,
}: DiagnosticsPanelProps) {
    return (
        <aside className="viz-diagnostics" aria-label="Visualizer diagnostics">
            <header className="viz-diagnostics__header">
                <strong>Diagnostics</strong>
                <button type="button" onClick={onClose} aria-label="Close diagnostics">×</button>
            </header>

            <div className="viz-diagnostics__body">
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

                <Section title="Performance">
                    <Row label="level" value={`L${readout.performance?.level ?? 0}`} />
                    <Row label="scale" value={(readout.performance?.profile.renderScale ?? 1).toFixed(2)} />
                    <Row label="frame" value={`${readout.frameTimeMs.toFixed(1)}ms`} />
                    <Row label="passes" value={String(readout.render?.passesExecuted ?? 0)} />
                    <Row label="skipped" value={String(readout.render?.skippedPasses ?? 0)} />
                    <Row label="suppressed" value={String(readout.render?.suppressedPlugins ?? 0)} />
                    <Row label="compiling" value={String(readout.render?.pendingShaders ?? 0)} />
                    <Row label="layers" value={String(readout.scene?.layerCount ?? 0)} />
                    <Row label="branches" value={String(readout.scene?.materialBranchCount ?? 0)} />
                    <Row label="modulators" value={String(readout.scene?.activeModulatorCount ?? 0)} />
                    <Row
                        label="persistence"
                        value={`${(readout.scene?.survivalPerSecond ?? 0).toFixed(3)}/s`}
                    />
                    <Row label="drag" value={`${(readout.scene?.motionScale ?? 0).toFixed(3)} uv/s`} />
                    <Row label="mutation" value={readout.scene?.lastMutation ?? 'none'} />
                    <Row label="targets" value={String(readout.render?.targetsAllocated ?? 0)} />
                    <Row label="downgrades" value={String(readout.performance?.downgrades ?? 0)} />
                    <Row label="buffer" value={readout.performance?.bufferConstrained ? 'constrained' : 'healthy'} />
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
                    <Row label="assets" value={String(readout.scene?.assets.length ?? 0)} />
                    <Row label="tier" value={describeTier(selectTier(faults))} />
                </Section>

                <details className="viz-diagnostics__details">
                    <summary>Features</summary>
                    <div className="viz-debug__meters">
                        {FEATURE_ORDER.map((name) => (
                            <Meter key={name} label={name} value={readout.bus.continuous[name]} />
                        ))}
                    </div>
                </details>

                {readout.render && readout.render.problems.length > 0 ? (
                    <details className="viz-diagnostics__details" open>
                        <summary>Shader errors ({readout.render.problems.length})</summary>
                        <ul className="viz-debug__reasons">
                            {readout.render.problems.map((problem) => <li key={problem}>{problem}</li>)}
                        </ul>
                    </details>
                ) : null}

                {readout.scene && readout.scene.instanceIds.length > 0 ? (
                    <details className="viz-diagnostics__details">
                        <summary>Plugins ({readout.scene.instanceIds.length})</summary>
                        <ul className="viz-debug__plugins">
                            {readout.scene.instanceIds.map((instanceId) => (
                                <li key={instanceId}>
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={!controls.disabledPlugins.includes(instanceId)}
                                            onChange={() => onControls(togglePluginDisabled(controls, instanceId))}
                                        />
                                        <span>{instanceId}</span>
                                    </label>
                                </li>
                            ))}
                        </ul>
                    </details>
                ) : null}

                {readout.scene && readout.scene.edges.length > 0 ? (
                    <details className="viz-diagnostics__details">
                        <summary>Graph ({readout.scene.edges.length} edges)</summary>
                        <ul className="viz-debug__plugins">
                            {readout.scene.edges.map((edge) => <li key={edge}>{edge}</li>)}
                        </ul>
                    </details>
                ) : null}

                {readout.scene && readout.scene.activationHistory.length > 0 ? (
                    <details className="viz-diagnostics__details">
                        <summary>Activation history ({readout.scene.activationHistory.length})</summary>
                        <ul className="viz-debug__plugins">
                            {readout.scene.activationHistory.map((entry, index) => (
                                <li key={`${entry}-${index}`}>{entry}</li>
                            ))}
                        </ul>
                    </details>
                ) : null}

                {faults.length > 0 ? (
                    <ul className="viz-debug__reasons">
                        {faults.map((fault) => <li key={fault}>{describeFault(fault)}</li>)}
                    </ul>
                ) : null}

                <h3 className="viz-diagnostics__controls-heading">Controls</h3>

                <label className="viz-debug__control">
                    <input
                        type="checkbox"
                        checked={controls.freezeMutations}
                        onChange={(event) => onControls({ ...controls, freezeMutations: event.currentTarget.checked })}
                    />
                    <span>Freeze scheduler mutations</span>
                </label>

                <label className="viz-debug__control">
                    <input
                        type="checkbox"
                        checked={controls.freezeSimulation}
                        onChange={(event) => onControls({ ...controls, freezeSimulation: event.currentTarget.checked })}
                    />
                    <span>Freeze simulation (audio continues)</span>
                </label>

                <label className="viz-debug__control">
                    <span>Inspect</span>
                    <select
                        value={controls.inspectResource ?? ''}
                        onChange={(event) => onControls({
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
                    <button
                        type="button"
                        title="Discard this composition and generate a fresh random scene"
                        onClick={() => handle?.newScene()}
                    >
                        New scene
                    </button>
                </div>
                <p className="viz-debug__control-help">
                    Discards the current composition and generates a fresh random scene.
                </p>
            </div>
        </aside>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
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
