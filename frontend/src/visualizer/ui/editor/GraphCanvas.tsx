/**
 * The node canvas.
 *
 * React Flow supplies the viewport, the selection model and edge routing; everything a node says
 * about the scene comes from `core/editor-view.ts`, and every gesture's meaning from
 * `core/editor-actions.ts`. Connection validity delegates to `portsCompatible` through
 * `connectionAllowed`, so a link the canvas refuses to draw is a link the compiler would have
 * rejected. See ADR-0011.
 */

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import {
    Background,
    Controls,
    Handle,
    Position,
    ReactFlow,
    type Connection,
    type Edge,
    type IsValidConnection,
    type Node,
    type NodeProps,
    type OnConnectEnd,
    useEdgesState,
    useNodesState,
    useUpdateNodeInternals,
} from '@xyflow/react';
import { connectionAllowed, type CanvasEndpoint } from '../../core/editor-actions';
import type { EditorEdge, EditorNode, EditorView } from '../../core/editor-view';
import GraphNodeBody, { PORT_ROW_HEIGHT, portColour } from './GraphNodeBody';

/** Distance from a node's top to the first port row, in step with the title bar in the stylesheet. */
const PORTS_TOP = 28;

type FlowNode = Node<{
    node: EditorNode;
    /** Excludes live parameter samples, which must not churn React Flow's controlled node array. */
    signature: string;
}, 'viz'>;

function nodeSignature(node: EditorNode): string {
    return JSON.stringify(node, (key, value) => (key === 'live' ? undefined : value));
}

function sameNodeProjection(current: readonly FlowNode[], next: readonly FlowNode[]): boolean {
    return current.length === next.length && current.every((node, index) => {
        const candidate = next[index];
        return node.id === candidate.id
            && node.type === candidate.type
            && node.position.x === candidate.position.x
            && node.position.y === candidate.position.y
            && node.selected === candidate.selected
            && node.draggable === candidate.draggable
            && node.data.signature === candidate.data.signature;
    });
}

function sameEdgeProjection(current: readonly Edge[], next: readonly Edge[]): boolean {
    return JSON.stringify(current) === JSON.stringify(next);
}

/**
 * One node type for everything.
 *
 * Plugins, assets, drivers and kernel stages differ in what they contain rather than in how they
 * behave on the canvas, and the body already varies its appearance from `kind`.
 */
const VizNode = memo(function VizNode({
    id,
    data,
    selected,
    isConnectable,
}: NodeProps<FlowNode>) {
    const { node } = data;
    const updateNodeInternals = useUpdateNodeInternals();
    const handleLayout = [
        node.inputs.map((port) => port.name).join('\u001f'),
        node.outputs.map((port) => port.name).join('\u001f'),
    ].join('\u001e');

    // Port membership and ordering are authored data. React Flow does not rediscover dynamically
    // changed handles by itself, so refresh its measured handle bounds after the new DOM is committed.
    useEffect(() => {
        updateNodeInternals(id);
    }, [handleLayout, id, updateNodeInternals]);

    return (
        <>
            {node.inputs.map((port, index) => (
                <Handle
                    key={`in-${port.name}`}
                    id={port.name}
                    type="target"
                    position={Position.Left}
                    isConnectable={isConnectable}
                    className={port.parameter ? 'is-parameter' : undefined}
                    style={{
                        top: PORTS_TOP + index * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2,
                        background: portColour(port.type),
                    }}
                />
            ))}

            <GraphNodeBody node={node} selected={selected} />

            {node.outputs.map((port, index) => (
                <Handle
                    key={`out-${port.name}`}
                    id={port.name}
                    type="source"
                    position={Position.Right}
                    isConnectable={isConnectable}
                    style={{
                        top: PORTS_TOP + index * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2,
                        background: portColour(port.type),
                    }}
                />
            ))}
        </>
    );
});

const NODE_TYPES = { viz: VizNode };

/** How each kind of connection is drawn, so the implicit ones cannot be mistaken for declared ones. */
function edgeStyle(edge: EditorEdge): Edge {
    const colour = portColour(edge.type);

    const shared = {
        id: edge.id,
        source: edge.from.node,
        sourceHandle: edge.from.port,
        target: edge.to.node,
        targetHandle: edge.to.port,
        // Only the document's own edges may be cut. The derived ones report why when tried.
        deletable: edge.kind === 'data' || edge.kind === 'feedback' || edge.kind === 'parameter',
    };

    switch (edge.kind) {
        case 'feedback':
            // Reads the previous frame, so it may run backwards through the graph. Marked, because a
            // cycle that is legal and a cycle that is a bug look identical otherwise.
            return {
                ...shared,
                animated: true,
                label: 'feedback',
                labelStyle: { fill: '#c9a35f', fontSize: 9 },
                labelBgStyle: { fill: '#17171c' },
                style: { stroke: '#c9a35f', strokeDasharray: '4 3' },
            };

        case 'asset':
            return { ...shared, style: { stroke: '#8a6a3f' } };

        case 'parameter':
            return { ...shared, style: { stroke: '#c9a35f', strokeWidth: 1 } };

        case 'layer':
            // Implicit: in no edge list anywhere. This is the stack that actually reaches the screen.
            return { ...shared, style: { stroke: colour, strokeDasharray: '2 3', opacity: 0.75 } };

        case 'motion':
            return { ...shared, style: { stroke: '#59b58a', strokeDasharray: '2 3', opacity: 0.75 } };

        case 'kernel':
            return { ...shared, style: { stroke: '#4a6a6a' } };

        default:
            return { ...shared, style: { stroke: colour } };
    }
}

export interface GraphCanvasProps {
    view: EditorView;
    selectedId?: string;
    editable: boolean;
    onSelect: (node: EditorNode | undefined) => void;
    onMove: (nodeId: string, position: { x: number; y: number }) => void;
    onConnect: (from: CanvasEndpoint, to: CanvasEndpoint) => void;
    onDisconnect: (edgeId: string) => void;
    /** A link dropped on empty canvas, including which side of the new node must satisfy it. */
    onDropOnPane: (
        from: CanvasEndpoint,
        handleType: 'source' | 'target',
        at: { x: number; y: number },
    ) => void;
    onAddAt: (at: { x: number; y: number }) => void;
    /** Hands back the screen-to-canvas projection, so a drop point becomes a node position. */
    onReady?: (project: (point: { x: number; y: number }) => { x: number; y: number }) => void;
}

export default function GraphCanvas({
    view,
    selectedId,
    editable,
    onSelect,
    onMove,
    onConnect,
    onDisconnect,
    onDropOnPane,
    onAddAt,
    onReady,
}: GraphCanvasProps) {
    const draggingNode = useRef<string | undefined>(undefined);
    const viewRef = useRef(view);
    const editableRef = useRef(editable);
    const connectRef = useRef(onConnect);
    const dropOnPaneRef = useRef(onDropOnPane);

    viewRef.current = view;
    editableRef.current = editable;
    connectRef.current = onConnect;
    dropOnPaneRef.current = onDropOnPane;

    const projectedNodes = useMemo<FlowNode[]>(() => view.nodes.map((node) => ({
        id: node.id,
        type: 'viz',
        position: node.position,
        data: { node, signature: nodeSignature(node) },
        selected: node.id === selectedId,
        draggable: editable,
        // A driver is a picture of a binding rather than something stored, so it has no position of
        // its own to move: it follows the node it drives.
        ...(node.kind === 'feature' || node.kind === 'constant' ? { draggable: false } : {}),
    })), [view.nodes, selectedId, editable]);

    const projectedEdges = useMemo<Edge[]>(() => view.edges.map(edgeStyle), [view.edges]);
    const [nodes, setNodes, onNodesChange] = useNodesState(projectedNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(projectedEdges);

    // Live values arrive at 20 Hz, but they do not change React Flow's geometry or interaction state.
    // Preserve the controlled arrays unless their structural projection changed; replacing them for
    // every sample interrupts React Flow's own click, drag and connection state machines.
    useEffect(() => {
        if (draggingNode.current) {
            return;
        }

        setNodes((current) => sameNodeProjection(current, projectedNodes)
            ? current
            : projectedNodes);
        setEdges((current) => sameEdgeProjection(current, projectedEdges)
            ? current
            : projectedEdges);
    }, [projectedNodes, projectedEdges, setNodes]);

    const isValid = useCallback<IsValidConnection>((connection) => {
        if (!connection.source || !connection.target
            || !connection.sourceHandle || !connection.targetHandle) {
            return false;
        }

        return connectionAllowed(
            viewRef.current,
            { node: connection.source, port: connection.sourceHandle },
            { node: connection.target, port: connection.targetHandle },
        ).ok;
    }, []);

    const onConnectEnd = useCallback<OnConnectEnd>((event, state) => {
        const handle = state.fromHandle;

        if (!handle?.id || !editableRef.current) {
            return;
        }

        const target = event.target as HTMLElement | null;
        // React Flow reports a drop on the pane by the element under the pointer; anything else was a
        // drop on a socket and `onConnect` has already dealt with it.
        if (!target?.classList.contains('react-flow__pane')) {
            return;
        }

        const point = 'clientX' in event
            ? { x: event.clientX, y: event.clientY }
            : { x: event.changedTouches[0]?.clientX ?? 0, y: event.changedTouches[0]?.clientY ?? 0 };

        dropOnPaneRef.current(
            { node: handle.nodeId, port: handle.id },
            handle.type,
            point,
        );
    }, []);

    const commitConnection = useCallback((connection: Connection) => {
        if (connection.source && connection.target
            && connection.sourceHandle && connection.targetHandle) {
            connectRef.current(
                { node: connection.source, port: connection.sourceHandle },
                { node: connection.target, port: connection.targetHandle },
            );
        }
    }, []);

    return (
        <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onInit={(instance) => onReady?.(instance.screenToFlowPosition)}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, node) => onSelect(node.data.node)}
            onPaneClick={() => onSelect(undefined)}
            onDoubleClick={(event) => {
                // React Flow has no pane double-click of its own, so this is the container's and the
                // target check is what keeps a double-click on a node from adding one.
                if (editable && (event.target as HTMLElement).classList.contains('react-flow__pane')) {
                    onAddAt({ x: event.clientX, y: event.clientY });
                }
            }}
            onNodeDragStart={(_, node) => {
                draggingNode.current = node.id;
            }}
            onNodeDragStop={(_, node) => {
                draggingNode.current = undefined;
                onMove(node.id, node.position);
            }}
            onConnect={commitConnection}
            onConnectEnd={onConnectEnd}
            onEdgesDelete={(deleted) => deleted.forEach((edge) => onDisconnect(edge.id))}
            isValidConnection={isValid}
            nodesConnectable={editable}
            nodesDraggable={editable}
            elementsSelectable
            deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
            fitView
            minZoom={0.1}
            maxZoom={2}
        >
            <Background color="#22222a" gap={24} />
            <Controls showInteractive={false} />
        </ReactFlow>
    );
}
