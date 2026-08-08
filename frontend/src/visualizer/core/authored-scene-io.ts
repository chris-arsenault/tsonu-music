/**
 * Reading and writing scene documents.
 *
 * A document that can only live in memory is a debugging aid for the length of one session. Written
 * out, the same document is a repro: it survives a reload, travels to another machine, and pastes
 * into a test as the exact scene that misbehaved. That is the difference between finding a fault and
 * being able to hand it to someone.
 *
 * Everything arriving here is untrusted — a file from disk, a string from storage, a document written
 * against an older version of the format. It is validated field by field, and what fails is reported
 * against the node or edge that holds it rather than as a parse error about the whole file.
 */

import type { BindingCurve, BindingMode, BindingRole, ParameterBinding } from './bindings';
import {
    AUTHORED_SCENE_VERSION,
    type AuthoredAssetBinding,
    type AuthoredEdge,
    type AuthoredKernel,
    type AuthoredNode,
    type AuthoredProblem,
    type AuthoredScene,
} from './authored-scene';
import type { BlendMode } from './passes';
import type { LayerOverride } from './layers';

export type SceneParseResult =
    | { ok: true; scene: AuthoredScene; warnings: AuthoredProblem[] }
    | { ok: false; problems: AuthoredProblem[] };

const CURVES: readonly BindingCurve[] = ['linear', 'smooth', 'square', 'sqrt', 'exponential'];
const MODES: readonly BindingMode[] = ['value', 'rate', 'impulse'];
const ROLES: readonly BindingRole[] = [
    'intensity', 'large-scale-force', 'deformation', 'detail', 'burst',
    'repeating-motion', 'complexity', 'lateral-force',
];
const BLEND_MODES: readonly BlendMode[] = [
    'none', 'normal', 'add', 'screen', 'multiply', 'difference', 'lighten', 'darken',
];

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A document as text, with its keys in a fixed order.
 *
 * Canonical rather than whatever order the object happens to hold, so exporting the same scene twice
 * gives the same bytes and two committed documents can be diffed against each other. A round trip
 * through `parseScene` and back is byte-identical.
 */
export function serializeScene(scene: AuthoredScene): string {
    return `${JSON.stringify(canonicalScene(scene), undefined, 2)}\n`;
}

function canonicalScene(scene: AuthoredScene): Record<string, unknown> {
    return omitUndefined({
        version: scene.version,
        entropy: scene.entropy,
        themeId: scene.themeId,
        nodes: scene.nodes.map((node) => omitUndefined({
            id: node.id,
            pluginId: node.pluginId,
            position: { x: node.position.x, y: node.position.y },
            seed: node.seed,
            muted: node.muted,
            promoted: node.promoted && [...node.promoted],
            parameters: node.parameters && sortedNumbers(node.parameters),
            bindings: node.bindings?.map(canonicalBinding),
        })),
        edges: scene.edges.map((edge) => omitUndefined({
            id: edge.id,
            from: { node: edge.from.node, port: edge.from.port },
            to: { node: edge.to.node, port: edge.to.port },
            feedback: edge.feedback,
        })),
        assetBindings: scene.assetBindings.map((binding) => ({
            node: binding.node,
            port: binding.port,
            resource: binding.resource,
        })),
        present: scene.present && { node: scene.present.node, port: scene.present.port },
        kernel: scene.kernel && canonicalKernel(scene.kernel),
    });
}

function canonicalKernel(kernel: AuthoredKernel): Record<string, unknown> {
    return omitUndefined({
        compositeInputs: kernel.compositeInputs !== undefined ? [...kernel.compositeInputs] : undefined,
        grade: kernel.grade && omitUndefined({
            parameters: kernel.grade.parameters && sortedNumbers(kernel.grade.parameters),
            bindings: kernel.grade.bindings?.map(canonicalBinding),
        }),
        palette: kernel.palette && omitUndefined({
            id: kernel.palette.id,
            strength: kernel.palette.strength,
        }),
        layers: kernel.layers && Object.fromEntries(
            Object.keys(kernel.layers).sort().map((id) => [id, omitUndefined({
                blendMode: kernel.layers![id].blendMode,
                opacity: kernel.layers![id].opacity,
                feedbackParticipation: kernel.layers![id].feedbackParticipation,
            })]),
        ),
    });
}

function canonicalBinding(binding: ParameterBinding): Record<string, unknown> {
    return omitUndefined({
        feature: binding.feature,
        parameter: binding.parameter,
        mode: binding.mode,
        role: binding.role,
        inputRange: binding.inputRange && [...binding.inputRange],
        outputRange: [...binding.outputRange],
        attack: binding.attack,
        release: binding.release,
        curve: binding.curve,
        polarity: binding.polarity,
        wrap: binding.wrap,
    });
}

function sortedNumbers(values: Record<string, number>): Record<string, number> {
    return Object.fromEntries(Object.keys(values).sort().map((key) => [key, values[key]]));
}

function omitUndefined(record: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Brings a document written against an older format up to the current one.
 *
 * There is one version, so this does nothing yet — but a committed document outlives the code that
 * wrote it, and the moment the format changes the choice is between a migration and a pile of files
 * that no longer open. The table is here so adding a step is adding a line.
 */
const MIGRATIONS: Readonly<Record<number, (raw: Record<string, unknown>) => Record<string, unknown>>> = {};

export function migrateScene(
    raw: Record<string, unknown>,
): { ok: true; raw: Record<string, unknown> } | { ok: false; problem: AuthoredProblem } {
    let current = raw;

    for (let guard = 0; guard < 32; guard += 1) {
        const version = current.version;

        if (version === AUTHORED_SCENE_VERSION) {
            return { ok: true, raw: current };
        }

        if (typeof version !== 'number' || !Number.isInteger(version)) {
            return {
                ok: false,
                problem: { kind: 'version', detail: 'the document states no version' },
            };
        }

        const step = MIGRATIONS[version];
        if (!step) {
            return {
                ok: false,
                problem: {
                    kind: 'version',
                    detail: version > AUTHORED_SCENE_VERSION
                        ? `document version ${version} was written by a newer build`
                        : `no migration from document version ${version}`,
                },
            };
        }

        current = step(current);
    }

    return { ok: false, problem: { kind: 'version', detail: 'migrations did not converge' } };
}

/** Parses and validates a document. Structure only — the registry has its say in `resolveAuthoredScene`. */
export function parseScene(text: string): SceneParseResult {
    let raw: unknown;

    try {
        raw = JSON.parse(text);
    } catch (error) {
        return {
            ok: false,
            problems: [{
                kind: 'version',
                detail: `not valid JSON: ${error instanceof Error ? error.message : 'unknown'}`,
            }],
        };
    }

    if (!isRecord(raw)) {
        return { ok: false, problems: [{ kind: 'version', detail: 'the document is not an object' }] };
    }

    const migrated = migrateScene(raw);
    if (!migrated.ok) {
        return { ok: false, problems: [migrated.problem] };
    }

    return validateScene(migrated.raw);
}

function validateScene(raw: Record<string, unknown>): SceneParseResult {
    const problems: AuthoredProblem[] = [];
    const warnings: AuthoredProblem[] = [];

    const entropy = raw.entropy;
    if (typeof entropy !== 'string' || entropy === '') {
        problems.push({ kind: 'version', detail: 'entropy must be a non-empty string' });
    }

    const nodes: AuthoredNode[] = [];
    for (const [index, entry] of arrayAt(raw, 'nodes', problems).entries()) {
        const node = validateNode(entry, index, problems, warnings);
        if (node) {
            nodes.push(node);
        }
    }

    const known = new Set(nodes.map((node) => node.id));

    const edges: AuthoredEdge[] = [];
    for (const [index, entry] of arrayAt(raw, 'edges', problems).entries()) {
        const edge = validateEdge(entry, index, problems);
        if (edge) {
            edges.push(edge);
        }
    }

    const assetBindings: AuthoredAssetBinding[] = [];
    for (const [index, entry] of arrayAt(raw, 'assetBindings', problems).entries()) {
        if (!isRecord(entry)) {
            problems.push({ kind: 'dangling-edge', detail: `assetBindings[${index}] is not an object` });
            continue;
        }

        const node = stringAt(entry, 'node');
        const port = stringAt(entry, 'port');
        const resource = stringAt(entry, 'resource');

        if (!node || !port || !resource) {
            problems.push({
                kind: 'dangling-edge',
                detail: `assetBindings[${index}] needs node, port and resource`,
            });
            continue;
        }

        assetBindings.push({ node, port, resource });
    }

    // Reported here rather than left to the resolver, because a name that does not match anything in
    // the file is a problem with the file, not with the catalog.
    for (const edge of edges) {
        for (const end of [edge.from, edge.to]) {
            if (!known.has(end.node)) {
                problems.push({
                    kind: 'dangling-edge',
                    detail: `edge ${edge.id} names ${end.node}, which is not in the document`,
                    edgeId: edge.id,
                });
            }
        }
    }

    if (problems.length > 0) {
        return { ok: false, problems };
    }

    const present = isRecord(raw.present)
        ? { node: stringAt(raw.present, 'node') ?? '', port: stringAt(raw.present, 'port') ?? '' }
        : undefined;

    const scene: AuthoredScene = {
        version: AUTHORED_SCENE_VERSION,
        entropy: entropy as string,
        ...(typeof raw.themeId === 'string' ? { themeId: raw.themeId } : {}),
        nodes,
        edges,
        assetBindings,
        ...(present && present.node && present.port ? { present } : {}),
        ...(isRecord(raw.kernel) ? { kernel: validateKernel(raw.kernel, warnings) } : {}),
    };

    return { ok: true, scene, warnings };
}

function validateNode(
    entry: unknown,
    index: number,
    problems: AuthoredProblem[],
    warnings: AuthoredProblem[],
): AuthoredNode | undefined {
    if (!isRecord(entry)) {
        problems.push({ kind: 'unknown-plugin', detail: `nodes[${index}] is not an object` });
        return undefined;
    }

    const id = stringAt(entry, 'id');
    const pluginId = stringAt(entry, 'pluginId');

    if (!id || !pluginId) {
        problems.push({ kind: 'unknown-plugin', detail: `nodes[${index}] needs an id and a pluginId` });
        return undefined;
    }

    const position = isRecord(entry.position)
        ? {
            x: numberAt(entry.position, 'x') ?? 0,
            y: numberAt(entry.position, 'y') ?? 0,
        }
        : { x: 0, y: 0 };

    const node: AuthoredNode = { id, pluginId, position };

    const seed = numberAt(entry, 'seed');
    if (seed !== undefined) {
        node.seed = seed;
    }

    if (entry.muted === true) {
        node.muted = true;
    }

    if (Array.isArray(entry.promoted)) {
        const promoted = entry.promoted.filter((name): name is string => typeof name === 'string');
        if (promoted.length > 0) {
            node.promoted = promoted;
        }
    }

    if (entry.parameters !== undefined) {
        if (!isRecord(entry.parameters)) {
            problems.push({ kind: 'binding', detail: `${id}: parameters is not an object`, nodeId: id });
        } else {
            const parameters: Record<string, number> = {};
            for (const [name, value] of Object.entries(entry.parameters)) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    parameters[name] = value;
                } else {
                    // Dropped rather than passed on: a non-finite uniform blanks the frame, which
                    // looks exactly like the fault the document was saved to demonstrate.
                    warnings.push({
                        kind: 'binding',
                        detail: `${id}: parameter ${name} is not a finite number and was dropped`,
                        nodeId: id,
                    });
                }
            }
            node.parameters = parameters;
        }
    }

    if (entry.bindings !== undefined) {
        if (!Array.isArray(entry.bindings)) {
            problems.push({ kind: 'binding', detail: `${id}: bindings is not an array`, nodeId: id });
        } else {
            node.bindings = entry.bindings
                .map((candidate) => validateBinding(candidate, id, problems))
                .filter((binding): binding is ParameterBinding => binding !== undefined);
        }
    }

    return node;
}

function validateEdge(
    entry: unknown,
    index: number,
    problems: AuthoredProblem[],
): AuthoredEdge | undefined {
    if (!isRecord(entry)) {
        problems.push({ kind: 'dangling-edge', detail: `edges[${index}] is not an object` });
        return undefined;
    }

    const id = stringAt(entry, 'id');
    const from = endpointAt(entry.from);
    const to = endpointAt(entry.to);

    if (!id || !from || !to) {
        problems.push({ kind: 'dangling-edge', detail: `edges[${index}] needs an id, a from and a to` });
        return undefined;
    }

    return { id, from, to, ...(entry.feedback === true ? { feedback: true } : {}) };
}

function validateBinding(
    entry: unknown,
    nodeId: string,
    problems: AuthoredProblem[],
): ParameterBinding | undefined {
    if (!isRecord(entry)) {
        problems.push({ kind: 'binding', detail: `${nodeId}: a binding is not an object`, nodeId });
        return undefined;
    }

    const feature = stringAt(entry, 'feature');
    const parameter = stringAt(entry, 'parameter');
    const outputRange = rangeAt(entry.outputRange);
    const attack = numberAt(entry, 'attack');
    const release = numberAt(entry, 'release');
    const curve = CURVES.find((candidate) => candidate === entry.curve);

    if (!feature || !parameter || !outputRange || attack === undefined
        || release === undefined || !curve) {
        problems.push({
            kind: 'binding',
            detail: `${nodeId}: a binding is missing feature, parameter, outputRange, attack, release or curve`,
            nodeId,
        });
        return undefined;
    }

    const inputRange = rangeAt(entry.inputRange);
    const wrap = numberAt(entry, 'wrap');

    return {
        feature,
        parameter,
        outputRange,
        attack,
        release,
        curve,
        ...(MODES.find((candidate) => candidate === entry.mode)
            ? { mode: entry.mode as BindingMode }
            : {}),
        ...(ROLES.find((candidate) => candidate === entry.role)
            ? { role: entry.role as BindingRole }
            : {}),
        ...(inputRange ? { inputRange } : {}),
        ...(entry.polarity === -1 || entry.polarity === 1
            ? { polarity: entry.polarity as 1 | -1 }
            : {}),
        ...(wrap !== undefined ? { wrap } : {}),
    };
}

function validateKernel(raw: Record<string, unknown>, warnings: AuthoredProblem[]): AuthoredKernel {
    const kernel: AuthoredKernel = {};

    if (Array.isArray(raw.compositeInputs)) {
        kernel.compositeInputs = uniqueStrings(raw.compositeInputs);
    }

    if (isRecord(raw.grade)) {
        const parameters = isRecord(raw.grade.parameters)
            ? finiteNumbers(raw.grade.parameters)
            : undefined;
        const bindings = Array.isArray(raw.grade.bindings)
            ? raw.grade.bindings
                .map((candidate) => validateBinding(candidate, 'grade', warnings))
                .filter((binding): binding is ParameterBinding => binding !== undefined)
            : undefined;

        kernel.grade = { ...(parameters ? { parameters } : {}), ...(bindings ? { bindings } : {}) };
    }

    if (isRecord(raw.palette)) {
        const id = stringAt(raw.palette, 'id');
        const strength = numberAt(raw.palette, 'strength');
        kernel.palette = {
            ...(id ? { id } : {}),
            ...(strength !== undefined ? { strength } : {}),
        };
    }

    // `raw.persistence` is read past rather than rejected. It pinned the kernel accumulation, which no
    // longer exists (ADR-0013), and a document written before that is still a valid graph — refusing
    // to open one over a section that has no effect either way would lose the part that still works.

    if (isRecord(raw.layers)) {
        const layers: Record<string, LayerOverride> = {};

        for (const [id, value] of Object.entries(raw.layers)) {
            if (!isRecord(value)) {
                continue;
            }

            const blendMode = BLEND_MODES.find((candidate) => candidate === value.blendMode);
            const opacity = numberAt(value, 'opacity');
            const feedbackParticipation = numberAt(value, 'feedbackParticipation');

            layers[id] = {
                ...(blendMode ? { blendMode } : {}),
                ...(opacity !== undefined ? { opacity } : {}),
                ...(feedbackParticipation !== undefined ? { feedbackParticipation } : {}),
            };
        }

        kernel.layers = layers;
    }

    return kernel;
}

function uniqueStrings(values: readonly unknown[]): string[] {
    return [...new Set(values.filter((value): value is string =>
        typeof value === 'string' && value.length > 0))];
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

export interface FixtureOptions {
    /** The constant the document is bound to in the emitted file. */
    name?: string;
    /** What the emitted test is called. */
    description?: string;
}

/**
 * The document as a test file.
 *
 * The end of the loop this whole subsystem exists for: a fault found by watching becomes a scene that
 * reproduces it, and then a test that fails when it comes back. Emitting a whole file rather than a
 * bare literal means what is pasted already compiles and already asserts something.
 */
export function toFixtureSource(scene: AuthoredScene, options: FixtureOptions = {}): string {
    const name = options.name ?? 'SCENE';
    const description = options.description ?? 'the captured scene still resolves';

    return `/**
 * A captured visualizer scene, for regression.
 *
 * Written by the graph editor. Place this file under \`frontend/src/visualizer/\`; if it goes
 * somewhere else, adjust the two import paths below.
 */

import { describe, expect, test } from 'vitest';
import { resolveAuthoredScene, type AuthoredScene } from './core/authored-scene';
import { createM1Registry } from './plugins/registry';

const ${name}: AuthoredScene = ${literal(canonicalScene(scene), 0)};

describe('${escapeSingle(name)}', () => {
    test('${escapeSingle(description)}', () => {
        const resolved = resolveAuthoredScene(${name}, createM1Registry());

        expect(
            resolved.ok,
            resolved.ok ? '' : resolved.problems.map((problem) => problem.detail).join('; '),
        ).toBe(true);
    });
});
`;
}

/**
 * A value as TypeScript source.
 *
 * `JSON.stringify` would do for the data, but its output is not the house style and a fixture nobody
 * can read is a fixture nobody maintains: single quotes, unquoted keys where they are identifiers,
 * and four-space indentation, matching everything around it.
 */
function literal(value: unknown, depth: number): string {
    const pad = '    '.repeat(depth + 1);
    const closePad = '    '.repeat(depth);

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return '[]';
        }

        // A numeric pair — a range, a position — reads better on one line than as four.
        if (value.every((entry) => typeof entry === 'number')) {
            return `[${value.join(', ')}]`;
        }

        return `[\n${value.map((entry) => `${pad}${literal(entry, depth + 1)},`).join('\n')}\n${closePad}]`;
    }

    if (isRecord(value)) {
        const entries = Object.entries(value);
        if (entries.length === 0) {
            return '{}';
        }

        return `{\n${entries
            .map(([key, entry]) => `${pad}${propertyKey(key)}: ${literal(entry, depth + 1)},`)
            .join('\n')}\n${closePad}}`;
    }

    if (typeof value === 'string') {
        return `'${escapeSingle(value)}'`;
    }

    return String(value);
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propertyKey(key: string): string {
    return IDENTIFIER.test(key) ? key : `'${escapeSingle(key)}'`;
}

function escapeSingle(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

/* -------------------------------------------------------------------------- */
/* Field helpers                                                              */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rangeAt(value: unknown): [number, number] | undefined {
    if (!Array.isArray(value) || value.length !== 2) {
        return undefined;
    }

    const [low, high] = value;
    if (typeof low !== 'number' || typeof high !== 'number'
        || !Number.isFinite(low) || !Number.isFinite(high)) {
        return undefined;
    }

    return [low, high];
}

function endpointAt(value: unknown): { node: string; port: string } | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const node = stringAt(value, 'node');
    const port = stringAt(value, 'port');

    return node && port ? { node, port } : undefined;
}

function arrayAt(
    record: Record<string, unknown>,
    key: string,
    problems: AuthoredProblem[],
): unknown[] {
    const value = record[key];
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value)) {
        problems.push({ kind: 'version', detail: `${key} is not an array` });
        return [];
    }

    return value;
}

function finiteNumbers(
    record: Record<string, unknown>,
    keys?: readonly string[],
): Record<string, number> {
    const values: Record<string, number> = {};

    for (const key of keys ?? Object.keys(record)) {
        const value = numberAt(record, key);
        if (value !== undefined) {
            values[key] = value;
        }
    }

    return values;
}
