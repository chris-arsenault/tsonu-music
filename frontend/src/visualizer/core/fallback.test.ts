import { describe, expect, test } from 'vitest';
import {
    ceilingFor,
    collectFaults,
    describeFault,
    describeTier,
    selectTier,
    tierNeedsAnalysis,
    tierNeedsGpu,
    tierRank,
    tierUsesScheduler,
    type FallbackTier,
    type FaultInputs,
    type VisualizerFault,
} from './fallback';

const ALL_TIERS: FallbackTier[] = ['full', 'reduced-graph', 'waveform', 'artwork', 'empty'];

/** Every fault listed in spec section 22, plus the two found in practice. */
const ALL_FAULTS: VisualizerFault[] = [
    'webgl-unavailable',
    'no-float-render-targets',
    'context-lost',
    'shader-failure',
    'analysis-blocked',
    'analysis-silent',
    'audio-context-suspended',
    'missing-assets',
    'unsupported-texture-format',
    'memory-pressure',
    'invalid-graph',
    'plugin-init-failure',
    'zero-sized-canvas',
    'performance-floor',
    'reduced-motion',
];

function inputs(overrides: Partial<FaultInputs> = {}): FaultInputs {
    return {
        webgl2Available: true,
        floatRenderTargets: true,
        contextLost: false,
        shaderErrorCount: 0,
        analysisFlatlined: false,
        audioContextState: 'running',
        graphValid: true,
        canvasWidth: 800,
        canvasHeight: 450,
        performanceSuspended: false,
        prefersReducedMotion: false,
        ...overrides,
    };
}

describe('tier ordering', () => {
    test('tiers descend from full to empty', () => {
        const ranks = ALL_TIERS.map(tierRank);

        expect(ranks).toEqual([0, 1, 2, 3, 4]);
    });

    test('each tier has a description', () => {
        const described = new Set(ALL_TIERS.map(describeTier));

        expect(described.size).toBe(ALL_TIERS.length);
    });

    test('only the plugin-graph tiers need webgl', () => {
        expect(tierNeedsGpu('full')).toBe(true);
        expect(tierNeedsGpu('reduced-graph')).toBe(true);
        // Drawn on a 2D context, which is why it outranks artwork.
        expect(tierNeedsGpu('waveform')).toBe(false);
        expect(tierNeedsGpu('artwork')).toBe(false);
        expect(tierNeedsGpu('empty')).toBe(false);
    });

    test('analysis is only needed by the plugin-graph tiers', () => {
        expect(tierNeedsAnalysis('full')).toBe(true);
        expect(tierNeedsAnalysis('reduced-graph')).toBe(true);
        // The waveform tier draws procedural motion without live features.
        expect(tierNeedsAnalysis('waveform')).toBe(false);
        expect(tierNeedsAnalysis('artwork')).toBe(false);
    });

    test('the scheduler only runs where a plugin graph exists', () => {
        expect(tierUsesScheduler('full')).toBe(true);
        expect(tierUsesScheduler('reduced-graph')).toBe(true);
        expect(tierUsesScheduler('waveform')).toBe(false);
        expect(tierUsesScheduler('empty')).toBe(false);
    });
});

describe('fault coverage', () => {
    test('every fault has a tier ceiling', () => {
        for (const fault of ALL_FAULTS) {
            expect(ALL_TIERS, fault).toContain(ceilingFor(fault));
        }
    });

    test('every fault has a description', () => {
        for (const fault of ALL_FAULTS) {
            expect(describeFault(fault).length, fault).toBeGreaterThan(0);
        }
    });

    test('no fault leaves the visualizer at full quality', () => {
        for (const fault of ALL_FAULTS) {
            expect(selectTier([fault]), fault).not.toBe('full');
        }
    });

    test('losing webgl never leaves a tier that needs it', () => {
        for (const fault of ['webgl-unavailable', 'no-float-render-targets', 'unsupported-texture-format', 'context-lost'] as VisualizerFault[]) {
            const tier = selectTier([fault]);
            expect(tierNeedsGpu(tier), fault).toBe(false);
            // Still shows something moving rather than dropping straight to a still image.
            expect(tier, fault).toBe('waveform');
        }
    });

    test('a zero-sized canvas drops below any drawing tier', () => {
        expect(selectTier(['zero-sized-canvas'])).toBe('artwork');
    });

    test('losing analysis keeps something rendering rather than dropping to artwork', () => {
        for (const fault of ['analysis-blocked', 'analysis-silent', 'audio-context-suspended'] as VisualizerFault[]) {
            expect(selectTier([fault]), fault).toBe('waveform');
        }
    });

    test('a shader or plugin failure only costs scene richness', () => {
        expect(selectTier(['shader-failure'])).toBe('reduced-graph');
        expect(selectTier(['plugin-init-failure'])).toBe('reduced-graph');
    });

    test('the performance floor renders nothing at all', () => {
        expect(selectTier(['performance-floor'])).toBe('empty');
    });
});

describe('tier selection', () => {
    test('no faults means the full graph', () => {
        expect(selectTier([])).toBe('full');
    });

    test('the most restrictive fault wins', () => {
        // Shader failure alone allows a reduced graph; losing WebGL is stricter.
        expect(selectTier(['shader-failure', 'webgl-unavailable'])).toBe('waveform');
        expect(selectTier(['webgl-unavailable', 'shader-failure'])).toBe('waveform');
        expect(selectTier(['webgl-unavailable', 'zero-sized-canvas'])).toBe('artwork');
    });

    test('order of faults does not matter', () => {
        const faults: VisualizerFault[] = ['analysis-silent', 'missing-assets', 'memory-pressure'];
        const reversed = [...faults].reverse();

        expect(selectTier(faults)).toBe(selectTier(reversed));
    });

    test('every fault at once still resolves to a tier', () => {
        expect(ALL_TIERS).toContain(selectTier(ALL_FAULTS));
    });

    test('duplicate faults are harmless', () => {
        expect(selectTier(['shader-failure', 'shader-failure'])).toBe('reduced-graph');
    });
});

describe('fault collection', () => {
    test('healthy state reports no faults', () => {
        expect(collectFaults(inputs())).toEqual([]);
        expect(selectTier(collectFaults(inputs()))).toBe('full');
    });

    test('missing webgl2 reports once, not twice', () => {
        const faults = collectFaults(inputs({ webgl2Available: false, floatRenderTargets: false }));

        expect(faults).toContain('webgl-unavailable');
        expect(faults).not.toContain('no-float-render-targets');
    });

    test('webgl2 without float targets is its own fault', () => {
        const faults = collectFaults(inputs({ floatRenderTargets: false }));

        expect(faults).toContain('no-float-render-targets');
    });

    test('a zero-sized canvas is detected in either dimension', () => {
        expect(collectFaults(inputs({ canvasWidth: 0 }))).toContain('zero-sized-canvas');
        expect(collectFaults(inputs({ canvasHeight: 0 }))).toContain('zero-sized-canvas');
    });

    test('a suspended context and a failed one are distinguished', () => {
        expect(collectFaults(inputs({ audioContextState: 'suspended' }))).toContain('audio-context-suspended');
        expect(collectFaults(inputs({ audioContextState: 'failed' }))).toContain('analysis-blocked');
        expect(collectFaults(inputs({ audioContextState: 'running' }))).not.toContain('analysis-blocked');
    });

    test('an interrupted context is treated like a suspended one', () => {
        // Safari raises this when another app takes the audio session; analysis stops either way.
        expect(collectFaults(inputs({ audioContextState: 'interrupted' }))).toContain('audio-context-suspended');
    });

    test('a closed context is a blocked analysis, not a recoverable suspension', () => {
        expect(collectFaults(inputs({ audioContextState: 'closed' }))).toContain('analysis-blocked');
    });

    test('a starting context is not yet a fault', () => {
        expect(collectFaults(inputs({ audioContextState: 'starting' }))).toEqual([]);
    });

    test('flatlined analysis is reported', () => {
        expect(collectFaults(inputs({ analysisFlatlined: true }))).toContain('analysis-silent');
    });

    test('shader errors are reported by count', () => {
        expect(collectFaults(inputs({ shaderErrorCount: 0 }))).not.toContain('shader-failure');
        expect(collectFaults(inputs({ shaderErrorCount: 3 }))).toContain('shader-failure');
    });

    test('an invalid graph is reported', () => {
        expect(collectFaults(inputs({ graphValid: false }))).toContain('invalid-graph');
    });

    test('reduced motion is a fault that only limits richness', () => {
        const faults = collectFaults(inputs({ prefersReducedMotion: true }));

        expect(faults).toEqual(['reduced-motion']);
        expect(selectTier(faults)).toBe('reduced-graph');
    });

    test('a suspended performance level renders nothing', () => {
        expect(selectTier(collectFaults(inputs({ performanceSuspended: true })))).toBe('empty');
    });

    test('the worst realistic case still resolves rather than throwing', () => {
        const faults = collectFaults(inputs({
            webgl2Available: false,
            floatRenderTargets: false,
            contextLost: true,
            shaderErrorCount: 5,
            analysisFlatlined: true,
            audioContextState: 'failed',
            graphValid: false,
            canvasWidth: 0,
            canvasHeight: 0,
            performanceSuspended: true,
            prefersReducedMotion: true,
        }));

        expect(faults.length).toBeGreaterThan(5);
        expect(selectTier(faults)).toBe('empty');
    });
});
