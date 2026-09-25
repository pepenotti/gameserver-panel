// Where the panel listens (NFR-03): TCP, or a unix socket in a volume only
// the panel and the TLS proxy mount; `panelctl health` finds it either way.
import { mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listenOn, probeHealth, type PanelListen } from '../src/listen';
import { makePanel, ORIGIN, OWNER } from './harness';

const posix = process.platform !== 'win32';

/** A socket path for this test: a file on POSIX, a named pipe on Windows (what `unix:` means there). */
function socketPath(name: string): string {
  if (!posix) return `\\\\.\\pipe\\gsp-listen-${process.pid}-${name}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-listen-'));
  made.push(dir);
  return path.join(dir, `${name}.sock`);
}

/** The folders the sockets were made in, removed at the end. */
const made: string[] = [];
afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function post(socket: string, url: string, body: unknown, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ socketPath: socket, path: url, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)), ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('PANEL_LISTEN', () => {
  it('serves on a unix socket, believes the proxy on the other end, and answers the healthcheck', async () => {
    const listen: PanelListen = { kind: 'unix', path: socketPath('panel') };
    const p = await makePanel({ listen });
    await listenOn(p.app, listen);
    try {
      expect(await probeHealth(listen)).toBe(true);
      // Anyone who can reach the socket may use it: the volume it lives in is the boundary.
      if (posix) expect(statSync(listen.path).mode & 0o777).toBe(0o666);
      // The proxy (Caddy) sets X-Forwarded-For to the client it saw; the socket's peer has no address.
      expect(await post(listen.path, '/api/auth/login', { username: OWNER.username, password: OWNER.password }, { origin: ORIGIN, 'x-forwarded-for': '203.0.113.9' })).toBe(200);
      expect(p.deps.audit.list({ action: 'auth.login' })[0]).toMatchObject({ ip: '203.0.113.9', ok: true });
    } finally {
      await p.app.close();
    }
    expect(await probeHealth(listen, 500)).toBe(false);
  });

  // Named pipes (Windows) vanish with their process.
  it.skipIf(!posix)('replaces a socket a crashed panel left behind', async () => {
    const listen: PanelListen = { kind: 'unix', path: socketPath('stale') };
    const first = await makePanel({ listen });
    await listenOn(first.app, listen);
    // A crash leaves the file: simulate it by closing the server without unlinking.
    renameSync(listen.path, `${listen.path}.keep`);
    await first.app.close();
    renameSync(`${listen.path}.keep`, listen.path);
    const second = await makePanel({ listen });
    await listenOn(second.app, listen);
    try {
      expect(await probeHealth(listen)).toBe(true);
    } finally {
      await second.app.close();
    }
  });

  it('serves on TCP and answers the healthcheck there too', async () => {
    const p = await makePanel();
    await listenOn(p.app, { kind: 'tcp', host: '127.0.0.1', port: 0 });
    try {
      const { port } = p.app.server.address() as AddressInfo;
      expect(await probeHealth({ kind: 'tcp', host: '0.0.0.0', port })).toBe(true);
    } finally {
      await p.app.close();
    }
  });
});
