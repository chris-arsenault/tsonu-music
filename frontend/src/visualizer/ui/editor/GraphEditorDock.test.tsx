import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import GraphEditorDock from './GraphEditorDock';
import { createDiagnosticsControls } from '../../core/diagnostics';
import { silentFeatureBus } from '../../core/features';
import type { KernelReadout } from '../../host/kernel-loop';

function readout(overrides: Partial<KernelReadout> = {}): KernelReadout {
    return {
        clock: { trackId: 't', playbackTime: 1, duration: 100, state: 'playing', generation: 1 },
        frozen: false,
        bus: silentFeatureBus(),
        latencySeconds: 0.01,
        contextState: 'running',
        analysisPath: 'worklet',
        flatlined: false,
        frameTimeMs: 16,
        ...overrides,
    } as KernelReadout;
}

const props = {
    faults: [],
    controls: createDiagnosticsControls(),
    onControls: vi.fn(),
    onClose: vi.fn(),
};

describe('the dock', () => {
    test('offers the three tabs', () => {
        const html = renderToStaticMarkup(<GraphEditorDock readout={readout()} {...props} />);

        expect(html).toContain('>graph</button>');
        expect(html).toContain('>meters</button>');
        expect(html).toContain('>performance</button>');
    });

    test('before a capture it explains what capturing gets you', () => {
        const html = renderToStaticMarkup(<GraphEditorDock readout={readout()} {...props} />);

        expect(html).toContain('Capture scene');
        expect(html).toContain('layer stack');
        // No document, so no canvas is mounted and React Flow is never fetched.
        expect(html).toContain('viz-editor__empty');
    });

    test('the scheduler controls are reachable from the bar whatever tab is open', () => {
        const html = renderToStaticMarkup(<GraphEditorDock readout={readout()} {...props} />);

        expect(html).toContain('freeze simulation');
        expect(html).toContain('freeze mutations');
    });

    test('a document can be brought in before anything has been captured', () => {
        // Import is the way back into a scene from a previous session or another machine, so it
        // cannot be behind having captured something first.
        const html = renderToStaticMarkup(<GraphEditorDock readout={readout()} {...props} />);

        expect(html).toContain('>Import</button>');
        expect(html).toContain('accept="application/json,.json"');
    });

    test('export and fixture are offered only once there is a document to export', () => {
        const html = renderToStaticMarkup(<GraphEditorDock readout={readout()} {...props} />);

        expect(html).not.toContain('>Export</button>');
        expect(html).not.toContain('>Copy fixture</button>');
    });

    test('it reports on the kernel it is given rather than starting one', () => {
        // Two visualizers in two GL contexts would describe the wrong thing. With no handle there is
        // nothing to capture and the dock still renders.
        const html = renderToStaticMarkup(<GraphEditorDock readout={readout()} {...props} />);

        expect(html).toContain('viz-editor');
    });
});
