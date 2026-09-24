import type { Capability, ConfigAccess, PanelAdapter, SecretBag, ServerCtx, ServerFiles, ServerRef, ToAgentOptions } from '@gsp/adapter-api';
import type { LaunchEnvelope, VersionsResponse } from '@gsp/shared';
import type { AgentApi } from '../agent/client';
import type { ConfigStore } from '../config/store';
import type { PanelEnv } from '../env';
import type { AgentFeed } from '../http/deps';
import type { Settings } from '../settings';

/** Settings row with the adapter's launch settings (its `S`). */
const LAUNCH_KEY = 'launch';

/** The panel's one server until M2 (servers get ids of their own then). */
export const DEFAULT_SERVER_ID = 'default';

/** What a server can do: its flavour's capabilities, or the adapter's. */
export function capabilitiesOf(adapter: PanelAdapter, flavour: string | null): Set<Capability> {
  const f = flavour === null ? undefined : adapter.meta.flavours.find((x) => x.id === flavour);
  return new Set(f?.capabilities ?? adapter.meta.capabilities);
}

export interface ServerHandleDeps {
  env: Pick<PanelEnv, 'serverName' | 'secrets'>;
  agent: AgentApi;
  feed: AgentFeed;
  files: ServerFiles;
  settings: Settings;
  /** The settings service; late-bound because it runs adapter code with this handle's contexts. */
  config: () => ConfigStore;
  adapter: PanelAdapter;
}

/**
 * The one game server the panel runs (until M2): its adapter, its stored
 * launch settings and secrets, and the `ServerCtx` adapter code runs with.
 * Every service shares its `ref`.
 */
export class ServerHandle {
  readonly ref: ServerRef;

  constructor(private readonly d: ServerHandleDeps) {
    this.ref = { id: DEFAULT_SERVER_ID, gameName: d.env.serverName, flavour: null };
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

  /** The secrets the adapter declares (`launch.secrets`) that the panel holds values for. */
  secrets(): SecretBag {
    const out: Record<string, string> = {};
    for (const s of this.d.adapter.launch.secrets ?? []) {
      const v = this.d.env.secrets[s.key];
      if (v) out[s.key] = v;
    }
    return out;
  }

  /** Declared secrets without a value: the panel can't start the server without them. */
  missingSecrets(): string[] {
    return (this.d.adapter.launch.secrets ?? []).map((s) => s.key).filter((k) => !this.d.env.secrets[k]);
  }

  /** Launch params for the agent; throws when the adapter can't turn `s` into params. */
  launchEnvelope(o: ToAgentOptions = {}, s: unknown = this.launchSettings()): LaunchEnvelope {
    return { adapter: this.d.adapter.meta.id, params: this.d.adapter.launch.toAgent(this.ref, s, this.secrets(), o) };
  }

  /** The config files as adapter code writes them (resets, hooks): as `actor`, no busy checks. */
  private configAccess(actor: string | null): ConfigAccess {
    const store = this.d.config;
    return {
      set: (fileId, values, note) => store().setDirect(fileId, values, actor, note),
      seedIfMissing: () => store().seedIfMissing(),
      applyPreset: async (name) => {
        await store().applyPreset(name, actor, { force: true });
      },
    };
  }

  /** A context for adapter code; `actor` is who the operation runs for. */
  ctx(actor: string | null = null): ServerCtx {
    const d = this.d;
    let versions: Promise<VersionsResponse> | null = null;
    return {
      srv: this.ref,
      files: d.files,
      actor,
      status: () => d.feed.status_,
      command: (c) => d.agent.command(c.command, c.via),
      action: (name, input) => d.agent.action(name, input),
      // One call per context: an update check and the route that shows it share the answer.
      versions: () => (versions ??= d.agent.versions({ launch: this.launchEnvelope() })),
      launchSettings: () => this.launchSettings(),
      config: this.configAccess(actor),
      onLog: (listener) =>
        d.feed.onEvent((e) => {
          if (e.event.type === 'log') listener(e.event.line);
        }),
    };
  }
}
