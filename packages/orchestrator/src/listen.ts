import { chmodSync, lstatSync, rmSync } from 'node:fs';
import type http from 'node:http';

/** A Windows named pipe (`\\.\pipe\…`): what Node's net module listens on there instead of socket files. */
export const isNamedPipe = (p: string) => /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(p);

/**
 * Listens on a unix socket (or, on Windows, a named pipe). A socket file
 * left behind by a previous run is removed first; the new one is made
 * connectable by any user of the containers that mount its volume (the panel
 * runs as another user), so the volume, not the file mode, is the boundary.
 */
export function listenOnSocket(server: http.Server, socket: string): Promise<void> {
  if (!isNamedPipe(socket)) {
    try {
      if (lstatSync(socket).isSocket()) rmSync(socket);
    } catch {
      // nothing there
    }
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      server.off('error', reject);
      if (!isNamedPipe(socket)) chmodSync(socket, 0o666);
      resolve();
    });
  });
}
