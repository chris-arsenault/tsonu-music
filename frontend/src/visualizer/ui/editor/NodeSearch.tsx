/**
 * The add-a-node search.
 *
 * Opened by double-clicking the canvas, or by dropping a link on empty space — in which case it is
 * filtered to plugins that could actually take that link, which is the ComfyUI behaviour and the one
 * that makes a catalog of a hundred and fifty plugins usable.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { portsCompatible } from '../../core/graph';
import type { PluginCategory, PortType, VisualPluginDefinition } from '../../core/plugin';
import { CATEGORY_COLOURS } from './editor-styles';

export interface NodeSearchProps {
    catalog: readonly VisualPluginDefinition[];
    /** Restricts results to plugins with an input this type satisfies. */
    acceptingType?: PortType;
    onPick: (definition: VisualPluginDefinition, port?: string) => void;
    onClose: () => void;
}

const RESULT_LIMIT = 40;

export default function NodeSearch({ catalog, acceptingType, onPick, onClose }: NodeSearchProps) {
    const [query, setQuery] = useState('');
    const [highlighted, setHighlighted] = useState(0);
    const input = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        input.current?.focus();
    }, []);

    const results = useMemo(() => {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

        return catalog
            .map((definition) => ({
                definition,
                port: acceptingType
                    ? definition.inputs.find((input_) => portsCompatible(acceptingType, input_.type))?.name
                    : undefined,
            }))
            // When a link is being dropped, a plugin that cannot take it is not a result.
            .filter((entry) => !acceptingType || entry.port !== undefined)
            .filter((entry) => terms.every((term) =>
                entry.definition.id.toLowerCase().includes(term)
                || entry.definition.category.includes(term)))
            .slice(0, RESULT_LIMIT);
    }, [catalog, acceptingType, query]);

    const choose = (index: number) => {
        const entry = results[index];
        if (entry) {
            onPick(entry.definition, entry.port);
        }
    };

    return (
        <div className="viz-search" role="dialog" aria-label="Add a node">
            <input
                ref={input}
                className="viz-search__input"
                value={query}
                placeholder={acceptingType ? `plugins taking ${acceptingType}` : 'search the catalog'}
                onChange={(event) => {
                    setQuery(event.currentTarget.value);
                    setHighlighted(0);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        // The modal closes the visualizer on Escape from `window`, which is not what
                        // dismissing a search box should do.
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
                    <li key={entry.definition.id}>
                        <button
                            type="button"
                            className={`viz-search__result${index === highlighted ? ' is-active' : ''}`}
                            onMouseEnter={() => setHighlighted(index)}
                            onClick={() => choose(index)}
                        >
                            <span
                                className="viz-search__swatch"
                                style={{ background: accentFor(entry.definition.category) }}
                            />
                            <span className="viz-search__name">{entry.definition.id}</span>
                            <span className="viz-search__category">
                                {entry.port ?? entry.definition.category}
                            </span>
                        </button>
                    </li>
                ))}
                {results.length === 0 ? (
                    <li className="viz-search__empty">
                        {acceptingType ? `nothing takes a ${acceptingType}` : 'no match'}
                    </li>
                ) : null}
            </ul>
        </div>
    );
}

function accentFor(category: PluginCategory): string {
    return CATEGORY_COLOURS[category] ?? '#4a4a55';
}
