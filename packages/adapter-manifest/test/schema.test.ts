// Manifests are checked when they are loaded (D4, M6): the JSON Schema in
// manifest.schema.json (by the package's own checker, no library), then the
// rules a schema can't say. Every manifest the package ships loads; broken
// ones are refused with every problem named.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSchema, ManifestError, MANIFEST_SCHEMA, loadManifest, manifestMeta, MANIFESTS, SchemaError, type JsonSchema } from '../src/shared';

const DIR = fileURLToPath(new URL('../manifests/', import.meta.url));
const avorionJson = () => JSON.parse(readFileSync(`${DIR}avorion.json`, 'utf8')) as Record<string, unknown>;

describe('the schema checker (a draft 2020-12 subset)', () => {
  const s: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'n'],
    $defs: { id: { type: 'string', pattern: '^[a-z]+$', minLength: 2, maxLength: 4 } },
    properties: {
      id: { $ref: '#/$defs/id' },
      n: { type: 'integer', minimum: 1, maximum: 9 },
      list: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: ['a', 'b', 'c'] } },
      kind: { oneOf: [{ const: 'x' }, { type: 'object', additionalProperties: false, required: ['k'], properties: { k: { type: 'boolean' } } }] },
      any: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      re: { type: 'string', format: 'regex' },
      map: { type: 'object', additionalProperties: { type: 'string' } },
      both: { type: ['string', 'boolean'] },
    },
  };

  it('passes what conforms', () => {
    expect(checkSchema(s, { id: 'ab', n: 3, list: ['a', 'c'], kind: { k: true }, any: 2.5, re: '^x+$', map: { a: 'b' }, both: false })).toEqual([]);
    expect(checkSchema(s, { id: 'abcd', n: 9, kind: 'x', any: 'y', both: 'z' })).toEqual([]);
  });

  it('names where and what for everything else', () => {
    const issues = checkSchema(s, { id: 'A', n: 1.5, extra: 1, list: ['a', 'a', 'd'], kind: { k: 'no' }, any: true, re: '(', map: { a: 1 }, both: 3 });
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'id', message: 'must have at least 2 characters' },
        { path: 'id', message: 'must match ^[a-z]+$' },
        { path: 'n', message: 'must be integer, not number' },
        { path: 'extra', message: 'is not a known field' },
        { path: 'list', message: 'has "a" twice' },
        { path: 'list[2]', message: 'must be one of "a", "b", "c"' },
        // The shape it comes closest to says what is wrong.
        { path: 'kind.k', message: 'must be boolean, not string' },
        { path: 're', message: 'must be a valid regular expression' },
        { path: 'map.a', message: 'must be string, not integer' },
        { path: 'both', message: 'must be string or boolean, not integer' },
      ]),
    );
    expect(issues.some((i) => i.path === 'any')).toBe(true);
    expect(checkSchema(s, {})).toEqual([
      { path: 'id', message: 'is required' },
      { path: 'n', message: 'is required' },
    ]);
    expect(checkSchema(s, [])).toEqual([{ path: '', message: 'must be object, not array' }]);
  });

  it('refuses a schema it could not apply faithfully', () => {
    expect(() => checkSchema({ type: 'object', patternProperties: {} }, {})).toThrow(SchemaError);
    expect(() => checkSchema({ type: 'string', format: 'email' }, 'x')).toThrow(/Unsupported format email/);
    expect(() => checkSchema({ $ref: 'https://example.invalid/s.json' }, 'x')).toThrow(/Only references inside the schema/);
    expect(() => checkSchema({ $ref: '#/$defs/missing' }, 'x')).toThrow(/Unresolved reference/);
  });

  it('applies to every keyword manifest.schema.json uses', () => {
    // Walks the schema itself: every subschema uses only what the checker knows.
    const known = ['$schema', '$id', '$defs', '$comment', '$ref', 'title', 'description', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'oneOf', 'anyOf', 'allOf', 'format'];
    const walk = (x: unknown, where: string): void => {
      if (typeof x !== 'object' || x === null) return;
      for (const [k, v] of Object.entries(x)) {
        expect(known, `${where}.${k}`).toContain(k);
        if (k === 'properties' || k === '$defs') for (const [name, sub] of Object.entries(v as object)) walk(sub, `${where}.${k}.${name}`);
        else if (k === 'items' || k === 'additionalProperties') walk(v, `${where}.${k}`);
        else if (k === 'oneOf' || k === 'anyOf' || k === 'allOf') (v as unknown[]).forEach((sub, i) => walk(sub, `${where}.${k}[${i}]`));
      }
    };
    walk(MANIFEST_SCHEMA, '(schema)');
  });
});

describe('every manifest the package ships (D4)', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

  it('is listed, one file per adapter id', () => {
    expect(files.map((f) => f.replace(/\.json$/, '')).sort()).toEqual(Object.keys(MANIFESTS).sort());
  });

  for (const f of files) {
    it(`${f} conforms to the schema and the rules, and names its schema`, () => {
      const json = JSON.parse(readFileSync(`${DIR}${f}`, 'utf8')) as Record<string, unknown>;
      expect(checkSchema(MANIFEST_SCHEMA, json)).toEqual([]);
      expect(json.$schema).toBe('../manifest.schema.json');
      const m = loadManifest(json);
      expect(`${m.id}.json`).toBe(f);
      expect(Object.isFrozen(m) && Object.isFrozen(m.ports)).toBe(true);
    });
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a manifest's JSON, broken freely in place
type Json = Record<string, any>;

describe('a broken manifest is refused, every problem named', () => {
  /** Avorion's manifest, changed. */
  const broken = (change: (m: Json) => void) => {
    const m = avorionJson() as Json;
    change(m);
    try {
      loadManifest(m);
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError);
      return (e as ManifestError).problems;
    }
    throw new Error('expected the manifest to be refused');
  };

  it('by the schema: a missing or unknown field, a bad id, a pattern that does not compile', () => {
    expect(
      broken((m) => {
        delete m.stop;
        m.extra = true;
        m.id = 'Avorion!';
        m.readiness.ready = '(unclosed';
      }),
    ).toEqual(expect.arrayContaining(['stop is required', 'extra is not a known field', 'id must match ^[a-z][a-z0-9-]{1,30}$', 'readiness.ready must be a valid regular expression']));
    expect(broken((m) => (m.ports[0].proto = 'both'))).toEqual(['ports[0].proto must be one of "udp", "tcp"']);
    expect(broken((m) => (m.console = { kind: 'telnet' }))).toEqual(expect.arrayContaining(['console.kind must be "stdin"']));
  });

  it('ports: following one declared before it, at its default distance, never the same port twice', () => {
    expect(broken((m) => (m.ports[1].follows.id = 'query'))).toEqual(['port gametcp follows query, which isn\'t a port declared before it']);
    expect(broken((m) => (m.ports[1].proto = 'udp'))).toEqual(expect.arrayContaining(['port gametcp follows game at 0 on the same protocol: it would be the same port']));
    expect(broken((m) => (m.ports[1].default = 27001))).toEqual(["port gametcp must default to game's default plus its offset (27000)"]);
    expect(broken((m) => (m.ports[3].default = 27003))).toEqual(['port steamquery has the default 27003/udp of another port']);
  });

  it('settings: defaults that fit, fields of their type, names the launch keeps for itself', () => {
    expect(broken((m) => delete m.settings[0].default)).toEqual(['setting serverName needs a default']);
    expect(broken((m) => (m.settings[1].default = 100))).toEqual(['setting maxPlayers has a default outside its range']);
    expect(broken((m) => (m.settings[3].default = 90))).toEqual(['setting saveInterval has a default off its steps']);
    expect(broken((m) => (m.settings[2].default = 'yes'))).toEqual(['setting listed has a default that is a string, not a boolean']);
    expect(broken((m) => (m.settings[0].min = 1))).toEqual(['setting serverName has min, which only integer settings take']);
    expect(broken((m) => (m.settings[0].id = 'branch'))).toEqual(expect.arrayContaining(["setting branch takes a name every manifest game's launch has (name, branch, updateOnStart, memoryMb)"]));
    expect(broken((m) => m.settings.push({ id: 'mode', type: 'enum', label: m.name, description: m.name, default: 'x' }))).toEqual(['setting mode is a choice without choices', 'setting mode has a default that is none of its choices']);
    expect(broken((m) => (m.settings[0].rules = [{ notIn: 'maxPlayers', message: m.name }]))).toEqual(["setting serverName rule 1 names maxPlayers, which isn't a text setting"]);
  });

  it('templates: known placeholders, where each may be used', () => {
    expect(broken((m) => m.launch.args.push('{port:nope}', '{setting:nope}', '{foo}', '{arg}', 'a{b'))).toEqual(
      expect.arrayContaining([
        "launch.args[22] names the port nope, which isn't declared",
        "launch.args[23] names the setting nope, which isn't declared",
        'launch.args[24] unknown placeholder {foo}',
        "launch.args[25] can't use {arg} here",
        'launch.args[26] a brace that is no placeholder in "a{b"',
      ]),
    );
    expect(broken((m) => (m.backups.parts[0].paths = ['../{name}']))).toEqual(['backup part galaxy path 1 must be a path inside the data folder']);
    expect(broken((m) => (m.config.files[0].path = '{dataDir}/server.ini'))).toEqual(expect.arrayContaining(["config file server can't use {dataDir} here"]));
    expect(broken((m) => (m.launch.env = { 'bad-key': 'x' }))).toEqual(['launch.env.bad-key is not an environment variable name']);
    expect(broken((m) => (m.launch.env = { '1ST': 'x' }))).toEqual(['launch.env.1ST is not an environment variable name']);
    // Names in the case a game reads them: Steam's own is SteamAppId.
    const mixed = avorionJson() as Json;
    mixed.launch.env = { SteamAppId: '1', LD_LIBRARY_PATH: '{installDir}/linux64' };
    expect(loadManifest(mixed).launch.env).toEqual({ SteamAppId: '1', LD_LIBRARY_PATH: '{installDir}/linux64' });
  });

  it('control: console lines need a console, behind its prefix; a save before a copy needs a save command', () => {
    expect(broken((m) => (m.moderation.kick = '/kick'))).toEqual(['moderation.kick must hold {arg} once']);
    expect(broken((m) => (m.broadcast = 'say {arg}'))).toEqual(['broadcast must start with the console\'s prefix /']);
    expect(broken((m) => delete m.save)).toEqual(['backups.running is save-then-copy, but the game has no save command']);
    expect(broken((m) => (m.backups.running = 'copy-between-saves'))).toEqual(["backups.running is copy-between-saves, but the game's autosave lines aren't declared"]);
    const none = broken((m) => (m.console = { kind: 'none' }));
    expect(none).toEqual(expect.arrayContaining(['stop.command needs a console on stdin', 'save.command needs a console on stdin', 'broadcast needs a console on stdin', 'moderation.ban needs a console on stdin']));
  });

  it('resets, config files, players and moderation name what exists', () => {
    expect(broken((m) => (m.resets[0].removeParts = ['world']))).toEqual(["reset factory removes world, which isn't a backup part"]);
    expect(broken((m) => (m.resets[0].permission = 'reset.everything'))).toEqual(['reset factory asks for an unknown permission reset.everything']);
    expect(broken((m) => (m.config.files[2].managed = { a: 'b' }))).toEqual(['config file blacklist is lines: it has no keys to manage']);
    expect(broken((m) => (m.config.files[0].restartKeys = ['port']))).toEqual([expect.stringMatching(/^config file server is edited only while stopped/)]);
    expect(broken((m) => delete m.players.leave)).toEqual(['players needs both join and leave lines, or neither']);
    expect(broken((m) => (m.players.steamQuery = { port: 'nope' }))).toEqual(["players.steamQuery.port names the port nope, which isn't declared"]);
    expect(broken((m) => (m.moderation.listFiles = { ban: 'admins', target: 'steamId', stoppedOnly: false }))).toEqual(
      expect.arrayContaining(["moderation.listFiles.ban names admins, which isn't a list (format \"lines\")", 'moderation bans either on the console or in a list file, not both']),
    );
  });

  it('joining (SRV-08): a port players can be given, settings and secret keys that exist, a default port only with host:port', () => {
    expect(broken((m) => (m.join.port = 'nope'))).toEqual(["join.port names the port nope, which isn't declared"]);
    expect(broken((m) => (m.join.port = 'gametcp'))).toEqual(["join.port names gametcp, which players can't be given (published, following no other)"]);
    expect(broken((m) => (m.join.port = 'steammaster'))).toEqual(["join.port names steammaster, which players can't be given (published, following no other)"]);
    expect(broken((m) => Object.assign(m.join, { format: 'separate', defaultPort: 27000 }))).toEqual(['join.defaultPort is for the host:port format only']);
    expect(broken((m) => (m.join.password = { file: 'server', key: 'name' }))).toEqual(["join.password names server name, which isn't one of its secret keys"]);
    expect(broken((m) => (m.join.password = { setting: 'serverName' }))).toEqual(["join.password names serverName, which isn't a secret setting"]);
    expect(broken((m) => (m.join.password = { file: 'nope', key: 'password' }))).toEqual(["join.password names the config file nope, which isn't declared"]);
    expect(broken((m) => (m.join.steps = [{ id: 'listed', text: m.name, when: { setting: 'listed', equals: 'yes' } }]))).toEqual(['join step listed compares listed with a string, not a boolean']);
    expect(broken((m) => (m.join.steps = [{ id: 'x', text: m.name, when: { setting: 'nope', equals: true } }]))).toEqual(expect.arrayContaining(["join step x names the setting nope, which isn't declared"]));
    expect(broken((m) => (m.join.steps = [{ id: 'x', text: m.name, when: { file: 'nope', key: 'k', equals: 1 } }]))).toEqual(["join step x names the config file nope, which isn't declared"]);
    expect(
      broken((m) =>
        (m.join.steps = [
          { id: 'x', text: m.name },
          { id: 'x', text: m.name },
        ]),
      ),
    ).toEqual(['join.steps has x twice']);
    expect(broken((m) => (m.join.format = 'ip:port'))).toEqual(['join.format must be one of "host:port", "separate"']);
    expect(broken((m) => delete m.join.verified)).toEqual(['join.verified is required']);
  });

  it('joining (SRV-08) reaches the adapter in the contract terms: a setting is a launch setting', () => {
    const m = avorionJson() as Json;
    m.join.steps = [
      { id: 'listed', text: m.name, when: { setting: 'listed', equals: true } },
      { id: 'pvp', text: m.name, when: { file: 'server', key: 'pvp', equals: 'true' } },
    ];
    m.id = 'avorion-join';
    const meta = manifestMeta(loadManifest(m));
    expect(meta.join).toEqual({
      port: 'game',
      format: 'host:port',
      where: m.join.where,
      client: m.join.client,
      steps: [
        { id: 'listed', text: m.name, when: { launch: 'listed', equals: true } },
        { id: 'pvp', text: m.name, when: { file: 'server', key: 'pvp', equals: 'true' } },
      ],
      password: { file: 'server', key: 'password' },
      verified: false,
      source: m.join.source,
      note: m.join.note,
    });
  });
});
