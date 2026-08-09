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
import { historyDepthFraction } from '../core/performance';
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
    inputs: {
        name: string;
        type: PortType;
        required: boolean;
        sampler?: string;
        multiple?: boolean;
        /** Parameter scaling this input's contribution, for the loop-gain check (ADR-0013). */
        gainParameter?: string;
    }[];
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
    /** Reads its own previous frame through a declared feedback edge. */
    feedbackPort?: string;
    /**
     * Feeds the strongest live impact into `uImpactCentre`, `uImpactRadius`, and `uImpactEnergy`.
     *
     * Declaring `impact-consumer` is not enough on its own — a plugin has to actually read the bus, and
     * several declared the capability while rendering from static uniforms.
     */
    impactDriven?: boolean;
    /**
     * Feeds the quality ladder's permitted history depth into `uDepth`, as a fraction of full depth.
     *
     * The ladder has always computed `historyDepth` and threaded it through `FrameContext`; until a
     * plugin actually kept frames it had nothing to constrain.
     */
    historyDriven?: boolean;
    /**
     * A second pass publishing the displacement this plugin's own material is undergoing.
     *
     * Almost every plugin in the catalog already computes where its material is going and throws it
     * away — a warp's per-pixel offset, a shape's rotation, a scroll's direction — and until the
     * kernel stopped owning the drag there was nowhere for it to go (ADR-0012). Published, it is an
     * ordinary `vector-field` output that anything can read: a feedback warp so the displacement
     * compounds over the accumulated image, a particle force, another warp.
     *
     * Written in UV per second, which is the unit the whole bus carries. The fragment gets the same
     * uniforms as the main pass, so a mode selector and a bound amount read identically in both.
     */
    motion?: {
        /** The output port to write to. Must appear in `outputs` with a motion-source type. */
        port: string;
        fragment: string;
    };
}

/**
 * Builds a definition for a plugin that is one fullscreen pass.
 *
 * Emits no passes when a required input is missing, so an incompletely wired scene degrades to a gap
 * rather than a GL error.
 */
export function defineShaderPlugin(spec: SimpleShaderPlugin): VisualPluginDefinition {
    const shaderId = spec.id;
    const motionShaderId = `${spec.id}:motion`;

    return {
        id: spec.id,
        version: 1,
        category: spec.category,
        inputs: spec.inputs.map((input): PluginPort => ({
            name: input.name,
            type: input.type,
            required: input.required,
            multiple: input.multiple,
            gainParameter: input.gainParameter,
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
            // Publishing the displacement costs a second pass, and the cost accounting has to know
            // or the performance controller budgets for a plugin that is not the one running.
            renderPasses: spec.motion ? 2 : 1,
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
            let depth = 1;
            let impact = { centre: [0.5, 0.5] as [number, number], radius: 0, energy: 0 };

            return {
                initialize() {
                    context.registerShader({
                        id: shaderId,
                        vertex: QUAD_VERTEX_SHADER,
                        fragment: spec.fragment,
                    });

                    if (spec.motion) {
                        context.registerShader({
                            id: motionShaderId,
                            vertex: QUAD_VERTEX_SHADER,
                            fragment: spec.motion.fragment,
                        });
                    }
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

                    if (spec.historyDriven) {
                        depth = historyDepthFraction(frame.historyDepth);
                    }

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
                        // A previous-frame resource is present exactly when wiring drew a back edge
                        // into this port, so its presence is the whole condition (ADR-0013). This
                        // read `input.name === spec.feedbackPort`, which was the last gate: the
                        // compiler recorded `previous` for any historical edge, the render plan
                        // allocated the second slot, and the plugin then ignored both unless the port
                        // happened to carry the name it had declared.
                        const resource = render.previous[input.name] ?? render.inputs[input.name];

                        if (resource) {
                            inputs[sampler] = resource;
                        } else if (input.required) {
                            return [];
                        }
                    }

                    const uniforms = {
                        uTime: elapsed,
                        uPhase: phase + spin,
                        uSeed: context.seed,
                        ...(spec.historyDriven ? { uDepth: depth } : {}),
                        ...(spec.uniforms ?? {}),
                        ...(spec.impactDriven
                            ? {
                                // No `uCentre`: that is a plugin's own static, and writing the
                                // impact centre over it made every `hasImpact ? uImpactCentre :
                                // uCentre` a no-op, since the two held the same value and the
                                // last centre is retained after the energy decays. The
                                // shockwave's audio-driven fallback centre never reached GL.
                                uImpactCentre: impact.centre,
                                uImpactRadius: impact.radius,
                                uImpactEnergy: impact.energy,
                            }
                            : {}),
                    };

                    const passes: RenderPass[] = [{
                        kind: 'fullscreen',
                        shader: shaderId,
                        inputs,
                        output: render.outputs[spec.outputs[0]?.name],
                        blend: spec.blend ?? 'none',
                        clear: spec.clear ?? true,
                        uniforms,
                    }];

                    // The displacement this plugin's own material is undergoing, published as an
                    // ordinary field. Same uniforms as the pass above, so a mode selector and a
                    // bound amount mean the same thing in both — the second pass describes what the
                    // first one did.
                    const motionOutput = spec.motion && render.outputs[spec.motion.port];
                    if (spec.motion && motionOutput) {
                        passes.push({
                            kind: 'fullscreen',
                            shader: motionShaderId,
                            inputs,
                            output: motionOutput,
                            blend: 'none',
                            clear: true,
                            uniforms,
                        });
                    }

                    return passes;
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

/**
 * The one way to read a historical edge.
 *
 * The decay stays, and stays here. ADR-0013 removes the *convex* bounds — the rules making each stage
 * individually non-expansive — and this is not one: it is the loss that makes a cycle converge at all,
 * it is the number `gainParameter` names and `core/loop-gain.ts` multiplies around the loop, and
 * having it in one place is what keeps it comparable across plugins. Each of the three that closed
 * loops before this existed wrote `pow(uDecay, delta * 60.0)`, burying a per-frame-at-sixty
 * assumption in a constant.
 *
 * The ceiling stays too, and is raised by a factor of thirty-two. Its job is to keep a runaway from
 * reaching infinity and then `NaN`, which blanks the frame — the worst failure available and the
 * hardest to read backwards. At eight it had stopped doing only that: a converging loop is *meant* to
 * hold many copies of its source now, and at an injection of 0.3 against a 168-frame memory the
 * steady state runs to roughly twenty times the incoming value, so the guard would have been clipping
 * the accumulation it exists to survive. Two hundred and fifty-six is far above anything the gains
 * can produce and far below where half-float precision goes.
 */
export const GLSL_HISTORY = `
const float HISTORY_CEILING = 256.0;

/** Attenuated and bounded previous frame. The decay is the fraction surviving one second. */
vec4 history(sampler2D previous, vec2 uv, float decay, float delta) {
    float survival = delta > 0.0 ? pow(clamp(decay, 0.0, 1.0), delta) : 1.0;
    vec4 sampled = texture(previous, clamp(uv, 0.0, 1.0)) * survival;

    return clamp(sampled, vec4(-HISTORY_CEILING), vec4(HISTORY_CEILING));
}
`;

/**
 * The displacement a resampling transform applies, as a field (ADR-0012).
 *
 * Every transform that warps, folds, tiles, or shocks answers one question per pixel — which
 * coordinate to read from — and the difference between where it reads and where it writes is exactly
 * a displacement. Each of those plugins now shares its coordinate function between the colour pass
 * and the motion pass, so the two cannot disagree about what the transform did.
 *
 * The sign is reversed against the sampling offset. A transform reads at `source` and writes at
 * `uv`, so material travels from `source` toward `uv`, and a field is a velocity — it points where
 * the material is going.
 */
export const GLSL_RESAMPLE_MOTION = `
/** How much of a resampling is expressed per second. A warp is a position; a field is a rate. */
const float RESAMPLE_RATE = 1.4;

vec4 resampleMotion(vec2 uv, vec2 source) {
    // Bounded because the polar and tiling modes rewrite the coordinate outright rather than nudging
    // it, so their difference spans the frame rather than describing a local displacement, and one
    // mode should not dominate every field it is read beside.
    vec2 field = clamp((uv - source) * RESAMPLE_RATE, vec2(-2.0), vec2(2.0));

    return vec4(field, length(field), 1.0);
}
`;

/**
 * Lets a producer be displaced by a field, which is what makes it able to interact with anything.
 *
 * Measured before this existed: 45 of 46 colour sources and every colour-producing simulator declared
 * no image or field input at all. A node with no inputs cannot be perturbed, cannot be warped, cannot
 * be the sink of a historical edge, and cannot participate in a loop — the only thing the graph can do
 * with it is draw it and composite it. That is why a waveform trace and a mask could sit in the same
 * scene as separate layers with no way to affect one another however the wiring was arranged, and why
 * the same trace was redrawn in the same place every frame no matter what the rest of the scene did.
 *
 * The field is optional everywhere. An unwired sampler reads the empty texture the device binds for
 * exactly this case, which is zero, so the displacement is the identity and a source with nothing
 * wired to it behaves as it always did.
 */
export const GLSL_PERTURB = `
uniform sampler2D uField;
/** UV displaced per unit of field magnitude. Zero is the identity. */
uniform float uPerturb;

vec2 perturbed(vec2 uv) {
    vec2 field = texture(uField, clamp(uv, 0.0, 1.0)).xy;

    return clamp(uv + field * uPerturb, 0.0, 1.0);
}
`;

/**
 * The same displacement for a geometry pass, applied in the vertex shader.
 *
 * Sampling the field per vertex rather than reading it back to the CPU: a trace is a few hundred
 * vertices and the field is already on the GPU, so a texture fetch in the vertex stage is the cheap
 * way round. Positions are clip space, which spans two units against UV's one.
 */
export const GLSL_PERTURB_VERTEX = `
uniform sampler2D uField;
uniform float uPerturb;

vec2 perturbedPosition(vec2 position) {
    vec2 uv = position * 0.5 + 0.5;
    vec2 field = texture(uField, clamp(uv, 0.0, 1.0)).xy;

    return position + field * uPerturb * 2.0;
}
`;

/** GLSL helpers shared across the catalog, prepended where needed. */
export const GLSL_COMMON = `
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

/**
 * Hue, saturation and value to linear RGB.
 *
 * Absent until now, which is most of why 59 plugins in the catalog write vec3(x) and are therefore
 * monochrome: without a way to turn a scalar into a colour, a shader computing one intensity has
 * nothing to do with it but write it to all three channels. Colour then only arrives if a palette
 * mapper happens to land downstream, which is about a third of scenes.
 */
vec3 hsv2rgb(vec3 hsv) {
    vec3 wrapped = clamp(abs(mod(hsv.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);

    return hsv.z * mix(vec3(1.0), wrapped, hsv.y);
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
