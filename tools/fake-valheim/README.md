# fake-valheim

Stand-ins for the Valheim dedicated server and steamcmd's view of it, for agent and panel tests and
the dev loop without the 2 GB download, Unity or Steam (NFR-07). They behave as the M6 fact-finding
measured Valheim 1.0.16 (Steam build 25527701; `docs/verification/valheim-1.0.16.md`,
`fixtures/valheim/1.0.16/`), and they are a separate implementation from any adapter on purpose.
`fake-valheim.test.ts` checks the line patterns an adapter will use against the real captures and
against the fakes.

| File | Stands in for |
|---|---|
| `server.mjs` | `valheim_server.x86_64`, with the adapter's own arguments |
| `steamcmd.mjs` | steamcmd for app 896660: `app_update` (public and the listed branches), `app_info_print` |

`tools/fake-orchestrator/fake-game.mjs` finds both by adapter id (`GAME_ADAPTER=valheim`); the
`fake` target of `docker/steam` must copy this folder for the fake runtime image to have them (see
the integrator notes in the M6 hand-off).

## server.mjs
Takes `-nographics -batchmode -name -port -world -password -public 0|1 -savedir -saveinterval
-backups -backupshort -backuplong -crossplay -preset -modifier <key> <value> -logfile`.

What it reproduces, per the measurements:
- the lines: Unity's first lines, then Valheim's own with their `MM/DD/YYYY HH:MM:SS: ` stamp;
  `Valheim version: l-1.0.16 (network version 40)`; a new world's `Load world:` / `missing …` and
  a run of location lines while it generates; `ZNet.LoadWorld: <world> (<world>), save number <n>`
  for an existing one; the ready line `Opened Steam server` (`Opened PlayFab server` with
  `-crossplay`), after `Registering lobby`, and `Game server connected`;
- saves: every `-saveinterval` seconds (scaled by `FAKE_VALHEIM_SAVE_MS_PER_S`) and on SIGINT or
  SIGTERM, the five `World save (n/5)` lines and a numbered set in
  `<savedir>/worlds_local/<world>/` written in the measured order (`00_00__0_<n>.chunk`,
  `_main.<n>.chunks`, `.db2`, `.fwl2`, then the `.ok` marker), the previous set removed after the
  marker; `Skipping backup. World session not long enough.` every time (the game's own backups
  never happened in the fact-finding's sessions);
- files: `adminlist.txt`, `bannedlist.txt`, `permittedlist.txt` with their one comment line when
  missing (never rewritten after that), `_main.0.fwl2` as soon as a new world is created;
- password rules, only for `-public 1`: shorter than 5 characters (or none) prints
  `Error bad password:The password is too short`, a password inside the server name
  `Error bad password:Invalid password`; either way exit 0 without the ready line, leaving
  `worlds_local/DevWorld/_main.0.fwl2` behind, as measured; a private server takes any password;
- sockets (UDP, on `FAKE_VALHEIM_BIND_HOST`): the query port is the game port + 1 and is bound
  first; a taken one prints the `CreateBoundSocket …`, `GameServer.Init() failed.` and
  `Awake of network backend failed` lines and exits 0; a taken game port is silent (the ready line
  still shows, and the stop has no `Stopping listening socket`); with `-crossplay` nothing is bound
  on the game port;
- Steam queries on the query port, only for `-public 1`: A2S_INFO (name, `valheim`, players,
  10 slots, `version 1.0.0.0`, keywords `g=1.0.16,n=40,m=`, the game port) and A2S_PLAYER (the
  count, names empty) answered at once, A2S_RULES never;
- crossplay: without PlayFab's libraries (the product image's case) `DllNotFoundException:
  libParty.so` and no join code; with `FAKE_VALHEIM_CROSSPLAY_LIBS=1`
  `Session "<name>" registered with join code 123456`;
- `-logfile <file>`: after `Setting -logfile to: …` every line goes to the file, none to stdout;
- `-preset` and `-modifier` print `Setting world modifier preset: …` / `Setting world modifier:
  <key>-><value>` and land in the world's `.fwl2`;
- stdin: ignored without a word (the real server reads nothing there);
- signals: SIGINT and SIGTERM save and exit 0.

Scenarios (`FAKE_VALHEIM_SCENARIO`): `normal`, `crash-after-ready` (the measured torn-world load:
the fatal lines, the ready line anyway, `World db couldn't load correctly, saving has been
disabled …`, then a quit with `Skipping world save`, exit 0; a world whose `.db2` the fake didn't
write does the same), `crash-on-boot` (the query socket can't be bound, exit 0), `never-ready` (the
unwritable save folder: `IOException: Read-only file system`, then nothing; also when `-savedir`
really can't be written), `ignore-stop` (SIGINT and SIGTERM do nothing). Tuning:
`FAKE_VALHEIM_BOOT_MS` (300), `FAKE_VALHEIM_GEN_MS` (200), `FAKE_VALHEIM_STOP_MS` (200).

Test hooks on stdin (not real commands): `fake-join <steamid>` prints `Got connection SteamID
<id>`, then `Got handshake from client <id>` and `Server: New peer connected,sending global keys`
(or, for a SteamID in `bannedlist.txt` or missing from a non-empty `permittedlist.txt`,
`Peer <id> is blacklisted or not in whitelist.` and `Closing socket <id>`); `fake-leave
<steamid>` prints `Closing socket <id>`; `fake-crash` exits 3. **These player lines come from the
game's own strings, not from a capture: no client joined in the fact-finding.**

Not modelled: the game's own timed backups (`_backup_auto-…`), PlayFab's relay, Unity's other
warnings, the CPU it burns idle (a third of a core), the in-game admin console.

## steamcmd.mjs
`+force_install_dir`, `+login anonymous`, `+app_update 896660 [-beta <branch>] [validate]`
(writes `steamapps/appmanifest_896660.acf` with the branch's build id and `BetaKey`, a stub
`valheim_server.x86_64`), `+app_info_print 896660` (the public branches and build ids measured:
`public` 25527701, `default_old` 25390671, `default_pre1_0` …, `privatebranches 1`). Failures:
`FAKE_STEAMCMD_FAIL` = `missing-config` (`ERROR! Failed to install app '896660' (Missing
configuration)`, what a fresh steamcmd answered once in the fact-finding) | `disk` | `timeout`;
`FAKE_BUILDID` overrides the public build id.

## Signals on Windows
Windows can't deliver SIGINT or SIGTERM to a child that handles them, so the signal test skips
there. It was run by hand in the product's `gsp/steam` image (Node 24, Linux): SIGINT and SIGTERM
saved and exited 0, `ignore-stop` kept running.
