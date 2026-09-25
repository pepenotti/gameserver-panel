import type { Actor } from '../audit';
import { HttpError } from '../http/context';
import type { ServerContext } from './context';

/** What SRV-01 asks for when a server is created. */
export interface CreateServerInput {
  /** `SERVER_ID_PATTERN`. */
  id: string;
  name: string;
  /** Adapter id; must run on the host's architecture (HST-05). */
  adapter: string;
  flavour?: string | null;
  /** The adapter's launch settings over its defaults (version, memory…). */
  launch?: Record<string, unknown>;
  /** Host ports by `PortDecl.id`; missing ones get free ports near the adapter's defaults. */
  ports?: Record<string, number>;
  memLimitMb?: number;
  cpus?: number | null;
  /** The owner accepted the game's EULA (D6), for adapters with the `eula` capability. */
  eulaAccepted?: boolean;
  by: Actor;
}

export interface RemoveServerOptions {
  /** Keep the server's backups (SRV-04: kept unless the owner chooses otherwise). */
  keepBackups: boolean;
  by: Actor;
}

/** What `reconcile` changed to bring containers in line with the servers table (SRV-06). */
export interface ReconcileReport {
  /** Containers created or recreated from their row's spec. */
  applied: string[];
  /** Servers started again because they were running before. */
  started: string[];
  /** Containers of this stack with no row (left alone, reported). */
  orphans: string[];
  /** Servers the orchestrator couldn't bring up, with why. */
  failed: { id: string; error: string }[];
}

/**
 * The servers the panel runs (PRD §10 "a server registry"): one
 * `ServerContext` each, built from the `servers` table. Creating and
 * removing servers goes through the orchestrator (D3); `reconcile` brings
 * containers back in line with the table after a panel, Docker or host
 * restart (SRV-06).
 */
export interface ServerRegistry {
  /** Every server, in the table's order. */
  list(): ServerContext[];
  get(id: string): ServerContext | null;
  /** SRV-01: validate, write the row, ask the orchestrator for the container, build the context. */
  create(input: CreateServerInput): Promise<ServerContext>;
  /** SRV-04: final backup, container and (unless kept) volumes removed, then the row and everything keyed to it. */
  remove(id: string, o: RemoveServerOptions): Promise<void>;
  reconcile(): Promise<ReconcileReport>;
}

/** 501 until the orchestrator lands (M2-A) and the registry uses it (M2-B). */
export function notImplemented(what: string): HttpError {
  return new HttpError(501, 'not-implemented', `${what} is not implemented yet`);
}

/**
 * The registry of an install with one server, the one its environment
 * describes (`default`). Lists and serves it; creating, removing and
 * reconciling servers come with the orchestrator.
 */
export class SingleServerRegistry implements ServerRegistry {
  constructor(private readonly only: ServerContext) {}

  list(): ServerContext[] {
    return [this.only];
  }

  get(id: string): ServerContext | null {
    return id === this.only.id ? this.only : null;
  }

  async create(_input: CreateServerInput): Promise<ServerContext> {
    throw notImplemented('Creating servers');
  }

  async remove(_id: string, _o: RemoveServerOptions): Promise<void> {
    throw notImplemented('Removing servers');
  }

  async reconcile(): Promise<ReconcileReport> {
    // The one server's container is Compose's, not the orchestrator's.
    return { applied: [], started: [], orphans: [], failed: [] };
  }
}
