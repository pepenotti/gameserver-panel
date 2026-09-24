// The contract every runtime adapter passes (NFR-07). Call it from a test
// file of the adapter's package:
//   runtimeAdapterSuite(pzRuntimeAdapter, { validLaunch: () => ({ … }) });
import { describe, expect, it } from 'vitest';
import type { Capability, RuntimeAdapter } from '../index';
import { metaTests } from './meta';

export interface RuntimeSuiteOptions {
  /** Launch input `parseLaunch` must accept; enables the parsing checks. */
  validLaunch?: () => unknown;
}

/** Capabilities that need a runtime method to exist. */
const NEEDS: [Capability[], keyof RuntimeAdapter, string][] = [
  [['save'], 'save', 'save()'],
  [['hotBackup'], 'hotCopy', 'hotCopy'],
  [['players'], 'listPlayers', 'listPlayers()'],
  [['branches', 'versionPin'], 'versions', 'versions()'],
];

export function runtimeAdapterSuite<P>(adapter: RuntimeAdapter<P>, opts: RuntimeSuiteOptions = {}): void {
  describe(`runtime adapter contract: ${adapter.meta.id}`, () => {
    metaTests(adapter.meta);

    it('implements what its capabilities promise', () => {
      const caps = new Set<Capability>([...adapter.meta.capabilities, ...adapter.meta.flavours.flatMap((f) => f.capabilities ?? [])]);
      const missing = NEEDS.filter(([need, key]) => need.some((c) => caps.has(c)) && adapter[key] === undefined).map(([, , what]) => what);
      expect(missing).toEqual([]);
    });

    it('names its actions with safe ids', () => {
      for (const name of Object.keys(adapter.actions ?? {})) expect(name).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
    });

    if (opts.validLaunch) {
      const valid = opts.validLaunch;
      it('parses valid launch params and refuses junk', () => {
        expect(() => adapter.parseLaunch(valid())).not.toThrow();
        for (const junk of [null, undefined, 42, 'x', []]) expect(() => adapter.parseLaunch(junk)).toThrow();
      });
    }
  });
}
