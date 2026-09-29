# Terraria 1.4.5.8 verification log

Facts measured on real servers for M5 (D5: measured, not guessed), not taken from wikis or
forums. Each entry says how it was verified and what it holds for. Captures live in
`fixtures/terraria/1.4.5.8/<flavour>/` (its README describes the layout and the scrubbing); the
fakes built from them are in `tools/fake-terraria/`.

## M5 fact-finding — 2026-09-29

**Setup.** Docker Desktop 29.7.2 (Linux engine, amd64, 12 cores). Every server ran in a throwaway
container shaped like the product's game containers: user 1000:1000, read-only root, all
capabilities dropped, `no-new-privileges`, a 256 MB `/tmp` tmpfs (exec), a 4096 pids limit, a 3 GiB
memory limit, the data on one volume (`/data`) and the install on another (read-only unless said
otherwise), `tini` as PID 1, ports published on 127.0.0.1 only. The base image was
`node:24-trixie-slim` with exactly the packages of `docker/native`'s base stage (`ca-certificates
tini procps tzdata`); for TShock and tModLoader, Microsoft's .NET runtimes copied from
`mcr.microsoft.com/dotnet/runtime:9.0` (9.0.20) and `:8.0` (8.0.31) into `/usr/share/dotnet`, plus
`libicu76` where said. At most one server ran at a time.

**What ran.**
| Flavour | Build | From |
|---|---|---|
| vanilla | Terraria dedicated server **1.4.5.8** (network release **326**) | `https://terraria.org/api/download/pc-dedicated-server/terraria-server-1458.zip` |
| TShock | **6.2.1.0** ("Profoundly Collaborative (3.11)"), OTAPI 3.3.14, TerrariaAPI 2.1.0.0, for Terraria 1.4.5.8 | GitHub release `v6.2.1`, `TShock-6.2.1-for-Terraria-1.4.5.8-linux-x64-Release.zip` |
| tModLoader | **v2026.07.3.0** (stable), on Terraria **1.4.4.9** | GitHub release `v2026.07.3.0`, `tModLoader.zip` |

**Licences.** No agreement was shown or needed to download or run any of the three. The dedicated
server zip and TShock (GPLv3) download without an accept step; tModLoader's GitHub release is the
same build as Steam's. Steam lists two "tModLoader EULA" entries for app 1281930 (one marked
Workshop, `required 0`), which a person accepts in the Steam client; the product doesn't use the
Steam client for tModLoader (below). So no EULA gate is proposed; the owner may want to confirm.

**Players.** No real client was used. Joins, leaves, kicks and bans were driven by a small test
client written for the fact-finding (network release 326; 1.4.5 added five bytes to the player-info
packet; made-up names `gspff…`, random UUIDs), which only completes the connection handshake. It
joined vanilla and TShock, not tModLoader. What only a real client can show is listed at the end.

### Headline findings
1. **The world is silently not created without a writable save folder.** Terraria writes
   `favorites.json` into `$HOME/.local/share/Terraria` (or `-savedirectory`) while creating a world;
   with the product's read-only HOME the write fails, the game prints a "Failed to create the file"
   block, **creates no world**, and still says `Server started`; its exit save then does nothing
   (vanilla) or throws (TShock). `-savedirectory /data` (tModLoader: `-tmlsavedirectory`) fixes it.
2. **Most failures are silent exit 0s.** A taken port (after printing `Listening on port 7777`), a
   `-world` that doesn't exist without `-autocreate`, and a corrupt world all exit **0**; only the
   corrupt world prints something (`Load failed!  No backup found.`). Readiness must be
   `Server started`, never `Listening on port`.
3. **Vanilla crashes on a burst of reconnects.** Six quick connect-and-get-booted cycles (a wrong
   client version) crashed vanilla 1.4.5.8 with an unhandled `ObjectDisposedException` in the server
   loop, exit **1**, twice out of two tries; TShock survived 60. Any port scanner can do this to a
   public vanilla server: the crash watchdog (SRV-07) will see it.
4. **Console output carries the prompt.** The console prints its prompt `: ` without a newline, so
   the next line (`: Server started`, `: gspffbob has left.`) starts with `: `; vanilla's first line
   starts with two byte-order marks. The world menu's `Choose World: ` never ends its line, so the
   agent (which reads whole lines) can only catch the menu by its `n\t\tNew World` line.
5. **Saves are in place, not atomic.** `save` rewrites the `.wld` in place, validates it, then moves
   `.bak` to `.bak2` and writes the *previous* world to `.bak`. `Backing up world file` (tModLoader:
   `Saving modded world data`) marks the `.wld` complete. The console waits for the save; the save
   of a small world takes about 0.3 s.
6. **Signals.** SIGTERM kills vanilla and TShock at once without saving (exit 143); tModLoader
   saves first and exits 0. `exit` saves and exits 0 in 1–2 s on every flavour.
7. **Vanilla bans by IP only, and every player shares one IP behind Docker Desktop.** `ban <name>`
   writes the player's IP (with the name as a comment) to `-banlist`; through Docker Desktop's port
   publishing every client comes from the gateway (here `172.17.0.1`), so one ban locks everyone
   out. Without an absolute `-banlist` the command fails with `Invalid command.` (the game's working
   directory is its read-only install). TShock bans by name, account, UUID or IP.
8. **The language setting translates the console.** `language=es-ES` in `serverconfig.txt` turns
   `Server started` into `Servidor iniciado`, `Listening on port` into `Escuchando en puerto` and
   even renames some commands in `help`: the adapter must pin English.
9. **TShock needs .NET 9 and ICU and a bundle folder.** `TShock.Server` is a framework-dependent
   single-file app (app host 9.0.20): without .NET it exits 131, without ICU 134, and with a read-only
   HOME it can't unpack its bundle (exit 159) unless `DOTNET_BUNDLE_EXTRACT_BASE_DIR` is set.
10. **tModLoader can't be installed anonymously from Steam.** `app_update 1281930` as anonymous
    prints `Success! App '1281930' fully installed.` and installs **nothing** (app 1281930 is only
    downloadable by an account that owns Terraria, app 105600). The GitHub release zip is the way;
    anonymous **Workshop** downloads for 1281930 do work.
11. **TShock's REST API: anonymous status, 500s that succeed.** `/v2/server/status` answers without
    a token; creating a ban answers **500** (a null reference) whenever players are online but
    stores the ban anyway; ban tickets are `ticketNumber`. The command line (with any secret on it)
    goes to `ServerLog.txt`.
12. **GitHub counts 304s.** Anonymous API calls answered 304 to `If-None-Match` still used one of
    the 60 hourly calls: cache by time, not by ETag.

### Install and versions (UPD-01, UPD-02)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Vanilla version list | `GET https://terraria.org/api/get/dedicated-servers-names` → `["terraria-server-1458.zip","terraria-server-1458.zip"]`: only the newest, twice; JSON, an ETag, Cloudflare in front, sets a session cookie. There is no list of older versions. | Fetched; `vanilla/api/dedicated-servers-names*.json` | 2026-09-29 |
| Vanilla download | `https://terraria.org/api/download/pc-dedicated-server/terraria-server-<digits>.zip` (`1458` = 1.4.5.8), 200 with `content-disposition`, `last-modified`, `accept-ranges`; no checksum published anywhere. Older ones stay downloadable: 1450–1458, 1449, 1448, 1447, 1445, 1444, 1443, 1441, 1436, 1435, 1423, 1412 answered 200; unknown ids answer 404 `Not Found` (9 bytes) or sometimes **502** (1442, 1446). | `HEAD` probes; `vanilla/api/download-*.json` | 2026-09-29 |
| Vanilla zip | 46 415 317 bytes (sha256 `f513a4ac…8334`), 4.7 s; 77 entries under `1458/` for `Linux/`, `Windows/` and `Mac/`; only `1458/Linux/` (56 MB, 33 files) is needed. **No Unix modes stored**: `TerrariaServer` and `TerrariaServer.bin.x86_64` unpack as 0644 and exec fails (`Permission denied`, exit 126) until the installer sets 0755. | Downloaded, `unzip -Z`, a start before `chmod` | 1.4.5.8 |
| Vanilla binary | `TerrariaServer.bin.x86_64`: MonoKickstart, an x86-64 ELF with Mono built in; needs only glibc (`libm librt libdl libpthread libgcc_s libc`). `TerrariaServer` is a bash wrapper that `cd`s to its folder, sets `MONO_IOMAP=all` and passes `$@` **unquoted** (arguments with spaces break): call the binary directly. `lib64/` holds FNA's SDL3/FNA3D/FAudio (not loaded by the server). The version sits in `TerrariaServer.exe`. | `ldd`, `file`, reading the script | 1.4.5.8 |
| TShock releases | `GET https://api.github.com/repos/Pryaxis/TShock/releases` (and `/latest`, `/tags/<tag>`): `tag_name` (`v6.2.1`), `name` (`TShock 6.2.1 for Terraria 1.4.5.8`), `prerelease`, `published_at`, assets with `name`, `size`, `content_type`, **`digest: "sha256:…"`** (matched the download; older releases have none), `browser_download_url` (302 to `release-assets.githubusercontent.com`). Asset names: `TShock-<v>-for-Terraria-<t>-linux-{x64,arm64,arm}-Release.zip` (6.x; 5.2.4 used `amd64`; pre-releases `TShock-Beta-linux-<arch>-Release.zip`), plus osx-x64 and win-x64. The Terraria version a release targets is only in its name. | Fetched; `tshock/api/github-releases*.json` | 2026-09-29 |
| TShock zip | 34 419 595 bytes, 3.4 s; holds one tar (`TShock-Beta-linux-x64-Release.tar`, 101 MB, 52 entries) that **keeps** the exec bits: `TShock.Server` (19 MB), `TShock.Installer`, `ServerPlugins/TShockAPI.dll`, `bin/` (OTAPI, TerrariaServer.dll, HttpServer.dll), `i18n/`, `GeoIP.dat`; 98 MB unpacked. The arm64 zip (34 203 285 bytes) holds the same layout. | Downloaded, `tar -tvf`; `tshock/tree/install.txt` | 6.2.1 |
| TShock's .NET | `TShock.Server` is a framework-dependent single-file app host (9.0.20, `tfm net9.0`): it needs **Microsoft.NETCore.App 9.x** installed (`/usr/share/dotnet` or `DOTNET_ROOT`). `TShock.Installer` would fetch .NET 9.0.0 from `dotnetcli.azureedge.net` next to the server: not used. | Strings in the bundle, runs without .NET, TShock's source at `v6.2.1` | 6.2.1 |
| tModLoader releases | `GET https://api.github.com/repos/tModLoader/tModLoader/releases[/latest]`: monthly `vYYYY.MM.N.N` tags; stable ones are named `1.4.4-refs/heads/stable Version Update: …` with `prerelease: false`, previews `…/preview…` with `prerelease: true`; the list also holds old legacy tags re-published recently (`v2022.09.48.2` "1.4.3-Legacy", `v0.11.8.11`) as pre-releases. Assets `tModLoader.zip` and `ExampleMod.zip`, with sha256 digests. `/latest` gave `v2026.07.3.0`. | Fetched; `tmodloader/api/` | 2026-09-29 |
| tModLoader zip | 61 132 728 bytes (31 s this time), 1 328 entries, 170 MB unpacked: `tModLoader.dll`, `tModLoader.runtimeconfig.json` (`net8.0`, `Microsoft.NETCore.App 8.0.0`), `Libraries/` (managed and native: `Native/Linux`, `Native/Linux-arm64`, `Native/OSX`), `Content/`, `LaunchUtils/*.sh`, `start-tModLoaderServer.sh`, `serverconfig.txt`, `DedicatedServerUtils/` (its own Dockerfile, compose file and management script). Scripts stored 0644. | Downloaded; `tmodloader/tree/` | v2026.07.3.0 |
| tModLoader's .NET | Its scripts (`ScriptCaller.sh` → `InstallDotNet.sh`) install **exactly** the runtime version in `runtimeconfig.json` (8.0.0) with Microsoft's `dotnet-install.sh` into `<install>/dotnet` (`dotnet_arm64` on arm64), then run it with `DOTNET_ROLL_FORWARD=Disable`; with no local dotnet they fall back to the system's. Run directly as `dotnet tModLoader.dll`, it ran on the system's **8.0.31**. | Reading the scripts; runs | v2026.07.3.0 |
| tModLoader on Steam | App 1281930 is free (`isfreeapp 1`) but `mustownapptopurchase 105600` (Terraria): anonymous `app_update 1281930` prints success and installs no depot (`SizeOnDisk 0`, empty `InstalledDepots`). Branches: `public` (build 25047440), `1.3-legacy`, `1.4.3-legacy`, `preview-v2026.07`, `preview-v2026.08`; Linux depot 1281933 (174 MB). tModLoader's own `manage-tModLoaderServer.sh` also asks for a Steam user for this, and offers `--github` otherwise. | `tmodloader/steamcmd/app-update-anonymous.log`, `app-info-1281930.vdf` | 2026-09-29 |
| Rate limits | GitHub: 60 anonymous calls an hour per IP (`x-ratelimit-*` headers), **a 304 counts too**, `cache-control: max-age=60`. terraria.org advertised none. | `tshock/api/github-conditional-requests.json` | 2026-09-29 |

### Runtime needs per flavour (HST-05, §10)
| | vanilla | TShock | tModLoader |
|---|---|---|---|
| Runs in `gsp/native`'s base as it is | **yes** (nothing to add) | no | no |
| Needs | glibc | .NET runtime **9.x**, `libicu` (else set `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`), `libstdc++` (in the base), `ca-certificates` | .NET runtime **8.x**, `libicu` |
| Environment | `HOME` writable or `-savedirectory` | `DOTNET_BUNDLE_EXTRACT_BASE_DIR` on a writable folder (it unpacked only `libe_sqlite3.so`, 1.3 MB, so `/tmp` fits); `-savedirectory` | a **writable install folder** (it writes `<working dir>/tModLoader-Logs/`, and must run from its install folder); `-tmlsavedirectory` |
| Failure without | — | `You must install .NET to run this application.` (exit 131); `Couldn't find a valid ICU package` (134); `Failure processing application bundle.` (159) | `Could not load file or assembly 'ReLogic'` from another working directory (134); `tModLoader v2026.7.3.0 Fatal Error` / `Failed to init logging` with a read-only install (1) |
| CPU architectures | **amd64 only** (the binary is x86-64) | amd64 and arm64 builds published (arm64 not run) | amd64; the zip carries `Native/Linux-arm64` libraries and the scripts an arm64 path, but tModLoader's own README says ARM is not supported (not run) |

The .NET 8 and 9 runtimes copied from Microsoft's images take 144 MB together; with `libicu76` the
test image was 615 MB (the native base: 343 MB).

### Launch (SRV-01, SRV-05, NFR-04)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Command, vanilla | `/opt/game/<v>/TerrariaServer.bin.x86_64 -port 7777 -maxplayers <n> -world /data/worlds/<name>.wld -autocreate <1\|2\|3> -worldname <name> -savedirectory /data -banlist /data/banlist.txt [-config /data/serverconfig.txt] [-noupnp]`. Its working directory becomes its install folder whatever the container's is, so **every path must be absolute**. | Runs; `/proc/<pid>/cwd` | 1.4.5.8 |
| Command, TShock | `/opt/game/<v>/TShock.Server` + the vanilla flags + `-configpath /data/tshock -logpath /data/tshock/logs -crashdir /data/tshock/crashes [--rest-enabled true --rest-port 7878]`, working directory `/data` (TShock keeps it: `ServerLog.txt` lands there). Env: `DOTNET_BUNDLE_EXTRACT_BASE_DIR=/tmp/dotnet-bundle`. | Runs | 6.2.1 |
| Command, tModLoader | `dotnet /opt/game/<v>/tModLoader.dll -server -nosteam -port 7777 -maxplayers <n> -world /data/tml/Worlds/<name>.wld -autocreate <n> -worldname <name> -tmlsavedirectory /data/tml -steamworkshopfolder /data/.workshop/steamapps/workshop`, working directory **the install folder**. Its start script can't be used: it `chmod`s and writes into the install and asks `Use steam server (y/n)` unless `-steam`/`-nosteam`. | Runs; `tmodloader/logs/` | v2026.07.3.0 |
| Flags that exist | vanilla: `-config -port -maxplayers/-players -pass/-password -motd -world -worldname -autocreate -savedirectory -banlist -secure -noupnp -seed -lang/-language -ip -forcepriority -worldrollbackstokeep -disableannouncementbox -announcementboxrange -autoshutdown -logfile -logerrors -loadlib`, plus Steam lobby ones. TShock adds `-configpath -logpath -logformat -logclear -worldselectpath -worldevil -dump --rest-enabled --rest-port --rest-token` and (its API) `-crashdir -additionalplugins -ignoreversion -difficulty -disable-commands -forceupdate -heaptile -constileation -asyncmono -skipassemblyload -nolog`. tModLoader adds `-server -steam -nosteam -tmlsavedirectory -steamworkshopfolder -modpath -modpack -skipselect -showserverconsole -publicity`. | Strings in the assemblies; TShock's source | the three |
| No world given | The world menu (`n\t\tNew World`, `d <number>\tDelete World`, tModLoader adds the worlds found and `m\t\tMods List`, then `Choose World: ` without a newline) and it waits for input forever; it doesn't spin (0 % CPU) and the end of stdin changes nothing. Typing anything else redraws it. | `*/logs/*world-menu.log` | the three |
| `-world` present, missing, no `-autocreate` | Exits **0** after `Error Logging Enabled.`, silently. With `-autocreate` an existing world is loaded and a missing one created: always pass it. | `vanilla/logs/missing-world-no-autocreate.log` | vanilla |
| World path | Vanilla and TShock create the world at `-world`; **tModLoader ignores `-world` when creating** and writes `<-tmlsavedirectory>/Worlds/<worldname>.wld` (+ `.twld`); give it that path. | File lists | the three |
| Sizes | `-autocreate 1/2/3` = small 4200×1200, medium 6400×1800, large 8400×2400. `difficulty=` (config) 0–3; `seed=` takes text (`Seed: gsp-seed`). | `Creating world - Seed: …, Width: …, Height: …, Evil: -1, Difficulty: <n>` | vanilla |
| No other prompt | With `-world` (or `-config` naming one) nothing else is asked; without `-port` it listened on 7777. | Runs with only `-world` | vanilla, TShock |
| Files a first boot writes | vanilla: the `.wld`, `favorites.json` in the save folder (and an empty `Worlds/` there), nothing else; `banlist.txt` at the first ban. TShock adds `tshock/{config.json, sscconfig.json, motd.txt, rules.txt, whitelist.txt (CRLF), tshock.sqlite, tshock.pid, setup-code.txt, logs/<date>.log}` and `/data/ServerLog.txt`. tModLoader: `<save>/Mods/enabled.json` (`[]`), `<save>/Worlds/<name>.{wld,twld}` (+ `.bak`), `<save>/favorites.json`, `<save>/Worlds/Backups/<date>-<name>.zip` (a zip of the world named by the date, made when it loaded an existing world, 1.1 MB), `<install>/tModLoader-Logs/{server.log, environment-server.log, Old/}`. | `*/tree/`, `*/files/` | the three |
| Stdin | Commands work on stdin; lines typed before the server is ready wait for it (an `exit` typed during generation ran right after it); the end of stdin changes nothing. | Console sessions | the three |
| Logs | Everything on stdout (vanilla's unhandled exception also on stderr); no log file for vanilla. TShock also writes `tshock/logs/<date>.log` (with `Server executed: …` and `World saved at (…)`) and `ServerLog.txt`; tModLoader `tModLoader-Logs/server.log` (why each mod was picked or skipped). World generation prints one line per progress step: about **30 000 lines** for a small world (TShock prints only phase names). | Captures | the three |

### Readiness and logs (CON-01, SRV-07)
Lines as the console prints them, after dropping leading byte-order marks and `: ` prompts.
| Line | Meaning | Flavours |
|---|---|---|
| `Server started` | ready (`: Server started` on vanilla) | all |
| `Listening on port <n>` | printed just before, even when the port is taken | all |
| `Terraria Server v1.4.5.8` / `Terraria Server v1.4.4.9` | game version (tModLoader's `version` command: `Terraria Server v1.4.4.9 - tModLoader v2026.7.3.0`) | all |
| `TShock 6.2.1.0 (Profoundly Collaborative (3.11)) now running.`, `TerrariaAPI Version: 2.1.0.0 (Protocol v1.4.5.8 (326), OTAPI 3.3.14+ca9c239)` | TShock build and the protocol it speaks | TShock |
| `Adding Content: tModLoader v2026.7.3.0` | tModLoader build (nothing else on stdout names it) | tModLoader |
| `Creating world - Seed: <s>, Width: <w>, Height: <h>, Evil: -1, Difficulty: <n>` (tModLoader: `IsExpert: False`) | a world is being generated | all |
| `<ip>:<port> is connecting...`, `<name> has joined.` (TShock adds `<name> has joined. IP: <ip>`), `<name> has left.` | players | vanilla, TShock |
| `<ip>:<port> was booted: <reason>` | refused or kicked (`You are not using the same version as this server.`, `Name is too long.`, `Kicked from server.`, `Banned from server.`, `You are banned from this server.`, TShock `Kicked: <reason>`, `#<ticket> - You are banned: <reason>`) | vanilla, TShock |
| `Backing up world file` | a save's `.wld` is written | vanilla, TShock |
| `Saving modded world data` | a save's `.wld` is written (then the `.twld`) | tModLoader |
| `Sandboxing: <mod> v<version>` | a mod is being loaded | tModLoader |
| `Failed to create the file: "\home\node\.local\share\Terraria\favorites.json"!` | **fatal in effect**: no world will be created | all |
| `Load failed!  No backup found.` + an exception (with a `.bak` the game copies it over the broken `.wld` and still exits) | corrupt world; exit 0 | all |
| `[ERROR] FATAL UNHANDLED EXCEPTION: …` (stderr) after a `==== … Unhandled Exception` block | crash; exit 1 | vanilla |
| `You must install .NET to run this application.` / `Process terminated. Couldn't find a valid ICU package …` / `Failure processing application bundle.` | runtime missing | TShock |
| `tModLoader v2026.7.3.0 Fatal Error` / `Unhandled exception. System.IO.FileNotFoundException: Could not load file or assembly 'ReLogic…` | tModLoader can't start | tModLoader |
| `n\t\tNew World` | the world menu: nobody will answer it | all |
| `To setup the server, join the game and type /setup <code>` | TShock's first-run code (a secret: whoever types it becomes superadmin) | TShock |
| `"<user>" requested REST endpoint: <path?query without the token>` / `Anonymous requested REST endpoint: …` | a REST call, when `LogRest` is on | TShock |

### Config (CFG-01…09)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| `serverconfig.txt` | `key=value` lines, `#` comments; read at start only (`-config <file>`), **never written** by the game (the file was byte-identical after a run). Keys the game knows (from the sample in the zip, whose text is Re-Logic's and not copied here): `world worldpath worldname autocreate seed difficulty maxplayers port password motd banlist secure language upnp npcstream priority worldrollbackstokeep` (tModLoader adds `modpath modpack`); an unknown key was ignored. UTF-8 values worked (`motd=From config ☃` came back from `motd`). Flags on the command line override the file. | `vanilla/files/serverconfig.txt`, `vanilla/logs/config-language-es.log` | vanilla (tModLoader shares the format) |
| `language` | Translates the console (lines and some command names): must be `en-US` for the adapter to read it. | Same run | vanilla |
| TShock `tshock/config.json` | `{ "Settings": { … 145 keys } }`, 2-space indent, **no final newline**. Rewritten at every start: missing keys completed with defaults, given values kept (UTF-8 as is), **unknown keys dropped** (also top-level ones). CLI flags override `ServerPort`, `MaxSlots`, `RestApiEnabled`, `RestApiPort` (and say so). Defaults worth knowing: `RestApiEnabled false`, `RestApiPort 7878`, `LogRest false`, `ApplicationRestTokens {}`, `AutoSave true`, `BackupInterval 10`, `BackupKeepFor 240`, `SaveWorldOnLastPlayerExit true`, `EnableGeoIP true`, `KickProxyUsers true`, `KickEmptyUUID true`, `DisableUUIDLogin false`, `StorageType sqlite`, `SqliteDBPath tshock.sqlite`, secrets `ServerPassword`, `MySqlPassword`, `PostgresPassword`, the token keys. | `tshock/config/config.json.generated`, `tshock/logs/partial-config-boot.log` | 6.2.1 |
| TShock's other files | `sscconfig.json` (JSON), `motd.txt`, `rules.txt` (text with `[c/rrggbb:…]` colour tags and `%map%`-style fields), `whitelist.txt` (one IP or CIDR per line, `#` comments, **CRLF**), `tshock.sqlite` (SQLite, journal mode **delete**, tables `Users`, `PlayerBans`, `GroupList`, `Regions`, `Warps`, `ItemBans`, `TileBans`, `ProjectileBans`, `RememberedPos`, `Research`, `tsCharacter`). | Files; `sqlite3` | 6.2.1 |
| tModLoader's mod list | `<save>/Mods/enabled.json`: a JSON array of mod names (`["RecipeBrowser"]`); the Workshop item's `workshop.json` and steamcmd's `appworkshop_1281930.acf` are metadata. ModConfigs: not seen (the one mod tried has none on the server). | `tmodloader/files/` | v2026.07.3.0 |

### Control (CON-02, CON-03, CON-04, PLY-03)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Vanilla console | `help` lists `help playing clear exit exit-nosave save kick ban password version time port maxplayers say motd dawn noon dusk midnight settle seed` (tModLoader adds `customsets modlist`). Replies: `playing` → `<name> (<ip>:<port>)` per player then `1 player connected.` / `<n> players connected.` / `No players connected.`; `version` → `Terraria Server v1.4.5.8`; `time` → `Time: 8:15 AM`; `port` → `Port: 7777`; `maxplayers` → `Player limit: 8`; `motd` → `MOTD: <text>` (`motd <text>` sets it, silently); `password` → `No password set.` / `Password: <password>` **in clear text** (`password <p>` sets and prints it); `say <text>` → `<Server> <text>`; `seed` → `World Seed: 1.1.2.0.<seed>`; `settle` → `Forcing water to settle.`; unknown → `Invalid command.`. `kick`/`ban` of a name nobody has: **no output at all**. `clear`, `dawn`… print nothing. | `vanilla/logs/console-session.log`, `vanilla/console/*.json` | 1.4.5.8 |
| Vanilla `kick <name>` / `ban <name>` | `<ip>:<port> was booted: Kicked from server.` / `… Banned from server.`, then `<name> has left.`; the ban appends `//<name>` and `<ip>` to `-banlist` and later connections from that IP get `You are banned from this server.`. There is no unban command (edit `banlist.txt` while stopped). | `vanilla/logs/players.log`, `vanilla/files/banlist.txt` | 1.4.5.8 |
| TShock console | Every line is a TShock command (with or without `/`), echoed as `Server executed: /<cmd>.` (and into its log). `who`/`playing` → `There are currently no players online.` or `Online Players (<n>/<max>)` + `<a>, <b>`; `kick <name> [reason]` → booted line, `Kicked <name> for : '<reason>'`, `Server kicked <name> for '<reason>'`, `<name> has left.` (unknown: `Player not found. Unable to kick the player.`); `ban add <online name> [reason]` (offline: `Could not find the target specified. …`), `ban list` (`Bans (1/1):` then `[<ticket>] <identifier>`), `ban del <n>` (unknown ticket: `Command failed, check logs for more details.`); `say`/`broadcast` → `(Server Broadcast) <text>`; `version` → `TShock: 6.2.1.0 Profoundly Collaborative (3.11).`; `setup` → `You must use this command in-game.`; unknown → `Invalid command entered. Type /help for a list of valid commands.`; `exit` and `off` save then shut down (`Server shutting down!`, `Saving before exit...`), `off-nosave` doesn't save. | `tshock/logs/first-boot.log`, `…/setup-lock-players-moderation.log` | 6.2.1 |
| TShock REST: enabling | `RestApiEnabled: true` in `config.json` or `--rest-enabled true`; it listens on `0.0.0.0:<RestApiPort>` (TCP 7878), no bind-address setting. Auth: an **application token** in `ApplicationRestTokens` (`{ "<token>": { "Username": "<name>", "UserGroupName": "superadmin" } }`) works at once; `--rest-token <t>` adds a superadmin token too but the command line is written to `ServerLog.txt`; `/v2/token/create?username=&password=` needs a TShock account with REST rights (403 otherwise). The token goes in the query (`?token=`); `LogRest` never logs it. | `tshock/rest/*.json`, `tshock/logs/rest-session.log` | 6.2.1 |
| TShock REST: endpoints (GET with query parameters; `POST` answered the same; JSON with `"status": "<code>"`) | `/status`, `/v2/server/status[?players=true&rules=true]` **anonymous**; `/tokentest` (`associateduser`); `/v2/players/list` (`nickname username group active state team`); `/v3/players/read?player=` (ip, group, position, inventory), `/v4/players/read`; `/v2/players/kick?player=&reason=` (`Player <n> was kicked`; unknown: 400 `Player <n> was not found`); `/v2/players/mute`; `/v3/bans/create?identifier=<name:\|acc:\|uuid:\|ip:><value>&reason=` (**500 while players are online**, ban stored; no kick); `/v3/bans/list` (`ticket_number identifier reason banning_user start_date_ticks end_date_ticks`, .NET ticks, "forever" = 3155378976000000000); `/v3/bans/read?ticketNumber=` (unknown: 200 `No matching bans found.`); `/v3/bans/destroy?ticketNumber=[&fullDelete=true]` (unknown ticket: 500); `/v2/server/broadcast?msg=`; `/v3/server/rawcmd?cmd=/<command>` (lines as an array, colour tags kept; without `/`: invalid); `/v2/world/save` (`World saved`, after the save lines); `/v2/server/off?confirm=true&nosave=false&message=` (players get the message, saves, exit 0 in ~1 s; without `confirm`: 400); `/v2/users/{create,list,read,update,destroy}` (`?user=&type=name&password=&group=`), `/v2/groups/{list,read}`. A bad token: 403 `Not authorized. The specified API endpoint requires a token, but the provided token was not valid.`. | Same | 6.2.1 |
| TShock setup code | Printed and written to `tshock/setup-code.txt` at every start **unless** `tshock/setup.lock` exists or any account exists. Creating an empty `setup.lock` before the first start skips it headlessly; accounts (and superadmins) can then be made over REST (`/v2/users/create?…&group=superadmin`). | `…/setup-lock-players-moderation.log`; TShock's source | 6.2.1 |
| TShock groups | `guest` (not logged in), `default`, `vip`, `newadmin`, `admin`, `trustedadmin`, `owner`, `superadmin` (`*`). Players who never registered stay `guest`; UUID login is on by default. | `/v2/groups/list`, `/v2/groups/read` | 6.2.1 |
| `exit` | Saves (`Saving before exit...`) and exits **0**: vanilla 1.0–1.1 s small world, 2.2 s large; TShock 1.2 s; tModLoader 1.4–2 s. `exit-nosave` exits 0 in 0.9 s, world untouched. | Timestamps | all |
| SIGTERM | vanilla and TShock: exit **143** at once, **no save**. tModLoader: `Saving before exit...`, saves, exit **0** in 1.8 s. | File times before and after | all |

### Saving and backups (BAK-01, BAK-02)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| `save` | Synchronous on the console: `Saving world data: <n>%` …, `Validating world save: <n>%` …, then `Backing up world file` (TShock prints the steps without percentages; tModLoader ends with `Saving modded world data`); 0.28 s for a small world. | Console captures | all |
| How a save writes | The old `.wld` is read, the new one **written in place** (no temp file, no rename), read back to validate, then `.bak` becomes `.bak2` and the **old** world is written to `.bak`. So after a save `.wld` is the new world, `.bak` the previous save, `.bak2` the one before. tModLoader does the same for `.twld`. | `inotifywait` on the folder (`vanilla/tree/save-file-events.txt`), sizes of `large1.wld` / `.bak` | vanilla, TShock, tModLoader |
| When it saves on its own | At `exit`, when the **last player leaves** (vanilla; TShock's `SaveWorldOnLastPlayerExit`, which counts only players who finished joining), and TShock every `BackupInterval` minutes into its own backups (not observed in the short runs). tModLoader zips the world into `Worlds/Backups/<date>-<name>.zip` when it loads it. | Captures | the three |
| Copying while running | The `.wld` is only consistent between saves; a save can start whenever the last player leaves. A copy right after `Backing up world file` is complete (the files are small: 2.9 MB small, 6.8 MB medium, 11.5 MB large). `tshock.sqlite` uses a rollback journal (`delete`), no WAL: a snapshot through SQLite is safe. | Timings, `sqlite3` | the three |
| Restoring | Putting a `.wld` back and starting works; a broken `.wld` with a `.bak` next to it makes the game copy the `.bak` over it (and exit 0 that time). | `vanilla/logs/corrupt-world-*.log` | vanilla |

**Procedure proposed (BAK-02): save, then copy.** Send `save` (TShock: `/v2/world/save` or the
console) and wait for `Backing up world file` (tModLoader: `Saving modded world data`), then copy the
world files **without** their `.bak`/`.bak2`, then the rest; snapshot `tshock.sqlite` through SQLite.
There is no save-off: a player leaving during the copy can trigger a save, so re-copy a world file
that changed while it was read (its mtime moved). With nobody online, nothing writes between saves.

### Mods and plugins (MOD-03, MOD-06)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Workshop downloads | `steamcmd +force_install_dir /data/.workshop +login anonymous +workshop_download_item 1281930 <id> +quit` works anonymously (7 s, 1.4 MB for Recipe Browser `2619954303`). Item layout: `steamapps/workshop/content/1281930/<id>/<tML version YYYY.M>/<ModName>.tmod` for several versions (`2022.9`, `2025.6`, `2025.9`, `2026.7`) plus `workshop.json` (`SteamEntryId`, `Tags` incl. Terraria versions). The mod's internal name is the `.tmod` file name. | `tmodloader/steamcmd/workshop-download.log`, `tmodloader/files/` | 2026-09-29 |
| How tModLoader picks them | `-steamworkshopfolder <…>/steamapps/workshop` + the name in `<save>/Mods/enabled.json`: it takes the newest version folder its own version accepts and says so in `server.log` (`Selected RecipeBrowser 0.12.0.3 for tML 2026.7.3.0 from Workshop.`, `Skipped … Reason: a newer version exists.` / `… for a different Terraria version/LTS release stream.`); stdout shows `Sandboxing: Recipe Browser v0.12.0.3`, `Adding Content: …`; `modlist` → `Recipe Browser`. Mods load only at start. | `tmodloader/logs/boot-with-workshop-mod.log`, `files/server-log-head.log` | v2026.07.3.0 |
| TShock plugins | Loaded from `ServerPlugins/` next to `TShock.Server` (the install folder), at start only; a loaded one prints `[Server API] Info Plugin <Name> v<ver> (by <author>) initiated.` (seen for TShock itself). A garbage `.dll` and a non-plugin .NET assembly there were **ignored without a word**; `-additionalplugins /data/plugins` with the same files printed nothing either. A real third-party plugin (and its failure) was not tried. | `tshock/logs/broken-plugin-ignored.log`, `ServerLog.txt` | 6.2.1 |

### Ports (SRV-01, SRV-08, NFR-03)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Listening | TCP **7777** on `0.0.0.0` (game); TShock also TCP **7878** on `0.0.0.0` when REST is on; each server also holds one ephemeral UDP socket (not a listener to publish). No other TCP listener. | `/proc/net/{tcp,tcp6,udp,udp6}` | the three |
| Published port | A client reached the game through a different host port (30550 → 7777): the port inside need not match. | The test client | vanilla, TShock |
| Source address | Through Docker Desktop's published port every client appears as the gateway (`172.17.0.1`). | Join and ban lines | Docker Desktop |

### Memory, CPU and time (SRV-05, NFR-04)
| | vanilla | TShock | tModLoader |
|---|---|---|---|
| RSS at the world menu / before the world | 308 MiB | 276 MiB (no world) | 402 MiB |
| RSS idle, small world | 527–540 MiB (cgroup 525 MiB) | 396 MiB (cgroup 335 MiB) | 986 MiB first boot, 704 MiB later with one mod (`docker stats` 918 / 628 MiB) |
| RSS idle, medium / large world | 912 MiB / 1.14 GiB (peak 1.23 GiB, cgroup peak 1.22 GiB) | not measured | not measured |
| CPU idle, small world, nobody online | ~5 % of one core | ~12 % | ~6 % |
| World generation | small 37 s, medium 92 s, large 211 s | small 95 s | small 30 s (+11 s "engine preload") |
| Start with an existing small world | 5.4 s | 6.8 s | 19.5 s (one mod) |

One amd64 host (12 cores), no players, one run each: treat as orders of magnitude.

### Per-flavour differences
| | vanilla | TShock | tModLoader |
|---|---|---|---|
| Terraria | 1.4.5.8 | 1.4.5.8 | **1.4.4.9** (its players need tModLoader, i.e. Terraria on Steam) |
| Binary | `TerrariaServer.bin.x86_64` (Mono inside) | `TShock.Server` (.NET 9) | `dotnet tModLoader.dll` (.NET 8) |
| Source | terraria.org zip, no checksum | GitHub zip with sha256 digest (tar inside) | GitHub zip with sha256 digest (not Steam) |
| Working directory | forced to its install folder | kept (`/data`) | must be its install folder (writes logs there) |
| Save folder flag | `-savedirectory` | `-savedirectory` | `-tmlsavedirectory` |
| First line | two BOMs + `Error Logging Enabled.` | `Error Logging Enabled.` | `Finding Mods...` (after ~6 s of silence) |
| Control | stdin | stdin + REST | stdin |
| Bans | IP (`-banlist`) | name, account, UUID, IP (SQLite) | IP (`-banlist`) |
| SIGTERM | no save, 143 | no save, 143 | saves, 0 |
| Own backups | `.bak`, `.bak2` | `.bak`, `.bak2`, `tshock/backups` | `.bak`, `.bak2`, `Worlds/Backups/*.zip` |
| Reconnect burst | crashed (exit 1) | survived | not tried |

### Keys the panel manages (CFG-04), proposed
| File | Key | Value | Why |
|---|---|---|---|
| launch flags (all) | `-port` | the container's game port (7777) | the agent's port |
| | `-world`, `-worldname`, `-autocreate` | from the launch settings; `-autocreate` always | the world the backups and resets name |
| | `-savedirectory` / `-tmlsavedirectory` | `/data` / `/data/tml` | the world is created at all (finding 1) |
| | `-banlist` | `/data/banlist.txt` | absolute, in the data root |
| `serverconfig.txt` | `language` | `en-US` | the console must be English |
| | `port`, `world`, `worldpath`, `autocreate`, `banlist` | as the flags | flags win; kept consistent |
| | `password` | secret | masked |
| | `upnp` | `0` | nothing opens router ports (§4) |
| TShock `config.json` | `RestApiEnabled` | `true` | CON-04 |
| | `RestApiPort` | 7878 (`ctx.ports.rest`) | the agent's port, never published |
| | `ApplicationRestTokens` | `{ "<control secret>": { "Username": "gameserver-panel", "UserGroupName": "superadmin" } }` | secret; agent-owned |
| | `LogRest` | `false` (or true: the token never shows) | quieter logs |
| | `ServerPort`, `MaxSlots` | as the flags | the flags override them anyway |
| | `ServerPassword`, `MySqlPassword`, `PostgresPassword` | (secret) | masked |
| TShock `setup.lock` | — | created empty before the first start | no setup code |

Every key takes effect at the next start (`restartKeys: '*'`) except what TShock's `/reload` re-reads
(not measured).

### Open questions (for the integrator and the owner)
- **Which runtime image for TShock and tModLoader?** Measured: both run on `node:24-trixie-slim` with
  Microsoft's .NET 9 and 8 runtimes copied in and `libicu76`; vanilla needs nothing. One image (the
  native family plus .NET) or a `dotnet` family? tModLoader's Steam depots aren't anonymous, so it
  doesn't need `gsp/steam` for its install, only steamcmd for Workshop mods.
- **Vanilla's IP bans behind Docker Desktop** ban every player at once: hide `ban` for vanilla and
  tModLoader on such hosts, or offer it with a warning?
- **Vanilla's reconnect crash**: accept it (the watchdog restarts the server), or steer public
  servers to TShock?
- **.NET 9 support ends in November 2026** (TShock says it moves to .NET 10 next): the image will
  need 10 when TShock does.
- TShock's `/reload` (and REST `/v3/server/reload`) re-reads `config.json`: which keys apply live
  was not measured.

### Unverified: needs a real client (the owner will check)
- Joining each flavour from a real Terraria client (tModLoader: from tModLoader), with and without a
  server password (`-password`; the client is asked for it, packet 37).
- What players see: `say` and TShock broadcasts, the kick and ban messages, the world's MOTD.
- TShock's UUID login, `/register`, `/login`, `/setup` with a real client; SSC off by default.
- Joins and leaves on tModLoader (the test client speaks only the vanilla handshake).
- Memory, CPU and save and stop times with players and with medium and large worlds (the stop
  budget); tModLoader with heavy mods (hundreds of MB to GBs).
- A real TShock plugin loading and failing; a tModLoader mod with server-side ModConfigs.
- arm64 hosts (TShock publishes arm64 builds; vanilla has none; tModLoader says it has none).
- Real client addresses on a Linux host (Docker Engine keeps them; Docker Desktop doesn't).
