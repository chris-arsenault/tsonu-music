import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import Inspector, { defaultBinding } from './Inspector';
import { ACCUMULATE_NODE, COMPOSITE_NODE, type EditorNode } from '../../core/editor-view';

function node(overrides: Partial<EditorNode> = {}): EditorNode {
    return {
        id: 'src#0',
        kind: 'plugin',
        title: 'SignalTraceSource:circular',
        subtitle: 'source',
        category: 'source',
        position: { x: 0, y: 0 },
        inputs: [],
        outputs: [],
        parameters: [],
        problems: [],
        ...overrides,
    };
}

const handlers = {
    onParameter: vi.fn(),
    onBinding: vi.fn(),
    onPromote: vi.fn(),
    onMute: vi.fn(),
    onSeed: vi.fn(),
    onClone: vi.fn(),
    onRemove: vi.fn(),
    onLayerOverride: vi.fn(),
};

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
    renderToStaticMarkup(element);

describe('inspector', () => {
    test('a plugin offers mute, clone, remove and seed control', () => {
        const html = render(<Inspector node={node()} editable {...handlers} />);

        expect(html).toContain('>Mute</button>');
        expect(html).toContain('>Clone</button>');
        expect(html).toContain('>Remove</button>');
        expect(html).toContain('>Reroll</button>');
    });

    test('nothing is editable while the scheduler owns the scene', () => {
        const html = render(<Inspector node={node()} editable={false} {...handlers} />);

        expect(html).toContain('disabled');
        expect(html).toContain('Capture the scene to edit it');
    });

    test('a parameter can be promoted or bound', () => {
        const html = render(<Inspector
            node={node({ parameters: [{ name: 'amount', value: 0.5 }] })}
            editable
            {...handlers}
        />);

        expect(html).toContain('>To input</button>');
        expect(html).toContain('>Bind</button>');
    });

    test('a bound parameter offers its whole binding, and unbinding', () => {
        const html = render(<Inspector
            node={node({
                parameters: [{
                    name: 'amount',
                    value: 0.5,
                    binding: { ...defaultBinding('amount'), feature: 'bassExcite', curve: 'sqrt' },
                }],
            })}
            editable
            {...handlers}
        />);

        expect(html).toContain('>Unbind</button>');
        expect(html).toContain('bassExcite');
        expect(html).toContain('attack / release');
        expect(html).toContain('invert');
    });

    test('a bound constant says it is only a starting value', () => {
        // The resolver overwrites it from the binding on the first frame, so a control that looks
        // like the value would be a control that appears not to work.
        const html = render(<Inspector
            node={node({
                parameters: [{ name: 'amount', value: 0.5, binding: defaultBinding('amount') }],
            })}
            editable
            {...handlers}
        />);

        expect(html).toContain('the starting value');
    });

    test('an unpinned accumulation value reads as automatic rather than as zero', () => {
        const html = render(<Inspector
            node={node({
                id: ACCUMULATE_NODE,
                kind: 'kernel',
                title: 'Accumulate',
                parameters: [{ name: 'survivalPerSecond', value: Number.NaN }],
            })}
            editable
            {...handlers}
        />);

        expect(html).toContain('placeholder="auto"');
        expect(html).not.toContain('NaN');
    });

    test('the composite stage offers a blend mode and opacity per layer', () => {
        const html = render(<Inspector
            node={node({
                id: COMPOSITE_NODE,
                kind: 'kernel',
                title: 'Composite',
                inputs: [{ name: 'trn#0', required: false, connected: true }],
            })}
            editable
            layerOverrides={{ 'trn#0': { opacity: 0.5 } }}
            {...handlers}
        />);

        expect(html).toContain('from character');
        expect(html).toContain('placeholder="opacity"');
    });

    test('a node with problems shows them before anything else', () => {
        const html = render(<Inspector
            node={node({ problems: ['src#0.source is required but unconnected'] })}
            editable
            {...handlers}
        />);

        expect(html).toContain('required but unconnected');
    });

    test('a driver node shows what it drives', () => {
        const html = render(<Inspector
            node={node({
                kind: 'feature',
                title: 'bass',
                subtitle: 'value',
                details: [{ label: 'drives', value: 'src#0.amount' }],
            })}
            editable
            {...handlers}
        />);

        expect(html).toContain('drives');
        expect(html).toContain('src#0.amount');
    });
});

describe('a fresh binding', () => {
    test('names the parameter it is for and starts somewhere visible', () => {
        const binding = defaultBinding('amount');

        expect(binding.parameter).toBe('amount');
        expect(binding.outputRange).toEqual([0, 1]);
        expect(binding.curve).toBe('linear');
    });
});
