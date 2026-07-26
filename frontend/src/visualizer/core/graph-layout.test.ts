import { describe, expect, test } from 'vitest';
import { layoutNodes, nodeDepths } from './graph-layout';

const nodes = (...ids: string[]) => ids.map((id, index) => ({ id, weight: index }));

describe('graph layout', () => {
    test('a chain advances one column per link', () => {
        const depths = nodeDepths(nodes('a', 'b', 'c'), [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
        ]);

        expect(depths).toEqual({ a: 0, b: 1, c: 2 });
    });

    test('a node sits right of everything feeding it, not just the nearest', () => {
        // Shortest path would put `d` at depth 1 through the direct edge and draw the long branch
        // backwards into it.
        const depths = nodeDepths(nodes('a', 'b', 'c', 'd'), [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
            { from: 'c', to: 'd' },
            { from: 'a', to: 'd' },
        ]);

        expect(depths.d).toBe(3);
    });

    test('a feedback edge does not push its target past its own consumer', () => {
        const depths = nodeDepths(nodes('a', 'b'), [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a', feedback: true },
        ]);

        expect(depths).toEqual({ a: 0, b: 1 });
    });

    test('an edge naming a node that is not there is ignored', () => {
        expect(nodeDepths(nodes('a'), [{ from: 'ghost', to: 'a' }])).toEqual({ a: 0 });
    });

    test('a cycle among forward edges settles rather than spinning', () => {
        // Layout runs while a graph is being drawn, which is before the compiler has had its say.
        const depths = nodeDepths(nodes('a', 'b'), [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
        ]);

        expect(Number.isFinite(depths.a)).toBe(true);
        expect(Number.isFinite(depths.b)).toBe(true);
    });

    test('parallel branches stack into rows within their column', () => {
        const positions = layoutNodes(nodes('a', 'b', 'c'), [
            { from: 'a', to: 'c' },
            { from: 'b', to: 'c' },
        ], { columnWidth: 100, rowHeight: 50 });

        expect(positions.a).toEqual({ x: 0, y: 0 });
        expect(positions.b).toEqual({ x: 0, y: 50 });
        expect(positions.c).toEqual({ x: 100, y: 0 });
    });

    test('rows follow the given order, so a column reads in execution order', () => {
        const positions = layoutNodes(
            [{ id: 'late', weight: 5 }, { id: 'early', weight: 1 }],
            [],
            { rowHeight: 10 },
        );

        expect(positions.early.y).toBeLessThan(positions.late.y);
    });

    test('an empty graph lays out to nothing', () => {
        expect(layoutNodes([], [])).toEqual({});
    });

    test('the origin shifts every node', () => {
        const positions = layoutNodes(nodes('a'), [], { originX: 7, originY: 9 });

        expect(positions.a).toEqual({ x: 7, y: 9 });
    });
});
