import { describe, expect, test } from 'vitest';
import { portTypes, redrawViolations } from './redraw';
import type { RenderPass } from './passes';

const TYPES = {
    'out.color': 'color-texture',
    'out.motion': 'motion-field',
    'in.source': 'color-texture',
    'in.field': 'vector-field',
} as const;

function fullscreen(overrides: Partial<RenderPass> = {}): RenderPass {
    return { kind: 'fullscreen', shader: 's', output: 'out.color', ...overrides } as RenderPass;
}

describe('redraw violations', () => {
    test('a source that replaces its target while reading no colour generates a frame', () => {
        const findings = redrawViolations([fullscreen({ blend: 'none' })], TYPES);

        expect(findings.map((finding) => finding.violation)).toEqual(['generates']);
    });

    test('compositing is enough; the pass need not sample anything', () => {
        expect(redrawViolations([fullscreen({ blend: 'lighten' })], TYPES)).toEqual([]);
    });

    test('reading an upstream colour is the other way to satisfy it', () => {
        const pass = fullscreen({ blend: 'none', inputs: { uSource: 'in.source' } });

        expect(redrawViolations([pass], TYPES)).toEqual([]);
    });

    test('reading a field is not reading colour', () => {
        const pass = fullscreen({ blend: 'none', inputs: { uField: 'in.field' } });

        expect(redrawViolations([pass], TYPES).map((finding) => finding.violation)).toEqual(['generates']);
    });

    test('a colour pass that clears destroys what its target held', () => {
        const pass: RenderPass = {
            kind: 'geometry',
            shader: 's',
            geometry: 'g',
            primitive: 'line-strip',
            vertexCount: 8,
            output: 'out.color',
            blend: 'add',
            clear: true,
        };

        expect(redrawViolations([pass], TYPES).map((finding) => finding.violation)).toEqual(['clears']);
    });

    test('both rules can fail on one pass', () => {
        const pass = fullscreen({ blend: 'none', clear: true });

        expect(redrawViolations([pass], TYPES).map((finding) => finding.violation))
            .toEqual(['clears', 'generates']);
    });

    test('a pass writing something other than colour is not governed', () => {
        const pass = fullscreen({ output: 'out.motion', blend: 'none', clear: true });

        expect(redrawViolations([pass], TYPES)).toEqual([]);
    });

    test('a pass with no declared output is not governed', () => {
        // The runtime falls back to the node's first output, which the caller can supply if it
        // wants the pass checked. An unresolved output is not evidence of a redraw.
        expect(redrawViolations([fullscreen({ output: undefined, blend: 'none' })], TYPES)).toEqual([]);
    });

    test('findings name the resource, and their index into the pass list', () => {
        const passes = [fullscreen({ blend: 'lighten' }), fullscreen({ blend: 'none' })];

        expect(redrawViolations(passes, TYPES)).toEqual([
            { pass: 1, violation: 'generates', output: 'out.color' },
        ]);
    });
});

describe('port types', () => {
    test('keys a definition\'s ports by the resources a render context bound them to', () => {
        const types = portTypes(
            [{ name: 'color', type: 'color-texture' }, { name: 'motion', type: 'motion-field' }],
            { color: 'out.color', motion: 'out.motion' },
        );

        expect(types).toEqual({ 'out.color': 'color-texture', 'out.motion': 'motion-field' });
    });

    test('a port the context did not bind contributes nothing', () => {
        const types = portTypes([{ name: 'color', type: 'color-texture' }], {});

        expect(types).toEqual({});
    });
});
