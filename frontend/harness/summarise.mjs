/**
 * Turns a harness run into something readable, and writes the captured frames out as PNGs.
 *
 *   node harness/run.mjs --scenes 12 --seconds 12 > run.json
 *   node harness/summarise.mjs run.json /tmp/frames
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , inputPath, frameDirectory] = process.argv;
const results = JSON.parse(readFileSync(inputPath, 'utf8'));

if (frameDirectory) {
    mkdirSync(frameDirectory, { recursive: true });
}

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
};

const rows = [];

for (const result of results) {
    if (result.error) {
        rows.push(`${result.entropy}  FAILED  ${result.error}`);
        continue;
    }

    if (frameDirectory && result.lastFrame) {
        writeFileSync(
            join(frameDirectory, `${result.entropy}.png`),
            Buffer.from(result.lastFrame.split(',')[1], 'base64'),
        );
    }

    // The scene beside its frame, so a measurement can be opened in the Lab and judged rather than
    // trusted. A statistic saying one scene remembers longer is not a claim that it is worth
    // watching, and nothing here can tell the difference.
    if (frameDirectory && result.document) {
        writeFileSync(
            join(frameDirectory, `${result.entropy}.json`),
            JSON.stringify(result.document, null, 2),
        );
    }

    // Steady state only: the first samples are before anything has been drawn.
    const settled = (values) => values.slice(Math.floor(values.length / 3));

    const lag = (seconds) => result.lags.find((entry) => entry.seconds === seconds);
    const one = lag(1);
    const two = lag(2);

    // How much of the picture is remembered rather than replayed, against the per-frame change as a
    // floor. Only meaningful when the run was given a period.
    const divergence = result.periodDivergence ?? [];
    const floor = median(settled(result.changeRate));
    const drift = divergence.length > 0
        ? `  P1=${divergence[0].difference.toFixed(4)}`
            + (divergence[2] ? ` P3=${divergence[2].difference.toFixed(4)}` : '')
            + ` floor=${floor.toFixed(4)}`
        : '';

    rows.push([
        result.entropy.padEnd(12),
        result.themeId.padEnd(17),
        `lum=${median(settled(result.luminance)).toFixed(3)}`,
        `cov=${median(settled(result.coverage)).toFixed(2)}`,
        `chg=${median(settled(result.changeRate)).toFixed(4)}`,
        one ? `r1=${one.correlation.toFixed(2)}` : 'r1=—',
        two ? `r2=${two.correlation.toFixed(2)}` : 'r2=—',
        // The measurement that separates flow from a pulse: how far the best-aligning shift moves,
        // as a fraction of the frame, and how much aligning improves the match.
        one ? `disp1=${one.displacement.toFixed(3)}` : '',
        two ? `disp2=${two.displacement.toFixed(3)}` : '',
        two ? `zoom2=${two.scale.toFixed(3)}` : '',
        one ? `gain1=${(one.alignedCorrelation - one.correlation).toFixed(3)}` : '',
    ].join('  ') + drift);
}

console.log(rows.join('\n'));

const usable = results.filter((result) => !result.error && result.lags.length > 0);
if (usable.length > 0) {
    const travelAt = (seconds) => usable
        .map((result) => result.lags.find((entry) => entry.seconds === seconds)?.displacement ?? 0);
    const gainAt = (seconds) => usable
        .map((result) => {
            const lag = result.lags.find((entry) => entry.seconds === seconds);
            return lag ? lag.alignedCorrelation - lag.correlation : 0;
        });
    const corrAt = (seconds) => usable
        .map((result) => result.lags.find((entry) => entry.seconds === seconds)?.correlation ?? 0);

    console.log('');
    console.log(`scenes: ${usable.length}`);
    for (const seconds of [0.25, 0.5, 1, 2, 4]) {
        const travel = travelAt(seconds);
        if (travel.length === 0) continue;
        console.log(
            `  at ${String(seconds).padStart(4)}s   `
            + `correlation=${median(corrAt(seconds)).toFixed(2)}  `
            + `displacement=${median(travel).toFixed(3)} frames  `
            + `alignment gain=${median(gainAt(seconds)).toFixed(3)}`,
        );
    }
    console.log('');
    const withPeriod = usable.filter((result) => (result.periodDivergence ?? []).length > 0);
    if (withPeriod.length > 0) {
        console.log('');
        console.log('path dependence, with the audio repeating exactly:');
        for (const periods of [1, 2, 3]) {
            const at = (source) => withPeriod
                .map((result) => (result[source] ?? []).find((e) => e.periods === periods)?.difference)
                .filter((value) => value !== undefined);

            const values = at('periodDivergence');
            const control = at('withoutHistory');
            if (values.length === 0) continue;

            console.log(
                `  ${periods} period${periods === 1 ? ' ' : 's'} apart:`
                + `  with history=${median(values).toFixed(4)}`
                + (control.length > 0
                    ? `  without=${median(control).toFixed(4)}`
                        + `  attributable to memory=${(median(values) - median(control)).toFixed(4)}`
                    : ''),
            );
        }
        const floors = withPeriod.map((result) => {
            const settled = result.changeRate.slice(Math.floor(result.changeRate.length / 3));
            return median(settled);
        });
        console.log(`  frame-to-frame change, as a floor:  ${median(floors).toFixed(4)}`);
        console.log('');
        console.log('"without" is the same scene with its memory blanked every frame, so whatever');
        console.log('diverges there is the plugins own clocks rather than history. The difference is');
        console.log('what the accumulation actually contributed; near zero means the picture replays');
        console.log('rather than accumulates, which is motion with a period rather than motion that');
        console.log('goes somewhere.');
        console.log('');
    }

    console.log('displacement is how far the best-aligning zoom, rotation and shift move a point at');
    console.log('mid-radius, as a fraction of frame width. A picture that flows has it growing with');
    console.log('the interval; a picture that changes in place has it flat and near zero. Zoom and');
    console.log('rotation are in the search because a tunnel has no best translation at all.');
    console.log('alignment gain is how much correlation improves once that shift is applied: above');
    console.log('zero means the frames are the same material displaced, not different material.');
}
