# fake-avorion

Stand-ins for the Avorion dedicated server and steamcmd's view of it, the game the M6
fact-finding picked to prove the manifest-only path (PRD M6, G4). They behave as Avorion 2.5.13
(Steam build 22295362) was measured (`docs/verification/avorion-2.5.13.md`,
`fixtures/avorion/2.5.13/`), and they are a separate implementation from any adapter on purpose.
`fake-avorion.test.ts` checks the line patterns a manifest will use against the real captures and
against the fakes.

| File | Stands in for |
|---|---|
| `server.mjs` | `bin/AvorionServer`, with the manifest's arguments |
| `steamcmd.mjs` | steamcmd for app 565060: `app_update` (public and listed branches), `app_info_print` |

`tools/fake-orchestrator/fake-game.mjs` finds both by adapter id when a manifest game's adapter id
is `avorion` (`GAME_ADAPTER=avorion`); the `fake` target of `docker/steam` must copy this folder
(see the M6 hand-off).

## server.mjs
Takes `--galaxy-name --datapath --server-name --port --query-port --steam-query-port
--steam-master-port --max-players --save-interval --send-crash-reports --listed --multiplayer
--use-steam-networking --admin --seed --difficulty --rcon-password --rcon-port`.

What it reproduces, per the measurements:
- the lines: the banner (`Avorion server 2.5.13 0417ab29738c running on …`, the public version
  `2.5.13.44140`), Steam's (`Server connected to Steam successfully`, the four ports), the
  warning a query port other than 27003 prints on a server that isn't listed (`WARNING: Query
  port change detected …`, measured in the manifest adapter check), the settings it runs with
  (`send crash reports: no` when told), `Server startup complete.` as the ready line;
- the console (stdin): every line must start with `/` (`Invalid command formatting. …`
  otherwise); `/help` (the list as captured), `/version`, `/seed`, `/players` (`online players
  (<n>):`), `/status`, `/say <text>` (`<Server> <text> `), `/kick` and `/ban` of someone offline
  (`Player <n> is not online.`, `Player <n> not found.`), `/banip <address>` (`Player <address> not
  found`, the measured quirk), `/unbanip` (`Ip <address> was not blacklisted`), `/whitelist` and
  `/admin` usage, unknown commands (`Unknown command: "<cmd>". To see all available commands type
  "/help"`); lines typed before the ready line wait for it;
- saving: `/save` prints `Saving all server data.`, then `Triggered saving of all server data.`
  and `All sectors saved successfully.` once the files are written; autosaves every
  `--save-interval` seconds (scaled by `FAKE_AVORION_INTERVAL_MS_PER_S`) print nothing; the
  numbered copies rotate (`server.dat.0-2`, `sectors/meta.db.0-2`);
- `/stop`, SIGINT and SIGTERM: the shutdown lines (they save), `Server shutdown successful.`, exit 0;
- `server.ini` in the galaxy folder, held in memory: read at start keeping the values of the keys
  the game knows and dropping unknown keys and comments, command-line values written into it, and
  written back at start, at every save and at the stop, so an edit made while it runs is lost
  (measured); `admin.xml` (`--admin` SteamIDs added), the empty `whitelist.txt`,
  `group-whitelist.txt`, `blacklist.txt`, `ipblacklist.txt`, a `serverlog <date>.txt` with
  everything printed, a `server-stats <date>.csv`;
- sockets (UDP, on `FAKE_AVORION_BIND_HOST`): the Steam query port (a taken one falls back to the
  deprecated TCP/UDP protocols with the measured warnings) and the internal query port, bound last
  (a taken one prints `Server startup FAILED.` and shuts down, exit 0); the game port isn't bound
  with Steam networking (measured);
- Steam queries on the Steam query port, only with `--listed true`: A2S_INFO (name, the seed as
  map, `avorion`, `Avorion`, players, slots, VAC, `2.5.13.44140`, the game port, keyword `Normal`,
  game id 445220), A2S_PLAYER, A2S_RULES (the nine rules seen), answered at once.

Scenarios (`FAKE_AVORION_SCENARIO`): `normal`, `crash-after-ready` (an exception line and exit 1
after `FAKE_AVORION_CRASH_MS`; **not measured**: no crash was seen), `crash-on-boot` (the measured
unwritable galaxy: `An exception occurred: … server.ini: cannot open file`, exit 0),
`never-ready` (`Server failed to connect to Steam` forever; the real server gave up after 30 s
and came up on the fallback protocols), `ignore-stop`. `FAKE_AVORION_INSTALL_DIR`, when set,
makes a start from another working directory fail as measured (the game's scripts are found
relative to it). Tuning: `FAKE_AVORION_BOOT_MS` (300), `FAKE_AVORION_SAVE_MS` (100).

Test hooks on stdin (not real commands, taken with or without a leading `/`, which the panel's
console adds to every line for Avorion): `fake-join <name>` prints `Player logged in: <name>,
index: <n>` (`Connection refused: Player <name> is banned.` for a name in `blacklist.txt`),
`fake-leave <name>` prints `Player logged off: <name>`, `fake-crash` exits 3; `/kick` and `/ban`
of a joined name then work. **These player lines, and what `/players`, `/kick`, `/ban` print with
someone online, come from the game's strings, not from a capture: no client joined.**

Not modelled: RCON, the hourly backups, the fallback protocols' sockets, sectors and players'
data, mods, the game's commented `server.ini - readme.txt` (the fake writes a stub).

## steamcmd.mjs
`+force_install_dir`, `+login anonymous`, `+app_update 565060 [-beta <branch>] [validate]` (the
app manifest with the branch's build id and `BetaKey`, stubs of `bin/AvorionServer`, `server.sh`,
`steam_appid.txt`, `data/scripts/server/server.lua`), `+app_info_print 565060` (`public`
22295362, `beta`, `previous`, some version branches, as measured). Failures: `FAKE_STEAMCMD_FAIL` =
`missing-config` (measured on a fresh steamcmd's first install) | `disk` | `timeout`.

## Signals on Windows
The signal test skips on Windows; it was run by hand in the product's `gsp/steam` image (Node 24,
Linux): SIGINT and SIGTERM saved and exited 0, `ignore-stop` kept running.
