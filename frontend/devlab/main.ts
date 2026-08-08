/**
 * Drives the visualizer kernel against a local file, with no player around it.
 *
 * The real surface reaches the kernel through the playback engine, an HLS switch, a React modal, and
 * an availability gate. None of those are what you are looking at when you are judging whether the
 * picture moves, and all of them are in the way of changing a constant and reloading.
 */

import { startKernel, type KernelHandle, type KernelReadout } from '../src/visualizer/host/kernel-loop';
import { createDiagnosticsControls, type DiagnosticsControls } from '../src/visualizer/core/diagnostics';
import { collectFaults } from '../src/visualizer/core/fallback';
import { KERNEL_STAGES } from '../src/visualizer/host/runtime';
import GraphEditorDock from '../src/visualizer/ui/editor/GraphEditorDock';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

const TRACKS = Object.entries(
    import.meta.glob('./audio/*.ogg', { eager: true, query: '?url', import: 'default' }),
).map(([path, url]) => ({
    id: path.replace(/^\.\/audio\//, '').replace(/\.ogg$/, ''),
    url: url as string,
})).sort((a, b) => a.id.localeCompare(b.id));

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const player = document.querySelector<HTMLAudioElement>('#player')!;
const trackSelect = document.querySelector<HTMLSelectElement>('#track')!;
const compositeList = document.querySelector<HTMLDListElement>('#composite')!;
const meterList = document.querySelector<HTMLDivElement>('#meters')!;
const pluginList = document.querySelector<HTMLUListElement>('#plugins')!;
const problemList = document.querySelector<HTMLUListElement>('#problems')!;
const editorContainer = document.querySelector<HTMLDivElement>('#editor-root')!;
const editorToggle = document.querySelector<HTMLButtonElement>('#editor-toggle')!;
const freezeButton = document.querySelector<HTMLButtonElement>('#freeze')!;
const editorRoot = createRoot(editorContainer);

/**
 * Artwork for the image-dream family, which otherwise never activates here.
 *
 * A mask PNG stands in for a cover: the album-art plugins want a colour texture and do not care where
 * it came from. Same origin, so no CORS dance.
 */
const ARTWORK_SRC = '/masks/elvish-star.png';

const inspectSelect = document.querySelector<HTMLSelectElement>('#inspect')!;

let handle: KernelHandle | undefined;
let artwork = false;
let reducedMotion = false;
let controls: DiagnosticsControls = createDiagnosticsControls();
let latestReadout: KernelReadout | undefined;
let editorOpen = true;
let lastEditorRender = 0;

const EDITOR_READOUT_INTERVAL_MS = 50;

for (const track of TRACKS) {
    const option = document.createElement('option');
    option.value = track.id;
    option.textContent = track.id;
    trackSelect.append(option);
}

/**
 * Starts the kernel. Must be called from inside a user gesture.
 *
 * `acquireTap` constructs the AudioContext, and a context constructed without a gesture starts
 * suspended. Because `createMediaElementSource` reroutes the element through that context, a
 * suspended one does not merely mean silence — the element never advances, so the playback clock
 * never leaves `paused`, the loop passes zero delta, and every feature sits at zero while the
 * renderer carries on. That reads as "the visualizer works and the music does nothing".
 */
function restart(): void {
    handle?.stop();
    controls = { ...controls, authoring: false };

    const track = TRACKS.find((entry) => entry.id === trackSelect.value) ?? TRACKS[0];
    if (!track) {
        problemList.innerHTML = '<li class="warn">No audio in devlab/audio.</li>';
        return;
    }

    if (!player.src.endsWith(track.url)) {
        player.src = track.url;
    }

    handle = startKernel({
        element: player,
        canvas,
        trackId: track.id,
        trackDurationSeconds: player.duration || 0,
        prefersReducedMotion: reducedMotion,
        artworkSrc: artwork ? ARTWORK_SRC : undefined,
        // Every frame. The meters are the instrument here, so they must not add stutter of their own.
        readoutHz: 60,
        onReadout: render,
    });

    handle.setControls(controls);
}

function applyControls(next: DiagnosticsControls): void {
    controls = next;
    handle?.setControls(controls);
    freezeButton.setAttribute('aria-pressed', String(controls.freezeMutations));
    inspectSelect.value = controls.inspectResource ?? '';

    if (latestReadout) {
        renderEditor(latestReadout, true);
    }
}

function setEditorOpen(open: boolean): void {
    editorOpen = open;
    editorContainer.hidden = !open;
    editorToggle.setAttribute('aria-pressed', String(open));

    if (open && latestReadout) {
        renderEditor(latestReadout, true);
    }
}

function renderEditor(readout: KernelReadout, force = false): void {
    if (!editorOpen) {
        return;
    }

    const now = performance.now();
    if (!force && now - lastEditorRender < EDITOR_READOUT_INTERVAL_MS) {
        return;
    }
    lastEditorRender = now;

    const faults = collectFaults({
        webgl2Available: readout.renderFailure !== 'no-webgl2',
        floatRenderTargets: readout.gpu?.floatRenderTargets
            ?? readout.renderFailure !== 'no-float-render-targets',
        contextLost: readout.gpu?.contextLost ?? false,
        shaderErrorCount: readout.render?.problems.length ?? 0,
        analysisFlatlined: readout.flatlined,
        audioContextState: readout.contextState,
        graphValid: readout.renderFailure !== 'invalid-scene',
        canvasWidth: canvas.clientWidth || 1,
        canvasHeight: canvas.clientHeight || 1,
        performanceSuspended: readout.performance?.profile.suspended ?? false,
        prefersReducedMotion: reducedMotion,
    });

    editorRoot.render(createElement(GraphEditorDock, {
        readout,
        faults,
        controls,
        onControls: applyControls,
        handle,
        onClose: () => setEditorOpen(false),
    }));
}

function sizeCanvas(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
}

const METERS = [
    'rms', 'bass', 'mid', 'treble',
    'bassExcite', 'midExcite', 'trebleExcite',
    'spectralCentroid', 'beatPhase',
] as const;

function render(readout: KernelReadout): void {
    // Parked on `window` so a headless probe can read the graph without the panel having to render it.
    (window as unknown as Record<string, unknown>).__readout = readout;
    latestReadout = readout;

    const scene = readout.scene;
    const rows: [string, string][] = [
        ['fps', (1000 / Math.max(readout.frameTimeMs, 1)).toFixed(0)],
        ['state', readout.clock.state + (readout.frozen ? ' (frozen)' : '')],
        ['audio', readout.contextState + (readout.flatlined ? ' flat' : '')],
        ['analysis', readout.analysisPath],
        ['theme', scene?.themeId ?? '—'],
        ['loop gain', scene?.loopGains.length
            ? scene.loopGains.map((gain) => gain.toFixed(2)).join(' · ')
            : '—'],
        ['layers', String(scene?.layerCount ?? 0)],
        ['branches', String(scene?.materialBranchCount ?? 0)],
        ['passes', String(readout.render?.passesExecuted ?? 0)],
        ['quality', String(readout.performance?.level ?? 0)],
        ['mutation', scene?.lastMutation ?? '—'],
    ];

    compositeList.innerHTML = rows
        .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
        .join('');

    const continuous = readout.bus.continuous as unknown as Record<string, number>;
    meterList.innerHTML = METERS
        .map((name) => {
            const value = Math.round((continuous[name] ?? 0) * 100);
            return `<div class="meter"><span>${name}</span><i style="--v:${value}%"></i></div>`;
        })
        .join('');

    pluginList.innerHTML = (scene?.pluginIds ?? [])
        .map((id) => `<li>${id}</li>`)
        .join('') || '<li>—</li>';

    // Populated from the live graph so any intermediate can be put on screen on its own. A stage that
    // is empty and a stage that is never composited look identical in the finished frame.
    // The kernel's own stages come first, because the composition between the layers and the canvas
    // is where brightness and detail actually go missing and it had no view of its own.
    const resources = [...KERNEL_STAGES, ...(scene?.resourceIds ?? [])];
    if (resources.join('|') !== inspectSelect.dataset.of) {
        inspectSelect.dataset.of = resources.join('|');
        inspectSelect.innerHTML = ['<option value="">composed output</option>']
            .concat(resources.map((id) => `<option value="${id}">${id}</option>`))
            .join('');
    }
    inspectSelect.value = controls.inspectResource ?? '';

    const problems = [
        ...(readout.render?.problems ?? []),
        ...(readout.renderFailure ? [`renderer: ${readout.renderFailure}`] : []),
    ];
    problemList.innerHTML = problems.length > 0
        ? problems.map((entry) => `<li class="warn">${entry}</li>`).join('')
        : '<li>none</li>';

    renderEditor(readout);
}

document.querySelector('#new-scene')!.addEventListener('click', () => handle?.newScene());

inspectSelect.addEventListener('change', () => {
    applyControls({ ...controls, inspectResource: inspectSelect.value || undefined });
});

freezeButton.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const next = button.getAttribute('aria-pressed') !== 'true';
    applyControls({ ...controls, freezeMutations: next });
});

editorToggle.addEventListener('click', () => {
    setEditorOpen(!editorOpen);
});

for (const [id, apply] of [
    ['artwork', (on: boolean) => { artwork = on; }],
    ['reduced', (on: boolean) => { reducedMotion = on; }],
] as const) {
    const button = document.querySelector<HTMLButtonElement>(`#${id}`)!;
    button.addEventListener('click', () => {
        const next = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', String(next));
        apply(next);
        restart();
    });
}

trackSelect.addEventListener('change', () => {
    restart();
    void player.play();
});

player.addEventListener('durationchange', () => {
    handle?.setTrack(trackSelect.value, player.duration || 0);
});

window.addEventListener('resize', sizeCanvas);

// `AudioWorklet` is a secure-context API, so over plain HTTP on anything but localhost the kernel
// falls back to main-thread analysis. Stated plainly, because the symptom otherwise looks like the
// music doing nothing rather than like a reduced-precision path.
if (!window.isSecureContext) {
    const notice = document.createElement('li');
    notice.className = 'warn';
    notice.textContent = 'insecure origin: analysis on the main thread, reduced timing precision';
    problemList.append(notice);
}

const startButton = document.querySelector<HTMLButtonElement>('#start')!;
startButton.addEventListener('click', () => {
    startButton.remove();
    // Both inside the gesture: the context is constructed and the element started while the page
    // holds user activation.
    restart();
    void player.play();
});

sizeCanvas();
