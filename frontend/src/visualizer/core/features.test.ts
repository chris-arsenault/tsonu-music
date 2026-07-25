import { describe, expect, test } from 'vitest';
import {
    advanceFeatureBus,
    createFeatureBusState,
    stereoBalance,
    TRANSIENT_GATE_SECONDS,
    type FeatureBusInput,
    type FeatureBusState,
    type FeatureSnapshot,
} from './features';
import { initialClock, type ClockEffect, type PlaybackClock } from './clock';

const LATENCY = 0.02;

const playing: PlaybackClock = {
    ...initialClock,
    trackId: 'track_a',
    state: 'playing',
    playbackTime: 30,
    duration: 200,
};

function snapshot(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
    return {
        audioTime: 100,
        rms: 0.5,
        peak: 0.8,
        bands: { subBass: 0.4, bass: 0.6, lowMid: 0.3, mid: 0.2, highMid: 0.1, treble: 0.05 },
        spectralCentroidHz: 2000,
        spectralFlux: 0.1,
        leftLevel: 0.5,
        rightLevel: 0.5,
        beatPeriodSeconds: 0,
        beatConfidence: 0,
        beatAnchorAudioTime: 0,
        onsets: [],
        waveform: new Float32Array(8),
        spectrum: new Float32Array(16),
        ...overrides,
    };
}

function input(overrides: Partial<FeatureBusInput> = {}): FeatureBusInput {
    return {
        clock: playing,
        effects: [],
        currentAudioTime: 100,
        latencySeconds: LATENCY,
        deltaSeconds: 1 / 60,
        ...overrides,
    };
}

/** Runs the bus forward with no new analysis, letting held events come due. */
function tick(state: FeatureBusState, currentAudioTime: number, overrides: Partial<FeatureBusInput> = {}) {
    return advanceFeatureBus(state, input({ currentAudioTime, ...overrides }));
}

describe('feature bus normalization', () => {
    test('starts silent', () => {
        const { bus } = createFeatureBusState();

        expect(bus.continuous.rms).toBe(0);
        expect(bus.continuous.beatPhase).toBe(0);
        expect(bus.events.onset).toEqual([]);
    });

    test('normalizes every continuous feature into unit range', () => {
        const state = advanceFeatureBus(createFeatureBusState(), input({ snapshot: snapshot() }));
        const values = Object.entries(state.bus.continuous);

        for (const [name, value] of values) {
            expect(Number.isFinite(value), `${name} is finite`).toBe(true);
            if (name !== 'stereoBalance') {
                expect(value, `${name} within unit range`).toBeGreaterThanOrEqual(0);
                expect(value, `${name} within unit range`).toBeLessThanOrEqual(1);
            }
        }
    });

    test('a relatively louder band reads higher than a quieter one', () => {
        let state = createFeatureBusState();
        state = advanceFeatureBus(state, input({ snapshot: snapshot() }));
        // Second frame, so both followers have an established ceiling.
        state = advanceFeatureBus(state, input({ snapshot: snapshot() }));

        expect(state.bus.continuous.bass).toBeGreaterThan(state.bus.continuous.treble);
    });

    test('relative band balance survives normalization', () => {
        const bassHeavy = advanceFeatureBus(
            createFeatureBusState(),
            input({
                snapshot: snapshot({
                    bands: { subBass: 0.5, bass: 0.9, lowMid: 0.3, mid: 0.2, highMid: 0.1, treble: 0.05 },
                }),
            }),
        );
        const trebleHeavy = advanceFeatureBus(
            createFeatureBusState(),
            input({
                snapshot: snapshot({
                    bands: { subBass: 0.05, bass: 0.1, lowMid: 0.2, mid: 0.3, highMid: 0.6, treble: 0.9 },
                }),
            }),
        );

        expect(bassHeavy.bus.continuous.bass).toBeGreaterThan(bassHeavy.bus.continuous.treble);
        expect(trebleHeavy.bus.continuous.treble).toBeGreaterThan(trebleHeavy.bus.continuous.bass);
    });

    test('centroid normalizes against a brightness ceiling', () => {
        const dull = advanceFeatureBus(
            createFeatureBusState(),
            input({ snapshot: snapshot({ spectralCentroidHz: 500 }) }),
        );
        const bright = advanceFeatureBus(
            createFeatureBusState(),
            input({ snapshot: snapshot({ spectralCentroidHz: 7000 }) }),
        );
        const beyond = advanceFeatureBus(
            createFeatureBusState(),
            input({ snapshot: snapshot({ spectralCentroidHz: 40000 }) }),
        );

        expect(bright.bus.continuous.spectralCentroid).toBeGreaterThan(dull.bus.continuous.spectralCentroid);
        expect(beyond.bus.continuous.spectralCentroid).toBe(1);
    });

    test('stereo balance is centred, signed, and bounded', () => {
        expect(stereoBalance(0.5, 0.5)).toBe(0);
        expect(stereoBalance(1, 0)).toBe(-1);
        expect(stereoBalance(0, 1)).toBe(1);
        expect(stereoBalance(0, 0)).toBe(0);
    });

    test('waveform and spectrum are passed through', () => {
        const state = advanceFeatureBus(createFeatureBusState(), input({ snapshot: snapshot() }));

        expect(state.bus.spectrum.length).toBe(16);
        expect(state.bus.waveform.length).toBe(8);
    });

    test('a frame with no new analysis holds the previous continuous values', () => {
        const withData = advanceFeatureBus(createFeatureBusState(), input({ snapshot: snapshot() }));
        const held = advanceFeatureBus(withData, input());

        expect(held.bus.continuous.bass).toBe(withData.bus.continuous.bass);
    });
});

describe('latency compensation', () => {
    test('an onset is held until it is actually audible', () => {
        const detected = advanceFeatureBus(
            createFeatureBusState(),
            input({ snapshot: snapshot({ onsets: [{ audioTime: 100, strength: 0.9 }] }) }),
        );

        // Detected at 100 but not audible until 100 + latency.
        expect(detected.bus.events.onset).toEqual([]);
        expect(detected.pendingOnsets.length).toBe(1);

        const early = tick(detected, 100 + LATENCY / 2);
        expect(early.bus.events.onset).toEqual([]);

        const due = tick(early, 100 + LATENCY);
        expect(due.bus.events.onset.length).toBe(1);
        expect(due.bus.events.onset[0].strength).toBeCloseTo(0.9, 6);
        expect(due.pendingOnsets).toEqual([]);
    });

    test('a presented event carries both audio time and playback time', () => {
        const detected = advanceFeatureBus(
            createFeatureBusState(),
            input({ snapshot: snapshot({ onsets: [{ audioTime: 100, strength: 0.5 }] }) }),
        );
        const due = tick(detected, 100 + LATENCY);

        expect(due.bus.events.onset[0].audioTime).toBe(100);
        // Playback was at 30 when audio time was 100, so the offset is -70.
        expect(due.bus.events.onset[0].playbackTime).toBeCloseTo(30, 6);
    });

    test('an event is presented exactly once', () => {
        const detected = advanceFeatureBus(
            createFeatureBusState(),
            input({ snapshot: snapshot({ onsets: [{ audioTime: 100, strength: 0.5 }] }) }),
        );

        const due = tick(detected, 100 + LATENCY);
        expect(due.bus.events.onset.length).toBe(1);

        const after = tick(due, 100 + LATENCY + 0.5);
        expect(after.bus.events.onset).toEqual([]);
    });
});

describe('clock effects', () => {
    function withEffects(state: FeatureBusState, effects: ClockEffect[], currentAudioTime = 100) {
        return advanceFeatureBus(state, input({ effects, currentAudioTime }));
    }

    test('clearing pending events drops undelivered detections', () => {
        const detected = advanceFeatureBus(
            createFeatureBusState(),
            input({ snapshot: snapshot({ onsets: [{ audioTime: 100, strength: 0.9 }] }) }),
        );
        expect(detected.pendingOnsets.length).toBe(1);

        const cleared = withEffects(detected, ['clear-pending-events']);
        expect(cleared.pendingOnsets).toEqual([]);

        // The dropped detection never surfaces, even once its time comes.
        const later = tick(cleared, 101);
        expect(later.bus.events.onset).toEqual([]);
    });

    test('suppressing transients discards detections from before the resume', () => {
        let state = createFeatureBusState();

        // A detection queued just before the freeze.
        state = advanceFeatureBus(
            state,
            input({ snapshot: snapshot({ onsets: [{ audioTime: 99.99, strength: 1 }] }) }),
        );

        // Resuming gates anything older than the gate window.
        state = withEffects(state, ['suppress-transients'], 100);
        state = tick(state, 100 + TRANSIENT_GATE_SECONDS + 0.01);

        expect(state.bus.events.onset).toEqual([]);
    });

    test('a genuine onset after the gate window still fires', () => {
        let state = withEffects(createFeatureBusState(), ['suppress-transients'], 100);
        const afterGate = 100 + TRANSIENT_GATE_SECONDS + 0.05;

        state = advanceFeatureBus(
            state,
            input({ snapshot: snapshot({ onsets: [{ audioTime: afterGate, strength: 0.8 }] }), currentAudioTime: afterGate }),
        );
        state = tick(state, afterGate + LATENCY);

        expect(state.bus.events.onset.length).toBe(1);
    });

    test('invalidating tempo drops confidence and phase', () => {
        let state = advanceFeatureBus(
            createFeatureBusState(),
            input({
                snapshot: snapshot({
                    beatPeriodSeconds: 0.5,
                    beatConfidence: 0.9,
                    beatAnchorAudioTime: 100,
                }),
            }),
        );
        expect(state.bus.continuous.beatConfidence).toBeGreaterThan(0);

        state = withEffects(state, ['invalidate-tempo']);

        expect(state.bus.continuous.beatConfidence).toBe(0);
        expect(state.bus.continuous.beatPhase).toBe(0);
        expect(state.beat.periodSeconds).toBe(0);
    });
});

describe('beat presentation', () => {
    const beating = {
        beatPeriodSeconds: 0.5,
        beatConfidence: 0.9,
        beatAnchorAudioTime: 100,
    };

    test('phase advances between beats and wraps at the next', () => {
        let state = advanceFeatureBus(
            createFeatureBusState(),
            input({ snapshot: snapshot({ ...beating }), currentAudioTime: 100 + LATENCY }),
        );
        expect(state.bus.continuous.beatPhase).toBeCloseTo(0, 3);

        state = tick(state, 100.25 + LATENCY);
        expect(state.bus.continuous.beatPhase).toBeCloseTo(0.5, 3);

        state = tick(state, 100.5 + LATENCY);
        expect(state.bus.continuous.beatPhase).toBeCloseTo(0, 3);
    });

    test('each beat emits one event', () => {
        let state = advanceFeatureBus(
            createFeatureBusState(),
            input({ snapshot: snapshot({ ...beating }), currentAudioTime: 100 + LATENCY }),
        );

        let emitted = state.bus.events.beat.length;
        for (let step = 1; step <= 20; step += 1) {
            state = tick(state, 100 + LATENCY + step * 0.05);
            emitted += state.bus.events.beat.length;
        }

        // Anchored at 100 with a 0.5s period, one second of audible time covers beats at
        // 100.0, 100.5, and 101.0.
        expect(emitted).toBe(3);
    });

    test('a frozen clock holds beat phase still', () => {
        let state = advanceFeatureBus(
            createFeatureBusState(),
            input({ snapshot: snapshot({ ...beating }), currentAudioTime: 100 + LATENCY }),
        );
        state = tick(state, 100.25 + LATENCY);
        const phaseAtFreeze = state.bus.continuous.beatPhase;

        // A frozen clock passes zero delta.
        const frozen = tick(state, 103, { clock: { ...playing, state: 'paused' }, deltaSeconds: 0 });

        expect(frozen.bus.continuous.beatPhase).toBe(phaseAtFreeze);
        expect(frozen.bus.events.beat).toEqual([]);
    });

    test('no confident tempo means no beat events and no free-running phase', () => {
        let state = advanceFeatureBus(
            createFeatureBusState(),
            input({ snapshot: snapshot({ beatPeriodSeconds: 0.5, beatConfidence: 0 }) }),
        );

        for (let step = 1; step <= 10; step += 1) {
            state = tick(state, 100 + step * 0.1);
            expect(state.bus.events.beat).toEqual([]);
            expect(state.bus.continuous.beatPhase).toBe(0);
        }
    });
});
