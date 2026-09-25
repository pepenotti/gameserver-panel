import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BackupPartDecl, DirEntry, ServerFiles } from '@gsp/adapter-api';
import { closeIterable, isSafeName, readTarZst, segments, TarError, TarPacker, unpack, zstdCompress } from '@gsp/archive';
import type { AgentFeed } from '../http/deps';
import { HttpError } from '../http/context';
import type { ServerHandle } from '../server/handle';

/** A backup part id, from the adapter's `backups.parts`. */
export type BackupPart = string;
export type BackupTrigger = 'manual' | 'scheduled' | 'pre-reset' | 'pre-restore' | 'pre-update' | 'upload';
const TRIGGERS: BackupTrigger[] = ['manual', 'scheduled', 'pre-reset', 'pre-restore', 'pre-update', 'upload'];
const PROTECTED: BackupTrigger[] = ['pre-reset', 'pre-restore', 'pre-update'];
const KEEP = { scheduled: 14, manual: 10, upload: 10 } as const;
const PROTECT_DAYS = 14;
/** Inside an archive, the server's files live under `data/`, next to `manifest.json`. */
const DATA_PREFIX = 'data/';

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
  /** Things that went less than perfectly (e.g. a database copied without a snapshot). */
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

/** The data-root path of an archive entry under `data/`, or null when it is anything else (or not a path the file API takes). */
export function dataRel(entryName: string): string | null {
  const n = entryName.replace(/\/$/, '');
  if (!n.startsWith(DATA_PREFIX)) return null;
  const rel = n.slice(DATA_PREFIX.length);
  try {
    const parts = segments(rel);
    return parts.length > 0 && parts.join('/') === rel ? rel : null;
  } catch {
    return null;
  }
}

const inside = (rel: string, roots: readonly string[]) => roots.some((r) => rel === r || rel.startsWith(`${r}/`));

export interface BackupDeps {
  /** Where this server's archives go (`BACKUP_DIR/<server>/`). */
  dir: string;
  /** The server's files (D11: through its agent); by default the server handle's. */
  files?: ServerFiles;
  /** @deprecated Unused since backups go through `ServerFiles` (D11); the panel no longer reads game files itself. */
  dataDir?: string;
  /** Recorded in each manifest. */
  panelVersion: string;
  feed: AgentFeed;
  server: ServerHandle;
  /** The enabled mods, recorded in each manifest. */
  mods?: { enabled(): { modId: string; workshopId: string }[] };
}

/**
 * A server's backups (BAK-01…05). Archives, their manifests and checksums
 * live on the panel's disk; the server's files are reached only through
 * `ServerFiles` (D11): its agent packs them (hot while the game runs, with
 * the game's own steps), stages a restore next to the data, swaps it in and
 * keeps what it replaced for an undo.
 */
export class BackupService {
  private readonly nameRe: RegExp;
  private readonly files: ServerFiles;

  constructor(private readonly d: BackupDeps) {
    const prefix = d.server.adapter.meta.id.replace(/[^a-z0-9-]/g, '');
    this.nameRe = new RegExp(`^${prefix}-[A-Za-z0-9_-]{1,32}-\\d{8}T\\d{6}Z-(${TRIGGERS.join('|')})(-\\d+)?\\.tar\\.zst$`);
    this.files = d.files ?? d.server.ctx().files;
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

  /** Whether anything of a part exists. */
  private async present(part: BackupPart): Promise<boolean> {
    for (const rel of this.partPaths(part)) {
      try {
        if (await this.files.stat('data', rel)) return true;
      } catch {
        // A path the file API refuses (a link): nothing a backup could copy.
      }
    }
    return false;
  }

  /** Whether anything a backup would cover exists (there is something to protect). */
  async hasData(): Promise<boolean> {
    for (const part of this.parts()) if (await this.present(part)) return true;
    return false;
  }

  /** Bytes of the files under `rel`, walked through the file API (links skipped, as a pack skips them). */
  private async sizeOf(rel: string): Promise<number> {
    const st = await this.files.stat('data', rel).catch(() => null);
    if (st?.kind === 'file') return st.size;
    if (st?.kind !== 'dir') return 0;
    let total = 0;
    const dirs = [rel];
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      let entries: DirEntry[];
      try {
        entries = await this.files.list('data', dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.kind === 'file') total += e.size;
        else if (e.kind === 'dir' && isSafeName(e.name)) dirs.push(`${dir}/${e.name}`);
      }
    }
    return total;
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

  /**
   * Archive every part the adapter declares that exists. The server's files
   * come from `ServerFiles.pack` as a tar stream (the agent copies hot while
   * the game runs: the game's own steps and SQLite snapshots of the parts'
   * `sqlite` globs); the panel adds the manifest first, compresses, and
   * writes the archive, its checksum and its sidecar. `hot` is what the
   * manifest records.
   */
  async create(opts: { trigger: BackupTrigger; hot: boolean; onProgress?: (fraction: number) => void }): Promise<BackupInfo> {
    mkdirSync(this.dir, { recursive: true });
    const parts: BackupPart[] = [];
    for (const part of this.parts()) if (await this.present(part)) parts.push(part);
    const rels = parts.flatMap((p) => this.partPaths(p));
    let total = 0;
    for (const rel of rels) total += await this.sizeOf(rel);
    const free = statfsSync(this.dir);
    // Estimate the archive at 60% of the raw size (zstd usually does better) and keep 20% headroom.
    if (free.bavail * free.bsize < total * 1.2 * 0.6) throw new HttpError(507, 'no-space', undefined, { neededBytes: Math.round(total * 0.72), freeBytes: free.bavail * free.bsize });

    const createdAt = new Date();
    let name = this.archiveName(this.name, createdAt, opts.trigger);
    for (let i = 2; existsSync(path.join(this.dir, name)); i++) name = this.archiveName(this.name, createdAt, opts.trigger, i);
    const tmp = path.join(this.dir, `.${name}.partial`);

    const installed = this.d.feed.status_?.installedInfo;
    const enabled = this.d.mods?.enabled() ?? [];

    const hash = createHash('sha256');
    let size = 0;
    const out = createWriteStream(tmp);
    const zstd = zstdCompress();
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    const done = pipeline(zstd, counter, out);
    // Awaited below; a failure (a full disk) must not count as unhandled before then.
    done.catch(() => undefined);
    const tar = new TarPacker(zstd);
    let files = 0;
    let bytes = 0;
    const warnings: string[] = [];
    // A server that sends far more than it holds is cut off before it fills the backup disk.
    const limit = total * 2 + 256 * 1024 * 1024;
    let src: AsyncIterable<Buffer> | null = null;
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
      if (rels.length > 0) {
        const sqlite = [...new Set(parts.flatMap((p) => this.decl(p).sqlite ?? []))];
        src = await this.files.pack({ root: 'data', rels, sqlite, prefix: DATA_PREFIX });
        await unpack(src, async (e) => {
          // What the server sent is checked like an upload: only its parts, under data/.
          const rel = dataRel(e.name);
          if (rel === null || !inside(rel, rels)) throw new TarError(`Unexpected path in the server's archive: ${e.name}`);
          const note = e.meta?.['GSP.warning'];
          if (note) warnings.push(note);
          if (e.type === 'dir') {
            await tar.addDir(e.name, e.mtime);
            return null;
          }
          files++;
          bytes += e.size;
          if (bytes > limit) throw new TarError('The server sent more data than it holds');
          opts.onProgress?.(total ? Math.min(bytes / total, 1) : 1);
          return tar.addFile(e.name, e.size, e.mtime);
        });
      }
      await tar.finish();
      zstd.end();
      await done;
      const sha256 = hash.digest('hex');
      renameSync(tmp, path.join(this.dir, name));
      const info: BackupInfo = { name, size, sha256, pinned: false, manifest: { ...manifest, files, bytes, ...(warnings.length ? { warnings } : {}) } };
      const { name: _n, ...side } = info;
      writeFileSync(path.join(this.dir, `${name}.json`), JSON.stringify(side, null, 2));
      this.applyRetention();
      return info;
    } catch (e) {
      zstd.destroy();
      out.destroy();
      await done.catch(() => undefined);
      rmSync(tmp, { force: true });
      throw e;
    } finally {
      // Hangs up on a pack that didn't finish (the agent's hot copy then runs its `after`).
      if (src) await closeIterable(src).catch(() => undefined);
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
    const src = readTarZst(file);
    try {
      await unpack(src, async (e) => {
        if (manifest === null && e.name === 'manifest.json' && e.type === 'file' && e.size < 1 << 20) {
          return new Writable({
            write(c: Buffer, _enc, cb) {
              chunks.push(c);
              cb();
            },
            final(cb) {
              try {
                manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BackupManifest;
                cb();
              } catch {
                cb(new TarError('Invalid manifest'));
              }
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
   * Stage the chosen parts of a backup next to the server's data, renamed
   * from the backup's server name to ours: the archive is read here, checked
   * (only plain files and folders under `data/`; paths of other parts are
   * left out) and streamed to `ServerFiles.stage`, which checks every entry
   * again. `rels` are the data-root paths a swap then moves into place.
   */
  async stage(name: string, parts: BackupPart[], onProgress?: (fraction: number) => void): Promise<{ stagingId: string; rels: string[] }> {
    const info = this.get(name);
    const from = info.manifest.serverName;
    const mapping = parts.flatMap((p) => {
      const ours = this.partPaths(p);
      return this.partPaths(p, from).map((theirs, i) => ({ theirs, ours: ours[i]! }));
    });
    const rels = parts.flatMap((p) => this.partPaths(p));
    const renameTo = (rel: string): string | null => {
      for (const m of mapping) if (rel === m.theirs || rel.startsWith(`${m.theirs}/`)) return m.ours + rel.slice(m.theirs.length);
      return null;
    };
    const file = this.filePath(name);
    const total = statSync(file).size || 1;
    const src = readTarZst(file, (n) => onProgress?.(Math.min(n / total, 1)));
    const staged = new PassThrough();
    // Its reader gets the error (a stream remembers it); this only keeps an early one from going unhandled.
    staged.on('error', () => undefined);
    const tar = new TarPacker(staged);
    let producerError: unknown = null;
    const producing = (async () => {
      await unpack(src, async (e) => {
        if (e.name === 'manifest.json') return null;
        const rel = dataRel(e.name);
        if (rel === null) throw new TarError(`Unsafe path in archive: ${e.name}`);
        const mapped = renameTo(rel);
        if (mapped === null) return null; // a part we're not restoring
        if (e.type === 'dir') {
          await tar.addDir(mapped, e.mtime);
          return null;
        }
        return tar.addFile(mapped, e.size, e.mtime);
      });
      await tar.finish();
      staged.end();
    })().catch((e: unknown) => {
      producerError ??= e;
      staged.destroy(e as Error);
    });
    try {
      const { stagingId } = await this.files.stage(staged, rels);
      await producing;
      return { stagingId, rels };
    } catch (e) {
      // The archive's own fault comes first; otherwise the stage's refusal.
      if (producerError) throw producerError;
      staged.destroy(new TarError('Staging stopped'));
      await producing;
      throw e;
    } finally {
      src.destroy();
    }
  }

  /** Move staged paths into place; what they replace goes to a trash folder (kept for an undo). */
  swap(stagingId: string, rels: string[]): Promise<{ trashId: string }> {
    return this.files.swap(stagingId, rels);
  }

  /** Put a trash folder's files back. */
  undo(trashId: string): Promise<void> {
    return this.files.undo(trashId);
  }

  purgeTrash(trashId: string): Promise<void> {
    return this.files.purgeTrash(trashId);
  }

  /** Delete parts (a reset, after its safety backup). */
  removeParts(parts: BackupPart[]): Promise<void> {
    return this.files.remove('data', parts.flatMap((p) => this.partPaths(p)));
  }

  /** Accept an uploaded archive: validate it and give it a canonical name. */
  async adopt(tmpFile: string): Promise<BackupInfo> {
    const manifest = await this.readManifest(tmpFile);
    // Full read to prove the archive is complete and contains only safe entries.
    const src = readTarZst(tmpFile);
    try {
      await unpack(src, async (e) => {
        if (e.name !== 'manifest.json' && dataRel(e.name) === null) throw new TarError(`Unsafe path in archive: ${e.name}`);
        return null;
      });
    } finally {
      src.destroy();
    }
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
