/**
 * Which port types carry a spatial field.
 *
 * This was the top of `core/persistence.ts`, where it described what the kernel dragged its
 * accumulation through. There is no kernel accumulation any more (ADR-0013) and there is no drag to
 * be the subject of the definition, so the question it answers is the plain one: does this port carry
 * a displacement per texel, or a picture?
 *
 * Grammar asks it to require that a scene's fields reach a consumer, wiring asks it to find the
 * producer for a warp's driver, and selection asks it to tell a field apart from the material it
 * moves. None of those needs the field to be going anywhere in particular.
 */

import type { PortType } from './plugin';

export const MOTION_SOURCE_TYPES: readonly PortType[] = [
    'motion-field',
    'vector-field',
    'collision-field',
];

export function isMotionSource(type: PortType): boolean {
    return MOTION_SOURCE_TYPES.includes(type);
}
