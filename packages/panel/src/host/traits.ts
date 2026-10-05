import type { HostInfo, HostTraits } from '@gsp/shared';
import type { OrchestratorClient } from '../servers/orchestrator';

/**
 * Whether players' and visitors' addresses reach the games and the panel
 * here, as the panel shows it (HST-07):
 * - `hidden`: they don't (Docker Desktop's port relay; measured);
 * - `visible`: they do: measured on this kind of host, or the owner says so
 *   (`CLIENT_IP_TRUSTWORTHY=true`);
 * - `expected`: Docker Engine, whose port forwarding is expected to keep
 *   them, not yet measured (M7);
 * - `unknown`: the orchestrator doesn't say (unreachable, or older than
 *   host traits).
 */
export type AddressView = 'hidden' | 'visible' | 'expected' | 'unknown';

/**
 * The host's trait and the owner's word together: what was measured wins
 * (Docker Desktop hides them whatever `.env` says); otherwise the owner's
 * `CLIENT_IP_TRUSTWORTHY=true` makes them visible; otherwise the
 * orchestrator's expectation, or unknown.
 */
export function addressesOf(traits: HostTraits | null | undefined, clientIpTrustworthy: boolean): AddressView {
  if (traits?.addressesVisible === false) return 'hidden';
  if (traits?.addressesVisible === true || clientIpTrustworthy) return 'visible';
  return traits?.addressesVisible === 'expected' ? 'expected' : 'unknown';
}

/** Whether a ban of an address names one player's address (not every player's): the address-ban notes say so. */
export const addressesTrustworthy = (a: AddressView) => a === 'visible' || a === 'expected';

export interface HostTraitsOptions {
  orchestrator: Pick<OrchestratorClient, 'host'>;
  /** `CLIENT_IP_TRUSTWORTHY`: the owner says the panel's and the games' clients arrive with their own addresses. */
  clientIpTrustworthy: boolean;
  /** How long an answer is kept (default 60 s), and a failure (default 10 s). */
  ttlMs?: number;
  failureTtlMs?: number;
  /** How long a page waits for the orchestrator before it shows what it knows (default 3 s); the answer still fills the cache. */
  waitMs?: number;
  now?: () => number;
}

/**
 * The host as the orchestrator describes it (`GET /v1/host`), asked at most
 * once a minute for the pages that show a note about it (address bans, the
 * activity log, per-address game settings): the host doesn't change while
 * the panel runs, and these pages must not wait on the orchestrator.
 */
export class HostTraitsCache {
  private value: { at: number; host: HostInfo | null } | null = null;
  private asking: Promise<HostInfo | null> | null = null;

  constructor(private readonly o: HostTraitsOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private fresh(): boolean {
    if (!this.value) return false;
    const ttl = this.value.host ? (this.o.ttlMs ?? 60_000) : (this.o.failureTtlMs ?? 10_000);
    return this.now() - this.value.at < ttl;
  }

  /** The host, or null when the orchestrator can't say; a slow orchestrator answers what was known before. */
  async host(): Promise<HostInfo | null> {
    if (this.fresh()) return this.value!.host;
    this.asking ??= this.o.orchestrator
      .host()
      .catch(() => null)
      .then((host) => {
        this.value = { at: this.now(), host };
        return host;
      })
      .finally(() => {
        this.asking = null;
      });
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), this.o.waitMs ?? 3000);
      timer.unref?.();
    });
    try {
      const r = await Promise.race([this.asking, late]);
      return r === 'late' ? (this.value?.host ?? null) : r;
    } finally {
      clearTimeout(timer);
    }
  }

  async addresses(): Promise<AddressView> {
    return addressesOf((await this.host())?.traits, this.o.clientIpTrustworthy);
  }
}
