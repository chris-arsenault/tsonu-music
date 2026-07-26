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
    'ParticleSimulator:lifetime': 'bounds particle age in the simulation step',
    'ParticleRenderer:pointSize': 'set as a vertex-stage point size rather than a fragment uniform',
    'SymmetryTransform:spin': 'integrated phase velocity, folded into uPhase by defineShaderPlugin',
    'SDFShapeSource:spin': 'integrated phase velocity, folded into uPhase by defineShaderPlugin',
};

function isCpuSide(definition: VisualPluginDefinition, parameter: string): boolean {
    const family = definition.id.split(':')[0];
    return CPU_SIDE_PARAMETERS[`${family}:${parameter}`] !== undefined;
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
        'ParticleSimulator:lifetime': 'changing it mid-flight retimes particles already alive',
        'ParticleRenderer:pointSize': 'a vertex-stage constant, not a per-frame value',
        'AlbumArtPalette:saturationFloor': 'a floor on extraction, not a visual parameter',
        'ImpactCascadeSimulator:brightness': 'the cascade drives its own energy',
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
