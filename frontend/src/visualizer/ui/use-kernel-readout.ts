/**
 * React glue for the kernel loop. Owns no logic: it resolves availability, starts and stops the
 * loop, and hands readouts to React state at the loop's throttled rate.
 */

import { useEffect, useRef, useState } from 'react';
import type { PlaybackEngine } from '../../music/playback-engine';
import { resolveAvailability, type VisualizerAvailability } from '../host/capabilities';
import {
    startKernel,
    type KernelControlHandle,
    type KernelHandle,
    type KernelReadout,
} from '../host/kernel-loop';
import type { DiagnosticsControls } from '../core/diagnostics';

export interface KernelSubject {
    getAudioElement: () => HTMLAudioElement | null;
    playbackEngine: PlaybackEngine;
    trackId: string | null;
    trackDurationSeconds: number;
    /** Omit to run analysis without rendering. */
    canvas?: HTMLCanvasElement | null;
    /** Omit when buffer telemetry is unavailable; frame time is then the only performance input. */
    getBufferHealth?: () => { forwardBufferSeconds?: number; stalled?: boolean };
    /** Album artwork for asset-derivation plugins. Omit to run without artwork. */
    artworkSrc?: string;
    /** Diagnostics overrides, pushed to the loop as they change. */
    controls?: DiagnosticsControls;
}

export interface KernelState {
    availability?: VisualizerAvailability;
    readout?: KernelReadout;
    /** Controls for the diagnostics overlay. Absent while the kernel is not running. */
    handle?: KernelControlHandle;
}

/**
 * Starts the kernel while `active` is true.
 *
 * Availability is resolved after mount rather than during render, because the audio element belongs
 * to a parent provider and its ref is not attached while this component first renders. It is resolved
 * before any `AudioContext` exists, so an unavailable browser never enters the Web Audio path.
 */
export function useKernelReadout(subject: KernelSubject, active: boolean): KernelState {
    const [element, setElement] = useState<HTMLAudioElement | null>(null);
    const [availability, setAvailability] = useState<VisualizerAvailability | undefined>(undefined);
    const [readout, setReadout] = useState<KernelReadout | undefined>(undefined);

    const handleRef = useRef<KernelHandle | undefined>(undefined);
    // State as well as a ref, so the overlay re-renders once controls become available.
    const [handle, setHandle] = useState<KernelHandle | undefined>(undefined);

    // Latest values, read when the kernel starts. Kept in refs so a track change pushes through
    // `setTrack` instead of restarting the loop and discarding unrelated state.
    const getElementRef = useRef(subject.getAudioElement);
    const trackIdRef = useRef(subject.trackId);
    const durationRef = useRef(subject.trackDurationSeconds);
    const bufferHealthRef = useRef(subject.getBufferHealth);
    const artworkRef = useRef(subject.artworkSrc);
    getElementRef.current = subject.getAudioElement;
    trackIdRef.current = subject.trackId;
    durationRef.current = subject.trackDurationSeconds;
    bufferHealthRef.current = subject.getBufferHealth;
    artworkRef.current = subject.artworkSrc;

    useEffect(() => {
        const resolved = getElementRef.current();
        setElement(resolved);
        setAvailability(
            subject.playbackEngine === 'pending'
                ? undefined
                : resolveAvailability(subject.playbackEngine),
        );
    }, [subject.playbackEngine]);

    const canvas = subject.canvas ?? undefined;
    const canRun = active && element !== null && availability?.available === true;

    useEffect(() => {
        if (!canRun || !element) {
            return undefined;
        }

        const started = startKernel({
            element,
            canvas,
            trackId: trackIdRef.current,
            trackDurationSeconds: durationRef.current,
            prefersReducedMotion: availability?.prefersReducedMotion,
            artworkSrc: artworkRef.current,
            bufferHealth: bufferHealthRef.current
                ? () => bufferHealthRef.current!()
                : undefined,
            onReadout: setReadout,
        });
        handleRef.current = started;
        setHandle(started);

        return () => {
            handleRef.current = undefined;
            setHandle(undefined);
            started.stop();
            setReadout(undefined);
        };
    }, [canRun, element, canvas, availability?.prefersReducedMotion]);

    // Pushed every render rather than restarting the kernel, so toggling a control is immediate.
    useEffect(() => {
        if (subject.controls) {
            handleRef.current?.setControls(subject.controls);
        }
    }, [subject.controls]);

    useEffect(() => {
        handleRef.current?.setTrack(subject.trackId, subject.trackDurationSeconds);
    }, [subject.trackId, subject.trackDurationSeconds]);

    // Pushed like the track, not read once at start. `artworkSrc` was held in a ref and deliberately
    // kept out of the kernel effect's dependencies, so the texture uploaded was whatever track was
    // playing when the visualizer opened and no later track ever replaced it.
    useEffect(() => {
        handleRef.current?.setArtwork(subject.artworkSrc);
    }, [subject.artworkSrc]);

    return { availability, readout, handle };
}
