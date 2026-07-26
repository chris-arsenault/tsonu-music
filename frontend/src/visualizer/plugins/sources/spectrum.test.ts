/**
 * The spectrum source's geometry against a spectrum on the bus's own scale.
 *
 * These exist because the source consumed raw FFT magnitude — median 7.7e-5 — while its gain was
 * bound over a range written for values near one. Half the contour's vertices sat within 0.4 percent
 * of the bottom edge and the radial mode drew a near-perfect circle, which is the thin line on black
 * that gets reported as "the visualizer is a static mess". Nothing in the type system distinguishes a
 * normalized array from a raw one, so the contract is asserted here.
 */

import { describe, expect, test } from 'vitest';
import { spectrumVertices } from './spectrum';

/** A plausible normalized spectrum: loud low end falling away, one bin at full scale. */
function spectrum(bins = 64): Float32Array {
    const values = new Float32Array(bins);
    for (let bin = 0; bin < bins; bin += 1) {
        values[bin] = Math.max(0.02, 1 / (1 + bin * 0.22));
    }

    return values;
}

function heights(mode: 'contour' | 'radial', gain: number): number[] {
    const source = spectrum();
    const vertices = new Float32Array(source.length * 3);
    const written = spectrumVertices(mode, source, gain, 0, vertices);

    const out: number[] = [];
    for (let index = 0; index < written; index += 1) {
        out.push(vertices[index * 3 + 1]);
    }

    return out;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

describe('spectrum geometry reaches the frame', () => {
    test('contour vertices are not all pinned to the bottom edge', () => {
        const y = heights('contour', 1.15);

        // Measured against the old raw-magnitude input, the median was -0.9933 on a usable range
        // running to 0.8 — half the vertices within 0.4 percent of the floor.
        expect(median(y)).toBeGreaterThan(-0.8);
        expect(Math.max(...y)).toBeGreaterThan(0);
    });

    test('the geometry spans a real fraction of the frame', () => {
        const y = heights('contour', 1.15);

        expect(Math.max(...y) - Math.min(...y)).toBeGreaterThan(0.5);
    });

    test('a quiet spectrum still draws low, so the gain has not simply been inflated', () => {
        const quiet = new Float32Array(64).fill(0.01);
        const vertices = new Float32Array(quiet.length * 3);
        const written = spectrumVertices('contour', quiet, 1.15, 0, vertices);

        const y: number[] = [];
        for (let index = 0; index < written; index += 1) {
            y.push(vertices[index * 3 + 1]);
        }

        expect(Math.max(...y)).toBeLessThan(-0.5);
    });
});
