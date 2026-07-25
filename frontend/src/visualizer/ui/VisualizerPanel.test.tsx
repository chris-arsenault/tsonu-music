import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import VisualizerPanel from './VisualizerPanel';

vi.mock('../../music/MusicPlayerContext', () => ({
    useMusicPlayer: () => ({
        artworkAltText: 'Release artwork',
        artworkSrc: '/artwork.png',
        getAudioElement: () => null,
        getBufferHealth: () => ({}),
        selectedTrack: null,
    }),
}));

describe('VisualizerPanel', () => {
    test('offers a clickable artwork thumbnail before the listener opts in', () => {
        const html = renderToStaticMarkup(<VisualizerPanel />);

        expect(html).toContain('aria-label="Open visualizer"');
        expect(html).toContain('<img src="/artwork.png"');
        expect(html).not.toContain('disabled=""');
    });
});
