/**
 * Where a captured scene's nodes go.
 *
 * A scene the scheduler built carries no positions, so opening one has to arrange it. Depth over the
 * forward edges is the arrangement that matches how the graph is read: sources at the left, each
 * consumer to the right of everything feeding it, and the stages that reach the screen at the right
 * edge. Feedback edges take no part, or the loop they close would push a node past its own consumer.
 *
 * Deterministic, so reopening a document does not rearrange it and two people looking at the same
 * capture are looking at the same picture.
 */

export interface LayoutNode {
    id: string;
    /** Ordering within a column falls back to this when depth alone does not separate two nodes. */
    weight?: number;
}

export interface LayoutEdge {
    from: string;
    to: string;
    feedback?: boolean;
}

export interface LayoutPosition {
    x: number;
    y: number;
}

export interface LayoutOptions {
    columnWidth?: number;
    rowHeight?: number;
    originX?: number;
    originY?: number;
}

const COLUMN_WIDTH = 320;
const ROW_HEIGHT = 190;

/**
 * Longest-path depth per node, over forward edges only.
 *
 * Longest rather than shortest: a node has to sit right of *everything* that feeds it, and the
 * shortest path puts it right of only the nearest one, which draws edges running backwards.
 */
export function nodeDepths(
    nodes: readonly LayoutNode[],
    edges: readonly LayoutEdge[],
): Record<string, number> {
    const present = new Set(nodes.map((node) => node.id));
    const forward = edges.filter((edge) =>
        !edge.feedback && present.has(edge.from) && present.has(edge.to));

    const depths: Record<string, number> = {};
    for (const node of nodes) {
        depths[node.id] = 0;
    }

    // Relax until nothing moves. Bounded by the node count, which is also the longest possible path,
    // so a cycle among forward edges settles rather than spinning — an authored graph may hold one
    // while it is being drawn, and layout runs before the compiler has had its say.
    for (let pass = 0; pass < nodes.length; pass += 1) {
        let changed = false;

        for (const edge of forward) {
            const candidate = depths[edge.from] + 1;
            if (candidate > depths[edge.to]) {
                depths[edge.to] = candidate;
                changed = true;
            }
        }

        if (!changed) {
            break;
        }
    }

    return depths;
}

/** A position per node: column from depth, row from order within the column. */
export function layoutNodes(
    nodes: readonly LayoutNode[],
    edges: readonly LayoutEdge[],
    options: LayoutOptions = {},
): Record<string, LayoutPosition> {
    const columnWidth = options.columnWidth ?? COLUMN_WIDTH;
    const rowHeight = options.rowHeight ?? ROW_HEIGHT;
    const originX = options.originX ?? 0;
    const originY = options.originY ?? 0;

    const depths = nodeDepths(nodes, edges);
    const rows = new Map<number, number>();
    const positions: Record<string, LayoutPosition> = {};

    // Declaration order within a column, which for a captured scene is graph order — so a column
    // reads top to bottom in the order the nodes execute.
    const ordered = [...nodes].sort((left, right) => (left.weight ?? 0) - (right.weight ?? 0));

    for (const node of ordered) {
        const depth = depths[node.id] ?? 0;
        const row = rows.get(depth) ?? 0;
        rows.set(depth, row + 1);

        positions[node.id] = {
            x: originX + depth * columnWidth,
            y: originY + row * rowHeight,
        };
    }

    return positions;
}
