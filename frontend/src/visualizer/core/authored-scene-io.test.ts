import { describe, expect, test } from 'vitest';
import {
    migrateScene,
    parseScene,
    serializeScene,
    toFixtureSource,
} from './authored-scene-io';
import {
    AUTHORED_SCENE_VERSION,
    emptyAuthoredScene,
    resolveAuthoredScene,
    type AuthoredScene,
} from './authored-scene';
import { createPluginRegistry } from './plugin';
import type { PluginCategory, PluginPort, VisualPluginDefinition } from './plugin';
import type { ParameterBinding } from './bindings';

function plugin(
    id: string,
    category: PluginCategory,
    inputs: PluginPort[] = [],
    outputs: PluginPort[] = [{ name: 'color', type: 'color-texture', required: false }],
    overrides: Partial<VisualPluginDefinition> = {},
): VisualPluginDefinition {
    return {
        id,
        version: 1,
        category,
        inputs,
        outputs,
        capabilities: [],
        cost: { gpu: 1, cpu: 1, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.5, motionEnergy: 0.5, geometricOrder: 0.5,
            recognizability: 0.5, persistence: 0.5, brightness: 0.5, dominance: 'either',
        },
        activationRules: { activationWeight: 1 },
        create: () => ({
            initialize: () => undefined,
            activate: () => undefined,
            update: () => undefined,
            render: () => [],
            deactivate: () => undefined,
            destroy: () => undefined,
        }),
        ...overrides,
    };
}

const binding: ParameterBinding = {
    feature: 'bassExcite',
    parameter: 'amount',
    mode: 'rate',
    role: 'large-scale-force',
    inputRange: [0, 0.8],
    outputRange: [0, 1],
    attack: 0.1,
    release: 0.25,
    curve: 'smooth',
    polarity: -1,
    wrap: 1,
};

const source = plugin('src', 'source', [], undefined, { parameters: { amount: 0.5 } });
const transform = plugin('trn', 'transformer', [
    { name: 'source', type: 'color-texture', required: true },
]);

const REGISTRY = createPluginRegistry([source, transform]);

function full(): AuthoredScene {
    return {
        ...emptyAuthoredScene('doc-entropy'),
        themeId: 'organic-flow',
        nodes: [
            {
                id: 'src#0',
                pluginId: 'src',
                position: { x: 0, y: 0 },
                seed: 0.25,
                muted: true,
                parameters: { amount: 0.75 },
                bindings: [binding],
            },
            { id: 'trn#0', pluginId: 'trn', position: { x: 320, y: 0 } },
        ],
        edges: [{
            id: 'src#0.color->trn#0.source',
            from: { node: 'src#0', port: 'color' },
            to: { node: 'trn#0', port: 'source' },
        }],
        assetBindings: [{ node: 'src#0', port: 'mask', resource: 'asset:ring' }],
        present: { node: 'trn#0', port: 'color' },
        kernel: {
            compositeInputs: ['trn#0'],
            motionInputs: [],
            grade: { parameters: { exposure: 1.4 }, bindings: [{ ...binding, parameter: 'exposure' }] },
            palette: { id: 'monochrome-noir', strength: 0 },
            persistence: { survivalPerSecond: 0.8 },
            layers: { 'trn#0': { blendMode: 'screen', opacity: 0.5 } },
        },
    };
}

describe('round trip', () => {
    test('a document survives being written and read', () => {
        const parsed = parseScene(serializeScene(full()));

        expect(parsed.ok, parsed.ok ? '' : parsed.problems[0].detail).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.scene).toEqual(full());
    });

    test('writing is canonical, so two exports of one scene are the same bytes', () => {
        const scene = full();
        const shuffled: AuthoredScene = {
            ...scene,
            nodes: scene.nodes.map((node) => (node.parameters
                // Same values, different insertion order.
                ? { ...node, parameters: { ...node.parameters, amount: node.parameters.amount } }
                : node)),
        };

        expect(serializeScene(shuffled)).toBe(serializeScene(scene));
    });

    test('a re-export of a parsed document is byte-identical', () => {
        const once = serializeScene(full());
        const parsed = parseScene(once);

        expect(parsed.ok && serializeScene(parsed.scene)).toBe(once);
    });

    test('the reimported document resolves to the same graph', () => {
        // The claim the whole export path rests on: what comes back renders what went out.
        const before = resolveAuthoredScene(full(), REGISTRY);
        const parsed = parseScene(serializeScene(full()));
        if (!parsed.ok) throw new Error(parsed.problems[0].detail);
        const after = resolveAuthoredScene(parsed.scene, REGISTRY);

        expect(before.ok && after.ok).toBe(true);
        if (!before.ok || !after.ok) return;
        expect(after.scene.graph).toEqual(before.scene.graph);
        expect(after.scene.bindings).toEqual(before.scene.bindings);
        expect(after.scene.seeds).toEqual(before.scene.seeds);
        expect(after.scene.kernel).toEqual(before.scene.kernel);
    });

    test('an empty document round-trips', () => {
        const parsed = parseScene(serializeScene(emptyAuthoredScene('nothing')));

        expect(parsed.ok && parsed.scene).toEqual(emptyAuthoredScene('nothing'));
    });

    test('an absent optional stays absent rather than becoming null', () => {
        const text = serializeScene(emptyAuthoredScene('bare'));

        expect(text).not.toContain('null');
        expect(text).not.toContain('themeId');
    });
});

describe('reading untrusted input', () => {
    test('text that is not JSON is refused with the reason', () => {
        const parsed = parseScene('{ not json');

        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.problems[0].detail).toContain('not valid JSON');
    });

    test('JSON that is not an object is refused', () => {
        expect(parseScene('[1, 2]').ok).toBe(false);
        expect(parseScene('"a scene"').ok).toBe(false);
    });

    test('a document with no version is refused rather than guessed at', () => {
        expect(parseScene(JSON.stringify({ entropy: 'x', nodes: [] })).ok).toBe(false);
    });

    test('a document from a newer build says so', () => {
        const parsed = parseScene(JSON.stringify({
            version: AUTHORED_SCENE_VERSION + 1,
            entropy: 'x',
            nodes: [],
        }));

        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.problems[0].detail).toContain('newer build');
    });

    test('a node missing its plugin id is reported, not silently dropped', () => {
        const parsed = parseScene(JSON.stringify({
            version: AUTHORED_SCENE_VERSION,
            entropy: 'x',
            nodes: [{ id: 'a' }],
        }));

        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.problems[0].detail).toContain('needs an id and a pluginId');
    });

    test('an edge naming a node the file does not contain is reported against the edge', () => {
        const parsed = parseScene(JSON.stringify({
            version: AUTHORED_SCENE_VERSION,
            entropy: 'x',
            nodes: [{ id: 'a', pluginId: 'src', position: { x: 0, y: 0 } }],
            edges: [{
                id: 'e',
                from: { node: 'ghost', port: 'color' },
                to: { node: 'a', port: 'source' },
            }],
        }));

        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.problems[0].edgeId).toBe('e');
    });

    test('a non-finite parameter is dropped with a warning rather than reaching the shader', () => {
        // NaN in a uniform blanks the frame, which looks exactly like the fault the document was
        // saved to demonstrate.
        const parsed = parseScene(JSON.stringify({
            version: AUTHORED_SCENE_VERSION,
            entropy: 'x',
            nodes: [{
                id: 'a',
                pluginId: 'src',
                position: { x: 0, y: 0 },
                parameters: { good: 1, bad: 'nonsense' },
            }],
        }));

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.scene.nodes[0].parameters).toEqual({ good: 1 });
        expect(parsed.warnings[0].nodeId).toBe('a');
    });

    test('a malformed binding is refused rather than half-read', () => {
        const parsed = parseScene(JSON.stringify({
            version: AUTHORED_SCENE_VERSION,
            entropy: 'x',
            nodes: [{
                id: 'a',
                pluginId: 'src',
                position: { x: 0, y: 0 },
                bindings: [{ feature: 'rms', parameter: 'amount' }],
            }],
        }));

        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.problems[0].nodeId).toBe('a');
    });

    test('an unknown curve or blend mode is not accepted as one', () => {
        const parsed = parseScene(JSON.stringify({
            version: AUTHORED_SCENE_VERSION,
            entropy: 'x',
            nodes: [{
                id: 'a',
                pluginId: 'src',
                position: { x: 0, y: 0 },
                bindings: [{ ...binding, curve: 'bezier' }],
            }],
            kernel: { layers: { a: { blendMode: 'overlay', opacity: 0.5 } } },
        }));

        expect(parsed.ok).toBe(false);
    });

    test('a missing position defaults rather than failing the document', () => {
        const parsed = parseScene(JSON.stringify({
            version: AUTHORED_SCENE_VERSION,
            entropy: 'x',
            nodes: [{ id: 'a', pluginId: 'src' }],
        }));

        expect(parsed.ok && parsed.scene.nodes[0].position).toEqual({ x: 0, y: 0 });
    });

    test('missing arrays read as empty rather than as an error', () => {
        const parsed = parseScene(JSON.stringify({ version: AUTHORED_SCENE_VERSION, entropy: 'x' }));

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.scene.nodes).toEqual([]);
        expect(parsed.scene.assetBindings).toEqual([]);
    });
});

describe('migration', () => {
    test('the current version passes straight through', () => {
        const raw = { version: AUTHORED_SCENE_VERSION, entropy: 'x' };

        expect(migrateScene(raw)).toEqual({ ok: true, raw });
    });

    test('a version with no migration is refused with which version it was', () => {
        const result = migrateScene({ version: 0, entropy: 'x' });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problem.detail).toContain('version 0');
    });
});

describe('fixtures', () => {
    const source_ = toFixtureSource(full(), { name: 'BLACK_FRAME', description: 'still resolves' });

    test('the emitted file names the constant and the test it was given', () => {
        expect(source_).toContain('const BLACK_FRAME: AuthoredScene = {');
        expect(source_).toContain("test('still resolves'");
    });

    test('it imports what it uses', () => {
        expect(source_).toContain("from './core/authored-scene'");
        expect(source_).toContain("from './plugins/registry'");
        expect(source_).toContain("from 'vitest'");
    });

    test('the literal is the document, and reading it back gives the document', () => {
        // The emitted source is TypeScript rather than JSON, so this checks the data survived the
        // rendering by parsing the object literal out of it.
        const literal = source_.slice(
            source_.indexOf('= {') + 2,
            source_.indexOf('\n\ndescribe('),
        ).trim().replace(/;$/, '');

        // Single quotes to double, and unquoted identifier keys to quoted, is enough to make the
        // emitted literal readable as JSON for this check.
        const asJson = literal
            .replace(/'/g, '"')
            .replace(/(\s)([A-Za-z_$][A-Za-z0-9_$]*):/g, '$1"$2":')
            .replace(/,(\s*[}\]])/g, '$1');

        expect(JSON.parse(asJson)).toEqual(JSON.parse(serializeScene(full())));
    });

    test('it uses the house style rather than JSON punctuation', () => {
        expect(source_).toContain("entropy: 'doc-entropy'");
        expect(source_).not.toContain('"entropy"');
        // A numeric pair reads better on one line than as four.
        expect(source_).toContain('outputRange: [0, 1]');
    });

    test('an id that is not an identifier is quoted', () => {
        // Instance ids carry a `#`, so every layer override key needs quoting.
        expect(source_).toContain("'trn#0': {");
    });

    test('a quote inside a string does not break the literal', () => {
        const emitted = toFixtureSource({
            ...emptyAuthoredScene("it's odd"),
        });

        expect(emitted).toContain("entropy: 'it\\'s odd'");
    });

    test('defaults are used when no name is given', () => {
        expect(toFixtureSource(emptyAuthoredScene('x'))).toContain('const SCENE: AuthoredScene');
    });
});
