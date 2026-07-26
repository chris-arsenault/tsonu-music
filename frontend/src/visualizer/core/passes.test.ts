import { describe, expect, test } from 'vitest';
import {
    countPasses,
    isGeometryPass,
    passInputs,
    passOutputs,
    unreachableInstances,
    type RenderPass,
} from './passes';

const fullscreen: RenderPass = {
    kind: 'fullscreen',
    shader: 'blur',
    inputs: { uSource: 'a.color' },
    output: 'b.color',
};

const geometry: RenderPass = {
    kind: 'geometry',
    shader: 'trace',
    geometry: 'waveform',
    primitive: 'line-strip',
    vertexCount: 512,
    output: 'a.color',
};

describe('pass descriptors', () => {
    test('distinguishes geometry from fullscreen passes', () => {
        expect(isGeometryPass(geometry)).toBe(true);
        expect(isGeometryPass(fullscreen)).toBe(false);
    });

    test('counts passes for cost accounting', () => {
        expect(countPasses([])).toBe(0);
        expect(countPasses([fullscreen, geometry])).toBe(2);
    });

    test('collects every resource read', () => {
        const passes: RenderPass[] = [
            fullscreen,
            { ...fullscreen, inputs: { uSource: 'c.color', uMask: 'm.mask' } },
        ];

        expect(passInputs(passes).sort()).toEqual(['a.color', 'c.color', 'm.mask']);
    });

    test('deduplicates resources read by several passes', () => {
        expect(passInputs([fullscreen, fullscreen])).toEqual(['a.color']);
    });

    test('collects every resource written', () => {
        expect(passOutputs([fullscreen, geometry]).sort()).toEqual(['a.color', 'b.color']);
    });

    test('a pass with no declared output contributes none', () => {
        const withoutOutput: RenderPass = {
            kind: 'fullscreen',
            shader: 'blur',
            inputs: { uSource: 'a.color' },
        };

        expect(passOutputs([withoutOutput])).toEqual([]);
    });

    test('a pass with no inputs contributes none', () => {
        expect(passInputs([geometry])).toEqual([]);
    });
});

// The `quality scaling` block that stood here tested `resolvePassScale`, which had no caller outside
// this file. Target sizes come from the render plan, which assigns them per resource from the port
// type before any pass is built; recomputing a size at execution disagreed with what was allocated
// and made every scaled pass delete and recreate its texture each frame. The field and the function
// are gone rather than left as a knob that reads as live.

describe('suppression strands whatever fed the suppressed plugin', () => {
    const isTerminal = (type: string) => type === 'color-texture' || type === 'vector-field';

    /** field -> simulator -> renderer, the chain that made this visible. */
    const CHAIN = [
        {
            instanceId: 'Field#0',
            inputs: {},
            outputs: { field: 'Field#0.field' },
            definition: { outputs: [{ name: 'field', type: 'vector-field' }] },
        },
        {
            instanceId: 'Simulator#1',
            inputs: { force: 'Field#0.field' },
            outputs: { state: 'Simulator#1.state' },
            definition: { outputs: [{ name: 'state', type: 'particle-buffer' }] },
        },
        {
            instanceId: 'Renderer#2',
            inputs: { state: 'Simulator#1.state' },
            outputs: { color: 'Renderer#2.color' },
            definition: { outputs: [{ name: 'color', type: 'color-texture' }] },
        },
    ] as never;

    test('nothing is stranded when the whole chain runs', () => {
        expect([...unreachableInstances(CHAIN, new Set(), isTerminal as never)]).toEqual([]);
    });

    test('a suppressed renderer takes its simulator with it', () => {
        // The simulator writes a particle buffer, which is never a colour texture, so with the
        // renderer gone it produces no pixels at all — while still costing a full simulation pass
        // every frame.
        const dead = unreachableInstances(CHAIN, new Set(['Renderer#2']), isTerminal as never);

        expect(dead.has('Simulator#1')).toBe(true);
    });

    test('a field that still reaches the motion bus survives its consumer', () => {
        // Vector fields are summed by the kernel whether or not anything else reads them, so the
        // field is terminal in its own right.
        const dead = unreachableInstances(CHAIN, new Set(['Renderer#2']), isTerminal as never);

        expect(dead.has('Field#0')).toBe(false);
    });
});
