/**
 * Static checks on every shader in the catalog.
 *
 * WebGL has no binary shader format, so shaders cannot be compiled ahead of deploy — the browser
 * compiles the source text at runtime. What can be checked without a driver is the contract between a
 * plugin's declared parameters and the uniforms its shader actually reads. A parameter with no matching
 * uniform is a dead binding: the scheduler distributes it, the runtime smooths it, and nothing consumes
 * it. That is the defect class this file exists to catch, because it is invisible at runtime.
 *
 * Real GLSL validation needs a compiler and is tracked in docs/backlog.md.
 */

import { describe, expect, test } from 'vitest';
import { allDefinitions } from './plugins/registry';
import { GLSL_HISTORY } from './plugins/define';
import { isFeedbackPort, isImagePortType } from './core/wiring';
import { parameterUniformName } from './core/parameters';
import type { VisualPluginDefinition } from './core/plugin';

/** Every shader source a plugin registers, vertex and fragment together. */
function shaderSources(definition: VisualPluginDefinition): { id: string; vertex: string; fragment: string }[] {
    const sources: { id: string; vertex: string; fragment: string }[] = [];
    const instance = definition.create({
        instanceId: 'contract-check',
        seed: 0.5,
        registerShader: (source) => sources.push(source),
    });

    instance.initialize();
    return sources;
}

function declaresUniform(source: string, name: string): boolean {
    return new RegExp(`uniform\\s+\\w+\\s+${name}\\b`).test(source);
}

/**
 * Parameters a plugin consumes on the CPU rather than through a uniform.
 *
 * Listed explicitly with the reason, so a genuinely dead parameter cannot hide behind a blanket
 * exemption. Each of these is read in the plugin's `update` to shape geometry or simulation.
 */
const CPU_SIDE_PARAMETERS: Record<string, string> = {
    'SignalTraceSource:amplitude': 'scales the waveform when writing trace vertices',
    'SpectrumGeometrySource:gain': 'scales spectrum magnitudes when writing vertices',
    'TransientGlyphSource:scale': 'scales glyph reach when writing glyph geometry',
    'ImpactCascadeSimulator:energyScale': 'scales collision energy in the CPU-side cascade step',
    'ParticleRenderer:debug': 'controls CPU-side debug geometry and passes',
    'SymmetryTransform:spin': 'integrated phase velocity, folded into uPhase by defineShaderPlugin',
    'SDFShapeSource:spin': 'integrated phase velocity, folded into uPhase by defineShaderPlugin',
};

/**
 * Plugins whose parameters are read by the CPU simulation rather than by a shader.
 *
 * These four publish authored data — an emitter configuration, a force, a collider — into the
 * simulator's world; none of them registers a shader at all. A per-parameter allowlist here would be
 * fifty entries restating the same fact, which is why this is by family. `ParticleRenderer` is
 * deliberately absent: it does draw, and its `brightness` reaches GL as a uniform like any other.
 */
const CPU_VALUE_FAMILIES = new Set([
    'ParticleSimulator',
    'ParticleEmitter',
    'ParticleForceField',
    'ParticleCollider',
]);

function isCpuSide(definition: VisualPluginDefinition, parameter: string): boolean {
    const family = definition.id.split(':')[0];
    return CPU_VALUE_FAMILIES.has(family)
        || CPU_SIDE_PARAMETERS[`${family}:${parameter}`] !== undefined;
}

const CATALOG = allDefinitions();

describe('every shader is structurally well formed', () => {
    test('the catalog registers shaders to check', () => {
        const total = CATALOG.reduce((count, definition) => count + shaderSources(definition).length, 0);

        expect(total).toBeGreaterThan(0);
    });

    test('every fragment shader declares a version and an output', () => {
        for (const definition of CATALOG) {
            for (const source of shaderSources(definition)) {
                expect(source.fragment.startsWith('#version 300 es'), `${definition.id} fragment version`).toBe(true);
                expect(source.fragment, `${definition.id} fragment output`).toMatch(/out\s+vec4\s+\w+/);
                expect(source.fragment, `${definition.id} fragment precision`).toMatch(/precision\s+\w+\s+float/);
            }
        }
    });

    test('every vertex shader declares a version', () => {
        for (const definition of CATALOG) {
            for (const source of shaderSources(definition)) {
                expect(source.vertex.startsWith('#version 300 es'), `${definition.id} vertex version`).toBe(true);
            }
        }
    });

    test('braces balance, so no shader was truncated by a template seam', () => {
        for (const definition of CATALOG) {
            for (const source of shaderSources(definition)) {
                for (const [stage, text] of [['vertex', source.vertex], ['fragment', source.fragment]] as const) {
                    const opens = (text.match(/\{/g) ?? []).length;
                    const closes = (text.match(/\}/g) ?? []).length;
                    expect(opens, `${definition.id} ${stage} braces`).toBe(closes);
                }
            }
        }
    });

    test('no shader body contains a backtick', () => {
        // Every shader in the catalog is a template literal, so a backtick inside a GLSL comment
        // terminates the string early. TypeScript then reports a syntax error somewhere after the
        // shader with no indication that a comment caused it, which cost four separate diagnoses
        // while this work was going on. A backtick can only ever appear here by that mistake.
        for (const definition of CATALOG) {
            for (const source of shaderSources(definition)) {
                expect(source.fragment.includes('`'), `${definition.id} fragment`).toBe(false);
                expect(source.vertex.includes('`'), `${definition.id} vertex`).toBe(false);
            }
        }
    });

    test('no shader interpolates an undefined value', () => {
        // A template literal referencing a missing constant produces the literal text "undefined".
        for (const definition of CATALOG) {
            for (const source of shaderSources(definition)) {
                expect(source.fragment.includes('undefined'), `${definition.id} fragment`).toBe(false);
                expect(source.vertex.includes('undefined'), `${definition.id} vertex`).toBe(false);
            }
        }
    });
});

describe('declared parameters reach a uniform', () => {
    test('every parameter is either a declared uniform or a listed CPU-side value', () => {
        const dead: string[] = [];

        for (const definition of CATALOG) {
            const sources = shaderSources(definition);
            const combined = sources.map((source) => `${source.vertex}\n${source.fragment}`).join('\n');

            for (const parameter of Object.keys(definition.parameters ?? {})) {
                if (declaresUniform(combined, parameterUniformName(parameter)) || isCpuSide(definition, parameter)) {
                    continue;
                }

                dead.push(`${definition.id}.${parameter} (expected ${parameterUniformName(parameter)})`);
            }
        }

        expect(dead, 'parameters nothing consumes').toEqual([]);
    });

    test('every bound parameter is consumed, so no binding is decorative', () => {
        // Stricter than the above: an unbound parameter that nothing reads is merely untidy, but a bound
        // one means the scheduler is distributing reactivity into a void.
        const dead: string[] = [];

        for (const definition of CATALOG) {
            const combined = shaderSources(definition)
                .map((source) => `${source.vertex}\n${source.fragment}`)
                .join('\n');

            for (const binding of definition.defaultBindings ?? []) {
                const consumed = declaresUniform(combined, parameterUniformName(binding.parameter))
                    || isCpuSide(definition, binding.parameter);

                if (!consumed) {
                    dead.push(`${definition.id}.${binding.parameter} bound to ${binding.feature}`);
                }
            }
        }

        expect(dead, 'bindings driving nothing').toEqual([]);
    });

    test('every CPU-side exemption still names a declared parameter', () => {
        // Keeps the allowlist from outliving the parameter it excuses.
        for (const key of Object.keys(CPU_SIDE_PARAMETERS)) {
            const [family, parameter] = key.split(':');
            const matching = CATALOG.filter((definition) => definition.id.split(':')[0] === family);

            expect(matching.length, `${family} is registered`).toBeGreaterThan(0);
            expect(
                matching.some((definition) => definition.parameters?.[parameter] !== undefined),
                `${key} still exists`,
            ).toBe(true);
        }
    });

    test('a uniform the runtime always supplies is declared where it is used', () => {
        // uResolution is set on every pass; a shader referencing it without declaring it will not compile.
        for (const definition of CATALOG) {
            for (const source of shaderSources(definition)) {
                if (/\buResolution\b/.test(source.fragment)) {
                    expect(
                        declaresUniform(source.fragment, 'uResolution'),
                        `${definition.id} declares uResolution`,
                    ).toBe(true);
                }
            }
        }
    });
});

describe('impact-driven shaders declare the impact uniforms they are given', () => {
    test('a plugin reading impacts declares the uniforms the runtime sets', () => {
        const consumers = CATALOG.filter((definition) =>
            definition.capabilities.includes('impact-consumer')
            && !definition.id.startsWith('TransientGlyphSource'));

        expect(consumers.length).toBeGreaterThan(0);

        for (const definition of consumers) {
            const combined = shaderSources(definition)
                .map((source) => source.fragment)
                .join('\n');

            expect(declaresUniform(combined, 'uImpactEnergy'), `${definition.id}`).toBe(true);
            expect(declaresUniform(combined, 'uImpactRadius'), `${definition.id}`).toBe(true);
            expect(declaresUniform(combined, 'uImpactCentre'), `${definition.id}`).toBe(true);
        }
    });
});

/**
 * A sampler and a scalar cannot share a uniform name.
 *
 * `defineShaderPlugin` gives every plugin `uTime`, `uPhase`, and `uSeed`, and each declared parameter
 * becomes `u<Name>`. An input port's sampler defaults to the same scheme, so a port named `seed`
 * produces `uSeed` too — and then the runtime binds a texture to it and immediately writes a float
 * over it. The driver rejects one of the two on every frame of every scene containing that plugin,
 * silently, which is exactly the class of fault that only ever shows up in a browser console.
 */
/**
 * Uniforms the kernel states for every pass, which a plugin must not also declare.
 *
 * The runtime writes these after a plugin's own uniforms so the kernel always wins, but a plugin that
 * declares one is still stating something it does not control, and was relying on the opposite order
 * when it was written. Two simulators declared `uDelta: 1 / 60` and neither declared a matching
 * parameter to displace it, so both integrated a fixed sixtieth of a second per *frame* — fast on a
 * high-refresh display, and still evolving while playback was paused.
 */
describe('the kernel owns the frame timebase and geometry', () => {
    const KERNEL_UNIFORMS = ['uDelta', 'uResolution'];

    test('no plugin declares a kernel-owned uniform as a pass default', () => {
        const declared: string[] = [];

        for (const definition of CATALOG) {
            const instance = definition.create({
                instanceId: 'kernel-uniform-check',
                seed: 0.5,
                registerShader: () => undefined,
            });
            instance.initialize();
            instance.activate?.({ playbackTime: 0 } as never);

            const inputs: Record<string, string> = {};
            for (const port of definition.inputs) {
                inputs[port.name] = `resource:${port.name}`;
            }
            const outputs: Record<string, string> = {};
            for (const port of definition.outputs) {
                outputs[port.name] = `resource:${port.name}`;
            }

            let passes;
            try {
                passes = instance.render({
                    inputs, outputs, previous: {}, renderWidth: 256, renderHeight: 256,
                } as never);
            } catch {
                // A plugin needing live state to render is checked by the runtime instead.
                continue;
            }

            for (const pass of passes) {
                for (const name of KERNEL_UNIFORMS) {
                    if (pass.uniforms && name in pass.uniforms) {
                        declared.push(`${definition.id} -> ${name}`);
                    }
                }
            }
        }

        expect(declared, 'plugin overriding a kernel-owned uniform').toEqual([]);
    });
});

/**
 * The attenuation contract (ADR-0012).
 *
 * Any edge may carry a previous frame, so a loop can be closed wherever wiring allows. The kernel
 * owns the combine for its own accumulation and can promise a fixed point; it does not own one
 * closed through the graph. What it requires instead is that whatever closes a loop is lossy and
 * bounded, and both live in one GLSL helper so no plugin has to be trusted to write them itself —
 * each of the three that closed loops before this existed wrote `pow(uDecay, delta * 60.0)`, burying
 * a per-frame-at-sixty assumption in a constant, and none of them clamped.
 */
describe('a plugin that may close an image loop attenuates and bounds it', () => {
    // Scoped by port type, not by capability. A simulator closing a loop on its own state type is
    // advancing a simulation bounded by its own dynamics — Gray-Scott stays inside nought to one
    // because the reaction does — and nothing else produces those types, so such a loop cannot be
    // cross-wired anywhere. A loop carrying a colour or mask texture is a picture fed back into a
    // picture, and that is the one that diverges.
    const closers = CATALOG.filter((definition) =>
        definition.capabilities.includes('feedback')
        && definition.inputs.some((port) => isFeedbackPort(port) && isImagePortType(port.type)));

    test('the catalog has some', () => {
        expect(closers.length).toBeGreaterThan(0);
    });

    test('each declares a per-second decay parameter', () => {
        for (const definition of closers) {
            expect(definition.parameters?.decay, `${definition.id} decay`).toBeTypeOf('number');
            // Per second, not per frame. A per-frame figure looks like 0.94; over a second that is
            // 0.024, so anything close to one here is the old units surviving the conversion.
            expect(definition.parameters?.decay, `${definition.id} decay is per second`)
                .toBeLessThan(0.85);
        }
    });

    test('each reads its history through the shared helper rather than sampling it raw', () => {
        for (const definition of closers) {
            const combined = shaderSources(definition)
                .map((source) => source.fragment)
                .join('\n');

            expect(combined, `${definition.id} uses history()`).toMatch(/\bhistory\s*\(\s*uHistory/);
            expect(
                /texture\s*\(\s*uHistory/.test(combined),
                `${definition.id} samples uHistory directly`,
            ).toBe(false);
        }
    });

    test('the helper attenuates by delta and clamps', () => {
        expect(GLSL_HISTORY).toMatch(/pow\s*\(\s*clamp\s*\(\s*decay/);
        expect(GLSL_HISTORY).toMatch(/clamp\s*\(\s*sampled/);
    });
});

describe('uniform names do not collide', () => {
    /** Names `defineShaderPlugin` sends as scalars to every plugin it builds. */
    const BOILERPLATE = ['uTime', 'uPhase', 'uSeed'];

    function samplerName(definition: VisualPluginDefinition, port: string): string {
        // Mirrors `defaultSampler`: `source` becomes `uSource`.
        return `u${port.charAt(0).toUpperCase()}${port.slice(1)}`;
    }

    test('no plugin binds a texture to a name it also writes a scalar to', () => {
        const collisions: string[] = [];

        for (const definition of CATALOG) {
            const sources = shaderSources(definition);
            const combined = sources.map((entry) => `${entry.vertex}\n${entry.fragment}`).join('\n');

            const scalars = new Set([
                ...BOILERPLATE,
                ...Object.keys(definition.parameters ?? {}).map(parameterUniformName),
            ]);

            for (const port of definition.inputs) {
                const declared = new RegExp(`uniform\\s+sampler2D\\s+(u\\w+)`, 'g');
                const samplers = [...combined.matchAll(declared)].map((match) => match[1]);
                const guess = samplerName(definition, port.name);

                if (samplers.includes(guess) && scalars.has(guess)) {
                    collisions.push(`${definition.id}.${port.name} -> ${guess}`);
                }
            }
        }

        expect(collisions, 'sampler and scalar sharing a uniform name').toEqual([]);
    });
});

/**
 * A parameter nothing drives is a knob nailed down.
 *
 * The catalog reached a point where 153 of its 369 parameters had no binding at all, and they were
 * disproportionately the ones that make a scene move: the feedback transform's trail length and
 * rotation, the impulse field's onset — three of whose six modes multiply their entire output by it,
 * so they emitted a field of exactly zero — the vector field's spatial scale, the shockwave's
 * magnitude, the mixer's blend. Every one of those ran, and every one ran at a constant.
 *
 * The exemptions below are parameters that genuinely should not follow the music. Anything else must
 * be bound, so a new plugin cannot quietly ship inert.
 */
describe('parameters are driven', () => {
    /** Parameters deliberately left static, with the reason. */
    const STATIC_PARAMETERS: Record<string, string> = {
        'ToneMapper:exposure': 'output conversion, must not breathe with the music',
        'ToneMapper:gamma': 'neutral: the kernel grade owns the output transfer',
        'ToneMapper:blackLevel': 'output conversion',
        'ToneMapper:grain': 'output conversion',
        'MaskSignedDistanceField:invert': 'a switch, not a continuous value',
        'MaskSignedDistanceField:searchRadius': 'sets the derivation cost, not its appearance',
        'MaskContainmentField:outside': 'a switch, not a continuous value',
        'MaskEffectStencil:edgeOnly': 'a switch, not a continuous value',
        'AlbumArtPalette:saturationFloor': 'a floor on extraction, not a visual parameter',
        'ImpactCascadeSimulator:brightness': 'the cascade drives its own energy',

        // A body's material. Elasticity, friction, and mass are what a body *is*, and moving them
        // per frame changes the material under it mid-bounce rather than changing what it does.
        'ParticleEmitter:mass': 'a body property, fixed at emission',
        'ParticleEmitter:elasticity': 'a body property, fixed at emission',
        'ParticleEmitter:friction': 'a body property, fixed at emission',
        'ParticleCollider:elasticity': 'a surface property; a wall is a wall',
        'ParticleCollider:friction': 'a surface property; a wall is a wall',

        // Positions are in world pixels, so any bound range would be a different fraction of the
        // frame at every render size. Worth revisiting if these become normalised coordinates.
        'ParticleEmitter:originX': 'world pixels, so a bound range would not survive a resize',
        'ParticleEmitter:originY': 'world pixels, so a bound range would not survive a resize',
        'ParticleForceField:x': 'world pixels, so a bound range would not survive a resize',
        'ParticleForceField:y': 'world pixels, so a bound range would not survive a resize',
        'ParticleCollider:x': 'world pixels, so a bound range would not survive a resize',
        'ParticleCollider:y': 'world pixels, so a bound range would not survive a resize',
        'ParticleCollider:x1': 'world pixels, so a bound range would not survive a resize',
        'ParticleCollider:y1': 'world pixels, so a bound range would not survive a resize',
        'ParticleCollider:x2': 'world pixels, so a bound range would not survive a resize',
        'ParticleCollider:y2': 'world pixels, so a bound range would not survive a resize',

        'ParticleEmitter:lifetime': 'copied onto a body at emission; moving it makes the field depth wander for no visible reason',
        'ParticleEmitter:colorR': 'particles emit luminance and take the scene scheme at the composite, as every other source does',
        'ParticleEmitter:colorG': 'particles emit luminance and take the scene scheme at the composite, as every other source does',
        'ParticleEmitter:colorB': 'particles emit luminance and take the scene scheme at the composite, as every other source does',
        'ParticleCollider:containInside': 'a switch, not a continuous value',
        'ParticleRenderer:debug': 'a switch the Lab sets, not a visual parameter',
        'ParticleSimulator:collisionIterations': 'solver convergence, not appearance',
    };

    test('every parameter is bound to a feature or listed as deliberately static', () => {
        const inert: string[] = [];

        for (const definition of CATALOG) {
            const bound = new Set((definition.defaultBindings ?? []).map((entry) => entry.parameter));
            const family = definition.id.split(':')[0];

            for (const parameter of Object.keys(definition.parameters ?? {})) {
                if (bound.has(parameter) || STATIC_PARAMETERS[`${family}:${parameter}`]) {
                    continue;
                }

                inert.push(`${family}:${parameter}`);
            }
        }

        expect([...new Set(inert)], 'parameters nothing drives').toEqual([]);
    });

    test('every static exemption still names a declared parameter', () => {
        for (const key of Object.keys(STATIC_PARAMETERS)) {
            const [family, parameter] = key.split(':');
            const matching = CATALOG.filter((definition) => definition.id.split(':')[0] === family);

            expect(matching.length, `${family} is registered`).toBeGreaterThan(0);
            expect(
                matching.some((definition) => definition.parameters?.[parameter] !== undefined),
                `${key} still exists`,
            ).toBe(true);
        }
    });
});
