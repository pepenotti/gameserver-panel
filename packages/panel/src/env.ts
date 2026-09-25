import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseListen, type PanelListen } from './listen';

export interface PanelEnv {
  version: string;
  /** Where the panel listens (`PANEL_LISTEN`): TCP, or a unix socket behind the TLS proxy (NFR-03). */
  listen: PanelListen;
  /** SQLite database and other panel-only state. */
  dataDir: string;
  /** Built web UI; absent in API-only tests. */
  publicDir: string | null;
  /**
   * The agent of the server the environment describes (`default`, whose
   * container Compose runs rather than the orchestrator); both empty when
   * it describes none.
   */
  agentUrl: string;
  agentToken: string;
  /**
   * The orchestrator (`ORCH_SOCKET`, `ORCH_TOKEN`): its unix socket and
   * token. Null: this install has none, and servers can't be created.
   */
  orchestrator: { socket: string; token: string } | null;
  /**
   * The image variant every new server's spec asks for (`SERVER_IMAGE_VARIANT`,
   * `ServerSpec.variant`): `fake` in development and test slots, so they run
   * the fake game images; null in production.
   */
  serverImageVariant: string | null;
  /** Mounted pz-data volume (PZ -cachedir). */
  pzDataDir: string;
  /** Mounted game install, read-only. */
  pzInstallDir: string;
  backupDir: string;
  serverName: string;
  /**
   * Secrets for the server's adapter, by `LaunchSecretDecl.key` (one server
   * until M2 keeps them per server); see `secretEnvName`.
   */
  secrets: Readonly<Record<string, string>>;
  /**
   * Published ports of the server the environment describes, by
   * `PortDecl.id` (`GAME_PORT_<ID>`); the `default` server's row takes them
   * when it is first written (servers/store.ts).
   */
  ports: Readonly<Record<string, number>>;
  /** Exact origins (scheme://host:port) allowed to change anything. */
  origins: string[];
  owner: { username: string; password: string } | null;
  /** Proxies whose X-Forwarded-For we believe (Fastify trustProxy syntax). */
  trustProxy: string;
  /** Set false when clients may all share one proxy IP (Docker Desktop). */
  clientIpTrustworthy: boolean;
  secureCookies: boolean;
}

/** `adminPassword` → `ADMIN_PASSWORD`. */
const upperSnake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
/** `ADMIN_PASSWORD` → `adminPassword`. */
const camel = (name: string) => name.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * The environment variable a secret comes from: `GAME_SECRET_<KEY>`, the key
 * in upper snake case (`adminPassword` → `GAME_SECRET_ADMIN_PASSWORD`).
 * Compose and the dev loop fill it from the `.env` names (`PZ_ADMIN_PASSWORD`).
 */
export function secretEnvName(key: string): string {
  return `GAME_SECRET_${upperSnake(key)}`;
}

function loadSecrets(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const m = /^GAME_SECRET_([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)$/.exec(name);
    if (m && value) out[camel(m[1]!)] = value;
  }
  return out;
}

/** `GAME_PORT_<ID>` → ports by id (`GAME_PORT_UDP=16262` → `{ udp: 16262 }`). */
function loadPorts(env: NodeJS.ProcessEnv): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(env)) {
    const m = /^GAME_PORT_([A-Z0-9_]+)$/.exec(name);
    if (!m || !value) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number`);
    out[m[1]!.toLowerCase()] = n;
  }
  return out;
}

function bundledVersion(): string {
  try {
    return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();
  } catch {
    return '0.0.0-dev';
  }
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): PanelEnv {
  // AGENT_URL and AGENT_TOKEN describe the `default` server; an install may have none.
  const agentToken = env.AGENT_TOKEN ?? '';
  if (agentToken && agentToken.length < 32) throw new Error('AGENT_TOKEN must be at least 32 characters');
  const agentUrl = env.AGENT_URL ?? (agentToken ? 'http://pz:8081' : '');
  if (agentUrl && !agentToken) throw new Error('AGENT_TOKEN must be set with AGENT_URL');
  const orchSocket = env.ORCH_SOCKET ?? '';
  const orchToken = env.ORCH_TOKEN ?? '';
  if (!orchSocket !== !orchToken) throw new Error('ORCH_SOCKET and ORCH_TOKEN must be set together');
  if (orchToken && orchToken.length < 32) throw new Error('ORCH_TOKEN must be at least 32 characters');
  const variant = (env.SERVER_IMAGE_VARIANT ?? '').trim();
  if (variant && !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(variant)) throw new Error('SERVER_IMAGE_VARIANT must be 1-32 lowercase letters, digits, dots, dashes or underscores');
  const serverName = env.PZ_SERVER_NAME ?? 'zomboid';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) throw new Error('PZ_SERVER_NAME must be 1-32 letters, digits, _ or -');
  const origins = (env.PANEL_ORIGINS ?? 'https://localhost:8443')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
    .map((o) => {
      const u = new URL(o);
      if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error(`PANEL_ORIGINS entry is not an exact origin: ${o}`);
      // Browsers leave the default port out of Origin: https://host:443 → https://host.
      return u.origin;
    });
  const ownerUser = env.PANEL_OWNER_USERNAME;
  const ownerPass = env.PANEL_OWNER_PASSWORD;
  const dataDir = env.PANEL_DATA_DIR ?? '/var/lib/panel';
  return {
    version: env.PANEL_VERSION ?? bundledVersion(),
    listen: parseListen(env),
    dataDir,
    publicDir: env.PANEL_PUBLIC_DIR === '' ? null : (env.PANEL_PUBLIC_DIR ?? fileURLToPath(new URL('./public', import.meta.url))),
    agentUrl,
    agentToken,
    orchestrator: orchSocket ? { socket: orchSocket, token: orchToken } : null,
    serverImageVariant: variant || null,
    pzDataDir: env.PZ_DATA_DIR ?? '/data',
    pzInstallDir: env.PZ_INSTALL_DIR ?? '/opt/pz',
    backupDir: env.BACKUP_DIR ?? '/backups',
    serverName,
    // Which ones the adapter needs is checked when the panel is wired (wiring.ts).
    secrets: loadSecrets(env),
    ports: loadPorts(env),
    origins,
    owner: ownerUser && ownerPass ? { username: ownerUser, password: ownerPass } : null,
    trustProxy: env.TRUST_PROXY ?? 'loopback,uniquelocal',
    clientIpTrustworthy: env.CLIENT_IP_TRUSTWORTHY === 'true',
    secureCookies: env.PANEL_INSECURE_COOKIES !== 'true',
  };
}
