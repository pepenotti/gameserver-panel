# Avorion 2.5.13 verification log

The second Steam game for M6 ("a second Steam game is added **with a manifest only**, and it
boots, stops and backs up"), picked from measured candidates and then measured like Valheim (D5).
Captures live in `fixtures/avorion/2.5.13/` (its README describes the layout and the scrubbing);
the fake built from them is in `tools/fake-avorion/`. Setup, harness and container shape are the
ones in `valheim-1.0.16.md` (the product's `gsp/steam` image, nothing added; read-only root and
install; one server at a time).

## M6 fact-finding — 2026-10-01

### Choosing the game
Criteria (from the M6 brief): anonymous steamcmd download, a Linux x86-64 build, at most 3 GiB
idle, no account or token to run, a recognisable ready line, a stop that saves (a signal or a
console command), plain files for settings and saves; and, to stay manifest-only, nothing the
`gsp/steam` image lacks.

| Candidate (app) | Measured | Verdict |
|---|---|---|
| **Avorion** (565060) | Anonymous install, 191 MB, 33 s. `bin/AvorionServer` runs in `gsp/steam` as it is. Ready line `Server startup complete.` 3–4 s after start. 0.21 GiB idle. Console on stdin (`/save` with a "done" line, `/stop`), SIGINT and SIGTERM save. Settings in an INI file (`server.ini`), saves are files in one galaxy folder. | **Chosen.** |
| Necesse (1169370) | Anonymous install, 302 MB, ships its own Java runtime. Ready `Started server using port 14159 with 10 slots on world …` after 9 s. Console on stdin (`save`: `Completed world save`, `stop`: saves and exits 0), the world is one zip written through a temporary file and a rename. 0.67–1.06 GiB. Settings in `cfg/server.cfg`, Necesse's own `KEY = { a = b, … }` format with comments, and every line coloured with ANSI codes. | Good second choice; set aside for its config format (not one the panel's format registry knows, so text-only editing), its colour codes and 3–5 times the memory. |
| Core Keeper (1963720) | Anonymous install, 592 MB, Unity. Its own launch script installs `xvfb` and `libxi6` with `sudo apt-get` and runs the server under a virtual X display (its README: world generation uses the GPU, so no `-nographics`). Without a display, run as `CoreKeeperServer -batchmode -datapath … -logfile -`, it stopped after `Desktop is 0 x 0 @ 0 Hz` at 95 % of a core, printed nothing more for 4 minutes and **ignored SIGTERM** (SIGKILL needed). Players join by a "Game ID" through Steam. | Rejected: needs an X server in the image and a launch wrapper (code, not a manifest), and doesn't stop on a signal. |
| Barotrauma (1026340), Unturned (1110390), Stationeers (600760) | App info only (all free to download, Linux, 64-bit): Linux depots of 156 MB, 1.8 GB and 5.0 GB. | Not run, so not measured: expected from their documentation, Barotrauma saves a campaign only at the end of a round and keeps XML settings, Unturned keeps each server's data inside its install folder, and Stationeers is a 5 GB download. Two good candidates were already measured. |

**First install on a fresh steamcmd**: Avorion, Necesse and Core Keeper (each with a new, empty
steamcmd HOME volume) all failed their first `app_update` with `ERROR! Failed to install app
'<id>' (Missing configuration)` (exit 8) after 11–12 s, and installed on the second try, as Project
Zomboid's did in M13. The agent's driver already retries it.

**What ran.** Steam app **565060** ("Avorion Dedicated Server"), public branch **build
22295362**, which prints `Avorion server 2.5.13 0417ab29738c` and lists itself publicly as
`2.5.13.44140`.

**Licences.** None shown or needed: `freetodownload 1`, anonymous install, nothing asked at start.
The owner may want to confirm.

**Players.** No client joined (a client needs a Steam account that owns Avorion). The join and
leave lines were read from the server binary's strings and are marked **expected**.

### Headline findings
1. **A clean console.** stdin takes slash commands (`/save`, `/stop`, `/players`, `/kick`, `/ban`,
   `/say` …) and answers in the log; text without a slash is refused. `/save` ends with `All sectors
   saved successfully.`; `/stop` ends with `Server shutdown successful.` and exit 0 in about 2 s.
2. **SIGINT and SIGTERM save and exit 0** too (0.7 s), so a stop works even without the console.
3. **`server.ini` is the game's memory, written back** at start, at every save (including silent
   autosaves) and at the stop: an edit made while it runs is lost, unknown keys and comments are
   dropped, values given on the command line stay in the file afterwards. Edits made while it is
   stopped are kept.
4. **It sends crash reports by default** (`send crash reports: yes`, `sendCrashReports=true`):
   the manifest passes `--send-crash-reports false` (NFR-09).
5. **Its own backups go to HOME** (`~/.avorion/backups`, hourly, unless `backupsPath` says
   otherwise): outside the data volume; the manifest manages `backupsPath`.
6. **The working directory must be the install folder**: started from the data folder it couldn't
   initialise Steam and couldn't find its scripts (`An exception occurred: …`, exit 0).
7. **Steam networking binds no game port**: with the default Steam networking only the Steam
   query port (UDP 27020) and the internal query port (UDP 27003) were bound, not 27000.
8. **Failures exit 0**: taken ports (`Server startup FAILED.`), an unwritable galaxy, a wrong
   working directory. Without Steam it waits 30 s and then runs on the "deprecated, potentially
   unsafe" fallback protocols.
9. **Small and quiet**: 0.21 GiB idle, about 0.28 of a core, ready in 3–4 s, nothing printed while
   idle except its own logs and stats files.

### Install and versions (UPD-01, UPD-02)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Anonymous install | `app_update 565060 validate`: **191 405 119 bytes** on disk, 33 s (after the first try's `Missing configuration`). | `steamcmd/app-update-565060*.log` | build 22295362 |
| Depots | `565061` (shared content, 37 MB), `565063` (Linux, 43 MB), `1006` (Steamworks redistributable). | `app-info-565060.vdf` | 2026-10-01 |
| Branches | `public` 22295362; `beta` (the same build today, "Newest Changes & Experimental Features"); `previous` 21146556 ("Previous Build 2.5.11 - Will be disabled soon"); one branch per past version, `0.28.1` … `2.5.2`, each described; `privatebranches 1`. | `app_info_print 565060` | 2026-10-01 |
| Installed build | `appmanifest_565060.acf` `buildid`; the version from `Avorion server <x.y.z> <commit> running on …` or `/version` (`Server Version: 2.5.13 0417ab29738c`). | Files, logs | build 22295362 |
| Install tree | `bin/AvorionServer` (the server), `bin/ServerRunner` (a graphical launcher, not used: needs GL and SDL), `bin/libsteam_api.so`, `linux64/steamclient.so`, `data/` (scripts and game data), `server.sh`, `launcher.sh`, `steam_appid.txt` (`445220`, the game's app id). | `ls` | build 22295362 |
| Binary | x86-64 ELF; needs glibc, `libz` and its own `libsteam_api.so`; all present in `gsp/steam`. | `ldd` | build 22295362 |

### Launch
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| The maker's script | `server.sh` changes to its own folder, sets `LD_LIBRARY_PATH=<install>/linux64` and runs `./bin/AvorionServer --galaxy-name avorion_galaxy "$@"`. | Reading it | build 22295362 |
| Command used | `/opt/game/bin/AvorionServer --galaxy-name <g> --datapath /data --server-name <name> --port 27000 --send-crash-reports false [--listed true] [--save-interval s] [--max-players n]`, working directory **`/opt/game`**, env `LD_LIBRARY_PATH=/opt/game/linux64`. The galaxy lives in `<datapath>/<galaxy-name>/`. | Runs | build 22295362 |
| Flags | `--help` lists them (`logs/help.txt`): ports (`--port`, `--query-port` 27003, `--steam-query-port` 27020, `--steam-master-port` 27021), `--max-players`, `--save-interval`, `--server-name`, `--galaxy-name`, `--datapath`, `--admin <steamid>`, `--seed`, `--difficulty -3…3`, `--scenario normal\|creative`, `--multiplayer`, `--listed`, `--vac-secure`, `--use-steam-networking`, `--rcon-ip/-port/-password` (RCON is off without a password), `--send-crash-reports`, `--backup-file` (restore a backup into an empty folder), `--init-folders-only`, `--max-logs` (15). | `--help`, runs | build 22295362 |
| Wrong working directory | From `/data`: `SteamGameServer_Init call failed`, the fallback warning, then `An exception occurred: … expected table` and `include error: module 'generator' not found`, exit 0 in 0.9 s. | `fail-wrong-working-directory.log` | build 22295362 |
| Files a first boot writes | In `<datapath>/<galaxy>/`: `server.ini`, `server.ini - readme.txt` (the game's own commented copy, 124 lines), `admin.xml`, empty `whitelist.txt`, `group-whitelist.txt`, `blacklist.txt`, `ipblacklist.txt`, `server.dat.0`, `index`, `globals`, `galaxyscripts.dat`, `groups.dat`, `sectors/meta.db.0`, empty `alliances/ factions/ moddata/ players/`, `serverlog <date>.txt` (everything it prints), `server-stats <date>.csv` (periodic statistics, incl. online players). About 40 KB. In HOME: Steam's `config/config.vdf` and logs. Nothing in the install. | File watch, `find` | build 22295362 |
| Time to ready | 3.3 s first boot, 4.1 s with a galaxy (1.5 s of it Steam's logon); 32.7 s without network. | Timestamps | one amd64 host |
| Memory | **216–226 MiB** (cgroup) idle, peak 242 MiB; RSS 246–249 MB. | cgroup, `VmRSS` | a new galaxy, nobody online |
| CPU | About 0.28 of one core idle. | cgroup `cpu.stat` | same |

### Readiness and logs
| Line | Meaning |
|---|---|
| `Avorion server <version> <commit> running on <os> starting up in "<galaxy>"` | version |
| `Server startup complete.` | **ready** |
| `Server connected to Steam successfully`, `Game Port: …`, `Steam Port: …`, `Steam Query Port: …`, `Query Port: …` | Steam is up, the ports in use |
| `Saving all server data.` → `Triggered saving of all server data.` → `All sectors saved successfully.` | `/save` (2 s for a new galaxy) |
| `Server is shutting down.` … `Server shutdown successful.` | a stop that saved |
| `Server startup FAILED.` | fatal (after `ERROR accepting connections: bind: Address already in use …` on stderr) |
| `An exception occurred: …` | fatal at start (exit 0) |
| `Server failed to connect to Steam`, `Error while initializing Steam networking: No response from Steam Network after over 30 seconds`, `Error starting steam-based networking. Falling back to standard TCP/UDP protocols.` + `WARNING: The fallback TCP/UDP protocols are deprecated and potentially UNSAFE!` | no Steam: runs on the fallback |
| `online players (<n>):` | `/players` |
| `Player logged in: <name>, index: <n>`, `Player logged off: <name>` | join and leave (**expected**, from the binary's strings) |
| `Connection refused: Player <name> is banned.` / `… is not whitelisted.` / `Ip <ip> is banned.` | refused joins (expected) |

Noise: the start prints its settings (about 30 lines), Steam's `[S_API …]` lines on stderr; then
nothing while idle. The banner names the host's CPU model and memory size (scrub in fixtures).

### Control and stop
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Console | Lines on stdin must start with `/` (else `Invalid command formatting. Commands must begin with a '/' character.`); answers go to stdout. `/help` lists 47 commands. Unknown: `Unknown command: "<cmd>". To see all available commands type "/help"`. | `first-boot-console-then-stop.log`, `existing-moderation-commands-then-sigterm.log` | build 22295362 |
| Replies measured | `/version` → `Server Version: 2.5.13 0417ab29738c`; `/seed` → the seed; `/players` → `online players (0):`; `/say <t>` → `<Server> <t> `; `/kick <n>` (offline) → `Player <n> is not online.`; `/ban <n>` (unknown) → `Player <n> not found.`; `/unban` likewise; `/banip <ip>` → `Player <ip> not found` (it looks the address up as a player); `/unbanip <ip>` → `Ip <ip> was not blacklisted`; `/whitelist`, `/blacklist`, `/admin` → their option lists (`--id`, `--name`, `-a`, `-r`, `-c`, `-l`); `/status` → players, sectors, load, and `Wrote memory stats to "/opt/game/profiling_stats.txt"` (its working folder: read-only here, so the file was not written; the panel should keep `/status` out of its catalogue or accept that). | Same | build 22295362 |
| RCON | Off unless `--rcon-password` (or `rconPassword`) is set; then on TCP `rconPort` (27015). Not tried: stdin is enough for a manifest. | `--help`, the start line | build 22295362 |
| `/stop` | Saves (settings, factions, sectors, groups, scripts), `Server shutdown successful.`, exit **0** in 1.9 s. | Logs | build 22295362 |
| SIGINT / SIGTERM | The same shutdown, exit **0** in 0.8 s / 0.7 s. | `ini-edited-while-stopped-listed-then-sigint.log`, `existing-moderation-commands-then-sigterm.log` | build 22295362 |
| Stop budget | 30 s proposed (measured 2 s). | | |

### Settings: `server.ini` (CFG-01…09)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Format | INI with sections `[Game]`, `[System]`, `[Networking]`, `[Administration]`, `[Meta]`, `key=value`, no comments, LF; 119 keys. | `config/server.ini.*` | build 22295362 |
| Written by the game | At start, at every save (also the silent autosaves) and at the stop, from memory: edits made while it runs are lost (an edited `motd` was back to empty after `/save`); unknown keys and comments are dropped (also when edited while stopped); values edited while stopped are kept; command-line values are written in and stay (`--max-players 8` remained after later starts without it). | `tree/ini-edit-while-running.txt`, `config/server.ini.after-later-runs` | build 22295362 |
| The game's commented copy | `server.ini - readme.txt` repeats the keys with a comment each (the game's own words; not in the fixtures). Rewritten with the INI. | File | build 22295362 |
| Keys worth knowing | Secrets: `[Administration] password` (players' join password), `[Networking] rconPassword`. Managed: `port`, `isListed`, `sendCrashReports` (default **true**), `backups` (true) and `backupsPath` (empty = `~/.avorion/backups`), `saveInterval` (600), `name`, `maxPlayers`. Settings people change: `Seed`, `Difficulty`, `Scenario`, `motd`, `description`, `accessListMode` (`Blacklist`/`Whitelist`), `PlayerToPlayerDamage`, `CollisionDamage`, `pausable`. | Same | build 22295362 |
| Other files | `admin.xml` (XML: command groups and `<administrators>`), the four list files (one entry per line, empty here; the format of an entry with a player in it is unverified), `modconfig.lua` (read if present, not created). | Files | build 22295362 |

### Saving and backups (BAK-01, BAK-02)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| When it saves | `/save`, every `saveInterval` seconds (silently: the files change, nothing is printed; measured with 30), at the stop. | `tree/autosave-events.txt` | build 22295362 |
| How it writes | Small files through temporary names and renames (`index~`, `globals~`, `galaxyscripts.dat~`, `groups.dat~`), and rotating numbered copies (`server.dat.0-2`, `sectors/meta.db.0-2`): the previous good copy stays while a new one is written. | File watch | build 22295362 |
| Copy while running | Consistent right after `All sectors saved successfully.`: nothing else wrote until the next autosave or a sector unloading (no players: nothing). A copy that overlaps an autosave is expected to stay loadable thanks to the rotation, unverified. | File events | build 22295362 |
| Its own backups | Hourly into `backupsPath` (`Backup creation enabled. Path: …`), not observed (sessions under an hour). `--backup-file` restores one into an empty folder. | Start lines, `--help` | build 22295362 |

**Procedure proposed (BAK-02): save, then copy.** Send `/save`, wait for `All sectors saved
successfully.` (budget 60 s; 2 s measured), copy the galaxy folder without `serverlog *.txt`,
`server-stats *.csv` and the game's backups. Restoring puts the folder back while stopped.

### Players and moderation (PLY-01…03)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Online players | `/players` (`online players (<n>):`, names expected one per line); `server-stats *.csv` (an `Online Players` column); A2S on the Steam query port with `--listed true`. | Logs, `a2s/listed.json` | build 22295362 |
| Join and leave (expected) | `Player logged in: <name>, index: <n>`, `Player logged off: <name>`. | Strings | build 22295362 |
| Bans | By player (`/ban`, `blacklist.txt`, presumably by SteamID: the list options take `--id <steamid>` or `--name`) and by address (`/banip`, `ipblacklist.txt`); `accessListMode=Whitelist` with `whitelist.txt`. Admins: `--admin <steamid>`, `/admin -a`, `admin.xml`. | `--help`, `/whitelist` options | build 22295362 |

### Ports and Steam queries
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Listening (Steam networking, the default) | UDP **27020** (Steam query; `--steam-query-port`) and UDP **27003** (internal query; `--query-port`); nothing on 27000 or 27021; a TCP listener on 127.0.0.1 (Steam's client). | `/proc/net` | build 22295362 |
| A2S | With `--listed true`: A2S_INFO on 27020 (name, the seed as map, `avorion`, `Avorion`, players, slots, VAC, version `2.5.13.44140`, game port 27000, keyword `Normal`, game id 445220), A2S_PLAYER, A2S_RULES (9 rules); no challenge step. Unlisted: no answer. | `a2s/listed.json` | build 22295362 |
| What to publish | Expected: 27000 TCP and UDP (the advertised game port; the fallback protocols), 27003 UDP, 27020 UDP; at the same numbers inside and out (Steam is told them). Which ones a client really uses needs a client. | — | — |
| Ports taken | 27020 taken: Steam's init fails and it falls back; 27003 taken too: `ERROR accepting connections: bind: Address already in use`, `Server startup FAILED.`, a clean shutdown, exit 0 (4.4 s). | `fail-ports-in-use.log` | build 22295362 |

### Unwritable galaxy, CPU architecture
- `--datapath` on a read-only folder: `An exception occurred: …ini_parser_error…: <galaxy>/server.ini:
  cannot open file`, exit 0 in 0.03 s (`fail-readonly-datapath.log`).
- x86-64 only (`osarch 64`, x86-64 ELF; no ARM build).

### What a manifest needs, measured
Every part of running Avorion fits a declarative description: the app id, the command line with
placeholders, the working directory and one environment variable, the ports, one ready regex,
fatal regexes, `/stop` as the stop and `/save` + its done line as the save, the INI file (stopped
only, with managed and secret keys), the galaxy folder as the backup, the player regexes and
`/players`. No code hook is needed (the hand-off has the manifest filled in).

### Unverified: needs a real client (the owner will check)
- Joining by address and through Steam; which published ports a client uses; the `password` key.
- The join and leave lines; `/players`, `/kick`, `/ban` with someone online, and what the lists
  hold afterwards; A2S's count with a player.
- Memory, CPU and save times with players and explored sectors.
- The hourly backups.

## Manifest adapter check — 2026-10-01

M6 phase 3 (D5): the adapter the manifest engine makes from
`packages/adapter-manifest/manifests/avorion.json`, run against the real server by the product's
own agent, driven only through the agent's HTTP API (as the panel drives it). Two runs on fresh
volumes; the second, with the manifest as committed, is the one recorded below, and the capture
of its first start is `fixtures/avorion/2.5.13/logs/manifest-adapter-check.log`.

**Setup.** Docker Desktop 29.7.2 (Linux engine, amd64). The product's `gsp/steam` image built from
this branch (`node scripts/stack.mjs build steam`, tag `s5`; the agent bundle with the manifest
inside, and Valheim's crossplay libraries now in the image: 887 MB). One container shaped as the
orchestrator makes them: user 1000:1000, read-only root, all capabilities dropped,
`no-new-privileges`, a 256 MB `/tmp` tmpfs (exec), a 3 GiB memory limit (no swap), 4096 pids, the
install (`/opt/game`), data (`/data`) and steamcmd HOME (`/home/node`) volumes read-write as the
orchestrator mounts them (labelled `gsp.factfinding=avorion`), `GAME_ADAPTER=avorion` and the
ports in the environment as the panel's spec sets them (`GAME_PORT_GAME=30550`, `GAMETCP=30550`,
`QUERY=30553`, `STEAMQUERY=30570`), published on 127.0.0.1 at the same numbers inside and out,
and the agent's port on 127.0.0.1. Launch params as the panel sends them (`name gspffcheck`,
public branch, 4 slots, not listed, autosave 300 s).

| Step (agent API) | Result |
|---|---|
| `PUT /v1/launch` | Accepted (the manifest's checks ran in the agent). |
| `POST /v1/install` | `{ ok: true }` in 59.5 s on a fresh steamcmd HOME (28 s in the first run): `Success! App '565060' fully installed.` at the first try, both runs (the fact-finding's first-try `Missing configuration` didn't come back; the driver still retries it). Installed: branch `public`, build `22295362`. |
| `POST /v1/start` | Running 4.2 s after the start (4.7 s on the second start); version `2.5.13` from the banner. Command line: `/opt/game/bin/AvorionServer --galaxy-name gspffcheck --datapath /data --server-name "gspff check" --max-players 4 --port 30550 --query-port 30553 --steam-query-port 30570 --steam-master-port 27021 --listed false --save-interval 300 --send-crash-reports false`, working folder `/opt/game`. `send crash reports: no`; `--listed false` taken (`listed: no`). |
| Players | The agent's quiet `/players` poll: `{ count: 0 }`, its reply kept out of the live log; `players` typed through `POST /v1/command` went to the game as `/players`, and its reply (`online players (0):`) showed. |
| `POST /v1/save` | `{ ok: true }` in 2.1 s (`/save` … `All sectors saved successfully.`). |
| `POST /v1/archive/pack` (hot) | 200, `application/x-tar`, 52 KB, 24 entries in 2.1 s, after the agent's `/save` and its done line: the whole galaxy folder (`server.ini`, its readme copy, `admin.xml`, the four lists, `server.dat.0-1`, `sectors/meta.db.0-2`, `index`, `globals`, `galaxyscripts.dat`, `groups.dat`, the empty `alliances/ factions/ moddata/ players/`, `serverlog <date>.txt`, `server-stats <date>.csv`). Nothing of `avorion-backups` (outside the part). |
| `POST /v1/stop` | `/stop`; `Server shutdown successful.`, exit 0, in 1.9 s. |
| Second start, stop | `server.ini` now holds the agent's keys (`backupsPath=/data/avorion-backups`, `sendCrashReports=false`; the port, name, slots, listing and autosave as before): `Backup creation enabled. Path: "/data/avorion-backups"`; the same seed; stop in 1.9 s, exit 0. |

Memory with nobody online: 240 MiB RSS for the game, 419 MiB for the whole container (agent and
game, page cache included); 0.28 of a core.

**What it found** (the manifest and the fake follow it):
1. **A `server.ini` written before a new galaxy's first start fixes its seed.** The first run
   seeded a partial `server.ini` (the agent's keys in their sections): the game took it, but gave
   the galaxy seed `0` (`Seed=0` written back); with an empty `Seed=` it ran with an empty seed. A
   start without a `server.ini` picks a random one (as in the fact-finding). So the manifest seeds
   nothing: the game writes `server.ini` on a galaxy's first start, crash reports are off from it
   through the command line, and the agent's other keys (the backup folder) apply from the next
   start. Until then the game's hourly backups would go to `/home/node/.avorion/backups`
   (`Backup creation enabled. Path: "/home/node/.avorion/backups"` on the first start).
2. **A query port other than 27003 on a server that isn't listed makes the game warn** at every
   start: `WARNING: Query port change detected and server is not listed publicly.`, `Players may
   not be able to connect to the server.`, `Change this port only when using steam networking and
   when listing the server publicly.`, then `If you're running multiple servers, you may want to
   look at binding the server to an ip with the --ip option.` The manifest declares it as a
   warning (the agent says it once per run in the log) and its ports note asks for 27003 on
   unlisted servers. Whether players really can't join is still *expected* (no client).
3. Everything else ran as the fact-finding measured: the ready and version lines, `/players`,
   `/save` and its done line, `/stop`, the galaxy's files.

**Left behind:** nothing. The container ran with `--rm`; its three volumes, the image
`gsp/steam:s5` and the throwaway token were removed afterwards; `docker ps -a`, `docker volume
ls`, `docker network ls` and `docker images`, filtered by `label=gsp.factfinding=avorion`, by the
name `gsp-ff` and by the tag `s5`, were empty. Docker's build cache was left alone (never
pruned); the other stacks' containers were not touched.
