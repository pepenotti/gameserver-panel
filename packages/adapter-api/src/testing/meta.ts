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
      // PRD §10: a flavour may name another image family than its adapter's, never an unknown one.
      if (f.runtime !== undefined) expect(['steam', 'java', 'native'], `runtime of flavour ${f.id}`).toContain(f.runtime);
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

  it('meta: an EULA names its agreement, and only an EULA does (D6)', () => {
    const caps = [...meta.capabilities, ...meta.flavours.flatMap((f) => f.capabilities ?? [])];
    if (!caps.includes('eula')) {
      expect(meta.eula, 'an agreement without the eula capability').toBeUndefined();
      return;
    }
    expect(meta.eula, 'the agreement the eula capability means').toBeDefined();
    expectI18n(meta.eula!.name, 'agreement name');
    expect(new URL(meta.eula!.url).protocol).toBe('https:');
  });

  it('meta: memory and stop budget are sane', () => {
    expect(meta.memory.minMb).toBeGreaterThan(0);
    expect(meta.memory.defaultMb).toBeGreaterThanOrEqual(meta.memory.minMb);
    expect(meta.memory.overheadMb).toBeGreaterThanOrEqual(0);
    expect(meta.stopBudgetMs).toBeGreaterThan(0);
  });
}
