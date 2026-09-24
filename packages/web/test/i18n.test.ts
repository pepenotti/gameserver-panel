/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { es } from '../src/i18n/es';

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
  }
  return out;
}

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(f) ? [p] : [];
  });
}

const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
const EN = flatten(en as unknown as Tree);
const ES = flatten(es as unknown as Tree);
const root = path.resolve(import.meta.dirname, '..', '..');

describe('translations', () => {
  it('English and Spanish have the same keys, none empty', () => {
    expect([...ES.keys()].sort()).toEqual([...EN.keys()].sort());
    for (const [k, v] of [...EN, ...ES]) expect(v.trim(), k).not.toBe('');
  });

  it('use the same {{placeholders}} in both languages', () => {
    for (const [k, v] of EN) expect(placeholders(ES.get(k) ?? ''), k).toEqual(placeholders(v));
  });

  it('every key the UI asks for exists', () => {
    const missing: string[] = [];
    for (const f of files(path.join(root, 'web', 'src'), /\.tsx?$/)) {
      const src = readFileSync(f, 'utf8');
      // t('a.b'), i18nKey="a.b" and label keys in arrays like ['nav.home', …] passed to t().
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z][\w.-]*)'/g)) if (!EN.has(m[1]!)) missing.push(`${path.basename(f)}: ${m[1]}`);
      // t(`prefix.${x}`): the prefix must be a section.
      for (const m of src.matchAll(/\bt\(\s*`([a-zA-Z][\w.-]*)\.\$\{/g)) if (![...EN.keys()].some((k) => k.startsWith(`${m[1]}.`))) missing.push(`${path.basename(f)}: ${m[1]}.*`);
    }
    expect(missing).toEqual([]);
  });

  it('every error code the panel can return has a message', () => {
    const codes = new Set<string>();
    for (const f of files(path.join(root, 'panel', 'src'), /\.ts$/)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/new HttpError\(\s*\d+,\s*'([\w-]+)'/g)) codes.add(m[1]!);
      for (const m of src.matchAll(/\.send\(\{\s*error:\s*'([\w-]+)'/g)) codes.add(m[1]!);
    }
    expect(codes.size).toBeGreaterThan(10);
    expect([...codes].filter((c) => !EN.has(`errors.${c}`)).sort()).toEqual([]);
  });
});
