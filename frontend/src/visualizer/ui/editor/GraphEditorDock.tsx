/**
 * The editor's dock: the surface below the canvas, and the one place the kernel is inspected from.
 *
 * Capture freezes whatever the scheduler put on screen into a document and hands the graph to it.
 * From there the scene holds still — no mutation, no rebuild on a track change, no quality
 * suppression — and can be examined a node at a time. Release hands it back.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildEditorView, type EditorNode } from '../../core/editor-view';
import { togglePluginDisabled, type DiagnosticsControls } from '../../core/diagnostics';
import type { VisualizerFault } from '../../core/fallback';
import { resolveAuthoredScene, type AuthoredScene } from '../../core/authored-scene';
import { createM1Registry } from '../../plugins/registry';
import type { KernelControlHandle, KernelReadout } from '../../host/kernel-loop';
import { useEditorStyles } from './editor-styles';
import { MetersTab, PerformanceTab } from './ReadoutTabs';

/**
 * The same catalog the running kernel registered.
 *
 * Built here rather than passed in: the plugin definitions are already in this chunk's graph because
 * the kernel loaded them, and threading a registry through the player would put the whole catalog in
 * the panel's chunk for the sake of a surface behind a debug flag.
 */
const REGISTRY = createM1Registry();

// Its own chunk: React Flow is carried only by a session that opens the graph.
const GraphCanvas = lazy(() => import('./GraphCanvas'));

const MIN_HEIGHT = 140;
const MAX_HEIGHT_FRACTION = 0.75;
const DEFAULT_HEIGHT = 340;
const HEIGHT_KEY = 'viz-editor-height';

type Tab = 'graph' | 'meters' | 'performance';

export interface GraphEditorDockProps {
    readout: KernelReadout;
    faults: readonly VisualizerFault[];
    controls: DiagnosticsControls;
    onControls: (controls: DiagnosticsControls) => void;
    handle?: KernelControlHandle;
    onClose: () => void;
}

export default function GraphEditorDock({
    readout,
    faults,
    controls,
    onControls,
    handle,
    onClose,
}: GraphEditorDockProps) {
    const registry = REGISTRY;

    useEditorStyles();

    const [tab, setTab] = useState<Tab>('graph');
    const [height, setHeight] = useState(initialHeight);
    const [document_, setDocument] = useState<AuthoredScene | undefined>();
    const [selected, setSelected] = useState<string | undefined>();

    // The document the kernel is actually running, which after a capture is the one below. Read from
    // the readout rather than assumed, so what is drawn is what is rendering.
    const live = readout.scene?.authored;
    const problems = readout.scene?.problems ?? [];

    const capture = useCallback(() => {
        const captured = handle?.captureScene();
        if (!captured) {
            return;
        }

        setDocument(captured);
        const failures = handle?.setAuthoredScene(captured) ?? [];
        if (failures.length === 0) {
            onControls({ ...controls, authoring: true });
        }
    }, [handle, controls, onControls]);

    const release = useCallback(() => {
        handle?.clearAuthoredScene();
        setDocument(undefined);
        setSelected(undefined);
        onControls({ ...controls, authoring: false, inspectResource: undefined });
    }, [handle, controls, onControls]);

    // Selecting a node routes its resource to the whole canvas. One at a time, through the same
    // control the resource picker has always used.
    const onSelect = useCallback((node: EditorNode | undefined) => {
        setSelected(node?.id);
        onControls({ ...controls, inspectResource: node?.inspect });
    }, [controls, onControls]);

    // Resolved here rather than read from the kernel: the compiled graph is what the layer stack and
    // the motion bus are derived from, and compiling a dozen nodes is nothing. Memoised on the
    // document alone, so the twelve-a-second readout does not recompile it.
    const resolved = useMemo(
        () => (document_ ? resolveAuthoredScene(document_, registry) : undefined),
        [document_, registry],
    );

    const view = useMemo(() => (document_ && resolved
        ? buildEditorView({
            document: document_,
            registry,
            graph: resolved.ok ? resolved.scene.graph : undefined,
            live: readout.scene?.parameters,
            problems: resolved.ok ? resolved.warnings : resolved.problems,
        })
        : undefined), [document_, registry, resolved, readout.scene?.parameters]);

    const grip = useDragHeight(height, setHeight);

    const selectedNode = view?.nodes.find((node) => node.id === selected);

    return (
        <aside className="viz-editor" style={{ height }} aria-label="Visualizer graph editor">
            <div className="viz-editor__grip" {...grip} role="separator" aria-orientation="horizontal" />

            <div className="viz-editor__bar">
                <div className="viz-editor__tabs">
                    {(['graph', 'meters', 'performance'] as const).map((name) => (
                        <button
                            key={name}
                            type="button"
                            className={`viz-editor__tab${tab === name ? ' is-active' : ''}`}
                            onClick={() => setTab(name)}
                            aria-pressed={tab === name}
                        >
                            {name}
                        </button>
                    ))}
                </div>

                {tab === 'graph' ? (
                    <>
                        {live ? (
                            <>
                                <button type="button" className="viz-editor__action is-live" onClick={release}>
                                    Release to scheduler
                                </button>
                                <span className="viz-editor__note">
                                    {view?.nodes.length ?? 0} nodes · scene held
                                </span>
                            </>
                        ) : (
                            <>
                                <button type="button" className="viz-editor__action" onClick={capture}>
                                    Capture scene
                                </button>
                                <button
                                    type="button"
                                    className="viz-editor__action"
                                    onClick={() => handle?.newScene()}
                                    title="Discard this composition and generate a fresh random scene"
                                >
                                    New scene
                                </button>
                            </>
                        )}

                        {selectedNode ? (
                            <>
                                <span className="viz-editor__note">
                                    {selectedNode.inspect
                                        ? `showing ${selectedNode.inspect}`
                                        : `${selectedNode.title} — nothing to show alone`}
                                </span>
                                {selectedNode.kind === 'plugin' ? (
                                    <button
                                        type="button"
                                        className="viz-editor__action"
                                        onClick={() => onControls(
                                            togglePluginDisabled(controls, selectedNode.id),
                                        )}
                                    >
                                        {controls.disabledPlugins.includes(selectedNode.id)
                                            ? 'Unmute'
                                            : 'Mute'}
                                    </button>
                                ) : null}
                            </>
                        ) : null}

                        {problems.length > 0 ? (
                            <span className="viz-editor__note is-problem">
                                {problems.length} problem{problems.length === 1 ? '' : 's'}
                            </span>
                        ) : null}
                    </>
                ) : null}

                <span className="viz-editor__spacer" />

                <label className="viz-editor__note">
                    <input
                        type="checkbox"
                        checked={controls.freezeSimulation}
                        onChange={(event) => onControls({
                            ...controls,
                            freezeSimulation: event.currentTarget.checked,
                        })}
                    />
                    {' '}freeze simulation
                </label>
                <label className="viz-editor__note">
                    <input
                        type="checkbox"
                        checked={controls.freezeMutations}
                        onChange={(event) => onControls({
                            ...controls,
                            freezeMutations: event.currentTarget.checked,
                        })}
                    />
                    {' '}freeze mutations
                </label>

                <button type="button" className="viz-editor__action" onClick={onClose}>×</button>
            </div>

            <div className="viz-editor__body">
                {tab === 'meters' ? <MetersTab readout={readout} /> : null}
                {tab === 'performance' ? <PerformanceTab readout={readout} faults={faults} /> : null}
                {tab === 'graph' ? (
                    view ? (
                        <Suspense fallback={<div className="viz-editor__empty">loading canvas…</div>}>
                            <GraphCanvas view={view} selectedId={selected} onSelect={onSelect} />
                        </Suspense>
                    ) : (
                        <div className="viz-editor__empty">
                            Capture the running scene to see its graph — every plugin, the layer stack
                            and motion bus that no other view shows, and the kernel stages between them
                            and the canvas.
                        </div>
                    )
                ) : null}
            </div>
        </aside>
    );
}

function initialHeight(): number {
    if (typeof window === 'undefined') {
        return DEFAULT_HEIGHT;
    }

    const stored = Number(window.localStorage?.getItem(HEIGHT_KEY));
    return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT;
}

/**
 * Drag-to-resize on the grip.
 *
 * The height is committed to storage on release rather than on every move, so a drag does not write
 * once per frame.
 */
function useDragHeight(height: number, setHeight: (value: number) => void) {
    const dragging = useRef<{ startY: number; startHeight: number } | undefined>(undefined);

    useEffect(() => {
        const onMove = (event: PointerEvent) => {
            if (!dragging.current) {
                return;
            }

            const limit = window.innerHeight * MAX_HEIGHT_FRACTION;
            const next = dragging.current.startHeight + (dragging.current.startY - event.clientY);
            setHeight(Math.max(MIN_HEIGHT, Math.min(limit, next)));
        };

        const onUp = () => {
            if (!dragging.current) {
                return;
            }

            dragging.current = undefined;
            window.localStorage?.setItem(HEIGHT_KEY, String(height));
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);

        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [height, setHeight]);

    return {
        onPointerDown: (event: { clientY: number }) => {
            dragging.current = { startY: event.clientY, startHeight: height };
        },
    };
}
