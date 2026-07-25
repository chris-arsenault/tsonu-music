export type PlaybackEngine = 'pending' | 'native-hls' | 'hls-js' | 'unsupported';
export type BrowserFamily = 'chromium' | 'firefox' | 'safari' | 'other';

export interface BrowserPlatform {
    userAgent: string;
    platform: string;
    maxTouchPoints: number;
}

export interface PlaybackEngineSelection {
    nativeHlsSupported: boolean;
    browserFamily: BrowserFamily;
    visualizerRequested: boolean;
}

/**
 * iOS browsers all use WebKit, whatever their branded user agent says. Treat them as Safari for
 * playback policy so Chrome and Firefox on iOS never enter the desktop MSE visualizer path.
 */
export function classifyBrowser(browser: BrowserPlatform): BrowserFamily {
    const reportsIos = /\b(?:iPhone|iPad|iPod)\b/.test(browser.userAgent);
    const reportsMac = browser.platform.startsWith('Mac') || /\bMacintosh\b/.test(browser.userAgent);
    const isDesktopModeIpad = reportsMac && browser.maxTouchPoints > 1;
    if (reportsIos || isDesktopModeIpad) {
        return 'safari';
    }

    if (/\b(?:Firefox|FxiOS)\//.test(browser.userAgent)) {
        return 'firefox';
    }

    if (/\b(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|Vivaldi)\//.test(browser.userAgent)) {
        return 'chromium';
    }

    if (/\bSafari\//.test(browser.userAgent) && /\bAppleWebKit\//.test(browser.userAgent)) {
        return 'safari';
    }

    return 'other';
}

export function supportsHlsJsVisualizer(browserFamily: BrowserFamily): boolean {
    return browserFamily === 'chromium' || browserFamily === 'firefox';
}

/** Native fallback is unsafe once the lifetime media element may have acquired a Web Audio tap. */
export function canFallbackToNativeHls(
    nativeHlsSupported: boolean,
    visualizerHlsCommitted: boolean,
): boolean {
    return nativeHlsSupported && !visualizerHlsCommitted;
}

/**
 * Native HLS remains the default. Chromium and Firefox move to hls.js only when native playback
 * is unavailable or the listener explicitly opens the visualizer. Safari never selects hls.js.
 */
export function selectPreferredPlaybackEngine(selection: PlaybackEngineSelection): Exclude<PlaybackEngine, 'pending'> {
    if (
        selection.nativeHlsSupported
        && (!selection.visualizerRequested || !supportsHlsJsVisualizer(selection.browserFamily))
    ) {
        return 'native-hls';
    }

    return supportsHlsJsVisualizer(selection.browserFamily) ? 'hls-js' : 'unsupported';
}

export function currentBrowserPlatform(): BrowserPlatform {
    return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints,
    };
}
