import { describe, expect, test } from 'vitest';
import { assignInstanceIds, instanceIdFor, wireScene } from './wiring';
import { compileGraph } from './graph';
import {
    distributeReactivity,
    featureKind,
    peakConcentration,
    reactivitySpread,
    ROLE_FEATURES,
} from './audio-mapping';
import { createRng } from './random';
import type { PluginCategory, PluginPort, VisualPluginDefinition } from './plugin';

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

const colorIn: PluginPort = { name: 'source', type: 'color-texture', required: true };
// Declares what it does to the history it reads. Under ADR-0013 that number, not a capability
// string, is what makes a loop through this port legal: a cycle at unity gain grows without bound,
// so a scene of plugins that all pass their input through undiminished gets no loop at all.
const historyIn: PluginPort = {
    name: 'history',
    type: 'color-texture',
    required: false,
    gainParameter: 'historyWeight',
};

const source = plugin('src', 'source');
const transform = plugin('trn', 'transformer', [colorIn]);
const feedback = plugin('fbk', 'transformer', [colorIn, historyIn], undefined, {
    parameters: { historyWeight: 0.9 },
});
const post = plugin('post', 'postprocess', [colorIn]);

describe('scene wiring', () => {
    test('chains source into transformer into postprocess', () => {
        const wired = wireScene([post, transform, source]);

        expect(wired.nodes.map((node) => node.definition.id)).toEqual(['src', 'trn', 'post']);
        expect(wired.unsatisfied).toEqual([]);
        expect(wired.edges).toHaveLength(2);
    });

    test('the wired scene compiles', () => {
        const wired = wireScene([source, transform, post]);
        const result = compileGraph(wired.nodes, wired.edges, wired.present);

        expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    });

    test('chains transformers rather than running them in parallel', () => {
        const second = plugin('trn2', 'transformer', [colorIn]);
        const wired = wireScene([source, transform, second]);

        const intoSecond = wired.edges.find((edge) => edge.to.instanceId.startsWith('trn2'));
        // Takes the freshest colour output, which is the first transformer, not the source.
        expect(intoSecond?.from.instanceId).toBe(instanceIdFor(transform, 0));
    });

    test('a two-input compositor receives two distinct colour branches', () => {
        const secondSource = plugin('src-b', 'source');
        const mixer = plugin('mix', 'compositor', [
            { name: 'source', type: 'color-texture', required: true },
            { name: 'overlay', type: 'color-texture', required: true },
        ]);
        const wired = wireScene([source, secondSource, mixer]);
        const inputs = wired.edges
            .filter((edge) => edge.to.instanceId.startsWith('mix'))
            .map((edge) => `${edge.from.instanceId}.${edge.from.port}`);

        expect(wired.unsatisfied).toEqual([]);
        expect(inputs).toHaveLength(2);
        expect(new Set(inputs).size).toBe(2);
    });

    test('presents the last colour output in the chain', () => {
        const wired = wireScene([source, transform, post]);

        expect(wired.present?.instanceId).toBe(instanceIdFor(post, 0));
    });

    test('a plugin never consumes its own forward output', () => {
        const wired = wireScene([transform]);

        // Nothing upstream, so its required input is unsatisfied rather than self-connected.
        expect(wired.edges.filter((edge) => !edge.feedback)).toEqual([]);
        expect(wired.unsatisfied).toHaveLength(1);
    });

    test('reports unsatisfied required inputs instead of producing a broken graph', () => {
        const needsField = plugin('needy', 'simulator', [
            { name: 'flow', type: 'vector-field', required: true },
        ]);
        const wired = wireScene([source, needsField]);

        expect(wired.unsatisfied).toEqual([
            { instanceId: instanceIdFor(needsField, 0), port: 'flow', type: 'vector-field' },
        ]);
    });

    test('an optional unconnected input is not reported', () => {
        const optional = plugin('opt', 'transformer', [
            { name: 'mask', type: 'mask-texture', required: false },
        ]);
        const wired = wireScene([source, optional]);

        expect(wired.unsatisfied).toEqual([]);
    });

    test('a distance field satisfies a mask input', () => {
        const field = plugin('sdf', 'field', [], [{ name: 'sdf', type: 'distance-field', required: false }]);
        const masked = plugin('mask-user', 'transformer', [
            { name: 'mask', type: 'mask-texture', required: true },
        ]);
        const wired = wireScene([field, masked]);

        expect(wired.unsatisfied).toEqual([]);
        expect(wired.edges).toHaveLength(1);
    });

    test('a collision field supplies both generic force and boundary semantics', () => {
        const boundary = plugin(
            'boundary',
            'field',
            [],
            [{ name: 'deflection', type: 'collision-field', required: false }],
        );
        const particles = plugin('particles', 'simulator', [
            { name: 'force', type: 'vector-field', required: true },
            { name: 'boundary', type: 'collision-field', required: false },
        ]);
        const wired = wireScene([boundary, particles]);
        const inputs = wired.edges.filter((edge) => edge.to.instanceId.startsWith('particles'));

        expect(wired.unsatisfied).toEqual([]);
        expect(inputs.map((edge) => edge.to.port).sort()).toEqual(['boundary', 'force']);
        expect(new Set(inputs.map((edge) => edge.from.instanceId))).toEqual(
            new Set([instanceIdFor(boundary, 0)]),
        );
    });

    test('an empty scene wires to nothing rather than failing', () => {
        const wired = wireScene([]);

        expect(wired.nodes).toEqual([]);
        expect(wired.edges).toEqual([]);
        expect(wired.present).toBeUndefined();
    });

    test('instance ids are unique even for repeated plugin ids', () => {
        const wired = wireScene([source, plugin('src', 'source')]);
        const ids = wired.nodes.map((node) => node.instanceId);

        expect(new Set(ids).size).toBe(ids.length);
    });

    test('an added plugin does not renumber the ones already in the scene', () => {
        // Positional ids meant inserting anything gave every later node a different id, and
        // `instantiate` reuses an instance only when its id matches — so an incremental rebuild reset
        // the simulations it was supposed to preserve.
        const before = wireScene([source, transform, post]);
        const after = wireScene([source, transform, post, plugin('extra', 'field', [], [
            { name: 'flow', type: 'vector-field', required: false },
        ])]);

        const idFor = (wired: typeof before, definitionId: string) =>
            wired.nodes.find((node) => node.definition.id === definitionId)?.instanceId;

        for (const definitionId of ['src', 'trn', 'post']) {
            expect(idFor(after, definitionId), definitionId).toBe(idFor(before, definitionId));
        }
    });

    test('a repeated definition numbers by its own occurrence, not by scene position', () => {
        const wired = wireScene([source, transform, plugin('src', 'source')]);

        expect(wired.nodes.map((node) => node.instanceId).sort())
            .toEqual(['src#0', 'src#1', 'trn#0']);
    });
});

describe('feedback wiring', () => {
    test('a feedback transformer reads its own previous frame', () => {
        const wired = wireScene([source, feedback, post]);
        const loops = wired.edges.filter((edge) => edge.feedback);

        expect(loops).toHaveLength(1);
        expect(loops[0].from.instanceId).toBe(loops[0].to.instanceId);
        expect(loops[0].to.port).toBe('history');
    });

    test('the feedback scene compiles as a declared cycle', () => {
        const wired = wireScene([source, feedback, post]);
        const result = compileGraph(wired.nodes, wired.edges, wired.present);

        expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
        if (!result.ok) return;
        expect(result.graph.pingPong).toHaveLength(1);
    });

    test('its forward input still comes from upstream', () => {
        const wired = wireScene([source, feedback]);
        const forward = wired.edges.filter((edge) => !edge.feedback);

        expect(forward).toHaveLength(1);
        expect(forward[0].from.instanceId).toBe(instanceIdFor(source, 0));
        expect(forward[0].to.port).toBe('source');
    });

    test('the history port is not wired forward from an upstream producer', () => {
        const wired = wireScene([source, plugin('other', 'source'), feedback]);
        const intoHistory = wired.edges.filter((edge) => edge.to.port === 'history');

        expect(intoHistory).toHaveLength(1);
        expect(intoHistory[0].feedback).toBe(true);
    });

    test('a transformer without the feedback capability gets no loop', () => {
        const wired = wireScene([source, transform, post]);

        expect(wired.edges.filter((edge) => edge.feedback)).toEqual([]);
    });
});

/**
 * ADR-0012. The compiler, the render plan, and the pass executor always accepted a loop closed to
 * any resource; this file was the only thing insisting a plugin could read nothing but itself.
 */
describe('a loop may close to any producer', () => {
    const scene = [source, plugin('other', 'source'), feedback, post];

    test('without a draw, every loop still closes on its own plugin', () => {
        // Authored graphs and every wiring test state their edges rather than drawing them, so the
        // absent-rng path has to stay exactly what it was.
        const loops = wireScene(scene).edges.filter((edge) => edge.feedback);

        expect(loops).toHaveLength(1);
        expect(loops[0].from.instanceId).toBe(loops[0].to.instanceId);
    });

    test('a draw can point the loop at another node entirely', () => {
        const reached = new Set<string>();

        for (let seed = 0; seed < 40; seed += 1) {
            const wired = wireScene(scene, [], createRng(`loop-${seed}`));
            for (const edge of wired.edges.filter((entry) => entry.feedback)) {
                reached.add(edge.from.instanceId);
            }
        }

        expect(reached.size).toBeGreaterThan(1);
        expect([...reached]).toContain(instanceIdFor(feedback, 0));
    });

    test('every drawn loop still compiles as a declared cycle and asks for a second slot', () => {
        for (let seed = 0; seed < 40; seed += 1) {
            const wired = wireScene(scene, [], createRng(`loop-${seed}`));
            const result = compileGraph(wired.nodes, wired.edges, wired.present);

            expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
            if (!result.ok) continue;

            // Whichever resource the loop landed on is the one that gets ping-ponged, which the
            // compiler derives rather than being told.
            expect(result.graph.pingPong).toHaveLength(1);
        }
    });

    test('a loop reaching the composed image folds the whole picture back in', () => {
        // The configuration a tunnel comes from: a warp reading the scene's own composed output
        // rather than its own branch means a small per-frame displacement compounds over the whole
        // picture.
        //
        // The composed image, not the presented one. This asked for the loop to reach `post`, which
        // is a post-processing stage — and a loop through presentation applies the grade, the palette
        // map and the bloom once per circuit, which is destructive rather than accumulating. Measured
        // over 400 scenes, 42 percent of image cycles ran through one. The two are the same node in
        // this fixture only because the fixture is three plugins long.
        const composed = instanceIdFor(feedback, 0);
        const found = Array.from({ length: 40 }, (_, seed) =>
            wireScene(scene, [], createRng(`loop-${seed}`)).edges
                .filter((edge) => edge.feedback)
                .some((edge) => edge.from.instanceId === composed));

        expect(found.some(Boolean)).toBe(true);
    });

    test('no loop closes through a presentation stage', () => {
        for (let seed = 0; seed < 40; seed += 1) {
            const wired = wireScene(scene, [], createRng(`loop-${seed}`));
            const reaches = wired.edges
                .filter((edge) => edge.feedback)
                .map((edge) => edge.from.instanceId);

            expect(reaches, `seed ${seed}`).not.toContain(instanceIdFor(post, 0));
        }
    });
});

describe('reactivity distribution', () => {
    const binding = {
        feature: 'rms',
        parameter: 'amount',
        outputRange: [0, 1] as [number, number],
        attack: 0.1,
        release: 0.2,
        curve: 'linear' as const,
    };

    const withBindings = (id: string, category: PluginCategory) =>
        plugin(id, category, [], undefined, {
            parameters: { amount: 0 },
            defaultBindings: [binding],
        });

    /** Ids as wiring assigns them, so distribution is exercised over instances as it runs in a scene. */
    const nodes = (...definitions: VisualPluginDefinition[]) => assignInstanceIds(definitions);

    test('spreads reactivity instead of binding everything to one feature', () => {
        const plugins = [
            withBindings('a', 'source'),
            withBindings('b', 'field'),
            withBindings('c', 'transformer'),
            withBindings('d', 'postprocess'),
        ];

        const distributed = distributeReactivity(nodes(...plugins), createRng('spread'));

        // Four plugins that all defaulted to rms must not all still be on rms.
        expect(peakConcentration(distributed)).toBeLessThan(plugins.length);
        expect(reactivitySpread(distributed).size).toBeGreaterThan(1);
    });

    test('assignments stay inside the role the binding was authored for', () => {
        // `rms` implies the intensity role, so distribution may move it to another intensity feature
        // and to nothing else. Spreading reactivity must not change what a parameter means.
        for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
            const distributed = distributeReactivity(nodes(withBindings('f', 'field')), createRng(seed));
            const rewritten = distributed[0].bindings[0];

            expect(rewritten.role).toBe('intensity');
            expect(ROLE_FEATURES.intensity).toContain(rewritten.feature);
        }
    });

    test('a level binding is never rewritten onto an excitation channel, or the reverse', () => {
        // The two kinds have incompatible distributions — a level rides continuously around the
        // middle of its range, an excitation channel is a gate that spends most of its time at zero
        // and clears its headroom on any percussive hit. `inputRange`, `outputRange`, and `curve`
        // are authored against one or the other, and distribution rescales none of them, so a swap
        // across the boundary turns a smooth rider into a binary toggle.
        for (const role of ['large-scale-force', 'deformation', 'detail'] as const) {
            const levels = ROLE_FEATURES[role].filter((feature) => featureKind(feature) === 'level');
            const excited = ROLE_FEATURES[role].filter((feature) => featureKind(feature) === 'excitation');
            expect(levels.length, `${role} needs both kinds to make this test meaningful`).toBeGreaterThan(0);
            expect(excited.length).toBeGreaterThan(0);

            for (const authored of ROLE_FEATURES[role]) {
                for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
                    const subject = plugin('k', 'field', [], undefined, {
                        parameters: { amount: 0 },
                        defaultBindings: [{ ...binding, feature: authored, role }],
                    });
                    const rewritten = distributeReactivity(nodes(subject), createRng(seed))[0].bindings[0];

                    expect(featureKind(rewritten.feature)).toBe(featureKind(authored));
                }
            }
        }
    });

    test('a declared role outranks the feature it was authored against', () => {
        const declared = plugin('r', 'source', [], undefined, {
            parameters: { amount: 0 },
            defaultBindings: [{ ...binding, role: 'detail' as const }],
        });

        const rewritten = distributeReactivity(nodes(declared), createRng('declared'))[0].bindings[0];

        expect(ROLE_FEATURES.detail).toContain(rewritten.feature);
    });

    test('a feature outside the mapping table is left alone', () => {
        // Deliberate and specific. Guessing at a replacement is how a parameter loses its meaning.
        const exotic = plugin('x', 'source', [], undefined, {
            parameters: { amount: 0 },
            defaultBindings: [{ ...binding, feature: 'beatConfidence' }],
        });

        const distributed = distributeReactivity(nodes(exotic), createRng('exotic'));

        expect(distributed[0].bindings[0].feature).toBe('beatConfidence');
        expect(distributed[0].bindings[0].role).toBeUndefined();
    });

    test('an impulse binding stays on an event channel', () => {
        const impulse = plugin('i', 'postprocess', [], undefined, {
            parameters: { amount: 0 },
            defaultBindings: [{ ...binding, feature: 'onset', mode: 'impulse' as const }],
        });

        const distributed = distributeReactivity(nodes(impulse), createRng('impulse'));

        expect(['onset', 'beat']).toContain(distributed[0].bindings[0].feature);
    });

    test('stays stable within one scene build', () => {
        const plugins = [withBindings('a', 'source'), withBindings('b', 'field')];

        expect(distributeReactivity(nodes(...plugins), createRng('same')))
            .toEqual(distributeReactivity(nodes(...plugins), createRng('same')));
    });

    test('preserves everything about a binding except its feature', () => {
        const distributed = distributeReactivity(nodes(withBindings('a', 'source')), createRng('preserve'));
        const rewritten = distributed[0].bindings[0];

        expect(rewritten.parameter).toBe('amount');
        expect(rewritten.attack).toBe(0.1);
        expect(rewritten.release).toBe(0.2);
        expect(rewritten.curve).toBe('linear');
        expect(rewritten.outputRange).toEqual([0, 1]);
    });

    test('a plugin with no bindings gets none', () => {
        const distributed = distributeReactivity(nodes(plugin('bare', 'source')), createRng('bare'));

        expect(distributed[0].bindings).toEqual([]);
    });

    test('more plugins than features still avoids total concentration', () => {
        const many = Array.from({ length: 12 }, (_, index) => withBindings(`p${index}`, 'transformer'));
        const distributed = distributeReactivity(nodes(...many), createRng('crowded'));

        expect(peakConcentration(distributed)).toBeLessThan(many.length);
    });

    test('an empty scene distributes nothing', () => {
        expect(distributeReactivity([], createRng('empty'))).toEqual([]);
        expect(peakConcentration([])).toBe(0);
    });

    test('two instances of one definition are assigned separately', () => {
        // Keyed by definition there was one entry for both, so they bound the same parameter to the
        // same feature and moved as one object — and nothing downstream could tell them apart.
        const twice = nodes(withBindings('same', 'source'), withBindings('same', 'source'));
        const distributed = distributeReactivity(twice, createRng('twins'));

        expect(distributed).toHaveLength(2);
        expect(distributed.map((entry) => entry.instanceId)).toEqual(['same#0', 'same#1']);
        expect(distributed[0].bindings[0].feature).not.toBe(distributed[1].bindings[0].feature);
    });
});
