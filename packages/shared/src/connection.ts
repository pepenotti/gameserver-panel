/**
 * Connection info (SRV-08) and the host's addresses (HST-08): the shapes the
 * panel serves and the web shows, and the rules both apply to an address
 * people type. Pure: no Node or browser APIs, so the web uses it as it is.
 */
import type { PortProto } from './orchestrator-api';

/** Text in English and Spanish. */
export interface Bilingual {
  en: string;
  es: string;
}

/** Where players are, as the connection info lists them: on this PC, on the home network, on the internet. */
export const JOIN_PLACES = ['pc', 'home', 'internet'] as const;
export type JoinPlace = (typeof JOIN_PLACES)[number];

/** The address players on this PC use: the published ports listen there (SRV-08). */
export const THIS_PC_ADDRESS = '127.0.0.1';

/** What an address is, once it passed `checkAddress`. */
export type AddressKind = 'dns' | 'ipv4' | 'ipv6';

/**
 * Why an address was refused: `empty`; `too-long` (over 253 characters);
 * `scheme` (`https://…`); `path` (a `/`, `?` or `#` after the name);
 * `port` (`:8443` after it); `invalid` (not a DNS name, nor an IPv4 or
 * IPv6 address).
 */
export type AddressProblem = 'empty' | 'too-long' | 'scheme' | 'path' | 'port' | 'invalid';

export type AddressCheck = { ok: true; address: string; kind: AddressKind } | { ok: false; problem: AddressProblem };

const IPV4_PART = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${IPV4_PART}(?:\\.${IPV4_PART}){3}$`);
const HEX_GROUP = /^[0-9a-f]{1,4}$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function isIPv4(s: string): boolean {
  return IPV4.test(s);
}

/** An IPv6 address as text (`2001:db8::1`, `::ffff:192.0.2.1`), without brackets or a zone. */
export function isIPv6(s: string): boolean {
  const v = s.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(v) || !v.includes(':')) return false;
  const halves = v.split('::');
  if (halves.length > 2) return false;
  const groups = (part: string): string[] | null => {
    if (part === '') return [];
    const g = part.split(':');
    return g.some((x) => x === '') ? null : g;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return false;
  const all = [...head, ...tail];
  // An IPv4 address may end it (`::ffff:192.0.2.1`): it counts as two groups.
  let count = all.length;
  const last = all[all.length - 1];
  if (last !== undefined && last.includes('.')) {
    if (!isIPv4(last)) return false;
    all.pop();
    count += 1;
  }
  if (!all.every((x) => HEX_GROUP.test(x))) return false;
  return halves.length === 2 ? count < 8 : count === 8;
}

/** A DNS name (`example.duckdns.org`, `gamepc`), lower case, without a trailing dot. */
export function isDnsName(s: string): boolean {
  if (s.length === 0 || s.length > 253) return false;
  const labels = s.split('.');
  if (!labels.every((l) => LABEL.test(l))) return false;
  // All digits is a broken IPv4 address, not a name (no top-level domain is only digits).
  return !/^\d+$/.test(labels[labels.length - 1]!);
}

/**
 * An address people typed for the host (HST-08): a DNS name or an IPv4 or
 * IPv6 address, with no scheme, port or path. Trimmed and lower-cased; an
 * IPv6 address may come in brackets, and a name with a trailing dot.
 */
export function checkAddress(input: string): AddressCheck {
  const raw = input.trim();
  if (raw === '') return { ok: false, problem: 'empty' };
  if (raw.length > 253) return { ok: false, problem: 'too-long' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes('://')) return { ok: false, problem: 'scheme' };
  if (/[/?#\\]/.test(raw)) return { ok: false, problem: 'path' };
  let s = raw.toLowerCase();
  const bracketed = /^\[([^\]]*)\](.*)$/.exec(s);
  if (bracketed) {
    if (bracketed[2] !== '') return { ok: false, problem: /^:\d*$/.test(bracketed[2]!) ? 'port' : 'invalid' };
    return isIPv6(bracketed[1]!) ? { ok: true, address: bracketed[1]!, kind: 'ipv6' } : { ok: false, problem: 'invalid' };
  }
  if (isIPv6(s)) return { ok: true, address: s, kind: 'ipv6' };
  // One colon followed by digits: a name or IPv4 address with a port.
  if (/^[^:]+:\d*$/.test(s)) return { ok: false, problem: 'port' };
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (isIPv4(s)) return { ok: true, address: s, kind: 'ipv4' };
  if (/^[\d.]+$/.test(s)) return { ok: false, problem: 'invalid' };
  return isDnsName(s) ? { ok: true, address: s, kind: 'dns' } : { ok: false, problem: 'invalid' };
}

/** An IPv4 address of a home network (RFC 1918: 10/8, 172.16/12, 192.168/16). */
export function isPrivateIPv4(s: string): boolean {
  if (!isIPv4(s)) return false;
  const [a, b] = s.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** How a game's client takes an address and a port (the adapter contract's `JoinFormat`). */
export type JoinTextFormat = 'host:port' | 'separate';

/**
 * What players type for `address` in a game's format (SRV-08): with
 * `host:port`, the address, `:` and the port (an IPv6 address in
 * brackets), or the address alone when the port is the one the client
 * assumes (`defaultPort`); with `separate`, the address (the port goes in a
 * field of its own).
 */
export function joinText(address: string, port: number, format: JoinTextFormat, defaultPort?: number | null): string {
  if (format === 'separate') return address;
  const host = address.includes(':') ? `[${address}]` : address;
  return defaultPort === port ? host : `${host}:${port}`;
}

// ------------------------------------------------------------- the wire

/**
 * `GET /api/host/address` (HST-08): the address friends use to reach this
 * host, and its address on the home network, as the connection info of
 * every server uses them.
 */
export interface HostAddressView {
  /** The public address in use: the owner's, else the default; null: none. */
  public: string | null;
  /** `set`: the owner's; `duckdns`: the DuckDNS name the panel uses for HTTPS (the default); `none`. */
  publicSource: 'set' | 'duckdns' | 'none';
  /** The home-network address in use: the owner's, else the default; null: none. */
  home: string | null;
  /** `set`: the owner's; `lan`: the panel's own home-network address (`LAN_IP`, the default); `none`. */
  homeSource: 'set' | 'lan' | 'none';
  /** What each would be without the owner's: the defaults. */
  defaults: { public: string | null; home: string | null };
  /** The one service the "Detect" button asks, only when pressed (NFR-09). */
  detectService: string;
}

/** `PUT /api/host/address`: null (or empty) goes back to the default. */
export interface HostAddressUpdate {
  public: string | null;
  home: string | null;
}

/** `POST /api/host/address/detect`: what the service answered (nothing is saved). */
export interface DetectedAddress {
  address: string;
  service: string;
}

/** One place players join from, and what they type there; null when its address isn't set. */
export interface ConnectionPlace {
  place: JoinPlace;
  address: string | null;
  text: string | null;
}

/** A step players take to join; `unknown`: the setting it depends on couldn't be read now. */
export interface ConnectionStep {
  id: string;
  text: Bilingual;
  applies: 'yes' | 'unknown';
}

/** A port the router must forward to this host (every published port, those that follow another too). */
export interface ConnectionForward {
  id: string;
  port: number;
  proto: PortProto;
  label: Bilingual;
  /** The port players type. */
  typed: boolean;
}

/** `GET /api/servers/:sid/connection` (SRV-08): how players join this server. */
export interface ConnectionInfo {
  server: { id: string; name: string };
  game: Bilingual;
  /** The port players type: its number on the host and its protocol. */
  port: { id: string; number: number; proto: PortProto; label: Bilingual };
  format: JoinTextFormat;
  /** The port the client assumes when none is typed (`host:port`); null: none. */
  defaultPort: number | null;
  /** Where in the game players type it. */
  where: Bilingual;
  /** The client players need; `version`: the server's, when it must match and is known. */
  client: { name: Bilingual; sameVersion: boolean; version: string | null };
  places: ConnectionPlace[];
  /**
   * Whether joining takes a password (`set`; null when the game has none,
   * or it couldn't be read now) and, only for those who may manage the
   * server and asked for it, its value.
   */
  password: { game: boolean; set: boolean | null; value: string | null; canInclude: boolean };
  steps: ConnectionStep[];
  forwards: ConnectionForward[];
  /** A real client joined this way (D5); false: expected, not measured. */
  verified: boolean;
  source: string;
  note: Bilingual | null;
  /** Whether the public address is set, and whether the signed-in user may set it (the owner). */
  publicAddress: { set: boolean; canSet: boolean };
}
