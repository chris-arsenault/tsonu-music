/**
 * React glue for the kernel loop. Owns no logic: it resolves availability, starts and stops the
 * loop, and hands readouts to React state at the loop's throttled rate.
 */

import { useEffect, useRef, useState } from 'react';
import { resolveAvailability, type VisualizerAvailability } from '../host/capabilities';
import { startKernel, type KernelHandle, type KernelReadout } from '../host/kernel-loop';

export interface KernelSubject {
    getAudioElement: () => HTMLAudioElement | null;
    trackId: string | null;
    trackDurationSeconds: number;
}

export interface KernelState {
    availability?: VisualizerAvailability;
    readout?: KernelReadout;
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

    // Latest values, read when the kernel starts. Kept in refs so a track change pushes through
    // `setTrack` instead of restarting the loop and discarding unrelated state.
    const getElementRef = useRef(subject.getAudioElement);
    const trackIdRef = useRef(subject.trackId);
    const durationRef = useRef(subject.trackDurationSeconds);
    getElementRef.current = subject.getAudioElement;
    trackIdRef.current = subject.trackId;
    durationRef.current = subject.trackDurationSeconds;

    useEffect(() => {
        const resolved = getElementRef.current();
        setElement(resolved);
        setAvailability(resolveAvailability(resolved));
    }, []);

    const canRun = active && element !== null && availability?.available === true;

    useEffect(() => {
        if (!canRun || !element) {
            return undefined;
        }

        const handle = startKernel({
            element,
            trackId: trackIdRef.current,
            trackDurationSeconds: durationRef.current,
            onReadout: setReadout,
        });
        handleRef.current = handle;

        return () => {
            handleRef.current = undefined;
            handle.stop();
            setReadout(undefined);
        };
    }, [canRun, element]);

    useEffect(() => {
        handleRef.current?.setTrack(subject.trackId, subject.trackDurationSeconds);
    }, [subject.trackId, subject.trackDurationSeconds]);

    return { availability, readout };
}
