/**
 * The editor's dock: the surface below the canvas, and the one place the kernel is inspected from.
 *
 * Capture freezes whatever the scheduler put on screen into a document and hands the graph to it.
 * From there the scene holds still — no mutation, no rebuild on a track change, no quality
 * suppression — and can be examined a node at a time. Release hands it back.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
    setAssetBinding,
    setFeedback,
    setLayerOverride,
    setMuted,
    setParameter,
    setPaletteId,
    setPaletteStrength,
    setPosition,
    setPromoted,
    setGradeParameter,
    setGradeBinding,
    removeGradeBinding,
    setKernelInputs,
    setSeed,
    undo,
    type DocumentHistory,
    type PluginLookup,
} from '../../core/authored-scene-edit';
import type { ParameterBinding } from '../../core/bindings';
import type { VisualPluginDefinition } from '../../core/plugin';
import { assetResourceId } from '../../core/wiring';
import { createM1Registry } from '../../plugins/registry';
import type { KernelControlHandle, KernelReadout } from '../../host/kernel-loop';
import { useEditorStyles } from './editor-styles';
import Inspector from './Inspector';
import NodeSearch, {
    type NodeSearchAsset,
    type NodeSearchPortFilter,
} from './NodeSearch';
import { MetersTab, PerformanceTab } from './ReadoutTabs';
import {
    copyFixture,
    copyGraph,
    downloadScene,
    loadStoredScene,
    readSceneFile,
    storeScene,
} from './scene-storage';
import { particleSanityScene } from './particle-sanity-scene';

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
    connection?: {
        fixed: CanvasEndpoint;
        candidatePort: NodeSearchPortFilter;
    };
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
    const [manualGraphCopy, setManualGraphCopy] = useState<string | undefined>();
    const fileInput = useRef<HTMLInputElement | null>(null);
    const canvas = useRef<HTMLDivElement | null>(null);
    const project = useRef<((point: Point) => Point) | undefined>(undefined);
    const attemptedRestore = useRef(false);

    const document_ = history?.present;

    // The Lab is an authoring surface: its last autosave resumes once the kernel is ready.
    const [stored] = useState(() => loadStoredScene());

    // The document the kernel is actually running, which after a capture is the one below. Read from
    // the readout rather than assumed, so what is drawn is what is rendering.
    const live = readout.scene?.authored;
    const problems = readout.scene?.problems ?? [];
    // Once the editor has a document, transient runtime readout gaps while the Lab reloads or
    // recompiles must not disable React Flow's drag and connection state machines. A live authored
    // scene remains editable before it has been copied into local history as well.
    const editable = Boolean(document_ || live);

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

    useEffect(() => {
        if (attemptedRestore.current || !handle) {
            return;
        }

        // An authored scene is already in control when the dock was merely closed and reopened. It
        // must not be replaced by an older localStorage snapshot.
        if (live) {
            attemptedRestore.current = true;
            return;
        }

        attemptedRestore.current = true;
        if (stored) {
            apply(stored, 'restored autosaved composition');
        }
    }, [apply, handle, live, stored]);

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

    const copyTestFixture = useCallback(() => {
        if (!document_) {
            return;
        }

        void copyFixture(document_).then((where) => setNotice(
            where === 'clipboard' ? 'fixture copied' : 'fixture downloaded',
        ));
    }, [document_]);

    const copyGraphForAnalysis = useCallback(() => {
        if (!document_) {
            return;
        }

        void copyGraph(document_).then((result) => {
            if (result.where === 'clipboard') {
                setNotice('graph copied');
            } else {
                setManualGraphCopy(result.text);
                setNotice('clipboard unavailable — copy the graph from the dialog');
            }
        });
    }, [document_]);

    const loadParticleSanityScene = useCallback(() => {
        apply(particleSanityScene(), 'loaded particle sanity scene');
        setSelected(undefined);
        setSearch(undefined);
    }, [apply]);

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

    const searchAssets = useMemo<NodeSearchAsset[]>(() =>
        (readout.scene?.assets ?? []).flatMap<NodeSearchAsset>((assetId) => {
            if (assetId.startsWith('mask:')) {
                return [{
                    resource: assetResourceId(assetId),
                    name: assetId,
                    type: 'mask-texture' as const,
                }];
            }
            if (assetId.startsWith('album-art:')) {
                return [{
                    resource: assetResourceId(assetId),
                    name: assetId,
                    type: 'color-texture' as const,
                }];
            }
            return [];
        }), [readout.scene?.assets]);

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

    const onMove = useCallback((nodeId: string, position: Point) => {
        // React Flow owns the transient drag. The document receives one settled position, so moving a
        // node neither rebuilds the whole canvas per pointer frame nor reaches the rendering kernel.
        edit(document_ && setPosition(document_, nodeId, position), {
            presentation: true,
        });
    }, [document_, edit]);

    const onCanvasConnect = useCallback((from: CanvasEndpoint, to: CanvasEndpoint) => {
        if (!document_ || !view) {
            return;
        }

        edit(applyConnect(document_, view, from, to, lookup));
    }, [document_, view, edit, lookup]);

    const onToggleFeedback = useCallback((edgeId: string, feedback: boolean) => {
        if (!document_) {
            return;
        }

        edit(setFeedback(document_, edgeId, feedback));
    }, [document_, edit]);

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

    const closeSearch = useCallback(() => setSearch(undefined), []);

    /** Opens the unfiltered catalog and uses the visible canvas centre for the new node. */
    const openCatalog = useCallback(() => {
        const bounds = canvas.current?.getBoundingClientRect();
        if (!bounds) {
            return;
        }

        setSearch({
            at: {
                x: bounds.left + bounds.width / 2,
                y: bounds.top + bounds.height / 2,
            },
        });
    }, []);

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

        if (search.connection && port) {
            // `view` predates the node we just added. Build the pending document's view so the same
            // connection validator used by canvas gestures can see and type-check both endpoints.
            const pending = resolveAuthoredScene(next, registry);
            const pendingView = buildEditorView({
                document: next,
                registry,
                graph: pending.ok ? pending.scene.graph : undefined,
                problems: pending.ok ? pending.warnings : pending.problems,
            });
            const added = { node: id, port };
            const { fixed, candidatePort } = search.connection;

            next = candidatePort.kind === 'input'
                ? applyConnect(next, pendingView, fixed, added, lookup)
                : applyConnect(next, pendingView, added, fixed, lookup);
        }

        setSearch(undefined);
        edit(next);
    }, [document_, search, edit, lookup]);

    const addAssetFromSearch = useCallback((asset: NodeSearchAsset) => {
        const connection = search?.connection;
        if (!document_ || !connection || connection.candidatePort.kind !== 'output') {
            return;
        }

        setSearch(undefined);
        edit(setAssetBinding(document_, connection.fixed, asset.resource, lookup));
    }, [document_, search, edit, lookup]);

    /**
     * A parameter edited from the inspector.
     *
     * The kernel tail's two surfaces are each their own thing — the grade's values are ordinary
     * parameters, and a driver's row belongs to the node it feeds. An accumulation branch stood here
     * for pinned survival and punch; those are a blend node's parameters now (ADR-0013) and take the
     * ordinary path below.
     */
    const onInspectorParameter = useCallback((
        node: EditorNode,
        parameter: string,
        value: number,
    ) => {
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
                        <button
                            type="button"
                            className="viz-editor__action"
                            onClick={loadParticleSanityScene}
                            title="Replace the Lab document with an unbound particle physics sanity scene"
                        >
                            Particle sanity
                        </button>

                        {document_ ? (
                            <>
                                <button
                                    type="button"
                                    className="viz-editor__action"
                                    onClick={copyGraphForAnalysis}
                                    title="Copy the exact graph JSON for pasting into an analysis conversation"
                                >
                                    Copy graph
                                </button>
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
                                    onClick={copyTestFixture}
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
                                    onClick={openCatalog}
                                    title="Add a disconnected node from the full plugin catalog"
                                >
                                    + Add node
                                </button>
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
                            <div ref={canvas} className="viz-editor__canvas">
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
                                        onToggleFeedback={onToggleFeedback}
                                        onDropOnPane={(fixed, handleType, at) => {
                                            const node = view.nodes.find(
                                                (candidate) => candidate.id === fixed.node,
                                            );
                                            const port = (handleType === 'source'
                                                ? node?.outputs
                                                : node?.inputs
                                            )?.find((candidate) => candidate.name === fixed.port);

                                            if (port?.type) {
                                                setSearch({
                                                    at,
                                                    connection: {
                                                        fixed,
                                                        candidatePort: {
                                                            kind: handleType === 'source' ? 'input' : 'output',
                                                            type: port.type,
                                                        },
                                                    },
                                                });
                                            }
                                        }}
                                        onAddAt={(at) => setSearch({ at })}
                                        onReady={(fn) => { project.current = fn; }}
                                    />
                                </Suspense>

                                {search ? (
                                    <NodeSearch
                                        catalog={registry.all()}
                                        assets={searchAssets}
                                        portFilter={search.connection?.candidatePort}
                                        onPick={addNodeFromSearch}
                                        onPickAsset={addAssetFromSearch}
                                        onClose={closeSearch}
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
                                    onKernelInputs={(stage, inputs) => editKernel(
                                        document_ && setKernelInputs(document_, stage, inputs),
                                    )}
                                    onPaletteId={(id) => editKernel(
                                        document_ && setPaletteId(document_, id),
                                    )}
                                    onPaletteStrength={(strength) => editKernel(
                                        document_ && setPaletteStrength(document_, strength),
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

            {manualGraphCopy ? (
                <GraphCopyDialog
                    text={manualGraphCopy}
                    onClose={() => setManualGraphCopy(undefined)}
                />
            ) : null}
        </aside>
    );
}

function GraphCopyDialog({ text, onClose }: { text: string; onClose: () => void }) {
    const field = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        field.current?.focus();
        field.current?.select();
    }, []);

    useEffect(() => {
        const dismiss = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                onClose();
            }
        };

        window.addEventListener('keydown', dismiss, { capture: true });
        return () => window.removeEventListener('keydown', dismiss, { capture: true });
    }, [onClose]);

    return (
        <div className="viz-copy-modal__backdrop">
            <section
                className="viz-copy-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Copy graph manually"
            >
                <div className="viz-copy-modal__head">
                    <strong>Copy graph</strong>
                    <button type="button" className="viz-editor__action" onClick={onClose}>
                        Close
                    </button>
                </div>
                <p>Clipboard access was unavailable. The complete graph is selected; copy it manually.</p>
                <textarea
                    ref={field}
                    className="viz-copy-modal__text"
                    readOnly
                    value={text}
                    onFocus={(event) => event.currentTarget.select()}
                />
            </section>
        </div>
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
