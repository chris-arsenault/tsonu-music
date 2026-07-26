import { describe, expect, test } from 'vitest';
import { selectKernelInputs } from './kernel-inputs';

const available = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('kernel input selection', () => {
    test('an absent selection uses every compatible input', () => {
        expect(selectKernelInputs(available, undefined)).toEqual(available);
    });

    test('explicit membership retains graph order and ignores stale ids', () => {
        expect(selectKernelInputs(available, ['c', 'ghost', 'a'])).toEqual([
            { id: 'a' },
            { id: 'c' },
        ]);
    });

    test('an explicit empty selection disconnects every input', () => {
        expect(selectKernelInputs(available, [])).toEqual([]);
    });
});
