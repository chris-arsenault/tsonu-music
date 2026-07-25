/**
 * Layer model and composition order (spec section 11).
 *
 * The compositor owns order, blend modes, masking, feedback injection, and crossfades. Plugins
 * declare what they contribute; they never decide where in the stack it lands.
 */

import { clamp01 } from './bindings';
import type { BlendMode, ResourceId } from './passes';
import type { SelectionCharacter } from './plugin';

export interface VisualLayer {
    id: string;
    color?: ResourceId;
    alpha?: ResourceId;
    depth?: ResourceId;
    motion?: ResourceId;

    blendMode: BlendMode;
    opacity: number;
    order: number;

    /** How much this layer contributes to the feedback buffer, 0 to 1. */
    feedbackParticipation: number;
}

/** A layer mid-crossfade between an outgoing and incoming branch (spec section 10). */
export interface Crossfade {
    fromLayerId: string;
    toLayerId: string;
    /** 0 is fully the outgoing layer, 1 fully the incoming one. */
    progress: number;
    durationSeconds: number;
}

export interface CompositionStep {
    layer: VisualLayer;
    /** Effective opacity after crossfade weighting. */
    opacity: number;
    blendMode: BlendMode;
}

export interface Composition {
    steps: CompositionStep[];
    /** Layers contributing to feedback, with their weights. */
    feedbackContributors: { id: string; color: ResourceId; weight: number }[];
}

/**
 * How a branch meets the ones beneath it, from what the plugin says it produces.
 *
 * Every layer above the base blended with `screen`, which is a lighten operator: parallel branches
 * accumulated toward white and read as flat superposition rather than as interaction. Section 11
 * defines seven modes and the choice belongs to the compositor, so it is made here from the
 * character the plugin already declares.
 *
 * `multiply` is deliberately absent. Against a dark base it collapses the frame to black, and the
 * safe place for it is `LayerMixer`, where section 19.9 already offers it behind a mix factor.
 */
export function blendForCharacter(character: SelectionCharacter): BlendMode {
    // Bright, sparse material is light being emitted: sparks, glints, glow. It should add.
    if (character.brightness >= 0.7 && character.visualDensity <= 0.4) {
        return 'add';
    }

    if (character.brightness >= 0.6) {
        return 'screen';
    }

    // Dense material is a surface, not a light. Compositing it over what is beneath lets it occlude,
    // which is the interaction screen blending could never produce.
    if (character.visualDensity >= 0.55) {
        return 'normal';
    }

    return 'screen';
}

export function createLayer(id: string, color: ResourceId, overrides: Partial<VisualLayer> = {}): VisualLayer {
    return {
        id,
        color,
        blendMode: 'normal',
        opacity: 1,
        order: 0,
        feedbackParticipation: 0,
        ...overrides,
    };
}

/**
 * Resolves the draw order and effective opacities.
 *
 * Layers sort by `order`, ties broken by id so the active composition is stable rather than dependent
 * on activation sequence. The lowest layer is forced to `normal` blending: blending a
 * bottom layer against an uninitialized target produces whatever the pool last left there.
 */
export function composeLayers(
    layers: readonly VisualLayer[],
    crossfades: readonly Crossfade[] = [],
): Composition {
    const sorted = [...layers].sort((left, right) =>
        left.order === right.order ? left.id.localeCompare(right.id) : left.order - right.order);

    const steps = sorted
        .map((layer, index): CompositionStep => ({
            layer,
            opacity: clamp01(layer.opacity) * crossfadeWeight(layer.id, crossfades),
            blendMode: index === 0 ? 'normal' : layer.blendMode,
        }))
        .filter((step) => step.opacity > 0 && step.layer.color !== undefined);

    const feedbackContributors = sorted
        .filter((layer): layer is VisualLayer & { color: ResourceId } =>
            layer.color !== undefined && layer.feedbackParticipation > 0)
        .map((layer) => ({
            id: layer.id,
            color: layer.color,
            weight: clamp01(layer.feedbackParticipation) * clamp01(layer.opacity),
        }))
        .filter((contributor) => contributor.weight > 0);

    return { steps, feedbackContributors };
}

/**
 * Weight a layer carries while crossfading. A layer not involved in any crossfade carries full
 * weight; one involved in several takes the lowest, so it cannot exceed full opacity by being
 * mentioned twice.
 */
export function crossfadeWeight(layerId: string, crossfades: readonly Crossfade[]): number {
    let weight = 1;

    for (const crossfade of crossfades) {
        const progress = clamp01(crossfade.progress);

        if (crossfade.fromLayerId === layerId) {
            weight = Math.min(weight, 1 - progress);
        }
        if (crossfade.toLayerId === layerId) {
            weight = Math.min(weight, progress);
        }
    }

    return weight;
}

/** Advances a crossfade. A frozen clock passes zero delta, holding it in place. */
export function advanceCrossfade(crossfade: Crossfade, deltaSeconds: number): Crossfade {
    if (deltaSeconds <= 0 || crossfade.durationSeconds <= 0) {
        return crossfade.durationSeconds <= 0 ? { ...crossfade, progress: 1 } : crossfade;
    }

    return {
        ...crossfade,
        progress: clamp01(crossfade.progress + deltaSeconds / crossfade.durationSeconds),
    };
}

export function isCrossfadeComplete(crossfade: Crossfade): boolean {
    return clamp01(crossfade.progress) >= 1;
}

/**
 * GL blend factors for a mode. `none` replaces the target; `normal` is source-over.
 * Returned as plain data so the mapping is testable without a context.
 */
export interface BlendFactors {
    enabled: boolean;
    sourceFactor: 'one' | 'src-alpha' | 'one-minus-dst-color' | 'dst-color' | 'zero';
    destinationFactor: 'zero' | 'one' | 'one-minus-src-alpha' | 'one-minus-src-color' | 'src-color';
    equation: 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';
}

export function blendFactors(mode: BlendMode): BlendFactors {
    switch (mode) {
        case 'none':
            return { enabled: false, sourceFactor: 'one', destinationFactor: 'zero', equation: 'add' };

        case 'normal':
            return { enabled: true, sourceFactor: 'src-alpha', destinationFactor: 'one-minus-src-alpha', equation: 'add' };

        case 'add':
            return { enabled: true, sourceFactor: 'src-alpha', destinationFactor: 'one', equation: 'add' };

        case 'screen':
            return { enabled: true, sourceFactor: 'one', destinationFactor: 'one-minus-src-color', equation: 'add' };

        case 'multiply':
            return { enabled: true, sourceFactor: 'dst-color', destinationFactor: 'zero', equation: 'add' };

        case 'difference':
            return { enabled: true, sourceFactor: 'one', destinationFactor: 'one', equation: 'subtract' };

        case 'lighten':
            return { enabled: true, sourceFactor: 'one', destinationFactor: 'one', equation: 'max' };

        case 'darken':
            return { enabled: true, sourceFactor: 'one', destinationFactor: 'one', equation: 'min' };
    }
}
