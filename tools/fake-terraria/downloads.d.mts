// Types of downloads.mjs, for the TypeScript tests that start it.

export interface FakeDownloads {
  /** Base URL of every fake service (terraria.org, GitHub's API and its release assets). */
  url: string;
  /** What was asked, in order, with each request's User-Agent. */
  requests: { method: string | undefined; path: string; userAgent: string | null }[];
  close(): Promise<void>;
}

export function startFakeDownloads(o?: { port?: number; host?: string; fail?: '' | 'bad-checksum' | 'not-found' | 'rate-limit' }): Promise<FakeDownloads>;

export function makeZip(entries: { name: string; data: Buffer | string; mode?: number }[], o?: { unix?: boolean }): Buffer;
export function makeTar(entries: { name: string; data?: Buffer | string; mode?: number }[]): Buffer;
/** A fake TShock plugin (`MZ` and a marker line `server.mjs` loads it by). */
export function fakePlugin(name: string, version?: string, author?: string): Buffer;
/** A fake .NET assembly that isn't a plugin (TShock ignores it without a word). */
export function fakeAssembly(name: string): Buffer;
