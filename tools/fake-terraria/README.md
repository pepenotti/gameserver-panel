# fake-terraria

Stand-ins for a Terraria dedicated server and its download services, for agent and panel tests
and the dev loop without the game, Mono, .NET or the internet (NFR-07). They behave as the M5
fact-finding measured vanilla 1.4.5.8, TShock 6.2.1 and tModLoader v2026.07.3.0
(`docs/verification/terraria-1.4.5.8.md`, `fixtures/terraria/1.4.5.8/`), and they are a separate
implementation from the adapter on purpose. `fake-terraria.test.ts` checks the line patterns the
adapter will use against the real captures and against the fakes.

| File | Stands in for |
|---|---|
| `server.mjs` | the game binary: vanilla's `TerrariaServer.bin.x86_64`, `TShock.Server`, or `dotnet tModLoader.dll` (the launcher replaces `dotnet`; a leading `*.dll` argument is skipped) |
| `downloads.mjs` | terraria.org (`/api/get/dedicated-servers-names`, `/api/download/pc-dedicated-server/terraria-server-<id>.zip`) and GitHub (`/repos/<owner>/<repo>/releases[/latest\|/tags/<tag>]`, release assets) |
| `steamcmd.mjs` | steamcmd for tModLoader: `app_update 1281930` (anonymous: "Success!" and no files, as measured), `app_info_print`, `workshop_download_item 1281930 <id>` |

`tools/fake-orchestrator/fake-game.mjs` picks `server.mjs` and `steamcmd.mjs` with
`GAME_ADAPTER=terraria`.

## server.mjs
Takes the adapter's own arguments (`-port`, `-maxplayers`, `-world`, `-autocreate 1|2|3`,
`-worldname`, `-savedirectory`, `-banlist`, `-config`, `-password`, `-motd`, `-seed`; TShock's
`-configpath`, `-logpath`, `--rest-enabled`, `--rest-port`, `--rest-token`; tModLoader's `-server`,
`-nosteam`, `-tmlsavedirectory`, `-steamworkshopfolder`). The flavour comes from
`FAKE_TERRARIA_FLAVOUR`, else `GAME_FLAVOUR`, else the arguments.

What it reproduces, per the measurements:
- the lines: vanilla's two byte-order marks, the `: ` prompt printed without a newline (so lines
  after a command start with `: `), `Listening on port <n>`, `Server started`, `<name> has joined.`
  (TShock adds `<name> has joined. IP: <ip>`), `<name> has left.`, the save lines ending in
  `Backing up world file` (tModLoader: `Saving modded world data`), the world menu when no world is
  given (`n\t\tNew World`, then `Choose World: ` without a newline), `Load failed!  No backup found.`
  for a world file it didn't write, a silent exit 0 for a missing world without `-autocreate` and
  for a taken game port (`FAKE_TERRARIA_BIND_GAME_PORT=1`);
- the console: vanilla's commands (`help`, `playing`, `kick`, `ban` into `-banlist` or `Invalid
  command.` without one, `save`, `exit`, `exit-nosave`, `password` in clear text, …), TShock's
  (`Server executed: /<cmd>.` echoes, `who`, `kick`, `ban add|list|del|details`, `save`, `off`),
  tModLoader's extra `modlist`; lines typed before the server is ready wait for it; the end of
  stdin changes nothing;
- the files: the world written in place, then the previous save moved to `.bak` (and `.bak` to
  `.bak2`); `favorites.json`; tModLoader's world in `<save dir>/Worlds` with its `.twld`, its logs
  in `<working dir>/tModLoader-Logs`, Workshop mods from `-steamworkshopfolder` listed in
  `Mods/enabled.json`; TShock's `config.json` completed with its 145 defaults and stripped of
  unknown keys (no final newline), `setup-code.txt` unless `setup.lock` exists or an account does,
  `ServerLog.txt` in the working directory, users and bans in a real SQLite `tshock.sqlite`;
- TShock's REST API (when `RestApiEnabled` or `--rest-enabled true`): anonymous `/status` and
  `/v2/server/status`, application tokens from `ApplicationRestTokens` (or `--rest-token`), players
  list and read, kick, bans (`/v3/bans/create` answers 500 while players are online but stores the
  ban, as measured; `ticketNumber` parameters), broadcast, `rawcmd` (needs the `/`), world save,
  users and groups, `/v2/server/off?confirm=true`; `LogRest` lines without the token;
- signals: SIGTERM exits 143 without saving (vanilla, TShock); tModLoader saves and exits 0.

Scenarios (`FAKE_TERRARIA_SCENARIO`): `normal`, `crash-after-ready` (the unhandled exception
measured after a burst of reconnects, exit 1), `crash-on-boot` (the world fails to load, exit 0),
`blocking-prompt` (the world menu), `never-ready`, `ignore-stop` (`exit`/`off` acknowledged, then
nothing). Tuning: `FAKE_TERRARIA_BOOT_MS` (300), `FAKE_TERRARIA_CRASH_MS` (500),
`FAKE_TERRARIA_PLAYERS` (`a,b`: online at boot, from `192.0.2.1` like every client behind Docker
Desktop's port publishing), `FAKE_TERRARIA_BIND_HOST` (127.0.0.1). Test hooks on stdin:
`fake-join <name>`, `fake-leave <name>`, `fake-crash`.

Not modelled: world generation's 30 000 progress lines (a few samples only), the language setting
(`language=es-ES` translates every console line, commands included: the adapter pins English),
TShock's own timed backups and plugins, tModLoader's multiplayer handshake and ModConfigs.

## downloads.mjs
`node downloads.mjs [--port N]` or `startFakeDownloads({ port, fail })`. The archives are tiny real
zips laid out like the real ones: `terraria-server-<id>.zip` with `<id>/Linux/…` and no Unix modes
(nothing executable), TShock's zip holding one tar that keeps `TShock.Server`'s exec bit, and
`tModLoader.zip` with its files at the top. GitHub assets carry `digest: sha256:…` that matches;
terraria.org publishes no checksum. Every GitHub API call counts against 60 an hour, including a
conditional one answered 304 (measured anonymously); `GET /__requests` lists what was asked.
Failures (`FAKE_TERRARIA_DOWNLOAD_FAIL` or `fail`): `bad-checksum` (digests don't match; terraria.org
zips come truncated), `not-found`, `rate-limit` (GitHub's documented 403, not captured).

## steamcmd.mjs
`FAKE_TML_STEAM_OWNED=1` makes `app_update` install a stub (an account owning Terraria);
`FAKE_TML_MOD_NAMES=<id>=<Name>,…` names the `.tmod` files; `FAKE_STEAMCMD_FAIL` = `disk` |
`timeout` | `missing-item`.

## Where it runs
`fake-game.mjs` finds these by adapter id. Both fake runtime images copy this folder (target `fake`
of `docker/native`, where vanilla and TShock run, and of `docker/steam`, where tModLoader runs);
`docker/steam`'s fake target runs `fake-game.mjs steamcmd` for every adapter, so tModLoader's
Workshop downloads reach `steamcmd.mjs` there. The agent's runtime contract test
(`packages/agent/test/runtime-contract.test.ts`) runs the adapter against `server.mjs` and
`downloads.mjs` for each flavour, and the adapter's own tests do too (`packages/adapter-terraria/test`).
