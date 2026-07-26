import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import NodeSearch from './NodeSearch';
import type { PluginCategory, PluginPort, VisualPluginDefinition } from '../../core/plugin';

function plugin(
    id: string,
    category: PluginCategory,
    inputs: PluginPort[] = [],
): VisualPluginDefinition {
    return {
        id,
        version: 1,
        category,
        inputs,
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
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
];

const handlers = { onPick: vi.fn(), onClose: vi.fn() };

describe('node search', () => {
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
            <NodeSearch catalog={CATALOG} acceptingType="color-texture" {...handlers} />,
        );

        expect(html).toContain('ColorTransform:solarize');
        expect(html).not.toContain('ParticleSimulator');
        // A source has no inputs, so it cannot receive one either.
        expect(html).not.toContain('SignalTraceSource:circular');
    });

    test('it names the port a result would connect to', () => {
        const html = renderToStaticMarkup(
            <NodeSearch catalog={CATALOG} acceptingType="color-texture" {...handlers} />,
        );

        expect(html).toContain('>source</span>');
    });

    test('a type nothing accepts says so rather than showing an empty box', () => {
        const html = renderToStaticMarkup(
            <NodeSearch catalog={CATALOG} acceptingType="palette" {...handlers} />,
        );

        expect(html).toContain('nothing takes a palette');
    });

    test('substitutable types are offered, as the compiler accepts them', () => {
        // A distance field satisfies a mask input, and the search uses the compiler's own rule.
        const masked = plugin('MaskRouter', 'compositor', [
            { name: 'mask', type: 'mask-texture', required: true },
        ]);
        const html = renderToStaticMarkup(
            <NodeSearch catalog={[masked]} acceptingType="distance-field" {...handlers} />,
        );

        expect(html).toContain('MaskRouter');
    });
});
