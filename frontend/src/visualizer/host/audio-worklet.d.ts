/**
 * Ambient declarations for `AudioWorkletGlobalScope`, which the DOM lib does not describe.
 * Only the members the analysis processor uses are declared.
 */

declare const currentTime: number;
declare const sampleRate: number;

declare class AudioWorkletProcessor {
    readonly port: MessagePort;
    constructor();
}

declare function registerProcessor(
    name: string,
    processorCtor: new () => AudioWorkletProcessor & {
        process(
            inputs: Float32Array[][],
            outputs?: Float32Array[][],
            parameters?: Record<string, Float32Array>,
        ): boolean;
    },
): void;
