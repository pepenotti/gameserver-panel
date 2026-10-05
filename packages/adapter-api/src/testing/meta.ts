// Checks every suite runs on an adapter's metadata. Registers tests; call it
// inside a describe block.
import { expect, it } from 'vitest';
import { redirectProblem } from '@gsp/shared';
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

  it('meta: a port that follows another follows an earlier one, published like it, at its default distance (SRV-01)', () => {
    for (const [i, p] of meta.ports.entries()) {
      if (!p.follows) continue;
      const base = meta.ports.slice(0, i).find((x) => x.id === p.follows!.id);
      expect(base, `port ${p.id} follows an earlier port`).toBeDefined();
      expect(base!.follows, `port ${p.id} follows ${base!.id}, which follows another`).toBeUndefined();
      expect(base!.publish, `port ${p.id} is published like ${base!.id}`).toBe(p.publish);
      expect(Number.isInteger(p.follows.offset), `offset of port ${p.id}`).toBe(true);
      expect(p.default, `default of port ${p.id}`).toBe(base!.default + p.follows.offset);
      // The same number twice is two protocols of one port, never one protocol twice.
      if (p.follows.offset === 0) expect(p.proto, `port ${p.id} at offset 0`).not.toBe(base!.proto);
    }
  });

  it('meta: notes are worded in both languages and name their limitations entry (UX-04)', () => {
    const notes = meta.notes ?? [];
    expectUnique(
      notes.map((n) => n.id),
      'note ids',
    );
    for (const n of notes) {
      expect(n.id).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
      expectI18n(n.text, `note ${n.id}`);
      if (n.doc !== undefined) expect(n.doc, `note ${n.id} doc`).toMatch(/^limitations\.md#[a-z0-9-]+$/);
    }
  });

  it('meta: settings that act per player address name their file, key and flavours, worded in both languages (HST-07)', () => {
    const settings = meta.perAddress ?? [];
    expectUnique(
      settings.map((s) => s.id),
      'per-address setting ids',
    );
    const flavours = new Set(meta.flavours.map((f) => f.id));
    for (const s of settings) {
      expect(s.id).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
      expect(s.file, `per-address ${s.id} file`).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
      expect(s.key.trim(), `per-address ${s.id} key`).not.toBe('');
      expectI18n(s.text, `per-address ${s.id}`);
      if (s.doc !== undefined) expect(s.doc, `per-address ${s.id} doc`).toMatch(/^limitations\.md#[a-z0-9-]+$/);
      for (const f of s.flavours ?? []) expect(flavours.has(f), `per-address ${s.id} names flavour ${f}`).toBe(true);
      if (s.flavours) expect(s.flavours.length, `per-address ${s.id} flavours`).toBeGreaterThan(0);
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

  it('meta: declares how its installs are shared, for itself or each flavour, with redirects inside the install to the data root (HST-09, D12)', () => {
    const declared = [...(meta.install ? [['the adapter', meta.install] as const] : []), ...meta.flavours.flatMap((f) => (f.install ? [[`flavour ${f.id}`, f.install] as const] : []))];
    if (!meta.install) {
      expect(meta.flavours.length, 'no install sharing declared (AdapterMeta.install)').toBeGreaterThan(0);
      for (const f of meta.flavours) expect(f.install, `install sharing of flavour ${f.id}`).toBeDefined();
    }
    for (const [who, s] of declared) {
      expect(['shared', 'copy', 'own'], `install mode of ${who}`).toContain(s.mode);
      if (s.mode !== 'shared') expect(s.redirects ?? [], `redirects of ${who}, whose installs aren't shared`).toEqual([]);
      for (const r of s.redirects ?? []) expect(redirectProblem(r), `redirect ${r.path} of ${who}`).toBeNull();
      expectUnique(
        (s.redirects ?? []).map((r) => r.path),
        `redirect paths of ${who}`,
      );
    }
  });

  it('meta: memory and stop budget are sane', () => {
    expect(meta.memory.minMb).toBeGreaterThan(0);
    expect(meta.memory.defaultMb).toBeGreaterThanOrEqual(meta.memory.minMb);
    expect(meta.memory.overheadMb).toBeGreaterThanOrEqual(0);
    expect(meta.stopBudgetMs).toBeGreaterThan(0);
  });
}
