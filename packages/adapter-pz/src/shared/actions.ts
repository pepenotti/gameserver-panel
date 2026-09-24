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
