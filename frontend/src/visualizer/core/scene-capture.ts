/**
 * Freezing a generated scene into an editable document.
 *
 * The move that makes the visualizer debuggable: whatever the scheduler put on screen becomes a
 * document that reproduces it, and reproduces it without the die roll. From there a fault can be
 * narrowed one node at a time, exported, and pasted into a test.
 *
 * Kept apart from `authored-scene.ts` so that module stays free of the scheduler: resolving a
 * document must not require the machinery that generates one.
 */

import {
    AUTHORED_SCENE_VERSION,
    edgeIdFor,
    type AuthoredEdge,
    type AuthoredNode,
    type AuthoredScene,
} from './authored-scene';
import { layoutNodes, type LayoutOptions } from './graph-layout';
import type { BuiltScene } from './scene-builder';

/**
 * Captures the scene as it is running, values and all.
 *
 * Parameters are written as the values in force rather than as the overrides that produced them: a
 * captured document is a record of what was on screen, so it must keep working when a plugin's
 * defaults later change. The entropy comes across too, because the colour scheme and every instance
 * seed derive from it and a document that renders in a different palette is not the scene that was
 * captured.
 */
export function captureScene(scene: BuiltScene, layout: LayoutOptions = {}): AuthoredScene {
    const positions = layoutNodes(
        scene.wired.nodes.map((node, index) => ({ id: node.instanceId, weight: index })),
        scene.wired.edges.map((edge) => ({
            from: edge.from.instanceId,
            to: edge.to.instanceId,
            feedback: edge.feedback,
        })),
        layout,
    );

    const nodes: AuthoredNode[] = scene.wired.nodes.map((node) => {
        const definition = node.definition;
        const distributed = scene.bindings.find((entry) => entry.instanceId === node.instanceId);

        return {
            id: node.instanceId,
            pluginId: definition.id,
            position: positions[node.instanceId] ?? { x: 0, y: 0 },
            parameters: {
                ...(definition.parameters ?? {}),
                ...(scene.parameterOverrides[node.instanceId] ?? {}),
            },
            bindings: [...(distributed?.bindings ?? definition.defaultBindings ?? [])],
        };
    });

    const edges: AuthoredEdge[] = scene.wired.edges.map((edge) => {
        const from = { node: edge.from.instanceId, port: edge.from.port };
        const to = { node: edge.to.instanceId, port: edge.to.port };

        return {
            id: edgeIdFor(from, to, edge.feedback),
            from,
            to,
            ...(edge.feedback ? { feedback: true } : {}),
        };
    });

    return {
        version: AUTHORED_SCENE_VERSION,
        entropy: scene.entropy,
        themeId: scene.theme.id,
        nodes,
        edges,
        assetBindings: scene.wired.assetBindings.map((binding) => ({
            node: binding.instanceId,
            port: binding.port,
            resource: binding.resource,
        })),
        ...(scene.wired.present
            ? { present: { node: scene.wired.present.instanceId, port: scene.wired.present.port } }
            : {}),
    };
}
