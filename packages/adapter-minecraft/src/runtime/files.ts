/**
 * The files the agent owns in the data root, written before every start
 * (`prepare`): the game rewrites `server.properties` from memory at every
 * boot, so the managed keys are applied again each time (CFG-04).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeCtx } from '@gsp/adapter-api';
import { buildProperties, editProperties } from '@gsp/formats';
import { LEVEL_NAME, type MANAGED_PROPERTIES } from '../shared/install';
import type { MinecraftLaunch } from '../shared/launch';
import { MINECRAFT_META } from '../shared/meta';

export const EULA_NOT_ACCEPTED = `The owner has not accepted the Minecraft EULA (${MINECRAFT_META.eula!.url}). Only the owner can accept it, in the panel; the server can't start until then.`;

/** Paper's bStats settings, relative to the data root. */
export const BSTATS_CONFIG = 'plugins/bStats/config.yml';

function port(ctx: RuntimeCtx, id: 'game' | 'rcon'): number {
  return ctx.ports[id] ?? MINECRAFT_META.ports.find((p) => p.id === id)!.default;
}

/** The values of `MANAGED_PROPERTIES` for this server. */
export function managedProperties(ctx: RuntimeCtx): Record<(typeof MANAGED_PROPERTIES)[number], string> {
  return {
    'server-port': String(port(ctx, 'game')),
    // Every address in the container; the orchestrator publishes the port.
    'server-ip': '',
    'enable-rcon': 'true',
    'rcon.port': String(port(ctx, 'rcon')),
    'rcon.password': ctx.state.controlSecret,
    // Nothing publishes the query port (UDP), and the management server isn't used (Q12).
    'enable-query': 'false',
    'management-server-enabled': 'false',
    'level-name': LEVEL_NAME,
  };
}

/** Writes through a temporary file, only when the text changes. */
function writeIfChanged(file: string, before: string | null, after: string): void {
  if (after === before) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.gsp-tmp`, after);
  renameSync(`${file}.gsp-tmp`, file);
}

/** Sets keys of a properties file in place (comments and other keys stay), or writes a new file with `header` and them. */
function setProperties(file: string, values: Record<string, string>, header = ''): void {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  writeIfChanged(file, before, before === null ? `${header}${buildProperties(values)}` : editProperties(before, values));
}

/**
 * Before every start: the managed `server.properties` keys (the game
 * completes a new file with its defaults); `eula=true` only once the owner
 * accepted the EULA in the panel (D6) — without it the start fails here,
 * with a message that says why; and for Paper, bStats off on a new server
 * (Q10, NFR-09): its settings file is written only when it doesn't exist
 * yet, so an owner who turns bStats on keeps it on.
 */
export async function prepare(ctx: RuntimeCtx, p: MinecraftLaunch): Promise<void> {
  if (ctx.eulaAccepted !== true) throw new Error(EULA_NOT_ACCEPTED);
  const data = ctx.roots.data;
  mkdirSync(data, { recursive: true });
  setProperties(path.join(data, 'server.properties'), managedProperties(ctx));
  setProperties(path.join(data, 'eula.txt'), { eula: 'true' }, `# Accepted by the server's owner in the panel: ${MINECRAFT_META.eula!.url}\n`);
  if (p.loader === 'paper') {
    const bstats = path.join(data, ...BSTATS_CONFIG.split('/'));
    if (!existsSync(bstats)) {
      writeIfChanged(
        bstats,
        null,
        [
          '# bStats (https://bStats.org) sends anonymous usage statistics to plugin authors.',
          '# The panel turns it off for new servers; set enabled to true to send them.',
          'enabled: false',
          'logFailedRequests: false',
          '',
        ].join('\n'),
      );
    }
  }
}
