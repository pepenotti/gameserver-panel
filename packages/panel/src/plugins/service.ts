import { createHash, randomUUID } from 'node:crypto';
import type { PluginAdded, PluginFile, PluginRefusal, PluginReply, PluginSource } from '@gsp/adapter-api';
import type { ConfigStore } from '../config/store';
import { nowIso } from '../db/db';
import { HttpError } from '../http/context';
import type { AgentFeed } from '../http/deps';
import type { ServerHandle } from '../server/handle';
import type { KeyValueSettings } from '../settings';

/** Where a plugin file came from, as the panel recorded it when it was added. */
export type PluginFrom = { upload: string; size: number; sha256: string | null } | { url: string };

/** Who added a plugin file, when, and from where. */
export interface PluginOriginInfo {
  addedAt: string;
  addedBy: string | null;
  from: PluginFrom;
}

/** A plugin file as the API shows it. */
export interface PluginEntry extends PluginFile {
  /** Who added this very file (its SHA-256), when and from where; null for one the panel didn't add (restored from a backup). */
  origin: PluginOriginInfo | null;
}

/** What an add did: the plugin source's answer, as entries. */
export interface PluginAddResult {
  added: PluginEntry[];
  replaced: string[];
  skipped: string[];
  from: PluginFrom;
  /** A running server takes the change at its next start. */
  restartNeeded: boolean;
}

/** An add the source refused: its reason, and where the plugin was to come from (for the audit log). */
export class PluginRefused extends HttpError {
  constructor(
    readonly reason: PluginRefusal,
    message: string,
    readonly from: PluginFrom | null,
  ) {
    super(reason === 'too-large' ? 413 : reason === 'not-found' ? 404 : 400, 'plugin-refused', message, { reason, message });
  }
}

/** Server settings key: the origin of each plugin file the panel added, by lower-case name. */
const ORIGINS_KEY = 'plugins.origins';
/** What the pending-restart notice lists for a plugin change. */
const PENDING_REASON = 'Plugins';
/** Longest name kept from an upload. */
const MAX_UPLOAD_NAME = 200;

type Origins = Record<string, PluginOriginInfo & { sha256: string }>;

export interface PluginsDeps {
  /** The server's own settings. */
  settings: KeyValueSettings;
  server: ServerHandle;
  feed: AgentFeed;
  config: Pick<ConfigStore, 'markPendingPublic'>;
  /** The server's plugin sources (those its flavour has the capability of); the first one serves. */
  sources: readonly PluginSource[];
  /** The panel's environment, for `PluginSource.checkLink` (tests point the release host elsewhere). */
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * The server's plugin files (MOD-06): listed, added from an upload or a
 * release link, enabled, disabled and removed through its plugin source,
 * whose work happens in the runtime's actions next to the files. The panel
 * never downloads a link itself (D11): it checks it, then the agent does,
 * checking every redirect. An upload reaches the server through its agent's
 * file API, into the source's upload folder, and the agent takes it from
 * there. Each change waits for the next start (the pending-restart badge).
 * One change at a time per server.
 */
export class PluginsService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: PluginsDeps) {}

  get available(): boolean {
    return this.d.sources.length > 0;
  }

  get sources(): readonly PluginSource[] {
    return this.d.sources;
  }

  /** The source, or 409 when the server takes no plugins. */
  private source(): PluginSource {
    const s = this.d.sources[0];
    if (!s) throw new HttpError(409, 'capability-unsupported');
    return s;
  }

  /** One change at a time: a second waits for the first. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private running(): boolean {
    return ['running', 'starting'].includes(this.d.feed.status_?.state ?? '');
  }

  private origins(): Origins {
    return this.d.settings.getRaw<Origins>(ORIGINS_KEY) ?? {};
  }

  private entry(f: PluginFile, origins: Origins): PluginEntry {
    const o = origins[f.name.toLowerCase()];
    return { ...f, origin: o && o.sha256 === f.sha256 ? { addedAt: o.addedAt, addedBy: o.addedBy, from: o.from } : null };
  }

  private ok<T extends object>(r: PluginReply<T>, from: PluginFrom | null = null): { ok: true } & T {
    if (!r.ok) throw new PluginRefused(r.reason, r.message, from);
    return r;
  }

  /** A running server takes a change at its next start: the badge says so. */
  private changed(): boolean {
    if (!this.running()) return false;
    this.d.config.markPendingPublic([PENDING_REASON]);
    return true;
  }

  async list(): Promise<{ plugins: PluginEntry[]; restartNeeded: boolean }> {
    const r = this.ok(await this.source().list(this.d.server.ctx()));
    const origins = this.origins();
    const plugins = r.plugins.map((f) => this.entry(f, origins));
    return { plugins, restartNeeded: this.running() && plugins.some((p) => p.enabled !== p.active) };
  }

  /** Records where the added files came from, and keeps the record to the files that are there. */
  private remember(r: PluginAdded, from: PluginFrom, by: string | null): PluginEntry[] {
    const origins = this.origins();
    const at = nowIso();
    for (const f of r.added) origins[f.name.toLowerCase()] = { sha256: f.sha256, addedAt: at, addedBy: by, from };
    this.d.settings.setRaw(ORIGINS_KEY, origins);
    return r.added.map((f) => this.entry(f, origins));
  }

  /**
   * An uploaded plugin file, or a zip of them. The file name says which;
   * anything else, or anything over the source's limit, is refused before
   * it reaches the server.
   */
  addUpload(filename: string, data: Buffer, by: string | null): Promise<PluginAddResult> {
    const source = this.source();
    const name = filename.split(/[\\/]/).pop()!.slice(0, MAX_UPLOAD_NAME);
    const lower = name.toLowerCase();
    const ext = [...source.extensions, '.zip'].find((x) => lower.endsWith(x));
    const from: PluginFrom = { upload: name, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    if (!ext || /[\x00-\x1f\x7f]/.test(name)) throw new PluginRefused('not-a-plugin', `${name} is neither a plugin file (${source.extensions.join(', ')}) nor a .zip of them`, from);
    if (data.length > source.maxBytes) throw new PluginRefused('too-large', `${name} is ${data.length} bytes, more than the ${source.maxBytes} allowed`, from);
    return this.serial(async () => {
      const ctx = this.d.server.ctx(by);
      const staged = `${randomUUID()}${ext}`;
      const rel = `${source.uploadDir.replace(/\/+$/, '')}/${staged}`;
      await ctx.files.writeAtomic('data', rel, data);
      let r: PluginReply<PluginAdded>;
      try {
        r = await source.add(ctx, { upload: staged, name });
      } finally {
        // The agent takes the upload away; this is in case it never got to.
        await ctx.files.remove('data', [rel]).catch(() => undefined);
      }
      const added = this.ok(r, from);
      return { added: this.remember(added, from, by), replaced: added.replaced, skipped: added.skipped, from, restartNeeded: this.changed() };
    });
  }

  /** A release link, checked here and downloaded by the server's agent, which checks it again with every redirect (D11). */
  addLink(url: string, by: string | null): Promise<PluginAddResult> {
    const source = this.source();
    const link = url.trim();
    const from: PluginFrom = { url: link.slice(0, 2000) };
    if (!source.linkHint) throw new PluginRefused('link-host', 'This server takes plugins by upload only', from);
    const refusal = source.checkLink(link, this.d.env);
    if (refusal) throw new PluginRefused(refusal, `The server doesn't download plugins from this link (${refusal})`, from);
    return this.serial(async () => {
      const added = this.ok(await source.add(this.d.server.ctx(by), { url: link }), from);
      return { added: this.remember(added, from, by), replaced: added.replaced, skipped: added.skipped, from, restartNeeded: this.changed() };
    });
  }

  setEnabled(name: string, enabled: boolean, by: string | null): Promise<{ changed: boolean; restartNeeded: boolean }> {
    const source = this.source();
    return this.serial(async () => {
      const r = this.ok(await source.setEnabled(this.d.server.ctx(by), name, enabled));
      return { changed: r.changed, restartNeeded: r.changed ? this.changed() : false };
    });
  }

  remove(name: string, by: string | null): Promise<{ restartNeeded: boolean }> {
    const source = this.source();
    return this.serial(async () => {
      this.ok(await source.remove(this.d.server.ctx(by), name));
      const origins = this.origins();
      const key = name.toLowerCase();
      if (Object.hasOwn(origins, key)) this.d.settings.setRaw(ORIGINS_KEY, Object.fromEntries(Object.entries(origins).filter(([k]) => k !== key)));
      return { restartNeeded: this.changed() };
    });
  }
}
