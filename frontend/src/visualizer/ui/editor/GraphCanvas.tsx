/**
 * The node canvas.
 *
 * React Flow supplies the viewport, the selection model and edge routing; everything a node says
 * about the scene comes from `core/editor-view.ts`, and every gesture's meaning from
 * `core/editor-actions.ts`. Connection validity delegates to `portsCompatible` through
 * `connectionAllowed`, so a link the canvas refuses to draw is a link the compiler would have
 * rejected. See ADR-0011.
 */

import { useCallback, useMemo, useRef } from 'react';
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
    type OnConnectStart,
} from '@xyflow/react';
import { connectionAllowed, type CanvasEndpoint } from '../../core/editor-actions';
import type { EditorEdge, EditorNode, EditorView } from '../../core/editor-view';
import GraphNodeBody, { PORT_ROW_HEIGHT, portColour } from './GraphNodeBody';

/** Distance from a node's top to the first port row, in step with the title bar in the stylesheet. */
const PORTS_TOP = 28;

type FlowNode = Node<{ node: EditorNode }, 'viz'>;

/**
 * One node type for everything.
 *
 * Plugins, assets, drivers and kernel stages differ in what they contain rather than in how they
 * behave on the canvas, and the body already varies its appearance from `kind`.
 */
function VizNode({ data, selected }: NodeProps<FlowNode>) {
    const { node } = data;

    return (
        <>
            {node.inputs.map((port, index) => (
                <Handle
                    key={`in-${port.name}`}
                    id={port.name}
                    type="target"
                    position={Position.Left}
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
                    style={{
                        top: PORTS_TOP + index * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2,
                        background: portColour(port.type),
                    }}
                />
            ))}
        </>
    );
}

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
    onMove: (nodeId: string, position: { x: number; y: number }, settled: boolean) => void;
    onConnect: (from: CanvasEndpoint, to: CanvasEndpoint) => void;
    onDisconnect: (edgeId: string) => void;
    /** A link dropped on empty canvas, at the position it was dropped. */
    onDropOnPane: (from: CanvasEndpoint, at: { x: number; y: number }) => void;
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
    const dragging = useRef<CanvasEndpoint | undefined>(undefined);

    const nodes = useMemo<FlowNode[]>(() => view.nodes.map((node) => ({
        id: node.id,
        type: 'viz',
        position: node.position,
        data: { node },
        selected: node.id === selectedId,
        draggable: editable,
        // A driver is a picture of a binding rather than something stored, so it has no position of
        // its own to move: it follows the node it drives.
        ...(node.kind === 'feature' || node.kind === 'constant' ? { draggable: false } : {}),
    })), [view.nodes, selectedId, editable]);

    const edges = useMemo<Edge[]>(() => view.edges.map(edgeStyle), [view.edges]);

    const isValid = useCallback<IsValidConnection>((connection) => {
        if (!connection.source || !connection.target
            || !connection.sourceHandle || !connection.targetHandle) {
            return false;
        }

        return connectionAllowed(
            view,
            { node: connection.source, port: connection.sourceHandle },
            { node: connection.target, port: connection.targetHandle },
        ).ok;
    }, [view]);

    const onConnectStart = useCallback<OnConnectStart>((_, params) => {
        dragging.current = params.nodeId && params.handleId
            ? { node: params.nodeId, port: params.handleId }
            : undefined;
    }, []);

    const onConnectEnd = useCallback<OnConnectEnd>((event) => {
        const from = dragging.current;
        dragging.current = undefined;

        if (!from || !editable) {
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

        onDropOnPane(from, point);
    }, [editable, onDropOnPane]);

    return (
        <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onInit={(instance) => onReady?.(instance.screenToFlowPosition)}
            onNodeClick={(_, node) => onSelect(node.data.node)}
            onPaneClick={() => onSelect(undefined)}
            onDoubleClick={(event) => {
                // React Flow has no pane double-click of its own, so this is the container's and the
                // target check is what keeps a double-click on a node from adding one.
                if (editable && (event.target as HTMLElement).classList.contains('react-flow__pane')) {
                    onAddAt({ x: event.clientX, y: event.clientY });
                }
            }}
            onNodeDrag={(_, node) => onMove(node.id, node.position, false)}
            onNodeDragStop={(_, node) => onMove(node.id, node.position, true)}
            onConnect={(connection: Connection) => {
                if (connection.source && connection.target
                    && connection.sourceHandle && connection.targetHandle) {
                    onConnect(
                        { node: connection.source, port: connection.sourceHandle },
                        { node: connection.target, port: connection.targetHandle },
                    );
                }
            }}
            onConnectStart={onConnectStart}
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
