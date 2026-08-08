import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import Inspector, { defaultBinding } from './Inspector';
import {
    ACCUMULATE_NODE,
    COMPOSITE_NODE,
    GRADE_NODE,
    PALETTE_NODE,
    type EditorNode,
} from '../../core/editor-view';

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
    onKernelInputs: vi.fn(),
    onPaletteId: vi.fn(),
    onPaletteStrength: vi.fn(),
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

    test('the grade exposes its values and audio bindings as editable controls', () => {
        const html = render(<Inspector
            node={node({
                id: GRADE_NODE,
                kind: 'kernel',
                title: 'Grade',
                parameters: [{
                    name: 'tint',
                    value: 0.8,
                    binding: defaultBinding('tint'),
                }],
            })}
            editable
            {...handlers}
        />);

        expect(html).toContain('value="0.8"');
        expect(html).toContain('>Unbind</button>');
        expect(html).toContain('attack / release');
        expect(html).not.toContain('>To input</button>');
    });

    test('the palette offers an explicit scheme and strength selection', () => {
        const html = render(<Inspector
            node={node({
                id: PALETTE_NODE,
                kind: 'kernel',
                title: 'Palette',
                subtitle: 'monochrome-noir',
                parameters: [{ name: 'strength', value: 0 }],
            })}
            editable
            {...handlers}
        />);

        expect(html).toContain('Palette scheme');
        expect(html).toContain('Monochrome Noir');
        expect(html).toContain('value="monochrome-noir" selected');
        expect(html).toContain('value="0"');
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
                availableInputs: [
                    { name: 'trn#0', required: false, connected: true },
                    { name: 'src#1', required: false, connected: false },
                ],
            })}
            editable
            layerOverrides={{ 'trn#0': { opacity: 0.5 } }}
            {...handlers}
        />);

        expect(html).toContain('from character');
        expect(html).toContain('placeholder="opacity"');
        expect(html).toContain('Add input');
        expect(html).toContain('src#1');
        expect(html).toContain('>Remove</button>');
        expect(html).toContain('>Use all</button>');
    });

    // A test for the motion sum's membership editing stood here. That stage no longer exists
    // (ADR-0012): where a field reaches the picture is an ordinary edge to an ordinary node, edited
    // on the canvas like any other, so there is no kernel-side membership left to pin.

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
