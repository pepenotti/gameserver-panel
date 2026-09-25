import type { DirEntry, FileStat, PackRequest, RootId, ServerFiles } from '@gsp/adapter-api';

/** Where a server's agent answers, and its token (the server's `AGENT_TOKEN`). */
export interface AgentFilesTarget {
  baseUrl: string;
  token: string;
}

/**
 * A server's files through its agent (D11): each method is one of the
 * agent's `/v1/fs/*` and `/v1/archive/*` routes (`@gsp/shared` agent-api).
 * M2-C implements it (and the agent's side); until then every call fails,
 * and the panel keeps `LocalServerFiles` for the server its environment
 * describes.
 */
export class AgentServerFiles implements ServerFiles {
  constructor(readonly target: AgentFilesTarget) {}

  private todo(route: string): Promise<never> {
    return Promise.reject(new Error(`not-implemented: ${route} through the agent (M2-C)`));
  }

  stat(_root: RootId, _rel: string): Promise<FileStat | null> {
    return this.todo('/v1/fs/stat');
  }
  list(_root: RootId, _rel: string): Promise<DirEntry[]> {
    return this.todo('/v1/fs/list');
  }
  read(_root: RootId, _rel: string, _o?: { maxBytes?: number }): Promise<Buffer | null> {
    return this.todo('/v1/fs/read');
  }
  writeAtomic(_root: RootId, _rel: string, _data: Buffer | string): Promise<void> {
    return this.todo('/v1/fs/write');
  }
  remove(_root: RootId, _rels: string[]): Promise<void> {
    return this.todo('/v1/fs/remove');
  }
  pack(_req: PackRequest): Promise<AsyncIterable<Buffer>> {
    return this.todo('/v1/archive/pack');
  }
  stage(_archive: AsyncIterable<Buffer>, _allow: string[]): Promise<{ stagingId: string; entries: number }> {
    return this.todo('/v1/archive/stage');
  }
  swap(_stagingId: string, _rels: string[]): Promise<{ trashId: string }> {
    return this.todo('/v1/archive/swap');
  }
  undo(_trashId: string): Promise<void> {
    return this.todo('/v1/archive/undo');
  }
  purgeTrash(_trashId?: string): Promise<void> {
    return this.todo('/v1/archive/purge');
  }
}
