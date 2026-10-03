# Shared installs verification log

Facts measured for HST-09 and D12 (M7, phase 1: fact-finding before any code), on real game
servers, not taken from wikis or forums (D5). Each entry says how it was verified and what it
holds for. Captures live in `fixtures/shared-installs/` (its README describes the layout and the
scrubbing). The design these facts lead to is proposed to the integrator separately; this log
holds what was measured.

## M7-0 fact-finding — 2026-10-03

**Setup.** Docker Desktop 29.7.2 (Linux engine, amd64, 12 cores, 15.6 GiB for Docker). The
product's runtime images built from this branch with `node scripts/stack.mjs build steam java
native` (tag `s5`: `gsp/steam` 887 MB, `gsp/java` 1.02 GB, `gsp/native` 511 MB), each running the
product's own agent and adapters. Every container was shaped as the orchestrator makes them:
user 1000:1000, read-only root, a 256 MB `/tmp` tmpfs (exec), all capabilities dropped,
`no-new-privileges`, 4096 pids, private IPC, a memory limit with no swap (the game's memory plus
its adapter's overhead: 2.25 GiB for Avorion and Terraria, 3 GiB for Minecraft, 3.25 GiB for
Valheim, 5 GiB for Project Zomboid), named volumes only, no published ports (nothing had to be
joined), the default bridge network. One game server ran at a time.

Three kinds of container, driven through the agent's HTTP API from inside each one, with its
token, the way the panel drives it:

- **Install job:** the runtime image with the install volume **read-write** at `/opt/game`, a
  scratch data volume at `/data` and, for the steam image, a fresh HOME volume at `/home/node`
  (seeded from the image, as the orchestrator's steam volume is); network on, no ports. `PUT
  /v1/launch`, then `POST /v1/install`, then the container and its scratch volumes were removed,
  keeping only the install volume.
- **Read-only run:** another container with the same install volume mounted **read-only** at
  `/opt/game`, and fresh data (and HOME) volumes: `PUT /v1/launch`, `POST /v1/start` until
  running, `POST /v1/save`, a running backup (`POST /v1/archive/pack` of the world and its
  settings, which runs the game's own hot-copy steps), `POST /v1/stop`, a second start on the
  same world and a second stop.
- **Read-write run:** the same steps with the install mounted read-write, on fresh data volumes.
  The install was listed before and after (every entry's type, mode, size, time and link target,
  and the SHA-256 of every file), and the two listings compared: what the run created, changed,
  deleted or only touched.

After every run: `find -newermt <start>` over each volume (what the run wrote, by path), and
`docker diff` of the container (writes outside the volumes and `/tmp`: none in any run).

**What ran.**
| Game, flavour | Build | Installed from |
|---|---|---|
| Project Zomboid | Steam app 380870, public branch, build **25485538**, prints `42.21.0` | steamcmd, anonymous |
| Minecraft vanilla | **26.3** | Mojang's server jar |
| Minecraft Paper | **26.2 build 129**, STABLE (26.3 has only BETA builds today: 143 is the newest) | PaperMC's Fill v3 |
| Minecraft Fabric | **26.3**, Fabric Loader **0.19.5**, installer 1.1.2 | Fabric's maven |
| Terraria vanilla | **1.4.5.8** | terraria.org's zip |
| Terraria TShock | **v6.2.1** (Terraria 1.4.5.8) | GitHub release |
| Terraria tModLoader | **v2026.07.3.0** (Terraria 1.4.4.9) | GitHub release |
| Valheim | Steam app 896660, public branch, build **25527701**, prints `1.0.16` | steamcmd, anonymous |
| Avorion | Steam app 565060, public branch, build **22295362**, prints `2.5.13`; branch `previous`, build 21146556 (2.5.11), for the update | steamcmd, anonymous |

**EULA.** `eula=true` was written for the Minecraft runs only, on these throwaway test servers,
as in the M3 fact-finding (the launch carried `eulaAccepted: true`); the product never writes it
without the owner's acceptance (D6).

**Players.** None: no client joined. Nothing here depends on one.

### Headline findings
1. **Every game ran with its install read-only, six of the nine as they are.** Project Zomboid
   (without mods), Valheim, Avorion, Paper, vanilla Terraria and TShock (the game itself) booted,
   saved, were copied hot, stopped and started again with the install mounted read-only, and their
   read-write runs changed not one byte of it (SHA-256 of every file, before and after). The others
   write into their install in three ways, each fixed below: Minecraft's first unpack (vanilla and
   Fabric), tModLoader's logs, and Project Zomboid's Workshop downloads.
2. **Minecraft vanilla and Fabric unpack Mojang's bundler on their first start** into the install
   (`versions/26.3/server-26.3.jar` and 39 libraries, 69.6 MB): read-only, the bundler fails
   (`/opt/game/versions: Read-only file system`, `Failed to extract server libraries, exiting`,
   exit 0; Fabric: `Error invoking MC server bundler`, exit 1) and the agent restarts it in a loop.
   **Fixed by a warm-up in the install job:** `java -DbundlerRepoDir=/opt/game -jar
   /opt/game/server.jar --help` unpacks exactly those files in 3.3 s and exits 0 without starting a
   server; both then ran read-only. Paper needs nothing: its patch-only install step already
   leaves everything in place.
3. **tModLoader writes its logs into its install folder** (`tModLoader-Logs/`, and refuses to
   start without it: `Failed to init logging`, exit 1). **A symlink redirects it:** with
   `tModLoader-Logs` made a link to `/data/tModLoader-Logs` in the install, it ran read-only and
   logged into the server's data, **provided the target folder exists** (a dangling link fails
   like no link at all).
4. **The product's own agent writes into TShock's install, not TShock.** Before every start the
   agent copies the enabled plugins into `ServerPlugins/` and writes its record there, even with
   no plugins, so a read-only TShock never starts (`Could not prepare the start: EROFS`). TShock
   itself loads a real plugin read-only both ways measured: from `-additionalplugins
   /data/plugins`, and from `ServerPlugins` made a symlink into `/data`.
5. **Project Zomboid downloads Workshop mods into its install** at every start
   (`steamapps/workshop/`). Read-only, Steam can't (`Install library folder not found`), the game
   throws a `NullPointerException` and exits 0. **A symlink redirects it:** with
   `steamapps/workshop` a link to `/data/.workshop/steamapps/workshop` (the target created first),
   it downloaded the mod into the server's data and loaded it, read-only.
6. **A redirect is a symlink in the install (made by the install job), and the agent's file API won't follow it**
   (403 `Symbolic links are not followed`): what lands behind it is read through the `data` root.
7. **steamcmd needs the install writable only while it installs.** An install job's volume, mounted
   read-only elsewhere, gives the agent everything it reads (`steamapps/appmanifest_<app>.acf`:
   branch and build). On a read-only install, `app_update` with nothing to download still answers
   `Success! … already up to date`, `validate` fails after about 2 minutes (`Update state (0x0) :
   Timed out waiting for update to start, bailing`, `state is 0x204`), and `app_info` (the version
   list) works, as it writes only HOME.
8. **An update installed beside the old one can start from a local copy of it:** a copy of a
   7.2 GB install takes 41 s against 237 s to download it, and steamcmd, run on the copy, downloads
   only what changed (Avorion 2.5.11 → 2.5.13: 15.8 MB instead of 56.9 MB), **replacing** each
   changed file (a new inode; no file was rewritten in place).
9. **A beta branch sticks to an install:** `app_update` without `-beta` on an install of another
   branch answers `already up to date` and stays on it (Avorion `previous`); `-beta public` moves
   it. The adapters pass no `-beta` for `public`, so today a server switched from a beta back to
   `public` keeps the beta's files without a word.
10. **Installs are immutable once their job ends,** so their size is measured once: from 56 MB
   (vanilla Terraria) to 6.9 GB (Project Zomboid). Steam HOME volumes are the other per-server
   copy: 204 MB each, seeded from the steam image.

### Per game
"Read-only" is the install mounted read-only through boot (a new world), a save, a running backup,
a stop, a second start and a stop. "Writes" is what the read-write run changed in the install
(created, changed or deleted, by SHA-256). Install time is the agent's `POST /v1/install` in the
job (network on this host; Steam's and the download services' speed vary). Size is `du -sb` of the
install volume after the job; the file count is files only.

| Game, flavour | Install job | Size (files) | Starts read-only | Writes into the install at runtime | Redirect | Notes |
|---|---|---|---|---|---|---|
| Project Zomboid 42.21.0 | 237 s, steamcmd (1.98 GB downloaded) | 7 206 116 309 B (39 186) | **Yes**: running in 84.7 s, save 0.5 s, running backup 5.9 MB, stop 14.2 s exit 0; again 64.5 s | None without mods. With Workshop mods, every start: `steamapps/workshop/{appworkshop_108600.acf, content/108600/<id>/…, downloads/, temp/}`; read-only, a start with mods exits 0 after 9 s (a `NullPointerException`) | **Yes:** `steamapps/workshop` → `/data/.workshop/steamapps/workshop`; the target must exist before the start | `-cachedir=/data` keeps every world, ini and log in data. The `libjsig.so` preload warning (`start-server.sh`) prints read-only and read-write alike. |
| Minecraft vanilla 26.3 | 21.1 s; peak 149 MiB | 62 294 879 B (2): `server.jar`, the marker | **No** as installed: the bundler's first unpack fails (exit 0, crash loop). **Yes** after the warm-up: running in 17.2 s, save 2.5 s, backup 2.3 MB, stop 0.7 s; again 12.1 s | First start only: `versions/26.3/server-26.3.jar` (26.7 MB) + 39 jars under `libraries/` (69.6 MB in all); nothing after | Not needed: the job runs the warm-up, the unpacked files are then part of the install (131 848 443 B, 42 files) | The warm-up prints the server's option list; `--network none` added a harmless `UnknownHostException` for the container's own name. |
| Minecraft Paper 26.2 build 129 | 26.8 s | 237 266 401 B (107): `paper.jar`, `cache/mojang_26.2.jar`, `versions/26.2/paper-26.2.jar`, 103 libraries | **Yes**: running in 27.2 s, save 1.1 s, backup 7.5 MB, stop 1.0 s; again 17.2 s | None | — | Paper's patch-only install step (`-Dpaperclip.patchonly=true`) already leaves the patched jar and libraries. |
| Minecraft Fabric 26.3, loader 0.19.5 | 11.1 s; peak 230 MiB | 66 203 354 B (10): `fabric-server-launch.jar`, Mojang's `server.jar`, 7 libraries | **No** as installed (`Error invoking MC server bundler`, exit 1, crash loop). **Yes** after the same warm-up: running in 18.2 s, save 2.4 s, backup 2.3 MB, stop 0.7 s; again 13.1 s | First start only: the same 40 files as vanilla (Fabric invokes Mojang's bundler with `-DbundlerRepoDir`) | Not needed (warm-up) | After the warm-up: 135 756 918 B, 50 files. |
| Terraria vanilla 1.4.5.8 | 4.9 s | 58 528 804 B (32), in `vanilla-1458/` | **Yes**: running in 37.2 s, save 0.3 s, backup 8.9 MB, stop 0.7 s; again 5.1 s | None | — | Its working directory is forced to its install folder; every path it writes is absolute (`-savedirectory`, `-banlist`, `-config`, all in `/data`). |
| Terraria TShock v6.2.1 | 6.1 s | 101 565 217 B (34), in `tshock-v6.2.1/` | **No** through today's agent (it writes `ServerPlugins/.gsp-plugins.json`). **Yes** for TShock itself: started, `Server started`, `exit`, exit 0, with Bagger loaded from `/data` either way | None by TShock; the agent's plugin copy and record | `-additionalplugins /data/plugins` (no link), or `ServerPlugins` → `/data/tshock/ServerPlugins` | `-configpath`, `-logpath`, `-crashdir` and the working directory `/data` keep TShock's own files in data. |
| Terraria tModLoader v2026.07.3.0 | 11.4 s | 173 801 846 B (942), in `tmodloader-v2026.07.3.0/` | **No** as installed (`Failed to init logging`, exit 1). **Yes** with the logs redirected: running in 31.2 s, stop 1.3 s exit 0 | `tModLoader-Logs/{server.log, environment-server.log, Old/<date>-<n>.zip}` every start | **Yes:** `tModLoader-Logs` → `/data/tModLoader-Logs`; the target must exist before the start | Must run from its install folder (its working directory), which is why the logs land there. Workshop mods already live in `/data/.workshop` (`-steamworkshopfolder`). |
| Valheim 1.0.16 | 136.8 s, steamcmd (1.91 GB downloaded) | 2 186 650 065 B (994) | **Yes**: running in 92.4 s (a new world), stop 5.0 s exit 0 (saved); again 50.3 s | None | — | Unity writes `~/.config/unity3d/IronGate/Valheim/prefs` in HOME (the server's steam volume), not the install. No save command (as measured in M6). |
| Avorion 2.5.13 | 29.2 s, steamcmd (56.9 MB downloaded) | 191 405 978 B (868) | **Yes**: running in 7.1 s, save 2.2 s, backup 52 KB, stop 1.9 s exit 0; again 5.1 s | None | — | Writes `~/.avorion/backups/` (an empty folder) in HOME. Its working directory must be its install folder (M6); that's only read. |

No run wrote anything outside its volumes and `/tmp` (`docker diff` was empty for all of them).

### Install jobs and steamcmd
| Fact | Value | How verified |
|---|---|---|
| A separate job fills the install | An agent container with the install volume read-write, network on, no ports, ran the adapter's own `install()` (steamcmd for the Steam games, downloads and installers for the others); a second container mounting the same volume read-only read `installedInfo` from it and ran the game. | Every game above |
| What the job leaves in `steamapps/` | `appmanifest_<app>.acf` (branch in `UserConfig.BetaKey` when not public, `buildid`, `SizeOnDisk`, `BytesToDownload`, the installed depots and their manifests), and two empty folders `downloading/` and `temp/`. | The install listings: `trees/`, `markers/` |
| Does the game or the agent need `steamapps/` writable later? | No, except to install, update or validate. `installed()` only reads the app manifest. | Read-only runs of Project Zomboid, Valheim and Avorion |
| steamcmd on a read-only install | `app_update` with nothing to download: `Success! App '565060' already up to date.` in 4.8 s (so `updateOnStart` passes until Steam has a new build, measured: a start with it on went through in 12.1 s). `validate`: `Update state (0x0) : Timed out waiting for update to start, bailing.` then `Error! App '565060' state is 0x204 after update job.` after 126 s. | Avorion, the agent's `POST /v1/install` and `/v1/install` with `validate` on a read-only install; `steamcmd/validate-readonly.log` |
| `versions()` (`app_info_print`) on a read-only install | Works (8.8 s, 18 branches): steamcmd writes only its HOME. | Avorion, `POST /v1/versions` |
| Where steamcmd keeps its own state | HOME (`/home/node`, the steam volume): the image seeds it with steamcmd itself (464 entries, 203.9 MB); one install job adds 2.7–8 MB (`Steam/appcache/{appinfo,packageinfo}.vdf`, `Steam/depotcache/*.manifest`, `Steam/config/*.vdf`, `Steam/logs/*`, `Steam/userdata/anonymous/`). Nothing a later job needs: a job can have a HOME of its own, removed with it. | HOME listings before and after the Avorion, Valheim and Project Zomboid jobs: `home/*-job.txt` |
| What a running Steam game writes in HOME | The Steam API (`steamclient.so`, loaded through `~/.steam/sdk64`) writes `Steam/config/config.vdf` and `Steam/logs/*` (about 12 files); Valheim adds Unity's `prefs`; Avorion `~/.avorion/backups/`. So a server keeps a writable HOME of its own (today's steam volume); the shared install doesn't change that. | `find -newermt` over each run's HOME volume: `home/*-run.txt` |
| Two containers on one install | A second agent container mounted the same volume read-only while the first ran Avorion from it, and read the same `installedInfo` (`public`, build 22295362). | `GET /v1/status` of both |
| A local copy into a new volume | `cp -a` from the install (read-only) into a new volume mounted at `/opt/game` (so the volume root is the image's `node`-owned folder): Avorion 191 MB in 1.6–2.1 s, Project Zomboid 7.2 GB in 41.4 s. Mounted at a path the image doesn't have, the new volume's root is root-owned and the copy fails (`Permission denied`, `preserving times … Operation not permitted`). | `steamcmd/copy-times.txt` |
| Job memory | The job container's cgroup peak (page cache included) inside a 3 GiB limit: 149 MiB (vanilla), 230 MiB (Fabric's installer), 311 MiB (steamcmd installing Avorion, a second job run for this). Project Zomboid's and Valheim's jobs weren't probed: *not measured*. | `memory.peak` of the job's cgroup |
| A job's scratch data | The agent's `/data/.agent/state.json` (380 bytes) and nothing else: downloads stage inside the install root (`.gsp-staging`), which the adapters remove. | Listings of the job's data volume |

### Workshop downloads, plugins and the file API
- **tModLoader** already takes its Workshop mods from the server's data
  (`-steamworkshopfolder /data/.workshop/steamapps/workshop`, filled by the agent's steamcmd before
  each start, MOD-03): nothing in the install.
- **Project Zomboid** downloads the items in its ini's `WorkshopItems` itself, at every start,
  into **its install folder**. Measured with one small mod (`WorkshopItems=2544353492`,
  `Mods=\P4HasBeenRead`, written into the data's `Server/gspffinst.ini` before the start):

  | Install | What happened |
  |---|---|
  | Read-write | `Workshop: download 0/319712 …` up to `319712/319712`, then `loading P4HasBeenRead`; running in 54.3 s. Written: `steamapps/workshop/{appworkshop_108600.acf, content/108600/2544353492/…, downloads/, temp/}` (99 files), plus Steam's `Steam/depotcache/108600_*.manifest`, `Steam/logs/{content,workshop}_log.txt` and a `Steam/userdata/<account>/ugcmsgcache/` entry in HOME. |
  | Read-only | `Staging library folder not found`, `Install library folder not found`, `Workshop: item state DownloadPending -> Fail`, then a `NullPointerException` in `GameServerWorkshopItems.Install` and exit **0** after 9 s: the agent restarts it in a loop. |
  | Read-only, `steamapps/workshop` a symlink to `/data/.workshop/steamapps/workshop`, the target missing | The same failure. |
  | The same, the target created first | Downloaded into `/data/.workshop/steamapps/workshop/content/108600/2544353492/` (with its `appworkshop_108600.acf`, `downloads/`, `temp/`), `Workshop: item state CheckItemState -> Ready`, `loading P4HasBeenRead`; running in 49.3 s, stop 15.7 s, exit 0. |

  So a symlink created by the install job redirects Project Zomboid's own Workshop downloads into
  each server's data, as long as the agent creates the target before each start. The target is
  the agent's own steamcmd cache folder (`.workshop`, where `workshop_download_item` puts items):
  whether the game reuses an item the agent's steamcmd downloaded there, instead of fetching it
  again, wasn't measured. `Staging library folder not found` prints in every Workshop start, the
  successful ones included.
- **The agent's file API doesn't follow the link** (D11, CFG-08): `POST /v1/fs/stat` and
  `/v1/fs/list` on `install` `steamapps/workshop` answer 403 `Symbolic links are not followed`
  (`outside-root`); a listing of `steamapps` shows it as `kind: symlink`. The same files are
  reachable under the `data` root (`.workshop/steamapps/workshop/content/108600/<id>`). The Workshop
  source looks for an item under the install root first (`workshopItemLocations`) and expects a
  folder or nothing there, not a refusal.
- **TShock's plugins:** `-additionalplugins <folder>` loads the plugins in that folder only, not in
  its subfolders: Bagger in `/data/plugins/disabled/` alone wasn't loaded (only TShock's own
  `initiated` line), in `/data/plugins/` it was (`Plugin Bagger v1.3.1 (by Soofa) initiated.`). The
  agent keeps disabled plugins in `tshock/plugins/disabled/`, so `-additionalplugins
  /data/tshock/plugins` would load exactly the enabled ones.

### Versions and identity
| Game | What the install is (its key) | Where the agent reads it | Not part of the install |
|---|---|---|---|
| Project Zomboid, Valheim, Avorion and other manifest games | Steam app id, branch (`BetaKey`, none for `public`), `buildid` | `steamapps/appmanifest_<app>.acf` (`installed()`: `channel` = branch, `build` = buildid); the game version only from its first boot's log line (`42.21.0`, `1.0.16`, `2.5.13`), stored per server (`RuntimeState.gameVersion`) | The Linux runtime libraries (image) |
| Minecraft | Loader, Minecraft version, Paper build (and its channel) or Fabric loader version (and installer version) | `.gsp-install.json` (`installed()`: `version`, `channel` = loader, `build` = Paper build or Fabric loader) | The Java runtime: the marker names the major (`javaMajor`, `jre`) but `/opt/java/<jre>` is in the `java` image |
| Terraria | Flavour and release (`vanilla` + game version, `tshock` + tag, `tmodloader` + tag), one folder per install (`vanilla-1458`, `tshock-v6.2.1`, `tmodloader-v2026.07.3.0`) | `.gsp-install.json` (`installed()`: `version` = Terraria version, `channel` = flavour, `build` = tag; tModLoader's full version only from its boot line, `1.4.4` before, `1.4.4.9` after) | .NET 8 or 9 (image) |

Everything that identifies an install is in the install, read-only: the agent of any server
mounting it reads the same `installedInfo`. Two things aren't: the game version a Steam game prints
(learnt per server at its first boot) and the runtime (the image). A server's runtime image
moves at its next start (HST-01); an install doesn't depend on it, except that Minecraft's marker
names the Java major the image must have.

### Updates
| Fact | Value | How verified |
|---|---|---|
| An update beside the old install | A new volume, filled by a job: a fresh download (Avorion public: 56.9 MB downloaded, 29 s), or a local copy of the old install then steamcmd on the copy (Avorion `previous` → public: copy 1.6 s, then 15 792 864 bytes downloaded in 16 s). The old volume is never touched, so servers still on it keep running. | The app manifests' `BytesToDownload`; `steamcmd/branch-switch.txt`, `steamcmd/copy-times.txt` |
| Does steamcmd rewrite files in place? | No. On the copy, the 10 changed files (44 MB: `bin/AvorionServer`, `bin/ServerRunner`, `data/checksums.db`, `data/scripts/scripts.db`, five Lua scripts, the app manifest) got **new inodes**; 856 unchanged files kept theirs, with their sizes and times; 2 release notes were added; nothing was deleted. A process holding an old file open keeps the old content. | Inode, size and time of every file before and after: `steamcmd/update-inodes.txt` |
| Branch switches | `app_update 565060` (no `-beta`) on an install of the `previous` branch: `Success! App '565060' already up to date.`, still `BetaKey previous`, build 21146556. `-beta public`: moved to build 22295362, `BetaKey public`. | `steamcmd/branch-switch.txt` |
| Minecraft and Terraria | An update is a new download into a new folder; today's install code empties the install root first (`clearInstallRoot`, and Terraria removes every other folder), so on a shared install it can only run in a new volume, never on the one servers use. | Reading the install code (`adapter-minecraft`, `adapter-terraria`) |
| Minecraft's first-start unpack after an update | A new version brings a new `server.jar`, so the warm-up must run again in the new install's job. *Expected* (from finding 2; not run across versions). | — |

### What a read-only install breaks in the product today
Measured above, listed here for phase 2 (each is a code change, not a game's limit):
| Where | What happens with the install read-only | Seen |
|---|---|---|
| The agent's TShock plugin sync (`syncServerPlugins`, before every start) | Writes `ServerPlugins/.gsp-plugins.json.tmp`: `Could not prepare the start: EROFS`, the server never starts. It also refuses a `ServerPlugins` that is a symlink (`is not a plain folder: reinstall TShock`). | TShock read-only run; reading the code |
| `installOnStart` → `required` (nothing or something else installed) | The agent runs the adapter's install into the read-only root and fails the start (`Game install failed`). | *Expected* from the code, not run |
| `installOnStart` → `update` (Steam games with `updateOnStart`) | Passes while Steam has nothing new (`already up to date`); with a new build it would fail, and the agent then starts the installed build ("Update failed …; starting the installed build"). | Avorion, nothing to update; the failing case *expected* |
| `POST /v1/install` with `validate` | Fails after about 2 minutes (`state is 0x204`). | Avorion |
| Minecraft vanilla and Fabric's first start | The bundler can't unpack: a crash loop. | Both |
| tModLoader's logs | `Failed to init logging`: a crash loop. | tModLoader |
| Project Zomboid with Workshop mods | The game's own download fails: a crash loop. | Project Zomboid |
| The Workshop source's item lookup (`workshopItemLocations`) | Looks under the install root first; with the install's `steamapps/workshop` a symlink, the agent's file API refuses that path (403) instead of answering "not there". | File API on the redirected install |
| Minecraft's and Terraria's install code | Empties the install root before unpacking the new files: only ever right in a fresh volume. | Reading the code |

### Not covered here
- Players: no client joined a server on a shared install (nothing in these facts depends on one).
- Two **game servers** running from one install at the same time: one game server ran at a time;
  only a second agent container mounted the install read-only while a game ran from it.
- An update of a running server's install in place, and a game noticing that its install changed
  under it: the design never does that; steamcmd's replace-don't-rewrite behaviour is measured
  above.
- Project Zomboid reusing a Workshop item the agent's steamcmd already put in
  `/data/.workshop` (the redirect's target) instead of fetching it again.
- steamcmd's peak memory on the 2–7 GB installs (Valheim, Project Zomboid).
- Forge and NeoForge (not built yet, UPD-07); other manifest games than Avorion; ARM64.
- The time a fresh Project Zomboid download takes elsewhere: 237 s here is one home connection.

**Left behind:** nothing. Every container ran with `--rm` or was removed after its run; all
`gsp-ff-install-*` volumes (eleven install volumes and every scratch, data and HOME volume) were
removed; `docker ps -a`, `docker volume ls` and `docker network ls` filtered by
`label=gsp.factfinding=install` listed nothing; the images `gsp/steam:s5`, `gsp/java:s5` and
`gsp/native:s5` were removed. Docker's build cache was left alone (never pruned), and no other
stack's container or volume was touched.
