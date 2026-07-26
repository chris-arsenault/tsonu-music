/**
 * The selected node's controls.
 *
 * A binding carries eight fields and a node carries a dozen parameters, which is more than fits on a
 * node without turning the graph into a wall of inputs. The canvas answers what is connected to what;
 * this answers what any of it is set to. ComfyUI splits the same way, and for the same reason.
 *
 * Presentational: every control reports an intent and none of them decides anything. The document
 * edits live in `core/authored-scene-edit.ts` and the gesture translation in `core/editor-actions.ts`.
 */

import type { ChangeEvent } from 'react';
import { BINDABLE_FEATURES, isEventFeature } from '../../core/audio-mapping';
import type { BindingCurve, BindingMode, ParameterBinding } from '../../core/bindings';
import type { EditorNode, EditorParameterRow } from '../../core/editor-view';
import { isPinned } from '../../core/editor-view';
import type { BlendMode } from '../../core/passes';
import { formatValue } from './GraphNodeBody';

const CURVES: readonly BindingCurve[] = ['linear', 'smooth', 'square', 'sqrt', 'exponential'];
const MODES: readonly BindingMode[] = ['value', 'rate', 'impulse'];
const BLEND_MODES: readonly BlendMode[] = [
    'normal', 'add', 'screen', 'multiply', 'difference', 'lighten', 'darken',
];

export interface InspectorProps {
    node: EditorNode;
    /** Absent while the scheduler owns the scene, when nothing here is editable. */
    editable: boolean;
    onParameter: (parameter: string, value: number) => void;
    onBinding: (parameter: string, binding: ParameterBinding | undefined) => void;
    onPromote: (parameter: string, promoted: boolean) => void;
    onMute: (muted: boolean) => void;
    onSeed: (seed: number | undefined) => void;
    onClone: () => void;
    onRemove: () => void;
    onLayerOverride: (layerId: string, blendMode: BlendMode | undefined, opacity: number | undefined) => void;
    /** The layer overrides in force, so the composite stage can show what it is being told. */
    layerOverrides?: Readonly<Record<string, { blendMode?: BlendMode; opacity?: number }>>;
}

export default function Inspector(props: InspectorProps) {
    const { node, editable } = props;

    return (
        <aside className="viz-inspector" aria-label="Selected node">
            <header className="viz-inspector__head">
                <strong>{node.title}</strong>
                <span>{node.subtitle}</span>
            </header>

            {node.problems.length > 0 ? (
                <div className="viz-inspector__problems">
                    {node.problems.map((problem) => <div key={problem}>{problem}</div>)}
                </div>
            ) : null}

            {node.kind === 'plugin' ? <PluginControls {...props} /> : null}
            {node.kind === 'kernel' ? <KernelControls {...props} /> : null}

            {node.details && node.details.length > 0 ? (
                <div className="viz-inspector__group">
                    {node.details.map((detail) => (
                        <div className="viz-inspector__row" key={detail.label}>
                            <span className="viz-inspector__label">{detail.label}</span>
                            <span className="viz-inspector__static">{detail.value}</span>
                        </div>
                    ))}
                </div>
            ) : null}

            {node.parameters.map((row) => (
                <ParameterControls key={row.name} row={row} {...props} />
            ))}

            {!editable ? (
                <p className="viz-inspector__hint">
                    Capture the scene to edit it. While the scheduler owns the graph these are a
                    readout.
                </p>
            ) : null}
        </aside>
    );
}

function PluginControls({ node, editable, onMute, onSeed, onClone, onRemove }: InspectorProps) {
    return (
        <div className="viz-inspector__group">
            <div className="viz-inspector__actions">
                <button
                    type="button"
                    className={`viz-editor__action${node.muted ? ' is-live' : ''}`}
                    disabled={!editable}
                    onClick={() => onMute(!node.muted)}
                >
                    {node.muted ? 'Unmute' : 'Mute'}
                </button>
                <button type="button" className="viz-editor__action" disabled={!editable} onClick={onClone}>
                    Clone
                </button>
                <button type="button" className="viz-editor__action" disabled={!editable} onClick={onRemove}>
                    Remove
                </button>
            </div>

            <div className="viz-inspector__row">
                <span className="viz-inspector__label" title="Random identity for this instance">
                    seed
                </span>
                <button
                    type="button"
                    className="viz-editor__action"
                    disabled={!editable}
                    // A fresh draw rather than an increment: the seed separates oscillator phases and
                    // spatial offsets, and neighbouring values are not meaningfully different.
                    onClick={() => onSeed(Math.random())}
                >
                    Reroll
                </button>
                <button
                    type="button"
                    className="viz-editor__action"
                    disabled={!editable}
                    onClick={() => onSeed(undefined)}
                    title="Return to the identity derived from the scene entropy"
                >
                    Release
                </button>
            </div>
        </div>
    );
}

/**
 * The composite stage's per-layer controls.
 *
 * Blend mode and opacity are chosen *for* a layer from the plugin's declared character, so this is
 * where a branch that vanished into an `add` over a bright base can be made to composite instead.
 */
function KernelControls({ node, editable, layerOverrides, onLayerOverride }: InspectorProps) {
    if (node.id !== 'kernel:composite') {
        return null;
    }

    return (
        <div className="viz-inspector__group">
            {node.inputs.map((port) => {
                const override = layerOverrides?.[port.name] ?? {};

                return (
                    <div className="viz-inspector__stack" key={port.name}>
                        <span className="viz-inspector__label" title={port.name}>{port.name}</span>
                        <div className="viz-inspector__row">
                            <select
                                value={override.blendMode ?? ''}
                                disabled={!editable}
                                onChange={(event) => onLayerOverride(
                                    port.name,
                                    (event.currentTarget.value || undefined) as BlendMode | undefined,
                                    override.opacity,
                                )}
                            >
                                <option value="">from character</option>
                                {BLEND_MODES.map((mode) => (
                                    <option key={mode} value={mode}>{mode}</option>
                                ))}
                            </select>
                            <NumberInput
                                value={override.opacity}
                                placeholder="opacity"
                                disabled={!editable}
                                onChange={(value) => onLayerOverride(port.name, override.blendMode, value)}
                            />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function ParameterControls({
    row,
    node,
    editable,
    onParameter,
    onBinding,
    onPromote,
}: InspectorProps & { row: EditorParameterRow }) {
    const binding = row.binding;

    return (
        <div className="viz-inspector__group">
            <div className="viz-inspector__row">
                <span className="viz-inspector__label" title={row.name}>{row.name}</span>
                {row.live !== undefined ? (
                    <span className="viz-inspector__live">{formatValue(row.live)}</span>
                ) : null}
                <NumberInput
                    value={isPinned(row) ? row.value : undefined}
                    // Only ever visible on an unpinned kernel value, which is the one place a blank
                    // field means "the kernel decides" rather than "nobody has typed anything".
                    placeholder={isPinned(row) ? undefined : 'auto'}
                    // A bound parameter is resolved from its binding every frame, so writing the
                    // constant only sets where it starts. Saying so beats a control that appears to
                    // do nothing.
                    title={binding ? 'the starting value; the binding drives it from there' : undefined}
                    disabled={!editable}
                    onChange={(value) => value !== undefined && onParameter(row.name, value)}
                />
            </div>

            {node.kind === 'plugin' ? (
                <div className="viz-inspector__actions">
                    <button
                        type="button"
                        className="viz-editor__action"
                        disabled={!editable}
                        onClick={() => onPromote(row.name, true)}
                        title="Show this parameter as a socket on the node"
                    >
                        To input
                    </button>
                    <button
                        type="button"
                        className="viz-editor__action"
                        disabled={!editable}
                        onClick={() => onBinding(row.name, binding ? undefined : defaultBinding(row.name))}
                    >
                        {binding ? 'Unbind' : 'Bind'}
                    </button>
                </div>
            ) : null}

            {binding ? (
                <BindingControls
                    binding={binding}
                    editable={editable}
                    onChange={(next) => onBinding(row.name, next)}
                />
            ) : null}
        </div>
    );
}

function BindingControls({
    binding,
    editable,
    onChange,
}: {
    binding: ParameterBinding;
    editable: boolean;
    onChange: (binding: ParameterBinding) => void;
}) {
    const set = (patch: Partial<ParameterBinding>) => onChange({ ...binding, ...patch });
    const mode = binding.mode ?? 'value';

    return (
        <div className="viz-inspector__binding">
            <div className="viz-inspector__row">
                <select
                    value={binding.feature}
                    disabled={!editable}
                    onChange={(event) => {
                        const feature = event.currentTarget.value;
                        // An impulse reads the event channels and a value reads the continuous bus, so
                        // moving between them without the mode following leaves the binding reading a
                        // channel that never fires.
                        set({
                            feature,
                            mode: isEventFeature(feature)
                                ? 'impulse'
                                : (mode === 'impulse' ? 'value' : mode),
                        });
                    }}
                >
                    {BINDABLE_FEATURES.map((feature) => (
                        <option key={feature} value={feature}>{feature}</option>
                    ))}
                </select>
                <select
                    value={mode}
                    disabled={!editable}
                    onChange={(event) => set({ mode: event.currentTarget.value as BindingMode })}
                >
                    {MODES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </select>
            </div>

            <div className="viz-inspector__row">
                <span className="viz-inspector__label">range</span>
                <NumberInput
                    value={binding.outputRange[0]}
                    disabled={!editable}
                    onChange={(value) => value !== undefined
                        && set({ outputRange: [value, binding.outputRange[1]] })}
                />
                <NumberInput
                    value={binding.outputRange[1]}
                    disabled={!editable}
                    onChange={(value) => value !== undefined
                        && set({ outputRange: [binding.outputRange[0], value] })}
                />
            </div>

            <div className="viz-inspector__row">
                <span className="viz-inspector__label">attack / release</span>
                <NumberInput
                    value={binding.attack}
                    disabled={!editable}
                    onChange={(value) => value !== undefined && set({ attack: value })}
                />
                <NumberInput
                    value={binding.release}
                    disabled={!editable}
                    onChange={(value) => value !== undefined && set({ release: value })}
                />
            </div>

            <div className="viz-inspector__row">
                <select
                    value={binding.curve}
                    disabled={!editable}
                    onChange={(event) => set({ curve: event.currentTarget.value as BindingCurve })}
                >
                    {CURVES.map((curve) => <option key={curve} value={curve}>{curve}</option>)}
                </select>
                <label className="viz-inspector__check">
                    <input
                        type="checkbox"
                        checked={binding.polarity === -1}
                        disabled={!editable}
                        onChange={(event) => set({ polarity: event.currentTarget.checked ? -1 : 1 })}
                    />
                    {' '}invert
                </label>
            </div>
        </div>
    );
}

/**
 * A binding for a parameter that had none.
 *
 * Zero to one over the parameter's own scale is wrong more often than not, but it is visible and it
 * is a starting point; the range is the first thing anybody changes.
 */
export function defaultBinding(parameter: string): ParameterBinding {
    return {
        feature: 'rms',
        parameter,
        outputRange: [0, 1],
        attack: 0.1,
        release: 0.3,
        curve: 'linear',
    };
}

/**
 * A number field that lets you type.
 *
 * Committed on blur and on Enter rather than on every keystroke: parsing as you type turns `0.` into
 * `0` and makes it impossible to enter a decimal, and an empty field mid-edit is not a request to set
 * the value to zero.
 */
function NumberInput({
    value,
    onChange,
    disabled,
    placeholder,
    title,
}: {
    value: number | undefined;
    onChange: (value: number | undefined) => void;
    disabled?: boolean;
    placeholder?: string;
    title?: string;
}) {
    const commit = (event: ChangeEvent<HTMLInputElement> | { currentTarget: HTMLInputElement }) => {
        const text = event.currentTarget.value.trim();
        if (text === '') {
            onChange(undefined);
            return;
        }

        const parsed = Number(text);
        if (Number.isFinite(parsed)) {
            onChange(parsed);
        }
    };

    return (
        <input
            className="viz-inspector__number"
            type="text"
            inputMode="decimal"
            defaultValue={value === undefined ? '' : String(round(value))}
            key={value === undefined ? 'auto' : round(value)}
            placeholder={placeholder}
            title={title}
            disabled={disabled}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === 'Enter') {
                    commit(event);
                }
            }}
        />
    );
}

/** Trims the float noise a scaled range leaves behind, without changing what the number means. */
function round(value: number): number {
    return Number(value.toPrecision(6));
}
