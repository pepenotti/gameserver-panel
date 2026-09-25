import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync, type Stats } from 'node:fs';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import type { BackupPartDecl } from '@gsp/adapter-api';
import type { AgentFeed } from '../http/deps';
import { HttpError } from '../http/context';
import type { ServerHandle } from '../server/handle';
import { globToRegExp, matchesAny } from './glob';
import { TarError, TarPacker, unpack } from './tar';

/** A backup part id, from the adapter's `backups.parts`. */
export type BackupPart = string;
export type BackupTrigger = 'manual' | 'scheduled' | 'pre-reset' | 'pre-restore' | 'pre-update' | 'upload';
const TRIGGERS: BackupTrigger[] = ['manual', 'scheduled', 'pre-reset', 'pre-restore', 'pre-update', 'upload'];
const PROTECTED: BackupTrigger[] = ['pre-reset', 'pre-restore', 'pre-update'];
const KEEP = { scheduled: 14, manual: 10, upload: 10 } as const;
const PROTECT_DAYS = 14;

export interface BackupManifest {
  format: 1;
  serverName: string;
  createdAt: string;
  trigger: BackupTrigger;
  mode: 'hot' | 'cold';
  gameVersion: string | null;
  buildId: string | null;
  branch: string | null;
  /** Items (Workshop ids…) of the enabled mods, `;`-separated. */
  workshopItems: string | null;
  /** Enabled mod ids in load order, `;`-separated. */
  mods: string | null;
  parts: BackupPart[];
  files: number;
  bytes: number;
  panelVersion: string;
  /** Things that went less than perfectly (e.g. a database copied without the SQLite backup API). */
  warnings?: string[];
}

export interface BackupInfo {
  name: string;
  size: number;
  sha256: string;
  pinned: boolean;
  manifest: BackupManifest;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Walk a directory, yielding paths relative to `root` (dirs end with /).
 * Symbolic links are skipped, never followed: whatever runs in the game
 * (mods) can create them, and a backup must not reach outside the data.
 */
export function* walk(root: string, rel: string): Generator<{ rel: string; abs: string; st: Stats }> {
  const abs = path.join(root, rel);
  let st: Stats;
  try {
    st = lstatSync(abs);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    yield { rel: `${rel}/`, abs, st };
    for (const e of readdirSync(abs).sort()) yield* walk(root, `${rel}/${e}`);
  } else if (st.isFile()) {
    yield { rel, abs, st };
  }
}

function exists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

export interface BackupDeps {
  /** Where this server's archives go. */
  dir: string;
  /** The server's data root on the panel's disk (until M2-C packs through the agent, D11). */
  dataDir: string;
  /** Recorded in each manifest. */
  panelVersion: string;
  feed: AgentFeed;
  server: ServerHandle;
  /** The enabled mods, recorded in each manifest. */
  mods?: { enabled(): { modId: string; workshopId: string }[] };
}

export class BackupService {
  private readonly nameRe: RegExp;

  constructor(private readonly d: BackupDeps) {
    const prefix = d.server.adapter.meta.id.replace(/[^a-z0-9-]/g, '');
    this.nameRe = new RegExp(`^${prefix}-[A-Za-z0-9_-]{1,32}-\\d{8}T\\d{6}Z-(${TRIGGERS.join('|')})(-\\d+)?\\.tar\\.zst$`);
  }

  /** Where this server's archives are. */
  get dir(): string {
    return this.d.dir;
  }

  private get name(): string {
    return this.d.server.ref.gameName;
  }

  /** Archive names start with the adapter id: `pz-<server>-<time>-<trigger>.tar.zst`. */
  private archiveName(serverName: string, createdAt: Date, trigger: BackupTrigger, n = 1): string {
    return `${this.d.server.adapter.meta.id}-${serverName}-${stamp(createdAt)}-${trigger}${n > 1 ? `-${n}` : ''}.tar.zst`;
  }

  assertName(name: string): void {
    if (!this.nameRe.test(name)) throw new HttpError(400, 'invalid-backup-name');
  }

  private decls(): BackupPartDecl[] {
    return this.d.server.adapter.backups.parts;
  }

  /** The adapter's part ids, in its order. */
  parts(): BackupPart[] {
    return this.decls().map((p) => p.id);
  }

  private decl(part: BackupPart): BackupPartDecl {
    const p = this.decls().find((x) => x.id === part);
    if (!p) throw new HttpError(400, 'unknown-part');
    return p;
  }

  /** Paths (relative to the data folder) that make up a part, for this server or another name (a restored backup's). */
  partPaths(part: BackupPart, serverName = this.name): string[] {
    return this.decl(part).paths({ ...this.d.server.ref, gameName: serverName });
  }

  /** Whether anything a backup would cover exists (there is something to protect). */
  hasData(): boolean {
    return this.parts().some((p) => this.partPaths(p).some((rel) => exists(path.join(this.d.dataDir, rel))));
  }

  // ------------------------------------------------------------------ list

  list(): BackupInfo[] {
    if (!existsSync(this.dir)) return [];
    const out: BackupInfo[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!this.nameRe.test(f)) continue;
      try {
        const side = JSON.parse(readFileSync(path.join(this.dir, `${f}.json`), 'utf8')) as Omit<BackupInfo, 'name'>;
        out.push({ name: f, ...side });
      } catch {
        // Archive without a sidecar (copied in by hand): list it with what we know.
        const st = statSync(path.join(this.dir, f));
        out.push({
          name: f,
          size: st.size,
          sha256: '',
          pinned: false,
          manifest: { format: 1, serverName: '?', createdAt: st.mtime.toISOString(), trigger: 'upload', mode: 'cold', gameVersion: null, buildId: null, branch: null, workshopItems: null, mods: null, parts: [], files: 0, bytes: 0, panelVersion: '?' },
        });
      }
    }
    return out.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
  }

  get(name: string): BackupInfo {
    this.assertName(name);
    const b = this.list().find((x) => x.name === name);
    if (!b) throw new HttpError(404, 'not-found');
    return b;
  }

  filePath(name: string): string {
    this.assertName(name);
    return path.join(this.dir, name);
  }

  setPinned(name: string, pinned: boolean): BackupInfo {
    const b = this.get(name);
    const { name: _n, ...side } = { ...b, pinned };
    writeFileSync(path.join(this.dir, `${name}.json`), JSON.stringify(side, null, 2));
    return { ...b, pinned };
  }

  delete(name: string): void {
    this.get(name);
    rmSync(path.join(this.dir, name), { force: true });
    rmSync(path.join(this.dir, `${name}.json`), { force: true });
  }

  /** Keep the newest N per trigger; protected triggers survive at least 14 days; pinned never expire. */
  applyRetention(): string[] {
    const removed: string[] = [];
    const now = Date.now();
    const byTrigger = new Map<BackupTrigger, BackupInfo[]>();
    for (const b of this.list()) byTrigger.set(b.manifest.trigger, [...(byTrigger.get(b.manifest.trigger) ?? []), b]);
    for (const [trigger, items] of byTrigger) {
      items.forEach((b, i) => {
        if (b.pinned) return;
        const age = now - new Date(b.manifest.createdAt).getTime();
        const expired = PROTECTED.includes(trigger) ? age > PROTECT_DAYS * 86_400_000 && i >= 3 : i >= (KEEP[trigger as keyof typeof KEEP] ?? 10);
        if (expired) {
          this.delete(b.name);
          removed.push(b.name);
        }
      });
    }
    return removed;
  }

  // ---------------------------------------------------------------- create

  private sourceBytes(parts: BackupPart[]): number {
    let total = 0;
    for (const part of parts) for (const p of this.partPaths(part)) for (const f of walk(this.d.dataDir, p)) if (f.st.isFile()) total += f.st.size;
    return total;
  }

  /**
   * Archive every part the adapter declares. `hot` means the server is
   * running: files matching a part's `sqlite` globs (relative to the data
   * folder) are copied as consistent SQLite snapshots instead of being read
   * mid-write.
   */
  async create(opts: { trigger: BackupTrigger; hot: boolean; onProgress?: (fraction: number) => void }): Promise<BackupInfo> {
    mkdirSync(this.dir, { recursive: true });
    const data = this.d.dataDir;
    const parts = this.parts().filter((p) => this.partPaths(p).some((rel) => exists(path.join(data, rel))));
    const total = this.sourceBytes(parts);
    const free = statfsSync(this.dir);
    // Estimate the archive at 60% of the raw size (zstd usually does better) and keep 20% headroom.
    if (free.bavail * free.bsize < total * 1.2 * 0.6) throw new HttpError(507, 'no-space', undefined, { neededBytes: Math.round(total * 0.72), freeBytes: free.bavail * free.bsize });

    const createdAt = new Date();
    let name = this.archiveName(this.name, createdAt, opts.trigger);
    for (let i = 2; existsSync(path.join(this.dir, name)); i++) name = this.archiveName(this.name, createdAt, opts.trigger, i);
    const tmp = path.join(this.dir, `.${name}.partial`);
    const snapDir = path.join(data, '.panel-snapshots', randomUUID());

    const status = this.d.feed.status_;
    const installed = status?.installedInfo;
    const enabled = this.d.mods?.enabled() ?? [];

    const hash = createHash('sha256');
    let size = 0;
    const out = createWriteStream(tmp);
    const zstd = createZstdCompress();
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    const done = pipeline(zstd, counter, out);
    const tar = new TarPacker(zstd);
    let files = 0;
    let bytes = 0;
    const warnings: string[] = [];
    try {
      const manifest: BackupManifest = {
        format: 1,
        serverName: this.name,
        createdAt: createdAt.toISOString(),
        trigger: opts.trigger,
        mode: opts.hot ? 'hot' : 'cold',
        gameVersion: installed?.version ?? null,
        buildId: installed?.build ?? null,
        branch: installed?.channel ?? null,
        workshopItems: enabled.length ? [...new Set(enabled.map((e) => e.workshopId))].join(';') : null,
        mods: enabled.length ? enabled.map((e) => e.modId).join(';') : null,
        parts,
        files: 0,
        bytes: total,
        panelVersion: this.d.panelVersion,
      };
      // Written first so a reader can check it before unpacking gigabytes.
      await tar.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)), createdAt.getTime() / 1000);
      for (const part of parts) {
        const sqlite = (this.decl(part).sqlite ?? []).map(globToRegExp);
        for (const rel of this.partPaths(part)) {
          for (const f of walk(data, rel)) {
            const archName = `data/${f.rel}`;
            const mtime = f.st.mtimeMs / 1000;
            if (f.rel.endsWith('/')) {
              await tar.addDir(archName, mtime);
              continue;
            }
            let src = f.abs;
            let len = f.st.size;
            if (opts.hot && matchesAny(f.rel, sqlite)) {
              mkdirSync(snapDir, { recursive: true });
              const snap = path.join(snapDir, `${files}.db`);
              try {
                // One read transaction, so a consistent snapshot even while the game writes.
                // (node:sqlite's async backup() sometimes stalled for minutes in testing.)
                const db = new DatabaseSync(f.abs, { readOnly: true, timeout: 10_000 });
                try {
                  db.prepare('VACUUM INTO ?').run(snap);
                } finally {
                  db.close();
                }
                src = snap;
                len = statSync(snap).size;
              } catch (e) {
                // Not a SQLite file after all (or locked): fall back to a plain copy rather than failing the backup.
                warnings.push(`${f.rel}: copied as a plain file (${(e as Error).message})`);
              }
            }
            await tar.addFile(archName, src, len, mtime);
            files++;
            bytes += f.st.size;
            opts.onProgress?.(total ? Math.min(bytes / total, 1) : 1);
          }
        }
      }
      await tar.finish();
      zstd.end();
      await done;
      const sha256 = hash.digest('hex');
      renameSync(tmp, path.join(this.dir, name));
      const info: BackupInfo = { name, size, sha256, pinned: false, manifest: { ...manifest, files, ...(warnings.length ? { warnings } : {}) } };
      const { name: _n, ...side } = info;
      writeFileSync(path.join(this.dir, `${name}.json`), JSON.stringify(side, null, 2));
      this.applyRetention();
      return info;
    } catch (e) {
      zstd.destroy();
      out.destroy();
      rmSync(tmp, { force: true });
      throw e;
    } finally {
      rmSync(snapDir, { recursive: true, force: true });
    }
  }

  // --------------------------------------------------------------- verify

  async sha256(name: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(this.filePath(name)) as AsyncIterable<Buffer>) hash.update(chunk);
    return hash.digest('hex');
  }

  /** Read just the manifest (first entry) of an archive. */
  async readManifest(file: string): Promise<BackupManifest> {
    let manifest: BackupManifest | null = null;
    const chunks: Buffer[] = [];
    const src = createReadStream(file).pipe(createZstdDecompress());
    try {
      await unpack(src as AsyncIterable<Buffer>, async (e) => {
        if (manifest === null && e.name === 'manifest.json' && e.type === 'file' && e.size < 1 << 20) {
          return new Writable({
            write(c: Buffer, _enc, cb) {
              chunks.push(c);
              cb();
            },
            final(cb) {
              manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BackupManifest;
              cb();
            },
          });
        }
        if (manifest === null) throw new TarError('manifest.json must be the first entry');
        throw new StopUnpack();
      });
    } catch (e) {
      if (!(e instanceof StopUnpack)) throw e;
    } finally {
      src.destroy();
    }
    if (!manifest) throw new TarError('No manifest');
    const m = manifest as BackupManifest;
    if (m.format !== 1 || typeof m.serverName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(m.serverName) || !Array.isArray(m.parts)) throw new TarError('Invalid manifest');
    return m;
  }

  // -------------------------------------------------------------- restore

  /**
   * Unpack the chosen parts into `staging`, renaming the backup's server name
   * to ours. Every entry is checked: only plain files/dirs, only paths that
   * belong to a chosen part, nothing that escapes the staging folder.
   */
  async extract(name: string, parts: BackupPart[], staging: string, onProgress?: (fraction: number) => void): Promise<{ files: number }> {
    const info = this.get(name);
    const from = info.manifest.serverName;
    const allowed = parts.flatMap((p) => this.partPaths(p, from).map((rel) => ({ rel, part: p })));
    const renameTo = (rel: string): string | null => {
      for (const a of allowed) {
        if (rel === a.rel || rel.startsWith(`${a.rel}/`)) {
          const ours = this.partPaths(a.part)[this.partPaths(a.part, from).indexOf(a.rel)]!;
          return ours + rel.slice(a.rel.length);
        }
      }
      return null;
    };
    mkdirSync(staging, { recursive: true });
    let files = 0;
    let seen = 0;
    const total = info.manifest.bytes || 1;
    const src = createReadStream(this.filePath(name)).pipe(createZstdDecompress());
    await unpack(src as AsyncIterable<Buffer>, async (e) => {
      if (e.name === 'manifest.json') return null;
      const n = e.name.replace(/\/$/, '');
      if (!n.startsWith('data/') || n.includes('\\') || n.split('/').some((seg) => seg === '..' || seg === '.' || seg === '') || /^[A-Za-z]:/.test(n)) {
        throw new TarError(`Unsafe path in archive: ${e.name}`);
      }
      const mapped = renameTo(n.slice('data/'.length));
      if (mapped === null) return null; // a part we're not restoring (or junk): skip
      const dest = path.join(staging, mapped);
      if (!path.resolve(dest).startsWith(path.resolve(staging) + path.sep)) throw new TarError(`Unsafe path in archive: ${e.name}`);
      if (e.type === 'dir') {
        mkdirSync(dest, { recursive: true });
        return null;
      }
      mkdirSync(path.dirname(dest), { recursive: true });
      files++;
      seen += e.size;
      onProgress?.(Math.min(seen / total, 1));
      return createWriteStream(dest, { flags: 'wx' });
    });
    return { files };
  }

  /**
   * Swap staged parts into place with renames (same volume, so each is atomic),
   * moving what was there into `trash` for rollback.
   */
  swapIn(parts: BackupPart[], staging: string, trash: string): void {
    const data = this.d.dataDir;
    for (const part of parts) {
      for (const rel of this.partPaths(part)) {
        const live = path.join(data, rel);
        const staged = path.join(staging, rel);
        if (exists(live)) {
          mkdirSync(path.dirname(path.join(trash, rel)), { recursive: true });
          renameSync(live, path.join(trash, rel));
        }
        if (existsSync(staged)) {
          mkdirSync(path.dirname(live), { recursive: true });
          renameSync(staged, live);
        }
      }
    }
  }

  /** Undo swapIn: put the trash back. */
  rollback(parts: BackupPart[], trash: string): void {
    const data = this.d.dataDir;
    for (const part of parts) {
      for (const rel of this.partPaths(part)) {
        const kept = path.join(trash, rel);
        const live = path.join(data, rel);
        if (!existsSync(kept)) {
          // Nothing existed before; remove what the restore added.
          rmSync(live, { recursive: true, force: true });
          continue;
        }
        rmSync(live, { recursive: true, force: true });
        mkdirSync(path.dirname(live), { recursive: true });
        renameSync(kept, live);
      }
    }
  }

  /** Accept an uploaded archive: validate it and give it a canonical name. */
  async adopt(tmpFile: string): Promise<BackupInfo> {
    const manifest = await this.readManifest(tmpFile);
    // Full read to prove the archive is complete and contains only safe entries.
    const src = createReadStream(tmpFile).pipe(createZstdDecompress());
    await unpack(src as AsyncIterable<Buffer>, async (e) => {
      const n = e.name.replace(/\/$/, '');
      if (e.name !== 'manifest.json' && (!n.startsWith('data/') || n.split('/').some((s) => s === '..' || s === '.' || s === '') || n.includes('\\'))) throw new TarError(`Unsafe path in archive: ${e.name}`);
      return null;
    });
    const created = new Date();
    const name = this.archiveName(manifest.serverName, created, 'upload');
    renameSync(tmpFile, path.join(this.dir, name));
    const sha256 = await this.sha256(name);
    const info: BackupInfo = { name, size: statSync(path.join(this.dir, name)).size, sha256, pinned: false, manifest: { ...manifest, trigger: 'upload' } };
    const { name: _n, ...side } = info;
    writeFileSync(path.join(this.dir, `${name}.json`), JSON.stringify(side, null, 2));
    return info;
  }
}

class StopUnpack extends Error {}
