/**
 * The download services a Terraria install reads (UPD-01, UPD-02), through
 * the agent's `InstallCtx.fetch`, with answers kept for a while: GitHub
 * allows 60 anonymous calls an hour per address and counts a 304 too
 * (measured), so a version list and the install right after it ask once,
 * and once GitHub says the limit is used up nothing asks it again until the
 * time it gave.
 */
import type { InstallCtx, RuntimeCtx } from '@gsp/adapter-api';
import { DOWNLOAD_SOURCES } from '../shared/install';
import { RateLimitError, sourceUrls, type Get, type SourceId } from '../shared/versions';

/** How long an answer is kept: GitHub's release lists and terraria.org's version name. */
export const TTL_MS = 10 * 60_000;
const cache = new Map<string, { until: number; text: string }>();
/** GitHub said no more until then (unix ms). */
let githubBlockedUntil = 0;

/**
 * A URL a service's answer points at (a release asset): HTTPS, or on a
 * service the environment points elsewhere (tests, the dev loop).
 */
export function checkUrl(ctx: RuntimeCtx, url: string, what: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Bad download address for ${what}`);
  }
  if (u.protocol === 'https:') return url;
  const overridden = (Object.keys(DOWNLOAD_SOURCES) as SourceId[]).filter((id) => {
    const v = ctx.env[DOWNLOAD_SOURCES[id].env];
    return v !== undefined && v !== '';
  });
  const bases = sourceUrls(ctx.env);
  if (overridden.some((id) => new URL(bases[id]).origin === u.origin)) return url;
  throw new Error(`Refusing a download of ${what} that isn't HTTPS: ${u.origin}`);
}

/** The agent's GET, cached by time; a cached answer comes back as a fresh 200. */
export function cachedGet(ctx: InstallCtx): Get {
  const fetch = ctx.fetch;
  if (!fetch) throw new Error('This agent cannot download: InstallCtx.fetch is missing');
  const githubBase = sourceUrls(ctx.env).github;
  return async (url) => {
    const hit = cache.get(url);
    if (hit && hit.until > Date.now()) return new Response(hit.text, { status: 200 });
    const github = url.startsWith(`${githubBase}/`);
    if (github && githubBlockedUntil > Date.now()) throw new RateLimitError(githubBlockedUntil);
    const res = await fetch(url);
    if (github && (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      // Without a reset time, wait out the hour the limit counts in.
      githubBlockedUntil = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 3_600_000;
      return res;
    }
    if (!res.ok) return res;
    const text = await res.text();
    cache.set(url, { until: Date.now() + TTL_MS, text });
    return new Response(text, { status: 200 });
  };
}

/** Forgets every cached answer and GitHub's limit (tests). */
export function clearSourceCache(): void {
  cache.clear();
  githubBlockedUntil = 0;
}
