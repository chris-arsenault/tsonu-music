import { describe, expect, test } from 'vitest';
import {
    describeUnavailableReason,
    usesNativeHlsPlayback,
    type UnavailableReason,
} from './capabilities';

const ALL_REASONS: UnavailableReason[] = [
    'native-hls-playback',
    'no-webgl2',
    'no-float-render-targets',
    'no-audio-worklet',
];

describe('native HLS detection', () => {
    test('gates only the engine the player actually selected', () => {
        expect(usesNativeHlsPlayback('native-hls')).toBe(true);
        expect(usesNativeHlsPlayback('hls-js')).toBe(false);
        expect(usesNativeHlsPlayback('pending')).toBe(false);
        expect(usesNativeHlsPlayback('unsupported')).toBe(false);
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
