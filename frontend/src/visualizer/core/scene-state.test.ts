import { describe, expect, test } from 'vitest';
import { createM1Registry, firstLightScene } from '../plugins/registry';
import { createSignalTraceSource } from '../plugins/sources/signal-trace';
import { createTemporalTransform } from '../plugins/transformers/transforms';
import { compileSceneGraph } from './graph';
import { layersForGraph } from './layers';

describe('canonical scene state', () => {
    test('accepts one explicit previous-state warp and combine', () => {
        const scene = firstLightScene(createM1Registry());
        const result = compileSceneGraph(scene.nodes, scene.edges, scene.present);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.graph.state).toMatchObject({
            combineInstanceId: 'state',
            warpInstanceId: 'history',
            stateResource: 'state.color',
            materialRoots: ['tone'],
        });
        expect(layersForGraph(result.graph)).toMatchObject([
            { id: 'state.color', color: 'state.color' },
        ]);
    });

    test('accepts a material trail beside the canonical state loop', () => {
        // The canonical form constrains the state, not the material (ADR-0016): exactly one
        // previous-frame read of the combine output, with plugin trails legal beside it.
        const scene = firstLightScene(createM1Registry());
        const echo = createTemporalTransform('echo');
        const nodes = [...scene.nodes, { instanceId: 'echo', definition: echo }];
        const edges = scene.edges.map((edge) =>
            edge.from.instanceId === 'tone' && edge.to.instanceId === 'state'
                ? { ...edge, to: { instanceId: 'echo', port: 'source' } }
                : edge);

        const result = compileSceneGraph(nodes, [
            ...edges,
            { from: { instanceId: 'echo', port: 'color' }, to: { instanceId: 'state', port: 'source' } },
            {
                from: { instanceId: 'echo', port: 'color' },
                to: { instanceId: 'echo', port: 'history' },
                feedback: true,
            },
        ], scene.present);

        expect(result.ok ? [] : result.errors).toEqual([]);
        expect(result.ok).toBe(true);
    });

    test('rejects a historical label that does not return the displayed state', () => {
        const scene = firstLightScene(createM1Registry());
        const edges = scene.edges.map((edge) => edge.feedback
            ? {
                from: { instanceId: 'history', port: 'color' },
                to: { instanceId: 'history', port: 'source' },
                feedback: true,
            }
            : edge);
        const result = compileSceneGraph(scene.nodes, edges, scene.present);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors).toContain('scene requires exactly one previous-frame read of the combine output; found 0');
    });

    test('rejects a material branch that bypasses the fresh-state input', () => {
        const scene = firstLightScene(createM1Registry());
        const result = compileSceneGraph([
            ...scene.nodes,
            { instanceId: 'bypass', definition: createSignalTraceSource('oscilloscope') },
        ], scene.edges, scene.present);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors).toContain('visible material root bypass bypasses the scene state');
    });

    test('rejects a scene that presents an ordinary image output', () => {
        const scene = firstLightScene(createM1Registry());
        const result = compileSceneGraph(scene.nodes, scene.edges, { instanceId: 'tone', port: 'color' });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors).toContain('scene must present state.color');
    });

    test('genuinely new scenes cannot alias active or retiring render targets', () => {
        const scene = firstLightScene(createM1Registry());
        const first = compileSceneGraph(scene.nodes, scene.edges, scene.present, [], 'first');
        const second = compileSceneGraph(scene.nodes, scene.edges, scene.present, [], 'second');

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        if (!first.ok || !second.ok) return;

        expect(first.graph.order.map((node) => node.instanceId))
            .toEqual(second.graph.order.map((node) => node.instanceId));
        expect(first.graph.state!.stateResource).toBe('scene:first/state.color');
        expect(second.graph.state!.stateResource).toBe('scene:second/state.color');
        const firstResources = new Set(first.graph.resources.map((resource) => resource.id));
        expect(second.graph.resources.some((resource) => firstResources.has(resource.id))).toBe(false);
    });
});
