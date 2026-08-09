/** Current-frame behavior of the generic fullscreen plugin helper. */

import { describe, expect, test } from 'vitest';
import { character, defineShaderPlugin } from './define';
import { silentFeatureBus } from '../core/features';
import { createImpactBus } from '../core/impact';
import type { RenderPass } from '../core/passes';
import type { SelectionCharacter, VisualPluginDefinition } from '../core/plugin';

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
void main() { fragColor = vec4(vUv, 0.0, 1.0); }`;

const CHARACTER: SelectionCharacter = character();

function plugin(overrides: Partial<Parameters<typeof defineShaderPlugin>[0]> = {}) {
    return defineShaderPlugin({
        id: 'Fixture',
        category: 'source',
        inputs: [],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: [],
        fragment: FRAGMENT,
        character: CHARACTER,
        ...overrides,
    });
}

function passesOf(definition: VisualPluginDefinition): RenderPass[] {
    const shaders: string[] = [];
    const instance = definition.create({
        instanceId: 'fixture',
        seed: 0.5,
        registerShader: (source) => shaders.push(source.id),
    });

    instance.initialize();
    instance.activate({
        clock: { trackId: 't', playbackTime: 0, duration: 1, state: 'playing', generation: 1 },
        parameters: definition.parameters ?? {},
    });
    instance.update({
        clock: { trackId: 't', playbackTime: 0, duration: 1, state: 'playing', generation: 1 },
        features: silentFeatureBus(),
        deltaSeconds: 1 / 60,
        seed: 0.5,
        renderWidth: 64,
        renderHeight: 64,
        parameters: {},
        uploadGeometry: () => undefined,
        impacts: createImpactBus(),
        publishImpacts: () => undefined,
        inputs: {},
        readField: () => undefined,
    });

    return [...instance.render({
        inputs: {},
        outputs: Object.fromEntries(definition.outputs.map((port) => [port.name, `out.${port.name}`])),
        previous: {},
        renderWidth: 64,
        renderHeight: 64,
    })];
}

function registeredShaders(definition: VisualPluginDefinition): string[] {
    const shaders: string[] = [];
    definition.create({
        instanceId: 'fixture',
        seed: 0.5,
        registerShader: (source) => shaders.push(source.id),
    }).initialize();

    return shaders;
}

describe('a generic shader plugin produces a current-frame value', () => {
    const compositing = plugin({ blend: 'lighten' });

    test('one pass draws the plugin output', () => {
        const passes = passesOf(compositing);

        expect(passes).toHaveLength(1);
        expect(passes[0]).toMatchObject({
            shader: 'Fixture',
            output: 'out.color',
            blend: 'lighten',
            clear: true,
        });
    });

    test('only the plugin shader is registered', () => {
        expect(registeredShaders(compositing)).toEqual(['Fixture']);
    });

    test('the cost matches the pass that runs', () => {
        expect(compositing.cost.renderPasses).toBe(1);
    });

    test('an explicitly non-clearing state pass remains non-clearing', () => {
        const state = plugin({
            clear: false,
            outputs: [{ name: 'field', type: 'reaction-diffusion-state' }],
        });

        expect(passesOf(state)[0]).toMatchObject({ clear: false });
    });
});
