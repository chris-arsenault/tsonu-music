/**
 * Getting a scene document in and out of the browser.
 *
 * Thin: every decision about what a document *is* lives in `core/authored-scene-io.ts`, and this only
 * moves the text between there and the places a browser keeps things. Storage may be unavailable —
 * a private window, a blocked origin — and none of that is worth losing the editor over, so each
 * operation reports whether it worked rather than throwing.
 */

import { parseScene, serializeScene, toFixtureSource } from '../../core/authored-scene-io';
import type { AuthoredProblem, AuthoredScene } from '../../core/authored-scene';

const STORAGE_KEY = 'viz-editor-scene';

/** Reads the autosaved document, or nothing when there is none or it no longer parses. */
export function loadStoredScene(): AuthoredScene | undefined {
    try {
        const text = window.localStorage?.getItem(STORAGE_KEY);
        if (!text) {
            return undefined;
        }

        const parsed = parseScene(text);
        // A stored document written by an older build may no longer be readable. Dropping it quietly
        // is right: it is a convenience copy, and the alternative is an error on every open.
        return parsed.ok ? parsed.scene : undefined;
    } catch {
        return undefined;
    }
}

export function storeScene(scene: AuthoredScene | undefined): void {
    try {
        if (scene) {
            window.localStorage?.setItem(STORAGE_KEY, serializeScene(scene));
        } else {
            window.localStorage?.removeItem(STORAGE_KEY);
        }
    } catch {
        // Storage full or blocked. The document is still in memory and still rendering.
    }
}

/** Offers a document as a file. */
export function downloadScene(scene: AuthoredScene, filename = defaultFilename(scene)): void {
    download(serializeScene(scene), filename, 'application/json');
}

/** Offers the document as a test file, ready to paste into the repository. */
export function downloadFixture(scene: AuthoredScene, name = 'CAPTURED_SCENE'): void {
    download(
        toFixtureSource(scene, { name }),
        `${baseName(scene)}.fixture.test.ts`,
        'text/plain',
    );
}

/**
 * Puts the fixture on the clipboard, falling back to a download.
 *
 * Writing to the clipboard needs no permission prompt in current browsers, but it does need a secure
 * context and it can still be refused — and a refusal that silently does nothing is worse than a file
 * appearing in the downloads folder.
 */
export async function copyFixture(
    scene: AuthoredScene,
    name = 'CAPTURED_SCENE',
): Promise<'clipboard' | 'download'> {
    const source = toFixtureSource(scene, { name });

    try {
        await navigator.clipboard.writeText(source);
        return 'clipboard';
    } catch {
        downloadFixture(scene, name);
        return 'download';
    }
}

export type SceneFileResult =
    | { ok: true; scene: AuthoredScene; warnings: AuthoredProblem[] }
    | { ok: false; problems: AuthoredProblem[] };

/** Reads a document the user picked. */
export async function readSceneFile(file: File): Promise<SceneFileResult> {
    try {
        return parseScene(await file.text());
    } catch (error) {
        return {
            ok: false,
            problems: [{
                kind: 'version',
                detail: `could not read ${file.name}: ${error instanceof Error ? error.message : 'unknown'}`,
            }],
        };
    }
}

function baseName(scene: AuthoredScene): string {
    // The entropy identifies the scene and nothing else, which is exactly what a filename wants.
    return `scene-${scene.entropy.replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 48)}`;
}

function defaultFilename(scene: AuthoredScene): string {
    return `${baseName(scene)}.json`;
}

function download(text: string, filename: string, type: string): void {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = filename;
    anchor.click();

    URL.revokeObjectURL(url);
}
