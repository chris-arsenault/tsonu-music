import { describe, expect, test } from 'vitest';
import {
    describeUnavailableReason,
    usesNativeHlsPlayback,
    type UnavailableReason,
} from './capabilities';

/** Stands in for a media element's `canPlayType`, which is the whole gate predicate. */
function element(hlsSupport: '' | 'maybe' | 'probably') {
    return { canPlayType: () => hlsSupport } as Pick<HTMLMediaElement, 'canPlayType'>;
}

const ALL_REASONS: UnavailableReason[] = [
    'native-hls-playback',
    'no-webgl2',
    'no-float-render-targets',
    'no-audio-worklet',
];

describe('native HLS detection', () => {
    test('an empty support string means hls.js drives playback', () => {
        expect(usesNativeHlsPlayback(element(''))).toBe(false);
    });

    test('both non-empty support values mean the native path is taken', () => {
        // Safari answers "maybe" and iOS "probably"; the player's own branch treats any non-empty
        // string as native support, so the gate must agree.
        expect(usesNativeHlsPlayback(element('maybe'))).toBe(true);
        expect(usesNativeHlsPlayback(element('probably'))).toBe(true);
    });
});

describe('unavailable reasons', () => {
    test('every reason has a description', () => {
        for (const reason of ALL_REASONS) {
            const description = describeUnavailableReason(reason);
            expect(description.length).toBeGreaterThan(0);
        }
    });

    test('descriptions are distinct so a reader can tell them apart', () => {
        const described = new Set(ALL_REASONS.map(describeUnavailableReason));
        expect(described.size).toBe(ALL_REASONS.length);
    });
});
