import type { Capability, ConfigAccess, PanelAdapter, SecretBag, ServerCtx, ServerFiles, ServerRef, ToAgentOptions } from '@gsp/adapter-api';
import type { LaunchEnvelope, VersionsResponse } from '@gsp/shared';
import type { AgentApi } from '../agent/client';
import type { ConfigStore } from '../config/store';
import type { AgentFeed } from '../http/deps';
import type { KeyValueSettings } from '../settings';

/** Settings row with the adapter's launch settings (its `S`). */
const LAUNCH_KEY = 'launch';

/** What a server can do: its flavour's capabilities, or the adapter's. */
export function capabilitiesOf(adapter: PanelAdapter, flavour: string | null): Set<Capability> {
  const f = flavour === null ? undefined : adapter.meta.flavours.find((x) => x.id === flavour);
  return new Set(f?.capabilities ?? adapter.meta.capabilities);
}

export interface ServerHandleDeps {
  /** Which server: its id, the name its game uses for its files, its flavour. */
  ref: ServerRef;
  /** The secrets the panel holds for it, by `LaunchSecretDecl.key` (the environment's for the server it describes, else the row's). */
  secrets: () => Readonly<Record<string, string>>;
  agent: AgentApi;
  feed: AgentFeed;
  files: ServerFiles;
  /** The server's own settings. */
  settings: KeyValueSettings;
  /** The settings service; late-bound because it runs adapter code with this handle's contexts. */
  config: () => ConfigStore;
  adapter: PanelAdapter;
  /** When the owner accepted the game's agreement, and who (D6), as stored now; absent: never. */
  eula?: () => EulaAcceptance;
}

/** An acceptance of a game's agreement (`servers.eula_accepted_at/by`, D6). */
export interface EulaAcceptance {
  at: string | null;
  /** User id of whoever accepted. */
  by: number | null;
}

/**
 * One game server as adapter code sees it: its adapter, its stored launch
 * settings and secrets, and the `ServerCtx` adapter code runs with. Every
 * service of the server shares its `ref`.
 */
export class ServerHandle {
  readonly ref: ServerRef;

  constructor(private readonly d: ServerHandleDeps) {
    this.ref = { ...d.ref };
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
    const held = this.d.secrets();
    const out: Record<string, string> = {};
    for (const s of this.d.adapter.launch.secrets ?? []) {
      const v = held[s.key];
      if (v) out[s.key] = v;
    }
    return out;
  }

  /** Declared secrets without a value: the panel can't start the server without them. */
  missingSecrets(): string[] {
    const held = this.d.secrets();
    return (this.d.adapter.launch.secrets ?? []).map((s) => s.key).filter((k) => !held[k]);
  }

  /** The acceptance of the game's agreement, for a game that has one (`eula`, D6); null for the others. */
  eula(): EulaAcceptance | null {
    if (!this.has('eula')) return null;
    return this.d.eula?.() ?? { at: null, by: null };
  }

  /** The game needs its agreement accepted before it may start, and the owner hasn't yet (D6). */
  eulaPending(): boolean {
    const e = this.eula();
    return e !== null && e.at === null;
  }

  /**
   * Launch params for the agent; throws when the adapter can't turn `s` into
   * params. A game with an agreement also gets whether the owner accepted it
   * (`eulaAccepted`), so its adapter writes the game's acceptance only then.
   */
  launchEnvelope(o: ToAgentOptions = {}, s: unknown = this.launchSettings()): LaunchEnvelope {
    const envelope: LaunchEnvelope = { adapter: this.d.adapter.meta.id, params: this.d.adapter.launch.toAgent(this.ref, s, this.secrets(), o) };
    const eula = this.eula();
    if (eula) envelope.eulaAccepted = eula.at !== null;
    return envelope;
  }

  /** The config files as adapter code writes them (resets, hooks): as `actor`, no busy checks. */
  private configAccess(actor: string | null): ConfigAccess {
    const store = this.d.config;
    return {
      set: (fileId, values, note, o) => store().setDirect(fileId, values, actor, note, o),
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
