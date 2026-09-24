/**
 * What the panel half sends the runtime half on every start
 * (`LaunchEnvelope.params` for adapter `pz`): the core only ever sees the
 * envelope, never this shape.
 */
export interface PzLaunch {
  /** `-servername`; names the ini, sandbox and save folder. Fixed once the server exists. */
  serverName: string;
  adminUsername: string;
  adminPassword: string;
  /** Heap size for both -Xms and -Xmx, in MiB. */
  memoryMb: number;
  /** Steam branch of the dedicated-server app: `public`, `legacy41`, `42.19`, … */
  branch: string;
  /** Run steamcmd app_update before every start. */
  updateOnStart: boolean;
}

/** `PzLaunch` as the agent's status shows it (secrets left out). */
export type PublicPzLaunch = Omit<PzLaunch, 'adminPassword'>;
