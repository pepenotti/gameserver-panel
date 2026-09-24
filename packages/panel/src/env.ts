import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface PanelEnv {
  version: string;
  host: string;
  port: number;
  /** SQLite database and other panel-only state. */
  dataDir: string;
  /** Built web UI; absent in API-only tests. */
  publicDir: string | null;
  agentUrl: string;
  agentToken: string;
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

function bundledVersion(): string {
  try {
    return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();
  } catch {
    return '0.0.0-dev';
  }
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): PanelEnv {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`${k} must be set`);
    return v;
  };
  const agentToken = need('AGENT_TOKEN');
  if (agentToken.length < 32) throw new Error('AGENT_TOKEN must be at least 32 characters');
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
    host: env.PANEL_HOST_BIND ?? '0.0.0.0',
    port: Number(env.PANEL_PORT_BIND ?? 8080),
    dataDir,
    publicDir: env.PANEL_PUBLIC_DIR === '' ? null : (env.PANEL_PUBLIC_DIR ?? fileURLToPath(new URL('./public', import.meta.url))),
    agentUrl: env.AGENT_URL ?? 'http://pz:8081',
    agentToken,
    pzDataDir: env.PZ_DATA_DIR ?? '/data',
    pzInstallDir: env.PZ_INSTALL_DIR ?? '/opt/pz',
    backupDir: env.BACKUP_DIR ?? '/backups',
    serverName,
    // Which ones the adapter needs is checked when the panel is wired (wiring.ts).
    secrets: loadSecrets(env),
    origins,
    owner: ownerUser && ownerPass ? { username: ownerUser, password: ownerPass } : null,
    trustProxy: env.TRUST_PROXY ?? 'loopback,uniquelocal',
    clientIpTrustworthy: env.CLIENT_IP_TRUSTWORTHY === 'true',
    secureCookies: env.PANEL_INSECURE_COOKIES !== 'true',
  };
}
