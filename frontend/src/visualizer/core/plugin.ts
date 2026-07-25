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
    | 'depth-texture'
    | 'motion-field'
    | 'particle-buffer'
    | 'geometry'
    | 'palette'
    | 'scalar-feature'
    | 'event-feature'
    | 'event-stream';

export interface PluginPort {
    name: string;
    type: PortType;
    required: boolean;
    multiple?: boolean;
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
    /** Deterministic per-instance value derived from the scene seed. */
    seed: number;
    renderWidth: number;
    renderHeight: number;
    /** Resolved parameter values after bindings have been applied. */
    parameters: Readonly<Record<string, number>>;
    /** Uploads geometry for a `GeometryPass` to draw. */
    uploadGeometry(upload: GeometryUpload): void;
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
