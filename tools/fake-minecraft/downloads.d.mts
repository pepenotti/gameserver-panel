// Types of downloads.mjs, for the TypeScript tests that start it.

export interface FakeDownloads {
  /** Base URL of every fake service (Mojang, Paper's Fill v3, Fabric's meta and maven). */
  url: string;
  /** What was asked, in order, with each request's User-Agent. */
  requests: { method: string | undefined; path: string; userAgent: string | null }[];
  close(): Promise<void>;
}

export function startFakeDownloads(o?: { port?: number; host?: string; fail?: '' | 'bad-checksum' | 'not-found' | 'rate-limit' }): Promise<FakeDownloads>;
