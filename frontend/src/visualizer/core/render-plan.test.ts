import { describe, expect, test } from 'vitest';
import {
    estimateTargetMemory,
    liveKeys,
    planTargets,
    targetKey,
    withRetiringNodes,
} from './render-plan';
import type { CompiledGraph, CompiledNode } from './graph';

function graph(overrides: Partial<CompiledGraph> = {}): CompiledGraph {
    return {
        order: [],
        resources: [
            { id: 'a.color', type: 'color-texture', producedBy: 'a', port: 'color' },
            { id: 'b.color', type: 'color-texture', producedBy: 'b', port: 'color' },
        ],
        pingPong: [],
        present: 'b.color',
        ...overrides,
    };
}

describe('target planning', () => {
    test('allocates one target per resource', () => {
        const plan = planTargets(graph(), 800, 600, 1, 0);

        expect(plan.targets).toHaveLength(2);
        expect(plan.targets.map((target) => target.key)).toEqual(['a.color', 'b.color']);
        expect(plan.width).toBe(800);
        expect(plan.height).toBe(600);
    });

    test('quality scale reduces every target together', () => {
        const plan = planTargets(graph(), 800, 600, 0.5, 0);

        expect(plan.width).toBe(400);
        expect(plan.height).toBe(300);
        for (const target of plan.targets) {
            expect(target.width).toBe(400);
            expect(target.height).toBe(300);
        }
    });

    test('never plans below a usable minimum', () => {
        const plan = planTargets(graph(), 800, 600, 0.001, 0);

        expect(plan.width).toBeGreaterThanOrEqual(16);
        expect(plan.height).toBeGreaterThanOrEqual(16);
    });

    test('a zero or negative scale still yields a valid plan', () => {
        expect(planTargets(graph(), 800, 600, 0, 0).width).toBe(16);
        expect(planTargets(graph(), 800, 600, -1, 0).width).toBe(16);
    });

    test('scale above one is clamped', () => {
        const plan = planTargets(graph(), 800, 600, 4, 0);

        expect(plan.width).toBe(800);
    });

    test('resolves the present key from the graph output', () => {
        const plan = planTargets(graph(), 800, 600, 1, 0);

        expect(plan.presentKey).toBe('b.color');
    });

    test('a graph with nothing to present has no present key', () => {
        const plan = planTargets(graph({ present: undefined }), 800, 600, 1, 0);

        expect(plan.presentKey).toBeUndefined();
    });
});

describe('ping-pong slots', () => {
    const feedback = graph({ pingPong: ['b.color'] });

    test('a ping-pong resource gets two targets', () => {
        const plan = planTargets(feedback, 400, 400, 1, 0);

        expect(plan.targets.map((target) => target.key)).toEqual([
            'a.color',
            targetKey('b.color', 0),
            targetKey('b.color', 1),
        ]);
    });

    test('reads and writes never land on the same slot', () => {
        for (const parity of [0, 1, 2, 3]) {
            const plan = planTargets(feedback, 400, 400, 1, parity);
            expect(plan.writeKeys['b.color']).not.toBe(plan.readKeys['b.color']);
        }
    });

    test('slots alternate with frame parity', () => {
        const even = planTargets(feedback, 400, 400, 1, 0);
        const odd = planTargets(feedback, 400, 400, 1, 1);

        expect(even.writeKeys['b.color']).toBe(targetKey('b.color', 0));
        expect(odd.writeKeys['b.color']).toBe(targetKey('b.color', 1));
        // What was written last frame is what is read this frame.
        expect(odd.readKeys['b.color']).toBe(even.writeKeys['b.color']);
    });

    test('a single-buffered resource reads and writes the same key', () => {
        const plan = planTargets(feedback, 400, 400, 1, 0);

        expect(plan.writeKeys['a.color']).toBe(plan.readKeys['a.color']);
    });

    test('the present key follows the written slot', () => {
        const even = planTargets(feedback, 400, 400, 1, 0);
        const odd = planTargets(feedback, 400, 400, 1, 1);

        expect(even.presentKey).toBe(targetKey('b.color', 0));
        expect(odd.presentKey).toBe(targetKey('b.color', 1));
    });
});

describe('pool bookkeeping', () => {
    test('live keys cover every planned target', () => {
        const plan = planTargets(graph({ pingPong: ['b.color'] }), 400, 400, 1, 0);
        const keys = liveKeys(plan);

        expect(keys.size).toBe(3);
        expect(keys.has('a.color')).toBe(true);
        expect(keys.has(targetKey('b.color', 1))).toBe(true);
    });

    test('memory estimate scales with area and target count', () => {
        const single = estimateTargetMemory(planTargets(graph(), 100, 100, 1, 0));
        const halved = estimateTargetMemory(planTargets(graph(), 100, 100, 0.5, 0));

        // Two 100x100 RGBA16F targets.
        expect(single).toBe(2 * 100 * 100 * 8);
        // Half scale is a quarter of the area.
        expect(halved).toBeCloseTo(single / 4, 0);
    });

    test('feedback doubles the memory of its resource', () => {
        const plain = estimateTargetMemory(planTargets(graph(), 100, 100, 1, 0));
        const withFeedback = estimateTargetMemory(planTargets(graph({ pingPong: ['b.color'] }), 100, 100, 1, 0));

        expect(withFeedback).toBe(plain + 100 * 100 * 8);
    });
});

/**
 * A plugin that has left the graph keeps rendering until its deactivation policy finishes, into the
 * resources it already owned. Planning has to cover those — including their ping-pong slots.
 */
describe('retiring nodes in the plan', () => {
    const node = (instanceId: string, feedback: boolean): CompiledNode => ({
        instanceId,
        definition: {
            id: instanceId.split('#')[0],
            version: 1,
            category: 'transformer',
            inputs: [],
            outputs: [{ name: 'color', type: 'color-texture', required: false }],
            capabilities: feedback ? ['feedback'] : [],
            cost: { gpu: 1, cpu: 1, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
            character: {
                visualDensity: 0.5, motionEnergy: 0.5, geometricOrder: 0.5,
                recognizability: 0.5, persistence: 0.5, brightness: 0.5, dominance: 'either',
            },
            activationRules: { activationWeight: 1 },
            create: () => ({
                initialize: () => undefined, activate: () => undefined, update: () => undefined,
                render: () => [], deactivate: () => undefined, destroy: () => undefined,
            }),
        },
        inputs: {},
        outputs: { color: `${instanceId}.color` },
        previous: feedback ? { history: `${instanceId}.color` } : {},
    });

    const live: CompiledGraph = {
        order: [],
        resources: [{ id: 'a.color', type: 'color-texture', producedBy: 'a', port: 'color' }],
        pingPong: [],
        present: 'a.color',
    };

    test('a graph with nothing retiring is returned unchanged', () => {
        expect(withRetiringNodes(live, [])).toBe(live);
    });

    test('a retiring node contributes its resources', () => {
        const extended = withRetiringNodes(live, [node('Old:mode#3', false)]);

        expect(extended.resources.map((entry) => entry.id))
            .toEqual(['a.color', 'Old:mode#3.color']);
    });

    test('a retiring feedback node keeps two slots, so it does not sample what it writes', () => {
        // Planned with one buffer, the read and write keys collapse to the same texture. The driver
        // rejects that draw, so the departing branch renders nothing for its whole retirement.
        const retiring = node('Feedback:vortex#3', true);
        const plan = planTargets(withRetiringNodes(live, [retiring]), 800, 600, 1, 0);

        expect(plan.writeKeys['Feedback:vortex#3.color'])
            .not.toBe(plan.readKeys['Feedback:vortex#3.color']);
    });

    test('a live ping-pong resource is not lost when something retires', () => {
        const withLoop: CompiledGraph = { ...live, pingPong: ['a.color'] };
        const extended = withRetiringNodes(withLoop, [node('Feedback:vortex#3', true)]);

        expect(extended.pingPong).toContain('a.color');
        expect(extended.pingPong).toContain('Feedback:vortex#3.color');
    });
});
