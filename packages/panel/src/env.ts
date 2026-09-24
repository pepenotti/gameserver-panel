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
  pzAdminPassword: string;
  /** Exact origins (scheme://host:port) allowed to change anything. */
  origins: string[];
  owner: { username: string; password: string } | null;
  /** Proxies whose X-Forwarded-For we believe (Fastify trustProxy syntax). */
  trustProxy: string;
  /** Set false when clients may all share one proxy IP (Docker Desktop). */
  clientIpTrustworthy: boolean;
  secureCookies: boolean;
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
    pzAdminPassword: need('PZ_ADMIN_PASSWORD'),
    origins,
    owner: ownerUser && ownerPass ? { username: ownerUser, password: ownerPass } : null,
    trustProxy: env.TRUST_PROXY ?? 'loopback,uniquelocal',
    clientIpTrustworthy: env.CLIENT_IP_TRUSTWORTHY === 'true',
    secureCookies: env.PANEL_INSECURE_COOKIES !== 'true',
  };
}
