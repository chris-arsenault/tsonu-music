/**
 * Failure behaviour (spec section 22).
 *
 * Playback must remain functional if visualization fails, so every failure mode resolves to a tier
 * rather than to an error. The tiers descend from the full plugin graph to an empty background, and the
 * selection is pure so every listed failure mode can be shown to land somewhere.
 */

export type FallbackTier =
    | 'full'
    | 'reduced-graph'
    | 'waveform'
    | 'artwork'
    | 'empty';

/** Everything that can go wrong, from spec section 22 plus the ones found in practice. */
export type VisualizerFault =
    | 'webgl-unavailable'
    | 'no-float-render-targets'
    | 'context-lost'
    | 'shader-failure'
    | 'analysis-blocked'
    | 'analysis-silent'
    | 'audio-context-suspended'
    | 'missing-assets'
    | 'unsupported-texture-format'
    | 'memory-pressure'
    | 'invalid-graph'
    | 'plugin-init-failure'
    | 'zero-sized-canvas'
    | 'performance-floor'
    | 'reduced-motion';

const TIER_ORDER: readonly FallbackTier[] = ['full', 'reduced-graph', 'waveform', 'artwork', 'empty'];

/**
 * The best tier each fault still permits.
 *
 * A fault that only affects scene richness drops one step; one that removes GPU rendering entirely
 * drops to artwork. Losing analysis does not drop below the waveform tier, because non-reactive
 * procedural motion is still worth showing.
 */
const FAULT_CEILING: Record<VisualizerFault, FallbackTier> = {
    // No usable WebGL. The waveform tier draws on a 2D context, so it survives this.
    'webgl-unavailable': 'waveform',
    'no-float-render-targets': 'waveform',
    'unsupported-texture-format': 'waveform',
    'context-lost': 'waveform',

    // Nothing can be drawn at any size.
    'zero-sized-canvas': 'artwork',

    // GPU present but the scene cannot be trusted.
    'invalid-graph': 'waveform',
    'plugin-init-failure': 'reduced-graph',
    'shader-failure': 'reduced-graph',
    'memory-pressure': 'reduced-graph',

    // Analysis problems leave rendering intact but unreactive.
    'analysis-blocked': 'waveform',
    'analysis-silent': 'waveform',
    'audio-context-suspended': 'waveform',

    // Content and preference constraints.
    'missing-assets': 'reduced-graph',
    'performance-floor': 'empty',
    'reduced-motion': 'reduced-graph',
};

export function tierRank(tier: FallbackTier): number {
    return TIER_ORDER.indexOf(tier);
}

export function ceilingFor(fault: VisualizerFault): FallbackTier {
    return FAULT_CEILING[fault];
}

/**
 * The tier to render given the active faults. With none, the full graph runs; otherwise the most
 * restrictive ceiling wins, since a tier is only viable if every fault permits it.
 */
export function selectTier(faults: readonly VisualizerFault[]): FallbackTier {
    let selected: FallbackTier = 'full';

    for (const fault of faults) {
        const ceiling = ceilingFor(fault);
        if (tierRank(ceiling) > tierRank(selected)) {
            selected = ceiling;
        }
    }

    return selected;
}

/**
 * Whether a tier needs a WebGL context. The waveform tier deliberately does not: drawing it on a 2D
 * context is what lets it sit above artwork in the chain, so losing WebGL still leaves something moving.
 */
export function tierNeedsGpu(tier: FallbackTier): boolean {
    return tier === 'full' || tier === 'reduced-graph';
}

/** Whether a tier needs live audio features. */
export function tierNeedsAnalysis(tier: FallbackTier): boolean {
    return tier === 'full' || tier === 'reduced-graph';
}

/** Whether the plugin scheduler runs at this tier. */
export function tierUsesScheduler(tier: FallbackTier): boolean {
    return tier === 'full' || tier === 'reduced-graph';
}

export function describeTier(tier: FallbackTier): string {
    switch (tier) {
        case 'full':
            return 'Full visualizer';
        case 'reduced-graph':
            return 'Reduced visualizer';
        case 'waveform':
            return 'Simple waveform';
        case 'artwork':
            return 'Release artwork';
        case 'empty':
            return 'No visuals';
    }
}

export function describeFault(fault: VisualizerFault): string {
    switch (fault) {
        case 'webgl-unavailable':
            return 'WebGL2 is unavailable.';
        case 'no-float-render-targets':
            return 'Floating-point render targets are unavailable.';
        case 'context-lost':
            return 'The graphics context was lost.';
        case 'shader-failure':
            return 'One or more shaders failed to compile.';
        case 'analysis-blocked':
            return 'Audio analysis is blocked.';
        case 'analysis-silent':
            return 'Audio analysis is returning silence.';
        case 'audio-context-suspended':
            return 'The audio context is suspended.';
        case 'missing-assets':
            return 'Some visual assets are unavailable.';
        case 'unsupported-texture-format':
            return 'A required texture format is unsupported.';
        case 'memory-pressure':
            return 'Graphics memory is constrained.';
        case 'invalid-graph':
            return 'The scene graph failed validation.';
        case 'plugin-init-failure':
            return 'A plugin failed to initialize.';
        case 'zero-sized-canvas':
            return 'The canvas has no size.';
        case 'performance-floor':
            return 'Rendering is suspended to protect playback.';
        case 'reduced-motion':
            return 'Reduced motion is preferred.';
    }
}

/**
 * Collects faults from observable state. One place that decides what counts as a fault, so the UI does
 * not accumulate its own opinions about degradation.
 */
export interface FaultInputs {
    webgl2Available: boolean;
    floatRenderTargets: boolean;
    contextLost: boolean;
    shaderErrorCount: number;
    analysisFlatlined: boolean;
    /**
     * `AudioContextState` plus the two states the tap itself reports. `interrupted` is Safari's, raised
     * when another app takes the audio session; analysis stops there just as it does when suspended.
     */
    audioContextState: AudioContextState | 'starting' | 'failed';
    graphValid: boolean;
    canvasWidth: number;
    canvasHeight: number;
    performanceSuspended: boolean;
    prefersReducedMotion: boolean;
}

export function collectFaults(inputs: FaultInputs): VisualizerFault[] {
    const faults: VisualizerFault[] = [];

    if (!inputs.webgl2Available) {
        faults.push('webgl-unavailable');
    } else if (!inputs.floatRenderTargets) {
        faults.push('no-float-render-targets');
    }

    if (inputs.contextLost) {
        faults.push('context-lost');
    }

    if (inputs.shaderErrorCount > 0) {
        faults.push('shader-failure');
    }

    if (inputs.analysisFlatlined) {
        faults.push('analysis-silent');
    }

    if (inputs.audioContextState === 'suspended' || inputs.audioContextState === 'interrupted') {
        faults.push('audio-context-suspended');
    } else if (inputs.audioContextState === 'failed' || inputs.audioContextState === 'closed') {
        faults.push('analysis-blocked');
    }

    if (!inputs.graphValid) {
        faults.push('invalid-graph');
    }

    if (inputs.canvasWidth <= 0 || inputs.canvasHeight <= 0) {
        faults.push('zero-sized-canvas');
    }

    if (inputs.performanceSuspended) {
        faults.push('performance-floor');
    }

    if (inputs.prefersReducedMotion) {
        faults.push('reduced-motion');
    }

    return faults;
}
