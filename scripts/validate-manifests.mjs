#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const schemaDir = join(root, 'catalog', 'schemas');
const examplesDir = join(root, 'catalog', 'examples');

const stableIdPattern = /^(album|release|track|asset|job)_[a-z0-9][a-z0-9_-]{2,96}$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const publicSecretKeys = new Set(['sourceMaster', 'bucket', 'versionId', 'etag']);

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

function assertStableId(value, label) {
    assert(typeof value === 'string' && stableIdPattern.test(value), `${label} must be a stable ID`);
}

function assertSlug(value, label) {
    assert(typeof value === 'string' && slugPattern.test(value), `${label} must be a slug`);
}

function walkJson(value, visit, path = '$') {
    visit(value, path);

    if (Array.isArray(value)) {
        value.forEach((item, index) => walkJson(item, visit, `${path}[${index}]`));
        return;
    }

    if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            walkJson(child, visit, `${path}.${key}`);
        }
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

for (const schemaFile of listJsonFiles(schemaDir)) {
    const schema = readJson(schemaFile);
    assert(schema.$schema, `${schemaFile} missing $schema`);
    assert(schema.$id, `${schemaFile} missing $id`);
}

const publishedCatalog = readJson(join(examplesDir, 'published', 'catalog.json'));
assert(publishedCatalog.schemaVersion === 1, 'catalog schemaVersion must be 1');
assert(publishedCatalog.entityType === 'catalog', 'published catalog entityType must be catalog');
assert(Array.isArray(publishedCatalog.albums), 'published catalog albums must be an array');

const seenIds = new Set();

function rememberId(id, label) {
    assertStableId(id, label);
    assert(!seenIds.has(id), `${label} ${id} is duplicated`);
    seenIds.add(id);
}

for (const summary of publishedCatalog.albums) {
    rememberId(summary.albumId, 'catalog albumId');
    rememberId(summary.releaseId, 'catalog releaseId');
    assertSlug(summary.slug, `catalog album ${summary.albumId} slug`);
    assert(summary.status === 'published', `catalog album ${summary.albumId} must be published`);
    assert(summary.visibility === 'public' || summary.visibility === 'unlisted', `catalog album ${summary.albumId} visibility is invalid`);
    assert(typeof summary.manifestPath === 'string' && summary.manifestPath.startsWith('albums/'), `catalog album ${summary.albumId} manifestPath must point under albums/`);

    const manifest = readJson(join(examplesDir, 'published', summary.manifestPath));
    assert(manifest.entityType === 'album', `${summary.manifestPath} entityType must be album`);
    assert(manifest.albumId === summary.albumId, `${summary.manifestPath} albumId must match catalog`);
    assert(manifest.releaseId === summary.releaseId, `${summary.manifestPath} releaseId must match catalog`);
    assert(manifest.slug === summary.slug, `${summary.manifestPath} slug must match catalog`);
    assert(manifest.status === 'published', `${summary.manifestPath} must be published`);
    assert(manifest.tracks.length === summary.trackCount, `${summary.manifestPath} trackCount mismatch`);

    const totalDuration = manifest.tracks.reduce((sum, track) => sum + track.durationSeconds, 0);
    assert(Math.abs(totalDuration - summary.totalDurationSeconds) < 0.001, `${summary.manifestPath} total duration mismatch`);

    walkJson(manifest, (value, path) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const key of Object.keys(value)) {
                assert(!publicSecretKeys.has(key), `${summary.manifestPath} leaks private key ${path}.${key}`);
            }
        }
    });

    const sortedTracks = [...manifest.tracks].sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber);
    sortedTracks.forEach((track, index) => {
        assert(track === manifest.tracks[index], `${summary.manifestPath} tracks must be sorted by discNumber then trackNumber`);
        rememberId(track.trackId, `track ${track.title} trackId`);
        assertSlug(track.slug, `track ${track.trackId} slug`);
        assert(track.durationSeconds > 0, `track ${track.trackId} duration must be positive`);
        assert(track.playback?.hls?.path?.endsWith('.m3u8'), `track ${track.trackId} hls path must point to a playlist`);
        assert(Array.isArray(track.playback?.formats) && track.playback.formats.length > 0, `track ${track.trackId} must include playback formats`);

        for (const format of track.playback.formats) {
            rememberId(format.assetId, `track ${track.trackId} format assetId`);
            assert(['hls-rendition', 'direct', 'download'].includes(format.kind), `track ${track.trackId} format kind is invalid`);
            assert(['aac-192', 'aac-320', 'flac-lossless'].includes(format.quality), `track ${track.trackId} format quality is invalid`);
        }
    });
}

const draftAlbums = listJsonFiles(join(examplesDir, 'draft', 'albums')).map(readJson);
const draftTracks = new Map();

for (const draft of draftAlbums) {
    assert(draft.entityType === 'draftAlbum', `draft ${draft.albumId} entityType must be draftAlbum`);
    assertStableId(draft.albumId, 'draft albumId');
    assertStableId(draft.releaseId, 'draft releaseId');
    assertSlug(draft.slug, `draft ${draft.albumId} slug`);

    for (const track of draft.tracks) {
        assertStableId(track.trackId, `draft ${draft.albumId} trackId`);
        assert(track.sourceMaster?.bucket === 'tsonu-music-masters', `draft track ${track.trackId} must source from masters bucket`);
        assert(track.sourceMaster?.key?.startsWith(`masters/${draft.albumId}/${track.trackId}/`), `draft track ${track.trackId} source key must be namespaced by album and track`);
        draftTracks.set(track.trackId, { albumId: draft.albumId, track });
    }
}

for (const jobPath of listJsonFiles(join(examplesDir, 'draft', 'jobs'))) {
    const job = readJson(jobPath);
    assert(job.entityType === 'encodeJob', `${jobPath} entityType must be encodeJob`);
    assertStableId(job.jobId, `${jobPath} jobId`);
    const draftTrack = draftTracks.get(job.trackId);
    assert(draftTrack, `${jobPath} references unknown track ${job.trackId}`);
    assert(job.albumId === draftTrack.albumId, `${jobPath} albumId does not match draft track`);
    assert(job.input.bucket === 'tsonu-music-masters', `${jobPath} input bucket must be masters`);
    assert(job.output.bucket === 'tsonu-music-media', `${jobPath} output bucket must be media`);
}

console.log(`Validated ${listJsonFiles(schemaDir).length} schemas and catalog examples.`);
