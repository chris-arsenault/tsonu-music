import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import NodeSearch, { dismissNodeSearch } from './NodeSearch';
import type { PluginCategory, PluginPort, VisualPluginDefinition } from '../../core/plugin';

function plugin(
    id: string,
    category: PluginCategory,
    inputs: PluginPort[] = [],
    outputs: PluginPort[] = [{ name: 'color', type: 'color-texture', required: false }],
): VisualPluginDefinition {
    return {
        id,
        version: 1,
        category,
        inputs,
        outputs,
        capabilities: [],
        cost: { gpu: 1, cpu: 1, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.5, motionEnergy: 0.5, geometricOrder: 0.5,
            recognizability: 0.5, persistence: 0.5, brightness: 0.5, dominance: 'either',
        },
        activationRules: { activationWeight: 1 },
        create: () => ({
            initialize: () => undefined,
            activate: () => undefined,
            update: () => undefined,
            render: () => [],
            deactivate: () => undefined,
            destroy: () => undefined,
        }),
    };
}

const CATALOG = [
    plugin('SignalTraceSource:circular', 'source'),
    plugin('ColorTransform:solarize', 'compositor', [
        { name: 'source', type: 'color-texture', required: true },
    ]),
    plugin('ParticleSimulator', 'simulator', [
        { name: 'force', type: 'vector-field', required: true },
    ]),
    plugin('ParticleForceField:vortex', 'field', [], [
        { name: 'force', type: 'vector-field', required: false },
    ]),
];

const handlers = { onPick: vi.fn(), onClose: vi.fn() };
const MASKS = [{
    resource: 'asset:mask:tree-of-life-full',
    name: 'mask:tree-of-life-full',
    type: 'mask-texture' as const,
}];

describe('node search', () => {
    test('Escape closes the search without choosing a node', () => {
        const event = {
            key: 'Escape',
            preventDefault: vi.fn(),
            stopImmediatePropagation: vi.fn(),
        };
        const onClose = vi.fn();
        const onPick = vi.fn();

        expect(dismissNodeSearch(event, onClose)).toBe(true);
        expect(onClose).toHaveBeenCalledOnce();
        expect(onPick).not.toHaveBeenCalled();
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    });

    test('lists the catalog when nothing constrains it', () => {
        const html = renderToStaticMarkup(<NodeSearch catalog={CATALOG} {...handlers} />);

        expect(html).toContain('SignalTraceSource:circular');
        expect(html).toContain('ColorTransform:solarize');
        expect(html).toContain('ParticleSimulator');
        expect(html).toContain('search the catalog');
    });

    test('a link being dropped narrows it to what could take that link', () => {
        // A hundred and fifty plugins is unusable without this, and offering one that cannot take the
        // link is offering a connection that will not be made.
        const html = renderToStaticMarkup(
            <NodeSearch
                catalog={CATALOG}
                portFilter={{ kind: 'input', type: 'color-texture' }}
                {...handlers}
            />,
        );

        expect(html).toContain('ColorTransform:solarize');
        expect(html).not.toContain('ParticleSimulator');
        // A source has no inputs, so it cannot receive one either.
        expect(html).not.toContain('SignalTraceSource:circular');
    });

    test('it names the port a result would connect to', () => {
        const html = renderToStaticMarkup(
            <NodeSearch
                catalog={CATALOG}
                portFilter={{ kind: 'input', type: 'color-texture' }}
                {...handlers}
            />,
        );

        expect(html).toContain('>source</span>');
    });

    test('a type nothing accepts says so rather than showing an empty box', () => {
        const html = renderToStaticMarkup(
            <NodeSearch
                catalog={CATALOG}
                portFilter={{ kind: 'input', type: 'palette' }}
                {...handlers}
            />,
        );

        expect(html).toContain('nothing takes a palette');
    });

    test('substitutable types are offered, as the compiler accepts them', () => {
        // A distance field satisfies a mask input, and the search uses the compiler's own rule.
        const masked = plugin('MaskRouter', 'compositor', [
            { name: 'mask', type: 'mask-texture', required: true },
        ]);
        const html = renderToStaticMarkup(
            <NodeSearch
                catalog={[masked]}
                portFilter={{ kind: 'input', type: 'distance-field' }}
                {...handlers}
            />,
        );

        expect(html).toContain('MaskRouter');
    });

    test('dragging from an input offers plugins with compatible outputs', () => {
        const html = renderToStaticMarkup(
            <NodeSearch
                catalog={CATALOG}
                portFilter={{ kind: 'output', type: 'vector-field' }}
                {...handlers}
            />,
        );

        expect(html).toContain('ParticleForceField:vortex');
        expect(html).not.toContain('ParticleSimulator');
        expect(html).toContain('plugins producing vector-field');
        expect(html).toContain('>force</span>');
    });

    test('dragging from a mask input offers loaded packaged masks', () => {
        const html = renderToStaticMarkup(
            <NodeSearch
                catalog={CATALOG}
                assets={MASKS}
                portFilter={{ kind: 'output', type: 'mask-texture' }}
                {...handlers}
            />,
        );

        expect(html).toContain('mask:tree-of-life-full');
        expect(html).toContain('>asset</span>');
    });

    test('assets are not offered as disconnected plugin nodes', () => {
        const html = renderToStaticMarkup(
            <NodeSearch catalog={CATALOG} assets={MASKS} {...handlers} />,
        );

        expect(html).not.toContain('mask:tree-of-life-full');
    });
});
