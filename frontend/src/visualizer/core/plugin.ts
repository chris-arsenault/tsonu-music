/**
 * The plugin contract (spec section 9).
 *
 * A definition is plain data: ports, costs, character, activation rules. The kernel understands only
 * those, never what a plugin looks like, which is what allows a plugin to be registered without any
 * kernel change.
 */

import type { AudioFeatureBus } from './features';
import type { ParameterBinding } from './bindings';
import type { PlaybackClock } from './clock';
import type { ImpactBus, ImpactEvent } from './impact';
import type { GeometryUpload, RenderPass, ResourceId, ShaderSource } from './passes';

export type PluginCategory =
    | 'source'
    | 'field'
    | 'simulator'
    | 'transformer'
    | 'compositor'
    | 'postprocess';

export type PortType =
    | 'color-texture'
    | 'mask-texture'
    | 'distance-field'
    | 'vector-field'
    | 'collision-field'
    | 'reaction-diffusion-state'
    | 'wave-field-state'
    | 'depth-texture'
    | 'motion-field'
    | 'particle-buffer'
    | 'particle-emitter'
    | 'particle-force'
    | 'particle-collider'
    | 'particle-state'
    | 'geometry'
    | 'palette'
    | 'scalar-feature'
    | 'event-feature'
    | 'event-stream';

/** CPU values passed synchronously through the graph instead of allocated as render targets. */
export function isValuePortType(type: PortType): boolean {
    return type === 'particle-emitter'
        || type === 'particle-force'
        || type === 'particle-collider'
        || type === 'particle-state';
}

/**
 * A port carrying a picture, which is the kind of loop that can run away visually.
 *
 * The distinction the loop-gain check turns on, and it is already in the port types. A simulator
 * closing a loop on `reaction-diffusion-state` or `wave-field-state` is advancing its own state,
 * bounded by its own dynamics — Gray-Scott stays inside nought to one because the reaction does, not
 * because anything decays it — and no other plugin produces those types, so such a loop cannot be
 * cross-wired anywhere else. A loop carrying a colour or mask texture is a picture fed back into a
 * picture, and that is what diverges.
 */
export function isImagePortType(type: PortType): boolean {
    return type === 'color-texture' || type === 'mask-texture';
}

export interface PluginPort {
    name: string;
    type: PortType;
    required: boolean;
    multiple?: boolean;
    /**
     * This input exists to consume a host asset, so an asset satisfies it before any producer does.
     *
     * Wiring otherwise takes the first compatible plugin output and only falls back to an asset,
     * which is the right order for an ordinary image input and exactly wrong for this one: album art
     * is a `color-texture`, so every colour producer in the scene matches the port and the artwork
     * loses to whichever happened to sort first. Measured over 200 scenes before this existed, 111 of
     * 180 album-art consumers were handed another plugin's picture — including every instance of
     * `AlbumArtDisplacement` and `ImageLuminanceField`, which sort late enough that a producer is
     * always available. Those plugins ran, drew, and derived from the wrong image, which is
     * indistinguishable from artwork never appearing.
     */
    fromAsset?: boolean;
    /**
     * Output of this same plugin whose previous frame this input reads.
     *
     * Feedback was recognised by input name alone — `history`, `feedback`, `previous` — and paired
     * with whichever output happened to match by type. That works while a plugin has one feedback
     * loop and one output of that type, and stops working the moment it has two: the particle
     * simulator writes both its state and its spatial bins as particle buffers, and the bins input has
     * to close onto the bins output specifically, not onto whichever came first.
     */
    feedbackFrom?: string;
    /**
     * Output that exists only to close a loop inside this plugin, and is not offered to others.
     *
     * The particle simulator writes both its state and a spatial bin grid, and both are particle
     * buffers. Registered as an ordinary producer, the bin grid was picked up by the particle
     * renderers instead of the state — so they drew the occupancy grid rather than the particles, and
     * a scene that looked like it had a working simulation was showing a picture of its index.
     */
    internal?: boolean;
    /**
     * On an output: data, never presentable material. Wiring may feed it to a structural input, the
     * join machinery must not absorb it as a branch, and it is not a terminal. The spectrum's band
     * strip is the archetype — one bar per bin, meaningful as another generator's edge or profile
     * argument, meaningless composited over the picture.
     *
     * On an input: an argument to what this plugin makes, rather than material it processes. Where
     * an ordinary image input is a picture the plugin transforms, a structural input is read as
     * geometry — a boundary displacement, a stroke weight, a domain bend — so a data strip is
     * exactly what belongs there and a picture is welcome too.
     *
     * The pairing is one-directional and both halves matter. Without the input flag, wiring offered
     * the band strip to any colour input that happened to be next, and a mixer composited 64 bars
     * over the picture; without the output flag, a join absorbed the strip as though it were a
     * branch.
     */
    structural?: boolean;
    /**
     * Parameter scaling how much of this input reaches the output (ADR-0013).
     *
     * The quantity that decides whether a cycle through this port converges. `attenuatesHistory` asked
     * whether a plugin carried the `feedback` capability, which is a string and not a bound; the
     * condition that actually governs divergence is that the product of these around a cycle stays
     * below one.
     *
     * Absent means one: the input passes through undiminished, which is correct for a warp resampling
     * its source and is exactly why a warp alone cannot be the lossy element in a loop.
    */
    gainParameter?: string;
}

export interface PluginCost {
    gpu: number;
    cpu: number;
    memory: number;
    renderPasses: number;

    qualityScalable: boolean;
    /** A dominant plugin defines a scene's character; the grammar limits how many may coexist. */
    dominant: boolean;
}

export interface SelectionCharacter {
    visualDensity: number;
    motionEnergy: number;
    geometricOrder: number;
    recognizability: number;
    persistence: number;
    brightness: number;
    dominance: 'supporting' | 'primary' | 'either';
}

/**
 * Arithmetic used by the graph-owned scene-state transition (ADR-0017).
 *
 * `max` keeps the brighter of history and fresh — a flash afterimage whose failure signature is
 * static bright regions. `flow` closes the gap to that envelope at an audio-driven rate, so fresh
 * takes over lit regions gradually while dark regions decay on survival alone. `deposit`
 * accumulates a bounded number of copies with a hue-preserving knee and a fresh-visibility floor.
 */
export type TemporalCombineOperator = 'max' | 'flow' | 'deposit';

/**
 * Identifies the one node that combines warped history with fresh scene material.
 *
 * This is definition metadata rather than a capability string because the compiler needs the
 * participating ports and the operator's actual arithmetic to validate the recursive path.
 */
export interface TemporalCombineContract {
    operator: TemporalCombineOperator;
    historyInput: string;
    sourceInput: string;
    output: string;
    /**
     * Presented instead of `output` when declared (ADR-0017 amendment). Memory and presentation
     * are different jobs with opposite needs: the recurrence wants smoothing or trails die, the
     * screen wants crisp audio-rate material or the picture goes numb. `output` remains the
     * previous-frame read; `displayOutput` is the state with fresh material riding on top, and it
     * feeds back into nothing.
     */
    displayOutput?: string;
    historyWeightParameter: string;
    sourceWeightParameter: string;
}

export interface ActivationRules {
    minimumDuration?: number;
    maximumDuration?: number;

    requiredAssets?: string[];
    requiredCapabilities?: string[];

    incompatibleWith?: string[];
    prefersWith?: string[];

    activationWeight: number;
    cooldown?: number;
}

/** How a stateful plugin leaves a scene (spec section 18). */
export type DeactivationPolicy =
    | 'immediate'
    | 'fade'
    | 'drain'
    | 'freeze-and-dissolve'
    | 'handoff-feedback';

export interface FrameContext {
    clock: PlaybackClock;
    features: AudioFeatureBus;
    /** Zero while the clock is frozen, so a plugin that integrates it stops advancing. */
    deltaSeconds: number;
    /** Random per-instance value derived from the active scene's entropy. */
    seed: number;
    renderWidth: number;
    renderHeight: number;
    /**
     * Resource bound to each declared input port, as `RenderContext` also reports.
     *
     * Available during update because a plugin simulating on the CPU has to read its inputs where the
     * simulation happens, not where the draw is described.
     */
    inputs: Readonly<Record<string, ResourceId | undefined>>;
    /** Resolved parameter values after bindings have been applied. */
    parameters: Readonly<Record<string, number>>;
    /** Uploads geometry for a `GeometryPass` to draw. */
    uploadGeometry(upload: GeometryUpload): void;
    /** Publishes a synchronous CPU value for a semantic graph resource. */
    publishValue?(resource: ResourceId, value: unknown): void;
    /** Reads a CPU value published by an upstream node earlier in graph order. */
    readValue?<T>(resource: ResourceId | undefined): T | undefined;
    /** Particle and agent count multiplier from the quality ladder. */
    particleScale?: number;
    /** Frames of temporal history the quality ladder permits a plugin to retain. */
    historyDepth?: number;
    /** Live impacts any plugin may respond to (spec section 19.6). */
    impacts: ImpactBus;
    /** Publishes impacts for other plugins to consume. */
    publishImpacts(impacts: readonly ImpactEvent[]): void;
    /**
     * A field this plugin consumes, as RGBA floats the CPU can read, or undefined until one arrives.
     *
     * For simulation that runs on the CPU rather than in a shader. A force field and a mask boundary
     * are textures, and a solver answering "what is pushing this body" or "is there a surface here"
     * cannot see one — so a plugin doing real physics needs the field in memory. Delivered a frame or
     * two late, because a synchronous read would stall the pipeline; a field is smooth over the
     * distance a body travels in that time.
     *
     * Undefined on the first frames a resource exists, before any read has completed. A caller must
     * behave sensibly without it rather than waiting.
     */
    readField(resource: ResourceId | undefined): FieldSample | undefined;
}

/** A field read back from the GPU: RGBA per texel, row-major from the bottom-left. */
export interface FieldSample {
    width: number;
    height: number;
    data: Float32Array;
}

export interface RenderContext {
    /** Resource bound to each declared input port. Absent for unconnected optional ports. */
    inputs: Readonly<Record<string, ResourceId | undefined>>;
    /** Resource this plugin's declared outputs write to. */
    outputs: Readonly<Record<string, ResourceId>>;
    /** Previous frame's content of an output, for feedback reads. */
    previous: Readonly<Record<string, ResourceId | undefined>>;
    renderWidth: number;
    renderHeight: number;
}

export interface PluginCreateContext {
    instanceId: string;
    seed: number;
    /** Compiled resource ids for this instance's output ports. */
    outputs?: Readonly<Record<string, ResourceId>>;
    /** Registers a shader program. Called at initialization, never per frame. */
    registerShader(source: ShaderSource): void;
}

export interface ActivationContext {
    clock: PlaybackClock;
    parameters: Readonly<Record<string, number>>;
}

export interface DeactivationContext {
    policy: DeactivationPolicy;
    clock: PlaybackClock;
}

export interface VisualPluginInstance {
    initialize(): Promise<void> | void;

    activate(context: ActivationContext): void;
    update(context: FrameContext): void;
    /** Returns the GPU work for this frame as plain data. Must not touch a GL context. */
    render(context: RenderContext): RenderPass[];

    deactivate(context: DeactivationContext): void;
    destroy(): void;
}

export interface VisualPluginDefinition {
    id: string;
    version: number;
    category: PluginCategory;

    inputs: PluginPort[];
    outputs: PluginPort[];

    capabilities: string[];
    requiredCapabilities?: string[];

    cost: PluginCost;
    character: SelectionCharacter;
    activationRules: ActivationRules;

    /** Parameters the scheduler may set, with their defaults. */
    parameters?: Readonly<Record<string, number>>;
    /** Bindings the plugin ships with. The scheduler may replace them. */
    defaultBindings?: ParameterBinding[];
    deactivationPolicy?: DeactivationPolicy;
    /** Present only on the graph-owned scene-state combine. */
    temporalCombine?: TemporalCombineContract;

    create(context: PluginCreateContext): VisualPluginInstance;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

export interface PluginRegistry {
    register(definition: VisualPluginDefinition): void;
    get(id: string): VisualPluginDefinition | undefined;
    all(): VisualPluginDefinition[];
    byCategory(category: PluginCategory): VisualPluginDefinition[];
}

export function createPluginRegistry(
    definitions: readonly VisualPluginDefinition[] = [],
): PluginRegistry {
    const byId = new Map<string, VisualPluginDefinition>();

    const registry: PluginRegistry = {
        register(definition) {
            const invalid = validateDefinition(definition);
            if (invalid.length > 0) {
                throw new Error(`plugin ${definition.id} is invalid: ${invalid.join('; ')}`);
            }

            const existing = byId.get(definition.id);
            if (existing && existing.version >= definition.version) {
                throw new Error(
                    `plugin ${definition.id} version ${definition.version} does not supersede ${existing.version}`,
                );
            }

            byId.set(definition.id, definition);
        },

        get(id) {
            return byId.get(id);
        },

        all() {
            return [...byId.values()];
        },

        byCategory(category) {
            return [...byId.values()].filter((definition) => definition.category === category);
        },
    };

    for (const definition of definitions) {
        registry.register(definition);
    }

    return registry;
}

/** Structural problems that make a definition unusable. Returns an empty array when valid. */
export function validateDefinition(definition: VisualPluginDefinition): string[] {
    const problems: string[] = [];

    if (definition.id.trim() === '') {
        problems.push('id is empty');
    }

    if (!Number.isInteger(definition.version) || definition.version < 1) {
        problems.push('version must be a positive integer');
    }

    if (definition.outputs.length === 0 && definition.category !== 'compositor') {
        problems.push('has no outputs');
    }

    problems.push(...duplicatePortNames('input', definition.inputs));
    problems.push(...duplicatePortNames('output', definition.outputs));

    if (definition.cost.renderPasses < 0) {
        problems.push('renderPasses is negative');
    }

    for (const [name, value] of Object.entries(definition.parameters ?? {})) {
        if (!Number.isFinite(value)) {
            problems.push(`parameter ${name} has a non-finite default`);
        }
    }

    for (const binding of definition.defaultBindings ?? []) {
        if (definition.parameters?.[binding.parameter] === undefined) {
            problems.push(`binding targets undeclared parameter ${binding.parameter}`);
        }
    }

    return problems;
}

function duplicatePortNames(kind: string, ports: readonly PluginPort[]): string[] {
    const seen = new Set<string>();
    const problems: string[] = [];

    for (const port of ports) {
        if (seen.has(port.name)) {
            problems.push(`duplicate ${kind} port ${port.name}`);
        }
        seen.add(port.name);
    }

    return problems;
}
