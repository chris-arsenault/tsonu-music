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
     * Inputs whose wiring the shader needs to know about, as `u<Name>IsHistory` set to 1 or 0.
     *
     * A weight can mean two different things depending on whether the port it scales carries a
     * forward edge or a loop, and only the CPU side knows which. Without this the shader has to
     * assume, and `LayerMixer` assumed history: it raised its base weight to the frame delta on
     * every port, which is a survival, and 631 of its 643 source ports across 200 scenes carry a
     * forward edge with nothing accumulating on it at all (ADR-0014).
     */
    historyFlags?: string[];
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
 * Persistence for a colour target, costing no memory (ADR-0014).
 *
 * A target can be decayed without being sampled. A fullscreen quad of `survival^Δt` drawn with
 * `multiply` leaves `dst · survival^Δt` behind, because the fixed-function blender reads the
 * destination — no texture fetch, so no second slot and no ping-pong. That is what lets every colour
 * producer in the catalog hold a memory without doubling the frame's target memory.
 *
 * Run ahead of a producer's own passes, it turns a pass that would have overwritten the frame into
 * one that adds to what is already there. The pair is bounded on its own: with a `lighten` combine
 * the target never exceeds the brightest contribution ever made to it, whatever the survival. The
 * bound needs no help from `core/loop-gain.ts`, and would get none — this loop closes through the
 * blender rather than through an edge, so `graphCycles` cannot see it.
 *
 * The rate is per second and corrected by `uDelta`, so a trail lasts the same wall-clock time at
 * thirty frames a second as at a hundred and forty-four.
 */
export const SURVIVAL_PARAMETER = 'survival';

/**
 * The input port a producer is displaced by, and the one its memory drifts along.
 *
 * Named rather than searched for by type: a plugin may read several fields, and the one its own
 * material moves with is the one its memory should move with too.
 */
export const FIELD_INPUT = 'field';

/** Fraction of a colour target surviving one second, when a plugin states no preference. */
export const DEFAULT_SURVIVAL = 0.6;

/**
 * How long the memory is, driven by how much new material is arriving.
 *
 * Inverted on purpose. A dense passage overwrites the frame quickly whatever the survival is, so
 * holding a long memory through one buries the picture; a sparse one has nothing to show but what it
 * remembers. Bound this way the trail lengthens as the track thins out, which is when there is room
 * for it — and the length of the memory becomes something the music moves rather than a constant.
 *
 * The ceiling is 0.9 a second, comfortably below the 1 at which the decay stops being a decay.
 */
export const SURVIVAL_BINDING: ParameterBinding = {
    feature: 'spectralFlux',
    role: 'intensity',
    parameter: SURVIVAL_PARAMETER,
    outputRange: [0.9, 0.35],
    attack: 0.8,
    release: 2.5,
    curve: 'smooth',
};

const DECAY_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform float uDelta;
uniform float uSurvival;

void main() {
    // Drawn with 'multiply', so what lands in the target is its own contents times this.
    float survival = uDelta > 0.0 ? pow(clamp(uSurvival, 0.0, 1.0), uDelta) : 1.0;

    fragColor = vec4(survival);
}`;

/**
 * The same ageing, with the memory carried along the field instead of held in place.
 *
 * Decaying a target leaves a trail where the material was. Advecting it makes the trail flow, which
 * is the difference between a shape that moves across its own wake and a picture that goes somewhere.
 * It costs a texture read, so it costs the second slot a `retained` output asks for, and it is only
 * worth that where a field is wired.
 *
 * Read from behind: a field is a velocity in UV per second, so material travelling along `+field`
 * arrives from `uv − field·Δt`. That is the same sign convention `GLSL_RESAMPLE_MOTION` states, where
 * a transform reads at `source` and writes at `uv`.
 */
const DRIFT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uPrevious;
uniform sampler2D uField;
uniform float uDelta;
uniform float uSurvival;
uniform float uPerturb;

void main() {
    float survival = uDelta > 0.0 ? pow(clamp(uSurvival, 0.0, 1.0), uDelta) : 1.0;
    vec2 velocity = texture(uField, clamp(vUv, 0.0, 1.0)).xy;
    vec2 source = clamp(vUv - velocity * uPerturb * uDelta, 0.0, 1.0);

    fragColor = texture(uPrevious, source) * survival;
}`;

/** The decay shader a plugin registers alongside its own. */
export function decayShaderId(pluginId: string): string {
    return `${pluginId}:decay`;
}

/** The drift shader, used in place of the decay where a previous frame is available. */
export function driftShaderId(pluginId: string): string {
    return `${pluginId}:drift`;
}

/** Both ageing shaders. Registered together, because which one runs is decided per frame. */
export function decayShaderSource(pluginId: string): { id: string; vertex: string; fragment: string }[] {
    return [
        { id: decayShaderId(pluginId), vertex: QUAD_VERTEX_SHADER, fragment: DECAY_FRAGMENT },
        { id: driftShaderId(pluginId), vertex: QUAD_VERTEX_SHADER, fragment: DRIFT_FRAGMENT },
    ];
}

/**
 * The pass that ages a colour target, to run before anything writes into it this frame.
 *
 * `uSurvival` arrives from the plugin's own `survival` parameter, which the runtime merges into
 * every pass of the node — so binding it makes the memory itself follow the music.
 */
export function decayPass(
    pluginId: string,
    output: ResourceId,
    /** The previous frame, when the output is `retained` and the plan gave it a second slot. */
    previous?: ResourceId,
    /** The field to carry the memory along. Absent, the drift would be the identity. */
    field?: ResourceId,
): RenderPass {
    if (!previous || !field) {
        return {
            kind: 'fullscreen',
            shader: decayShaderId(pluginId),
            output,
            blend: 'multiply',
            clear: false,
        };
    }

    return {
        kind: 'fullscreen',
        shader: driftShaderId(pluginId),
        inputs: { uPrevious: previous, uField: field },
        output,
        // Replaces the write slot, which holds the frame before last. What is being preserved is the
        // read slot, and this pass is what carries it across.
        blend: 'none',
        clear: false,
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

    // A plugin that composites into a colour target needs that target to have been aged first, or
    // the accumulation has no upper bound to converge to. A plugin that replaces its target does
    // not: it is already a transform of whatever it read, and a decay ahead of it would be
    // overwritten in the same frame. The declared blend says which of the two this is, so no plugin
    // has to opt in.
    // The first output, and only if it carries colour: that is the one the plugin's own pass writes,
    // so a plugin whose primary product is a field is untouched by any of this even when it also
    // publishes a colour port.
    const primaryOutput = spec.outputs[0];
    const colourOutput = primaryOutput?.type === 'color-texture' ? primaryOutput : undefined;
    const persists = colourOutput !== undefined && (spec.blend ?? 'none') !== 'none';
    const parameters = persists
        ? { [SURVIVAL_PARAMETER]: DEFAULT_SURVIVAL, ...spec.parameters }
        : spec.parameters;
    const statesSurvival = spec.bindings?.some((binding) => binding.parameter === SURVIVAL_PARAMETER);
    const bindings = persists && !statesSurvival
        ? [SURVIVAL_BINDING, ...(spec.bindings ?? [])]
        : spec.bindings;

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
            // The colour a compositing producer accumulates into is the one thing worth a second
            // slot: it is the only output whose previous frame this plugin reads (ADR-0014).
            ...(persists && output === colourOutput ? { retained: true } : {}),
        })),
        capabilities: spec.capabilities,
        cost: {
            gpu: spec.gpuCost ?? 1,
            cpu: 0,
            memory: spec.memoryCost ?? 1,
            // Publishing the displacement costs a second pass, and the cost accounting has to know
            // or the performance controller budgets for a plugin that is not the one running. Ageing
            // the colour target costs a third.
            renderPasses: (spec.motion ? 2 : 1) + (persists ? 1 : 0),
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
        parameters,
        defaultBindings: bindings,
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

                    if (persists) {
                        for (const source of decayShaderSource(spec.id)) {
                            context.registerShader(source);
                        }
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
                        ...Object.fromEntries((spec.historyFlags ?? []).map((name) => [
                            `u${name.charAt(0).toUpperCase()}${name.slice(1)}IsHistory`,
                            render.previous[name] === undefined ? 0 : 1,
                        ])),
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

                    const colourTarget = colourOutput && render.outputs[colourOutput.name];
                    const passes: RenderPass[] = [];

                    // Ahead of the plugin's own pass, so what it composites into is the aged frame
                    // rather than a fresh one. A compositing pass over a target nobody ages is an
                    // accumulation with no upper bound; over a target somebody clears, it is a redraw.
                    if (persists && colourTarget) {
                        passes.push(decayPass(
                            spec.id,
                            colourTarget,
                            render.previous[colourOutput.name],
                            render.inputs[FIELD_INPUT],
                        ));
                    }

                    passes.push({
                        kind: 'fullscreen',
                        shader: shaderId,
                        inputs,
                        output: render.outputs[spec.outputs[0]?.name],
                        blend: spec.blend ?? 'none',
                        // No colour pass clears (ADR-0014). For a compositing one the target is the
                        // memory it is adding to; for a replacing one the flag changes no pixel,
                        // since a fullscreen quad with blend 'none' overwrites the target whether or
                        // not it was cleared first. A pass writing a field or a mask keeps the flag,
                        // because those are recomputed each frame by design.
                        clear: colourOutput ? false : spec.clear ?? true,
                        uniforms,
                    });

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
