import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('../../../fixtures/valheim/1.0.16/', import.meta.url));
export const FAKE_SERVER = fileURLToPath(new URL('../../../tools/fake-valheim/server.mjs', import.meta.url));

/** Valheim's launch params as the panel sends them for a server whose game name is `vh`. */
export const valheimLaunch = (over: Record<string, unknown> = {}) => ({
  name: 'vh',
  branch: 'public',
  updateOnStart: false,
  memoryMb: 3072,
  serverName: 'gspff test',
  password: 'secret12',
  public: false,
  crossplay: false,
  saveInterval: 300,
  ...over,
});

/** A file of the Valheim 1.0.16 captures. */
export function fixture(...parts: string[]): string {
  return readFileSync(`${FIXTURES}${parts.join('/')}`, 'utf8');
}

/**
 * A captured log as the agent reads it: the harness's own lines (`# argv`,
 * `# cwd`) and what it typed (`> `) left out, stderr lines without their
 * `[stderr] ` mark.
 */
export function fixtureLines(...parts: string[]): string[] {
  return fixture(...parts)
    .split(/\r?\n/)
    .filter((l) => !l.startsWith('# ') && !l.startsWith('> '))
    .map((l) => l.replace(/^\[stderr\] /, ''));
}
