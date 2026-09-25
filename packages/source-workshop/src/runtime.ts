/**
 * The runtime half of the Workshop source: the agent action that downloads
 * items with the agent's steamcmd driver (`workshop_download_item`, into the
 * data root's `.workshop` cache). A game adapter of the `steam` family adds
 * it to its actions under `WORKSHOP_DOWNLOAD`, with its Workshop app id.
 */
import type { JobResult, RuntimeAction } from '@gsp/adapter-api';
import { WORKSHOP_DOWNLOAD_BATCH, WORKSHOP_ID, type WorkshopDownloadInput } from './index';

export { WORKSHOP_DOWNLOAD, type WorkshopDownloadInput } from './index';

function asObject(x: unknown): Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

/** `workshop-download` for the items of `workshopAppId` (the game's app on the Workshop). */
export function workshopDownloadAction(workshopAppId: string): RuntimeAction {
  if (!/^\d{1,10}$/.test(workshopAppId)) throw new Error(`Invalid Workshop app id ${workshopAppId}`);
  return {
    job: 'workshop',
    parse(x): WorkshopDownloadInput {
      const ids = asObject(x).ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > WORKSHOP_DOWNLOAD_BATCH || !ids.every((id) => typeof id === 'string')) throw new Error(`Give 1-${WORKSHOP_DOWNLOAD_BATCH} workshop ids`);
      for (const id of ids as string[]) if (!WORKSHOP_ID.test(id)) throw new Error(`Invalid workshop id ${id}`);
      return { ids: ids as string[] };
    },
    async run(ctx, _ctl, input): Promise<JobResult> {
      const { ids } = input as WorkshopDownloadInput;
      if (!ctx.steam) throw new Error('No steamcmd driver: Workshop items are downloaded with steamcmd');
      ctx.progress(null, `Downloading ${ids.length} workshop item(s)`);
      return ctx.steam.workshopDownload({ workshopAppId, ids });
    },
  };
}
