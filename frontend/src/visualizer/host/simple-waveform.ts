/**
 * The waveform fallback tier (spec section 22).
 *
 * Drawn on a 2D context so it survives everything the WebGL path can lose. When analysis is live it
 * draws the waveform; when it is not, it draws slow procedural motion instead, so the tier still shows
 * something rather than collapsing to a still image.
 */

import type { AudioFeatureBus } from '../core/features';

export interface SimpleWaveform {
    render(features: AudioFeatureBus, elapsedSeconds: number): void;
    resize(): void;
    dispose(): void;
}

/** Below this peak amplitude the waveform is treated as absent and procedural motion is drawn. */
const SILENCE_THRESHOLD = 1e-4;

export function createSimpleWaveform(canvas: HTMLCanvasElement): SimpleWaveform | undefined {
    const context = canvas.getContext('2d');
    if (!context) {
        return undefined;
    }

    function sizeCanvas(): void {
        // Capped at 1x here: this tier exists for constrained situations, so it should be cheap.
        const width = Math.max(1, canvas.clientWidth);
        const height = Math.max(1, canvas.clientHeight);

        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
    }

    sizeCanvas();

    return {
        render(features, elapsedSeconds) {
            sizeCanvas();

            const { width, height } = canvas;
            const middle = height / 2;

            context.clearRect(0, 0, width, height);
            context.lineWidth = 1.5;
            context.strokeStyle = 'rgba(212, 175, 55, 0.75)';
            context.beginPath();

            const waveform = features.waveform;
            const live = hasSignal(waveform);

            for (let x = 0; x < width; x += 1) {
                const t = width > 1 ? x / (width - 1) : 0;
                const amplitude = live
                    ? waveform[Math.min(waveform.length - 1, Math.floor(t * waveform.length))]
                    // Two detuned sines drift against each other, so the motion never obviously loops.
                    : Math.sin(t * 6 + elapsedSeconds * 0.7) * 0.25
                        + Math.sin(t * 11 - elapsedSeconds * 0.4) * 0.12;

                const y = middle - amplitude * middle * 0.85;
                if (x === 0) {
                    context.moveTo(x, y);
                } else {
                    context.lineTo(x, y);
                }
            }

            context.stroke();
        },

        resize() {
            sizeCanvas();
        },

        dispose() {
            context.clearRect(0, 0, canvas.width, canvas.height);
        },
    };
}

export function hasSignal(waveform: Float32Array): boolean {
    for (let index = 0; index < waveform.length; index += 1) {
        if (Math.abs(waveform[index]) > SILENCE_THRESHOLD) {
            return true;
        }
    }

    return false;
}
