import type { ServerFilesErrorCode } from '@gsp/shared';

/** Why a `ServerFiles` call was refused (`AgentError.reason` over HTTP). */
export class ServerFilesError extends Error {
  constructor(
    readonly code: ServerFilesErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const MAX_REL = 1024;
// Windows maps these names to devices in any folder, with or without an extension.
const DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function invalid(rel: string): never {
  throw new ServerFilesError('invalid-path', `Invalid path: ${JSON.stringify(rel)}`);
}

/**
 * `rel` as path segments. Paths are relative with `/` separators. Refused:
 * absolute paths, drive letters, backslashes, NUL and other control
 * characters, `..`, and names Windows would read differently from Linux
 * (`a.txt:stream`, a trailing dot or space, device names), so a check on the
 * name is a check on the file that gets opened.
 */
export function segments(rel: string): string[] {
  if (typeof rel !== 'string' || rel.length > MAX_REL || /[\x00-\x1f\x7f\\]/.test(rel) || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) invalid(rel);
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..' || /[:<>"|?*]/.test(p) || /[. ]$/.test(p) || DEVICE_NAMES.test(p)) invalid(rel);
  }
  return parts;
}

/** Whether a single file name passes `segments` (a name the file API can reach). */
export function isSafeName(name: string): boolean {
  try {
    return segments(name).length === 1 && !name.includes('/');
  } catch {
    return false;
  }
}

/** Staging and trash folder ids. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isFolderId(id: unknown): id is string {
  return typeof id === 'string' && ID.test(id);
}
