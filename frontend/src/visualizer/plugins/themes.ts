/**
 * Themes (spec section 16).
 *
 * A theme is constraints and weighted preferences, not a fixed pipeline: it says what kind of scene it
 * wants and lets the scheduler assemble one. Fresh scene entropy gives each activation a different
 * composition with the same broad character.
 */

import {
    COLLISION_ENERGY,
    GEOMETRIC_SIGNAL,
    IMAGE_DREAM,
    ORGANIC_FLOW,
} from '../core/grammar';
import { DEFAULT_MUTATION_POLICY, type VisualTheme } from '../core/scheduler';

export const GEOMETRIC_SIGNAL_THEME: VisualTheme = {
    id: 'geometric-signal',
    grammar: GEOMETRIC_SIGNAL,
    targetCharacter: {
        geometricOrder: 0.85,
        visualDensity: 0.3,
        motionEnergy: 0.55,
        recognizability: 0.2,
        brightness: 0.6,
    },
    mutationPolicy: DEFAULT_MUTATION_POLICY,
    colorPolicy: { source: 'curated', strength: 0.7 },
};

export const ORGANIC_FLOW_THEME: VisualTheme = {
    id: 'organic-flow',
    grammar: ORGANIC_FLOW,
    targetCharacter: {
        geometricOrder: 0.25,
        visualDensity: 0.6,
        motionEnergy: 0.5,
        persistence: 0.8,
        brightness: 0.45,
    },
    // Slower structural mutation: the family is about accumulation, while continuous parameter motion
    // still keeps every layer breathing between swaps. Slower than the default, not four times it —
    // these intervals were set when a branch mutation discarded the whole scene, so they were pacing
    // how often the image was allowed to be thrown away. A swap that leaves the rest of the graph
    // running does not need to be rationed like that.
    mutationPolicy: { ...DEFAULT_MUTATION_POLICY, intervalSeconds: 8 },
    colorPolicy: { source: 'album-palette', strength: 0.8 },
};

export const COLLISION_ENERGY_THEME: VisualTheme = {
    id: 'collision-energy',
    grammar: COLLISION_ENERGY,
    targetCharacter: {
        motionEnergy: 0.9,
        visualDensity: 0.7,
        geometricOrder: 0.3,
        brightness: 0.75,
        persistence: 0.3,
    },
    mutationPolicy: { ...DEFAULT_MUTATION_POLICY, intervalSeconds: 4 },
    colorPolicy: { source: 'complementary', strength: 0.6 },
};

export const IMAGE_DREAM_THEME: VisualTheme = {
    id: 'image-dream',
    grammar: IMAGE_DREAM,
    targetCharacter: {
        recognizability: 0.7,
        persistence: 0.75,
        motionEnergy: 0.35,
        geometricOrder: 0.4,
        brightness: 0.5,
    },
    mutationPolicy: { ...DEFAULT_MUTATION_POLICY, intervalSeconds: 7 },
    colorPolicy: { source: 'album-palette', strength: 0.9 },
};

export const THEMES: readonly VisualTheme[] = [
    GEOMETRIC_SIGNAL_THEME,
    ORGANIC_FLOW_THEME,
    COLLISION_ENERGY_THEME,
    IMAGE_DREAM_THEME,
];

export function themeById(id: string): VisualTheme | undefined {
    return THEMES.find((theme) => theme.id === id);
}

/**
 * Themes that can be satisfied by the plugins currently registered.
 *
 * Until the catalog is complete most themes cannot be built — collision energy needs a simulator, image
 * dream needs album-art sources. Filtering here is what keeps the scheduler from assembling a scene
 * that fails its own grammar.
 */
export function satisfiableThemes(
    availableCategories: ReadonlySet<string>,
): VisualTheme[] {
    return THEMES.filter((theme) => {
        if (theme.grammar.simulatorCount[0] > 0 && !availableCategories.has('simulator')) {
            return false;
        }
        if (theme.grammar.fieldCount[0] > 0 && !availableCategories.has('field')) {
            return false;
        }
        if (theme.grammar.sourceCount[0] > 0 && !availableCategories.has('source')) {
            return false;
        }
        if (theme.grammar.postprocessCount[0] > 0 && !availableCategories.has('postprocess')) {
            return false;
        }
        if (theme.grammar.transformerCount[0] > 0 && !availableCategories.has('transformer')) {
            return false;
        }
        if (theme.grammar.compositorCount[0] > 0 && !availableCategories.has('compositor')) {
            return false;
        }

        return true;
    });
}
