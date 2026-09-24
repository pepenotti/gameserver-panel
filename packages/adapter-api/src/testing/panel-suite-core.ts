// The contract every panel adapter passes, minus its config half (see
// panel-suite-config.ts). Call it from a test file of the adapter's package:
//   panelAdapterCoreSuite(pzPanelAdapter, { server: () => ({ … }) });
import { describe, expect, it } from 'vitest';
import type { Capability, PanelAdapter, ServerRef } from '../index';
import { expectI18n, expectUnique, metaTests } from './meta';

export interface PanelCoreSuiteOptions {
  /** A server of this adapter; enables the checks that call per-server functions. */
  server?: () => ServerRef;
}

export function panelAdapterCoreSuite<S>(adapter: PanelAdapter<S>, opts: PanelCoreSuiteOptions = {}): void {
  describe(`panel adapter contract (core): ${adapter.meta.id}`, () => {
    metaTests(adapter.meta);
    const caps = () => new Set<Capability>([...adapter.meta.capabilities, ...adapter.meta.flavours.flatMap((f) => f.capabilities ?? [])]);

    it('implements what its capabilities promise', () => {
      const c = caps();
      const p = adapter.players;
      const missing: string[] = [];
      const need = (cap: Capability, ok: boolean, what: string) => {
        if (c.has(cap) && !ok) missing.push(`${cap}: ${what}`);
      };
      need('broadcast', !!adapter.messages.broadcast, 'messages.broadcast');
      need('kick', !!p?.kick, 'players.kick');
      need('ban', !!p?.ban && !!p.unban, 'players.ban/unban');
      need('whitelist', !!p?.whitelistAdd && !!p.whitelistRemove, 'players.whitelistAdd/Remove');
      need('accessLevels', !!p?.setAccess, 'players.setAccess');
      need('accounts', !!p?.accounts, 'players.accounts');
      need('updateCheck', !!adapter.updates, 'updates.check');
      for (const cap of c) if (cap.startsWith('mods:')) need(cap, !!adapter.mods?.some((m) => m.capability === cap), `a mod source for ${cap}`);
      for (const m of adapter.mods ?? []) if (!c.has(m.capability)) missing.push(`mod source ${m.id} without the ${m.capability} capability`);
      expect(missing).toEqual([]);
    });

    it('backup parts and resets are labelled and consistent', () => {
      const parts = adapter.backups.parts.map((x) => x.id);
      expectUnique(parts, 'backup part ids');
      for (const x of adapter.backups.parts) expectI18n(x.label, `backup part ${x.id}`);
      expectUnique(
        adapter.resets.map((r) => r.id),
        'reset ids',
      );
      for (const r of adapter.resets) {
        expectI18n(r.label, `reset ${r.id}`);
        expect(r.removeParts.filter((x) => !parts.includes(x)), `reset ${r.id} removes unknown parts`).toEqual([]);
      }
    });

    it('launch settings have unique keys', () => {
      expectUnique(
        adapter.launch.schema.map((o) => o.key),
        'launch setting keys',
      );
    });

    if (opts.server) {
      const server = opts.server;
      it('backup paths stay relative to the data root', () => {
        for (const x of adapter.backups.parts) for (const p of x.paths(server())) expect(p).toMatch(/^(?![/\\])(?!.*(^|[/\\])\.\.([/\\]|$))/);
      });
    }
  });
}
