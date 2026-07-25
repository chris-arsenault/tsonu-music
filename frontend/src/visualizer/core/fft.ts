/**
 * Minimal radix-2 FFT and Hann window.
 *
 * The analysis worklet runs on the audio render thread, where no `AnalyserNode` is available, so the
 * transform is first-party. Keeping it pure means it is testable against known signals in Node.
 */

/** Hann window of the given size. Precompute once; never allocate per frame. */
export function hannWindow(size: number): Float32Array {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i += 1) {
        window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return window;
}

/** Bit-reversal permutation table for the given power-of-two size. */
export function bitReversalTable(size: number): Uint32Array {
    const table = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i += 1) {
        let reversed = 0;
        for (let bit = 0; bit < bits; bit += 1) {
            reversed = (reversed << 1) | ((i >>> bit) & 1);
        }
        table[i] = reversed;
    }
    return table;
}

export function isPowerOfTwo(value: number): boolean {
    return value > 0 && (value & (value - 1)) === 0;
}

/**
 * In-place complex FFT. `real` and `imaginary` must be the same power-of-two length. `reversal` is
 * the table from `bitReversalTable` for that length.
 */
export function fftInPlace(
    real: Float32Array,
    imaginary: Float32Array,
    reversal: Uint32Array,
): void {
    const size = real.length;

    for (let i = 0; i < size; i += 1) {
        const j = reversal[i];
        if (j > i) {
            const tempReal = real[i];
            real[i] = real[j];
            real[j] = tempReal;

            const tempImaginary = imaginary[i];
            imaginary[i] = imaginary[j];
            imaginary[j] = tempImaginary;
        }
    }

    for (let span = 2; span <= size; span *= 2) {
        const half = span / 2;
        const angleStep = (-2 * Math.PI) / span;

        for (let start = 0; start < size; start += span) {
            for (let offset = 0; offset < half; offset += 1) {
                const angle = angleStep * offset;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);

                const evenIndex = start + offset;
                const oddIndex = evenIndex + half;

                const oddReal = real[oddIndex] * cos - imaginary[oddIndex] * sin;
                const oddImaginary = real[oddIndex] * sin + imaginary[oddIndex] * cos;

                real[oddIndex] = real[evenIndex] - oddReal;
                imaginary[oddIndex] = imaginary[evenIndex] - oddImaginary;
                real[evenIndex] += oddReal;
                imaginary[evenIndex] += oddImaginary;
            }
        }
    }
}

/**
 * Reusable FFT scratch space. Allocated once and reused every frame, since the worklet must not
 * allocate on the audio render thread.
 */
export interface SpectrumScratch {
    readonly size: number;
    readonly window: Float32Array;
    readonly reversal: Uint32Array;
    readonly real: Float32Array;
    readonly imaginary: Float32Array;
    /** Magnitude spectrum, length `size / 2`. */
    readonly magnitude: Float32Array;
}

export function createSpectrumScratch(size: number): SpectrumScratch {
    if (!isPowerOfTwo(size)) {
        throw new Error(`FFT size must be a power of two, received ${size}`);
    }

    return {
        size,
        window: hannWindow(size),
        reversal: bitReversalTable(size),
        real: new Float32Array(size),
        imaginary: new Float32Array(size),
        magnitude: new Float32Array(size / 2),
    };
}

/**
 * Windows `samples` into the scratch space, transforms it, and fills `scratch.magnitude`.
 * `samples` shorter than the scratch size is zero-padded; longer is truncated.
 */
export function computeMagnitudeSpectrum(scratch: SpectrumScratch, samples: Float32Array): void {
    const { size, window, real, imaginary, magnitude, reversal } = scratch;
    const usable = Math.min(size, samples.length);

    for (let i = 0; i < usable; i += 1) {
        real[i] = samples[i] * window[i];
        imaginary[i] = 0;
    }
    for (let i = usable; i < size; i += 1) {
        real[i] = 0;
        imaginary[i] = 0;
    }

    fftInPlace(real, imaginary, reversal);

    const scale = 2 / size;
    for (let bin = 0; bin < magnitude.length; bin += 1) {
        magnitude[bin] = Math.hypot(real[bin], imaginary[bin]) * scale;
    }
}

/** Centre frequency of a magnitude bin, in Hz. */
export function binFrequency(bin: number, fftSize: number, sampleRate: number): number {
    return (bin * sampleRate) / fftSize;
}
