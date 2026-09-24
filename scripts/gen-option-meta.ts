// Builds packages/panel/src/config/option-meta.json from the English and
// Spanish files PZ generated in the M1 spike (fixtures/b42/config). Re-run
// after capturing files from a newer build:
//
//   npx tsx scripts/gen-option-meta.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { iniOptions, mergeLanguages, parseIni, parseLuaData, sandboxOptions } from '@pz/formats';

const read = (f: string) => readFileSync(new URL(`../fixtures/b42/config/${f}`, import.meta.url), 'utf8');

const ini = mergeLanguages({ en: iniOptions(parseIni(read('server.en.ini'))), es: iniOptions(parseIni(read('server.es.ini'))) });
const sandbox = mergeLanguages({
  en: sandboxOptions(parseLuaData(read('SandboxVars.en.lua')).table),
  es: sandboxOptions(parseLuaData(read('SandboxVars.es.lua')).table),
});

const out = { source: 'Project Zomboid 42.20.4 (b0bbce05d5)', ini, sandbox };
writeFileSync(new URL('../packages/panel/src/config/option-meta.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(`ini: ${ini.length} options, sandbox: ${sandbox.length} options`);
