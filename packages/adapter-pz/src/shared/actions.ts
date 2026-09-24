/**
 * Agent actions (`POST /v1/actions/:name`) the Project Zomboid halves agree
 * on: the runtime adapter implements them, the panel adapter calls them.
 */

/** Download workshop items with steamcmd (today's `POST /v1/steamcmd/workshop`). Replies with a `JobResult`. */
export const WORKSHOP_DOWNLOAD = 'workshop-download';

export interface WorkshopDownloadInput {
  /** 1-100 workshop ids. */
  ids: string[];
}

/**
 * Player accounts from the game's own database (`db/<serverName>.db`), read
 * by the agent. Replies with `PlayerAccount[]` from `@gsp/adapter-api`.
 */
export const ACCOUNTS = 'accounts';

/** Steam-id and IP bans from the same database. Replies with `BanList`. */
export const BANS = 'bans';

/** Input of `accounts` and `bans`: actions don't receive the launch params. */
export interface ServerDbInput {
  serverName: string;
}
