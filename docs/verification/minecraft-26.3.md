# Minecraft Java 26.3 verification log

Facts measured on real servers for M3 (D5: measured, not guessed), not taken from wikis or
blog posts. Each entry says how it was verified and what it holds for. Captures live in
`fixtures/minecraft/26.3/<loader>/` (its README describes the layout and the scrubbing); the
fake built from them is `tools/fake-minecraft/`.

## M3 fact-finding — 2026-09-25

**Setup.** Docker Desktop 29.7.2 (Linux engine, amd64). Every server ran in a throwaway
container shaped like the product's java containers: user 1000:1000, read-only root, all
capabilities dropped, `no-new-privileges`, a 256 MB `/tmp` tmpfs (exec), a pids limit, a
3 GiB memory limit, the working directory `/data` on one volume and the jars in `/opt/game`
on another, and `--init` in front of `java` (the product runs tini). Ports were published on
127.0.0.1 only. Images: `eclipse-temurin:25-jre` (25.0.4+7) and `:21-jre` (21.0.12+8), both
Ubuntu 26.04 based. At most one server ran at a time.

**What ran.** The latest release, **26.3** (released 2026-09-15): Mojang's server jar; Paper
**26.3 build 41** (the newest; 26.3 had only ALPHA builds); Fabric Loader **0.19.5** with the
installer **1.1.2**. Also one boot of Paper **26.2 build 83** (STABLE, two months old).

**EULA.** `eula=true` was written on these throwaway test servers only, by the owner's leave,
to test them. The product never writes it without the owner's acceptance (D6, built in M3.0).

**Players.** No real client was used. Joins, leaves, kicks and bans were driven by a small
test client written for the fact-finding (offline mode, protocol 777, packet ids from the
server jar's own data generator), with made-up names (`gspff…`). What only a real client in
online mode can show is listed at the end.

### Headline findings
1. **RCON drops a connection that sends two packets in one write.** The server reads at most
   one packet per read and closes the connection when a read holds anything else. The agent's
   `RconClient` sends each command and its sentinel in one write (measured on PZ), so against
   Minecraft every command fails with "connection closed". A sentinel sent on its own works
   and is answered with `Unknown request 0`. The client must stop pipelining (proposal below).
2. **Paper no longer splits the world.** On 26.3 (and 26.2) all three loaders keep every
   dimension inside `world/dimensions/minecraft/{overworld,the_nether,the_end}`; there are no
   `world_nether` / `world_the_end` folders. Player data moved into `world/players/`.
3. **`server.properties` is rewritten from memory** at every boot and at every `whitelist on|off`:
   comments go, keys are sorted, unknown keys are kept. An edit made on disk while the server
   runs is lost at the next such write. `ops.json` is overwritten the same way at the next
   `op`/`deop`; `whitelist.json` edits are picked up only by `whitelist reload`.
4. **`save-all flush` is synchronous, but saving off isn't a freeze.** Its RCON reply
   (`…Saved the game`, 0.2–0.9 s with a player online) comes after the last world write, and
   a `tar` taken right then is clean. Afterwards nothing changes while players only stand
   around, but a player **leaving** while saving is off still writes their player files (and,
   on vanilla, a chunk file), and a join may write a chunk file.
5. **Java 25 for 26.x.** 26.1, 26.2 and 26.3 declare Java 25; a 26.3 jar on Java 21 fails in
   under a second. Temurin publishes no Java 16 image, which 1.17.x declares.
6. **Paper's download API moved.** `api.papermc.io/v2` answers 410 Gone (sunset 2026-07-01);
   the current one is Fill v3 (`fill.papermc.io/v3`), with builds in channels ALPHA, BETA,
   STABLE. A new Minecraft version has only ALPHA builds for weeks.
7. **Exit codes don't tell a crash.** A failed start (port in use) writes a crash report and
   exits **0**, as does the EULA refusal; SIGTERM exits 143 after saving.
8. **26.3 defaults to `white-list=true`** and ships a JSON-RPC management server (off by
   default) whose `management-server-secret` the game generates into `server.properties`.
9. **Paper turns on bStats** (anonymous usage statistics to bstats.org) and spark's background
   profiler by default; `version` also calls PaperMC.

### Install and pinning (UPD-01, UPD-02, UPD-05, UPD-06)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Mojang version list | `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json`: `latest.release` / `latest.snapshot`, and `versions[]` with `id`, `type` (`release`, `snapshot`, `old_beta`, `old_alpha`), `url`, `time`, `releaseTime`, `sha1` (of the version file), `complianceLevel`. 916 entries: 103 releases, 752 snapshots (release candidates and pre-releases are `snapshot`). | Fetched; `vanilla/api/version_manifest_v2.json` (trimmed) | 2026-09-25 |
| Version file → server jar | The version file's `downloads.server` = `{ sha1, size, url }` on `piston-data.mojang.com/v1/objects/<sha1>/server.jar`; `javaVersion` = `{ component, majorVersion }`. 26.x have no `server_mappings` (the game ships unobfuscated). Releases 1.0–1.2.4 have no server jar. | Fetched all 103 release files; downloaded 26.3 and checked sha1 and size | 2026-09-25 |
| Paper API | Fill v3: `GET /v3/projects/paper` (versions grouped by minor, pre-releases included), `/versions/<v>` (`support.status`, `java.version.minimum`, recommended flags, build ids), `/versions/<v>/builds[?channel=STABLE]` (newest first), `/builds/latest`, `/builds/<n>`. A build: `id`, `time`, `channel`, `commits`, `downloads["server:default"] = { name, checksums.sha256, size, url }` on `fill-data.papermc.io/v1/objects/<sha256>/<name>`. The channel filter is case-sensitive (`stable` is a 400). Unknown version or build: 404 with `version_not_found` / `build_not_found`. The v2 API answers 410 `sunset`. | Fetched; downloaded 26.3-41 and 26.2-83 and checked sha256 and size; `paper/api/` | 2026-09-25 |
| Paper channels | 26.3: builds 3–41, all ALPHA (10 days after the release). 26.2: ALPHA 10–58 (Jun 16–Jul 12), BETA 59–82 (to Jul 26), STABLE 83–129. 1.21.11, 1.20.6, 1.17.1, 1.16.5: a STABLE latest build. | Channel counts from the builds lists | 2026-09-25 |
| Paper install step | `java -Dpaperclip.patchonly=true -DbundlerRepoDir=/opt/game -jar /opt/game/paper.jar` downloads Mojang's jar (from Mojang) into `cache/`, patches it into `versions/26.3/paper-26.3.jar`, unpacks 103 libraries into `libraries/` (all under the repo dir), prints `Downloading mojang_26.3.jar` and `Applying patches`, and exits 0 in 12 s. Without it, the first start does the same before booting (+9 s). | `paper/logs/patch-only.log`, `paper/tree/install.txt`, `paper/logs/first-boot-26.2-83-unpatched.log` | Paper 26.3-41, 26.2-83 |
| Fabric meta | `https://meta.fabricmc.net/v2/versions/game` (`version`, `stable`), `/v2/versions/loader` (`version`, `build`, `maven`, `stable`; 253 entries, only the newest flagged stable), `/v2/versions/installer` (`url` on maven.fabricmc.net, `version`, `stable`), `/v2/versions/loader/<game>` (per-loader `launcherMeta`; `intermediary` is `0.0.0` for 26.x). Unknown game: 400 with `[]`. | Fetched; `fabric/api/` | 2026-09-25 |
| Fabric install, chosen way | The installer jar from maven (`fabric-installer-1.1.2.jar`, with a `.sha256` next to it that matched): `java -jar fabric-installer.jar server -mcversion 26.3 -loader 0.19.5 -dir /opt/game -downloadMinecraft` writes `fabric-server-launch.jar` (616 bytes), `server.jar` (Mojang's, fetched by the installer) and 7 libraries into `/opt/game`, exit 0 in 8 s. | `fabric/logs/installer.log` | installer 1.1.2 |
| Fabric start | From `/data`, `fabric-server-launch.jar` looks for `server.jar` in the working directory and fails (`The Minecraft server .JAR is missing (/data/server.jar)!`, exit 1, and it writes `fabric-server-launcher.properties` there). With `-Dfabric.gameJarPath=/opt/game/server.jar -DbundlerRepoDir=/opt/game` it starts, and `/data` gets only the server's own files plus `.fabric/processedMods/` (a 0.7 MB cache). | `fabric/logs/installed-missing-game-jar.log`, `fabric/logs/no-eula.log` | loader 0.19.5 |
| Fabric one-file launcher (not chosen) | `/v2/versions/loader/<game>/<loader>/<installer>/server/jar` (182 KB; no checksum published, but the same bytes on two downloads) downloads Mojang's jar and every library into the **working directory** on first start (`.fabric/`, `libraries/`, `versions/`: 136 MB in `/data`). | `fabric/logs/launcher-first-run-no-eula.log`, `fabric/tree/launcher-first-run.txt` | loader 0.19.5, launcher 1.1.2 |
| Vanilla unpacking | The server jar is a bundler: it unpacks `versions/26.3/server-26.3.jar` and 39 libraries (69 MB) into the working directory, or into `-DbundlerRepoDir`. With the files already there it starts from a read-only `/opt/game`. | `vanilla/logs/no-eula.log`, `vanilla/tree/install.txt`; a start with `/opt/game` mounted read-only | 26.3 |
| Rate limits and headers | None of the three advertised a rate limit (no rate-limit headers). Caching: piston-meta `max-age=120` with an ETag; Fill `max-age=1800` (project) and `300` (builds); Fabric meta `max-age=1800`, launcher jar `86400`. Fill answered with and without a User-Agent; every request sent `gameserver-panel-factfinding/0.3 (test)`. | Response headers | 2026-09-25 |

### Java matrix (from each version file's `javaVersion.majorVersion`)
| Minecraft | Java major | Mojang's runtime name | Temurin JRE image |
|---|---|---|---|
| 26.1 – 26.3, 26.4 snapshots (latest) | **25** | java-runtime-epsilon | `eclipse-temurin:25-jre` |
| 1.20.5 – 1.21.11 (last 1.20.x: **1.20.6 → 21**) | **21** | java-runtime-delta | `:21-jre` |
| 1.18 – 1.20.4 | **17** | java-runtime-beta / gamma | `:17-jre` |
| 1.17 – 1.17.1 (**1.17.1 → 16**) | **16** | java-runtime-alpha | none published; 17 is the nearest |
| 1.7.10 – 1.16.5 (**1.16.5 → 8**) | **8** | jre-legacy | `:8-jre` |
| 1.6.4 and older | not declared | — | — |

Paper's `java.version.minimum` agrees (26.3: 25; 1.21.11 and 1.20.6: 21; 1.17.1: 16; 1.16.5: 8).
Wrong Java, measured: the 26.3 jar on Java 21 exits 1 in 1.2 s with
`Error: LinkageError occurred while loading main class net.minecraft.bundler.Main` and
`UnsupportedClassVersionError … class file version 69.0 … only recognizes class file versions up to 65.0`
(`vanilla/logs/wrong-java-21.log`).

Right Java, measured (a boot to the ready line with `eula=true`, then `stop`, exit 0; no
errors beyond the missing-`server.properties` message of a first start): **1.20.6 on 21**
(20.6 s), **1.17.1 on 17** (39.5 s; it declares 16), **1.16.5 on 17** (31.8 s; it declares 8).
Versions before 1.16.5 on 17: not tried.

The Temurin 25, 21, 17 and 8 JRE images are published for linux/amd64 and linux/arm64; the JRE
folder (`/opt/java/openjdk`) is 192 MB for 25 and 159 MB for 21. Copied as is into
`node:24-trixie-slim` (the base of `docker/java`), the Temurin 25 JRE ran `java -version` and
started 26.3 up to its EULA check, with `/opt/game` mounted read-only.

### Launch (SRV-01, SRV-05, NFR-04)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Command | `java -Xms<M>m -Xmx<M>m -DbundlerRepoDir=/opt/game [-Dfabric.gameJarPath=/opt/game/server.jar] -jar /opt/game/<server.jar \| paper.jar \| fabric-server-launch.jar> nogui`, working directory `/data`. Runs as uid 1000 with a read-only root; writes only `/data`, `/opt/game` (first unpack) and `/tmp`. | Every run | all three, 26.3 |
| Without `eula=true` | Writes `eula.txt` (`#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).`, a date comment, `eula=false`) and a full default `server.properties`, logs `You need to agree to the EULA in order to run the server. Go to eula.txt for more info.`, and **exits 0** after ~10 s (first start, with unpacking). It never waits for input. A second start without the EULA prints only that line; an existing `eula.txt` is not rewritten. | `*/logs/no-eula.log`, `vanilla/logs/no-eula-again.log`, `*/config/eula.txt.generated` | all three |
| EULA link | `https://aka.ms/MinecraftEULA`, as in `MINECRAFT_META.eula.url`. | `eula.txt` | 26.3 |
| First boot | Container start → ready line: vanilla 17.8 s (`Done (4.945s)`; spawn area 4.6 s), Paper 19.1 s (`Done (17.555s)`, Paper counts from its own start), Fabric 19.2 s (`Done (5.643s)`). About 10 s of each is the JVM, libraries and data fixers before the world. | `*/logs/first-boot.log` with timestamps | 12 cores, amd64 |
| Later boots | Existing world: vanilla 12.2–12.6 s, Paper 14.3 s, Fabric 12.6 s to the ready line. | `*/logs/second-boot.log` | same |
| Memory above the heap | With `-Xms2G -Xmx2G -XX:+AlwaysPreTouch` (heap fully resident), idle, small world, no players: RSS vanilla 2389 MiB (**+341 MiB** over the heap), Fabric 2407 MiB (**+359**), Paper 2452 MiB (**+404**); the container's cgroup counted about the same. Without pre-touch the RSS at ready was 1.46 GiB (vanilla), 1.96 GiB (Paper), 1.76 GiB (Fabric). | `/proc/<java>/status` and the cgroup's `memory.current` | idle only; players, view distance and plugins add native memory |
| stdin | Console commands work on stdin. Lines typed before the server is ready wait for it. End of stdin changes nothing: the server keeps running. | `*/logs/console-session.log`; closing stdin | all three |
| Log files | `logs/latest.log` (the console lines); at each boot the previous one is gzipped to `logs/<date>-<n>.log.gz`. Crash reports go to `crash-reports/`. | File lists | all three |

### Readiness and logs (CON-01, SRV-07)
Line header: vanilla and Fabric `[HH:MM:SS] [<thread>/<LEVEL>]: <message>`, Paper
`[HH:MM:SS <LEVEL>]: <message>`; some lines have no header (stack traces, Paper's second line
of a multi-line message, Fabric's mod list). The JVM prints warnings on stderr (`WARNING: A
restricted method…`, `sun.misc.Unsafe…`), and Paper `… ServerMain WARN Advanced terminal
features are not available in this environment`. Timestamps are the container's time zone.

| Line (message part) | Meaning | Loaders |
|---|---|---|
| `Done (<s>s)! For help, type "help"` (thread `Server thread`) | ready | all |
| `Starting remote control listener`, `Thread RCON Listener started`, `RCON running on 0.0.0.0:<port>` | RCON is up: right after the ready line on vanilla and Fabric, just **before** it on Paper | all |
| `Starting minecraft server version 26.3` | game version | all |
| `This server is running Paper version 26.3-41-main@a15fed9 (…) (Implementing API version 26.3.build.41-alpha)`; `[bootstrap] Loading Paper 26.3-41-main@a15fed9 (…) for Minecraft 26.3` | Paper build and channel | Paper |
| `Loading Minecraft 26.3 with Fabric Loader 0.19.5` (thread `main`) | loader version | Fabric |
| `Starting Minecraft server on *:<port>` | game port chosen (not yet bound) | all |
| `**** FAILED TO BIND TO PORT!`, `The exception was: io.netty.channel.unix.Errors$NativeIoException: bind(..) failed with error(-98): Address already in use`, `Perhaps a server is already running on that port?`, then `Encountered an unexpected exception`, `java.lang.IllegalStateException: Failed to initialize server`, `This crash report has been saved to: /data/crash-reports/crash-<date>-server.txt`, `Stopping server` — **exit 0** in 13 s | fatal: port taken | vanilla (`vanilla/logs/port-in-use.log`) |
| `Unable to initialise RCON on 0.0.0.0:<port>` + `java.net.BindException: Address already in use` | RCON port taken: **not** fatal, the server runs on without RCON | vanilla |
| `No rcon password set in server.properties, rcon disabled!` | RCON on with an empty password: runs without RCON | vanilla |
| `Error: Invalid or corrupt jarfile <jar>` / `Error: Unable to access jarfile <jar>` (stderr, exit 1 in ~1 s) | bad or missing jar | JVM |
| `UnsupportedClassVersionError` (above) | wrong Java | JVM |
| `The Minecraft server .JAR is missing (…)!` + `Exception in thread "main" java.lang.RuntimeException: Failed to setup Fabric server environment!` (exit 1) | Fabric without its game jar | Fabric |
| `You need to agree to the EULA …` (exit 0) | EULA refused | all |
| `Server empty for 60 seconds, pausing` | vanilla and Fabric pause ticking when empty (`pause-when-empty-seconds=60`); Paper sets it to -1 | vanilla, Fabric |
| `Thread RCON Client /<ip> started` / `… shutting down` | an RCON connection opens and closes (every panel connection shows up in the log, with its address) | all |
| `Couldn't find profile with name: <name>` + an exception with `status=404` | a command named an account that doesn't exist (online lookups): a WARN with a stack trace, not a failure | all |

### Config (CFG-01…09)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| `server.properties` encoding | UTF-8 as it is (`motd=Servidor de prueba Ñandú ☃` round-trips, no `\u` escapes), LF, a final newline. Java escapes: `level-type=minecraft\:normal`. | Byte-level reads of `*/config/server.properties.after` | all three |
| Rewrites | At every boot and at `whitelist on|off` the game writes the file from memory: header `#Minecraft server properties` and a date comment, keys sorted, comments dropped, **unknown keys kept** (`gsp-probe-unknown-key`), missing keys completed with defaults. It is not rewritten at stop. Nothing re-reads it while running. | `*/config/server.properties.before` vs `.after`; `vanilla/…` timestamps | all three |
| Edits on disk while running | Lost at the next rewrite (the `motd` edited on disk came back at `whitelist on`). | The second-boot runs | all three |
| Defaults the panel must know | `white-list=true`, `online-mode=true`, `enable-rcon=false`, `rcon.port=25575`, `rcon.password=` (empty), `enable-query=false`, `query.port=25565`, `server-port=25565`, `server-ip=` (all addresses), `management-server-enabled=false`, `management-server-secret=<40 random characters>` (generated on first write, kept afterwards), `log-ips=true`, `pause-when-empty-seconds=60`, `level-name=world`. Paper adds `debug=false` and sets `pause-when-empty-seconds=-1`. 71 keys (72 on Paper). | `*/config/server.properties.generated` | 26.3 |
| `eula.txt` | Java properties; written only when missing. | Timestamps across runs | all three |
| `ops.json`, `whitelist.json`, `banned-players.json`, `banned-ips.json` | JSON arrays, 2-space indent, **no final newline**; entries `{uuid, name, level, bypassesPlayerLimit}`, `{uuid, name}`, `{uuid, name, created, source, expires, reason}`, `{ip, created, source, expires, reason}` (`created` like `2026-09-25 19:47:43 +0000`, `source` `Rcon` or `Server`, `expires` `forever`). Written at once by the commands that change them; created as `[]` on first boot. | `*/files/` | all three |
| `usercache.json` | One line, `{uuid, name, expiresOn}` (a month ahead), updated whenever a name is looked up or a player joins. A cache: never an input. | `*/files/usercache.json` | all three |
| Edits to the lists while running | `whitelist.json`: ignored until `whitelist reload` (then taken). `ops.json`: an entry added on disk was not an operator in the game, and the next `op`/`deop` wrote the file from memory without it. Bans: not tested; treat like ops. | The second-boot runs | vanilla, Paper, Fabric |
| Names in commands | Online mode: resolved through Mojang's profile service (an unknown name is `That player does not exist` after ~0.3–0.8 s). Offline mode: a name Mojang knows is **still** resolved to that account; an unknown one becomes an offline profile — vanilla and Fabric lower-case it (`gspffalice`, UUID from the lower-case name), Paper keeps it as typed. | `*/rcon/moderation.json`, `*/rcon/players-offline.json` | 26.3 |
| Paper's own files (YAML unless noted) | `bukkit.yml`, `spigot.yml`, `commands.yml`, `config/paper-global.yml`, `config/paper-world-defaults.yml`, `world/dimensions/minecraft/<dim>/paper-world.yml` (one per dimension), `plugins/bStats/config.yml`, `plugins/spark/config.json` (JSON), `.paper/version_history.json` (JSON, the game's own). No `help.yml` or `permissions.yml` is created on 26.3 (bukkit.yml still names `permissions.yml`). | `paper/data/`, `paper/tree/` | Paper 26.3-41 |
| Fabric's own files | `mods/` (empty), `.fabric/processedMods/` (cache); `config/` appears only when a mod writes one (mods pick their own formats: JSON, JSON5, TOML, properties, YAML). | `fabric/tree/` | loader 0.19.5 |

### Control (CON-02, PLY-03)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| RCON auth | One packet back: type 2 with the request id (no empty type-0 packet first, unlike PZ). A wrong password: type 2 with id **-1**; the connection stays open and every later packet gets the same -1 answer. | `*/rcon/short.json`, `*/rcon/bad-auth.json` | all three |
| RCON replies | Type 0 with the request id, **one or more packets for every command** (`say` answers an empty body). Split every **4096 characters** (`help`: 4096 + 1628). Multi-line replies: vanilla and Fabric join the lines with **nothing** (`Unknown or incomplete command. See below for errornotacommand<--[HERE]`), Paper keeps `\n`. | `*/rcon/short.json`, `*/rcon/long.json` | all three |
| Sentinel | A type-0 packet sent on its own is answered once with `Unknown request 0` (type 0, its id). | `*/rcon/short.json` | all three |
| **Two packets in one write** | The server **closes the connection** without answering (it reads one packet per read and gives up on anything else). | `*/rcon/combined-write.json` | all three |
| Longest command | A packet of 1460 bytes (a 1446-byte body) is taken; 1461 bytes closes the connection. | `say` commands of growing size | vanilla |
| `say` length | At most 256 characters: longer is refused with `Chat message was too long (<n> > maximum 256 characters)`. | Same run | vanilla |
| RCON is not echoed | Commands aren't logged, but their feedback is announced to operators and the log as `System chat: [Rcon: <feedback>]` (for example `[Rcon: Automatic saving is now disabled]`) while `broadcast-rcon-to-ops=true` (the default). `list`, `banlist` and `whitelist list` aren't announced. | `*/logs/first-boot.log` | all three |
| Console feedback | On stdin, feedback is logged as `System chat: <line>` (26.3 adds the prefix); an unknown command logs `System chat: Unknown or incomplete command. See below for error` and `System chat: <cmd><--[HERE]` (Paper prints the second line bare). | `*/logs/console-session.log` | all three |
| `stop` | Answers `Stopping the server`, then `Stopping server`, `Saving players`, `Saving worlds`, `Saving chunks for level 'ServerLevel[world]'/minecraft:<dim>` ×3 (Paper adds its chunk-system lines), and exits **0**: 1.2–1.3 s after the command (small idle world), ~4 s with four players' chunks loaded. Same from stdin. Players get `Server closed`. | `*/logs/stop.log`, `*/logs/stop-with-player.log`, `vanilla/logs/rcon-port-clash-stdin-stop.log` | all three |
| SIGTERM | The JVM's shutdown hook saves (level.dat rewritten at that moment) and the process exits **143** in 1.3–1.5 s. Vanilla and Fabric log **nothing** (logging is already shut down); Paper logs its whole stop. | `paper/logs/sigterm.log`; file times | all three |
| `list` | `There are <n> of a max of <max> players online: <a>, <b>` (with 0 players it ends with `: `); `list uuids`: `<name> (<uuid>)` each. | `*/rcon/players-online.json` | all three |
| Moderation replies | `kick`: `Kicked <name>: <reason>` / `No player was found`. `ban`: `Banned <name>: <reason>` (kicks an online player with `You are banned from this server`) / `That player does not exist`. `pardon`: `Unbanned <name>`. `ban-ip`: `Banned IP <ip>: <reason>`. `pardon-ip`: `Unbanned IP <ip>`. `banlist`: `There are <n> ban(s):` then `<target> was banned by <source>: <reason>` per ban. `whitelist add|remove`: `Added <name> to the whitelist` / `Removed <name> from the whitelist`; `on|off`: `Whitelist is now turned on|off` / `Whitelist is already turned on`; `list`: `There are no whitelisted players` / `There are <n> whitelisted player(s): <a>, <b>`; `reload`: `Reloaded the whitelist`. `op`: `Made <name> a server operator` / `Nothing changed. The player is already an operator`; `deop`: `Made <name> no longer a server operator` / `Nothing changed. The player is not an operator`. `say <text>`: empty reply, logged as `[Not Secure] [Rcon] <text>` (`[Server]` from the console). The remaining failure texts in the fake come from the game's own English language file inside the server jar. | `*/rcon/moderation.json`, `*/rcon/players-*.json` | all three |

### Players (PLY-01, PLY-02) — offline test client
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Join | vanilla and Fabric: `<name>[/<ip>:<port>] logged in with entity id <n> at (<x>, <y>, <z>)` then `System chat: <name> joined the game`. Paper: `UUID of player <name> is <uuid>`, `System chat: <name> joined the game`, then `<name>[/<ip>:<port>] logged in with entity id <n> at ([minecraft:overworld]<x>, <y>, <z>)`. | `*/logs/players.log` | offline mode |
| Leave | `<name> lost connection: <reason>` (`Disconnected`, the kick reason, `You are banned from this server`, `You logged in from another location`) then `System chat: <name> left the game`. | `*/logs/players.log` | offline mode |
| Refused login | `Disconnecting <name> (/<ip>:<port>): You are banned from this server.` + `Reason: <reason>` on a second, header-less line, then `<name> (/<ip>:<port>) lost connection: …`. | `*/logs/players.log` | banned player |
| Whitelist and operators | Operators may join while the whitelist is on. Paper throttles reconnects from one address (`Connection throttled! Please wait before reconnecting.`, `bukkit.yml` `connection-throttle: 4000`). | The player runs | offline mode |
| Player data | `world/players/data/<uuid>.dat` (+ `.dat_old`), `world/players/advancements/<uuid>.json`, `world/players/stats/<uuid>.json`. | File list | 26.3 |
| Published port | A client reached the game through a different published host port (30450 → 25565): the game port inside the container need not equal the host port. | The test client | all three |

### Running backups (BAK-02)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| `save-off` | `Automatic saving is now disabled` (again: `Saving is already turned off`) | `*/rcon/save.json` | all three |
| `save-all flush` | One reply, `Saving the game (this may take a moment!)Saved the game` (Paper with `\n`): 18 ms on an empty server (vanilla), 0.5–0.9 s with a player online (Paper 0.2 s after its first flush). Works while saving is off and while the server is paused. | `*/rcon/save.json`, `*/rcon/flush-timing.json` (reply awaited, 4 rounds per loader) | all three |
| After the reply | The newest world file was written **before** the reply arrived in every round (12 of 12), and a `tar` of `world/` taken right after the reply finished without "file changed" warnings (12 of 12). With the player standing still and saving off, nothing under `world/` changed for 10 s. | Container clock around the awaited reply and file times; `tar` exit status | all three |
| Joins and leaves while saving is off | A leaving player's files are written anyway (`world/players/{data,advancements,stats}/<uuid>`), and on vanilla one `entities` region file; a join wrote one `poi` region file on vanilla and nothing on Paper. | File times around a test client's join and leave | vanilla, Paper |
| `save-on` | `Automatic saving is now enabled` (again: `Saving is already turned on`) | `*/rcon/save.json` | all three |
| What the world is | `world/` (the `level-name`), with every dimension inside it (`world/dimensions/minecraft/{overworld,the_nether,the_end}/{region,entities,poi,data}`), `world/data/minecraft/*.dat`, `world/players/`, `world/level.dat` (+ `level.dat_old`), `world/datapacks/`. **The same on Paper** (plus `paper-world.yml` and `data/paper/` per dimension). | `*/tree/data-running.txt`, `paper/tree/data-26.2-83.txt` | 26.2, 26.3 |
| `session.lock` | `world/session.lock`, 3 bytes (a UTF-8 snowman), held with a file lock while running, still readable; left behind after a stop. | Reads while running | all three |
| Restore | A world copied while running (without `session.lock`) and put back into the stopped server booted cleanly (`Done`, no warnings about the world). That copy was even taken before the flush had answered. | `vanilla/logs/restored-world-boot.log` | vanilla |

### Ports (SRV-01, SRV-08, NFR-03)
| Fact | Value | How verified | Holds for |
|---|---|---|---|
| Listening sockets | TCP 25565 (game) and TCP 25575 (RCON) on every address (IPv4 and IPv6 any); no UDP (query off); nothing else (the management server is off). | `/proc/net/{tcp,tcp6,udp,udp6}` in the running container | vanilla |
| RCON address | Always `0.0.0.0` (there is no separate RCON address key; `server-ip` would move the game port too). It stays unpublished; the agent reaches it on 127.0.0.1. | Log lines | all three |

### CPU architecture (HST-05)
Not run on arm64. By the downloads' nature: the server jars are Java; vanilla's bundler ships
netty's native epoll libraries for both `linux-x86_64` and `linux-aarch_64`; Paper prints
`Paper: Using libdeflate (Linux x86_64) compression from Velocity.` and the same for OpenSSL, so
it picks per-architecture natives (and falls back to Java code where none exists); Fabric adds
only Java libraries. The Temurin 25/21/17/8 JRE images are published for linux/arm64. So arm64
should work for all three; **unverified**.

### Per-loader differences
| | vanilla | Paper | Fabric |
|---|---|---|---|
| Jar started | `server.jar` (bundler) | `paper.jar` (paperclip) | `fabric-server-launch.jar` + `-Dfabric.gameJarPath=/opt/game/server.jar` |
| Install | one download (sha1) | download (sha256) + patch-only run (fetches Mojang's jar) | installer download (maven `.sha256`) + installer run (fetches Mojang's jar) |
| Log header | `[time] [thread/LEVEL]:` | `[time LEVEL]:` | as vanilla (first lines on thread `main`) |
| RCON up | after `Done` | before `Done` | after `Done` |
| Multi-line RCON reply | lines joined with nothing | joined with `\n` | as vanilla |
| SIGTERM | silent, 143 | logs its stop, 143 | silent, 143 |
| Join lines | logged in, then joined | UUID, joined, logged in | as vanilla |
| Extra files | — | `bukkit.yml`, `spigot.yml`, `commands.yml`, `config/*.yml`, per-dimension `paper-world.yml`, `plugins/`, `.paper/` | `mods/`, `.fabric/` |
| `pause-when-empty-seconds` | 60 | -1 | 60 |
| Offline names from commands | lower-cased | as typed | lower-cased |
| Extras on by default | — | bStats, spark profiler, reconnect throttle (4 s) | — |

### Keys the panel manages (CFG-04), proposed
| File | Key | Value | Why |
|---|---|---|---|
| server.properties | `server-port` | the container's game port (25565) | the agent's port; the host port is the orchestrator's mapping |
| | `server-ip` | empty | bind every address in the container |
| | `enable-rcon` | `true` | the control channel |
| | `rcon.port` | 25575 (`ctx.ports.rcon`) | the agent's port |
| | `rcon.password` | the control secret (secret) | agent-owned |
| | `enable-query` | `false` | nothing publishes UDP 25565 |
| | `management-server-enabled` | `false` | not used in M3; it would listen with its own secret |
| | `level-name` | `world` | backup parts and reset scopes name this folder |
| | `management-server-secret`, `management-server-tls-keystore-password` | (game-written) | secret keys: masked, never managed |
| eula.txt | `eula` | `true` only after the owner accepted (D6) | the game's own acceptance |

Every `server.properties` key takes effect at the next start (`restartKeys: '*'`).

### Backup procedure (BAK-02), as measured
1. `save-off`; expect `Automatic saving is now disabled` or `Saving is already turned off`.
2. `save-all flush`, over RCON, and wait for its reply: it contains `Saved the game` once the
   world is on disk (a console fallback waits for the `Saved the game` log line instead).
3. Copy `world/` without `world/session.lock`, plus the config files and lists.
4. `save-on`, always, even when the copy failed.
A player leaving during step 3 writes their own files; a copy that notices a file changing under
it (tar reports it) should copy that file again.

### Open questions (for the integrator and the owner)
- Which Minecraft versions are offered? Measured: 26.3 on 25, 1.20.6 on 21, 1.17.1 and 1.16.5
  on 17 (1.18–1.20.4 declare 17 themselves), so Temurin 25, 21 and 17 cover 1.16.5 and newer;
  older versions would need Java 8 (not tried on 17).
- Should the adapter turn Paper's bStats off by default (NFR-09 says the panel has no
  telemetry; this is the game's)?
- The management server (JSON-RPC over WebSocket; method names in
  `vanilla/api/json-rpc-api-methods.json`: players, allowlist, bans, operators, save, stop,
  settings, and join/leave/save notifications) could replace log parsing for players later.
  Not probed: its authentication and TLS behaviour are unverified.
- Paper version picker: offer only versions with a STABLE build by default, or show ALPHA/BETA
  with a warning?
- The panel's own `whitelist on|off` makes the game rewrite `server.properties` from memory:
  panel edits saved while the server runs must be re-applied before the next start.

### Unverified: needs a real client (the owner will check)
- Joining in **online mode** with a real account: the `UUID of player <name> is <uuid>` line on
  vanilla and Fabric (Paper printed it even offline), the join and leave lines with a real
  profile, and the kick / ban / whitelist messages as a player sees them.
- What `say` looks like in game from RCON (`[Rcon] …`?) versus `tellraw @a`, for the countdown
  messages (SRV-03).
- `whitelist on` with `enforce-whitelist` kicking online players; `white-list=true` refusing a
  real player (`You are not white-listed on this server!`).
- Stop time and memory with several players and a large world (the stop budget).
- Chat and the "Not Secure" marker with `enforce-secure-profile=true`.
- arm64 hosts.
