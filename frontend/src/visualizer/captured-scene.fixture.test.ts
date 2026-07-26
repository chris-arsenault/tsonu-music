/**
 * A captured visualizer scene, for regression.
 *
 * Written by the graph editor. Place this file under `frontend/src/visualizer/`; if it goes
 * somewhere else, adjust the two import paths below.
 */

import { describe, expect, test } from 'vitest';
import { resolveAuthoredScene, type AuthoredScene } from './core/authored-scene';
import { createM1Registry } from './plugins/registry';

const CAPTURED_SCENE: AuthoredScene = {
    version: 1,
    entropy: 'fixture-seed:candidate:0',
    themeId: 'geometric-signal',
    nodes: [
        {
            id: 'SignalTraceSource:filament#0',
            pluginId: 'SignalTraceSource:filament',
            position: {
                x: 0,
                y: 0,
            },
            parameters: {
                amplitude: 0.6,
                brightness: 1.4,
                thickness: 2,
            },
            bindings: [
                {
                    feature: 'rmsExcite',
                    parameter: 'thickness',
                    role: 'intensity',
                    outputRange: [1.2, 3.8],
                    attack: 0.06,
                    release: 0.4,
                    curve: 'sqrt',
                },
                {
                    feature: 'peak',
                    parameter: 'amplitude',
                    role: 'intensity',
                    outputRange: [0.15, 0.85],
                    attack: 0.05,
                    release: 0.25,
                    curve: 'sqrt',
                },
                {
                    feature: 'treble',
                    parameter: 'brightness',
                    role: 'detail',
                    outputRange: [0.9, 2.2],
                    attack: 0.02,
                    release: 0.3,
                    curve: 'linear',
                },
            ],
        },
        {
            id: 'SignalTraceSource:radial-petals#0',
            pluginId: 'SignalTraceSource:radial-petals',
            position: {
                x: 0,
                y: 190,
            },
            parameters: {
                amplitude: 0.6,
                brightness: 1.4,
                thickness: 2,
            },
            bindings: [
                {
                    feature: 'rmsExcite',
                    parameter: 'thickness',
                    role: 'intensity',
                    outputRange: [1.2, 3.8],
                    attack: 0.06,
                    release: 0.4,
                    curve: 'sqrt',
                },
                {
                    feature: 'rms',
                    parameter: 'amplitude',
                    role: 'intensity',
                    outputRange: [0.15, 0.85],
                    attack: 0.05,
                    release: 0.25,
                    curve: 'sqrt',
                },
                {
                    feature: 'transient',
                    parameter: 'brightness',
                    role: 'detail',
                    outputRange: [0.9, 2.2],
                    attack: 0.02,
                    release: 0.3,
                    curve: 'linear',
                },
            ],
        },
        {
            id: 'TilingTransform:brick#0',
            pluginId: 'TilingTransform:brick',
            position: {
                x: 320,
                y: 0,
            },
            parameters: {
                repeat: 3,
            },
            bindings: [
                {
                    feature: 'mid',
                    parameter: 'repeat',
                    role: 'deformation',
                    outputRange: [2, 6],
                    attack: 0.6,
                    release: 1.5,
                    curve: 'smooth',
                },
            ],
        },
        {
            id: 'FeedbackFlowTransform:rotate#0',
            pluginId: 'FeedbackFlowTransform:rotate',
            position: {
                x: 640,
                y: 0,
            },
            parameters: {
                decay: 0.94,
                rotation: 0.15,
                strength: 0.02,
            },
            bindings: [
                {
                    feature: 'subBass',
                    parameter: 'strength',
                    role: 'large-scale-force',
                    outputRange: [0.004, 0.05],
                    attack: 0.08,
                    release: 0.4,
                    curve: 'smooth',
                },
                {
                    feature: 'rms',
                    parameter: 'decay',
                    role: 'intensity',
                    outputRange: [0.9, 0.985],
                    attack: 0.25,
                    release: 0.9,
                    curve: 'smooth',
                },
                {
                    feature: 'lowMid',
                    parameter: 'rotation',
                    role: 'deformation',
                    outputRange: [0.04, 0.55],
                    attack: 0.3,
                    release: 1,
                    curve: 'smooth',
                },
            ],
        },
        {
            id: 'LayerMixer:contrast#0',
            pluginId: 'LayerMixer:contrast',
            position: {
                x: 960,
                y: 0,
            },
            parameters: {
                mix: 1,
            },
            bindings: [
                {
                    feature: 'peak',
                    parameter: 'mix',
                    role: 'intensity',
                    outputRange: [0.45, 1],
                    attack: 0.15,
                    release: 0.6,
                    curve: 'smooth',
                },
            ],
        },
        {
            id: 'ColorTransform:solarize#0',
            pluginId: 'ColorTransform:solarize',
            position: {
                x: 1280,
                y: 0,
            },
            parameters: {
                amount: 0.42,
            },
            bindings: [
                {
                    feature: 'highMid',
                    parameter: 'amount',
                    role: 'detail',
                    outputRange: [0.06999999999999999, 0.5599999999999999],
                    attack: 0.15,
                    release: 0.6,
                    curve: 'smooth',
                },
            ],
        },
        {
            id: 'GlowAndScatter:edge-glow#0',
            pluginId: 'GlowAndScatter:edge-glow',
            position: {
                x: 1600,
                y: 0,
            },
            parameters: {
                amount: 0.8,
                threshold: 0.55,
            },
            bindings: [
                {
                    feature: 'onset',
                    parameter: 'amount',
                    mode: 'impulse',
                    role: 'burst',
                    outputRange: [0.3, 1.6],
                    attack: 0.015,
                    release: 0.32,
                    curve: 'sqrt',
                },
                {
                    feature: 'highMidExcite',
                    parameter: 'threshold',
                    role: 'detail',
                    outputRange: [0.62, 0.34],
                    attack: 0.08,
                    release: 0.5,
                    curve: 'smooth',
                },
            ],
        },
        {
            id: 'ToneMapper#0',
            pluginId: 'ToneMapper',
            position: {
                x: 1920,
                y: 0,
            },
            parameters: {
                blackLevel: 0.002,
                exposure: 1.1,
                gamma: 1,
                grain: 0.006,
            },
            bindings: [],
        },
    ],
    edges: [
        {
            id: 'SignalTraceSource:radial-petals#0.color->TilingTransform:brick#0.source',
            from: {
                node: 'SignalTraceSource:radial-petals#0',
                port: 'color',
            },
            to: {
                node: 'TilingTransform:brick#0',
                port: 'source',
            },
        },
        {
            id: 'TilingTransform:brick#0.color->FeedbackFlowTransform:rotate#0.source',
            from: {
                node: 'TilingTransform:brick#0',
                port: 'color',
            },
            to: {
                node: 'FeedbackFlowTransform:rotate#0',
                port: 'source',
            },
        },
        {
            id: 'FeedbackFlowTransform:rotate#0.color->FeedbackFlowTransform:rotate#0.history:feedback',
            from: {
                node: 'FeedbackFlowTransform:rotate#0',
                port: 'color',
            },
            to: {
                node: 'FeedbackFlowTransform:rotate#0',
                port: 'history',
            },
            feedback: true,
        },
        {
            id: 'FeedbackFlowTransform:rotate#0.color->LayerMixer:contrast#0.source',
            from: {
                node: 'FeedbackFlowTransform:rotate#0',
                port: 'color',
            },
            to: {
                node: 'LayerMixer:contrast#0',
                port: 'source',
            },
        },
        {
            id: 'TilingTransform:brick#0.color->LayerMixer:contrast#0.overlay',
            from: {
                node: 'TilingTransform:brick#0',
                port: 'color',
            },
            to: {
                node: 'LayerMixer:contrast#0',
                port: 'overlay',
            },
        },
        {
            id: 'LayerMixer:contrast#0.color->ColorTransform:solarize#0.source',
            from: {
                node: 'LayerMixer:contrast#0',
                port: 'color',
            },
            to: {
                node: 'ColorTransform:solarize#0',
                port: 'source',
            },
        },
        {
            id: 'ColorTransform:solarize#0.color->GlowAndScatter:edge-glow#0.source',
            from: {
                node: 'ColorTransform:solarize#0',
                port: 'color',
            },
            to: {
                node: 'GlowAndScatter:edge-glow#0',
                port: 'source',
            },
        },
        {
            id: 'GlowAndScatter:edge-glow#0.color->ToneMapper#0.source',
            from: {
                node: 'GlowAndScatter:edge-glow#0',
                port: 'color',
            },
            to: {
                node: 'ToneMapper#0',
                port: 'source',
            },
        },
    ],
    assetBindings: [],
    present: {
        node: 'ToneMapper#0',
        port: 'color',
    },
};

describe('CAPTURED_SCENE', () => {
    test('the captured scene resolves against the live catalog', () => {
        const resolved = resolveAuthoredScene(CAPTURED_SCENE, createM1Registry());

        expect(
            resolved.ok,
            resolved.ok ? '' : resolved.problems.map((problem) => problem.detail).join('; '),
        ).toBe(true);
    });
});
