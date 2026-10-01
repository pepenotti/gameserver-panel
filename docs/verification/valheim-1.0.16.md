# Valheim 1.0.16 verification log

Facts measured on the real dedicated server for M6 (D5: measured, not guessed), not taken from
wikis or forums. Each entry says how it was verified and what it holds for. Captures live in
`fixtures/valheim/1.0.16/` (its README describes the layout and the scrubbing); the fake built
from them is in `tools/fake-valheim/`. The second Steam game, measured for the manifest-only path,
is in `avorion-2.5.13.md`.

## M6 fact-finding — 2026-10-01

**Setup.** Docker Desktop 29.7.2 (Linux engine, amd64, 12 cores). Every run used the product's
`gsp/steam` image built from this branch (`node scripts/stack.mjs build steam`, Node 24 on Debian
trixie with Valve's steamcmd), in a throwaway container shaped like the product's game containers:
user 1000:1000, read-only root, all capabilities dropped, `no-new-privileges`, a 256 MB `/tmp`
tmpfs (exec), a 3 GiB memory limit (no swap), 4096 pids, the install on its own volume mounted
**read-only** at `/opt/game`, the data at `/data`, steamcmd's HOME on a third volume at
`/home/node` (as the orchestrator's steam volume), ports published on 127.0.0.1 only. A small
harness started the game in its own process group, timestamped every line, sampled memory and CPU
from the cgroup every 5 s, watched folders for file events and sent signals or stdin lines. One
server at a time.

**What ran.** Steam app **896660** ("Valheim Dedicated Server"), public branch **build
25527701**, which prints `Valheim version: l-1.0.16 (network version 40)`; Unity 6000.0.75f1.
Installed anonymously with `steamcmd +force_install_dir /opt/game +login anonymous +app_update
896660 validate +quit`.

**Licences.** No agreement was shown or needed: steamcmd installed the app anonymously
(`freetodownload 1`) and the server asks nothing before it runs. No EULA gate is proposed; the
owner may want to confirm.

**Players.** No client joined: a Valheim client needs a Steam (or Xbox/PlayFab) account that owns
the game, so joins, leaves, kicks, bans, the lists taking effect and the player count with someone
online were not seen. The log lines a join should print were read from the game's own strings
(its `assembly_valheim.dll`), and are marked **expected**. What only a real client can show is
listed at the end.

### Headline findings
1. **No remote console, and stdin is ignored.** Words typed on stdin (`help`, `save`, `info`)
   produced nothing; the binary has no RCON. Kick, ban and save exist only in the in-game console
   of admins listed in `adminlist.txt` (expected, from the strings). The panel controls Valheim
   with signals and files only, and has no way to ask for a save.
2. **SIGINT and SIGTERM both save and exit 0** in 3.5–4.2 s (`Game - OnApplicationQuit`, the five
   `World save (n/5)` steps, about 0.1 s for a small world). A stop budget of 60 s is generous.
3. **The ready line is `Opened Steam server`** (`Opened PlayFab server` with `-crossplay`).
   `Game server connected` is Steam's logon and came *before* world generation on a first boot.
   First boot (world generation, about 32 s) ready at **77 s**, an existing world at **44–48 s**.
4. **Valheim 1.0 saves a world as a numbered set** in `worlds_local/<world>/`:
   `00_00__0_<n>.chunk` files, `_main.<n>.chunks`, `_main.<n>.db2`, `_main.<n>.fwl2`, then an
   `_main.<n>.ok` marker, and only then deletes the previous set. A set is never written again after
   its marker, so **the newest set with an `.ok` is a consistent copy while the game runs**.
5. **Password rules apply only to public servers**: with `-public 1` a password shorter than 5
   characters (or none) fails with `Error bad password:The password is too short`, one contained in
   the server name with `Error bad password:Invalid password`; the process exits **0** about 36 s
   in, without the ready line, and leaves an empty `worlds_local/DevWorld/` world behind. With
   `-public 0` a 3-character password and no password at all were accepted.
6. **Most failures exit 0.** A taken query port, a bad password and a corrupt world all exit 0. A
   corrupt world even prints the ready line before quitting. A taken game port is **silent**: the
   server says it is ready and never listens.
7. **Crossplay needs libraries the image lacks.** PlayFab Party (`libparty.so`) links against
   `libatomic1`, `libpulse0` and `libpulse-mainloop-glib0`. Without them `-crossplay` still prints
   its ready line but never gets a join code. With them it registers a session with a join code and
   **the host's public address**, and binds nothing on the game port.
8. **Steam queries answer only on public servers.** With `-public 1` the query port (game port +
   1) answers A2S_INFO and A2S_PLAYER (players online, slots, `g=1.0.16,n=40`); with `-public 0` it
   stays silent. That is the only way found to count players without a client in the log.
9. **It burns CPU idle**: about a third of one core with nobody online, and about 1.37 GiB of
   memory (RSS 1.43–1.46 GB).
10. **The game's own backups never happened.** Every save said `Skipping backup. World session not
    long enough.`, even with `-backupshort 60 -backuplong 120` over 7.5 minutes.
11. **`-logfile` takes the log away from stdout** (only Unity's first lines stay): the agent, which
    reads stdout, must not pass it.

### Install and versions (UPD-01, UPD-02)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Anonymous install | `app_update 896660 validate` as `anonymous`: `Success! App '896660' fully installed.`, 1 min 57 s on this host's line; 1 911 421 168 bytes downloaded, **2 186 649 264 bytes** on disk (`SizeOnDisk`), 994 files. It worked on the first try here (steamcmd's state already held an `app_info_print`); a fresh steamcmd failed the first install of three other apps with `Missing configuration` (see `avorion-2.5.13.md`). | `steamcmd/app-update-896660.log`, `du` | build 25527701 |
| Depots | `896661` (Linux, 2.08 GB) and `1006` (Steamworks redistributable for Linux, 111 MB). | `steamcmd/app-info-896660.vdf`, `appmanifest_896660.acf` | 2026-10-01 |
| Branches | `public` 25527701; `default_old` 25390671 ("Previous stable"); `default_pre1_0`, `default_preal`, `default_prebw`, `default_precta`, `default_preml` (each "Last stable build before …" an update); `privatebranches 1`: hidden branches exist (the public test branch isn't listed anonymously and needs an access code; not tried). | `app_info_print 896660` | 2026-10-01 |
| Installed build | `steamapps/appmanifest_896660.acf`: `buildid`, and `UserConfig.BetaKey` for a branch; the game's version from its log line `Valheim version: l-1.0.16 (network version 40)` (also A2S keywords `g=1.0.16,n=40`). | Files, logs | build 25527701 |
| Install tree | `valheim_server.x86_64` (15 KB), `UnityPlayer.so`, `valheim_server_Data/` (1.9 GB: `Managed/` with `assembly_valheim.dll`, `Plugins/` with `libsteam_api.so` and `libparty.so`, `MonoBleedingEdge/`), `linux64/steamclient.so`, a second `steamclient.so`, `start_server.sh`, `start_server_xterm.sh`, `docker_start_server.sh` and `docker/` (the maker's own container recipe), the server manual (PDF), `steam_appid.txt` (`892970`, the game's app id). steamcmd leaves every file 0755. | `ls`, `cat` | build 25527701 |
| Binary | x86-64 ELF; needs only glibc (`libm libgcc_s libpthread libc libdl libanl librt`), all in `gsp/steam`. `libparty.so` (crossplay) also needs `libatomic.so.1`, `libpulse.so.0`, `libpulse-simple.so.0` and `libpulse-mainloop-glib.so.0`, which `gsp/steam` lacks (Debian `libatomic1 libpulse0 libpulse-mainloop-glib0`). The maker's own container recipe installs `libatomic1` and `libpulse`. | `ldd` on each library | build 25527701 |

### Launch (SRV-01, SRV-05, NFR-04)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| The maker's start script | Sets `LD_LIBRARY_PATH=./linux64:$LD_LIBRARY_PATH` and `SteamAppId=892970`, then runs `./valheim_server.x86_64 -name … -port 2456 -world … -password … -crossplay` from the install folder. Its comments ask for a password of at least 5 characters that isn't part of the name, and for UDP 2456–2458 to be forwarded. | Reading `start_server.sh` | build 25527701 |
| Command used | `/opt/game/valheim_server.x86_64 -nographics -batchmode -name <name> -port <port> -world <world> -password <pw> -public 0\|1 -savedir /data`, working directory `/opt/game` (read-only is fine), env `LD_LIBRARY_PATH=/opt/game/linux64`, `SteamAppId=892970`. Without `-nographics -batchmode` it forced the null graphics device anyway (`Forcing GfxDevice: Null`). | Runs | build 25527701 |
| Flags | Server: `-name -port -world -password -public -savedir -logfile -crossplay -instanceid -saveinterval -backups -backupshort -backuplong -preset -modifier <key> <value> -setkey -resetmodifiers` (plus client-only `-joinserverwithcharacter -joincode -simulationdistance`) and Unity's `-nographics -batchmode`. Used and seen working: all but `-instanceid`, `-setkey`, `-resetmodifiers`. | Strings in `assembly_valheim.dll`; runs | build 25527701 |
| `-savedir` | `Setting -savedir to: /data`; the worlds go to `<savedir>/worlds_local/`, the three lists to `<savedir>/`. Default (not used): `~/.config/unity3d/IronGate/Valheim`. | Runs, file lists | build 25527701 |
| `-world` | A missing world is created (`Load world: <w> (<w>)`, `  missing /data/worlds_local/<w>.db`, then `Loading: Generating locations`); an existing one is loaded by its newest complete save (`ZNet.LoadWorld: <w> (<w>), save number <n>`). | `logs/first-boot-then-sigterm.log`, `existing-world-autosaves-then-sigint.log` | build 25527701 |
| `-public` | `1`: Steam lists it and the query port answers; the password rules apply. `0`: neither. Both print `Registering lobby` and `Opened Steam server`. | `public.log`, `a2s/*.json` | build 25527701 |
| Password rules | Public only: shorter than 5 or missing → `Error bad password:The password is too short`; inside the name (`gspff` in `gspff test`) → `Error bad password:Invalid password`; exit 0 at 36–38 s, no ready line, `worlds_local/DevWorld/_main.0.fwl2` left behind. Private: 3 characters and none accepted. | `fail-password-*.log`, `fail-no-password-public.log`, `private-*.log` | build 25527701 |
| `-port` | The game port; the Steam query port is always **game port + 1** (measured with 2456 and 30560). | `tree/sockets.txt` | build 25527701 |
| `-crossplay` | See "Crossplay" below. | | |
| `-saveinterval` | Seconds between autosaves; 60 worked (default 1800 by the maker's documentation, not waited for). | `existing-world-autosaves-then-sigint.log` | build 25527701 |
| `-backups -backupshort -backuplong` | Echoed in every save's `Considering autobackup for World. World time: <t>, short time: <s>, long time: <l>, backup count: <n>`; defaults 7200, 43200, 4. No backup was made (finding 10). | Same | build 25527701 |
| `-preset`, `-modifier` | `Setting world modifier preset: hard`, `Setting world modifier: raids->none`; they are stored in the world (the `.fwl2` held `playerdamage`, `enemydamage` … afterwards). | `logfile-file.log`, the `.fwl2`'s bytes | build 25527701 |
| `-logfile <file>` | `Setting -logfile to: <file>`; from then on everything goes to the file, stdout keeps only Unity's first ~30 lines. | `logfile-stdout.log`, `logfile-file.log` | build 25527701 |
| Files a first boot writes | `adminlist.txt`, `bannedlist.txt`, `permittedlist.txt` (each one comment line, see Players); `worlds_local/<world>/_main.0.fwl2` (55 bytes: name and seed) as the world is created; the first numbered set only at the first save. In HOME: `.config/unity3d/IronGate/Valheim/prefs` (Unity's preferences, with Unity analytics session ids), `Steam/config/config.vdf`, `Steam/logs/connection_log_<port>.txt` (grows with every start: 113 KB after 15 starts). Nothing in the install, `/tmp` or elsewhere. | File watch, `find -newermt` on HOME | build 25527701 |
| Time to ready | First boot 77 s (32 s of location generation, 183 locations); existing world 44–48 s; with another busy container on the host, a first boot's generation took over 80 s. | Timestamps | one amd64 host |
| Memory | 0.51 GiB at 5 s, **1.37–1.38 GiB** (cgroup) idle with a small world, peak 1.40 GiB; RSS 1.43–1.46 GB; crossplay adds about 30 MB. | cgroup `memory.current`/`peak`, `VmRSS` | small world, nobody online |
| CPU | About **0.34 of one core** idle with nobody online (113 s of CPU in 330 s); 2 cores during generation. | cgroup `cpu.stat` | same |

### Readiness and logs (CON-01, SRV-07)
Lines as printed. Valheim's own lines start with `MM/DD/YYYY HH:MM:SS: `; Unity's and Steam's have
no stamp; some lines go to stderr.
| Line (after the stamp) | Meaning |
|---|---|
| `Valheim version: l-1.0.16 (network version 40)` | version (also `Console: Valheim l-1.0.16 (network version 40)`) |
| `Opened Steam server` / `Opened PlayFab server` | **ready** (after `Registering lobby`) |
| `Game server connected` | Steam logon; not readiness |
| `Load world: …`, `  missing …`, `Loading: Generating locations` | a new world is generated |
| `Location <name> took more than 0.5 seconds to place, check spawn conditions to improve! (…)`, `Failed to place all <name>, placed …` | world generation's progress-like run (48 lines on the measured first boot); then `There are <n> that take a long time to generate …` |
| `ZNet.LoadWorld: <w> (<w>), save number <n>` | an existing world loads |
| `World save (1/5) … => Save number <n>` … `World save (5/5) done. Total time [<n>ms]` | a save; `(5/5)` means the set and its `.ok` are written |
| `Game - OnApplicationQuit` | stopping (a signal) |
| `Error bad password:<reason>` | fatal: bad password (public) |
| `CreateBoundSocket: ::bind couldn't find an open port between <p> and <p>`, `[Steamworks.NET] GameServer.Init() failed.`, `Steam is not initialized`, `Awake of network backend failed` | fatal: query port taken |
| `World load failed mid-file. Exiting without save. Check backups!`, `World db couldn't load correctly, saving has been disabled …`, `Skipping world save` | fatal: corrupt world (also `World load failed early. …`, from the strings) |
| `IOException: Read-only file system` then `The WorldGenerator instance was null` (×18) | the save folder can't be written: never ready |
| `Game server connected failed` | Steam can't be reached (repeats every 4–20 s) |
| `DllNotFoundException: libParty.so …`, `Failed to open plugin: …/libparty.so` | PlayFab's libraries are missing; both lines show on every start, with or without `-crossplay` (only crossplay needs them) |
| `Session "<name>" registered with join code <n>`, `Session "<name>" with join code <n> and IP <ip>:<port> is active with <n> player(s)` | crossplay is up |
| `Available space to current user: <n>. Saving is blocked if below: <n> bytes. …` | the game checks free disk before saving and refuses to save below a threshold |

Noise: Unity's start (`memorysetup-…` parameters, shader and image-effect warnings, `The
referenced script on this Behaviour … is missing!`, `Unloading … unused Assets …`), PlayFab's
stack trace without its libraries, Steam's `[S_API …]` and assertion lines on stderr. About 205
lines from start to ready on an existing world, 260 on a first boot; then **nothing** while idle
(no periodic lines in 7.5 minutes except the saves).

### Control and stop (CON-02, SRV-03, NFR-04)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Remote console | None (no RCON flag or code path for a dedicated server). | Strings, flags | build 25527701 |
| stdin | Ignored: `help`, `save`, `info` printed nothing. | `first-boot-then-sigterm.log` (`> ` lines) | build 25527701 |
| In-game admin console | Admins (SteamIDs in `adminlist.txt`) get `kick [name/ip/userID]`, `ban [name/ip/userID]`, `unban [ip/userID]`, `banned` and `save` through the game client's console (sent to the server as a remote command). **Expected** (strings), needs a client. | Strings | build 25527701 |
| SIGINT | Saves, `Net scene destroyed`, exit **0** in 3.5–4.2 s (small world). | `existing-world-autosaves-then-sigint.log`, `tree/save-file-events.txt` | build 25527701 |
| SIGTERM | The same: saves, exit **0** in about 3.5 s. | `first-boot-then-sigterm.log`, `tree/stop-sigterm-events.txt` | build 25527701 |
| Stop budget | 60 s proposed: the measured stops took 4 s; a big world's save is expected to take seconds more, unmeasured (a world grows only where players go). | | |
| Never-ready stop | The unwritable-save-folder hang exits 0 at once on SIGINT. | `never-ready-readonly-savedir.log` | build 25527701 |

### Saving and backups (BAK-01, BAK-02)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| When it saves | Every `-saveinterval` seconds (each prints `Sending message to save player profiles` first: characters are saved on the players' own machines, not on the server) and on SIGINT/SIGTERM. Never on demand (no console). | Logs | build 25527701 |
| How a save writes | Set `<n>` = previous + 1: each `00_00__0_<n>.chunk` (one per chunk with changes), `_main.<n>.chunks`, `_main.<n>.db2` (the world), `_main.<n>.fwl2` (name, seed, modifiers), then the 4-byte `_main.<n>.ok`, then the files of set `<n-1>` are deleted. Each file is created and written directly (no temporary name); the `.ok` marks the set complete. 50–100 ms for a small world (`.db2` 146 KB). | File watch: `tree/save-file-events.txt` | build 25527701 |
| Loading | The newest set with an `.ok`; the game also knows how to remove orphan files and two competing sets (strings: `Removing orphan save file`, `There are two none-backup files for save`). | Logs, strings | build 25527701 |
| A torn `.db2` | `World load failed mid-file …`, ready line, quit without saving, exit 0; the files are left as they were. | `fail-corrupt-world.log` | build 25527701 |
| The game's backups | `-backups/-backupshort/-backuplong` choose them, but none was made ("World session not long enough") in sessions up to 7.5 min. Expected names: `<world>_backup_auto-<yyyyMMdd-HHmmss>` (strings). | Logs, strings | build 25527701 |
| Copy while running | The newest complete set is never written again: copying it (and the three lists) is consistent. An autosave may start during the copy and delete that set once it finishes the next one (in about 0.1 s); the copy must then start over with the new set. | File events, a copy taken during play (9 ms for a small world) | build 25527701 |

**Procedure proposed (BAK-02): copy the newest complete save while running.** List
`worlds_local/<world>/`, take the highest `<n>` that has `_main.<n>.ok`, copy that set (its
`.fwl2`, `.db2`, `.chunks`, `.ok` and every `*_<n>.chunk`) plus `adminlist.txt`,
`bannedlist.txt`, `permittedlist.txt`; if a file of the set disappears during the copy, start
again with the new highest set. The copy holds the world as of the last save (up to
`-saveinterval` old: the panel should pass a shorter interval than the default 30 minutes, e.g.
300 s). A stopped server's backup is the same copy with nothing moving. There is no way to force a
save first; restoring puts one set back (any `<n>` works; keeping the numbers is fine).

### Players and moderation (PLY-01…03)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Lists | `adminlist.txt`, `bannedlist.txt`, `permittedlist.txt` in the save folder, each created at the first boot with one comment line (`// List admin players ID  ONE per line`, …) and then **one ID per line** (SteamID64 for Steam players; the strings also show `playfab/`, `steam/` and `socket/` id prefixes for other platforms, not seen). A non-empty permitted list lets only those IDs in. | `files/` | build 25527701 |
| Who writes them | The game, only to create them. It never rewrote them afterwards: not at boot, not at saves, not at the stop, not after they were replaced while it ran (with unusual spacing, a blank line and a comment of our own kept byte for byte). Whether it **re-reads** them while running needs a client (no log line reacted to the edits). | `tree/list-edit-events.txt` | build 25527701 |
| Bans | By ID (SteamID), so Docker Desktop's hidden addresses don't matter for them; the in-game `ban` also takes a name or IP (expected). | Strings | build 25527701 |
| Join and leave (expected) | `Got connection SteamID <id>`, `Got handshake from client <id>`, `Server: New peer connected,sending global keys`; refusals `Peer <id> has wrong password`, `Peer <id> is blacklisted or not in whitelist.`, `… disconnected due to server is full`; a leave `Closing socket <id>`. Names are not in those lines. | Strings only | build 25527701 |
| Counting players | No console to ask. With `-public 1`: A2S_INFO `players` on the query port (0 measured) and A2S_PLAYER (count, names unverified). Otherwise only from the join and leave lines (expected). | `a2s/public.json` | build 25527701 |

### Ports (SRV-01, SRV-08, NFR-03)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Listening | UDP **game port** (IPv6 any, dual-stack) and UDP **game port + 1** (IPv4 any, Steam's query and server socket); also one ephemeral UDP socket and a TCP listener on 127.0.0.1 (Steam's client, not to publish). Nothing on game port + 2 (2458), with or without crossplay. | `/proc/net/udp{,6}`, `tcp` (`tree/sockets.txt`) | build 25527701 |
| With `-crossplay` | Nothing on the game port; PlayFab uses ephemeral sockets and its relays; the session is registered with the host's public address and the game port. | Same | build 25527701 |
| What to publish | UDP game port and game port + 1, **at the same numbers inside and out**: Steam is told the in-container port (A2S reported 2456 while it was published as 30550). | A2S through the published port | build 25527701 |
| Through Docker Desktop | The query answered through the published port from the host. Clients' addresses: not seen (no client). | A2S from the host | Docker Desktop |

### Crossplay
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| With the libraries | `Opened PlayFab server`, a PlayFab login with an id built from the server's name, port and a hash, `Joined PlayFab Party network …`, `Created PlayFab lobby …`, `Session "<name>" registered with join code <6 digits>`, `… is active with 0 player(s)` (once, not repeated). Needs outbound access to PlayFab. | `crossplay.log` | build 25527701 + `libatomic1 libpulse0 libpulse-mainloop-glib0` |
| Without them (the product image) | `DllNotFoundException: libParty.so`, `New session server … that has join code , now 0 player(s)`, then stuck at `begin PlayFab create and join network`: ready line, but nobody can join through crossplay. | `crossplay-missing-libraries.log` | `gsp/steam` |
| What it tells the world | The host's public IPv4 address (in the log and to PlayFab). | Logs | build 25527701 |

Offering it: only if the image gains the three libraries (about 2 MB) and the panel says that
crossplay players join by the join code, and that the log shows the public address. Proposed as
an option off by default (see the hand-off).

### No network (HST-07)
With `--network none` the server still printed `Opened Steam server` (ready, 42 s) and then
`Game server connected failed` every 4–20 s; it saved and stopped normally. Clients authenticate
through Steam, so nobody is expected to be able to join (unverified). The no-network line is worth
a warning in the panel, not a crash. (`no-network.log`)

### CPU architecture (HST-05)
x86-64 only: the binary is an x86-64 ELF and the app's only Linux depot is x86-64 (`osextended`
lists Apple Silicon only for macOS). Confirmed by `file`-style header and the depot list.

### Mods (MOD-05, PRD §4)
Not installed (a non-goal in v1). How a server would load BepInEx, from general knowledge and not
run: BepInEx's Valheim pack ships a doorstop preloader (`libdoorstop` through `LD_PRELOAD`) and a
start script that sets the doorstop's variables, and puts `BepInEx/` and its libraries next to
`valheim_server.x86_64`, i.e. **into the install folder**, which the product keeps read-only and
`validate` overwrites. Supporting it later would need a mods folder outside the install, a
launcher hook that sets the preload variables, and the same plugin warnings as TShock's.

### Keys the panel manages, proposed
| Where | Value | Why |
|---|---|---|
| `-port` | the server's game port (published at the same number) | Steam advertises it |
| `-savedir` | `/data` | the world and lists in the data volume |
| `-world` | the server's game name (`ServerRef.gameName`) | backups and resets name it |
| `-public` | the owner's choice; `1` requires the password rules | lists the server |
| `-password` | a launch secret (never on a log line: the game doesn't print it; the agent redacts it) | — |
| `-saveinterval` | e.g. 300 (launch setting) | bounds what a running backup misses |
| `-nographics -batchmode` | always | as the community launches it; harmless |
| `-logfile` | never | the log must stay on stdout |
| env `LD_LIBRARY_PATH=<install>/linux64`, `SteamAppId=892970` | always | the maker's script does |

### Open questions (for the integrator and the owner)
- **Crossplay**: add `libatomic1 libpulse0 libpulse-mainloop-glib0` to `gsp/steam` and offer
  `-crossplay` (off by default), or leave it out of v1?
- **Public servers**: offer `-public 1` (the server appears in Steam's list; the password rules
  apply), or keep every server private and joined by address?
- **Player count**: A2S works only with `-public 1`; for private servers the log's join and leave
  lines (expected, unverified) are the only source. Is a count from the log good enough?
- **Autosave interval**: the default 30 minutes means a running backup may miss up to 30 minutes.
  Pass a shorter `-saveinterval` (300 s proposed)?
- The game's own backups (`-backups …`): leave them off (`-backups 0`?) since the panel makes its
  own, or keep the defaults? (They never ran in the fact-finding, so their effect is unmeasured.)

### Unverified: needs a real client (the owner will check)
- Joining by address (Steam, `-public 0` and `1`), with the password; joining a crossplay server by
  its join code from another platform.
- The join and leave lines and their SteamIDs; A2S's player count and names with someone online.
- Kick, ban and unban from the in-game admin console; whether an edit of `bannedlist.txt`,
  `permittedlist.txt` or `adminlist.txt` takes effect without a restart; what the game writes into
  the lists when an admin bans someone in game.
- Saves and stop times with a played-in world (bigger `.db2`, many chunk files); memory and CPU with
  players.
- The game's own backups after a long session.
- Real client addresses on a Linux host (Docker Engine keeps them; Docker Desktop doesn't).

## Adapter check — 2026-10-01

M6 (D5): the Valheim adapter (`packages/adapter-valheim`: the manifest `manifest/valheim.json` plus
its two hooks) run against the real server by the product's own agent, driven only through the
agent's HTTP API, as the panel drives it. No crossplay (it was measured once in the fact-finding;
it registers the host's public address with an outside service) and no public listing. Two
attempts on fresh volumes: the first found the chunk versions below and changed the running
backup's selection; the second, with the code as committed, is the one recorded here, and the live
log of its first run is `fixtures/valheim/1.0.16/logs/adapter-check.log`. The world folder after
every save of both attempts is `fixtures/valheim/1.0.16/tree/adapter-check-sets.txt`.

**Setup.** Docker Desktop 29.7.2 (Linux engine, amd64, 12 cores). The product's `gsp/steam` image
built from this branch (`node scripts/stack.mjs build steam`, tag `s5`, 887 MB: the agent bundle
with Valheim enabled, PlayFab's libraries in the image). One container shaped as the orchestrator
makes them: user 1000:1000, read-only root, all capabilities dropped, `no-new-privileges`, a
256 MB `/tmp` tmpfs (exec), 3328 MiB of memory (the default 3072 for the game plus 256), no swap,
4096 pids; the install (`/opt/game`), data (`/data`) and steamcmd HOME (`/home/node`) volumes
labelled `gsp.factfinding=valheim`; `GAME_ADAPTER=valheim`, `GAME_PORT_GAME=30556` and
`GAME_PORT_QUERY=30557` (the query port following the game port, as the panel's spec sets it),
both published on 127.0.0.1 over UDP at the same numbers inside and out, the agent's port on
127.0.0.1. Launch params as the panel sends them: game name `gsp-vh-check` (an ID with dashes, as
the panel's are), public branch, 3072 MiB, server name `gspff check`, a random 8-character
password, not listed, no crossplay, autosave every 60 s (the shortest the panel offers, to see
several saves; its default is 300 s).

| Step (agent API) | Result |
|---|---|
| `PUT /v1/launch` | Accepted. The same with `public: true` and a 4-character password: 400, `password: A server in the public list needs a password of at least 5 characters: Valheim refuses to start otherwise.` (the agent checks the manifest's rules too; the panel refuses first). |
| `POST /v1/install` | `{ ok: true }` in 122.5 s on a fresh steamcmd HOME (115.4 s in the first attempt), first try both times: `Success! App '896660' fully installed.` Installed: branch `public`, build `25527701`. |
| `POST /v1/start` | Running 85.0 s after the start: a new world (`Load world: gsp-vh-check (gsp-vh-check)`, 33.5 s placing locations, shown as one progress line), then `Opened Steam server`; version `1.0.16`. Command line: `/opt/game/valheim_server.x86_64 -nographics -batchmode -name gspff check -port 30556 -world gsp-vh-check -password <redacted> -public 0 -savedir /data -saveinterval 60`, working folder `/opt/game`; the password was in no log line. No warning and no alert: with PlayFab's libraries in the image, the `DllNotFoundException: libParty.so` of the fact-finding's image is gone. |
| Players | The agent's poll from the join and leave lines: `{ count: 0 }`. An A2S_INFO to the published query port: no answer in 3 s (a private server, as measured). |
| Autosaves | Every 60 s: the five `World save (n/5)` lines, a numbered set in `worlds_local/gsp-vh-check/`. |
| `POST /v1/archive/pack` (hot, the world and the three lists) | 200, `application/x-tar`, 156 672 bytes, 45 ms: exactly one complete set, `00_00__0_1.chunk`, `_main.1.chunks`, `.db2`, `.fwl2`, `.ok`, and `adminlist.txt`, `bannedlist.txt`, `permittedlist.txt`. |
| The same, fired at the next autosave | Sent 1 ms after that save's first line (`Sending message to save player profiles`), done in 38 ms, just before the save wrote its first file: set 1, complete, and the lists. A copy that overlaps a save's writing wasn't caught on the real server (a save takes 0.1 s here); the end-to-end test holds a fake save half written for that. |
| The same after that save | Set 2 with `00_00__0_2.chunk` (its save changed the chunk). |
| `POST /v1/stop` | SIGINT: `Game - OnApplicationQuit`, save 3, exit 0 in 3.7 s. Save 3 changed no chunk: set 3 is `_main.3.*` with `00_00__0_2.chunk`. A stopped copy: those five files and the lists. |
| Second start, stop | Running in 48.5 s on the same world (`ZNet.LoadWorld: gsp-vh-check (gsp-vh-check), save number 3`, nothing generated); stopped in 3.8 s, exit 0 (save 4, no chunk changed). |
| Third start (a new container, the same volumes) | Running in 46.6 s on save 4; autosave 5 changed the chunk (`00_00__0_3.chunk`); a hot pack held `00_00__0_3.chunk`, `_main.5.*` and the lists; stop 3.7 s, exit 0 (save 6). |

Memory with nobody online: 1.48 GB RSS for the game, 1.97 GiB for the whole container in
`docker stats`; the container's cgroup counted 3.2 GB of its 3.25 GiB, the page cache of the
install included (reclaimable: nothing was killed). CPU 0.24-0.33 of a core.

**What it found** (the hook, the fake and the tests follow it):
1. **A chunk file is named by the chunk's own version, not the save number.** The version goes up
   only when a save finds the chunk changed (`Number of dirty chunks to save: 1`); a save that
   changed nothing (`… 0`) writes no chunk file, its set uses the older one, and that one stays.
   First attempt: saves 2 to 4 used `00_00__0_1.chunk`, save 5 wrote `00_00__0_2.chunk`; second:
   saves 1 and 2 changed it, 3 and 4 didn't, 5 did (version 3). In the fact-finding every save
   changed it, which made the version look like the save number. The set's index
   `_main.<n>.chunks` (21 bytes) names the version (bytes 13-16: 1, 2, 3 above; bytes 2-5 the
   world's object count, 85 and 81, as `Starting to load 85 zdos from 1 Chunks` says); how it
   names the chunks of a bigger world, with more than one chunk file, wasn't measured. So a running
   backup takes, for each chunk, its newest file written no later than the newest complete set's
   `.ok`: the one that set uses, never one a save in progress is writing, never a leftover the game
   is deleting. Taking only chunk files numbered like the set (the fact-finding's reading) would
   have left the world's chunk out of the backups after save 2 of the first attempt.
2. Which saves change a chunk with nobody online isn't predictable from outside (the first
   autosave did in both attempts; later ones sometimes did); the fake models both ways
   (`FAKE_VALHEIM_DIRTY_SAVES`).
3. **A world named like a panel ID (with dashes) works**: `worlds_local/gsp-vh-check/`.
4. Everything else ran as the fact-finding measured: install, readiness, version, the command
   line, SIGINT saves and exits 0 in under 4 s, an existing world loads by its newest complete set,
   the lists and the private server's silent query port.

**The tests that need signals, on Linux.** Windows can't deliver SIGINT to a child that handles it,
so the agent's live contract for Valheim skips there. They ran in the same `gsp/steam:s5` image
(Node 24, Linux; a copy of the branch, `npm ci`): the agent's live runtime contract against
`tools/fake-valheim` (23 checks), then the fake's tests (signals included), the adapter's and the
engine's tests and the end-to-end test (276 passed, 2 skipped: the console checks of games without
a console), all green.

**Left behind:** nothing. The containers ran with `--rm`; the three `gsp-ff-valheim-*` volumes, the
Linux test run's volume and the image `gsp/steam:s5` were removed afterwards; `docker ps -a`,
`docker volume ls` and `docker images`, filtered by `label=gsp.factfinding=valheim`, by the name
`gsp-ff` and by the tag `s5`, were empty. Docker's build cache was left alone (never pruned); the
other stacks' containers were not touched.
