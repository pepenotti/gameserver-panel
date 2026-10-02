import { checkAddress, isIPv4, isPrivateIPv4, type AddressProblem, type DetectedAddress, type HostAddressUpdate, type HostAddressView } from '@gsp/shared';
import type { PanelEnv } from '../env';
import type { KeyValueSettings } from '../settings';

/** The host setting (table `settings`) the owner's addresses are kept under (HST-08). */
export const HOST_ADDRESS_KEY = 'host.address';

/**
 * The one public service "Detect" asks for this host's public IPv4 address
 * (HST-08, NFR-09): only when the owner presses the button, one HTTPS GET
 * with nothing but the request, its answer a bare address.
 */
export const DETECT_SERVICE = 'https://api.ipify.org';

/** How long Detect waits for the service. */
export const DETECT_TIMEOUT_MS = 5000;

/** What the owner set; null: the default. */
interface Stored {
  public: string | null;
  home: string | null;
}

/** An address the owner typed that isn't one (400 `invalid-address`): which field, and why. */
export class AddressRefusal extends Error {
  constructor(
    readonly field: 'public' | 'home',
    readonly problem: AddressProblem,
  ) {
    super(`The ${field} address is refused: ${problem}`);
  }
}

/** The service didn't give an address (502 `detect-failed`); `reason` for the audit log. */
export class DetectFailure extends Error {
  constructor(readonly reason: string) {
    super(`The address service gave no address: ${reason}`);
  }
}

/**
 * The defaults the panel knows from its own setup (`PanelEnv`): the
 * DuckDNS name it uses for HTTPS (`DUCKDNS_SUBDOMAIN`, or the `.duckdns.org`
 * name among its origins, which `PANEL_TLS=duckdns` puts there), and its
 * home-network address (`LAN_IP`, a private IPv4 address among its origins).
 */
export function addressDefaults(env: Pick<PanelEnv, 'origins' | 'duckdnsSubdomain'>): { public: string | null; home: string | null } {
  const hosts = env.origins.map((o) => {
    try {
      return new URL(o).hostname.toLowerCase();
    } catch {
      return '';
    }
  });
  const sub = env.duckdnsSubdomain?.trim().toLowerCase() ?? '';
  const fromSub = sub ? `${sub}.duckdns.org` : null;
  const duck = (fromSub && checkAddress(fromSub).ok ? fromSub : null) ?? hosts.find((h) => h.endsWith('.duckdns.org') && checkAddress(h).ok) ?? null;
  const home = hosts.find((h) => isPrivateIPv4(h)) ?? null;
  return { public: duck, home };
}

/**
 * The host's public address and its home-network address (HST-08), as the
 * owner sets them, over the defaults; every server's connection info
 * (SRV-08) uses them.
 */
export class HostAddress {
  constructor(
    private readonly d: {
      settings: KeyValueSettings;
      env: Pick<PanelEnv, 'origins' | 'duckdnsSubdomain'>;
      /** How Detect reaches the service (tests: a fake one; never the real one). */
      fetch?: typeof fetch;
    },
  ) {}

  private stored(): Stored {
    const s = this.d.settings.getRaw<Partial<Stored>>(HOST_ADDRESS_KEY);
    return { public: typeof s?.public === 'string' ? s.public : null, home: typeof s?.home === 'string' ? s.home : null };
  }

  view(): HostAddressView {
    const s = this.stored();
    const def = addressDefaults(this.d.env);
    const pub = s.public ?? def.public;
    const home = s.home ?? def.home;
    return {
      public: pub,
      publicSource: s.public !== null ? 'set' : def.public !== null ? 'duckdns' : 'none',
      home,
      homeSource: s.home !== null ? 'set' : def.home !== null ? 'lan' : 'none',
      defaults: def,
      detectService: DETECT_SERVICE,
    };
  }

  /** Sets both addresses; null or empty goes back to the default. Throws `AddressRefusal`. */
  save(u: HostAddressUpdate): HostAddressView {
    const one = (field: 'public' | 'home', v: string | null): string | null => {
      if (v === null || v.trim() === '') return null;
      const c = checkAddress(v);
      if (!c.ok) throw new AddressRefusal(field, c.problem);
      return c.address;
    };
    const next: Stored = { public: one('public', u.public), home: one('home', u.home) };
    this.d.settings.setRaw<Stored>(HOST_ADDRESS_KEY, next);
    return this.view();
  }

  /**
   * Asks `DETECT_SERVICE` for this host's public IPv4 address: one GET over
   * HTTPS, no redirects, at most `DETECT_TIMEOUT_MS`. Saves nothing (the
   * owner decides). Throws `DetectFailure`.
   */
  async detect(): Promise<DetectedAddress> {
    const f = this.d.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(DETECT_SERVICE, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(DETECT_TIMEOUT_MS) });
    } catch (e) {
      throw new DetectFailure((e as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable');
    }
    if (!res.ok) throw new DetectFailure(`status ${res.status}`);
    const text = (await res.text().catch(() => '')).trim();
    if (!isIPv4(text)) throw new DetectFailure('not an address');
    return { address: text, service: DETECT_SERVICE };
  }
}
