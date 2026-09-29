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
