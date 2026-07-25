import { describe, expect, test } from 'vitest';
import {
    createDiagnosticsControls,
    formatBytes,
    isPluginDisabled,
    MAX_ACTIVATION_HISTORY,
    recordActivation,
    simulationDelta,
    togglePluginDisabled,
} from './diagnostics';

describe('diagnostics controls', () => {
    test('start with nothing frozen and nothing disabled', () => {
        const controls = createDiagnosticsControls();

        expect(controls.freezeMutations).toBe(false);
        expect(controls.freezeSimulation).toBe(false);
        expect(controls.disabledPlugins).toEqual([]);
        expect(controls.inspectResource).toBeUndefined();
        expect(controls.overrideSeed).toBeUndefined();
    });

    test('freezing simulation passes zero delta, exactly as a frozen clock does', () => {
        const running = createDiagnosticsControls();
        const frozen = { ...running, freezeSimulation: true };

        expect(simulationDelta(running, 1 / 60)).toBeCloseTo(1 / 60, 10);
        // No plugin needs to know the overlay exists; zero delta is already handled everywhere.
        expect(simulationDelta(frozen, 1 / 60)).toBe(0);
    });

    test('disabling a plugin toggles rather than accumulating duplicates', () => {
        let controls = createDiagnosticsControls();

        controls = togglePluginDisabled(controls, 'plugin#1');
        expect(isPluginDisabled(controls, 'plugin#1')).toBe(true);

        controls = togglePluginDisabled(controls, 'plugin#1');
        expect(isPluginDisabled(controls, 'plugin#1')).toBe(false);
        expect(controls.disabledPlugins).toEqual([]);
    });

    test('several plugins can be disabled independently', () => {
        let controls = createDiagnosticsControls();
        controls = togglePluginDisabled(controls, 'a#0');
        controls = togglePluginDisabled(controls, 'b#1');

        expect(controls.disabledPlugins).toEqual(['a#0', 'b#1']);

        controls = togglePluginDisabled(controls, 'a#0');
        expect(controls.disabledPlugins).toEqual(['b#1']);
    });

    test('an unrelated plugin is never reported as disabled', () => {
        const controls = togglePluginDisabled(createDiagnosticsControls(), 'a#0');

        expect(isPluginDisabled(controls, 'b#1')).toBe(false);
    });

    test('controls are immutable, so a stale reference cannot mutate live state', () => {
        const original = createDiagnosticsControls();
        const toggled = togglePluginDisabled(original, 'a#0');

        expect(original.disabledPlugins).toEqual([]);
        expect(toggled).not.toBe(original);
    });
});

describe('activation history', () => {
    test('records in order, newest last', () => {
        let history: string[] = [];
        history = recordActivation(history, 'first');
        history = recordActivation(history, 'second');

        expect(history).toEqual(['first', 'second']);
    });

    test('stays bounded across a long session', () => {
        let history: string[] = [];

        for (let index = 0; index < MAX_ACTIVATION_HISTORY * 3; index += 1) {
            history = recordActivation(history, `plugin#${index}`);
        }

        expect(history).toHaveLength(MAX_ACTIVATION_HISTORY);
        // The most recent are kept, since those are the ones worth inspecting.
        expect(history[history.length - 1]).toBe(`plugin#${MAX_ACTIVATION_HISTORY * 3 - 1}`);
    });

    test('the same plugin reactivating is recorded again', () => {
        let history = recordActivation([], 'a#0');
        history = recordActivation(history, 'a#0');

        expect(history).toEqual(['a#0', 'a#0']);
    });
});

describe('formatting', () => {
    test('scales byte counts for reading', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(2048)).toBe('2 KB');
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    });

    test('zero and boundary values format sensibly', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(1024)).toBe('1 KB');
        expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    });
});
