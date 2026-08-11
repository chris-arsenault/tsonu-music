/**
 * Entry point for the headless render harness.
 *
 * Reads its parameters from the query string so one page serves any run, measures each scene in turn,
 * and writes the results into the DOM for the reader to pick up. Nothing here is interactive: the
 * page exists to be loaded by a browser that will be closed as soon as it finishes.
 */

import { measureScene, type SceneMeasurement } from './measure';
import { runFixtureMatrix } from './fixtures';

const parameters = new URLSearchParams(location.search);
/** `scenes` measures generated scenes as before; `fixtures` runs the combine-operator matrix. */
const mode = parameters.get('mode') ?? 'scenes';
const count = Number(parameters.get('scenes') ?? 8);
const seconds = Number(parameters.get('seconds') ?? 12);
const fps = Number(parameters.get('fps') ?? 60);
const width = Number(parameters.get('width') ?? 320);
const height = Number(parameters.get('height') ?? 180);
const sampleInterval = Number(parameters.get('interval') ?? 0.25);
/** Repeat the audio exactly on this period, so history can be told apart from the music. */
const periodSeconds = Number(parameters.get('period') ?? 0);
const prefix = parameters.get('prefix') ?? 'harness';

const output = document.getElementById('results')!;

async function run(): Promise<void> {
    const results: (SceneMeasurement | { entropy: string; error: string })[] = [];

    for (let index = 0; index < count; index += 1) {
        const entropy = `${prefix}-${index}`;
        try {
            const options = { entropy, seconds, fps, width, height, sampleInterval, periodSeconds };
            const measured = measureScene(options);

            // The same scene without its memory, so the period divergence has something to be
            // compared against. Only worth paying for when the run is measuring path dependence.
            if (periodSeconds > 0) {
                const control = measureScene({ ...options, withoutHistory: true });
                measured.withoutHistory = control.periodDivergence;
            }

            results.push(measured);
        } catch (error) {
            results.push({ entropy, error: error instanceof Error ? error.message : String(error) });
        }

        // Yielded between scenes so a long run does not trip the browser's unresponsive-page
        // handling, and so each scene's context is released before the next allocates one.
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    output.textContent = JSON.stringify(results);
    output.dataset.state = 'done';
}

async function runFixtures(): Promise<void> {
    const report = await runFixtureMatrix({ fps, width, height });
    output.textContent = JSON.stringify(report);
    output.dataset.state = 'done';
}

(mode === 'fixtures' ? runFixtures() : run()).catch((error) => {
    output.textContent = JSON.stringify({ error: String(error) });
    output.dataset.state = 'failed';
});
