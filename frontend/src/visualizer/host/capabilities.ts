/**
 * Availability gate (ADR-0001, ADR-0002).
 *
 * Resolved before any `AudioContext` or WebGL context is created. The point of gating ahead of the
 * tap rather than probing it is that `createMediaElementSource` cannot be undone: a probe that fails
 * has already rerouted the element's audio for the page's lifetime.
 */

const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';

export type UnavailableReason =
    | 'native-hls-playback'
    | 'no-webgl2'
    | 'no-float-render-targets'
    | 'no-audio-worklet';

export interface VisualizerAvailability {
    available: boolean;
    reasons: UnavailableReason[];
    /** True when the user prefers reduced motion. Selects a low-energy profile; not a block. */
    prefersReducedMotion: boolean;
}

/**
 * True when the browser decodes HLS natively, which is the branch the player takes in
 * `MusicPlayerContext` and where media-element analysis is unreliable.
 */
export function usesNativeHlsPlayback(element: Pick<HTMLMediaElement, 'canPlayType'>): boolean {
    return element.canPlayType(HLS_MIME_TYPE) !== '';
}

export function supportsAudioWorklet(): boolean {
    return typeof AudioWorkletNode !== 'undefined' && typeof AudioContext !== 'undefined';
}

export interface WebGl2Support {
    supported: boolean;
    floatRenderTargets: boolean;
}

/**
 * Probes WebGL2 and `EXT_color_buffer_float` on a throwaway canvas, releasing the context
 * immediately so the probe does not hold a GPU context open.
 */
export function probeWebGl2(): WebGl2Support {
    if (typeof document === 'undefined') {
        return { supported: false, floatRenderTargets: false };
    }

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;

    const gl = canvas.getContext('webgl2');
    if (!gl) {
        return { supported: false, floatRenderTargets: false };
    }

    const floatRenderTargets = gl.getExtension('EXT_color_buffer_float') !== null;
    gl.getExtension('WEBGL_lose_context')?.loseContext();

    return { supported: true, floatRenderTargets };
}

export function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false;
    }

    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function resolveAvailability(
    element: Pick<HTMLMediaElement, 'canPlayType'> | null,
): VisualizerAvailability {
    const reasons: UnavailableReason[] = [];

    if (element && usesNativeHlsPlayback(element)) {
        reasons.push('native-hls-playback');
    }

    if (!supportsAudioWorklet()) {
        reasons.push('no-audio-worklet');
    }

    const webgl = probeWebGl2();
    if (!webgl.supported) {
        reasons.push('no-webgl2');
    } else if (!webgl.floatRenderTargets) {
        reasons.push('no-float-render-targets');
    }

    return {
        available: reasons.length === 0,
        reasons,
        prefersReducedMotion: prefersReducedMotion(),
    };
}

export function describeUnavailableReason(reason: UnavailableReason): string {
    switch (reason) {
        case 'native-hls-playback':
            return 'This browser plays HLS natively, where audio analysis is unreliable.';
        case 'no-webgl2':
            return 'WebGL2 is unavailable.';
        case 'no-float-render-targets':
            return 'WebGL2 is available but floating-point render targets are not.';
        case 'no-audio-worklet':
            return 'AudioWorklet is unavailable.';
    }
}
