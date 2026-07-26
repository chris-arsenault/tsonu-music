/**
 * A node's contents, with no dependency on the canvas that hosts it.
 *
 * The test environment has no jsdom — components are checked with `renderToStaticMarkup` — so
 * anything requiring a live DOM cannot be covered at all. Keeping the body a plain function of plain
 * props puts every claim a node makes about the scene inside the tests, and leaves only the viewport
 * outside them. See ADR-0011.
 */

import type { EditorNode, EditorParameterRow, EditorPort } from '../../core/editor-view';
import { isPinned } from '../../core/editor-view';
import { CATEGORY_COLOURS, DEFAULT_PORT_COLOUR, PORT_COLOURS } from './editor-styles';

export function portColour(type: string | undefined): string {
    return (type && PORT_COLOURS[type]) || DEFAULT_PORT_COLOUR;
}

export function nodeAccent(node: EditorNode): string {
    if (node.kind === 'kernel') {
        return '#4a6a6a';
    }
    if (node.kind === 'asset') {
        return '#8a6a3f';
    }
    if (node.kind === 'feature' || node.kind === 'constant') {
        return '#c9a35f';
    }

    return (node.category && CATEGORY_COLOURS[node.category]) || '#4a4a55';
}

/** Row height in the port columns. The canvas anchors its handles against this. */
export const PORT_ROW_HEIGHT = 18;

export interface GraphNodeBodyProps {
    node: EditorNode;
    selected?: boolean;
}

export default function GraphNodeBody({ node, selected }: GraphNodeBodyProps) {
    const classes = [
        'viz-node',
        `is-${node.kind}`,
        selected ? 'is-selected' : '',
        node.muted ? 'is-muted' : '',
        node.problems.length > 0 ? 'is-problem' : '',
    ].filter(Boolean).join(' ');

    return (
        <div className={classes} style={{ ['--viz-node-accent' as string]: nodeAccent(node) }}>
            <div className="viz-node__title">
                <span className="viz-node__name" title={node.title}>{node.title}</span>
                <span className="viz-node__kind">{node.muted ? 'muted' : node.subtitle}</span>
            </div>

            {node.inputs.length > 0 || node.outputs.length > 0 ? (
                <div className="viz-node__ports">
                    <div className="viz-node__column">
                        {node.inputs.map((port) => <Port key={port.name} port={port} />)}
                    </div>
                    <div className="viz-node__column is-outputs">
                        {node.outputs.map((port) => <Port key={port.name} port={port} />)}
                    </div>
                </div>
            ) : null}

            {node.parameters.length > 0 || (node.details && node.details.length > 0) ? (
                <div className="viz-node__params">
                    {node.parameters.map((row) => <Parameter key={row.name} row={row} />)}
                    {(node.details ?? []).map((detail) => (
                        <div className="viz-node__param" key={detail.label}>
                            <span className="viz-node__param-name">{detail.label}</span>
                            <span className="viz-node__param-value">{detail.value}</span>
                        </div>
                    ))}
                </div>
            ) : null}

            {node.problems.length > 0 ? (
                <div className="viz-node__problems">
                    {node.problems.map((problem) => <div key={problem}>{problem}</div>)}
                </div>
            ) : null}
        </div>
    );
}

function Port({ port }: { port: EditorPort }) {
    // A required input with nothing on it is the commonest reason a document does not compile, so it
    // is called out on the socket rather than only in the problem list.
    const wanting = port.required && !port.connected;
    const classes = [
        'viz-node__port',
        port.required ? 'is-required' : '',
        port.connected ? '' : 'is-unconnected',
    ].filter(Boolean).join(' ');

    return (
        <div className={classes} title={`${port.name}${port.type ? `: ${port.type}` : ''}`}>
            <span>{port.name}{wanting ? ' *' : ''}</span>
        </div>
    );
}

/**
 * One parameter row.
 *
 * A bound parameter is not a constant, and showing its stated value as though it were is how a
 * control comes to look connected when it is not: the resolver overwrites it from the binding on the
 * first frame. So a bound row names its feature, and the number it shows is the live one.
 */
function Parameter({ row }: { row: EditorParameterRow }) {
    const unpinned = !isPinned(row);
    const shown = row.live ?? row.value;

    return (
        <div className="viz-node__param">
            <span className="viz-node__param-name" title={row.name}>{row.name}</span>
            {row.binding ? (
                <span className="viz-node__param-feature">{row.binding.feature}</span>
            ) : null}
            <span
                className={[
                    'viz-node__param-value',
                    row.live !== undefined ? 'is-live' : '',
                    unpinned && row.live === undefined ? 'is-unpinned' : '',
                ].filter(Boolean).join(' ')}
            >
                {unpinned && row.live === undefined ? 'auto' : formatValue(shown)}
            </span>
        </div>
    );
}

export function formatValue(value: number): string {
    if (!Number.isFinite(value)) {
        return 'auto';
    }

    const magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude < 0.01 || magnitude >= 10000)) {
        return value.toExponential(1);
    }

    return value.toFixed(magnitude >= 100 ? 0 : magnitude >= 1 ? 2 : 3);
}
