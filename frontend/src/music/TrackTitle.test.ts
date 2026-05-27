import { describe, expect, test } from 'vitest';
import { getTrackTitleLabel, getTrackTitleParts } from './TrackTitle';

describe('track title display', () => {
    test('uses the song title as the primary track title', () => {
        expect(getTrackTitleParts({
            title: 'Reign of the Simmered (Orchestral Edit)',
            songTitle: 'Reign of the Simmered',
            versionTitle: 'Orchestral Edit',
        })).toEqual({
            primary: 'Reign of the Simmered',
            alternate: 'Orchestral Edit',
        });
    });

    test('extracts a parenthetical alternate title when no version title is present', () => {
        expect(getTrackTitleParts({
            title: 'Reign of the Simmered (Orchestral Edit)',
            songTitle: 'Reign of the Simmered',
        })).toEqual({
            primary: 'Reign of the Simmered',
            alternate: 'Orchestral Edit',
        });
    });

    test('formats the accessible label with the alternate title', () => {
        expect(getTrackTitleLabel({
            title: 'Reign of the Simmered (Orchestral Edit)',
            songTitle: 'Reign of the Simmered',
            versionTitle: 'Orchestral Edit',
        })).toBe('Reign of the Simmered - Orchestral Edit');
    });
});
