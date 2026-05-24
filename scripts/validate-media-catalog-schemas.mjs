#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const schemaDir = join(root, 'schemas', 'media-catalog');

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function fail(message) {
    throw new Error(message);
}

function assert(condition, message) {
    if (!condition) {
        fail(message);
    }
}

function listJsonFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return listJsonFiles(path);
        }
        return entry.name.endsWith('.json') ? [path] : [];
    });
}

function walkSchemaRefs(value, visit, path = '$') {
    if (Array.isArray(value)) {
        value.forEach((item, index) => walkSchemaRefs(item, visit, `${path}[${index}]`));
        return;
    }

    if (!value || typeof value !== 'object') {
        return;
    }

    for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;
        if (key === '$ref') {
            visit(child, childPath);
        }
        walkSchemaRefs(child, visit, childPath);
    }
}

const schemaFiles = listJsonFiles(schemaDir);
const schemaFileNames = new Set(schemaFiles.map((schemaFile) => basename(schemaFile)));
const schemaIds = new Set();

assert(schemaFiles.length > 0, 'media catalog schema directory must contain JSON schemas');

for (const schemaFile of schemaFiles) {
    const schema = readJson(schemaFile);
    assert(schema.$schema, `${schemaFile} missing $schema`);
    assert(schema.$id, `${schemaFile} missing $id`);
    assert(!schemaIds.has(schema.$id), `${schemaFile} duplicates schema id ${schema.$id}`);
    schemaIds.add(schema.$id);

    walkSchemaRefs(schema, (ref, path) => {
        assert(typeof ref === 'string', `${schemaFile} ${path} must be a string`);
        if (ref.startsWith('#')) {
            return;
        }

        const [refFile] = ref.split('#');
        assert(schemaFileNames.has(refFile), `${schemaFile} ${path} references unknown schema file ${refFile}`);
    });
}

console.log(`Validated ${schemaFiles.length} media catalog schemas.`);
