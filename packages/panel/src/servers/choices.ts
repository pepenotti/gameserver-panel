import type { ChoicesCtx, LaunchChoices, PanelAdapter } from '@gsp/adapter-api';
import { HttpError } from '../http/context';

/** How long an answer is kept: the download services cache their lists for 2 to 30 minutes themselves. */
export const CHOICES_TTL_MS = 5 * 60_000;
/** How long one request to a download service may take. */
const FETCH_TIMEOUT_MS = 15_000;

export interface ChoicesDeps {
  /** The panel's version, in its User-Agent. */
  version: string;
  /** How the panel reaches the web (tests: the fake download services, or nothing). */
  fetch?: typeof fetch;
  /** Adapter knobs (download service overrides: the dev loop and tests); default the panel's environment. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * What a game's version and version-dependent launch settings may be set
 * to (UPD-02), from its download services, for the create form and a
 * server's page (`PanelAdapter.launch.choices`). The panel names itself,
 * gives each request a time limit, and keeps each answer a few minutes, so
 * a form that asks again as someone picks doesn't ask the services again.
 */
export class LaunchChoicesService {
  private readonly cache = new Map<string, { until: number; value: Promise<LaunchChoices> }>();
  private readonly ctx: ChoicesCtx;

  constructor(d: ChoicesDeps) {
    const get = d.fetch ?? fetch;
    const ua = `gameserver-panel/${d.version}`;
    this.ctx = {
      fetch: (url) => get(url, { headers: { 'user-agent': ua, accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' }),
      env: d.env ?? process.env,
    };
  }

  /** 409 `choices-unsupported` for a game that lists none; 502 `choices-unavailable` when its services can't be asked. */
  async get(adapter: PanelAdapter, flavour: string | null, version: string | null): Promise<LaunchChoices> {
    const choices = adapter.launch.choices;
    if (!choices) throw new HttpError(409, 'choices-unsupported');
    const flavours = adapter.meta.flavours;
    if (flavours.length ? !flavours.some((f) => f.id === flavour) : flavour !== null) throw new HttpError(400, 'unknown-flavour', undefined, { flavours: flavours.map((f) => f.id) });
    const key = JSON.stringify([adapter.meta.id, flavour, version]);
    const now = Date.now();
    for (const [k, v] of this.cache) if (v.until <= now) this.cache.delete(k);
    let hit = this.cache.get(key);
    if (!hit) {
      hit = { until: now + CHOICES_TTL_MS, value: choices.call(adapter.launch, { flavour, version }, this.ctx) };
      this.cache.set(key, hit);
      // A failure isn't kept: the next ask tries again.
      hit.value.catch(() => this.cache.delete(key));
    }
    try {
      return await hit.value;
    } catch (e) {
      const message = (e as Error).message;
      throw new HttpError(502, 'choices-unavailable', message, { message });
    }
  }
}
