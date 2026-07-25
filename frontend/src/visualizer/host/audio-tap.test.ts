import { afterEach, describe, expect, test, vi } from 'vitest';
import { acquireTap } from './audio-tap';

class FakeAudioNode {
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();
}

class FakeAudioWorkletNode extends FakeAudioNode {
    static instances: FakeAudioWorkletNode[] = [];

    readonly port = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn(),
    };

    constructor() {
        super();
        FakeAudioWorkletNode.instances.push(this);
    }
}

class FakeAudioContext {
    static instances: FakeAudioContext[] = [];

    readonly source = new FakeAudioNode();
    readonly output = new FakeAudioNode() as FakeAudioNode & { gain: { value: number } };
    readonly destination = new FakeAudioNode();
    readonly audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    readonly createMediaElementSource = vi.fn(() => this.source);
    readonly createGain = vi.fn(() => this.output);
    readonly resume = vi.fn().mockResolvedValue(undefined);
    readonly baseLatency = 0;
    readonly currentTime = 0;
    state: AudioContextState = 'running';

    constructor() {
        this.output.gain = { value: 0 };
        FakeAudioContext.instances.push(this);
    }
}

describe('audio tap lifetime', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        FakeAudioContext.instances = [];
        FakeAudioWorkletNode.instances = [];
    });

    test('reconnects the same analysis branch when the visualizer reopens', async () => {
        vi.stubGlobal('AudioContext', FakeAudioContext);
        vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);

        const element = { paused: false } as HTMLMediaElement;
        const tap = await acquireTap(element);
        const context = FakeAudioContext.instances[0];
        const analysis = FakeAudioWorkletNode.instances[0];

        expect(context.createMediaElementSource).toHaveBeenCalledOnce();
        expect(context.source.connect).toHaveBeenCalledWith(analysis);
        expect(analysis.port.onmessage).toBeTypeOf('function');

        tap.dispose();

        expect(context.source.disconnect).toHaveBeenCalledWith(analysis);
        expect(analysis.port.onmessage).toBeNull();

        const reopened = await acquireTap(element);
        await reopened.resume();

        expect(reopened).toBe(tap);
        expect(context.createMediaElementSource).toHaveBeenCalledOnce();
        expect(context.source.connect).toHaveBeenCalledTimes(3);
        expect(context.source.connect).toHaveBeenLastCalledWith(analysis);
        expect(analysis.port.onmessage).toBeTypeOf('function');
    });
});
