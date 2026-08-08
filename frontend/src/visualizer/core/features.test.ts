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
import {
    createBeatTracker,
    observeOnset,
    PINK_BAND_WEIGHTS,
    SPECTRAL_BANDS,
    type BandName,
} from './analysis';

const LATENCY = 0.02;

const playing: PlaybackClock = {
    ...initialClock,
    trackId: 'track_a',
    state: 'playing',
    playbackTime: 30,
    duration: 200,
};

/**
 * Raw band means that produce a given perceived balance.
 *
 * `bandEnergy` reports a mean per bin, and those are not comparable across bands: the spectrum rolls
 * off, so a wide high band averages many small bins where a narrow low band averages a few large
 * ones. Writing `{ bass: 0.9, treble: 0.05 }` as a raw fixture therefore does not describe a
 * bass-heavy mix — measured against real material, raw treble runs three orders of magnitude below
 * raw bass, so 0.05 against 0.9 is extremely treble-heavy.
 *
 * These fixtures state the balance they mean and divide back through the pink weights to get the raw
 * means that would produce it. Before this helper existed they asserted the balance the old shared
 * ceiling happened to produce, which is why they passed while four of six channels were pinned at
 * their floor in production.
 */
function rawBands(balance: Record<BandName, number>): Record<BandName, number> {
    const raw = {} as Record<BandName, number>;
    for (const band of SPECTRAL_BANDS) {
        raw[band.name] = balance[band.name] / PINK_BAND_WEIGHTS[band.name];
    }

    return raw;
}

function snapshot(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
    return {
        audioTime: 100,
        rms: 0.5,
        peak: 0.8,
        bands: rawBands({ subBass: 0.4, bass: 0.6, lowMid: 0.3, mid: 0.2, highMid: 0.1, treble: 0.05 }),
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
                    bands: rawBands({ subBass: 0.5, bass: 0.9, lowMid: 0.3, mid: 0.2, highMid: 0.1, treble: 0.05 }),
                }),
            }),
        );
        const trebleHeavy = advanceFeatureBus(
            createFeatureBusState(),
            input({
                snapshot: snapshot({
                    bands: rawBands({ subBass: 0.05, bass: 0.1, lowMid: 0.2, mid: 0.3, highMid: 0.6, treble: 0.9 }),
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

describe('beat presentation against a live tracker', () => {
    /**
     * Runs the bus with an anchor produced by the real beat tracker rather than a pinned constant.
     *
     * Every other test in this file supplies `beatAnchorAudioTime` as a fixed number, which cannot
     * happen at runtime: the tracker re-evaluates its anchor on every onset. Pinning it hid a defect
     * that made beat events almost entirely stop firing — the tests asserted a situation the
     * producer never creates.
     */
    function play(seconds: number, beatPeriod: number) {
        let tracker = createBeatTracker();
        let state = createFeatureBusState();
        let audioTime = 100;
        const emitted: number[] = [];
        const phases: number[] = [];
        let nextOnsetAt = audioTime;

        for (let frame = 0; frame * (1 / 60) < seconds; frame += 1) {
            audioTime += 1 / 60;

            // An onset on every beat, plus one halfway between — a kick and an off-beat hat, which
            // is what makes the anchor move if anything does.
            const onsets: { audioTime: number; strength: number }[] = [];
            while (nextOnsetAt <= audioTime) {
                tracker = observeOnset(tracker, nextOnsetAt);
                onsets.push({ audioTime: nextOnsetAt, strength: 0.8 });
                nextOnsetAt += beatPeriod / 2;
            }

            state = advanceFeatureBus(state, input({
                currentAudioTime: audioTime,
                snapshot: snapshot({
                    audioTime,
                    onsets,
                    beatPeriodSeconds: tracker.periodSeconds,
                    beatConfidence: tracker.confidence,
                    beatAnchorAudioTime: tracker.anchorTime,
                }),
            }));

            for (const event of state.bus.events.beat) {
                emitted.push(event.audioTime);
            }
            if (tracker.confidence > 0) {
                phases.push(state.bus.continuous.beatPhase);
            }
        }

        return { emitted, phases, tracker };
    }

    test('beats keep firing for the length of a passage', () => {
        const { emitted, tracker } = play(20, 0.5);

        expect(tracker.confidence).toBeGreaterThan(0);
        // Twenty seconds at half-second beats, less the few seconds the tracker needs to lock.
        expect(emitted.length).toBeGreaterThan(30);
    });

    test('no beat is emitted twice', () => {
        const { emitted } = play(20, 0.5);

        for (let i = 1; i < emitted.length; i += 1) {
            expect(emitted[i] - emitted[i - 1]).toBeGreaterThan(0.25);
        }
    });

    test('phase sweeps the whole cycle rather than stalling partway', () => {
        const { phases } = play(20, 0.5);

        expect(Math.max(...phases)).toBeGreaterThan(0.9);
        expect(Math.min(...phases)).toBeLessThan(0.1);
    });

    test('the grid anchor holds while onsets land on it', () => {
        const tracker = play(20, 0.5).tracker;

        // Anchored early and left alone, rather than dragged to the most recent onset.
        expect(tracker.anchorTime).toBeLessThan(110);
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

/**
 * The defect: every band was divided by one ceiling driven by the loudest of them, so on ordinary
 * music the dominant band sat near the top of its range and every quieter band sat near the bottom,
 * whatever was happening. Any binding on treble was reading a signal that never moved.
 */
describe('band excitation', () => {
    /** A bass-dominant mix, as almost all mastered music is. */
    const mix = (treble: number) => snapshot({
        bands: rawBands({ subBass: 0.5, bass: 0.9, lowMid: 0.3, mid: 0.2, highMid: 0.06, treble }),
    });

    /** Settles the bus on a steady mix, then reports the frame after `final` arrives. */
    function settleThen(steady: number, final: number) {
        let state = createFeatureBusState();
        let audioTime = 100;

        for (let frame = 0; frame < 240; frame += 1) {
            audioTime += 1 / 60;
            state = advanceFeatureBus(state, input({ snapshot: mix(steady), currentAudioTime: audioTime }));
        }

        const before = state.bus.continuous;
        audioTime += 1 / 60;
        state = advanceFeatureBus(state, input({ snapshot: mix(final), currentAudioTime: audioTime }));

        return { before, after: state.bus.continuous };
    }

    test('a quiet band stays crushed in level, which is what excitation exists to answer', () => {
        const { before } = settleThen(0.02, 0.02);

        expect(before.treble).toBeLessThan(0.1);
        expect(before.bass).toBeGreaterThan(0.9);
    });

    test('a treble transient excites even while its level barely moves', () => {
        const { before, after } = settleThen(0.02, 0.2);

        expect(after.trebleExcite).toBeGreaterThan(0.5);
        // The level channel moved by a fraction of what excitation reports, because the bass ceiling
        // it is divided by did not change.
        expect(after.treble - before.treble).toBeLessThan(0.25);
    });

    test('a steady dominant band is not permanently excited', () => {
        const { after } = settleThen(0.02, 0.02);

        expect(after.bass).toBeGreaterThan(0.9);
        expect(after.bassExcite).toBeLessThan(0.2);
    });

    test('excitation is short-term history and is dropped on a seek', () => {
        let state = createFeatureBusState();
        let audioTime = 100;

        for (let frame = 0; frame < 120; frame += 1) {
            audioTime += 1 / 60;
            state = advanceFeatureBus(state, input({ snapshot: mix(0.02), currentAudioTime: audioTime }));
        }

        expect(state.excitation.bass.mean).toBeGreaterThan(0);

        const seeked = advanceFeatureBus(state, input({
            effects: ['clear-analysis-history'] as ClockEffect[],
            currentAudioTime: audioTime,
        }));

        expect(seeked.excitation.bass.mean).toBe(0);
        expect(seeked.excitation.treble.deviation).toBe(0);
    });
});

describe('level channels occupy the range their consumers assume', () => {
    /** Each band on its own slow cycle, so the balance between them genuinely moves. */
    function shiftingBalance(frame: number): FeatureSnapshot {
        const cycle = (periodSeconds: number, phase: number) =>
            0.55 + 0.45 * Math.sin((frame / 60) * (Math.PI * 2 / periodSeconds) + phase);

        return snapshot({
            rms: 0.3 * cycle(25, 0.5),
            peak: 0.5 * cycle(25, 0.5),
            bands: rawBands({
                subBass: 0.6 * cycle(19, 0),
                bass: 0.9 * cycle(23, 1.1),
                lowMid: 0.4 * cycle(17, 2.2),
                mid: 0.3 * cycle(21, 3.3),
                highMid: 0.15 * cycle(29, 4.4),
                treble: 0.1 * cycle(13, 5.5),
            }),
        });
    }

    /** One fixed balance, moved up and down together — a fade, not a change in the music. */
    function uniformGain(frame: number): FeatureSnapshot {
        const level = 0.55 + 0.45 * Math.sin((frame / 60) * (Math.PI * 2 / 24));

        return snapshot({
            rms: 0.3 * level,
            peak: 0.5 * level,
            bands: rawBands({
                subBass: 0.5 * level,
                bass: 0.9 * level,
                lowMid: 0.3 * level,
                mid: 0.2 * level,
                highMid: 0.06 * level,
                treble: 0.04 * level,
            }),
        });
    }

    /** Runs ninety seconds and reports what `channel` took after the distribution warmed up. */
    function run(
        material: (frame: number) => FeatureSnapshot,
        channel: keyof typeof bus,
    ): number[] {
        let state = createFeatureBusState();
        let audioTime = 100;
        const values: number[] = [];

        for (let frame = 0; frame < 90 * 60; frame += 1) {
            audioTime += 1 / 60;
            state = advanceFeatureBus(state, input({
                snapshot: material(frame),
                currentAudioTime: audioTime,
            }));

            // Past the warm-up, which blends back toward the raw value before then.
            if (frame > 30 * 60) {
                values.push(state.bus.continuous[channel]);
            }
        }

        return values;
    }

    const bus = createFeatureBusState().bus.continuous;
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

    test('a mid-range band spreads across the range rather than sitting in a tenth of it', () => {
        // Measured over real material `mid` lived between 0.150 and 0.254, so every parameter mapped
        // across [0, 1] moved a tenth of its span for the length of a track. What a consumer's
        // [0, 1] is asking about is the band's position within its own distribution.
        expect(spread(run(shiftingBalance, 'mid'))).toBeGreaterThan(0.75);
    });

    test('a quiet band spreads as far as a loud one', () => {
        expect(spread(run(shiftingBalance, 'treble'))).toBeGreaterThan(0.75);
        expect(spread(run(shiftingBalance, 'bass'))).toBeGreaterThan(0.75);
    });

    test('a fade produces no band movement, and none is manufactured', () => {
        // The shared ceiling divides out a gain applied to every band at once, so a fade changes no
        // band's level — correctly, since the balance did not change. The distribution stage sees a
        // channel that does not vary and must leave it alone rather than spreading its own noise
        // across the whole range, which would turn a fade into six full-scale control signals.
        expect(spread(run(uniformGain, 'mid'))).toBeLessThan(0.05);
        expect(spread(run(uniformGain, 'treble'))).toBeLessThan(0.05);
    });

    test('excitation channels are left as gates', () => {
        // Their median of zero is the signal. Spreading them uniformly would turn every event
        // detector into a level, and `distributeReactivity` refuses to move a binding between the
        // two kinds for exactly that reason.
        const values = run(shiftingBalance, 'bassExcite');
        const median = [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];

        expect(median).toBeLessThan(0.1);
    });
});
