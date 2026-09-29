/**
 * TShock's plugins as the panel sees them (MOD-06): a plugin source whose
 * work happens in the runtime's actions, next to the files
 * (`runtime/plugins.ts`); here are what people are told, the limits, and a
 * first check of names and links so a wrong one is answered without
 * reaching the server. Layout and rules: `shared/plugins.ts`.
 */
import type { PluginAdded, PluginFile, PluginOrigin, PluginReply, PluginSource, ServerCtx } from '@gsp/adapter-api';
import { isPluginName, PLUGIN_ACTIONS, PLUGIN_EXTENSION, PLUGIN_MAX_BYTES, PLUGINS, pluginLinkRefusal, UPLOAD_NAME } from '../shared/plugins';

/** What the agent answered, as a `PluginReply`; anything else was no answer at all. */
function reply<T extends object>(x: unknown): PluginReply<T> {
  if (x === null || typeof x !== 'object' || typeof (x as { ok?: unknown }).ok !== 'boolean') throw new Error("Unexpected reply from the server's agent");
  return x as PluginReply<T>;
}

const badName = (name: string): PluginReply<never> => ({ ok: false, reason: 'bad-name', message: `Not a plugin file name: ${JSON.stringify(String(name).slice(0, 120))}` });

async function add(ctx: ServerCtx, from: PluginOrigin): Promise<PluginReply<PluginAdded>> {
  if ('url' in from) {
    // Which hosts are allowed is `checkLink`'s (the panel asks it first) and the agent's; here, only that it is one.
    const protocol = URL.canParse(from.url) ? new URL(from.url).protocol : null;
    if (protocol !== 'https:' && protocol !== 'http:') return { ok: false, reason: 'link-invalid', message: 'Not a web address' };
    return reply(await ctx.action(PLUGIN_ACTIONS.add, { url: from.url }));
  }
  if (!UPLOAD_NAME.test(from.upload)) return { ok: false, reason: 'bad-name', message: 'Not an upload of the panel' };
  return reply(await ctx.action(PLUGIN_ACTIONS.add, { upload: from.upload, name: from.name }));
}

export const tshockPlugins: PluginSource = {
  id: 'tshock-plugins',
  capability: 'mods:tshock',
  label: { en: 'TShock plugins', es: 'Plugins de TShock' },
  warning: {
    en: 'A plugin runs its own code inside this server, with everything TShock can reach: the world, the players’ accounts and the server’s connection to the internet. Add only plugins you trust, from their authors’ own releases. TShock skips a plugin it can’t load without saying so: after the restart, check the log for “Plugin … initiated”.',
    es: 'Un plugin ejecuta su propio código dentro de este servidor, con todo lo que TShock alcanza: el mundo, las cuentas de los jugadores y la conexión del servidor a internet. Agregá solo plugins en los que confíes, de las publicaciones de sus propios autores. TShock omite sin avisar un plugin que no puede cargar: después del reinicio, buscá en el registro «Plugin … initiated».',
  },
  extensions: [PLUGIN_EXTENSION],
  maxBytes: PLUGIN_MAX_BYTES,
  linkHint: {
    en: 'A GitHub release download link: https://github.com/<owner>/<repository>/releases/download/<version>/<file>.dll (or .zip). The server downloads it itself.',
    es: 'Un enlace de descarga de una publicación de GitHub: https://github.com/<dueño>/<repositorio>/releases/download/<versión>/<archivo>.dll (o .zip). El servidor lo descarga por su cuenta.',
  },
  uploadDir: PLUGINS.uploads,
  checkLink: pluginLinkRefusal,
  list: async (ctx) => reply<{ plugins: PluginFile[] }>(await ctx.action(PLUGIN_ACTIONS.list, {})),
  add,
  async setEnabled(ctx, name, enabled) {
    if (!isPluginName(name)) return badName(name);
    return reply(await ctx.action(PLUGIN_ACTIONS.set, { name, enabled }));
  },
  async remove(ctx, name) {
    if (!isPluginName(name)) return badName(name);
    return reply(await ctx.action(PLUGIN_ACTIONS.remove, { name }));
  },
};
