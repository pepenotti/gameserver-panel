// API first (AST-01): everything the UI does goes through the documented,
// permission-checked HTTP API. This skeleton proves two things, and M2 grows
// it:
//   - every call the web makes (`api(…)` for host routes, a `ServerApi` —
//     `sapi(…)`, `serverApi(sid)(…)`, `sapi.url(…)` — for a server's) names a
//     route the panel has;
//   - every /api/ route declares a permission, is `public`, or is on the
//     short, explicit list of routes that only need a session.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { RouteInfo } from '../src/app';
import { makePanel } from './harness';

const web = path.resolve(import.meta.dirname, '..', '..', 'web', 'src');

/** Routes any signed-in user may call without a permission: about the session itself, or answering only with what the user may see. */
const SESSION_ONLY = [
  'GET /api/session',
  'POST /api/auth/mfa',
  'POST /api/auth/logout',
  'POST /api/auth/password',
  'POST /api/auth/totp/setup',
  'POST /api/auth/totp/enable',
  'POST /api/auth/totp/disable',
  'PUT /api/me',
  'GET /api/me/sessions',
  'DELETE /api/me/sessions/:id',
  // Filtered to the servers the user has a role on.
  'GET /api/servers',
  // Filtered per server and topic.
  'GET /api/ws',
];

/**
 * Calls the scan can't read from the code (not `api`/`ServerApi` calls with
 * a written-out method and path), each checked by hand here.
 */
const OTHER_CALLS: { file: string; call: string; why: string }[] = [{ file: 'api/live.tsx', call: 'GET /api/ws', why: 'the websocket (new WebSocket)' }];

/** Files whose non-literal calls are the helpers themselves. */
const HELPERS = new Set(['api/http.ts']);

interface WebCall {
  file: string;
  line: number;
  method: string;
  path: string;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

/** A path argument as text, `${…}` becoming a `:param`; null when it isn't written out. */
function pathOf(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `:param${s.literal.text}`).join('');
  return null;
}

function methodOf(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteral(node) ? node.text : null;
}

/** Every API call in the web's sources; unreadable ones in `unread`. */
function scanWeb(): { calls: WebCall[]; unread: string[] } {
  const calls: WebCall[] = [];
  const unread: string[] = [];
  for (const f of files(web)) {
    const rel = path.relative(web, f).split(path.sep).join('/');
    const src = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        let scope: 'host' | 'server' | null = null;
        let method: string | null = null;
        let p: string | null = null;
        if (ts.isIdentifier(callee) && callee.text === 'api') {
          scope = 'host';
          method = methodOf(n.arguments[0]);
          p = pathOf(n.arguments[1]);
        } else if ((ts.isIdentifier(callee) && callee.text === 'sapi') || (ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'serverApi')) {
          scope = 'server';
          method = methodOf(n.arguments[0]);
          p = pathOf(n.arguments[1]);
        } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'sapi' && callee.name.text === 'url') {
          scope = 'server';
          method = 'GET';
          p = pathOf(n.arguments[0]);
        }
        if (scope) {
          const line = src.getLineAndCharacterOfPosition(n.getStart()).line + 1;
          if (method === null || p === null) {
            if (!HELPERS.has(rel)) unread.push(`${rel}:${line}`);
          } else {
            const bare = p.split('?')[0]!;
            calls.push({ file: rel, line, method, path: scope === 'server' ? `/api/servers/:sid${bare}` : bare });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return { calls, unread };
}

/** Same route: segment by segment, a `:param` on either side matching any one segment. */
function matches(route: string, call: string): boolean {
  const a = route.split('/');
  const b = call.split('/');
  return a.length === b.length && a.every((s, i) => s === b[i] || s.startsWith(':') || b[i]!.startsWith(':'));
}

async function routeTable(): Promise<RouteInfo[]> {
  const p = await makePanel();
  await p.app.ready();
  return p.app.routeTable.filter((r) => r.method !== 'HEAD');
}

describe('API first (AST-01)', () => {
  it('finds the web calls it is looking for, and reads every one of them', () => {
    const { calls, unread } = scanWeb();
    // A scan that finds nothing proves nothing.
    expect(calls.length).toBeGreaterThan(60);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/auth/login')).toBe(true);
    expect(calls.some((c) => c.method === 'GET' && c.path === '/api/servers/:sid/backups/:param/download')).toBe(true);
    expect(unread).toEqual([]);
  });

  it('matches every call the web makes to a route of the panel', async () => {
    const routes = await routeTable();
    const { calls } = scanWeb();
    const all = [...calls.map((c) => ({ where: `${c.file}:${c.line}`, method: c.method, path: c.path })), ...OTHER_CALLS.map((c) => ({ where: c.file, method: c.call.split(' ')[0]!, path: c.call.split(' ')[1]! }))];
    const missing = all.filter((c) => !routes.some((r) => r.method === c.method && matches(r.url, c.path))).map((c) => `${c.where}: ${c.method} ${c.path}`);
    expect(missing).toEqual([]);
  });

  it('has the web call nothing but the API helpers', () => {
    // Raw fetches would bypass the scan (and the CSRF header).
    const raw = files(web).filter((f) => !HELPERS.has(path.relative(web, f).split(path.sep).join('/')) && /\bfetch\(/.test(readFileSync(f, 'utf8')));
    expect(raw).toEqual([]);
  });

  it('guards every /api/ route: a permission, public, or a session-only route on the list', async () => {
    const routes = (await routeTable()).filter((r) => r.url.startsWith('/api/'));
    expect(routes.length).toBeGreaterThan(60);
    const unguarded = routes.filter((r) => !r.config.permission && r.config.auth !== 'public' && !SESSION_ONLY.includes(`${r.method} ${r.url}`)).map((r) => `${r.method} ${r.url}`);
    expect(unguarded).toEqual([]);
    // Every route of a server is resolved and checked on that server.
    const perServer = routes.filter((r) => r.url.startsWith('/api/servers/:sid/'));
    expect(perServer.length).toBeGreaterThan(40);
    expect(perServer.filter((r) => !r.config.serverScoped || !r.config.permission).map((r) => `${r.method} ${r.url}`)).toEqual([]);
    // No stale entries.
    const known = new Set(routes.map((r) => `${r.method} ${r.url}`));
    expect(SESSION_ONLY.filter((x) => !known.has(x))).toEqual([]);
    expect(routes.filter((r) => r.config.auth === 'public').map((r) => `${r.method} ${r.url}`)).toEqual(['GET /api/health', 'POST /api/auth/login']);
  });
});
