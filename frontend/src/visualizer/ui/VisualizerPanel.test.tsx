import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import VisualizerPanel from './VisualizerPanel';

const useKernelReadoutMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock('../../music/MusicPlayerContext', () => ({
    useMusicPlayer: () => ({
        artworkAltText: 'Release artwork',
        artworkSrc: '/artwork.png',
        getAudioElement: () => null,
        getBufferHealth: () => ({}),
        playbackEngine: 'pending',
        prepareVisualizerPlayback: () => true,
        selectedTrack: null,
    }),
}));

vi.mock('./use-kernel-readout', () => ({
    useKernelReadout: useKernelReadoutMock,
}));

describe('VisualizerPanel', () => {
    beforeEach(() => {
        useKernelReadoutMock.mockReturnValue({});
    });

    test('offers a clickable artwork thumbnail before the listener opts in', () => {
        const html = renderToStaticMarkup(<VisualizerPanel />);

        expect(html).toContain('aria-label="Open visualizer"');
        expect(html).toContain('<img src="/artwork.png"');
        expect(html).not.toContain('disabled=""');
    });

    test('keeps the artwork control when the current engine is native HLS', () => {
        useKernelReadoutMock.mockReturnValue({
            availability: {
                available: false,
                reasons: ['native-hls-playback'],
                prefersReducedMotion: false,
            },
        });

        const html = renderToStaticMarkup(<VisualizerPanel />);

        expect(html).toContain('aria-label="Open visualizer availability details"');
        expect(html).toContain('<img src="/artwork.png"');
        expect(html).toContain('This browser plays HLS natively');
        expect(html).not.toContain('disabled=""');
    });
});
