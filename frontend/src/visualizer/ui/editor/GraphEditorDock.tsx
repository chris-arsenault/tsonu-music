/**
 * The editor's dock: the surface below the canvas, and the one place the kernel is inspected from.
 *
 * Capture freezes whatever the scheduler put on screen into a document and hands the graph to it.
 * From there the scene holds still — no mutation, no rebuild on a track change, no quality
 * suppression — and can be examined a node at a time. Release hands it back.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ACCUMULATE_NODE,
    buildEditorView,
    driverTarget,
    GRADE_NODE,
    type EditorNode,
} from '../../core/editor-view';
import { togglePluginDisabled, type DiagnosticsControls } from '../../core/diagnostics';
import type { VisualizerFault } from '../../core/fallback';
import { resolveAuthoredScene, type AuthoredScene } from '../../core/authored-scene';
import {
    applyConnect,
    applyDisconnect,
    type CanvasEndpoint,
} from '../../core/editor-actions';
import {
    addNode,
    cloneNode,
    coalesce,
    commit,
    createHistory,
    freeNodeId,
    canRedo,
    canUndo,
    redo,
    removeBinding,
    removeNode,
    setBinding,
    setLayerOverride,
    setMuted,
    setParameter,
    setPersistencePin,
    setPosition,
    setPromoted,
    setGradeParameter,
    setGradeBinding,
    removeGradeBinding,
    setSeed,
    undo,
    type DocumentHistory,
    type PluginLookup,
} from '../../core/authored-scene-edit';
import type { ParameterBinding } from '../../core/bindings';
import type { PersistenceOverrides } from '../../core/persistence';
import type { PortType, VisualPluginDefinition } from '../../core/plugin';
import { createM1Registry } from '../../plugins/registry';
import type { KernelControlHandle, KernelReadout } from '../../host/kernel-loop';
import { useEditorStyles } from './editor-styles';
import Inspector from './Inspector';
import NodeSearch from './NodeSearch';
import { MetersTab, PerformanceTab } from './ReadoutTabs';
import {
    copyFixture,
    downloadScene,
    loadStoredScene,
    readSceneFile,
    storeScene,
} from './scene-storage';

/**
 * The same catalog the running kernel registered.
 *
 * Built here rather than passed in: the plugin definitions are already in this chunk's graph because
 * the kernel loaded them, and threading a registry through the player would put the whole catalog in
 * the public panel's chunk for the sake of a surface mounted only by the Lab.
 */
const REGISTRY = createM1Registry();

// Its own chunk: React Flow is carried only by a session that opens the graph.
const GraphCanvas = lazy(() => import('./GraphCanvas'));

const MIN_HEIGHT = 140;
const MAX_HEIGHT_FRACTION = 0.75;
const DEFAULT_HEIGHT = 340;
const HEIGHT_KEY = 'viz-editor-height';

type Tab = 'graph' | 'meters' | 'performance';

interface Point { x: number; y: number }

/** An open search box: where it was opened, and the link that opened it, if any. */
interface SearchRequest {
    at: Point;
    from?: CanvasEndpoint;
    acceptingType?: PortType;
}

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
    const [history, setHistory] = useState<DocumentHistory | undefined>();
    const [selected, setSelected] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();
    const [search, setSearch] = useState<SearchRequest | undefined>();
    const fileInput = useRef<HTMLInputElement | null>(null);
    const project = useRef<((point: Point) => Point) | undefined>(undefined);

    const document_ = history?.present;

    // Whatever was open last time. Offered rather than applied: reopening the dock should not silently
    // take the graph away from the scheduler.
    const [stored] = useState(() => loadStoredScene());

    // The document the kernel is actually running, which after a capture is the one below. Read from
    // the readout rather than assumed, so what is drawn is what is rendering.
    const live = readout.scene?.authored;
    const problems = readout.scene?.problems ?? [];
    const editable = Boolean(live);

    /** Hands a document to the kernel and starts a fresh history at it. */
    const apply = useCallback((next: AuthoredScene, note?: string) => {
        setHistory(createHistory(next));

        const failures = handle?.setAuthoredScene(next) ?? [];
        if (failures.length > 0) {
            setNotice(failures[0].detail);
            return false;
        }

        onControls({ ...controls, authoring: true });
        setNotice(note);
        return true;
    }, [handle, controls, onControls]);

    /**
     * Records an edit and hands the result to the kernel.
     *
     * `hot` is for a change the kernel can take without recompiling — a parameter or a binding on a
     * live instance — which is what lets a value be dragged while watching what it does. Everything
     * else goes through `setAuthoredScene`, which recompiles but preserves the instances the edit did
     * not touch. `presentation` never reaches the kernel at all: a node's position changes the picture
     * and nothing else.
     */
    const edit = useCallback((
        next: AuthoredScene | undefined,
        options: { hot?: () => void; presentation?: boolean; coalesce?: boolean } = {},
    ) => {
        if (!next) {
            return;
        }

        setHistory((current) => {
            const base = current ?? createHistory(next);
            return options.coalesce ? coalesce(base, next) : commit(base, next);
        });

        if (options.presentation) {
            return;
        }

        if (options.hot) {
            options.hot();
            return;
        }

        const failures = handle?.setAuthoredScene(next) ?? [];
        setNotice(failures.length > 0 ? failures[0].detail : undefined);
    }, [handle]);

    const capture = useCallback(() => {
        const captured = handle?.captureScene();
        if (captured) {
            apply(captured);
        }
    }, [handle, apply]);

    const release = useCallback(() => {
        handle?.clearAuthoredScene();
        setHistory(undefined);
        setSelected(undefined);
        setNotice(undefined);
        setSearch(undefined);
        onControls({ ...controls, authoring: false, inspectResource: undefined });
    }, [handle, controls, onControls]);

    /**
     * Steps the history and re-applies whatever it lands on.
     *
     * Through `setAuthoredScene` rather than the hot paths, because a step may cross any kind of edit
     * and the recompile is what makes it safe not to know which.
     */
    const step = useCallback((direction: 'undo' | 'redo') => {
        setHistory((current) => {
            if (!current) {
                return current;
            }

            const next = direction === 'undo' ? undo(current) : redo(current);
            if (next !== current) {
                handle?.setAuthoredScene(next.present);
            }

            return next;
        });
    }, [handle]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (!editable || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') {
                return;
            }

            event.preventDefault();
            step(event.shiftKey ? 'redo' : 'undo');
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [editable, step]);

    const importFile = useCallback(async (file: File | undefined) => {
        if (!file) {
            return;
        }

        const read = await readSceneFile(file);
        if (!read.ok) {
            setNotice(read.problems[0].detail);
            return;
        }

        apply(read.scene, read.warnings.length > 0 ? read.warnings[0].detail : `loaded ${file.name}`);
    }, [apply]);

    const copy = useCallback(() => {
        if (!document_) {
            return;
        }

        void copyFixture(document_).then((where) => setNotice(
            where === 'clipboard' ? 'fixture copied' : 'fixture downloaded',
        ));
    }, [document_]);

    // Autosaved on every change, so a reload does not lose a scene that took a while to find.
    useEffect(() => {
        if (document_) {
            storeScene(document_);
        }
    }, [document_]);

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

    /* -- editing --------------------------------------------------------- */

    const lookup = useCallback<PluginLookup>((pluginId) => registry.get(pluginId), [registry]);

    const editParameter = useCallback((nodeId: string, parameter: string, value: number) => {
        edit(document_ && setParameter(document_, nodeId, parameter, value), {
            hot: () => handle?.setNodeParameter(nodeId, parameter, value),
            coalesce: true,
        });
    }, [document_, edit, handle]);

    const editBinding = useCallback((
        nodeId: string,
        parameter: string,
        binding: ParameterBinding | undefined,
    ) => {
        if (!document_) {
            return;
        }

        const next = binding
            ? setBinding(document_, nodeId, binding, lookup)
            : removeBinding(document_, nodeId, parameter, lookup);
        const node = next.nodes.find((candidate) => candidate.id === nodeId);

        edit(next, { hot: () => handle?.setNodeBindings(nodeId, node?.bindings ?? []) });
    }, [document_, edit, handle, lookup]);

    const editKernel = useCallback((next: AuthoredScene | undefined) => edit(next), [edit]);

    const onMove = useCallback((nodeId: string, position: Point, settled: boolean) => {
        // A drag emits a position per frame. Coalesced until it stops, so undo takes back the drag
        // rather than one frame of it, and it never reaches the kernel because it is not the scene.
        edit(document_ && setPosition(document_, nodeId, position), {
            presentation: true,
            coalesce: !settled,
        });
    }, [document_, edit]);

    const onCanvasConnect = useCallback((from: CanvasEndpoint, to: CanvasEndpoint) => {
        if (!document_ || !view) {
            return;
        }

        edit(applyConnect(document_, view, from, to, lookup));
    }, [document_, view, edit, lookup]);

    const onCanvasDisconnect = useCallback((edgeId: string) => {
        if (!document_ || !view) {
            return;
        }

        const result = applyDisconnect(document_, view, edgeId, lookup);
        if (result.refused) {
            setNotice(result.refused);
            return;
        }

        edit(result.scene);
    }, [document_, view, edit, lookup]);

    /** Adds a node where the pointer is, wiring it up when a link was dropped to get here. */
    const addNodeFromSearch = useCallback((
        definition: VisualPluginDefinition,
        port: string | undefined,
    ) => {
        if (!document_ || !search) {
            return;
        }

        const at = project.current?.(search.at) ?? search.at;
        const id = freeNodeId(document_, definition.id);
        // Plugin defaults, not the theme's overrides: the theme scales a colour plugin's starting
        // value *and* its binding range together, and reproducing half of that would put a node on the
        // canvas that quietly disagrees with the identical one beside it.
        let next = addNode(document_, definition.id, at, id);

        if (search.from && port) {
            next = applyConnect(next, view!, search.from, { node: id, port }, lookup);
        }

        setSearch(undefined);
        edit(next);
    }, [document_, search, view, edit, lookup]);

    /**
     * A parameter edited from the inspector.
     *
     * The kernel tail's three surfaces are each their own thing — accumulation values are pinned or
     * released, the grade's are ordinary parameters, and a driver's row belongs to the node it feeds.
     */
    const onInspectorParameter = useCallback((
        node: EditorNode,
        parameter: string,
        value: number,
    ) => {
        if (node.id === ACCUMULATE_NODE) {
            editKernel(document_ && setPersistencePin(
                document_,
                parameter as keyof PersistenceOverrides,
                value,
            ));
            return;
        }

        if (node.id === GRADE_NODE) {
            editKernel(document_ && setGradeParameter(document_, parameter, value));
            return;
        }

        const target = targetOf(node);
        editParameter(target.node, target.parameter ?? parameter, value);
    }, [document_, editKernel, editParameter]);

    const onInspectorBinding = useCallback((
        node: EditorNode,
        parameter: string,
        binding: ParameterBinding | undefined,
    ) => {
        if (node.id === GRADE_NODE) {
            editKernel(document_ && (binding
                ? setGradeBinding(document_, binding)
                : removeGradeBinding(document_, parameter)));
            return;
        }

        const target = targetOf(node);
        const name = target.parameter ?? parameter;

        editBinding(target.node, name, binding ? { ...binding, parameter: name } : undefined);
    }, [document_, editKernel, editBinding]);

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
                                {stored ? (
                                    <button
                                        type="button"
                                        className="viz-editor__action"
                                        onClick={() => apply(stored, 'restored the last capture')}
                                        title="Reopen the document this editor last had"
                                    >
                                        Restore last
                                    </button>
                                ) : null}
                            </>
                        )}

                        <button
                            type="button"
                            className="viz-editor__action"
                            onClick={() => fileInput.current?.click()}
                            title="Open a scene document from a file"
                        >
                            Import
                        </button>
                        <input
                            ref={fileInput}
                            type="file"
                            accept="application/json,.json"
                            hidden
                            onChange={(event) => {
                                void importFile(event.currentTarget.files?.[0]);
                                // Cleared so choosing the same file twice fires again.
                                event.currentTarget.value = '';
                            }}
                        />

                        {document_ ? (
                            <>
                                <button
                                    type="button"
                                    className="viz-editor__action"
                                    onClick={() => downloadScene(document_)}
                                    title="Save this scene as a document"
                                >
                                    Export
                                </button>
                                <button
                                    type="button"
                                    className="viz-editor__action"
                                    onClick={copy}
                                    title="Copy this scene as a test file that reproduces it"
                                >
                                    Copy fixture
                                </button>
                            </>
                        ) : null}

                        {editable ? (
                            <>
                                <button
                                    type="button"
                                    className="viz-editor__action"
                                    disabled={!history || !canUndo(history)}
                                    onClick={() => step('undo')}
                                    title="Undo (Ctrl+Z)"
                                >
                                    ↺
                                </button>
                                <button
                                    type="button"
                                    className="viz-editor__action"
                                    disabled={!history || !canRedo(history)}
                                    onClick={() => step('redo')}
                                    title="Redo (Ctrl+Shift+Z)"
                                >
                                    ↻
                                </button>
                            </>
                        ) : null}

                        {selectedNode ? (
                            <span className="viz-editor__note">
                                {selectedNode.inspect
                                    ? `showing ${selectedNode.inspect}`
                                    : `${selectedNode.title} — nothing to show alone`}
                            </span>
                        ) : null}

                        {problems.length > 0 ? (
                            <span className="viz-editor__note is-problem">
                                {problems.length} problem{problems.length === 1 ? '' : 's'}
                            </span>
                        ) : null}

                        {notice ? <span className="viz-editor__note">{notice}</span> : null}
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
                        <div className="viz-editor__split">
                            <div className="viz-editor__canvas">
                                <Suspense
                                    fallback={<div className="viz-editor__empty">loading canvas…</div>}
                                >
                                    <GraphCanvas
                                        view={view}
                                        selectedId={selected}
                                        editable={editable}
                                        onSelect={onSelect}
                                        onMove={onMove}
                                        onConnect={onCanvasConnect}
                                        onDisconnect={onCanvasDisconnect}
                                        onDropOnPane={(from, at) => setSearch({
                                            at,
                                            from,
                                            acceptingType: view.nodes
                                                .find((node) => node.id === from.node)?.outputs
                                                .find((port) => port.name === from.port)?.type,
                                        })}
                                        onAddAt={(at) => setSearch({ at })}
                                        onReady={(fn) => { project.current = fn; }}
                                    />
                                </Suspense>

                                {search ? (
                                    <NodeSearch
                                        catalog={registry.all()}
                                        acceptingType={search.acceptingType}
                                        onPick={addNodeFromSearch}
                                        onClose={() => setSearch(undefined)}
                                    />
                                ) : null}
                            </div>

                            {selectedNode ? (
                                <Inspector
                                    node={selectedNode}
                                    editable={editable}
                                    layerOverrides={document_?.kernel?.layers}
                                    onParameter={(parameter, value) =>
                                        onInspectorParameter(selectedNode, parameter, value)}
                                    onBinding={(parameter, binding) =>
                                        onInspectorBinding(selectedNode, parameter, binding)}
                                    onPromote={(parameter, promoted) => edit(
                                        document_ && setPromoted(
                                            document_,
                                            targetOf(selectedNode).node,
                                            parameter,
                                            promoted,
                                        ),
                                        { presentation: true },
                                    )}
                                    onMute={(muted) => {
                                        edit(document_ && setMuted(document_, selectedNode.id, muted));
                                        onControls(togglePluginDisabled(controls, selectedNode.id));
                                    }}
                                    onSeed={(seed) =>
                                        edit(document_ && setSeed(document_, selectedNode.id, seed))}
                                    onClone={() =>
                                        edit(document_ && cloneNode(document_, selectedNode.id))}
                                    onRemove={() => {
                                        edit(document_ && removeNode(document_, selectedNode.id));
                                        setSelected(undefined);
                                    }}
                                    onLayerOverride={(layerId, blendMode, opacity) => editKernel(
                                        document_ && setLayerOverride(document_, layerId, {
                                            ...(blendMode ? { blendMode } : {}),
                                            ...(opacity !== undefined ? { opacity } : {}),
                                        }),
                                    )}
                                />
                            ) : null}
                        </div>
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

/**
 * The node and parameter an inspector row belongs to.
 *
 * A driver node is a picture of a binding on the node it feeds, so editing it edits that node — not
 * the picture.
 */
function targetOf(node: EditorNode): { node: string; parameter?: string } {
    const driven = driverTarget(node.id);

    return driven ? { node: driven.node, parameter: driven.parameter } : { node: node.id };
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
