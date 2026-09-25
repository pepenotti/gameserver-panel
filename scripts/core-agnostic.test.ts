// NFR-08: the core knows no game. ESLint refuses adapter imports outside the
// composition roots; this test checks the same from the files themselves, and
// looks for what a game leaks in without any import. The web has its own
// check (it can reuse scripts/lib/core-agnostic.mjs).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findAdapterImports, findGameTokens, GAME_TOKENS } from './lib/core-agnostic.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
/** The core packages this test covers (packages/web checks itself). */
const CORE = ['shared', 'formats', 'adapter-api', 'archive', 'agent', 'orchestrator', 'panel'];
/** The only core modules that pick game adapters. */
const COMPOSITION_ROOTS = ['packages/agent/src/main.ts', 'packages/panel/src/main.ts', 'packages/panel/src/wiring.ts'];
const SOURCE = /\.(?:[cm]?[jt]s|tsx|json)$/;

/** Every source file under `packages/<pkg>/src`, as a repository-relative path with `/`. */
function coreFiles(): string[] {
  const out: string[] = [];
  for (const pkg of CORE) {
    const src = path.join(root, 'packages', pkg, 'src');
    for (const rel of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
      if (SOURCE.test(rel)) out.push(`packages/${pkg}/src/${rel.split(path.sep).join('/')}`);
    }
  }
  return out.sort();
}

const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

describe('the core is game-agnostic (NFR-08)', () => {
  const files = coreFiles();

  it('covers every core package', () => {
    for (const pkg of CORE) expect(files.some((f) => f.startsWith(`packages/${pkg}/src/`)), pkg).toBe(true);
    expect(files).toEqual(expect.arrayContaining(COMPOSITION_ROOTS));
  });

  it("names none of a game's app ids, files or console commands", () => {
    const hits = files.flatMap((f) => findGameTokens(read(f)).map((h) => `${f}:${h.line} ${h.token}`));
    expect(hits).toEqual([]);
  });

  it('imports game adapters only in the composition roots', () => {
    const hits = files.filter((f) => !COMPOSITION_ROOTS.includes(f)).flatMap((f) => findAdapterImports(read(f)).map((h) => `${f}:${h.line} ${h.specifier}`));
    expect(hits).toEqual([]);
    // The roots do pick an adapter (the check above would pass on an empty list too).
    expect(COMPOSITION_ROOTS.filter((f) => findAdapterImports(read(f)).length > 0)).toEqual(['packages/agent/src/main.ts', 'packages/panel/src/wiring.ts']);
  });
});

describe('what the check finds', () => {
  it('finds each game token, in names and paths too', () => {
    for (const t of GAME_TOKENS) expect(findGameTokens(`x ${t} y`), t).toEqual([{ line: 1, token: t }]);
    expect(findGameTokens('a\nconst f = `${name}_SandboxVars.lua`; // ProjectZomboid').map((h) => h.token)).toEqual(['SandboxVars', 'Zomboid']);
    expect(findGameTokens("appmanifest_380870.acf\n'108600'").map((h) => h.line)).toEqual([1, 2]);
    // Other numbers that merely contain an app id are not it.
    expect(findGameTokens('13808701 2108600')).toEqual([]);
    expect(findGameTokens('zomboid (the default server name) and servermessage')).toEqual([]);
  });

  it('finds adapter imports in every form, and only those', () => {
    const src = [
      "import { pz } from '@gsp/adapter-pz';",
      "import type { X } from '@gsp/adapter-pz/panel/core';",
      "export { a } from '@gsp/adapters/panel';",
      "const m = await import('@gsp/adapters');",
      "const r = require('../../adapter-pz/src/runtime');",
      "import type { PanelAdapter } from '@gsp/adapter-api';",
      "import { suite } from '@gsp/adapter-api/testing/runtime-suite';",
      "import { x } from '../adapters-helper-not-a-package/x';",
      "import { createWorkshopSource } from '@gsp/source-workshop';",
      "import { workshopDownloadAction } from '../../source-workshop/src/runtime';",
      "import { y } from '@gsp/sourcemaps';",
    ].join('\n');
    expect(findAdapterImports(src).map((h) => h.line)).toEqual([1, 2, 3, 4, 5, 9, 10]);
  });
});
