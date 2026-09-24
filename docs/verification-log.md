# B42 verification log

Facts measured on a real server, not taken from blogs. Each entry says how it
was verified. Fixtures live in `fixtures/b42/`.

## M1 spike — 2026-09-23

Setup: the GameServer bundled with the Steam client (`zombie.network.GameServer`,
**version=42.20.4 b0bbce05d5**, Zulu JRE 25, ZGC), run natively on Windows with
`-servername spike -cachedir=C:\pz-data`. It ran in no-Steam mode
("SteamUtils started without Steam"), so anything that needs a Steam client
joining is deferred to M3 (marked **→ M3**).

### Process and console
| Question | Answer |
|---|---|
| Ready line | `LOG  : Network      f:0 st:…> *** SERVER STARTED ****` at ~76 s cold. With RCON enabled it is followed ~50 ms later by `RCON: listening on port 27015`. |
| Version line | `version=42.20.4 b0bbce05d5 demo=false` in the first second. |
| First-run admin prompt | Without `-adminpassword`: `User 'admin' not found, creating it`, `Command line admin password: null`, `Enter new administrator password: ` then `Confirm the password: ` — the server blocks on stdin. Fail-fast pattern: `Enter new administrator password`. |
| `-adminpassword` on every start | Logs `admin password changed via -adminpassword option` each boot: the flag re-applies the password every start. The game never prints the password itself. |
| stdin commands | Work. Each is logged as `command entered via server console (System.in): "<cmd>"`. Multi-line replies are printed without the `LOG  :` header (`* additem : …`). |
| `save` | Prints `World saved`, then `SaveAll took N ms` … `Saving finish` / `Saving took N ms` (~100 ms on an empty world). |
| `quit` | Saves and exits with **code 0** in ~9 s: `Quit` → `Shutdown handling started` → `Server exited` → save lines → `Shutdown handling finished`. Works from stdin and RCON. The ini is **not** rewritten at shutdown. |
| `players` (empty) | `Players connected (0): ` followed by an empty line. With players **→ M3**. |
| `help` | Full command list captured (`logs/console-session.log`). Notable names: `kick` (usage says `/kickuser`), `banid`/`unbanid`, `setaccesslevel` (levels Admin, Moderator, Overseer, GM, Observer), `adduser`, `removeuserfromwhitelist`, `checkModsNeedUpdate` ("writes the answer to the log file"), `reloadoptions`, `changeoption`, `showoptions`, `servermsg`, `save`, `quit`, `stats`, `worldgen`. |
| Help/descriptions language | Follow the OS locale (Spanish here). `-Duser.language=en -Duser.country=US` switches the ini/sandbox comments and messages to English. **The agent passes these flags.** Log markers (`SERVER STARTED`, `World saved`, …) are English regardless. |

### RCON (fixtures `rcon/*.json`)
- Enabled only when `RCONPassword` is non-empty at boot; `RCON: listening on port 27015` confirms it.
- Auth reply: an empty type-0 packet then a type-2 packet, both with the request id (standard Source).
- Command replies are type 0 with the request id. **Long replies are split into several packets of at most 4096-byte `size`** (4086-byte bodies) with the same id and correct `00 00` terminators; concatenating the bodies (as bytes, since a split can land inside a UTF-8 character) gives the full text.
- **Sentinel works:** an empty type-0 packet sent after a command is answered with *two* empty type-0 packets carrying the sentinel id, after the full reply. The client ends a reply on the first sentinel echo (idle timeout as a fallback) — no need to guess from timing.
- RCON commands are **not** echoed into the log; their side effects are (e.g. the `save` lines).
- Unknown command → `Unknown command <name>`. `save` → `World saved`. `servermsg` → `Message sent.`. `quit` → `Quit`.

### Server ini (`config/server.{en,es}.ini`)
- UTF-8, **CRLF on Windows, no final newline**. Each key is preceded by a `# comment` in the server's language, and `Minimum=… Maximum=… Default=…` (ES: `Mínimo=… Máximo=… Por defecto=…`) appear inside the comment when relevant; many keys have no comment. 144 keys.
- The server **rewrites the whole file** at startup, on `changeoption` (immediately), and on `reloadoptions`. Rewrites regenerate its own comments and **drop unknown keys and user comments**.
- `reloadoptions` re-reads the file from disk and applies it (verified: `MaxPlayers` and `PauseEmpty` edited on disk show the new values in `showoptions`). Parse failures are logged, e.g. `ERROR IntegerConfigOption.parse() "ChatMessageSlowModeTime" string="3PanelTestKey"`, and then the value is left as it was. The panel must surface these lines after an apply.
- **A partial ini is completed with defaults** at boot while keeping the given values (`config/partial.*`). So first-run and factory reset can write only the managed keys plus the wizard's choices.
- `changeoption` preserves UTF-8 (`PublicName=Prueba Ñandú`).
- Other relevant keys: `ResetID`, `Seed`, `ServerPlayerID`, `UPnP=true` by default (must force `false`), `BackupsOnStart=true` (PZ's own zip backups in `backups/startup`), `WebhookAddress`/`Discord*` (built-in Discord, unused by us), `SaveWorldEveryMinutes=0`.

### SandboxVars.lua (`config/SandboxVars.{en,es}.lua`)
- `SandboxVars = { VERSION = 6, Key = value, …, Basement = {…}, Map = {…}, ZombieLore = {…}, ZombieConfig = {…}, MultiplierConfig = {…}, }` — one level of nesting, values are integers, decimals (`1.0`), booleans and double-quoted strings. Enum options are listed in comments as `-- 1 = Insane`.
- The server **reads it and rewrites it on every boot** (`writing …\spike_SandboxVars.lua`). Values edited on disk while stopped **survive** the rewrite. There is no `map_sand.bin` in B42 saves, so the file is the source of truth. (Whether a changed value affects already-generated chunks is game logic, not our concern.)
- Comments follow the locale like the ini. EN and ES files have identical key order, so bilingual metadata is generated by aligning them key by key.

### Spawn files
- `spawnregions.lua`: `function SpawnRegions() return { { name = "Muldraugh, KY", file = "media/maps/Muldraugh, KY/spawnpoints.lua" }, … } end` with a commented example line.
- `spawnpoints.lua`: `function SpawnPoints() return { unemployed = { { worldX = 40, worldY = 22, posX = 67, posY = 201 } } } end`.

### Data layout under `-cachedir`
```
Server/<n>.ini  <n>_SandboxVars.lua  <n>_spawnregions.lua  <n>_spawnpoints.lua
Saves/Multiplayer/<n>/   players.db vehicles.db map/ chunkdata/ metagrid/ isoregiondata/ apop/ zpop/ radio/
                         map_t.bin map_meta.bin map_zone.bin map_worldgen.bin map_animals.bin map_basements.bin
                         WorldDictionary.bin id_manager_data.bin global_mod_data.bin … (35 entries, 5.8 MB fresh)
db/<n>.db                accounts, roles, bans, capabilities
Logs/<date>_<time>_{DebugLog-server,admin,chat}.txt
backups/{startup,version}/backup_N.zip  backups/last_server_version.txt ("42.20")
server-console.txt  Crafting/  messaging/
```
- `db/<n>.db` (journal mode `delete`): `whitelist(id, world, username, password(bcrypt, 60 chars), lastConnection, role, authType, googleKey, steamid, ownerid, displayName)`, `role(id,name,…)` = 1 banned, 2 user, 3 priority, 4 observer, 5 gm, 6 moderator, 7 admin; `capabilities` (248 rows), `defaultRoles`, `bannedid(steamid, reason)`, `bannedip(ip, username, reason)`, `allowedsteamid`, `userlog`, `tickets`.
- `players.db`: `networkPlayers(id, world, username, playerIndex, name, steamid, x, y, z, worldversion, data, isDead)`; `vehicles.db`: `vehicles(…)`. Both journal mode `delete` → `node:sqlite` `backup()` is safe for hot backups.
- `Logs/<date>_admin.txt` lines: `[23-09-26 08:49:52.559] admin changed option PublicName=….`, `admin reloaded options.`, `admin closed server.`
- No `*_connections.txt` yet (no one connected) **→ M3**.

### Mods (`workshop/`, from the local Steam cache)
- `mod.info` is `key=value`; `description=` repeats; `require=\A,\B,` (backslash per id, trailing comma); `incompatible=A,B,` (no backslashes); `versionMin=42.20.2`; `modversion`, `author`, `poster`, `icon`.
- Folders per mod: root `mod.info` (B41), version folders (`42`, `42.0`, `42.13`, `42.19`, `42.20.1`) and `common/`. A mod with only a root `mod.info` (TheyKnew) has no B42 folder.

### Still open → M3 (needs the Linux dedicated server in Steam mode)
- `players` output with players, the connections log format, `ResetID` behaviour, `kick`/`banid` effects.
- `start-server.sh`: does it `exec`? JVM flag precedence; SIGTERM behaviour; files outside `-cachedir`; `steamclient.so`.
- Workshop download path and `Mods=`/`Map=` format written by the server; whether the dedicated app ships `media/lua/shared/Translate`.
- Docker Desktop source IPs, two simultaneous joins, UDP stability.

## M3 — 2026-09-23

- Agent verified against the fake server (`tools/fake-pz`): start → ready → players → RCON (split replies) → quit; crash → restart; crash loop → halt; ignored quit → SIGTERM; admin prompt → fail fast; ready timeout; lock suspends the watchdog; resume after agent restart.
- **Real-server run in Docker was blocked on the Windows test host**: Docker Desktop 4.87 crashes at startup because every AF_UNIX socket file it creates becomes inaccessible (Error 1920) — open bug [docker/desktop-feedback#676](https://github.com/docker/desktop-feedback/issues/676) on Windows 11 build 26200. The `pz` image and `compose.yaml` are written but **not yet built or run**. Options when resuming: Docker Engine inside WSL Ubuntu (mirrored networking), or a VPS.
- Still open from M1 (need the real Linux server): `players` output with players, connections log, `ResetID`, `start-server.sh` exec/`--` handling, JVM flag precedence, SIGTERM saving, files outside `-cachedir`, workshop paths, Translate files in the dedicated app, Docker source IPs.

## M12 — 2026-09-23

- **Caddy `tls internal` certificates live 12 h by default** (intermediate 7 d), per the Caddy docs. Browsers that remember a certificate exception per certificate (Firefox, Safari) would warn again after every renewal, several times a day. The Caddyfile now signs with the root (`sign_with_root`, `lifetime 180d`), so the certificate changes about every 4 months. Chrome still forgets exceptions after about a week. A real certificate needs DNS-01 or ports 80/443 (see `security.md`). **→ M13:** check that the Caddyfile loads, and look at the served certificate's validity.
- Mobile layout checked at 375 px on every page: the config rows, the backups table and the schedule headers were fixed. Users and Activity log scroll sideways, which is fine for owner/admin tables.
- **`node:sqlite` `backup()` stalled** for 30 s to 270 s in about a third of calls under vitest (Node 26.7). 40 runs each on a plain main thread and in a plain worker thread never stalled, but the cause is unknown. Hot backups now use `VACUUM INTO` from a read-only connection instead: synchronous, one read transaction, so still a consistent snapshot. The hot-backup test went from 19 s to 0.6 s.

## M13 go-live — 2026-09-23 (Docker Desktop 29.7.2 on Windows 11)

- Docker Desktop started normally at 21:48 (engine up in 70 s) without a reboot. The AF_UNIX socket bug from M3 didn't come back. Another Compose project already using 80/443 on the same Docker was untouched.
- Both images built on the first try. First start failed twice, both fixed:
  - `pz` got EACCES on `/data`. The panel image had `/data` owned by root, and whichever container mounts an empty shared volume first sets its owner. The panel image now creates `/data` and `/opt/pz` as `node`.
  - Caddy: `exec /usr/bin/caddy: operation not permitted`. The official binary carries the `cap_net_bind_service` file capability, so it can't run with `cap_drop: ALL`. Compose now adds back only `NET_BIND_SERVICE`.
- Caddy loads the Caddyfile. The certificates for the DDNS name, the LAN IP and `localhost` are valid 180 days (notBefore 2026-09-24 00:53 UTC, notAfter 2027-03-23), as intended.
- **steamcmd, first `app_update 380870` on a fresh install:** `ERROR! Failed to install app '380870' (Missing configuration)` right after anonymous login. The second try installed it. Captured in `logs/steamcmd-first-install.log`; the error is now retried. steamcmd also prefixes lines with `ESC[0m`, which the agent now strips.
- Install: 6.9 GB in `/opt/pz`, public branch **buildid 24909836** (the dedicated server app has its own build ids, unrelated to the client's).
- `start-server.sh` does **not** `exec`. It runs `./ProjectZomboid64 "$@"` under `LD_PRELOAD=libjsig.so`, then always `exit 0`. So the exit code never shows a crash. The agent treats any exit it didn't request as a crash, so the watchdog is unaffected. Signals go to the whole process group.
- `ProjectZomboid64.json` vmArgs: `-Djava.awt.headless=true -Xmx8g -Dzomboid.steam=1 -Dzomboid.znetlog=1 -Djava.library.path=linux64/ -Djava.security.egd=file:/dev/urandom -XX:+UseZGC -XX:-OmitStackTraceInFastThrow`.
- The dedicated app ships `media/lua/shared/Translate/{EN,ES,…}`, including `Sandbox.json` and `UI.json`.
- Still open, needs the server running with players: which `-Xmx` wins (ours vs. the json), `players` output with players, the connections log, the source IPs PZ sees through Docker Desktop, the workshop download path, `ResetID`.
- **Real certificate via DuckDNS (v0.13.0), 2026-09-24 01:42 UTC:** The DuckDNS name resolves to the same public IP as the existing No-IP name. The DNS-01 challenge through the DuckDNS TXT record was valid on the first try. The Let's Encrypt certificate (issuer YE1, 90 days, renewal handled by Caddy) was obtained about 10 s after start. A strict client validates it. The panel is also reachable at `https://<name>.duckdns.org:8443` through the public IP from inside the LAN, so the router supports loopback and the TCP 8443 forward works. The LAN IP and `localhost` keep the internal certificate.
