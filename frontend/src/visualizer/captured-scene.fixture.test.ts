/** A checked-in capture of the complete graph-owned scene-state contract. */

import { describe, expect, test } from 'vitest';
import { edgeIdFor, resolveAuthoredScene, type AuthoredScene } from './core/authored-scene';
import { createM1Registry } from './plugins/registry';

const edge = (
    from: { node: string; port: string },
    to: { node: string; port: string },
    feedback = false,
) => ({
    id: edgeIdFor(from, to, feedback),
    from,
    to,
    ...(feedback ? { feedback: true } : {}),
});

const CAPTURED_SCENE: AuthoredScene = {
    version: 1,
    entropy: 'fixture-scene-state',
    themeId: 'geometric-signal',
    nodes: [
        {
            id: 'trace',
            pluginId: 'SignalTraceSource:filament',
            position: { x: 0, y: 0 },
        },
        {
            id: 'tone',
            pluginId: 'ToneMapper',
            position: { x: 320, y: 0 },
        },
        {
            id: 'history',
            pluginId: 'SceneHistoryWarp:spiral',
            position: { x: 320, y: 220 },
        },
        {
            id: 'state',
            pluginId: 'SceneStateCombine',
            position: { x: 640, y: 100 },
        },
    ],
    edges: [
        edge({ node: 'trace', port: 'color' }, { node: 'tone', port: 'source' }),
        edge({ node: 'tone', port: 'color' }, { node: 'state', port: 'source' }),
        edge({ node: 'state', port: 'color' }, { node: 'history', port: 'source' }, true),
        edge({ node: 'history', port: 'color' }, { node: 'state', port: 'history' }),
    ],
    assetBindings: [],
    present: { node: 'state', port: 'color' },
};

describe('CAPTURED_SCENE', () => {
    test('the captured scene resolves as a complete playable scene', () => {
        const resolved = resolveAuthoredScene(
            CAPTURED_SCENE,
            createM1Registry(),
            { requireSceneState: true },
        );

        expect(
            resolved.ok,
            resolved.ok ? '' : resolved.problems.map((problem) => problem.detail).join('; '),
        ).toBe(true);
    });
});
