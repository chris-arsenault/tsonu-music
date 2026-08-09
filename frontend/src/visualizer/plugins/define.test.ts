/**
 * The persistence primitive `defineShaderPlugin` gives a compositing producer (ADR-0014).
 */

import { describe, expect, test } from 'vitest';
import {
    DEFAULT_SURVIVAL,
    SURVIVAL_PARAMETER,
    character,
    decayShaderId,
    defineShaderPlugin,
    driftShaderId,
} from './define';
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

describe('a compositing colour producer ages its target', () => {
    const compositing = plugin({ blend: 'lighten' });

    test('the decay pass runs before the plugin draws', () => {
        const passes = passesOf(compositing);

        expect(passes).toHaveLength(2);
        expect(passes[0]).toMatchObject({
            shader: decayShaderId('Fixture'),
            output: 'out.color',
            blend: 'multiply',
            clear: false,
        });
        expect(passes[1]).toMatchObject({ shader: 'Fixture', blend: 'lighten' });
    });

    test('the decay reads nothing, so it needs no second slot', () => {
        expect(passesOf(compositing)[0]?.inputs).toBeUndefined();
    });

    test('the plugin pass cannot clear the memory it is compositing into', () => {
        const insistent = plugin({ blend: 'lighten', clear: true });

        expect(passesOf(insistent)[1]).toMatchObject({ clear: false });
    });

    test('survival is an ordinary parameter, so it can be bound', () => {
        expect(compositing.parameters?.[SURVIVAL_PARAMETER]).toBe(DEFAULT_SURVIVAL);
    });

    test('a plugin stating its own survival keeps it', () => {
        const slow = plugin({ blend: 'lighten', parameters: { survival: 0.95 } });

        expect(slow.parameters?.[SURVIVAL_PARAMETER]).toBe(0.95);
    });

    test('the decay shader is registered alongside the plugin\'s own', () => {
        expect(registeredShaders(compositing)).toContain(decayShaderId('Fixture'));
    });

    test('the extra pass is counted, so the performance ladder budgets for it', () => {
        expect(compositing.cost.renderPasses).toBe(2);
    });
});

describe('a retained producer carries its memory along the field', () => {
    const drifting = plugin({
        blend: 'lighten',
        inputs: [{ name: 'field', type: 'vector-field', required: false }],
    });

    function aged(previous: Record<string, string>, inputs: Record<string, string>) {
        const instance = drifting.create({ instanceId: 'f', seed: 0.5, registerShader: () => undefined });
        instance.initialize();

        return instance.render({
            inputs,
            outputs: { color: 'out.color' },
            previous,
            renderWidth: 64,
            renderHeight: 64,
        })[0];
    }

    test('the ageing pass samples the previous frame through the field', () => {
        expect(aged({ color: 'out.color' }, { field: 'in.field' })).toMatchObject({
            shader: driftShaderId('Fixture'),
            inputs: { uPrevious: 'out.color', uField: 'in.field' },
            output: 'out.color',
            blend: 'none',
            clear: false,
        });
    });

    test('the colour output declares the retention that buys the second slot', () => {
        expect(drifting.outputs.find((port) => port.name === 'color')?.retained).toBe(true);
    });

    test('no field wired falls back to the decay, which costs no memory', () => {
        expect(aged({ color: 'out.color' }, {})).toMatchObject({ blend: 'multiply' });
    });

    test('no second slot planned falls back too, rather than sampling the target it writes', () => {
        expect(aged({}, { field: 'in.field' })).toMatchObject({ blend: 'multiply' });
    });
});

describe('a producer that replaces its target is left alone', () => {
    const replacing = plugin();

    test('no decay pass, because it would be overwritten in the same frame', () => {
        const passes = passesOf(replacing);

        expect(passes).toHaveLength(1);
        expect(passes[0]).toMatchObject({ shader: 'Fixture', blend: 'none' });
    });

    test('no survival parameter, because nothing survives a replacement', () => {
        expect(replacing.parameters?.[SURVIVAL_PARAMETER]).toBeUndefined();
    });

    test('no decay shader registered', () => {
        expect(registeredShaders(replacing)).not.toContain(decayShaderId('Fixture'));
    });
});

describe('persistence is for colour', () => {
    test('a compositing pass writing a field gets no decay', () => {
        const field = plugin({
            blend: 'add',
            outputs: [{ name: 'field', type: 'vector-field' }],
        });

        expect(passesOf(field)).toHaveLength(1);
        expect(field.parameters?.[SURVIVAL_PARAMETER]).toBeUndefined();
    });
});
