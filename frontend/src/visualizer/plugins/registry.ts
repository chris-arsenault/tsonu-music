/**
 * Plugin registration and the hand-wired first scene.
 *
 * Registration is a plain function call against the registry — no kernel file changes as the catalog
 * grows. The scene here is fixed; the scheduler that assembles scenes from grammar arrives in M2.
 */

import { createPluginRegistry, type PluginRegistry, type VisualPluginDefinition } from '../core/plugin';
import type { GraphNode, RenderGraphEdge } from '../core/graph';
import { createSignalTraceSource, SIGNAL_TRACE_MODES } from './sources/signal-trace';
import { createFeedbackFlowTransform, FEEDBACK_FLOW_MODES } from './transformers/feedback-flow';
import { createToneMapper } from './postprocess/tone-mapper';

/** Every plugin available in M1: each mode of each transformer plus the tone mapper. */
export function m1Definitions(): VisualPluginDefinition[] {
    return [
        ...SIGNAL_TRACE_MODES.map(createSignalTraceSource),
        ...FEEDBACK_FLOW_MODES.map(createFeedbackFlowTransform),
        createToneMapper(),
    ];
}

export function createM1Registry(): PluginRegistry {
    return createPluginRegistry(m1Definitions());
}

export interface SceneDefinition {
    nodes: GraphNode[];
    edges: RenderGraphEdge[];
    present: { instanceId: string; port: string };
}

/**
 * Trace into feedback into tone mapping — the smallest scene that exercises geometry passes, a
 * declared feedback loop, and the output stage together.
 *
 * The renderer assembles scenes through the scheduler rather than using this. It is kept as a fixed
 * reference scene: a hand-checked graph that must keep compiling, so a change to the plugin contract or
 * the graph rules fails a test rather than silently producing an unrenderable scene.
 */
export function firstLightScene(registry: PluginRegistry): SceneDefinition {
    const trace = required(registry, 'SignalTraceSource:circular');
    const feedback = required(registry, 'FeedbackFlowTransform:vortex');
    const toneMapper = required(registry, 'ToneMapper');

    return {
        nodes: [
            { instanceId: 'trace', definition: trace },
            { instanceId: 'feedback', definition: feedback },
            { instanceId: 'tone', definition: toneMapper },
        ],
        edges: [
            { from: { instanceId: 'trace', port: 'color' }, to: { instanceId: 'feedback', port: 'source' } },
            {
                // Declared feedback: the transform reads its own previous frame.
                from: { instanceId: 'feedback', port: 'color' },
                to: { instanceId: 'feedback', port: 'history' },
                feedback: true,
            },
            { from: { instanceId: 'feedback', port: 'color' }, to: { instanceId: 'tone', port: 'source' } },
        ],
        present: { instanceId: 'tone', port: 'color' },
    };
}

function required(registry: PluginRegistry, id: string): VisualPluginDefinition {
    const definition = registry.get(id);
    if (!definition) {
        throw new Error(`plugin ${id} is not registered`);
    }

    return definition;
}
