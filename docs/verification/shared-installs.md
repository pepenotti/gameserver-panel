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
`docker diff` of the container (writes outside the volumes and `/tmp`: none in any run). The
redirect symlinks and the Minecraft warm-up below were made in the install volume by a short
helper container (the same image and hardening, no network) standing in for the install job,
which doesn't do either yet.

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
10. **Installs are immutable once their job ends,** so their size is measured once: from 59 MB
   (vanilla Terraria) to 7.2 GB (Project Zomboid). Steam HOME volumes are the other per-server
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
| Does steamcmd rewrite files in place? | No. On the copy, the 10 changed files (44 MB: `bin/AvorionServer`, `bin/ServerRunner`, `data/checksums.db`, `data/scripts/scripts.db`, five Lua scripts, the app manifest) got **new inodes**; 856 unchanged files kept theirs, with their sizes and times; 2 release notes were added; nothing was deleted. So a process holding an old file open keeps the old content. | Inode, size and time of every file before and after: `steamcmd/update-inodes.txt` |
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
- The full read-only sequence for three of them: tModLoader with its logs redirected was started
  and stopped (`stop` saves), without a separate save or running backup; TShock read-only ran by
  hand, without the agent (a start and `exit`, which saves); Valheim has no save command. The
  read-write runs of tModLoader and TShock went through every step (tModLoader's running backup
  named folders its layout doesn't have and copied nothing; its save ran).
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

## Runtime side check — 2026-10-03

Phase 2 (runtime side) run for real (D5): the product's orchestrator, agent and adapters from the
M7-A branch, no fakes, against Docker in a development slot. It checks what phase 1 could only
stand in for: the install job itself, the orchestrator's install volumes and jobs, servers mounting
an install read-only through `ServerSpec.install`, the agent's shared runtime mode, and the redirects
and warm-up made by the job instead of a helper container.

**Setup.** Docker Desktop 29.7.2 (Linux engine, amd64, 12 cores, 15.6 GiB). The slot's stack
(orchestrator, panel, Caddy) and the runtime images `gsp/steam`, `gsp/java` and `gsp/native` built
from the branch (`node scripts/stack.mjs build …`, `up -d --build`). The orchestrator API was called
on its socket and the agents on their networks from inside the panel container (the panel's own
route to both), with a fresh agent token per job and per server; nothing else touched Docker but a
read-only checksum container on the install volume (below). One game server ran at a time.

**What a job and a server were, as Docker shows them** (`docker inspect`):
- Install job `<stack>-job-<id>`: user 1000:1000, read-only root, not privileged, every capability
  dropped, `no-new-privileges`, 1 GiB memory (no swap), 4096 pids, no port bindings, restart policy
  `no`, its own bridge network `<stack>-jobnet-<id>` holding only the job and the panel, `/data` a
  64 MiB tmpfs (`noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700`), `/tmp` the servers' tmpfs; mounts:
  the install volume read-write at `/opt/game` and, for the steam family, its own HOME volume
  `<stack>-job-<id>-steam` (204 MB, seeded from the image). `DELETE /v1/installs/<id>/job` removed
  the container, its network and its HOME; the install volume stayed.
- Server on an install: the install volume at `/opt/game` with `RW false`, its data (and, steam,
  HOME) volumes of its own and no install volume of its own; `GSP_INSTALL_SHARED=1` in its
  environment (set by the orchestrator).
- Copy job: `cp -a /src/. /opt/game/` (the orchestrator's command), network `none`, the image's
  environment only (no token), the source read-only at `/src`.

**Install volume unchanged:** a throwaway container (`--read-only --network none --cap-drop ALL
--user 1000:1000`, the volume read-only) printed, before the first server and after the second:
the number of files and links, every link's target, `du -sb`, the SHA-256 of every file (one digest
of the sorted list) and a digest of every entry's path, type, mode, size and mtime. Both lines were
**identical** for every game below.

| Game, flavour | Install job (`POST /v1/install`: install, warm-up, redirects, marker) | Job memory peak | Install (files with the marker, `du -sb`) | Server A: running, save, running backup, stop | Server B: the same | Install after both |
|---|---|---|---|---|---|---|
| Project Zomboid 42.21.0, build 25485538, one Workshop mod (2544353492) | 222.4 s (steamcmd, anonymous); link `steamapps/workshop` → `/data/.workshop/steamapps/workshop` | 1 024.6 MiB: the job's limit, reached through page cache while 7.2 GB were written (`memory.events`: `max` 40 536, `oom_kill` 0; 36 MiB anonymous after) | 39 187 files, 1 link, 7 206 116 892 B | 53.2 s (the game's own Workshop download landed in `/data/.workshop/steamapps/workshop/content/108600/2544353492`, `loading P4HasBeenRead`), 0.24 s, 6.6 MB in 0.32 s, 11.5 s exit 0 | 54.2 s (its own download, into its own data), 0.24 s, 6.6 MB in 0.31 s, 11.4 s | identical |
| Minecraft Fabric 26.3, loader 0.19.5 | 10.8 s, the warm-up included (`Unpacking 26.3/server-26.3.jar … to /opt/game/versions/…`, the option list, exit 0) | 430 MiB | 52 files, 135 757 330 B | 16.1 s, 2.3 s, 3.0 MB in 0.11 s, 0.6 s | 16.1 s, 1.9 s, 3.0 MB in 0.12 s, 0.6 s | identical |
| Terraria TShock v6.2.1 (1.4.5.8), a real plugin | 5.1 s | 312 MiB | 35 files, 101 565 629 B | 87.3 s (a new world), with Bagger v1.3.1 added by its release link: `-additionalplugins /data/tshock/plugins` on the command line, `Plugin Bagger v1.3.1 (by Soofa) initiated.`, listed active; 0.28 s, 9.0 MB in 0.37 s, 0.7 s | 85.3 s (no plugin: no `-additionalplugins`), 0.30 s, 9.0 MB in 0.41 s, 0.7 s | identical |
| Terraria tModLoader v2026.07.3.0 | 11.7 s; link `tmodloader-v2026.07.3.0/tModLoader-Logs` → `/data/tModLoader-Logs` | 310 MiB | 943 files, 1 link, 173 802 410 B | 31.1 s (its logs in `/data/tModLoader-Logs`: `server.log`, `environment-server.log`, `Old/`), 0.18 s, 9.1 MB in 0.18 s, 1.0 s | 31.1 s, 0.15 s, 9.2 MB in 0.17 s, 0.8 s | identical |

The agent's marker said, for the job's install alone (files without the marker, the sum of their
sizes): Project Zomboid 39 186 files, 7 206 116 353 B; Fabric 51 files, 135 756 918 B; tModLoader
942 files, 173 801 846 B (M7-0's table: 39 186, 50 and 942 files; 7 206 116 309, 135 756 918 and
173 801 846 B).

**No second download.** Each game was downloaded once, by its install job. No server's agent ran a
job of any kind (no `job` event, no steamcmd or download line); none got an install volume of its
own. Project Zomboid's server B ran with "update when it starts" on: `Not updating at start: this
server runs from a shared install, which install jobs update.`, no steamcmd. Each server downloaded
its own copy of the Workshop mod into its own data (as `docs/limitations.md` says).

**Refusals seen on the real stack:**
| Asked | Answer |
|---|---|
| `PUT /v1/servers/pza` naming the install while its job ran | 409 `install-busy` (`field: install`) |
| `DELETE /v1/installs/<id>` while its job ran | 409 `install-busy` |
| `DELETE /v1/installs/<id>` with both servers stopped | 409 `install-in-use`: "mounted by server pza, server pzb" |
| `POST /v1/start` on the job's agent | 409, `install: install-job` |
| `POST /v1/install` on a server's agent | 409, `install: shared-install` |
| A start whose launch asks for branch `unstable` (the install is `public`) | Failed at once, nothing installed: `install-mismatch: this server's shared install holds public 42.21.0 build 25485538, and its launch asks for another; …`, also in `status.install.mismatch` |
| `PUT /v1/installs/<id>?fromServer=trown` while that server ran | 409 `server-running` |

**Updates and migration, as the panel will drive them** (the copy, then a job on the copy):
- `PUT /v1/installs/<copy>?from=<Project Zomboid's install>`: the copy job exited 0 in **28.8 s**
  (7.2 GB); the copy's file digest equalled the source's (the entry digest differed: some folders'
  times). An install job on the copy then answered `Success! App '380870' already up to date.` in
  52.6 s (steamcmd starting with a fresh HOME, then the 39 186 files measured): nothing downloaded,
  the redirect link made again, a new marker written.
- Migration of a server's own install: a vanilla Terraria 1.4.5.8 server installed into its own
  volume (4.3 s), stopped; `?fromServer=` copied it in 0.2 s; the install job on the copy found it
  installed (29 ms, nothing downloaded) and wrote the marker; the server's spec then named the
  install: its container was recreated with the install read-only, it ran (33.1 s, the world
  created on the first start) on its old data, and its own install volume stayed behind (a
  left-over the panel lists) until the server was removed.

**Observed, unrelated to shared installs:** Project Zomboid prints `AdvancedAnimator$1.visitFileFailed`
`NoSuchFileException` errors for `…/mods/P4HasBeenRead/common/media/AnimSets` (and `actiongroups`):
the mod has no such folders; the server ran and loaded the mod.

**Not covered here:** Minecraft vanilla and Paper, vanilla Terraria (other than the migration), Valheim
and Avorion on the real stack (phase 1 ran them read-only; the agent's tests run every game and flavour
through a job and a shared install against the fakes); a tModLoader Workshop mod; players; two game
servers running from one install at the same time; ARM64.

**Left behind:** nothing. Every server was removed with its volumes, every install and job with
`DELETE`, the stack with `node scripts/stack.mjs clean`, and the slot's images (`gsp/*:s5`) with
`docker rmi`; `docker ps -a`, `docker volume ls` and `docker network ls` filtered by `gsp-s5`, and
`GET /v1/installs` and `GET /v1/servers` before the stack went, listed nothing. The build cache was
left alone; no other stack was touched.

## Panel side check — 2026-10-03

Phase 2 (panel side) run for real (D5): the panel deciding which install each server runs from,
driving the jobs, moving servers, and the upgrade of a panel from before shared installs, against
the real orchestrator, agent and game in a development slot. No fakes.

**Setup.** Docker Desktop 29.7.2 (Linux engine, amd64, 12 cores, 15.6 GiB). The slot's stack
(orchestrator, panel, Caddy) and the `gsp/native` runtime image built with `node scripts/stack.mjs`,
the real images (`SERVER_IMAGE_VARIANT` empty). The panel was built twice on one database volume:
first from `main` before the panel had shared installs (8805398), then from this branch, which is
the upgrade every existing install will go through. Everything was driven through the panel's
HTTPS API from the host, as the owner (session, CSRF header, 2FA), like the web. The game was
vanilla Terraria, the newest version (1.4.5.8), small worlds; one game server ran at a time.

**What a download is.** An install job's network counters (`/proc/net/dev` of its own interfaces,
read every 100 ms while it ran, through `docker exec` into the job container) say what it received.
Copy jobs have no network at all.

**The old way, then the upgrade.** On the panel from before shared installs, server `tr-own` was
created, started (its agent downloaded and installed 1.4.5.8 into the server's own install volume,
58 528 804 B; a new world), and stopped. With the branch's panel on the same database (migration 7
ran at its start), the server list said `tr-own` ran from its own install, with the pending reason
`install` and "moves to a shared install at its next start"; `GET /api/host/installs` was empty.

| Step (panel side) | What happened | Time |
|---|---|---|
| Create form's plan (`POST /api/adapters/terraria/install-plan`) | `download`, size unknown (no install of that game yet) | — |
| `tr-a` and `tr-b` created one after the other | One install (`install.create` once); `tr-b` found it being installed and waited for it; both without a container until it was ready, then both created on it (read-only at `/opt/game`, `RW false`), neither with an install volume of its own | job 7.8 s (create → ready, the 58.5 MB download included); containers 1.8 s and 3.7 s later |
| `tr-own` started | Its container stopped, its own install copied into a new install (`?fromServer=`), the install job on the copy, which found the same files as `tr-a`'s install: the copy was removed and `tr-own` put on that install; it started on its old world; its own install volume listed as a left-over with its size | 6.5 s to the move, running 12.7 s after the start |
| `POST …/server/update` on `tr-a`, then on `tr-b` (stopped; nothing newer upstream) | A copy of the install, the job on it, the same files: the copy removed, nobody moved, nothing stopped | 4.5 s each; on a third such update, sampled, the job received 9 388 B |
| A file check (`validate`) on `tr-a`, stopped, while `tr-own` ran | A copy, the job with `validate` on it (it downloads again: 50 842 307 B received), kept as the install that replaces the old one; `tr-a` and `tr-b`, stopped, moved at once; `tr-own`, running, showed the pending reason `install` ("moves to 1.4.5.8 at its next start") | 9 s, the moves 2–5 s later |
| `tr-own` restarted | Stopped, a safety backup (`pre-update`, 1.4.5.8), recreated on the new install, running | 9 s |
| Removals by the owner | The install in use: 409 `install-in-use`, naming `tr-own`, `tr-a`, `tr-b`; the old one (superseded, used by nobody) and `tr-own`'s left-over own install: removed, their volumes gone | — |

**A move without a download, seen directly.** With every server and install removed through the
panel, the panel from `main` was built again on the same (now empty) database, server `tr-old`
created on it, started (its own install: Terraria's install marker says
`installedAt 10:38:30.544Z`) and stopped; then the branch's panel. This time nothing else was
installed, so the move kept what it copied: `POST /api/servers/tr-old/install` (the "move to a
shared install" action, as the owner) stopped its container, copied its own install, and ran the
install job on the copy, which received **10 245 bytes** (no 58.5 MB download). The new install
(`origin: adopted`) kept Terraria's own marker unchanged (`installedAt 10:38:30.544Z`: the job found
the game installed and installed nothing), and the shared-install marker the job wrote last named
1.4.5.8, 58 528 804 B, 32 files. `tr-old` started on its old world (its `Worlds/tr-old.wld` from the
first panel's run) from the install, read-only. Then the plan for a new server said `existing`
(58 528 804 B, used by 1 server), and server `tr-new` got that install at once: no job at all.

**Audit.** Every step was recorded: `install.create` (by the owner for a new server, by the panel
for an update or a move), `install.ready` (with `sameAs` when a job found files another install
holds), `server.install.move` (from `own` or an install, to an install, by the panel; the owner's
request for the move as well), `install.remove` (the owner: an install, or `server:<id>` for a
left-over own install).

**Not covered here:** a Steam game (Project Zomboid, Valheim) and the steamcmd update path through
the panel on the real stack (the runtime side check ran a copy plus an install job on Project
Zomboid's 7.2 GB install; the end-to-end test runs this path through the fake orchestrator); a
newer build published upstream (a file check stood in for an update that brings new files); two game
servers running from one install at the same time; the web pages on the real stack.

**Left behind:** nothing. Every server was removed through the panel (backups dropped, the owner's
choice), every install and left-over through the host routes; then `node scripts/stack.mjs clean`
and `docker rmi gsp/native:s5`. `docker ps -a`, `docker volume ls`, `docker network ls` filtered by
`gsp-s5`, and `docker images` for `:s5`, listed nothing. No other stack was touched.

## Acceptance (M7, HST-09) — 2026-10-05

On the slot-1 acceptance stack (Docker Desktop, real images built from `main` at v0.4.2), which
had eight servers on their own per-server installs (Project Zomboid, Minecraft vanilla, Paper
and Fabric, Terraria vanilla, TShock and tModLoader, Valheim), all created through the panel in
M2–M6 and played on by the owner.

**Upgrade.** The rebuilt panel ran migration 7 at boot. Every server showed the pending reason
`install`; the two that were running kept running.

**Migration, one game at a time** (each through `POST /api/servers/:sid/install`, "Move now",
with the server stopped; the running ones stopped first). Each move copied the server's own
install locally and ran an install job on the copy; none downloaded the game again. Every server
then started and ran from its install mounted read-only (`/opt/game` `ro`, `/data` `rw`):

| Server | Install | Move | Start to running |
|---|---|---|---|
| TShock 1.4.5.8 | 97 MiB | 10 s | 12 s |
| Minecraft vanilla 26.3 | 126 MiB (bundler warmed up) | 12 s | ✓ |
| Paper 26.2 | 226 MiB | 17 s | 29 s |
| Fabric 26.3 | 129 MiB (bundler warmed up) | 16 s | 24 s |
| tModLoader 1.4.4.9 | 166 MiB (logs redirected) | 16 s | 13 s |
| Terraria vanilla 1.4.5.8 | 56 MiB | 12 s | 12 s |
| Project Zomboid 42.21.0 | 6.9 GiB | 111 s | 78 s |
| Valheim 1.0.16 | 2.0 GiB | 61 s | 66 s |

One thing the operator script got wrong, not the panel: a start sent the moment the install
showed `ready` was refused while the move operation was still finishing; the web shows that
operation, and a start sent after it ends is taken.

**A second server of a version already installed.** The create form's plan said "uses the
existing files, 58 MB, 1 server"; the new vanilla Terraria server was created in 4 s on the
same install, with no install job.

**An update on two servers sharing one install.** A file check (update with `validate`) on one
of them created exactly one new install (one `install.create`, copied from the old one). The
stopped server moved at once; the running one kept running with the pending reason `install`
and moved at its next restart, with no second job. The old install was left unused, for the
owner to remove from the panel settings page, as were the eight per-server installs the
migration replaced.

This meets M7's first done-when: two servers of the same game and version share one install,
and an update moves each at its next start without a second download.
