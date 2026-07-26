/**
 * Diagnostics model (spec section 23).
 *
 * The overlay's data shape and its control state, kept pure so what the overlay claims can be tested
 * without a browser. The controls exist because most section 26 acceptance criteria are only checkable
 * with them: disabling one plugin, freezing mutation while audio continues, and inspecting an
 * intermediate target.
 */

export interface DiagnosticsControls {
    /** Holds the scheduler still, so a scene can be studied without it mutating underneath. */
    freezeMutations: boolean;
    /**
     * Freezes simulation while audio keeps playing. Distinct from a paused clock: this isolates whether
     * a visual problem comes from the simulation or from the features driving it.
     */
    freezeSimulation: boolean;
    /** Plugin instance ids excluded from the graph. */
    disabledPlugins: readonly string[];
    /** Intermediate resource displayed instead of the composed output. */
    inspectResource?: string;
    /**
     * A document is in control of the graph.
     *
     * Holds the scene still in every way the scheduler and the ladder would otherwise move it: no
     * mutation, no rebuild when the track changes, and no quality suppression. The last of those is
     * the important one — the ladder drops whole plugins at level five and above, so a scene under
     * study would lose the very node being examined the moment frame time slipped, and nothing on
     * screen would say so.
     */
    authoring: boolean;
}

export function createDiagnosticsControls(): DiagnosticsControls {
    return {
        freezeMutations: false,
        freezeSimulation: false,
        disabledPlugins: [],
        authoring: false,
    };
}

export function togglePluginDisabled(
    controls: DiagnosticsControls,
    instanceId: string,
): DiagnosticsControls {
    const disabled = controls.disabledPlugins.includes(instanceId)
        ? controls.disabledPlugins.filter((id) => id !== instanceId)
        : [...controls.disabledPlugins, instanceId];

    return { ...controls, disabledPlugins: disabled };
}

/**
 * Effective delta for the simulation, given the controls.
 *
 * Freezing simulation passes zero exactly as a frozen clock does, so every plugin already handles it —
 * no plugin needs to know the diagnostics overlay exists.
 */
export function simulationDelta(controls: DiagnosticsControls, deltaSeconds: number): number {
    return controls.freezeSimulation ? 0 : deltaSeconds;
}

export function isPluginDisabled(controls: DiagnosticsControls, instanceId: string): boolean {
    return controls.disabledPlugins.includes(instanceId);
}

/** Everything the overlay reports (spec section 23). */
export interface DiagnosticsSnapshot {
    playback: {
        state: string;
        generation: number;
        playbackTime: number;
        duration: number;
        frozen: boolean;
    };
    audio: {
        contextState: string;
        outputLatencyMs: number;
        flatlined: boolean;
    };
    features: {
        normalized: Readonly<Record<string, number>>;
        onsetCount: number;
        beatCount: number;
        beatConfidence: number;
        beatPhase: number;
    };
    scene: {
        themeId: string;
        pluginIds: readonly string[];
        /** Every graph edge as `from -> to`, for reading the structure at a glance. */
        edges: readonly string[];
        assignedAssets: readonly string[];
        /** Instance ids in activation order, newest last. */
        activationHistory: readonly string[];
    };
    performance: {
        level: number;
        renderScale: number;
        frameTimeMs: number;
        passesExecuted: number;
        targetsAllocated: number;
        estimatedTextureBytes: number;
        downgrades: number;
        bufferConstrained: boolean;
        suspended: boolean;
    };
    gpu: {
        floatRenderTargets: boolean;
        maxTextureSize: number;
        maxPixelRatio: number;
        renderWidth: number;
        renderHeight: number;
    };
    /** Shader compile and link failures, empty when everything compiled. */
    shaderErrors: readonly string[];
    /** Active faults and the resulting fallback tier. */
    faults: readonly string[];
    tier: string;
}

/** Formats a byte count for display. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(0)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Bounded activation history, so a long session cannot grow it without limit. */
export const MAX_ACTIVATION_HISTORY = 64;

export function recordActivation(
    history: readonly string[],
    instanceId: string,
): string[] {
    return [...history, instanceId].slice(-MAX_ACTIVATION_HISTORY);
}
