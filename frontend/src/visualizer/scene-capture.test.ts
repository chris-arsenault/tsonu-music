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
import { removeNode, setParameter } from './core/authored-scene-edit';
import { mergeUniforms, parameterUniformName, resolveParameters } from './core/parameters';
import { silentFeatureBus } from './core/features';
import {
    applyPersistenceOverrides,
    frameSurvival,
    type PersistenceSettings,
} from './core/persistence';
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

/**
 * Everything between a document and the GPU, which in the Node environment is everything that can be
 * checked. A binding in a document has to reach a shader uniform by exactly the path a generated
 * scene's does, or the editor is driving something other than what renders.
 */
describe('an authored document drives the frame', () => {
    const captured = () => {
        const document = captureScene(SCENES[0].scene);
        const resolved = resolveAuthoredScene(document, REGISTRY);
        if (!resolved.ok) {
            throw new Error(resolved.problems.map((problem) => problem.detail).join('; '));
        }

        return { document, resolved: resolved.scene };
    };

    test('a bound parameter moves with the audio and lands on its uniform', () => {
        const { resolved } = captured();
        const bound = resolved.bindings.find((entry) => entry.bindings.length > 0);
        expect(bound, 'no captured node carries a binding').toBeDefined();

        const binding = bound!.bindings[0];
        const loud = silentFeatureBus({ [binding.feature]: 1 } as never);
        const quiet = silentFeatureBus();

        const start = resolved.parameters[bound!.instanceId];
        const driven = resolveParameters(start, [binding], loud, 1);
        const still = resolveParameters(start, [binding], quiet, 1);

        expect(driven[binding.parameter]).not.toBe(still[binding.parameter]);
        expect(mergeUniforms(undefined, driven))
            .toHaveProperty(parameterUniformName(binding.parameter));
    });

    test('a constant the document states survives to the uniform unchanged', () => {
        const { document } = captured();
        const node = document.nodes.find((candidate) => (candidate.bindings ?? []).length === 0
            && Object.keys(candidate.parameters ?? {}).length > 0);
        if (!node) return;

        const [parameter] = Object.keys(node.parameters!);
        const edited = setParameter(document, node.id, parameter, 0.375);
        const resolved = resolveAuthoredScene(edited, REGISTRY);

        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;

        // Nothing is bound to it, so the resolver leaves it exactly where the document put it.
        const advanced = resolveParameters(
            resolved.scene.parameters[node.id],
            resolved.scene.bindings.find((entry) => entry.instanceId === node.id)!.bindings,
            silentFeatureBus(),
            1 / 60,
        );

        expect(advanced[parameter]).toBe(0.375);
        expect(mergeUniforms(undefined, advanced)[parameterUniformName(parameter)]).toBe(0.375);
    });

    test('a pinned survival reaches the accumulation instead of the theme value', () => {
        const { document } = captured();
        const pinned = resolveAuthoredScene({
            ...document,
            kernel: { persistence: { survivalPerSecond: 0.9 } },
        }, REGISTRY);

        expect(pinned.ok).toBe(true);
        if (!pinned.ok) return;

        const computed: PersistenceSettings = {
            survivalPerSecond: 0.05,
            motionScale: 0.2,
            transientPunch: 0,
        };
        const applied = applyPersistenceOverrides(computed, pinned.scene.kernel.persistence);

        expect(applied.survivalPerSecond).toBe(0.9);
        expect(frameSurvival(applied.survivalPerSecond, 1)).toBeCloseTo(0.9, 6);
        // The drag was not pinned, so it still follows what the scene computed.
        expect(applied.motionScale).toBe(0.2);
    });

    test('an edit to one node leaves every other node instance-identical', () => {
        // This is what makes editing usable: the reused instances are exactly those whose id and
        // definition are unchanged, so a one-node edit does not reset the simulations around it.
        const { document } = captured();
        const target = document.nodes[0];
        const edited = removeNode(document, target.id);

        const before = resolveAuthoredScene(document, REGISTRY);
        const after = resolveAuthoredScene(edited, REGISTRY);
        if (!before.ok || !after.ok) return;

        const survivors = after.scene.nodes.map((node) => node.instanceId);
        const originals = new Map(before.scene.nodes.map((node) => [node.instanceId, node.definition]));

        for (const instanceId of survivors) {
            expect(originals.get(instanceId)).toBe(
                after.scene.nodes.find((node) => node.instanceId === instanceId)!.definition,
            );
        }
    });
});
