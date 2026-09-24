import type { Capability, PanelAdapter, SecretBag, ServerCtx, ServerFiles, ServerRef } from '@gsp/adapter-api';
import type { LaunchEnvelope, VersionsResponse } from '@gsp/shared';
import type { AgentApi } from '../agent/client';
import type { ConfigStore } from '../config/store';
import type { PanelEnv } from '../env';
import type { AgentFeed } from '../http/deps';
import type { Settings } from '../settings';

/** Settings row with the adapter's launch settings (its `S`). */
const LAUNCH_KEY = 'launch';

/** What a server can do: its flavour's capabilities, or the adapter's. */
export function capabilitiesOf(adapter: PanelAdapter, flavour: string | null): Set<Capability> {
  const f = flavour === null ? undefined : adapter.meta.flavours.find((x) => x.id === flavour);
  return new Set(f?.capabilities ?? adapter.meta.capabilities);
}

/**
 * Members the panel's ServerCtx carries beyond the adapter contract until the
 * contract grows them (M1-B hand-off, contract requests); adapters read them
 * with a structural check, so they can move into `ServerCtx` without a
 * breaking change.
 */
export interface ServerCtxBridge {
  /** `POST /v1/versions` for the stored launch settings; one call per context. */
  versions(): Promise<VersionsResponse>;
  /** The launch settings stored for the server (the adapter's `S`). */
  launchSettings(): unknown;
  /** The server's settings (history, managed keys), for resets and hooks that change them. */
  config: ConfigStore;
  /** Who the operation runs for (settings history); null for the panel itself. */
  actor: string | null;
}

export type PanelServerCtx = ServerCtx & ServerCtxBridge;

/** Optional fourth argument of `launch.toAgent` until the contract has it (M1-B contract request). */
export interface LaunchHints {
  /** The start follows an install the panel just ran: skip the pre-start update. */
  afterInstall?: boolean;
}

type ToAgent = (srv: ServerRef, s: unknown, secrets: SecretBag, hints?: LaunchHints) => unknown;

export interface ServerHandleDeps {
  env: PanelEnv;
  agent: AgentApi;
  feed: AgentFeed;
  files: ServerFiles;
  settings: Settings;
  config: ConfigStore;
  adapter: PanelAdapter;
}

/**
 * The one game server the panel runs (until M2): its adapter, its stored
 * launch settings and secrets, and the `ServerCtx` adapter code runs with.
 */
export class ServerHandle {
  readonly ref: ServerRef;

  constructor(private readonly d: ServerHandleDeps) {
    this.ref = { id: 'default', gameName: d.env.serverName, flavour: null };
  }

  get adapter(): PanelAdapter {
    return this.d.adapter;
  }

  capabilities(): Set<Capability> {
    return capabilitiesOf(this.d.adapter, this.ref.flavour);
  }

  has(cap: Capability): boolean {
    return this.capabilities().has(cap);
  }

  /** Stored launch settings over the adapter's defaults (settings added later get their defaults). */
  launchSettings(): unknown {
    const stored = this.d.settings.getRaw<Record<string, unknown>>(LAUNCH_KEY);
    return { ...(this.d.adapter.launch.defaults() as object), ...(stored ?? {}) };
  }

  setLaunchSettings(s: unknown): void {
    this.d.settings.setRaw(LAUNCH_KEY, s);
  }

  /** Secrets the panel holds for the server: the admin password (PZ_ADMIN_PASSWORD until M2 keeps them per server). */
  secrets(): SecretBag {
    return { adminPassword: this.d.env.pzAdminPassword };
  }

  /** Launch params for the agent; throws when the adapter can't turn `s` into params. */
  launchEnvelope(hints: LaunchHints = {}, s: unknown = this.launchSettings()): LaunchEnvelope {
    const toAgent = this.d.adapter.launch.toAgent as ToAgent;
    return { adapter: this.d.adapter.meta.id, params: toAgent(this.ref, s, this.secrets(), hints) };
  }

  /** A context for adapter code; `actor` is who the operation runs for. */
  ctx(actor: string | null = null): PanelServerCtx {
    const d = this.d;
    let versions: Promise<VersionsResponse> | null = null;
    return {
      srv: this.ref,
      files: d.files,
      status: () => d.feed.status_,
      command: (c) => d.agent.command(c.command, c.via),
      action: (name, input) => d.agent.action(name, input),
      onLog: (listener) =>
        d.feed.onEvent((e) => {
          if (e.event.type === 'log') listener(e.event.line);
        }),
      versions: () => (versions ??= d.agent.versions({ launch: this.launchEnvelope() })),
      launchSettings: () => this.launchSettings(),
      config: d.config,
      actor,
    };
  }
}
