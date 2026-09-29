import type { FastifyInstance } from 'fastify';
import { srvOf } from '../http/context';
import type { Deps } from '../http/deps';

/**
 * What the server's game adapter supports, for the UI to show only that and
 * for AST-04 (machine-readable context). Anyone with a role on the server
 * may read it.
 */
export function metaRoutes(app: FastifyInstance, _deps: Deps): void {
  app.get('/meta', { config: { permission: 'server.view' } }, async (req) => {
    const s = srvOf(req);
    const a = s.adapter;
    const srv = s.handle.ref;
    // Its flavour's moderation, resets and console commands, where flavours differ.
    const p = s.handle.players();
    // Parts this server has (a loader's plugins or mods are nothing for another loader).
    const parts = a.backups.parts.filter((x) => x.paths(srv).length > 0);
    const has = new Set(parts.map((x) => x.id));
    return {
      adapter: a.meta,
      server: { id: srv.id, name: s.row.name, gameName: srv.gameName, flavour: srv.flavour },
      capabilities: [...s.capabilities()],
      // Which secrets the server needs, never their values. `choices`: its versions can be listed; `warnings`: what their codes mean.
      // Every setting, those of other flavours too (`flavours`): the stored settings hold them all.
      launch: {
        schema: a.launch.schema,
        secrets: (a.launch.secrets ?? []).map((x) => ({ key: x.key, label: x.label })),
        choices: !!a.launch.choices,
        warnings: a.launch.warnings ?? {},
      },
      backupParts: parts.map((x) => ({ id: x.id, label: x.label })),
      resets: s.handle.resets().map((r) => ({ id: r.id, label: r.label, permission: r.permission, removeParts: r.removeParts.filter((id) => has.has(id)), options: r.options ?? {} })),
      accessLevels: p?.accessLevels ?? [],
      banTargets: p?.banTargets ?? [],
      // Its bans are bans of an address, whatever they name (a UI warns first); commands that wait for a stopped game.
      banByAddress: p?.banByAddress === true,
      stoppedOnly: p?.stoppedOnly ?? [],
      // How the whitelist works here: a password per entry (accounts), switched on and off live, listed.
      whitelist: { password: p?.whitelistPassword !== false, toggle: !!p?.setWhitelistEnabled, list: !!p?.whitelist },
      // Who holds a level above the lowest can be listed.
      levelHolders: !!p?.levelHolders,
      // Its flavour's mod sources: catalogues (mods added by id or link, their load order) and plugin files people bring,
      // with the warning shown before adding one and what an upload or link may be (MOD-03, MOD-06).
      modSources: [
        ...s.mods.sources.map((m) => ({ id: m.id, capability: m.capability, label: m.label, kind: 'catalogue' as const, serverFetches: m.serverFetches !== false })),
        ...s.plugins.sources.map((m) => ({ id: m.id, capability: m.capability, label: m.label, kind: 'files' as const, warning: m.warning, extensions: m.extensions, maxBytes: m.maxBytes, linkHint: m.linkHint ?? null })),
      ],
      consoleCatalog: s.handle.consoleCatalog(),
    };
  });
}
