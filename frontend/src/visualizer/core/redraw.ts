/**
 * Whether a pass redraws the frame or transforms it (ADR-0014).
 *
 * A source plugin computes an image from the current time and the current feature bus and writes it
 * over its target. Its output at frame N is a function of the features at frame N and nothing else,
 * so the moment a feature returns to a value it held before, the image returns with it. That is why
 * a scene bumps to the beat and goes nowhere: no accumulator downstream can recover a history the
 * producer never had.
 *
 * The invariant is that a colour pass's output must be a function of at least one colour texture —
 * its own previous contents, an upstream one, or both. Two rules carry it, and both are decidable
 * from a pass descriptor without a GL context:
 *
 * - **clears** — a colour pass that clears destroys whatever its target was holding. This only
 *   bites on a geometry pass: a fullscreen quad with `blend: 'none'` replaces the target completely,
 *   so the flag changes no pixel there. A sparse line strip drawn after a clear is the whole of what
 *   the target holds, which is how a spectrum ends up reading as a thin spectrogram behind the
 *   image, unwarped and interacting with nothing.
 * - **generates** — a colour pass that replaces its target while reading no colour is producing a
 *   frame out of time and audio. Compositing instead of replacing is enough to satisfy this; the
 *   pass does not have to sample anything.
 *
 * A transformer is not the problem and is not caught: `warp(uSource)` is already a transform of an
 * existing image, and the history in it is whatever upstream carried.
 */

import type { PortType } from './plugin';
import type { RenderPass, ResourceId } from './passes';

export type RedrawViolation = 'clears' | 'generates';

export interface PassRedrawFinding {
    /** Index into the pass list the finding came from. */
    pass: number;
    violation: RedrawViolation;
    /** The resource the offending pass writes, for a message that names something real. */
    output: ResourceId | undefined;
}

/**
 * Presentation stages are exempt.
 *
 * `postprocess` is what `core/wiring.ts` treats as presentation when it refuses to close a loop
 * through one: grading, tone mapping and bloom happen on the composed image's way to the screen and
 * are not part of what the scene remembers. A stage with no state to preserve cannot destroy any.
 */
export function isPresentationCategory(category: string): boolean {
    return category === 'postprocess';
}

/** Whether a pass writes a colour texture, which is the only kind this rule governs. */
function writesColour(pass: RenderPass, typeOf: Readonly<Record<ResourceId, PortType>>): boolean {
    return pass.output !== undefined && typeOf[pass.output] === 'color-texture';
}

/** Whether a pass reads a colour texture, by its own previous slot or from upstream. */
function readsColour(pass: RenderPass, typeOf: Readonly<Record<ResourceId, PortType>>): boolean {
    return Object.values(pass.inputs ?? {}).some((resource) => typeOf[resource] === 'color-texture');
}

/**
 * Every way a pass list destroys or bypasses the state in its colour targets.
 *
 * `typeOf` maps a resource id to the port type it carries. The caller has this from the compiled
 * graph, or — in a contract check over a single definition — from the definition's own ports.
 */
export function redrawViolations(
    passes: readonly RenderPass[],
    typeOf: Readonly<Record<ResourceId, PortType>>,
): PassRedrawFinding[] {
    const findings: PassRedrawFinding[] = [];

    passes.forEach((pass, index) => {
        if (!writesColour(pass, typeOf)) {
            return;
        }

        if (pass.clear === true) {
            findings.push({ pass: index, violation: 'clears', output: pass.output });
        }

        if ((pass.blend ?? 'none') === 'none' && !readsColour(pass, typeOf)) {
            findings.push({ pass: index, violation: 'generates', output: pass.output });
        }
    });

    return findings;
}

/** A resource-to-type map for one plugin's ports, keyed the way a render context binds them. */
export function portTypes(
    ports: readonly { name: string; type: PortType }[],
    resources: Readonly<Record<string, ResourceId>>,
): Record<ResourceId, PortType> {
    const types: Record<ResourceId, PortType> = {};

    for (const port of ports) {
        const resource = resources[port.name];
        if (resource !== undefined) {
            types[resource] = port.type;
        }
    }

    return types;
}
