// The panel's HTTP API as the web calls it (AST-01: the UI does nothing the
// API doesn't). Host routes go through `api`, a server's routes through a
// `ServerApi` (`serverApi(sid)`, or `useServerApi()` in a server's pages),
// with the method and path written out at the call so a test can match
// every call to a route (packages/panel/test/api-first.test.ts).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

let csrfToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setCsrf(token: string | null): void {
  csrfToken = token;
}

/** Called when any request finds the session gone, so the app can show the login. */
export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn;
}

/** A host route (`/api/...`). The body is sent as JSON, or as is when it is `FormData` (uploads). */
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const form = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !form) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-gsp-csrf'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const { error, ...extra } = (data ?? {}) as { error?: string };
    const code = error ?? 'generic';
    if (res.status === 401 && code === 'unauthenticated') onUnauthenticated?.();
    throw new ApiError(res.status, code, extra);
  }
  return data as T;
}

/** Where one server's route lives: `/api/servers/<sid><path>`. */
export function serverPath(sid: string, path: string): string {
  return `/api/servers/${encodeURIComponent(sid)}${path}`;
}

/** One server's routes: `sapi('GET', '/backups')` is `GET /api/servers/<sid>/backups`. */
export interface ServerApi {
  <T>(method: Method, path: string, body?: unknown): Promise<T>;
  readonly sid: string;
  /** A GET route's address, for links (downloads). */
  url(path: string): string;
}

export function serverApi(sid: string): ServerApi {
  const call = <T>(method: Method, path: string, body?: unknown) => api<T>(method, serverPath(sid, path), body);
  return Object.assign(call, { sid, url: (path: string) => serverPath(sid, path) });
}
