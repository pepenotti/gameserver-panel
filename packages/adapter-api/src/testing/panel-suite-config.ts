// The contract for a panel adapter's config half: files, editable folders,
// schemas and presets (CFG-01…10). Call it from a test file of the adapter's
// package:
//   panelAdapterConfigSuite(pzPanelAdapter, {
//     server: () => ({ id: 'test', gameName: 'zomboid', flavour: null }),
//     files: () => ({ 'data/Server/zomboid.ini': capturedIni, … }),
//   });
import { describe, expect, it } from 'vitest';
import { checkOptionValue, formatFor } from '@gsp/formats';
import type { Capability, CommandResponse, DirEntry, PanelAdapter, RootId, ServerCtx, ServerFiles, ServerRef } from '../index';
import { expectI18n, expectUnique } from './meta';

export interface PanelConfigSuiteOptions {
  /** A server of this adapter; enables the checks that call `files()` and `roots()`. */
  server?: () => ServerRef;
  /**
   * A server's files as the game writes them (captured fixtures), by
   * `<root>/<rel>`; served to the adapter from memory. Enables the checks
   * that read files: declared files parse, presets, `afterWrite`.
   */
  files?: () => Record<string, string>;
}

/** Relative, `/`-separated, never climbing out. */
const RELATIVE = /^(?![/\\])(?![A-Za-z]:)(?!.*(^|[/\\])\.\.([/\\]|$)).+$/;

/** `ServerFiles` in memory; refuses the paths a real implementation refuses. */
export function memoryServerFiles(seed: Record<string, string>): ServerFiles & { written: Map<string, string> } {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, Buffer.from(v)]));
  const written = new Map<string, string>();
  const key = (root: RootId, rel: string) => {
    if (rel !== '' && !RELATIVE.test(rel)) throw new Error(`Invalid path: ${JSON.stringify(rel)}`);
    return rel === '' ? root : `${root}/${rel.replace(/\/+$/, '')}`;
  };
  const no = async (): Promise<never> => {
    throw new Error('not available in the contract suite');
  };
  return {
    written,
    async stat(root, rel) {
      const k = key(root, rel);
      const f = store.get(k);
      if (f) return { kind: 'file', size: f.length, mtimeMs: 0 };
      return [...store.keys()].some((x) => x.startsWith(`${k}/`)) ? { kind: 'dir', size: 0, mtimeMs: 0 } : null;
    },
    async list(root, rel) {
      const prefix = `${key(root, rel)}/`;
      const out = new Map<string, DirEntry>();
      for (const [k, v] of store) {
        if (!k.startsWith(prefix)) continue;
        const [name, ...deeper] = k.slice(prefix.length).split('/');
        out.set(name!, deeper.length ? { name: name!, kind: 'dir', size: 0, mtimeMs: 0 } : { name: name!, kind: 'file', size: v.length, mtimeMs: 0 });
      }
      return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    async read(root, rel, o) {
      const f = store.get(key(root, rel));
      if (!f) return null;
      if (o?.maxBytes !== undefined && f.length > o.maxBytes) throw new Error(`${rel} is too large`);
      return f;
    },
    async writeAtomic(root, rel, data) {
      store.set(key(root, rel), Buffer.from(data));
      written.set(key(root, rel), Buffer.from(data).toString('utf8'));
    },
    async remove(root, rels) {
      for (const r of rels) store.delete(key(root, r));
    },
    pack: no,
    stage: no,
    swap: no,
    undo: no,
    purgeTrash: no,
  };
}

export function panelAdapterConfigSuite<S>(adapter: PanelAdapter<S>, opts: PanelConfigSuiteOptions = {}): void {
  describe(`panel adapter contract (config): ${adapter.meta.id}`, () => {
    const caps = new Set<Capability>(adapter.meta.capabilities);
    const cfg = adapter.config;

    it('implements what its capabilities promise', () => {
      const missing: string[] = [];
      if (caps.has('settingsForms') && Object.keys(cfg.schemas).length === 0) missing.push('settingsForms: config.schemas');
      if (caps.has('presets') && !cfg.presets) missing.push('presets: config.presets');
      if (caps.has('liveReload') && !cfg.afterWrite) missing.push('liveReload: config.afterWrite');
      expect(missing).toEqual([]);
    });

    it('schemas have typed options with unique keys and defaults their own checks accept', () => {
      for (const [id, schema] of Object.entries(cfg.schemas)) {
        expectUnique(
          schema.map((o) => o.key),
          `keys of schema ${id}`,
        );
        for (const o of schema) {
          expect(o.key, `schema ${id}`).not.toBe('');
          if (o.type === 'enum') expect(o.options?.length ?? 0, `${id}.${o.key} has no choices`).toBeGreaterThan(0);
          if (o.min !== undefined && o.max !== undefined) expect(o.min, `${id}.${o.key} range`).toBeLessThanOrEqual(o.max);
          if (o.default !== undefined) expect(checkOptionValue(o, o.default), `${id}.${o.key} default ${JSON.stringify(o.default)}`).toBeNull();
        }
      }
    });

    it('option groups are labelled, and every option is in a declared group (CFG-10)', () => {
      for (const [id, groups] of Object.entries(cfg.groups ?? {})) {
        expect(cfg.schemas[id], `groups for unknown schema ${id}`).toBeDefined();
        expectUnique(
          groups.map((g) => g.id),
          `groups of schema ${id}`,
        );
        for (const g of groups) expectI18n(g.label, `group ${id}.${g.id}`);
        const known = new Set(groups.map((g) => g.id));
        const strays = (cfg.schemas[id] ?? []).filter((o) => o.group === undefined || !known.has(o.group)).map((o) => o.key);
        expect(strays, `options of schema ${id} outside its groups`).toEqual([]);
      }
      for (const [id, schema] of Object.entries(cfg.schemas)) {
        if (!cfg.groups?.[id]) expect(schema.filter((o) => o.group !== undefined).map((o) => o.key), `schema ${id} names groups it doesn't declare`).toEqual([]);
      }
    });

    if (!opts.server) return;
    const server = opts.server;

    it('config files are declared consistently', () => {
      const srv = server();
      const files = cfg.files(srv);
      expect(files.length, 'declared files').toBeGreaterThan(0);
      expectUnique(
        files.map((f) => f.id),
        'config file ids',
      );
      expectUnique(
        files.map((f) => `${f.root}/${f.rel}`),
        'config file paths',
      );
      if (cfg.presets) expect(files.map((f) => f.id), 'the file presets apply to').toContain(cfg.presets.fileId);
      for (const f of files) {
        expect(f.id, 'file id').toMatch(/^[a-z][a-z0-9-]*$/);
        if (f.label) expectI18n(f.label, `label of ${f.id}`);
        expect(f.rel, `${f.id} path`).toMatch(RELATIVE);
        // A validate would overwrite the install; settings live with the server's data.
        expect(f.root, `${f.id} root`).not.toBe('install');
        // A file edited only while the game is stopped takes effect when it starts.
        if (f.stoppedOnly) expect(f.restartKeys, `${f.id} is stopped-only`).toBe('*');
        const schema = f.schemaId === undefined ? undefined : cfg.schemas[f.schemaId];
        if (f.schemaId !== undefined) expect(schema, `schema ${f.schemaId} of ${f.id}`).toBeDefined();
        for (const [what, keys] of [
          ['managed', f.managedKeys],
          ['secret', f.secretKeys],
          ['restart', f.restartKeys === '*' ? [] : f.restartKeys],
        ] as const) {
          expectUnique(keys, `${what} keys of ${f.id}`);
          // Catches typos: a key the form can't show is a key nobody can see locked, masked or flagged.
          if (schema) expect(keys.filter((k) => !schema.some((o) => o.key === k)), `${what} keys of ${f.id} missing from its schema`).toEqual([]);
        }
      }
    });

    it('files the game executes are declared data-only (CFG-02)', () => {
      for (const f of cfg.files(server())) {
        const format = formatFor(f);
        if (f.format === 'lua-data') expect(f.dataOnly, `${f.id} is Lua the game executes`).toBeDefined();
        if (f.dataOnly) {
          expect(f.format, `${f.id} data-only`).toBe('lua-data');
          expect(format.checkShape, `${f.id} format checks shapes`).toBeDefined();
          expect(f.dataOnly.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
        }
      }
    });

    it('first-run seeds can be written and read back', () => {
      for (const f of cfg.files(server())) {
        if (!f.seed) continue;
        const format = formatFor(f);
        expect(format.create, `${f.id} has a seed, so its format must create files`).toBeDefined();
        const r = format.parse(format.create!(f.seed));
        expect(r.ok, `${f.id} seed parses`).toBe(true);
        if (!r.ok) continue;
        const flat = format.flatten(r.doc);
        for (const [k, v] of Object.entries(f.seed)) expect(String(flat[k]), `${f.id}.${k}`).toBe(String(v));
      }
    });

    it('managed values only set managed keys of declared files (CFG-04)', () => {
      const srv = server();
      const files = new Map(cfg.files(srv).map((f) => [f.id, f]));
      for (const [fileId, values] of Object.entries(cfg.managedValues(srv))) {
        const f = files.get(fileId);
        expect(f, `managed values for undeclared file ${fileId}`).toBeDefined();
        expect(Object.keys(values).filter((k) => !f!.managedKeys.includes(k)), `values for keys ${fileId} doesn't list as managed`).toEqual([]);
        for (const v of Object.values(values)) expect(v, `${fileId} managed value`).not.toMatch(/[\r\n\0]/);
      }
    });

    it('editable folders are labelled, relative and have globs (CFG-07, CFG-08)', () => {
      const roots = cfg.roots(server());
      expectUnique(
        roots.map((r) => r.id),
        'editable root ids',
      );
      for (const r of roots) {
        expectI18n(r.label, `editable root ${r.id}`);
        expect(r.rel === '' || RELATIVE.test(r.rel), `editable root ${r.id} path ${r.rel}`).toBe(true);
        expect(r.include.length, `editable root ${r.id} includes nothing`).toBeGreaterThan(0);
        for (const g of [...r.include, ...r.exclude]) expect(g, `glob of ${r.id}`).toMatch(RELATIVE);
      }
    });

    if (!opts.files) return;
    const seed = opts.files;
    const ctxFor = () => {
      const files = memoryServerFiles(seed());
      const commands: string[] = [];
      const no = async (): Promise<never> => {
        throw new Error('not available in the config contract suite');
      };
      const ctx: ServerCtx = {
        srv: server(),
        files,
        actor: 'contract-suite',
        status: () => null,
        command: async (c): Promise<CommandResponse> => {
          commands.push(c.command);
          return { via: 'rcon', output: '' };
        },
        action: no,
        versions: no,
        launchSettings: () => adapter.launch.defaults(),
        // Config code is what the panel's settings service runs; it doesn't call itself.
        config: { set: no, seedIfMissing: no, applyPreset: no },
        onLog: () => () => undefined,
      };
      return { ctx, files, commands };
    };

    it('the files a real server writes parse with their declared format and shape', async () => {
      const { ctx } = ctxFor();
      let seen = 0;
      for (const f of cfg.files(ctx.srv)) {
        const buf = await ctx.files.read(f.root, f.rel);
        if (!buf) continue;
        seen++;
        const format = formatFor(f);
        const r = format.parse(buf.toString('utf8'));
        expect(r.ok ? [] : r.issues, `${f.id} parses`).toEqual([]);
        if (r.ok && f.dataOnly) expect(format.checkShape!(r.doc, f.dataOnly), `${f.id} shape`).toBeNull();
      }
      expect(seen, 'no declared file found in the fixtures').toBeGreaterThan(0);
    });

    it('re-reads a running server after a write, or says it takes a restart (CFG-05)', async () => {
      if (!cfg.afterWrite) return;
      for (const f of cfg.files(server())) {
        const r = await cfg.afterWrite(ctxFor().ctx, f.id, []);
        expect(['live', 'restart'], `${f.id} applied`).toContain(r.applied);
        expect(Array.isArray(r.warnings), `${f.id} warnings`).toBe(true);
        if (f.restartKeys === '*') expect(r.applied, `${f.id} takes effect at the next start`).toBe('restart');
      }
    });

    it('lists and loads presets, refusing names that are not presets (CFG-06)', async () => {
      if (!cfg.presets) return;
      const { ctx } = ctxFor();
      const names = await cfg.presets.list(ctx);
      expectUnique(names, 'preset names');
      expect(names.length, 'no preset found in the fixtures').toBeGreaterThan(0);
      const values = await cfg.presets.load(ctx, names[0]!);
      expect(Object.keys(values).length, `preset ${names[0]} has no values`).toBeGreaterThan(0);
      for (const v of Object.values(values)) expect(['string', 'number', 'boolean']).toContain(typeof v);
      for (const bad of ['../../etc/passwd', 'nope-not-a-preset']) await expect(cfg.presets.load(ctx, bad), bad).rejects.toThrow();
    });
  });
}
