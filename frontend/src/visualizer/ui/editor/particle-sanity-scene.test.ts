import { describe, expect, test } from 'vitest';
import { resolveAuthoredScene } from '../../core/authored-scene';
import { createM1Registry } from '../../plugins/registry';
import { particleSanityScene } from './particle-sanity-scene';

describe('particle sanity scene', () => {
    test('is a complete music-independent physical particle graph', () => {
        const document = particleSanityScene();
        const resolved = resolveAuthoredScene(document, createM1Registry());

        expect(resolved.ok).toBe(true);
        expect(document.nodes.every((node) => node.bindings?.length === 0)).toBe(true);
        expect(document.nodes.find((node) => node.pluginId === 'ParticleRenderer:discs')?.parameters)
            .toEqual({ brightness: 1, debug: 1 });
        expect(document.nodes.filter((node) => node.pluginId.startsWith('ParticleCollider:')))
            .toHaveLength(2);
        // The scene draws exactly what the simulator produced this frame. That used to need the
        // kernel accumulation pinned to zero; with the accumulation gone (ADR-0013) it follows from
        // the graph holding no loop.
        expect(document.edges.some((edge) => edge.feedback)).toBe(false);
    });
});
