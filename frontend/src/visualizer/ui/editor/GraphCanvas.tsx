/**
 * The node canvas.
 *
 * React Flow supplies the viewport, the selection model and edge routing; everything a node says
 * about the scene comes from `core/editor-view.ts` and is rendered by `GraphNodeBody`. Connection
 * validity, when M4 makes connections drawable, will delegate to `portsCompatible` — the same
 * function the graph compiler validates with, so a link the canvas refuses is a link that would not
 * have compiled. See ADR-0011.
 */

import { useCallback, useMemo } from 'react';
import {
    Background,
    Controls,
    Handle,
    Position,
    ReactFlow,
    type Edge,
    type Node,
    type NodeProps,
} from '@xyflow/react';
import type { EditorEdge, EditorNode, EditorView } from '../../core/editor-view';
import GraphNodeBody, { PORT_ROW_HEIGHT, portColour } from './GraphNodeBody';

/** Distance from a node's top to the first port row, in step with the title bar in the stylesheet. */
const PORTS_TOP = 28;

type FlowNode = Node<{ node: EditorNode }, 'viz'>;

/**
 * One node type for everything.
 *
 * Plugins, assets and kernel stages differ in what they contain rather than in how they behave on the
 * canvas, and the body already varies its own appearance from `kind`.
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
    onSelect: (node: EditorNode | undefined) => void;
}

export default function GraphCanvas({ view, selectedId, onSelect }: GraphCanvasProps) {
    const nodes = useMemo<FlowNode[]>(() => view.nodes.map((node) => ({
        id: node.id,
        type: 'viz',
        position: node.position,
        data: { node },
        selected: node.id === selectedId,
        // Positions are the document's to state. M4 makes them draggable and writes them back.
        draggable: false,
    })), [view.nodes, selectedId]);

    const edges = useMemo<Edge[]>(() => view.edges.map(edgeStyle), [view.edges]);

    const onNodeClick = useCallback((_: unknown, node: FlowNode) => {
        onSelect(node.data.node);
    }, [onSelect]);

    const onPaneClick = useCallback(() => onSelect(undefined), [onSelect]);

    return (
        <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodesConnectable={false}
            elementsSelectable
            fitView
            minZoom={0.1}
            maxZoom={2}
            proOptions={{ hideAttribution: false }}
        >
            <Background color="#22222a" gap={24} />
            <Controls showInteractive={false} />
        </ReactFlow>
    );
}
