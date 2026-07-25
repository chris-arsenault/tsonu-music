import { describe, expect, test } from 'vitest';
import {
    canFallbackToNativeHls,
    classifyBrowser,
    selectPreferredPlaybackEngine,
    supportsHlsJsVisualizer,
    type BrowserPlatform,
} from './playback-engine';

function browser(overrides: Partial<BrowserPlatform> = {}): BrowserPlatform {
    return {
        userAgent: 'Mozilla/5.0',
        platform: 'MacIntel',
        maxTouchPoints: 0,
        ...overrides,
    };
}

describe('browser classification', () => {
    test('recognizes Chrome, Edge, and Vivaldi as Chromium', () => {
        for (const userAgent of [
            'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36 Vivaldi/7.0',
        ]) {
            expect(classifyBrowser(browser({ userAgent }))).toBe('chromium');
        }
    });

    test('recognizes desktop Firefox', () => {
        expect(classifyBrowser(browser({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:147.0) Gecko/20100101 Firefox/147.0',
        }))).toBe('firefox');
    });

    test('recognizes desktop Safari', () => {
        expect(classifyBrowser(browser({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
        }))).toBe('safari');
    });

    test('treats every iOS browser as Safari policy', () => {
        expect(classifyBrowser(browser({
            platform: 'iPhone',
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/147.0 Mobile/15E148 Safari/604.1',
            maxTouchPoints: 5,
        }))).toBe('safari');
        expect(classifyBrowser(browser({
            platform: 'iPad',
            userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) FxiOS/147.0 Mobile/15E148 Safari/605.1.15',
            maxTouchPoints: 5,
        }))).toBe('safari');
    });

    test('recognizes an iPad requesting a desktop site', () => {
        expect(classifyBrowser(browser({
            platform: 'MacIntel',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
            maxTouchPoints: 5,
        }))).toBe('safari');
    });
});

describe('HLS engine policy', () => {
    test('keeps native HLS until an eligible listener requests the visualizer', () => {
        expect(selectPreferredPlaybackEngine({
            nativeHlsSupported: true,
            browserFamily: 'chromium',
            visualizerRequested: false,
        })).toBe('native-hls');
        expect(selectPreferredPlaybackEngine({
            nativeHlsSupported: true,
            browserFamily: 'firefox',
            visualizerRequested: false,
        })).toBe('native-hls');
    });

    test('switches Chromium and Firefox to hls.js for the visualizer', () => {
        for (const browserFamily of ['chromium', 'firefox'] as const) {
            expect(supportsHlsJsVisualizer(browserFamily)).toBe(true);
            expect(selectPreferredPlaybackEngine({
                nativeHlsSupported: true,
                browserFamily,
                visualizerRequested: true,
            })).toBe('hls-js');
        }
    });

    test('uses hls.js for Chromium and Firefox when native HLS is absent', () => {
        for (const browserFamily of ['chromium', 'firefox'] as const) {
            expect(selectPreferredPlaybackEngine({
                nativeHlsSupported: false,
                browserFamily,
                visualizerRequested: false,
            })).toBe('hls-js');
        }
    });

    test('keeps Safari native and never selects hls.js', () => {
        expect(supportsHlsJsVisualizer('safari')).toBe(false);
        expect(selectPreferredPlaybackEngine({
            nativeHlsSupported: true,
            browserFamily: 'safari',
            visualizerRequested: true,
        })).toBe('native-hls');
        expect(selectPreferredPlaybackEngine({
            nativeHlsSupported: false,
            browserFamily: 'safari',
            visualizerRequested: true,
        })).toBe('unsupported');
    });

    test('allows native fallback only before hls.js is exposed to the visualizer', () => {
        expect(canFallbackToNativeHls(true, false)).toBe(true);
        expect(canFallbackToNativeHls(true, true)).toBe(false);
        expect(canFallbackToNativeHls(false, false)).toBe(false);
    });
});
