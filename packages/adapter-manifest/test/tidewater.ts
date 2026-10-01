// A made-up Steam game whose manifest uses what Avorion's doesn't (no
// console: signals, its own autosaves, list files for moderation, a port
// that follows another, a generated secret, rules across settings, Steam
// queries, a timestamp and colours on every line, progress lines), so the
// engine is tested on every part of the format.
import { loadManifest } from '../src/shared';

const t = (en: string, es = en) => ({ en, es });

export const TIDEWATER_JSON = {
  manifestVersion: 1,
  id: 'tidewater',
  name: t('Tidewater'),
  steam: { appId: '1234567', branches: ['beta'], defaultBranch: 'public' },
  arch: ['amd64'],
  memory: { minMb: 1024, defaultMb: 2048, overheadMb: 256 },
  ports: [
    { id: 'game', proto: 'udp', default: 3000, publish: true, sameInsideOut: true, label: t('Game', 'Juego') },
    { id: 'query', proto: 'udp', default: 3001, publish: true, sameInsideOut: true, follows: { id: 'game', offset: 1 }, label: t('Steam query', 'Consulta de Steam') },
  ],
  settings: [
    { id: 'serverName', type: 'string', label: t('Server name', 'Nombre del servidor'), description: t('Its name.', 'Su nombre.'), default: 'My tide', minLength: 1, maxLength: 32 },
    {
      id: 'password',
      type: 'secret',
      label: t('Password', 'Contraseña'),
      description: t('What players type.', 'Lo que escriben los jugadores.'),
      maxLength: 32,
      rules: [
        { if: { setting: 'public', equals: true }, minLength: 5, message: t('A public server needs a password of at least 5 characters.', 'Un servidor público necesita una contraseña de al menos 5 caracteres.') },
        { if: { setting: 'public', equals: true }, notIn: 'serverName', message: t("The password can't be part of the server's name.", 'La contraseña no puede formar parte del nombre del servidor.') },
      ],
    },
    { id: 'public', type: 'boolean', label: t('Public', 'Público'), description: t('Listed on Steam.', 'Listado en Steam.'), default: false, onValue: '1', offValue: '0' },
    {
      id: 'mode',
      type: 'enum',
      label: t('Mode', 'Modo'),
      description: t('The world preset.', 'El preajuste del mundo.'),
      default: '',
      choices: [
        { value: '', label: t('Normal') },
        { value: 'hard', label: t('Hard', 'Difícil') },
      ],
      advanced: true,
    },
    { id: 'saveEvery', type: 'integer', label: t('Save every', 'Guardar cada'), description: t('Seconds.', 'Segundos.'), default: 300, min: 60, max: 3600, step: 60, unit: 's' },
  ],
  secrets: [{ id: 'adminKey', label: t('Admin key', 'Clave de administración') }],
  launch: {
    executable: '{installDir}/tide_server',
    args: ['-name', '{setting:serverName}', '-port', '{port:game}', '-password', '{setting:password}', '-public', '{setting:public}', '-key', '{secret:adminKey}', { if: { setting: 'mode', notEmpty: true }, args: ['-preset', '{setting:mode}'] }, '-savedir', '{dataDir}', '-world', '{name}'],
    cwd: '{installDir}',
    env: { TIDE_APP: '7654321', TIDE_LIBS: '{installDir}/lib' },
  },
  prepare: { dirs: ['worlds'] },
  log: { stripAnsi: true, strip: '^\\d\\d:\\d\\d:\\d\\d ', progress: [{ key: 'worldgen', pattern: '^Placing ', text: 'Generating the world' }] },
  readiness: {
    ready: '^Server is up$',
    version: '^Version (\\S+)$',
    fatal: ['^Bad password'],
    warnings: [{ id: 'no-steam', pattern: '^Steam failed$', message: t("The server can't reach Steam.", 'El servidor no puede contactar con Steam.') }],
  },
  console: { kind: 'none' },
  stop: { signal: 'SIGINT', budgetMs: 60000 },
  autosave: { start: '^Saving world$', done: '^World saved$', budgetMs: 2000 },
  backups: {
    parts: [
      { id: 'world', label: t('World', 'Mundo'), paths: ['worlds/{name}'] },
      { id: 'lists', label: t('Lists', 'Listas'), paths: ['banned.txt', 'allowed.txt', 'admins.txt'] },
    ],
    running: 'copy-between-saves',
  },
  resets: [
    { id: 'world', label: t('New world', 'Mundo nuevo'), permission: 'reset.world', removeParts: ['world'] },
    { id: 'factory', label: t('New world and empty lists', 'Mundo nuevo y listas vacías'), permission: 'reset.factory', removeParts: ['world', 'lists'] },
  ],
  config: {
    files: [
      { id: 'banned', label: t('Banned', 'Vetados'), path: 'banned.txt', format: 'lines', restartKeys: '*', seed: '# banned SteamIDs\n' },
      { id: 'allowed', label: t('Allowed', 'Permitidos'), path: 'allowed.txt', format: 'lines', restartKeys: '*' },
      { id: 'admins', label: t('Admins', 'Administradores'), path: 'admins.txt', format: 'lines', restartKeys: '*' },
      { id: 'world-settings', path: 'worlds/{name}/settings.ini', format: 'ini', managed: { port: '{port:game}', query: '{port:query}', save: '{setting:saveEvery}', world: '{name}', telemetry: 'off' }, secretKeys: ['adminpass'], restartKeys: ['motd'] },
    ],
    roots: [{ id: 'world', label: t('World', 'Mundo'), path: 'worlds/{name}', include: ['*.ini'] }],
  },
  players: { join: '^Joined: (\\d+)$', leave: '^Left: (\\d+)$', steamQuery: { port: 'query', when: { setting: 'public', equals: true } } },
  moderation: { listFiles: { ban: 'banned', allow: 'allowed', admin: 'admins', target: 'steamId', stoppedOnly: false }, banTargets: ['steamId'] },
  notes: [{ id: 'no-console', text: t('No console.', 'Sin consola.'), doc: 'limitations.md#host' }],
} as const;

export const TIDEWATER = loadManifest(TIDEWATER_JSON);

/** Launch params as the panel would send them for a server named `tide`. */
export const tideLaunch = (over: Record<string, unknown> = {}) => ({ name: 'tide', branch: 'public', updateOnStart: false, memoryMb: 2048, serverName: 'My tide', password: '', public: false, mode: '', saveEvery: 300, adminKey: 'k-123456789', ...over });
