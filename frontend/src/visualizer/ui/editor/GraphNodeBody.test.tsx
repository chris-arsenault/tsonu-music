import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import GraphNodeBody, { formatValue } from './GraphNodeBody';
import type { EditorNode } from '../../core/editor-view';

function node(overrides: Partial<EditorNode> = {}): EditorNode {
    return {
        id: 'src#0',
        kind: 'plugin',
        title: 'SignalTraceSource:circular',
        subtitle: 'source',
        category: 'source',
        position: { x: 0, y: 0 },
        inputs: [],
        outputs: [{ name: 'color', type: 'color-texture', required: false, connected: true }],
        parameters: [],
        problems: [],
        ...overrides,
    };
}

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
    renderToStaticMarkup(element);

describe('node body', () => {
    test('names the plugin and its category', () => {
        const html = render(<GraphNodeBody node={node()} />);

        expect(html).toContain('SignalTraceSource:circular');
        expect(html).toContain('source');
    });

    test('a muted node says so instead of its category', () => {
        const html = render(<GraphNodeBody node={node({ muted: true })} />);

        expect(html).toContain('is-muted');
        expect(html).toContain('muted');
    });

    test('a required input with nothing on it is marked, not merely listed', () => {
        // The commonest reason a document does not compile, so it is called out on the socket.
        const html = render(<GraphNodeBody node={node({
            inputs: [{ name: 'source', type: 'color-texture', required: true, connected: false }],
        })} />);

        expect(html).toContain('is-required');
        expect(html).toContain('is-unconnected');
        expect(html).toContain('source *');
    });

    test('a satisfied required input is not marked', () => {
        const html = render(<GraphNodeBody node={node({
            inputs: [{ name: 'source', type: 'color-texture', required: true, connected: true }],
        })} />);

        expect(html).not.toContain('source *');
        expect(html).not.toContain('is-hollow');
    });

    test('a bound parameter names its feature rather than posing as a constant', () => {
        const html = render(<GraphNodeBody node={node({
            parameters: [{
                name: 'amount',
                value: 0.5,
                live: 0.82,
                binding: {
                    feature: 'bassExcite',
                    parameter: 'amount',
                    outputRange: [0, 1],
                    attack: 0.1,
                    release: 0.2,
                    curve: 'linear',
                },
            }],
        })} />);

        expect(html).toContain('bassExcite');
        // The live value, because the resolver overwrites the stated one on the first frame.
        expect(html).toContain('0.820');
        expect(html).toContain('is-live');
    });

    test('a constant shows the value the document states', () => {
        const html = render(<GraphNodeBody node={node({
            parameters: [{ name: 'amount', value: 0.25 }],
        })} />);

        expect(html).toContain('0.250');
        expect(html).not.toContain('is-live');
    });

    test('an unpinned kernel value reads as automatic rather than as zero', () => {
        const html = render(<GraphNodeBody node={node({
            kind: 'kernel',
            parameters: [{ name: 'survivalPerSecond', value: Number.NaN }],
        })} />);

        expect(html).toContain('auto');
        expect(html).not.toContain('NaN');
    });

    test('problems are shown on the node that caused them', () => {
        const html = render(<GraphNodeBody node={node({
            problems: ['src#0.source is required but unconnected'],
        })} />);

        expect(html).toContain('is-problem');
        expect(html).toContain('required but unconnected');
    });

    test('each kind carries its own class', () => {
        expect(render(<GraphNodeBody node={node({ kind: 'kernel' })} />)).toContain('is-kernel');
        expect(render(<GraphNodeBody node={node({ kind: 'asset' })} />)).toContain('is-asset');
        expect(render(<GraphNodeBody node={node()} selected />)).toContain('is-selected');
    });

    test('a node with no ports and no parameters renders its title alone', () => {
        const html = render(<GraphNodeBody node={node({ outputs: [], parameters: [] })} />);

        expect(html).not.toContain('viz-node__ports');
        expect(html).not.toContain('viz-node__params');
    });
});

describe('value formatting', () => {
    test('small numbers keep three decimals and large ones lose them', () => {
        expect(formatValue(0.5)).toBe('0.500');
        expect(formatValue(1.25)).toBe('1.25');
        expect(formatValue(4096)).toBe('4096');
    });

    test('very small and very large values go exponential rather than reading as zero', () => {
        expect(formatValue(0.00001)).toBe('1.0e-5');
        expect(formatValue(250000)).toBe('2.5e+5');
    });

    test('zero is zero, and a non-finite value is automatic', () => {
        expect(formatValue(0)).toBe('0.000');
        expect(formatValue(Number.NaN)).toBe('auto');
    });
});
