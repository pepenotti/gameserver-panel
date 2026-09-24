// Checks every suite runs on an adapter's metadata. Registers tests; call it
// inside a describe block.
import { expect, it } from 'vitest';
import type { AdapterMeta, I18n } from '../index';

export function expectI18n(value: I18n, what: string): void {
  expect(value.en.trim(), `${what} (en)`).not.toBe('');
  expect(value.es.trim(), `${what} (es)`).not.toBe('');
}

export function expectUnique(values: readonly string[], what: string): void {
  expect(values.filter((v, i) => values.indexOf(v) !== i), `duplicate ${what}`).toEqual([]);
}

export function metaTests(meta: AdapterMeta): void {
  it('meta: id, English and Spanish names, architectures', () => {
    expect(meta.id).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    expectI18n(meta.name, 'name');
    expect(meta.arch.length).toBeGreaterThan(0);
    expectUnique(meta.arch, 'architectures');
  });

  it('meta: capabilities and flavours are unique', () => {
    expectUnique(meta.capabilities, 'capabilities');
    expectUnique(
      meta.flavours.map((f) => f.id),
      'flavour ids',
    );
    for (const f of meta.flavours) {
      expectI18n(f.name, `flavour ${f.id}`);
      if (f.capabilities) expectUnique(f.capabilities, `capabilities of flavour ${f.id}`);
    }
  });

  it('meta: ports have unique ids, labels and valid numbers', () => {
    expectUnique(
      meta.ports.map((p) => p.id),
      'port ids',
    );
    for (const p of meta.ports) {
      expectI18n(p.label, `port ${p.id}`);
      expect(Number.isInteger(p.default) && p.default >= 1 && p.default <= 65535, `port ${p.id}`).toBe(true);
    }
  });

  it('meta: memory and stop budget are sane', () => {
    expect(meta.memory.minMb).toBeGreaterThan(0);
    expect(meta.memory.defaultMb).toBeGreaterThanOrEqual(meta.memory.minMb);
    expect(meta.memory.overheadMb).toBeGreaterThanOrEqual(0);
    expect(meta.stopBudgetMs).toBeGreaterThan(0);
  });
}
