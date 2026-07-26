import { afterEach, describe, expect, test, vi } from 'vitest';
import { emptyAuthoredScene } from '../../core/authored-scene';
import { serializeScene } from '../../core/authored-scene-io';
import { copyGraph } from './scene-storage';

describe('copying a graph for analysis', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('writes the canonical graph JSON to the clipboard', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        const scene = emptyAuthoredScene('clipboard');

        await expect(copyGraph(scene)).resolves.toEqual({ where: 'clipboard' });
        expect(writeText).toHaveBeenCalledWith(serializeScene(scene));
    });

    test('returns the text for a manual-copy dialog when clipboard access fails', async () => {
        vi.stubGlobal('navigator', {
            clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
        });
        const scene = emptyAuthoredScene('manual');

        await expect(copyGraph(scene)).resolves.toEqual({
            where: 'manual',
            text: serializeScene(scene),
        });
    });
});
