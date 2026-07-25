/**
 * Beat-relative phase envelopes (spec section 7.2).
 *
 * Phase runs 0 at one detected beat to 1 at the next, so motion follows real tempo variation rather
 * than a fixed BPM. Every shape maps phase in [0, 1] to amplitude in [0, 1].
 */

export type EnvelopeShape =
    | 'linear'
    | 'triangle'
    | 'sine'
    | 'sawtooth'
    | 'square'
    | 'exponential-decay';

const EXPONENTIAL_DECAY_RATE = 5;

export function envelope(shape: EnvelopeShape, phase: number): number {
    const wrapped = wrapPhase(phase);

    switch (shape) {
        case 'linear':
            return wrapped;

        case 'triangle':
            return wrapped < 0.5 ? wrapped * 2 : (1 - wrapped) * 2;

        case 'sine':
            // Starts and ends at 0 with a single smooth peak at mid-phase.
            return 0.5 - 0.5 * Math.cos(2 * Math.PI * wrapped);

        case 'sawtooth':
            // Snaps to full on the beat and falls away linearly.
            return 1 - wrapped;

        case 'square':
            return wrapped < 0.5 ? 1 : 0;

        case 'exponential-decay':
            return Math.exp(-EXPONENTIAL_DECAY_RATE * wrapped);
    }
}

/** Maps any real phase into [0, 1). Guards against a NaN interval upstream. */
export function wrapPhase(phase: number): number {
    if (!Number.isFinite(phase)) {
        return 0;
    }

    const wrapped = phase % 1;
    return wrapped < 0 ? wrapped + 1 : wrapped;
}
