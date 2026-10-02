# Adding a Steam game with a manifest

A simple Steam game needs no adapter code: one JSON file describes it, and the manifest engine
(`packages/adapter-manifest`) turns it into an adapter of its own id, both halves (PRD §10
"Declarative adapters", D4, G4). Avorion was the first (`manifests/avorion.json`); Valheim is a
manifest plus two code hooks (`packages/adapter-valheim`, see "Example: a manifest plus hooks").

## When a manifest is enough

PRD §7 "Steam manifests": the game installs anonymously with steamcmd, runs in the `steam` image
as it is (no extra packages, no wrapper script), says when it is ready in a line it prints, and
stops cleanly with a console command or a signal. Measure it first (D5): a
`docs/verification/<game>-<build>.md`, captures in `fixtures/<game>/<build>/` and a fake in
`tools/fake-<id>/`. Everything a manifest says should be in those notes.

## The files

| File | What |
|---|---|
| `packages/adapter-manifest/manifests/<id>.json` | The manifest. `"$schema": "../manifest.schema.json"` gives editors completion. |
| `packages/adapter-manifest/manifest.schema.json` | The format (JSON Schema draft 2020-12). |
| `packages/adapter-manifest/src/shared/index.ts` | Loads each manifest (`loadManifest`), so it is checked when imported; add yours to `MANIFESTS`. |
| `packages/adapters/src/{runtime,panel}.ts` | One entry each: `manifestRuntimeAdapter(M)` and `manifestPanelAdapter(M)`, disabled until measured. |
| `tools/fake-<id>/{server,steamcmd}.mjs` | The fake game and steamcmd the tests, the dev loop and the fake image run (`GAME_ADAPTER=<id>`). |
| `docker/steam/Dockerfile` | The `fake` target copies `tools/fake-<id>/`. |
| `docs/limitations.md` | What people will notice (UX-04); the manifest's `notes` point at its section. |

`loadManifest` refuses a manifest with every problem listed: the schema first (types, ids,
patterns that must compile), then what a schema can't say (ids that must exist and be unique,
ports, defaults that fit their settings, placeholders allowed where they are used, console lines
only with a console). `packages/adapter-manifest/test/schema.test.ts` loads every file in
`manifests/`.

## The format

| Field | What it says |
|---|---|
| `id`, `name` | The adapter id servers store, and the game's name in English and Spanish. |
| `steam` | `appId` (anonymous install), `defaultBranch` (`public`), `branches`: `"listed"` (whatever Steam lists) or a fixed list. |
| `arch` | `["amd64"]`: steamcmd games are x86-64 only (HST-05). |
| `eula` | Only when the game has a license to accept (D6). |
| `memory` | `minMb`, `defaultMb` (multiples of 256) and `overheadMb`: the container gets the game's memory (a launch setting) plus the overhead (SRV-05). |
| `ports` | `id` (lowercase letters and digits), `proto` (`udp`/`tcp`), `default`, `publish`, `sameInsideOut` (the game tells Steam or clients its number), `label`. A port on both protocols is two ports, the second `follows` the first at offset 0; a port the game derives (Valheim's query port, game + 1) `follows` its base at its offset and is never asked for. |
| `settings` | The launch settings people choose (see below). |
| `secrets` | Secrets the panel generates and keeps (`{secret:<id>}`), never shown. |
| `launch` | `executable` (`{installDir}/…`), `args` (strings, or `{ "if": <condition>, "args": [...] }`), `cwd`, `env`. |
| `prepare.dirs` | Data folders made before every start (the game expects them). |
| `log` | `stripAnsi`, `strip` (a prefix such as a timestamp, taken off before matching and in the live log), `progress` runs (CON-01). |
| `readiness` | `ready`, `version` (group 1), `fatal` lines (SRV-07), `warnings` (said once in the log). |
| `console` | `{ "kind": "stdin", "prefix": "/", "commands": [...] }` or `{ "kind": "none" }`. The prefix is added to what people type (the panel strips a leading `/`). `commands` is the console's catalogue (names without the prefix). |
| `stop` | `command` (sent once the game reads its console), else `signal`; `budgetMs` before the agent escalates (NFR-04). |
| `save` | `command`, its `done` line and `budgetMs`: the `save` capability and `save-then-copy`. |
| `autosave` | `start` and `done` lines of the game's own saves, for `copy-between-saves`. |
| `backups` | `parts` (data paths, `{name}` only) and `running` (below). |
| `resets` | Scopes: `permission` (`reset.world`, `reset.full`, `reset.factory`) and the parts they remove. |
| `config` | `files` (below) and `roots`: folders the text editor may browse, with globs. |
| `players` | `join`/`leave` lines (group 1), `list` (a console command, its count line, an `item` pattern), `steamQuery` (needs a hook). |
| `moderation` | `kick`/`ban`/`unban` console templates (`{arg}`), `banTargets`, `refusals` (reply patterns and what they mean, PLY-03), or `listFiles` (ban, allow and admin lists edited through the panel). |
| `broadcast` | A console template (`/say {arg}`): the in-game countdowns and messages (CON-03). |
| `notes` | What people should know, EN/ES, each with its `limitations.md#…` entry; shown on the create form and the server's pages. |
| `join` | How players join (SRV-08), for every server's connection info: the `port` they type (published, following no other), the `format` (`host:port`, or `separate` fields; `defaultPort` when the client assumes one), `where` in the game it is typed, the `client` and whether it must match the server's version (`sameVersion`), `steps` (each shown while a `setting` or a config `file`'s `key` `equals` a value), the `password` (a secret setting, or a secret key of a config file), and `verified` with its `source`: true only when a real client joined that way (D5); a `note` says what isn't measured yet. |

### Placeholders

`{installDir}` `{dataDir}` (absolute, in the container), `{name}` (the server's game name, used
for its files), `{port:<id>}`, `{setting:<id>}` (a boolean as its `onValue`/`offValue`, else
`true`/`false`; also `memoryMb` and `branch`), `{secret:<id>}`, and `{arg}` in console templates
only. A template can't hold a literal brace.

| Where | Allowed |
|---|---|
| `launch.*`, `config.files[].managed`, `config.files[].seed` | everything but `{arg}` |
| `config.files[].path`, `config.roots[].path`, `backups.parts[].paths`, `prepare.dirs` | `{name}` only, and the path must stay inside the data folder |
| `moderation.kick/ban/unban`, `broadcast` | `{arg}` once, behind the console's prefix |
| `stop.command`, `save.command`, `players.list.command` | none |

### Launch settings

Every manifest game has three settings of its own: `branch` (UPD-02), `updateOnStart` (UPD-03)
and `memoryMb`. The manifest adds its own: `string`, `secret` (hidden once saved; empty means
none), `integer` (`min`, `max`, `step`, `unit`), `boolean` (`onValue`, `offValue`) or `enum`
(`choices`), each with `label`, `description` (EN/ES), a `default` and `advanced`. Strings take
`minLength`, `maxLength` and `pattern`. `rules` check across settings, in order, with their own
EN/ES message: `{ "if": { "setting": "public", "equals": true }, "minLength": 5, "message": … }`,
`required`, or `notIn: "<another text setting>"` (the value can't be part of it, case ignored).
The panel checks them before it saves (the web shows the message next to the setting) and the
agent checks them again before a start.

### Running backups (BAK-02)

| `running` | What a backup of a running server does |
|---|---|
| `save-then-copy` | Sends `save.command`, waits for `save.done`, then copies. |
| `copy-between-saves` | The game can't be asked to save: waits out an autosave in progress (`autosave.start` … `done`), copies, and fails the backup if one started meanwhile. With a `hotCopySelect` hook it does neither: the hook picks files no save in progress touches (Valheim's newest complete save). |
| `stopped-only` | No running backup: the panel refuses one while the game runs. |

### Config files (CFG-02…09)

`files[]`: `id`, `label`, `path`, `format` (`ini`, `properties`, `json`, `json5`, `yaml`, `toml`,
`lines`, `text`), `managed` keys (set by the agent before every start, locked in the editor;
values without placeholders the panel also re-applies on save), `secretKeys` (masked), `stoppedOnly`
(the game writes the file back from memory: edited only while stopped, and `restartKeys` must be
`"*"`), `restartKeys`, `seed` (written when the file is missing, before a start: the game completes
it), `note`. There are no forms for manifest games' files: they are edited as text (PRD §7).

## What needs a hook

`manifestRuntimeAdapter(m, hooks)` and `manifestPanelAdapter(m, hooks)` take `ManifestHooks`:

- `hotCopySelect(ctx, files)`: narrows a running backup to a consistent set (Valheim's newest
  complete save set). The agent hard-links the picks before sending anything and asks again,
  once, when a pick vanished (`RuntimeAdapter.hotCopy.select`).
- `steamQuery(ctx, port)`: players from Steam's server queries, while `players.steamQuery.when`
  holds; without it the join and leave lines count.
- `runtime(adapter)`, `panel(adapter)`: change or complete either half; keep its `meta`.

Anything else a game needs (a launch wrapper, packages in the image, a token to run) means it is
not a manifest game: give it an adapter package.

### Example: a manifest plus hooks (Valheim)

A game with hooks is a small package of its own, `packages/adapter-<id>`, that holds its manifest
and its code; the adapter list takes its two halves like any adapter's:

| File | What |
|---|---|
| `manifest/valheim.json` | The manifest (`"$schema": "../../adapter-manifest/manifest.schema.json"`). |
| `src/shared/meta.ts` | `VALHEIM = loadManifest(json)` (checked when imported) and `VALHEIM_META = manifestMeta(VALHEIM)`: one meta for both halves. |
| `src/runtime/index.ts` | `manifestRuntimeAdapter(VALHEIM, { hotCopySelect, steamQuery })`. |
| `src/panel/index.ts` | `manifestPanelAdapter(VALHEIM)`: the panel half needs no hook. |
| `src/runtime/save-sets.ts` | The selection: each world's newest complete save set (the `.ok` marker, its `.db2` and `.fwl2`), the chunk files it uses (each chunk's newest file written before that marker: chunk files carry their own versions), and every file outside the worlds. |
| `src/runtime/a2s.ts` | A small A2S_INFO client (UDP, Valve's challenge step included) for the player count. |

```ts
export const valheimRuntimeAdapter = manifestRuntimeAdapter(VALHEIM, {
  // BAK-02: copy only what a save in progress can't touch (the hook may look at the files: ctx.roots.data).
  hotCopySelect: async (ctx, files) => newestCompleteSaves(files, writtenAt(ctx)),
  // PLY-01: called while players.steamQuery.when holds (`public` is on), on the port it names.
  steamQuery: async (_ctx, port) => ({ count: (await queryInfo('127.0.0.1', port)).players, names: [] }),
});
```

What stays in the manifest is everything else Valheim does: a launch argument only when its setting
says so (`{ "if": { "setting": "password", "notEmpty": true }, "args": ["-password",
"{setting:password}"] }`, `-crossplay` only when on), a rule across settings refused before a start
in both languages (a listed server's password: `minLength` 5, `notIn` the server name), a port
that follows another (`query` at `game` + 1), a stop by signal with no console, its autosave
lines for `copy-between-saves`, list files for moderation by SteamID while stopped, and its
notes. A hook is tested on its own (`test/save-sets.test.ts`, `test/a2s.test.ts`) and through the
same suites and end-to-end test as a manifest game (`packages/panel/test/valheim-e2e.test.ts`).

## Testing it

1. Captures and a fake: `tools/fake-<id>/` reproduces what was measured (lines, console, saves,
   files, signals), checked against the captures by its own test.
2. The package's tests: `runtimeAdapterSuite` with the captured boot and fatal lines,
   `panelAdapterCoreSuite` and `panelAdapterConfigSuite` with the files the real server wrote
   (see `packages/adapter-manifest/test/contract.test.ts`).
3. Live against the fake through the agent's own plumbing: one `runtimeAdapterSuite` entry in
   `packages/agent/test/runtime-contract.test.ts`.
4. End to end through the panel and the fake orchestrator: create, start, save, hot backup,
   restore, reset, stop (`packages/panel/test/avorion-e2e.test.ts`).
5. The real game once (D5): build the steam image, run one server in a hardened container, drive
   its agent's HTTP API, and record it in the game's verification document.
