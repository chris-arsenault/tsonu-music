/**
 * Target allocation planning.
 *
 * Turns a compiled graph plus a render size into the set of framebuffers to allocate and which slot a
 * ping-pong resource reads from and writes to this frame. Pure, so the ping-pong alternation and the
 * quality scaling are testable without a GL context.
 */

import type { CompiledGraph } from './graph';
import type { PortType } from './plugin';
import type { ResourceId } from './passes';

export interface TargetPlanEntry {
    /** Device pool key. A ping-pong resource contributes two. */
    key: string;
    resource: ResourceId;
    width: number;
    height: number;
    /** Slot 0 or 1 for a ping-pong resource; undefined for a single-buffered one. */
    slot?: 0 | 1;
}

export interface RenderPlan {
    width: number;
    height: number;
    targets: TargetPlanEntry[];
    /** Resource to the key it is written to this frame. */
    writeKeys: Record<ResourceId, string>;
    /** Resource to the key holding the previous frame, for declared feedback reads. */
    readKeys: Record<ResourceId, string>;
    /** Allocated size per resource, since not every resource is the render size. */
    sizes: Record<ResourceId, { width: number; height: number }>;
    presentKey: string | undefined;
}

/** Smallest useful render dimension. Below this, feedback and blur read as mush. */
const MINIMUM_DIMENSION = 16;

function clampScale(value: number): number {
    return value <= 0 ? 0 : value > 1 ? 1 : value;
}

export function targetKey(resource: ResourceId, slot?: 0 | 1): string {
    return slot === undefined ? resource : `${resource}#${slot}`;
}

/**
 * Plans this frame's targets.
 *
 * `frameParity` alternates which slot a ping-pong resource writes. A feedback consumer reads the other
 * slot, so it sees the previous frame rather than the one being written — which is what stops a
 * feedback loop from sampling its own partial output.
 */
/**
 * Per-port-type size multipliers and pixel budgets.
 *
 * A resource is not always the render size. A vector field consumed by advection needs no pixel detail,
 * and a particle buffer is one texel per particle rather than one per screen pixel — sizing it to the
 * viewport would silently change the particle count with the window.
 */
export const RESOURCE_SIZING: Partial<Record<PortType, { scale?: number; fixed?: number }>> = {
    'vector-field': { scale: 0.5 },
    'motion-field': { scale: 0.5 },
    'distance-field': { scale: 0.5 },
    'particle-buffer': { fixed: 128 },
    // A palette is a strip of swatches, not an image.
    palette: { fixed: 64 },
};

export function planTargets(
    graph: CompiledGraph,
    renderWidth: number,
    renderHeight: number,
    qualityScale: number,
    frameParity: number,
    /** Simulation-resolution multiplier from the quality ladder, applied to field and buffer resources. */
    simulationScale = 1,
): RenderPlan {
    const scale = clampScale(qualityScale);
    const width = Math.max(MINIMUM_DIMENSION, Math.round(renderWidth * scale));
    const height = Math.max(MINIMUM_DIMENSION, Math.round(renderHeight * scale));

    const pingPong = new Set(graph.pingPong);
    const targets: TargetPlanEntry[] = [];
    const writeKeys: Record<ResourceId, string> = {};
    const readKeys: Record<ResourceId, string> = {};
    const sizes: Record<ResourceId, { width: number; height: number }> = {};

    const writeSlot: 0 | 1 = frameParity % 2 === 0 ? 0 : 1;
    const readSlot: 0 | 1 = writeSlot === 0 ? 1 : 0;

    for (const resource of graph.resources) {
        // Sized by what the resource is for, so a field or particle buffer is not needlessly allocated at
        // full viewport resolution — and so the size is stable across frames rather than recomputed per
        // pass, which is what previously caused a delete-and-recreate every frame.
        const sizing = RESOURCE_SIZING[resource.type];
        let resourceWidth = width;
        let resourceHeight = height;

        if (sizing?.fixed !== undefined) {
            resourceWidth = sizing.fixed;
            resourceHeight = sizing.fixed;
        } else if (sizing?.scale !== undefined) {
            const combined = sizing.scale * clampScale(simulationScale);
            resourceWidth = Math.max(MINIMUM_DIMENSION, Math.round(width * combined));
            resourceHeight = Math.max(MINIMUM_DIMENSION, Math.round(height * combined));
        }

        if (pingPong.has(resource.id)) {
            targets.push({ key: targetKey(resource.id, 0), resource: resource.id, width: resourceWidth, height: resourceHeight, slot: 0 });
            targets.push({ key: targetKey(resource.id, 1), resource: resource.id, width: resourceWidth, height: resourceHeight, slot: 1 });
            writeKeys[resource.id] = targetKey(resource.id, writeSlot);
            readKeys[resource.id] = targetKey(resource.id, readSlot);
        } else {
            targets.push({ key: targetKey(resource.id), resource: resource.id, width: resourceWidth, height: resourceHeight });
            writeKeys[resource.id] = targetKey(resource.id);
            readKeys[resource.id] = targetKey(resource.id);
        }

        sizes[resource.id] = { width: resourceWidth, height: resourceHeight };
    }

    return {
        width,
        height,
        targets,
        writeKeys,
        readKeys,
        sizes,
        presentKey: graph.present ? writeKeys[graph.present] : undefined,
    };
}

/** Every pool key the plan uses, for releasing what a scene change left behind. */
export function liveKeys(plan: RenderPlan): Set<string> {
    return new Set(plan.targets.map((target) => target.key));
}

/** Approximate bytes the plan's targets occupy, at 8 bytes per RGBA16F pixel. */
export function estimateTargetMemory(plan: RenderPlan, bytesPerPixel = 8): number {
    return plan.targets.reduce((total, target) => total + target.width * target.height * bytesPerPixel, 0);
}
