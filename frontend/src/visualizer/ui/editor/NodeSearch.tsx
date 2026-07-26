/**
 * The add-a-node search.
 *
 * Opened from Add node or by double-clicking the canvas. Dropping a link on empty space opens it
 * filtered to plugins that could actually take that link, which is the ComfyUI behaviour and the one
 * that makes a catalog of a hundred and fifty plugins usable.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { portsCompatible } from '../../core/graph';
import type { PluginCategory, PortType, VisualPluginDefinition } from '../../core/plugin';
import { CATEGORY_COLOURS } from './editor-styles';

/** The side a newly chosen node must contribute to finish a connection dropped on the pane. */
export interface NodeSearchPortFilter {
    kind: 'input' | 'output';
    type: PortType;
}

export interface NodeSearchAsset {
    resource: string;
    name: string;
    type: PortType;
}

export interface NodeSearchProps {
    catalog: readonly VisualPluginDefinition[];
    /** Loaded host assets. They are offered only when they can finish an input-origin connection. */
    assets?: readonly NodeSearchAsset[];
    /** Restricts results to plugins with a compatible port on the required side. */
    portFilter?: NodeSearchPortFilter;
    onPick: (definition: VisualPluginDefinition, port?: string) => void;
    onPickAsset?: (asset: NodeSearchAsset) => void;
    onClose: () => void;
}

const RESULT_LIMIT = 40;

export function dismissNodeSearch(
    event: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopImmediatePropagation'>,
    onClose: () => void,
): boolean {
    if (event.key !== 'Escape') {
        return false;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    onClose();
    return true;
}

export default function NodeSearch({
    catalog,
    assets = [],
    portFilter,
    onPick,
    onPickAsset,
    onClose,
}: NodeSearchProps) {
    const [query, setQuery] = useState('');
    const [highlighted, setHighlighted] = useState(0);
    const input = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        input.current?.focus();
    }, []);

    useEffect(() => {
        const dismiss = (event: KeyboardEvent) => {
            // Capture at window so the visualizer modal's own Escape listener never sees this key.
            // No result is chosen: Escape is dismissal only.
            dismissNodeSearch(event, onClose);
        };

        window.addEventListener('keydown', dismiss, { capture: true });
        return () => window.removeEventListener('keydown', dismiss, { capture: true });
    }, [onClose]);

    const results = useMemo(() => {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

        const plugins = catalog
            .map((definition) => ({
                kind: 'plugin' as const,
                definition,
                port: portFilter
                    ? (portFilter.kind === 'input'
                        ? definition.inputs.find((input_) =>
                            portsCompatible(portFilter.type, input_.type))?.name
                        : definition.outputs.find((output) =>
                            portsCompatible(output.type, portFilter.type))?.name)
                    : undefined,
            }))
            // When a link is being dropped, a plugin that cannot take it is not a result.
            .filter((entry) => !portFilter || entry.port !== undefined)
            .filter((entry) => terms.every((term) =>
                entry.definition.id.toLowerCase().includes(term)
                || entry.definition.category.includes(term)));

        const hostAssets = portFilter?.kind === 'output'
            ? assets
                .filter((asset) => portsCompatible(asset.type, portFilter.type))
                .map((asset) => ({ kind: 'asset' as const, asset }))
                .filter((entry) => terms.every((term) =>
                    entry.asset.name.toLowerCase().includes(term)
                    || 'asset'.includes(term)))
            : [];

        return [...hostAssets, ...plugins].slice(0, RESULT_LIMIT);
    }, [assets, catalog, portFilter, query]);

    const choose = (index: number) => {
        const entry = results[index];
        if (entry?.kind === 'plugin') {
            onPick(entry.definition, entry.port);
        } else if (entry?.kind === 'asset') {
            onPickAsset?.(entry.asset);
        }
    };

    return (
        <div className="viz-search" role="dialog" aria-label="Add a node">
            <input
                ref={input}
                className="viz-search__input"
                value={query}
                placeholder={portFilter
                    ? `plugins ${portFilter.kind === 'input' ? 'taking' : 'producing'} ${portFilter.type}`
                    : 'search the catalog'}
                onChange={(event) => {
                    setQuery(event.currentTarget.value);
                    setHighlighted(0);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        onClose();
                    } else if (event.key === 'Enter') {
                        choose(highlighted);
                    } else if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setHighlighted((index) => Math.min(results.length - 1, index + 1));
                    } else if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        setHighlighted((index) => Math.max(0, index - 1));
                    }
                }}
            />

            <ul className="viz-search__results">
                {results.map((entry, index) => (
                    <li key={entry.kind === 'plugin'
                        ? `plugin:${entry.definition.id}`
                        : `asset:${entry.asset.resource}`}
                    >
                        <button
                            type="button"
                            className={`viz-search__result${index === highlighted ? ' is-active' : ''}`}
                            onMouseEnter={() => setHighlighted(index)}
                            onClick={() => choose(index)}
                        >
                            <span
                                className="viz-search__swatch"
                                style={{
                                    background: entry.kind === 'plugin'
                                        ? accentFor(entry.definition.category)
                                        : '#8a6a3f',
                                }}
                            />
                            <span className="viz-search__name">
                                {entry.kind === 'plugin' ? entry.definition.id : entry.asset.name}
                            </span>
                            <span className="viz-search__category">
                                {entry.kind === 'plugin'
                                    ? entry.port ?? entry.definition.category
                                    : 'asset'}
                            </span>
                        </button>
                    </li>
                ))}
                {results.length === 0 ? (
                    <li className="viz-search__empty">
                        {portFilter
                            ? `nothing ${portFilter.kind === 'input' ? 'takes' : 'produces'} a ${portFilter.type}`
                            : 'no match'}
                    </li>
                ) : null}
            </ul>
        </div>
    );
}

function accentFor(category: PluginCategory): string {
    return CATEGORY_COLOURS[category] ?? '#4a4a55';
}
