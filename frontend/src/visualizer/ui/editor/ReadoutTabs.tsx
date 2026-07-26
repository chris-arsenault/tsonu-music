/**
 * The numbers the kernel reports, as the dock's non-graph tabs.
 *
 * Purely presentational: this reports on the kernel the modal is already running rather than owning
 * one, because diagnostics that describe a second visualizer in a second GL context describe the
 * wrong thing.
 */

import type { ReactNode } from 'react';
import { formatBytes } from '../../core/diagnostics';
import { describeFault, describeTier, selectTier, type VisualizerFault } from '../../core/fallback';
import type { KernelReadout } from '../../host/kernel-loop';

const FEATURE_ORDER = [
    'rms', 'peak', 'transient',
    'subBass', 'bass', 'lowMid', 'mid', 'highMid', 'treble',
    'rmsExcite', 'subBassExcite', 'bassExcite', 'lowMidExcite', 'midExcite', 'highMidExcite',
    'trebleExcite',
    'spectralCentroid', 'spectralFlux', 'beatConfidence', 'beatPhase',
    'leftLevel', 'rightLevel', 'stereoBalance',
] as const;

export function MetersTab({ readout }: { readout: KernelReadout }) {
    return (
        <div className="viz-editor__scroll">
            <div className="viz-debug__meters">
                {FEATURE_ORDER.map((name) => (
                    <Meter key={name} label={name} value={readout.bus.continuous[name]} />
                ))}
            </div>
        </div>
    );
}

export function PerformanceTab({
    readout,
    faults,
}: {
    readout: KernelReadout;
    faults: readonly VisualizerFault[];
}) {
    return (
        <div className="viz-editor__scroll">
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
                <Row label="path" value={readout.analysisPath} />
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
                <Row label="targets" value={String(readout.render?.targetsAllocated ?? 0)} />
                <Row label="downgrades" value={String(readout.performance?.downgrades ?? 0)} />
                <Row
                    label="buffer"
                    value={readout.performance?.bufferConstrained ? 'constrained' : 'healthy'}
                />
            </Section>

            <Section title="Composition">
                <Row label="theme" value={readout.scene?.themeId ?? '—'} />
                <Row label="layers" value={String(readout.scene?.layerCount ?? 0)} />
                <Row label="branches" value={String(readout.scene?.materialBranchCount ?? 0)} />
                <Row label="modulators" value={String(readout.scene?.activeModulatorCount ?? 0)} />
                <Row
                    label="persistence"
                    value={`${(readout.scene?.survivalPerSecond ?? 0).toFixed(3)}/s`}
                />
                <Row label="drag" value={`${(readout.scene?.motionScale ?? 0).toFixed(3)} uv/s`} />
                <Row label="mutation" value={readout.scene?.lastMutation ?? 'none'} />
                <Row label="assets" value={String(readout.scene?.assets.length ?? 0)} />
            </Section>

            <Section title="GPU">
                <Row label="float targets" value={readout.gpu?.floatRenderTargets ? 'yes' : 'no'} />
                <Row label="max texture" value={String(readout.gpu?.maxTextureSize ?? 0)} />
                <Row label="pixel ratio" value={(readout.gpu?.maxPixelRatio ?? 1).toFixed(2)} />
                <Row
                    label="render"
                    value={`${readout.gpu?.renderWidth ?? 0}x${readout.gpu?.renderHeight ?? 0}`}
                />
                <Row label="textures" value={formatBytes(readout.scene?.estimatedTextureBytes ?? 0)} />
                <Row label="tier" value={describeTier(selectTier(faults))} />
            </Section>

            {readout.render && readout.render.problems.length > 0 ? (
                <details className="viz-diagnostics__details" open>
                    <summary>Problems ({readout.render.problems.length})</summary>
                    <ul className="viz-debug__reasons">
                        {readout.render.problems.map((problem) => <li key={problem}>{problem}</li>)}
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
        </div>
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
