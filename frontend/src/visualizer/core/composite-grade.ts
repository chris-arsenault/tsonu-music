/**
 * The compositor's own parameters, declared and bound exactly as a plugin's are.
 *
 * Colour and brightness at the composition boundary reached the shader as three features handed
 * straight to fixed coefficients — `rms` to a brightness term, `bass` to a wobble rate,
 * `spectralCentroid` to a hue offset. That is the most-seen transformation in the whole subsystem,
 * since it grades every layer of every scene, and it was the one thing that could not be
 * redistributed by role, could not use a rate or impulse binding, got none of the role dynamics, and
 * was identical in every scene.
 *
 * Two of those three features were level channels as well, which sit near the top of their range on
 * anything mastered — so the brightness term was close to a constant and the hue drift was carried by
 * the clock rather than by the music.
 *
 * Declaring them here means the composite goes through `resolveParameters` and `modulateParameters`
 * like everything else: same roles, same modes, same slow-big and fast-small dynamics.
 */

import type { ParameterBinding } from './bindings';

export const COMPOSITE_PARAMETERS: Readonly<Record<string, number>> = {
    /** Turns the scene's whole colour scheme rotates through, integrated. */
    hueDrift: 0,
    /** How far material is pulled toward its branch colour, against keeping its own. */
    tint: 0.8,
    /** Chroma multiplier at the grade. */
    saturation: 1.25,
    /** Output exposure, before the highlight roll-off. */
    exposure: 1.15,
    /** Above one, deepens the mid-tones. */
    contrast: 1.35,
};

/**
 * What drives them.
 *
 * `hueDrift` is a rate binding, so the scheme turns at a speed the music sets rather than at a fixed
 * one. Exposure answers to transients so the frame lifts on a hit. Saturation follows brightness,
 * which is where the ear expects colour to intensify.
 */
export const COMPOSITE_BINDINGS: readonly ParameterBinding[] = [
    {
        feature: 'mid',
        role: 'deformation',
        mode: 'rate',
        parameter: 'hueDrift',
        // Turns per second: a full rotation between roughly forty seconds and three minutes.
        outputRange: [0.006, 0.026],
        attack: 0.6,
        release: 2,
        curve: 'smooth',
        wrap: 1,
    },
    {
        feature: 'onset',
        role: 'burst',
        mode: 'impulse',
        parameter: 'exposure',
        outputRange: [1.05, 1.75],
        attack: 0.012,
        release: 0.3,
        curve: 'sqrt',
    },
    {
        feature: 'rmsExcite',
        role: 'intensity',
        parameter: 'saturation',
        outputRange: [1, 1.7],
        attack: 0.12,
        release: 0.7,
        curve: 'smooth',
    },
    {
        feature: 'spectralCentroid',
        role: 'complexity',
        parameter: 'tint',
        // Bright material keeps more of its own colour; dark material takes the scheme's.
        outputRange: [0.9, 0.55],
        attack: 0.4,
        release: 1.2,
        curve: 'smooth',
    },
    {
        feature: 'bassExcite',
        role: 'large-scale-force',
        parameter: 'contrast',
        outputRange: [1.5, 1.1],
        attack: 0.15,
        release: 0.8,
        curve: 'smooth',
    },
];
