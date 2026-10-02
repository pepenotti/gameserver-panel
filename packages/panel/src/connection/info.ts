import type { AdapterMeta, JoinDecl, JoinSetting, PortDecl, Scalar } from '@gsp/adapter-api';
import { CONFIG_FORMATS } from '@gsp/formats';
import { joinText, THIS_PC_ADDRESS, type ConnectionForward, type ConnectionInfo, type ConnectionStep, type HostAddressView } from '@gsp/shared';
import { HttpError } from '../http/context';
import type { ServerContext } from '../servers/context';

/**
 * How players join a server of `flavour` (SRV-08): the adapter's
 * `AdapterMeta.join`, with what its flavour declares in place of the
 * adapter's fields; null when the game says nothing.
 */
export function joinOf(meta: AdapterMeta, flavour: string | null): JoinDecl | null {
  const own = flavour === null ? undefined : meta.flavours.find((f) => f.id === flavour)?.join;
  if (!meta.join && !own) return null;
  const j = { ...meta.join, ...own } as Partial<JoinDecl>;
  if (j.port === undefined || j.format === undefined || !j.where || !j.client || j.verified === undefined || j.source === undefined) return null;
  return j as JoinDecl;
}

/** A port's number on the host: the server's own, else what the game declares (a port that follows another: its base plus the offset). */
function hostPort(s: ServerContext, ports: readonly PortDecl[], p: PortDecl): number {
  const own = s.row.ports[p.id];
  if (own !== undefined) return own;
  if (p.follows) {
    const base = ports.find((x) => x.id === p.follows!.id);
    if (base) return hostPort(s, ports, base) + p.follows.offset;
  }
  return p.default;
}

/** A setting kept in a file the agent couldn't give now. */
const UNREADABLE = Symbol('unreadable');

/** Whether a setting's value is `want`: compared as text, case ignored (a file's `true` and a form's `true` alike). */
const same = (v: unknown, want: Scalar) => v !== undefined && v !== null && String(v).toLowerCase() === String(want).toLowerCase();

/** What adding the password to the answer needs: the person may manage the server, and asked for it. */
export interface ConnectionOptions {
  /** The host's addresses (HST-08). */
  address: HostAddressView;
  /** The person may see the password (an admin of the server, or the owner). */
  canIncludePassword: boolean;
  /** …and asked for it now. */
  includePassword: boolean;
  /** The person may set the public address (the owner, `host.settings`). */
  canSetAddress: boolean;
}

/**
 * The connection info of a server (SRV-08): what players type from this PC,
 * the home network and the internet, in its game's format; the client and
 * version; whether a password is set (its value only when `includePassword`
 * is allowed and asked); the steps that apply now; every port the router
 * must forward; and whether it was measured with a real client (D5).
 * Settings kept in the server's files are read through its agent: when it
 * can't be reached, what depends on them says it couldn't be read.
 */
export async function connectionInfo(s: ServerContext, o: ConnectionOptions): Promise<ConnectionInfo> {
  const meta = s.adapter.meta;
  const join = joinOf(meta, s.row.flavour);
  if (!join) throw new HttpError(409, 'join-undeclared');
  const decl = meta.ports.find((p) => p.id === join.port);
  if (!decl) throw new HttpError(409, 'join-undeclared');
  const port = hostPort(s, meta.ports, decl);

  // Settings read once each: launch settings as stored, config files through the agent (null: unreadable now).
  const launch = s.handle.launchSettings() as Record<string, unknown>;
  const files = new Map<string, Promise<Record<string, Scalar> | null>>();
  const decls = s.adapter.config.files(s.handle.ref);
  const fileValues = (id: string): Promise<Record<string, Scalar> | null> => {
    let p = files.get(id);
    if (!p) {
      p = (async () => {
        const d = decls.find((f) => f.id === id);
        if (!d) return null;
        const text = await s.config.read(id);
        // A file the game hasn't written yet holds nothing: every key has its game default.
        if (text === null) return {};
        const f = CONFIG_FORMATS[d.format];
        const r = f.parse(text);
        return r.ok ? f.flatten(r.doc) : null;
      })().catch(() => null);
      files.set(id, p);
    }
    return p;
  };
  /** A setting's value; `unreadable` when its file can't be read now. */
  const valueOf = async (x: JoinSetting): Promise<unknown> => {
    if ('launch' in x) return launch[x.launch];
    const values = await fileValues(x.file);
    return values === null ? UNREADABLE : values[x.key];
  };

  const steps: ConnectionStep[] = [];
  for (const st of join.steps ?? []) {
    if (!st.when) {
      steps.push({ id: st.id, text: st.text, applies: 'yes' });
      continue;
    }
    const v = await valueOf(st.when);
    if (v === UNREADABLE) steps.push({ id: st.id, text: st.text, applies: 'unknown' });
    else if (same(v, st.when.equals)) steps.push({ id: st.id, text: st.text, applies: 'yes' });
  }

  let password: ConnectionInfo['password'] = { game: false, set: false, value: null, canInclude: false };
  if (join.password) {
    const v = await valueOf(join.password);
    const set = v === UNREADABLE ? null : typeof v === 'string' ? v !== '' : v !== undefined && v !== null && String(v) !== '';
    const value = set === true && o.includePassword && o.canIncludePassword ? String(v) : null;
    password = { game: true, set, value, canInclude: o.canIncludePassword };
  }

  const status = s.feed.status_ ?? (await s.agent.status().catch(() => null));
  const version = join.client.sameVersion ? (status?.installedInfo?.version ?? null) : null;

  const forwards: ConnectionForward[] = meta.ports
    .filter((p) => p.publish)
    .map((p) => ({ id: p.id, port: hostPort(s, meta.ports, p), proto: p.proto, label: p.label, typed: p.id === join.port }));

  const at = (address: string | null) => ({ address, text: address === null ? null : joinText(address, port, join.format, join.defaultPort) });
  return {
    server: { id: s.id, name: s.row.name },
    game: meta.name,
    port: { id: decl.id, number: port, proto: decl.proto, label: decl.label },
    format: join.format,
    defaultPort: join.format === 'host:port' ? (join.defaultPort ?? null) : null,
    where: join.where,
    client: { name: join.client.name, sameVersion: join.client.sameVersion, version },
    places: [
      { place: 'pc', ...at(THIS_PC_ADDRESS) },
      { place: 'home', ...at(o.address.home) },
      { place: 'internet', ...at(o.address.public) },
    ],
    password,
    steps,
    forwards,
    verified: join.verified,
    source: join.source,
    note: join.note ?? null,
    publicAddress: { set: o.address.public !== null, canSet: o.canSetAddress },
  };
}
