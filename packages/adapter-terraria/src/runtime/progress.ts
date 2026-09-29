/**
 * Terraria's progress lines (CON-01), as captured from vanilla 1.4.5.8,
 * TShock 6.2.1 and tModLoader v2026.07.3.0 (fixtures/terraria/1.4.5.8):
 * generating a world prints one line per step, about 30 000 for a small
 * world on vanilla and tModLoader (`<done>% - <phase> - <phase done>%`), and
 * loading, settling and saving a world print a line per percent. The agent
 * shows each run as its latest line. Each pattern matches a `bare` line.
 */
import type { LineSignal } from '@gsp/adapter-api';

export const TR_PROGRESS: readonly { key: string; re: RegExp }[] = [
  // Vanilla and tModLoader; the first line of tModLoader's has no phase (`0.0% -  - 0.0%`), and another language writes `0,4%`.
  { key: 'world-generation', re: /^\d{1,3}(?:[.,]\d+)?% - .* - \d{1,3}(?:[.,]\d+)?%$/ },
  { key: 'resetting', re: /^Resetting game objects \d{1,3}%$/ },
  { key: 'loading', re: /^Loading world data: \d{1,3}%$/ },
  { key: 'settling', re: /^Settling liquids \d{1,3}%$/ },
  // TShock's world generation prints its phases once each, and this one per percent.
  { key: 'underworld', re: /^Creating underworld \d{1,3}%$/ },
  { key: 'saving', re: /^Saving world data: \d{1,3}%$/ },
  { key: 'validating', re: /^Validating world save: \d{1,3}%$/ },
];

/** The run a `bare` line is a step of, if any. */
export function progressOf(bareLine: string): LineSignal['progress'] {
  const p = TR_PROGRESS.find((x) => x.re.test(bareLine));
  return p ? { key: p.key } : undefined;
}
