import { chmodSync, lstatSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Where the panel listens (`PANEL_LISTEN`, NFR-03): a TCP address
 * (`PANEL_HOST_BIND`, `PANEL_PORT_BIND`), or a unix socket in a volume only
 * the panel and the TLS proxy mount (`unix:/run/panel/panel.sock`).
 */
export type PanelListen = { kind: 'tcp'; host: string; port: number } | { kind: 'unix'; path: string };

/** A Windows named pipe (`\\.\pipe\name`): what `unix:` means in a dev loop on Windows. */
const PIPE = /^\\\\[.?]\\pipe\\[^\\]+$/;

/** `PANEL_LISTEN`: `tcp` (the default) or `unix:<absolute path>`. */
export function parseListen(env: NodeJS.ProcessEnv): PanelListen {
  const v = (env.PANEL_LISTEN ?? '').trim() || 'tcp';
  if (v === 'tcp') {
    const port = Number(env.PANEL_PORT_BIND ?? 8080);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PANEL_PORT_BIND must be a port number');
    return { kind: 'tcp', host: env.PANEL_HOST_BIND ?? '0.0.0.0', port };
  }
  if (v.startsWith('unix:')) {
    const p = v.slice('unix:'.length);
    if (path.posix.isAbsolute(p) || PIPE.test(p)) return { kind: 'unix', path: p };
  }
  throw new Error('PANEL_LISTEN must be "tcp" or "unix:<absolute path>"');
}

/**
 * Listens where `l` says. A socket file left by a panel that didn't shut
 * down is removed first; the new one is readable and writable by anyone who
 * can reach it, because what guards it is the volume it lives in (only the
 * panel and the TLS proxy mount it, and the proxy runs as another user).
 */
export async function listenOn(app: FastifyInstance, l: PanelListen): Promise<void> {
  if (l.kind === 'tcp') {
    await app.listen({ host: l.host, port: l.port });
    return;
  }
  if (!PIPE.test(l.path)) {
    try {
      if (lstatSync(l.path).isSocket()) rmSync(l.path);
    } catch {
      // nothing there
    }
  }
  await app.listen({ path: l.path });
  if (!PIPE.test(l.path)) chmodSync(l.path, 0o666);
}

/**
 * Which proxies' `X-Forwarded-For` to believe (Fastify's `trustProxy`). On
 * a unix socket the peer has no address and is always the TLS proxy (only
 * it mounts the socket's volume): believe that one hop and no more, so the
 * client address is the one the proxy saw. On TCP: `TRUST_PROXY`.
 */
export function trustProxyFor(env: { listen: PanelListen; trustProxy: string }): string | ((address: string, hop: number) => boolean) {
  return env.listen.kind === 'unix' ? (_address, hop) => hop === 0 : env.trustProxy;
}

/** Whether a panel answers `GET /api/health` at `l` (the container's healthcheck: `panelctl health`). */
export function probeHealth(l: PanelListen, timeoutMs = 4000): Promise<boolean> {
  const target = l.kind === 'unix' ? { socketPath: l.path } : { host: l.host === '0.0.0.0' || l.host === '::' ? '127.0.0.1' : l.host, port: l.port };
  return new Promise((resolve) => {
    const req = request({ ...target, path: '/api/health', method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}
