# 0004 — HLS buffer health throttles the visualizer, not the reverse

- Status: Accepted
- Date: 2026-07-25

## Context

Audio decode and output run off the main thread, and `hls.js` is constructed with
`enableWorker: true`, so segment demuxing is off-thread as well. What remains on the main thread
is the buffer-append path, ABR decisions, and error recovery — sharing that thread with the
visualizer's per-frame work.

The consequence is that visualizer cost does not manifest as distorted audio. It manifests as a
stall: on a weak device, main-thread contention near buffer exhaustion delays an append past the
point where playback runs dry. A frame-time budget alone cannot see this coming, because frame
time can sit inside budget while the buffer drains.

The `hls.js` instance already exposes what is needed to see it: `FRAG_BUFFERED`,
`BUFFER_STALLED_ERROR`, and the `mainForwardBufferInfo` getter.

## Decision

Forward buffer length is a first-class input to the performance controller alongside frame time.
When buffer-ahead falls below threshold or a stall is reported, the controller downgrades and, at
the floor, suspends rendering entirely until buffer health recovers.

## Alternatives considered

- **Frame-time budgeting alone, as the specification's downgrade ladder describes** — simpler,
  one signal, and correct for pure rendering cost. Blind to the failure that actually harms the
  listener, since a stall can arrive with frame time nominal. Rejected as incomplete.
- **Move visualizer rendering off the main thread onto an `OffscreenCanvas` in a worker** —
  removes the contention at its source rather than reacting to it, and is the stronger long-term
  answer. Costs a worker boundary for every audio feature, asset upload, and diagnostic read, and
  `OffscreenCanvas` support is uneven on the platforms that need the help most. Recorded in
  `docs/backlog.md`.
- **Cap the frame rate low enough that contention cannot occur** — trivially safe, and throws away
  the visual quality the feature exists to provide on the machines that can afford it. Rejected.

## Consequences

Playback is protected by a signal that observes the actual failure mode, and the visualizer
degrades on the devices that need it without penalizing capable ones. Suspend-and-recover means a
listener on a marginal connection sees the visuals pause rather than the music stop.

The performance controller now depends on the `hls.js` instance, so the player must surface buffer
telemetry to the visualizer, coupling two subsystems that would otherwise not interact. On the
native-HLS path no instance exists, but that path has no audio-reactive visualizer (see ADR-0001);
`HTMLMediaElement.buffered` supplies a coarser playback-health equivalent there.
