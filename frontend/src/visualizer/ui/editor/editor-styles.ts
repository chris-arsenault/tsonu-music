/**
 * The editor's stylesheet, injected at mount rather than bundled.
 *
 * The public production build publishes a single stylesheet because the `website` module is
 * configured with one `ENTRY_CSS` value. The editor is mounted only by the Lab, and importing its
 * stylesheet as text keeps that development-only boundary explicit. See ADR-0011.
 */

import { useEffect } from 'react';
import reactFlowStyles from '@xyflow/react/dist/style.css?inline';

const STYLE_ELEMENT_ID = 'viz-editor-styles';

/** One colour per port type, so a socket says what it carries before anything is connected. */
export const PORT_COLOURS: Readonly<Record<string, string>> = {
    'color-texture': '#e0b341',
    'mask-texture': '#8f8f96',
    'distance-field': '#7fa7c9',
    'vector-field': '#59b58a',
    'collision-field': '#4f9e78',
    'reaction-diffusion-state': '#a172c4',
    'wave-field-state': '#8a6bbd',
    'depth-texture': '#6f7fa8',
    'motion-field': '#59b58a',
    'particle-buffer': '#d0705a',
    'particle-emitter': '#d98b55',
    'particle-force': '#d06078',
    'particle-collider': '#72b98c',
    'particle-state': '#d0705a',
    geometry: '#c98f5a',
    palette: '#c45f9b',
    'scalar-feature': '#5f8fc4',
    'event-feature': '#5f8fc4',
    'event-stream': '#5f8fc4',
};

export const DEFAULT_PORT_COLOUR = '#7a7a82';

/** One accent per plugin category, so a node's role reads before its name does. */
export const CATEGORY_COLOURS: Readonly<Record<string, string>> = {
    source: '#3f7fa8',
    field: '#3f8a6a',
    simulator: '#a85f3f',
    transformer: '#7a5fa8',
    compositor: '#a8873f',
    postprocess: '#8a3f5f',
};

const EDITOR_CSS = `
.viz-editor {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    min-height: 0;
    background: #101013;
    border: 1px solid var(--line, #303036);
    border-bottom: none;
    border-radius: 0.5rem 0.5rem 0 0;
    color: #d8d8de;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.72rem;
    overflow: hidden;
    position: relative;
}

.viz-editor__grip {
    height: 8px;
    cursor: ns-resize;
    background: linear-gradient(#26262c, #17171b);
    border-bottom: 1px solid #26262c;
    flex: 0 0 auto;
}

.viz-editor__grip:hover { background: #2f2f38; }

.viz-editor__bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid #26262c;
    flex: 0 0 auto;
    flex-wrap: wrap;
}

.viz-editor__tabs { display: flex; gap: 0.25rem; }

.viz-editor__tab {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0.25rem;
    color: #9a9aa4;
    cursor: pointer;
    font: inherit;
    padding: 0.2rem 0.6rem;
}

.viz-editor__tab.is-active { background: #23232a; border-color: #34343d; color: #f0f0f4; }
.viz-editor__tab:hover { color: #f0f0f4; }

.viz-editor__spacer { flex: 1 1 auto; }

.viz-editor__action {
    background: #1c1c22;
    border: 1px solid #34343d;
    border-radius: 0.25rem;
    color: #d8d8de;
    cursor: pointer;
    font: inherit;
    padding: 0.2rem 0.6rem;
}

.viz-editor__action:hover:not(:disabled) { background: #2a2a33; }
.viz-editor__action:disabled { color: #5a5a63; cursor: default; }
.viz-editor__action.is-live { border-color: #4f9e78; color: #7fd6ab; }

.viz-editor__note { color: #8a8a94; }
.viz-editor__note.is-problem { color: #e0806a; }

.viz-editor__body { flex: 1 1 auto; min-height: 0; overflow: hidden; position: relative; }
.viz-editor__scroll { height: 100%; overflow: auto; padding: 0.6rem 0.75rem; }

.viz-editor__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #7a7a84;
    text-align: center;
    padding: 1rem;
}

.viz-editor__split { display: flex; height: 100%; min-height: 0; }
.viz-editor__canvas { position: relative; flex: 1 1 auto; min-width: 0; }

/* Manual graph copy ------------------------------------------------------ */

.viz-copy-modal__backdrop {
    position: absolute;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(5, 5, 8, 0.78);
}

.viz-copy-modal {
    width: min(760px, 100%);
    height: min(520px, 100%);
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    padding: 0.7rem;
    border: 1px solid #454552;
    border-radius: 0.35rem;
    background: #141419;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.65);
}

.viz-copy-modal__head { display: flex; align-items: center; gap: 0.5rem; }
.viz-copy-modal__head strong { color: #f0f0f4; }
.viz-copy-modal__head .viz-editor__action { margin-left: auto; }
.viz-copy-modal p { margin: 0; color: #9a9aa4; }

.viz-copy-modal__text {
    flex: 1 1 auto;
    min-height: 0;
    resize: none;
    padding: 0.5rem;
    border: 1px solid #32323b;
    border-radius: 0.25rem;
    background: #0b0b0e;
    color: #d8d8de;
    font: inherit;
    line-height: 1.4;
    white-space: pre;
}

/* Inspector -------------------------------------------------------------- */

.viz-inspector {
    flex: 0 0 264px;
    border-left: 1px solid #26262c;
    overflow-y: auto;
    padding: 0.5rem 0.6rem 1rem;
    background: #131317;
}

.viz-inspector__head {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid #26262c;
    margin-bottom: 0.5rem;
}

.viz-inspector__head strong { color: #f0f0f4; overflow-wrap: anywhere; }
.viz-inspector__head span { color: #8a8a94; font-size: 0.65rem; }

.viz-inspector__problems {
    background: #26130f;
    border: 1px solid #4a2c22;
    border-radius: 0.2rem;
    color: #e0806a;
    padding: 0.3rem 0.4rem;
    margin-bottom: 0.5rem;
}

.viz-inspector__group {
    border-bottom: 1px solid #1e1e24;
    padding-bottom: 0.4rem;
    margin-bottom: 0.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
}

.viz-inspector__row { display: flex; align-items: center; gap: 0.3rem; }
.viz-inspector__stack { display: flex; flex-direction: column; gap: 0.2rem; }
.viz-inspector__actions { display: flex; gap: 0.25rem; flex-wrap: wrap; }

.viz-inspector__label {
    color: #9a9aa4;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.viz-inspector__static { color: #b8b8c2; overflow-wrap: anywhere; text-align: right; }
.viz-inspector__live { color: #7fd6ab; font-variant-numeric: tabular-nums; }
.viz-inspector__check { color: #9a9aa4; white-space: nowrap; }

.viz-inspector__number {
    width: 68px;
    flex: 0 0 auto;
    background: #0d0d10;
    border: 1px solid #32323b;
    border-radius: 0.2rem;
    color: #e8e8ee;
    font: inherit;
    padding: 0.1rem 0.25rem;
    text-align: right;
}

.viz-inspector__number:disabled { color: #5a5a63; }

.viz-inspector__binding {
    border-left: 2px solid #4a4132;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding-left: 0.4rem;
}

.viz-inspector select {
    background: #0d0d10;
    border: 1px solid #32323b;
    border-radius: 0.2rem;
    color: #e8e8ee;
    font: inherit;
    min-width: 0;
    flex: 1 1 auto;
    padding: 0.1rem 0.2rem;
}

.viz-inspector__hint { color: #7a7a84; margin-top: 0.5rem; }

/* Node search ------------------------------------------------------------ */

.viz-search {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    width: min(420px, 90%);
    background: #17171c;
    border: 1px solid #3a3a45;
    border-radius: 0.3rem;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    z-index: 10;
    overflow: hidden;
}

.viz-search__input {
    width: 100%;
    background: #0d0d10;
    border: none;
    border-bottom: 1px solid #2a2a33;
    color: #f0f0f4;
    font: inherit;
    padding: 0.4rem 0.5rem;
}

.viz-search__input:focus { outline: 1px solid #4a6a8a; outline-offset: -1px; }

.viz-search__results { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow-y: auto; }

.viz-search__result {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    background: transparent;
    border: none;
    color: #d8d8de;
    cursor: pointer;
    font: inherit;
    padding: 0.22rem 0.5rem;
    text-align: left;
}

.viz-search__result.is-active { background: #24242c; }
.viz-search__swatch { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }
.viz-search__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.viz-search__category { color: #8a8a94; margin-left: auto; font-size: 0.65rem; }
.viz-search__empty { color: #7a7a84; padding: 0.4rem 0.5rem; }

/* Nodes ------------------------------------------------------------------ */

.viz-node {
    width: 240px;
    background: #17171c;
    border: 1px solid #32323b;
    border-radius: 0.3rem;
    overflow: hidden;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
}

.viz-node.is-selected { border-color: #7fa7c9; }
.viz-node.is-muted { opacity: 0.45; }
.viz-node.is-problem { border-color: #b45f45; }
.viz-node.is-kernel { background: #14181a; border-style: dashed; }
.viz-node.is-asset { background: #1a1714; }

.viz-node__title {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.3rem 0.5rem;
    background: #22222a;
    border-bottom: 1px solid #32323b;
    border-left: 3px solid var(--viz-node-accent, #4a4a55);
}

.viz-node__name {
    color: #f0f0f4;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.viz-node__kind { color: #8a8a94; font-size: 0.65rem; margin-left: auto; }

.viz-node__ports { display: flex; gap: 0.5rem; padding: 0.3rem 0; }
.viz-node__column { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 0.1rem; }
.viz-node__column.is-outputs { align-items: flex-end; text-align: right; }

.viz-node__port {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0 0.5rem;
    color: #b8b8c2;
    height: 18px;
    overflow: hidden;
    white-space: nowrap;
}

.viz-node__port.is-required.is-unconnected { color: #e0806a; }

.viz-node__params {
    border-top: 1px solid #26262c;
    padding: 0.25rem 0.5rem 0.35rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
}

.viz-node__param { display: flex; align-items: center; gap: 0.4rem; }
.viz-node__param-name { color: #9a9aa4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.viz-node__param-value { margin-left: auto; color: #d8d8de; font-variant-numeric: tabular-nums; }
.viz-node__param-value.is-live { color: #7fd6ab; }
.viz-node__param-value.is-unpinned { color: #6a6a74; }
.viz-node__param-feature {
    color: #c9a35f;
    font-size: 0.65rem;
    border: 1px solid #4a4132;
    border-radius: 0.2rem;
    padding: 0 0.2rem;
}

.viz-node__problems {
    border-top: 1px solid #4a2c22;
    background: #26130f;
    color: #e0806a;
    padding: 0.25rem 0.5rem;
    white-space: normal;
}

/* React Flow overrides --------------------------------------------------- */

.viz-editor .react-flow { background: #0b0b0e; }
.viz-editor .react-flow__node { font-family: inherit; font-size: inherit; }
.viz-editor .react-flow__handle {
    width: 9px;
    height: 9px;
    border: 1px solid #101013;
    min-width: 0;
    min-height: 0;
}
.viz-editor .react-flow__handle.is-parameter { border-radius: 2px; }
.viz-editor .react-flow__edge-path { stroke-width: 1.5; }
/* A link cannot land where it cannot connect, so the sockets that would refuse it recede. */
.viz-editor .react-flow__handle.connectingfrom,
.viz-editor .react-flow__handle.valid { box-shadow: 0 0 0 3px rgba(127, 214, 171, 0.35); }
.viz-editor .react-flow__controls-button {
    background: #1c1c22;
    border-bottom: 1px solid #32323b;
    fill: #d8d8de;
}
.viz-editor .react-flow__attribution { background: transparent; color: #4a4a55; }
`;

/**
 * Puts the editor's styles in the document while it is mounted.
 *
 * Reference counted, because the dock can be torn down and rebuilt while the canvas keeps rendering
 * and a second mount must not find the styles gone.
 */
let mounted = 0;

export function useEditorStyles(): void {
    useEffect(() => {
        mounted += 1;

        if (typeof document !== 'undefined' && !document.getElementById(STYLE_ELEMENT_ID)) {
            const element = document.createElement('style');
            element.id = STYLE_ELEMENT_ID;
            element.textContent = `${reactFlowStyles}\n${EDITOR_CSS}`;
            document.head.append(element);
        }

        return () => {
            mounted -= 1;
            if (mounted === 0) {
                document.getElementById(STYLE_ELEMENT_ID)?.remove();
            }
        };
    }, []);
}
