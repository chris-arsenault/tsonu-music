/**
 * Capture fidelity, against the real catalog.
 *
 * The claim the editor rests on is that a scene the scheduler built can be frozen into a document and
 * that resolving the document gives back the same graph. Anything less and the editor is studying
 * something other than what was on screen, which is worse than not having it.
 */

import { describe, expect, test } from 'vitest';
import { allDefinitions, createM1Registry } from './plugins/registry';
import { THEMES } from './plugins/themes';
import { buildScene } from './core/scene-builder';
import { profileFor } from './core/performance';
import { captureScene } from './core/scene-capture';
import { resolveAuthoredScene } from './core/authored-scene';
import { assetResourceId, type AssetResource } from './core/wiring';
import type { BuiltScene } from './core/scene-builder';

const CATALOG = allDefinitions();
const REGISTRY = createM1Registry();

const ASSETS: AssetResource[] = [
    { resource: assetResourceId('album-art'), type: 'color-texture' },
    { resource: assetResourceId('ring'), type: 'mask-texture' },
];

const CONTEXT = {
    available: CATALOG,
    assets: ['album-art', 'ring'],
    assetResources: ASSETS,
    capabilities: ['float-textures', 'webgl2'],
    history: {},
    playbackTime: 0,
};

/** Every theme that builds, so capture is exercised across the families rather than one of them. */
function builtScenes(): { themeId: string; scene: BuiltScene }[] {
    const scenes: { themeId: string; scene: BuiltScene }[] = [];

    for (const theme of THEMES) {
        for (const entropy of ['capture-a', 'capture-b', 'capture-c']) {
            const result = buildScene(entropy, theme, CONTEXT, profileFor(0));
            if (result.ok) {
                scenes.push({ themeId: theme.id, scene: result.scene });
            }
        }
    }

    return scenes;
}

const SCENES = builtScenes();

describe('capturing a generated scene', () => {
    test('there is something to capture', () => {
        expect(SCENES.length).toBeGreaterThan(0);
    });

    test('a captured scene resolves to the graph it was captured from', () => {
        for (const { themeId, scene } of SCENES) {
            const resolved = resolveAuthoredScene(captureScene(scene), REGISTRY);

            expect(
                resolved.ok,
                resolved.ok ? '' : `${themeId}: ${resolved.problems.map((p) => p.detail).join('; ')}`,
            ).toBe(true);
            if (!resolved.ok) continue;

            expect(resolved.scene.graph.order.map((node) => node.instanceId), themeId)
                .toEqual(scene.graph.order.map((node) => node.instanceId));
            expect(resolved.scene.graph.resources, themeId).toEqual(scene.graph.resources);
            expect(resolved.scene.graph.pingPong, themeId).toEqual(scene.graph.pingPong);
            expect(resolved.scene.graph.present, themeId).toBe(scene.graph.present);
        }
    });

    test('every node keeps the inputs it was compiled with, including asset-fed ones', () => {
        for (const { themeId, scene } of SCENES) {
            const resolved = resolveAuthoredScene(captureScene(scene), REGISTRY);
            if (!resolved.ok) continue;

            for (const original of scene.graph.order) {
                const captured = resolved.scene.graph.order
                    .find((node) => node.instanceId === original.instanceId);

                expect(captured?.inputs, `${themeId} ${original.instanceId}`).toEqual(original.inputs);
                expect(captured?.previous, `${themeId} ${original.instanceId}`).toEqual(original.previous);
            }
        }
    });

    test('the distributed bindings survive the round trip', () => {
        for (const { themeId, scene } of SCENES) {
            const resolved = resolveAuthoredScene(captureScene(scene), REGISTRY);
            if (!resolved.ok) continue;

            for (const original of scene.bindings) {
                const captured = resolved.scene.bindings
                    .find((entry) => entry.instanceId === original.instanceId);

                expect(captured?.bindings, `${themeId} ${original.instanceId}`)
                    .toEqual(original.bindings);
            }
        }
    });

    test('the entropy comes across, so the colour scheme is reproducible', () => {
        for (const { scene } of SCENES) {
            const document = captureScene(scene);

            expect(document.entropy).toBe(scene.entropy);
            expect(document.themeId).toBe(scene.theme.id);
        }
    });

    test('positions place a consumer to the right of everything feeding it', () => {
        for (const { themeId, scene } of SCENES) {
            const document = captureScene(scene);
            const at = new Map(document.nodes.map((node) => [node.id, node.position]));

            for (const edge of document.edges) {
                if (edge.feedback) continue;

                expect(
                    at.get(edge.to.node)!.x,
                    `${themeId} ${edge.id}`,
                ).toBeGreaterThan(at.get(edge.from.node)!.x);
            }
        }
    });

    test('no two nodes land on the same spot', () => {
        for (const { themeId, scene } of SCENES) {
            const document = captureScene(scene);
            const spots = document.nodes.map((node) => `${node.position.x},${node.position.y}`);

            expect(new Set(spots).size, themeId).toBe(spots.length);
        }
    });

    test('capture is deterministic', () => {
        for (const { scene } of SCENES) {
            expect(captureScene(scene)).toEqual(captureScene(scene));
        }
    });
});
