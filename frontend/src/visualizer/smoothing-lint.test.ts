/**
 * A lint over every shader in the catalog for operations that average.
 *
 * Nobody ever asked this system to smooth anything, and it smooths everything. That is not because
 * anyone chose it: averaging is what you get by leaving a default alone. A texture read filters
 * unless the coordinate lands on a texel centre. `mix` is a weighted mean. `smoothstep` is a soft
 * threshold. A sum of neighbouring taps over their count is a blur kernel. Each one is invisible in
 * review, each is individually defensible, and applied every frame inside a loop they compound until
 * the picture is a uniform field — measured, a drift transport leaves 2.8% of its detail after one
 * second and 0.1% after two.
 *
 * Every other invariant in this subsystem is a computed number that fails a build: loop gain has
 * `divergentCycles`, terminal count has `structuralViolations`, a mixer reading one branch twice has
 * a test. Averaging had nothing, so it is the one property that could be degraded to zero without a
 * single check going red, and it was, repeatedly, by every round of work including this one.
 *
 * This is that check. It is a lint rather than a render measurement on purpose: a render takes
 * twenty-five minutes, needs a GPU, and tells you a scene went to mush without telling you which
 * line did it. This runs in the test suite in milliseconds and names the line.
 *
 * The allowlist below is the whole point of the file. An averaging operation is not forbidden — it
 * is required to be *stated*, with the reason it is not a defect, in one place that can be read end
 * to end. Anything not on the list fails.
 */

import { describe, expect, test } from 'vitest';
import { allDefinitions } from './plugins/registry';
import type { VisualPluginDefinition } from './core/plugin';

/** Every shader source a plugin registers, vertex and fragment together. */
function shaderSources(definition: VisualPluginDefinition): { id: string; vertex: string; fragment: string }[] {
    const sources: { id: string; vertex: string; fragment: string }[] = [];
    const instance = definition.create({
        instanceId: 'smoothing-lint',
        seed: 0.5,
        registerShader: (source) => sources.push(source),
    });

    instance.initialize();
    return sources;
}

interface Finding {
    plugin: string;
    shader: string;
    line: number;
    kind: string;
    text: string;
}

/**
 * What counts as averaging, by the shape it takes in GLSL.
 *
 * Deliberately syntactic. A semantic rule would need to know what the operands mean, which is the
 * argument that lets every individual case through.
 */
const RULES: { kind: string; pattern: RegExp; note: string }[] = [
    {
        kind: 'mix',
        pattern: /\bmix\s*\(/,
        note: 'a weighted mean of two values',
    },
    {
        kind: 'smoothstep',
        pattern: /\bsmoothstep\s*\(/,
        note: 'a soft threshold, which is a ramp where a decision was wanted',
    },
    {
        kind: 'tap-average',
        // A sum divided by a count: the shape of a blur kernel.
        pattern: /\/\s*(?:2|3|4|5|6|7|8|9|16|25)\.0\b/,
        note: 'a sum of samples over their count is a blur kernel',
    },
    {
        kind: 'temporal-decay',
        pattern: /\bpow\s*\([^;]*\buDelta\b/,
        note: 'an exponential decay is a low-pass in time',
    },
];

/** Reads of a texture at a coordinate the shader computed, which bilinear filtering will smooth. */
const DISPLACED_READ = /\btexture\s*\(\s*(\w+)\s*,\s*([^)]*(?:\([^)]*\))?[^)]*)\)/g;

/**
 * Loops that sample a texture: the shape of a convolution, whatever the weights are called.
 *
 * The literal-divisor rule above misses these. A twelve-tap glow divides its sum by a `weight` it
 * accumulated alongside, so there is no `/ 12.0` anywhere in it — and it is a blur either way.
 */
function loopTaps(source: string): number[] {
    const lines = source.split('\n');
    const found: number[] = [];

    lines.forEach((line, index) => {
        if (!/\bfor\s*\(/.test(line)) {
            return;
        }
        let depth = 0;
        let opened = false;
        for (let scan = index; scan < lines.length; scan += 1) {
            for (const character of lines[scan]) {
                if (character === '{') {
                    depth += 1;
                    opened = true;
                } else if (character === '}') {
                    depth -= 1;
                }
            }
            if (/\btexture\s*\(/.test(lines[scan]) && scan > index) {
                found.push(index + 1);
                return;
            }
            if (opened && depth <= 0) {
                return;
            }
        }
    });

    return found;
}

function findings(): Finding[] {
    const found: Finding[] = [];
    // One entry per source line. A shared shader is registered once per mode — nine flow transports
    // all register `feedback-flow` — and counting each registration would report one line nine
    // times and make the inventory look nine times larger than the work to fix it.
    const seen = new Set<string>();

    for (const definition of allDefinitions()) {
        for (const source of shaderSources(definition)) {
            for (const [name, text] of [['vertex', source.vertex], ['fragment', source.fragment]] as const) {
                const lines = text.split('\n');

                for (const line of loopTaps(text)) {
                    const key = `${source.id}/${name}:${line}:loop-tap`;
                    if (seen.has(key)) {
                        continue;
                    }
                    seen.add(key);
                    found.push({
                        plugin: definition.id,
                        shader: `${source.id}/${name}`,
                        line,
                        kind: 'loop-tap',
                        text: lines[line - 1]?.trim() ?? '',
                    });
                }

                lines.forEach((line, index) => {
                    // Comments are prose about the code, not the code.
                    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
                    if (code.trim().startsWith('*')) {
                        return;
                    }

                    const record = (kind: string) => {
                        const key = `${source.id}/${name}:${index}:${kind}`;
                        if (seen.has(key) || EXEMPT_LINES[code.trim()] !== undefined) {
                            return;
                        }
                        seen.add(key);
                        found.push({
                            plugin: definition.id,
                            shader: `${source.id}/${name}`,
                            line: index + 1,
                            kind,
                            text: code.trim(),
                        });
                    };

                    for (const rule of RULES) {
                        if (rule.pattern.test(code)) {
                            record(rule.kind);
                        }
                    }

                    for (const match of code.matchAll(DISPLACED_READ)) {
                        const coordinate = match[2].trim();
                        // A read at the fragment's own coordinate is not a resample: it lands on the
                        // texel it is writing. Anything else is sampled between texels and filtered.
                        if (/^v?[Uu][Vv]$/.test(coordinate) || coordinate === 'vUv') {
                            continue;
                        }
                        record('filtered-resample');
                    }
                });
            }
        }
    }

    return found;
}

/**
 * Averaging that is stated rather than inherited.
 *
 * Keyed by `plugin kind`, valued with why this one is not the defect. Adding an entry is a decision
 * to smooth something, taken on purpose, in a place a reviewer can find. Removing a line from a
 * shader is what removes it from here.
 */
const STATED: Record<string, string> = {};

/**
 * Source lines that read as averaging and are not.
 *
 * Matched on the line itself rather than on the plugin, because these are shared helper bodies that
 * every shader including the helper would otherwise report separately.
 */
const EXEMPT_LINES: Record<string, string> = {
    'return texture(image, snapped);':
        'the body of `resample`: the coordinate was snapped to a texel centre on the line above, so '
        + 'this read returns one texel and interpolates nothing',
};

/**
 * What the catalog contained when this lint was written, per kind.
 *
 * A ratchet rather than a clean sheet. Nine hundred and seventy averaging operations cannot be
 * removed in one change, and a lint that fails from its first commit gets skipped rather than
 * obeyed. What this stops is the thing that actually happened here: smoothing arriving one
 * defensible line at a time, each invisible in review, until the picture is a uniform field.
 *
 * These numbers may only go down. Lowering one after removing an operation is the whole ceremony —
 * it takes one line and it means the class shrank.
 */
const CEILING: Record<string, number> = {
    'filtered-resample': 272,
    mix: 566,
    smoothstep: 108,
    'loop-tap': 9,
    'tap-average': 4,
    'temporal-decay': 12,
};

describe('nothing averages by default', () => {
    test('the catalog registers shaders to lint', () => {
        expect(allDefinitions().flatMap(shaderSources).length).toBeGreaterThan(20);
    });

    test('no kind of averaging is more common than it was', () => {
        const unstated = findings().filter(
            (finding) => STATED[`${finding.plugin} ${finding.kind}`] === undefined,
        );

        const byKind = new Map<string, number>();
        for (const finding of unstated) {
            byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
        }

        for (const [kind, count] of byKind) {
            const ceiling = CEILING[kind];
            const examples = unstated
                .filter((finding) => finding.kind === kind)
                .slice(0, 8)
                .map((finding) => `  ${finding.plugin} ${finding.shader}:${finding.line} ${finding.text}`);

            expect(
                count,
                `${kind}: ${count} where ${ceiling ?? 0} is allowed.\n${examples.join('\n')}`,
            ).toBeLessThanOrEqual(ceiling ?? 0);
        }
    });

    test('the ceilings are not stale, so removing an operation lowers one', () => {
        const unstated = findings().filter(
            (finding) => STATED[`${finding.plugin} ${finding.kind}`] === undefined,
        );

        for (const [kind, ceiling] of Object.entries(CEILING)) {
            const count = unstated.filter((finding) => finding.kind === kind).length;
            expect(count, `${kind} is down to ${count}; lower its ceiling from ${ceiling}`)
                .toBe(ceiling);
        }
    });
});
