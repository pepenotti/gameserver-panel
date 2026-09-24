// The contract for a panel adapter's config half: files, editable folders,
// schemas and presets (CFG-01…10). Call it from a test file of the adapter's
// package:
//   panelAdapterConfigSuite(pzPanelAdapter, { server: () => ({ … }) });
import { describe, expect, it } from 'vitest';
import type { Capability, PanelAdapter, ServerRef } from '../index';
import { expectI18n, expectUnique } from './meta';

export interface PanelConfigSuiteOptions {
  /** A server of this adapter; enables the checks that call `files()` and `roots()`. */
  server?: () => ServerRef;
}

export function panelAdapterConfigSuite<S>(adapter: PanelAdapter<S>, opts: PanelConfigSuiteOptions = {}): void {
  describe(`panel adapter contract (config): ${adapter.meta.id}`, () => {
    const caps = new Set<Capability>(adapter.meta.capabilities);

    it('implements what its capabilities promise', () => {
      const missing: string[] = [];
      if (caps.has('settingsForms') && Object.keys(adapter.config.schemas).length === 0) missing.push('settingsForms: config.schemas');
      if (caps.has('presets') && !adapter.config.presets) missing.push('presets: config.presets');
      if (caps.has('liveReload') && !adapter.config.afterWrite) missing.push('liveReload: config.afterWrite');
      expect(missing).toEqual([]);
    });

    it('schemas have typed options with unique keys', () => {
      for (const [id, schema] of Object.entries(adapter.config.schemas)) {
        expectUnique(
          schema.map((o) => o.key),
          `keys of schema ${id}`,
        );
        for (const o of schema) {
          expect(o.key, `schema ${id}`).not.toBe('');
          if (o.type === 'enum') expect(o.options?.length ?? 0, `${id}.${o.key} has no choices`).toBeGreaterThan(0);
          if (o.min !== undefined && o.max !== undefined) expect(o.min, `${id}.${o.key} range`).toBeLessThanOrEqual(o.max);
        }
      }
    });

    if (opts.server) {
      const server = opts.server;
      it('config files and editable folders are declared consistently', () => {
        const srv = server();
        const files = adapter.config.files(srv);
        expectUnique(
          files.map((f) => f.id),
          'config file ids',
        );
        for (const f of files) {
          if (f.schemaId) expect(adapter.config.schemas[f.schemaId], `schema ${f.schemaId} of ${f.id}`).toBeDefined();
          expect(f.rel).not.toMatch(/^[/\\]|(^|[/\\])\.\.([/\\]|$)/);
        }
        const roots = adapter.config.roots(srv);
        expectUnique(
          roots.map((r) => r.id),
          'editable root ids',
        );
        for (const r of roots) expectI18n(r.label, `editable root ${r.id}`);
      });
    }
  });
}
