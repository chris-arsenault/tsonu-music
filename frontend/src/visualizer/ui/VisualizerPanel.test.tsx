import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import VisualizerPanel from './VisualizerPanel';

const useKernelReadoutMock = vi.hoisted(() => vi.fn(() => ({})));
const musicPlayerMock = vi.hoisted(() => ({
    artworkAltText: 'Release artwork',
    artworkSrc: '/artwork.png',
    getAudioElement: () => null,
    getBufferHealth: () => ({}),
    playbackEngine: 'pending',
    prepareVisualizerPlayback: () => true,
    selectedTrack: null,
    visualizerSupported: true,
}));

vi.mock('../../music/MusicPlayerContext', () => ({
    useMusicPlayer: () => musicPlayerMock,
}));

vi.mock('./use-kernel-readout', () => ({
    useKernelReadout: useKernelReadoutMock,
}));

describe('VisualizerPanel', () => {
    beforeEach(() => {
        useKernelReadoutMock.mockReturnValue({});
        musicPlayerMock.visualizerSupported = true;
    });

    test('offers one text launcher without another artwork thumbnail or checkbox', () => {
        const html = renderToStaticMarkup(<VisualizerPanel />);

        expect(html).toContain('>Open visualizer</button>');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('type="checkbox"');
    });

    test('keeps the launcher while eligible native HLS prepares its hls.js transition', () => {
        useKernelReadoutMock.mockReturnValue({
            availability: {
                available: false,
                reasons: ['native-hls-playback'],
                prefersReducedMotion: false,
            },
        });

        const html = renderToStaticMarkup(<VisualizerPanel />);

        expect(html).toContain('>Open visualizer</button>');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('type="checkbox"');
    });

    test('does not offer the visualizer on an unsupported browser', () => {
        musicPlayerMock.visualizerSupported = false;

        const html = renderToStaticMarkup(<VisualizerPanel />);

        expect(html).not.toContain('Open visualizer');
    });
});
