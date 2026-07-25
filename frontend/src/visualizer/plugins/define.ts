/**
 * Plugin declaration helpers.
 *
 * Most plugins are one shader plus a description of what they read and write. These helpers carry that
 * boilerplate so a definition reads as its distinguishing parts — ports, cost, character, shader — and
 * the catalog stays reviewable as it grows.
 */

import type { ParameterBinding } from '../core/bindings';
import type { RenderPass, ResourceId } from '../core/passes';
import { impactAge, strongestImpact } from '../core/impact';
import type {
    DeactivationPolicy,
    PluginCategory,
    PluginPort,
    PortType,
    SelectionCharacter,
    VisualPluginDefinition,
    VisualPluginInstance,
} from '../core/plugin';
import { QUAD_VERTEX_SHADER } from '../host/device';

export interface SimpleShaderPlugin {
    id: string;
    category: PluginCategory;
    /** Input port name to the sampler uniform it binds to. */
    inputs: { name: string; type: PortType; required: boolean; sampler?: string; multiple?: boolean }[];
    outputs: { name: string; type: PortType }[];
    capabilities: string[];
    requiredAssets?: string[];
    fragment: string;
    /** Static uniform values. Parameter-driven values are added on top each frame. */
    uniforms?: Record<string, number | readonly number[]>;
    parameters?: Record<string, number>;
    bindings?: ParameterBinding[];
    character: SelectionCharacter;
    gpuCost?: number;
    memoryCost?: number;
    dominant?: boolean;
    activationWeight?: number;
    minimumDuration?: number;
    cooldown?: number;
    incompatibleWith?: string[];
    prefersWith?: string[];
    deactivationPolicy?: DeactivationPolicy;
    blend?: RenderPass['blend'];
    clear?: boolean;
    /** Renders into the output at reduced resolution, for simulation fields. */
    scale?: number;
    /** Reads its own previous frame through a declared feedback edge. */
    feedbackPort?: string;
    /**
     * Feeds the strongest live impact into `uImpactCentre`, `uImpactRadius`, and `uImpactEnergy`.
     *
     * Declaring `impact-consumer` is not enough on its own — a plugin has to actually read the bus, and
     * several declared the capability while rendering from static uniforms.
     */
    impactDriven?: boolean;
}

/**
 * Builds a definition for a plugin that is one fullscreen pass.
 *
 * Emits no passes when a required input is missing, so an incompletely wired scene degrades to a gap
 * rather than a GL error.
 */
export function defineShaderPlugin(spec: SimpleShaderPlugin): VisualPluginDefinition {
    const shaderId = spec.id;

    return {
        id: spec.id,
        version: 1,
        category: spec.category,
        inputs: spec.inputs.map((input): PluginPort => ({
            name: input.name,
            type: input.type,
            required: input.required,
            multiple: input.multiple,
        })),
        outputs: spec.outputs.map((output): PluginPort => ({
            name: output.name,
            type: output.type,
            required: false,
        })),
        capabilities: spec.capabilities,
        cost: {
            gpu: spec.gpuCost ?? 1,
            cpu: 0,
            memory: spec.memoryCost ?? 1,
            renderPasses: 1,
            qualityScalable: true,
            dominant: spec.dominant ?? false,
        },
        character: spec.character,
        activationRules: {
            activationWeight: spec.activationWeight ?? 1,
            minimumDuration: spec.minimumDuration,
            cooldown: spec.cooldown,
            requiredAssets: spec.requiredAssets,
            incompatibleWith: spec.incompatibleWith,
            prefersWith: spec.prefersWith,
        },
        parameters: spec.parameters,
        defaultBindings: spec.bindings,
        deactivationPolicy: spec.deactivationPolicy ?? 'fade',

        create(context): VisualPluginInstance {
            let elapsed = 0;
            let phase = 0;
            let spin = 0;
            let impact = { centre: [0.5, 0.5] as [number, number], radius: 0, energy: 0 };

            return {
                initialize() {
                    context.registerShader({
                        id: shaderId,
                        vertex: QUAD_VERTEX_SHADER,
                        fragment: spec.fragment,
                    });
                },

                activate() {
                    phase = context.seed * Math.PI * 2;
                    elapsed = 0;
                    spin = 0;
                },

                update(frame) {
                    // Frozen-aware: a paused clock passes zero, so animated plugins hold their frame.
                    elapsed += frame.deltaSeconds;

                    // `spin` is the convention for an audio-driven phase velocity: a plugin declares
                    // it as a parameter with a `rate` binding and the kernel integrates it, so how
                    // fast the shader's phase advances follows the music. `uTime` alone can only run
                    // at one speed. Added to the seed phase rather than replacing it, so instances of
                    // the same plugin stay separated.
                    spin = frame.parameters.spin ?? 0;

                    if (!spec.impactDriven) {
                        return;
                    }

                    const strongest = strongestImpact(frame.impacts, frame.clock.playbackTime);
                    if (!strongest) {
                        impact = { centre: impact.centre, radius: 0, energy: 0 };
                        return;
                    }

                    // Radius grows with the impact's age, so the ring travels outward from where the
                    // collision actually happened rather than sitting at the centre of the frame.
                    const age = impactAge(strongest, frame.clock.playbackTime);
                    impact = {
                        centre: strongest.position,
                        radius: strongest.radius + age * 0.8,
                        energy: strongest.energy * (1 - age),
                    };
                },

                render(render): RenderPass[] {
                    const inputs: Record<string, ResourceId> = {};

                    for (const input of spec.inputs) {
                        const sampler = input.sampler ?? defaultSampler(input.name);
                        const resource = input.name === spec.feedbackPort
                            ? render.previous[input.name] ?? render.inputs[input.name]
                            : render.inputs[input.name];

                        if (resource) {
                            inputs[sampler] = resource;
                        } else if (input.required) {
                            return [];
                        }
                    }

                    return [{
                        kind: 'fullscreen',
                        shader: shaderId,
                        inputs,
                        output: render.outputs[spec.outputs[0]?.name],
                        blend: spec.blend ?? 'none',
                        clear: spec.clear ?? true,
                        scale: spec.scale,
                        uniforms: {
                            uTime: elapsed,
                            uPhase: phase + spin,
                            uSeed: context.seed,
                            ...(spec.uniforms ?? {}),
                            ...(spec.impactDriven
                                ? {
                                    uCentre: impact.centre,
                                    uImpactCentre: impact.centre,
                                    uImpactRadius: impact.radius,
                                    uImpactEnergy: impact.energy,
                                }
                                : {}),
                        },
                    }];
                },

                deactivate() {
                    // Layer opacity is driven by the retirement policy, not by the plugin.
                },

                destroy() {
                    elapsed = 0;
                },
            };
        },
    };
}

/** `source` becomes `uSource`, `mask` becomes `uMask`. */
function defaultSampler(portName: string): string {
    return `u${portName.charAt(0).toUpperCase()}${portName.slice(1)}`;
}

/** Character presets, so a definition states only what makes it different. */
export function character(overrides: Partial<SelectionCharacter> = {}): SelectionCharacter {
    return {
        visualDensity: 0.5,
        motionEnergy: 0.5,
        geometricOrder: 0.5,
        recognizability: 0.2,
        persistence: 0.4,
        brightness: 0.5,
        dominance: 'either',
        ...overrides,
    };
}

/** GLSL helpers shared across the catalog, prepended where needed. */
export const GLSL_COMMON = `
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 frac = fract(p);
    vec2 smoothed = frac * frac * (3.0 - 2.0 * frac);

    float a = hash(cell);
    float b = hash(cell + vec2(1.0, 0.0));
    float c = hash(cell + vec2(0.0, 1.0));
    float d = hash(cell + vec2(1.0, 1.0));

    return mix(mix(a, b, smoothed.x), mix(c, d, smoothed.x), smoothed.y);
}

float fbm(vec2 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i += 1) {
        total += valueNoise(p) * amplitude;
        p *= 2.0;
        amplitude *= 0.5;
    }
    return total;
}

vec2 rotate(vec2 v, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return mat2(c, -s, s, c) * v;
}

float luminance(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}
`;
