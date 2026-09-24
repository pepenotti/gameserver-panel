/**
 * Login throttling that works when every client shares one IP (Docker
 * Desktop's port proxy): a per-account exponential delay instead of a
 * lockout (so an attacker can't lock the owner out), plus a global breaker
 * that slows everything down during a spray.
 */

const FREE_ATTEMPTS = 3;
const MAX_DELAY_MS = 5 * 60_000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_LIMIT = 30;
const GLOBAL_COOLDOWN_MS = 60_000;

export function delayAfter(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(1000 * 2 ** (failures - FREE_ATTEMPTS), MAX_DELAY_MS);
}

export class GlobalBreaker {
  private failures: number[] = [];
  private openUntil = 0;
  /** Unknown usernames get the same per-name delay as real ones, kept in memory. */
  private readonly unknown = new Map<string, { failures: number; until: number }>();

  constructor(private readonly onTrip?: (count: number) => void) {}

  /** Milliseconds to wait before any login is accepted. */
  blockedFor(now = Date.now()): number {
    return Math.max(0, this.openUntil - now);
  }

  recordFailure(now = Date.now()): void {
    this.failures = this.failures.filter((t) => now - t < GLOBAL_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length >= GLOBAL_LIMIT && this.openUntil <= now) {
      this.openUntil = now + GLOBAL_COOLDOWN_MS;
      this.onTrip?.(this.failures.length);
    }
  }

  unknownUserBlockedFor(name: string, now = Date.now()): number {
    const e = this.unknown.get(name.toLowerCase());
    return e ? Math.max(0, e.until - now) : 0;
  }

  recordUnknownUser(name: string, now = Date.now()): void {
    const key = name.toLowerCase();
    const e = this.unknown.get(key) ?? { failures: 0, until: 0 };
    e.failures++;
    e.until = now + delayAfter(e.failures);
    this.unknown.set(key, e);
    if (this.unknown.size > 10_000) this.unknown.clear();
  }
}
