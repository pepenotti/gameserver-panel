import type { FileRoots } from '@gsp/adapter-api';
import { RootedFiles } from '@gsp/archive';

export { segments, ServerFilesError } from '@gsp/archive';

const ALWAYS_SNAPSHOT = { before: async () => undefined, after: async () => undefined };

/**
 * `ServerFiles` on the panel's own disk, for tests and the dev loop: the
 * same `RootedFiles` an agent serves (D11), rooted at folders the panel can
 * see. There is no game process to ask for a hot copy, so every pack copies
 * the SQLite globs as snapshots, which is consistent whether or not a game
 * writes to them. A deployed panel reaches each server's files through its
 * agent (`AgentServerFiles`) and mounts no game volumes.
 */
export class LocalServerFiles extends RootedFiles {
  constructor(roots: FileRoots) {
    super({ roots, hot: () => ALWAYS_SNAPSHOT });
  }
}
