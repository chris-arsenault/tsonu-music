/**
 * Target allocation planning.
 *
 * Turns a compiled graph plus a render size into the set of framebuffers to allocate and which slot a
 * ping-pong resource reads from and writes to this frame. Pure, so the ping-pong alternation and the
 * quality scaling are testable without a GL context.
 */

import type { CompiledGraph } from './graph';
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
    presentKey: string | undefined;
}

/** Smallest useful render dimension. Below this, feedback and blur read as mush. */
const MINIMUM_DIMENSION = 16;

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
export function planTargets(
    graph: CompiledGraph,
    renderWidth: number,
    renderHeight: number,
    qualityScale: number,
    frameParity: number,
): RenderPlan {
    const scale = qualityScale <= 0 ? 0 : qualityScale > 1 ? 1 : qualityScale;
    const width = Math.max(MINIMUM_DIMENSION, Math.round(renderWidth * scale));
    const height = Math.max(MINIMUM_DIMENSION, Math.round(renderHeight * scale));

    const pingPong = new Set(graph.pingPong);
    const targets: TargetPlanEntry[] = [];
    const writeKeys: Record<ResourceId, string> = {};
    const readKeys: Record<ResourceId, string> = {};

    const writeSlot: 0 | 1 = frameParity % 2 === 0 ? 0 : 1;
    const readSlot: 0 | 1 = writeSlot === 0 ? 1 : 0;

    for (const resource of graph.resources) {
        if (pingPong.has(resource.id)) {
            targets.push({ key: targetKey(resource.id, 0), resource: resource.id, width, height, slot: 0 });
            targets.push({ key: targetKey(resource.id, 1), resource: resource.id, width, height, slot: 1 });
            writeKeys[resource.id] = targetKey(resource.id, writeSlot);
            readKeys[resource.id] = targetKey(resource.id, readSlot);
        } else {
            targets.push({ key: targetKey(resource.id), resource: resource.id, width, height });
            writeKeys[resource.id] = targetKey(resource.id);
            readKeys[resource.id] = targetKey(resource.id);
        }
    }

    return {
        width,
        height,
        targets,
        writeKeys,
        readKeys,
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
