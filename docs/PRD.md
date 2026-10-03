# Game Server Panel — Product Requirements

| | |
|---|---|
| Status | Draft 0.29 |
| Date | 2026-09-24 |
| Name | `gameserver-panel` |
| License | PolyForm Noncommercial 1.0.0 (D9) |
| Grows out of | [zomboid-server](https://github.com/pepenotti/zomboid-server), which stays as it is |

This document is the plan. Work that can't be traced to a requirement ID or a
milestone here doesn't get built until this document says so (see
[change control](#14-change-control)).

---

## 1. Summary

A self-hosted web panel that runs **several game servers side by side on one
machine**, starting with Project Zomboid, Minecraft Java, Terraria and Valheim.
It aims for the same depth zomboid-server gives Project Zomboid:
- real configuration forms;
- safe backups, restores and resets;
- players, mods and schedules;
- Discord alerts;
- accounts with roles and 2FA;
- English and Spanish.

zomboid-server keeps serving a single Project Zomboid server. Its code seeds this
project, and its Project Zomboid support becomes the first **game adapter** here.

## 2. Problem

Groups of friends who host their own game servers pick between two options:

- **Generic panels** (Pterodactyl, Pelican, AMP, Crafty) run many games, but
  shallowly. Settings are raw files, backups are folder zips, and nothing knows
  a game's own rules: how to save before a backup, which settings need a
  restart, which mods depend on which.
- **Single-game tools** such as zomboid-server go deep, but only for one game,
  and one server at a time.

The goal is the depth of the second with the reach of the first, for a few
games people actually play together.

## 3. Goals

| ID | Goal |
|---|---|
| G1 | Run several servers (same or different games) from one panel, each isolated from the others. |
| G2 | Game-aware depth for every supported game: settings forms, safe backups and restores, resets, players, mods, update policies. |
| G3 | Project Zomboid support at least as good as zomboid-server (parity). |
| G4 | Adding a simple Steam game takes a declarative manifest, not new code. |
| G5 | The same security bar as zomboid-server: an internet-facing panel with roles, 2FA and an audit log. |
| G6 | Usable by non-technical friends, on a phone, in English or Spanish. |
| G7 | Easy by default, never a ceiling: forms for the common settings, and anything too complex for a form stays fully editable as text in the browser. |
| G8 | Ready for an optional assistant later, without redesigning the panel (see D8). |

### 3.1 Product principles

These settle UX disagreements. When a design choice is unclear, the one that
fits these wins.

1. **Easy by default.** The settings people change most get forms, with
   plain-language help in EN/ES and sensible defaults. Rare and advanced
   settings sit behind an "Advanced" section and search; they are never removed.
2. **Never a ceiling.** Every configuration file a game reads can be opened
   and edited as text in the browser. If a setting is too complex for a form
   (nested lists, plugin configs, per-mod settings), the text editor is the
   answer, not a missing feature.
3. **Forms and text agree.** A change made in one shows up in the other. The
   text editor keeps unknown keys and, where the format allows, comments.
4. **Safe by default.** Validate before saving, show what will change
   before applying it, back up before anything destructive, and offer undo.
5. **Explain, don't hide.** Locked settings say why. Settings that need a
   restart say so. Features a game doesn't support are explained, not just
   greyed out.

## 4. Non-goals (v1)

- Hosting for strangers: billing, customer quotas, hard multi-tenant isolation.
- More than one host machine (nodes, clusters).
- Windows-only dedicated servers run under Wine (e.g. Enshrouded, V Rising).
- x86-only game servers on ARM hosts (e.g. anything installed with steamcmd on
  an Apple Silicon Mac or a Raspberry Pi). The panel says why instead (HST-05).
- Minecraft Bedrock; CurseForge (needs an API key and has its own terms).
- Valheim mods (BepInEx / Thunderstore).
- Moving the live Project Zomboid server off zomboid-server (it stays there
  for now; the importer HST-04 is P2).
- Game clients, launchers, voice servers.
- Automatic router configuration (UPnP). Port forwards stay a documented manual step.
- Shipping an AI assistant. v1 is only built to be ready for one (G8, D8, [AST](#812-assistant-readiness--ast)).

Each can move into scope later through [change control](#14-change-control).

## 5. Users and roles

| Role | Who | Can |
|---|---|---|
| Owner | Runs the host. Exactly one. | Everything, on every server, including users and host settings. |
| Admin | A trusted friend | Manage servers: create, delete, configure, mods, restore, reset. Per server, or on all servers. |
| Operator | Runs a server day to day | Start, stop, restart, broadcast, back up, kick, ban. |
| Viewer | Wants to see what's going on | Status, players, schedules. |

- Roles are **granted per server**. Only the owner, and admins granted "all
  servers", act everywhere. Technically an account has a scope: `all` (its
  role applies to every server) or `granted` (only the servers it has a
  grant on, each with its own role). Creating servers and the host overview
  need an admin (or the owner) with scope `all`.
- A server someone has no role on doesn't exist for them: the API answers
  "not found" rather than "forbidden".
- 2FA is mandatory for admins and the owner.
- Accepting a game's EULA is the owner's alone (D6).
- People who only play need no account.

## 6. Concepts

- **Host**: the machine that runs the stack.
- **Game adapter**: everything the panel knows about one game. That covers
  installing and updating it, launching and stopping it, talking to it,
  settings, players, mods, backups and resets.
- **Server** (instance): one running copy of a game, with its own data,
  ports, schedules, backups, mods, settings history and permissions.
- **Capability**: something an adapter supports, such as `rcon`,
  `stdinConsole`, `hotBackup`, `players`, `whitelist`, `mods:workshop`,
  `mods:modrinth`, `broadcast`. The UI shows only what a server's adapter
  supports, and the API refuses the rest.

## 7. Supported games (v1)

| Game | Flavours | Install | Control | Settings | Mods | Default ports |
|---|---|---|---|---|---|---|
| Project Zomboid (Build 42) | — | steamcmd | RCON + stdin | server ini, `SandboxVars.lua`, spawn files | Steam Workshop | UDP 16261–16262 |
| Minecraft Java | vanilla, Paper, Fabric, Forge, NeoForge (picked per server) | official downloads and loader installers, version pinned | RCON + stdin | `server.properties`, whitelist / ops / bans, plugin and mod configs | Modrinth (Paper plugins; Fabric, Forge and NeoForge mods) | TCP 25565 |
| Terraria | vanilla, TShock, tModLoader | terraria.org download / TShock and tModLoader releases on GitHub; tModLoader's Workshop mods with steamcmd | stdin; TShock adds its REST API | `serverconfig.txt`, world options, TShock config | TShock plugins; tModLoader via Steam Workshop | TCP 7777 |
| Valheim | — | steamcmd | none: signals (both save) + log parsing; Steam queries count players on public servers | launch options, admin / banned / permitted lists (SteamIDs) | — (v1) | UDP 2456 and the next port (the same numbers inside and out) |
| Other Steam games (first: Avorion) | — | steamcmd | per manifest (stdin or signals) | raw files, launch options from the manifest | — | per manifest |

- **Minecraft EULA:** Minecraft needs the owner to accept Mojang's EULA. The
  panel asks explicitly and never accepts it on the owner's behalf: only the
  owner accepts it, when creating the server or later on its page, with the
  agreement's link in front of them. Until then the server can't start, and
  its game is told the EULA was accepted only after that.
- **Minecraft versions and privacy:** the panel offers Minecraft 1.16.5 and
  newer (Q11). New Paper servers start with bStats usage statistics off; the
  owner can turn them on like any other setting (Q10, NFR-09).
- **Minecraft's lists:** the running game writes its operator and ban lists
  back from memory, so the panel changes those files only while the server is
  stopped; the whitelist is re-read at once, and switching it on or off keeps
  the settings saved since the server started. The panel refuses list files
  the game couldn't load (entries must be the objects the game writes; players
  are added on the Players page), and when an operator's `whitelist on|off` in
  game writes `server.properties` from memory, the settings the panel saved
  since the start are put back before the next start the panel makes.
- **Terraria:** tModLoader runs on Terraria 1.4.4 while vanilla and TShock
  follow 1.4.5, and its players need tModLoader. Vanilla Terraria bans by IP
  address only; behind Docker Desktop every player arrives from the same
  address, so the panel warns before a vanilla ban there. No Terraria flavour
  has a license to accept before its server runs (Steam's tModLoader EULA
  covers the Steam client, not the GitHub release the panel installs).
  terraria.org publishes no checksums: the panel checks the dedicated server
  versions it measured against the checksums it recorded, and marks a newer
  version it can't check yet. Large Terraria worlds need 2 GiB; tModLoader
  starts at about 1 GiB before any mod. A Terraria server's world is named
  after the server's ID, the name the game uses for its files. Vanilla
  Terraria and tModLoader keep their bans in memory: the panel lifts a ban
  while the server is stopped. TShock loads plugins only at start and skips
  one it can't load without a word; the panel keeps them in the server's data
  and puts the enabled ones in place before each start. tModLoader takes each
  Workshop mod from the newest folder built for its version.
- **Valheim:** it has no server console: the panel stops it with a signal (it
  saves first), can't warn players in game or ask it to save, and its running
  backups copy the newest complete save it made on its own timer (the save
  set the game marked complete and the chunk files it uses; the panel
  passes a 5-minute save interval instead of the game's 30 minutes). A server
  can be listed in the game's public list (off by default, Q15); a listed
  server needs a password of at least 5 characters that isn't part of its
  name, checked before it starts. Crossplay is offered, off by default (Q14):
  it needs extra libraries in the steam image and registers the host's
  public address with Microsoft's PlayFab, which also shows in the server's
  log. Valheim uses about 1.5 GiB and a third of a CPU core even when empty.
  Its admin, ban and allowed lists (SteamIDs) are changed only while it is
  stopped. World presets and modifiers aren't offered in v1.
- **After v1, Counter-Strike 2 first** (owner, 2026-10-03, Q16–Q18): the
  dedicated server is Steam app 730 (tens of GB, so shared installs come
  first, HST-09); control by its console and Source RCON; maps and game modes
  as launch settings; a Game Server Login Token per server (a secret; without
  one only home-network players can join, to be measured); updates are
  frequent and forced, so update policies matter; bans by SteamID. Then, as a
  second step, Metamod and CounterStrikeSharp plugins from their releases,
  admins only with a warning, re-applied after every game update (an update
  overwrites the file that loads them). Measured first, as every game (D5).
- **Steam manifests:** a game can be added with a manifest alone when it
  installs anonymously with steamcmd, runs in the steam image as it is, says
  when it is ready, and stops cleanly with a console command or a signal.
  The first is Avorion (measured in M6). Their own settings files are edited
  as text (no forms); their launch settings have a form with the manifest's
  checks. A manifest says whether its install can be shared and which paths
  the game writes inside it.
- **Avorion:** its console takes slash commands (the panel adds the slash);
  it writes its `server.ini` from memory, so the panel edits it only while it
  is stopped; a server that isn't listed publicly should keep the default
  query port 27003 (the game warns otherwise); its own hourly backups go to
  the server's data volume from a galaxy's second start (the game writes
  `server.ini` on the first).
- **CPU architecture:** Minecraft runs on x86-64 and ARM64 hosts (its server
  jars are Java and carry ARM64 native libraries; the fact-finding ran x86-64
  only, so an ARM64 run is part of M7). Servers
  installed with steamcmd need x86-64. Terraria's servers need x86-64
  (vanilla ships no ARM64 build; TShock's ARM64 builds are unverified). Each
  adapter declares what it runs
  on, confirmed in its milestone (HST-05).
- **Measured, not guessed:** details marked here, like readiness lines, stop
  commands and file formats, are confirmed against a real server in each
  game's first milestone, as zomboid-server did (see D5).

## 8. Functional requirements

Priorities: **P0** blocks v1 · **P1** is a v1 target · **P2** comes later.

### 8.1 Servers — SRV

| ID | P | Requirement |
|---|---|---|
| SRV-01 | P0 | Create a server from an adapter: name, game, flavour and version, ports, memory limit. Port conflicts with other servers and with the host are refused. |
| SRV-02 | P0 | List servers with their state, players, version and next scheduled restart. Each server has its own pages. |
| SRV-03 | P0 | Start, stop, restart and kill. Stop and restart use countdown warnings wherever the game can message players. |
| SRV-04 | P0 | Delete a server after typing its name. A final backup is taken first; backups are kept unless the owner chooses otherwise. The owner may force the removal of a server that can't be stopped, won't run or whose agent can't be reached: the final backup is still taken when possible, and the result says when it wasn't and why. |
| SRV-05 | P0 | Memory and CPU limits per server. Whoever may change a server's limits sees the most the host allows one server. New limits, a newer runtime image, a new install version and a new way of building containers from a panel update apply at once to a stopped server and at its next start to a running one. A host view warns when the limits add up to more than the host has. |
| SRV-06 | P0 | Each server returns to its previous state after a Docker or host restart, and after a product upgrade, on the newer runtime image from its next start. After an orchestrator release that builds containers another way, a running game's container is kept until the game's next start. |
| SRV-07 | P0 | Per-server crash watchdog that halts after repeated crashes, as in zomboid-server, and says why: the last fatal line the game printed (redacted). |
| SRV-08 | P0 | Connection info per server, for everyone who can see it: what players type to join, in that game's own words and format (the address, the port players use and its protocol, the client and version they need, whether a password is set, and extra steps such as a whitelist), for three places: this PC, the home network and the internet. Each line has a copy button, and a Share button opens the phone's share sheet where the browser has one (copy otherwise). It also lists the router forwards the server needs (ports and protocols). An admin of the server or the owner may include the password in what is shared (each time is audited); nobody else sees it. Facts about joining (which port a client uses) are measured per game (D5) and marked unverified until a real client confirms them. |
| SRV-09 | P2 | Clone a server: settings only, or settings plus world. |

### 8.2 Install and updates — UPD

| ID | P | Requirement |
|---|---|---|
| UPD-01 | P0 | Install from the adapter's source, once per game, flavour and version (HST-09), with progress shown in the UI. |
| UPD-02 | P0 | Choose and pin a version: Steam branch, Minecraft version, loader version. The create form lists the versions a game's download services offer before the server exists. |
| UPD-03 | P0 | Update checks with a per-server policy: apply when nobody is playing, apply after a countdown, or only notify. Applying an update moves the server to the new version's install at its next start; the new version is downloaded once for every server on the old one. |
| UPD-04 | P0 | Every update takes a safety backup first. |
| UPD-05 | P0 | Minecraft never moves to a new game version on its own, since that breaks mods and worlds. It only takes builds of the pinned version (for Paper, from the pinned build channel or a more stable one: STABLE unless an admin picks BETA or ALPHA, with a warning), unless an admin chooses a new version. |
| UPD-06 | P0 | Minecraft's loader is picked per server when it's created: vanilla, Paper or Fabric. |
| UPD-07 | P1 | Forge and NeoForge as loader choices too. The adapter runs their installers and pins the loader version. |
| UPD-08 | P2 | Switch an existing Minecraft server to another loader, as a guided change with a backup, since worlds and mods may not carry over. |

### 8.3 Settings — CFG

| ID | P | Requirement |
|---|---|---|
| CFG-01 | P0 | Settings forms from each adapter's schema: types, ranges, choices, EN/ES descriptions, search. |
| CFG-02 | P0 | Raw editor per file, validated by format. Files the game executes (Lua) must parse as plain data. |
| CFG-03 | P0 | History per file, with diff and one-click revert. |
| CFG-04 | P0 | Settings the panel manages itself (ports, RCON, paths), and keys the game writes itself (e.g. a file's format version), are locked. Secrets a game keeps as keys (TShock's REST tokens) are hidden and locked whole. |
| CFG-05 | P0 | Each setting says when it applies (live, or after a restart), and the UI shows a pending-restart badge. |
| CFG-06 | P1 | Presets per game (e.g. Project Zomboid sandbox presets, Minecraft difficulty and game mode). |
| CFG-07 | P0 | **Text editor for every config file.** Admins can browse the configuration folders each adapter declares (game settings, plugin and mod configs) and edit any text file there in the browser. It has syntax highlighting for the format (properties, ini, YAML, TOML, JSON/JSON5, Lua, plain text), validation where a parser exists, a diff preview before saving, and history with revert (CFG-03). |
| CFG-08 | P0 | **Editor safety.** Only paths inside the adapter's declared folders; no symlinks out; text files only, with a size cap. Files the game runs as code (e.g. Project Zomboid's `SandboxVars.lua`) must parse as plain data (CFG-02); scripts and binaries (`.jar`, `.dll`, `.sh`, mod code) are never editable. Panel-managed keys (CFG-04) are re-applied on save, with a note explaining why. |
| CFG-09 | P0 | Forms and text stay in sync (principle 3): editing either updates the other; unknown keys are kept, and so are comments where the format allows. A file the game itself rewrites and prunes (TShock's config) says so. |
| CFG-10 | P1 | "Advanced" section and search in every settings form, so rare settings are reachable without cluttering the common ones (principle 1). |

### 8.4 Console and logs — CON

| ID | P | Requirement |
|---|---|---|
| CON-01 | P0 | Live log per server for operators and up, with secrets redacted and a filter. A run of progress lines (a world being generated prints one per step) shows as its latest line, updated in place, so a first boot's install and start lines stay in the live log; every line still counts for readiness and failures. |
| CON-02 | P0 | Raw console (RCON or stdin) for admins, with command arguments sanitised. Commands longer than the game's control channel takes are refused before they are sent (Minecraft's RCON: 1446 bytes of text). |
| CON-03 | P1 | Broadcast a message to players where the game supports it. |
| CON-04 | P0 | Terraria with TShock is controlled through TShock's REST API for players, kick, ban and broadcast. The API is bound to the server's internal network only, never published, with a token the agent generates and keeps in TShock's config, masked like other secrets. Vanilla Terraria and tModLoader use stdin. |

### 8.5 Players — PLY

| ID | P | Requirement |
|---|---|---|
| PLY-01 | P0 | Online players, wherever the game exposes them (RCON, stdin or logs). Asking a game's console for its players stays out of the live log; the same command sent by a person shows like any other. |
| PLY-02 | P1 | Join and leave history. |
| PLY-03 | P0 | Kick, ban and unban, whitelist, and operator/admin levels, mapped to what each game supports: a ban names a player, an address, a Steam account, a game client's ID or a server account, as the game takes them. |

### 8.6 Mods — MOD

| ID | P | Requirement |
|---|---|---|
| MOD-01 | P0 | Project Zomboid Steam Workshop mods, at parity with zomboid-server. |
| MOD-02 | P0 | Minecraft through Modrinth: search, add by link or ID, filter by the server's loader and game version, resolve dependencies, check for updates. Covers Paper plugins and Fabric mods, plus Forge and NeoForge mods once UPD-07 lands. |
| MOD-03 | P1 | tModLoader mods through the Steam Workshop, reusing the Project Zomboid code. tModLoader reads only what is on disk: the panel downloads the enabled mods that are missing or have an update before each start. |
| MOD-04 | P1 | Mod update checks with the same policies as game updates (UPD-03). |
| MOD-05 | P2 | Thunderstore (Valheim), CurseForge. |
| MOD-06 | P1 | TShock plugins: add by upload (a plugin file or a zip of them) or by a GitHub release link that the server's own agent downloads (HTTPS, GitHub's hosts only, every redirect checked, 16 MiB at most), enable, disable, remove, with a restart badge. There's no central catalogue, so no dependency resolution. Admins only, with a warning that plugins run code inside the server; the audit log records each file's name, size and SHA-256 and where it came from. |

### 8.7 Backups, restore, reset — BAK

| ID | P | Requirement |
|---|---|---|
| BAK-01 | P0 | Per-server backups (manual, scheduled, before updates, restores and resets, and a final one before a server is removed), each with a manifest, a checksum and retention per server. Game installs are not part of backups. |
| BAK-02 | P0 | Consistent backups while running, using each game's own method. Project Zomboid: `save`, then SQLite snapshots. Minecraft: `save-off`, `save-all flush`, then `save-on` after the copy. Otherwise save, then copy, or a stopped-server backup. Valheim can't be asked to save: the copy takes the newest complete save the game made, without waiting for one in progress. |
| BAK-03 | P0 | Restore with a choice of parts, a staging folder, atomic swap and undo. |
| BAK-04 | P0 | Reset scopes from each adapter (world only; world and players; factory). A backup is always taken first. |
| BAK-05 | P1 | Download (admins) and upload (owner) of backups. Every uploaded archive entry is validated. |
| BAK-06 | P1 | Nightly copy of the panel's own database. |

### 8.8 Schedules and notifications — SCH

| ID | P | Requirement |
|---|---|---|
| SCH-01 | P0 | Per-server schedules: restarts with a quiet backup, backups, update checks. |
| SCH-02 | P1 | Stagger jobs so servers don't restart or back up at the same moment. |
| SCH-03 | P0 | Discord webhooks with per-event switches in EN/ES. One host webhook; each server may override it with its own webhook, language and event switches. Every message names its server. |

### 8.9 Accounts, permissions, audit — ACC

| ID | P | Requirement |
|---|---|---|
| ACC-01 | P0 | Accounts, 2FA, sessions and the host recovery tool, as in zomboid-server. |
| ACC-02 | P0 | Global roles plus per-server grants, enforced on every route and websocket topic. Tests prove nobody reaches a server they have no grant for. |
| ACC-03 | P0 | Audit log with the server on every entry, filterable by server or by the host's own entries (sign-ins, accounts, host settings), which only admins on every server see. |

### 8.10 Host and access — HST

| ID | P | Requirement |
|---|---|---|
| HST-01 | P0 | One Docker Compose stack for the panel, the orchestrator and the TLS proxy. Game servers are containers the orchestrator creates. A product upgrade reaches every server: a server whose runtime image was rebuilt moves to it at its game's next start (at once when its game is stopped), never while its game runs. |
| HST-02 | P0 | HTTPS with a self-signed certificate, or Let's Encrypt through DuckDNS, as in zomboid-server. |
| HST-03 | P1 | Host overview: CPU, memory and disk per server and in total. |
| HST-04 | P2 | Import an existing zomboid-server deployment: world, settings, mods, backups and panel users. (The live server stays on zomboid-server for now; Q7.) |
| HST-05 | P0 | **Runs on the main operating systems through Docker:** Linux (Docker Engine), Windows 10/11 (Docker Desktop or Docker Engine in WSL) and macOS (Docker Desktop). x86-64 and ARM64 hosts work. Adapters declare the CPU architectures they support, and the panel won't create a server the host can't run natively; it says why instead. |
| HST-06 | P0 | A setup and operations guide for each of Linux, Windows and macOS, with firewall and router notes. |
| HST-07 | P0 | The panel knows what its host can't do and says so where it matters: the orchestrator reports the host's traits (CPU architecture, the memory Docker gives it, and whether players' addresses reach the games, which they don't through Docker Desktop's port relay), the host page lists the limitations that apply, and each affected feature (address bans, per-address game settings, addresses in the activity log) shows its own note. |
| HST-08 | P0 | Public address: the owner sets the name friends use to reach this host, a DNS name (by default the DuckDNS name the panel already uses for HTTPS, when there is one) or an IP address, and optionally the host's address on the home network (by default the panel's `LAN_IP` when it is a private address). A "detect" button asks one fixed public service for this host's public IP, only when the owner presses it (NFR-09). Every server's connection info (SRV-08) uses these. |
| HST-09 | P0 | Shared installs (D12): a game's server files are downloaded once per game, flavour and version, and every server on that version mounts them read-only, so a second server never downloads them again. An update installs the new version beside the old one and each server moves to it at its next start; a version no server uses is removed after the owner confirms. The host page shows each install, its size and the servers using it. The install job runs as its own short-lived container with the same hardening as a server; the panel shows its progress on the server's page and the host page. Installs are never backed up. |

### 8.11 Language and usability — UX

| ID | P | Requirement |
|---|---|---|
| UX-01 | P0 | EN/ES for all of the UI, game setting labels, Discord messages and in-game warnings. |
| UX-02 | P0 | Every page usable on a phone. |
| UX-03 | P1 | First-run wizard that walks the owner through the first server. |
| UX-04 | P0 | Known limitations stated plainly: `docs/limitations.md` lists every limitation that changes what a feature does or how safe it is, by host platform and by game, each with what people will notice, why, the workaround and the fix if there is one, and whether it was measured (where) or is only expected. The panel links to it from the host page and from each in-app note (HST-07). A change that finds a limitation adds it in the same change. |

### 8.12 Assistant readiness — AST

v1 ships no assistant, but it's built so an optional one can be added later
without a redesign (G8, D8). The P0 and P1 items below are cheap and useful
on their own; only AST-05 is the assistant itself.

| ID | P | Requirement |
|---|---|---|
| AST-01 | P0 | **API first.** Everything the UI can do goes through the documented, permission-checked HTTP API; there are no UI-only actions. A future assistant uses the same API, as the signed-in user, with that user's permissions. |
| AST-02 | P0 | The audit log records **who acted and as what**: a person, a schedule, the host recovery tool, or an assistant acting for a person. |
| AST-03 | P1 | **Propose, preview, approve.** Settings and file changes can be submitted as a proposal, shown as a diff, and applied only after a person approves. The text editor's preview (CFG-07) uses the same flow a future assistant would. |
| AST-04 | P1 | **Machine-readable context** through the API: each adapter's settings schema with EN/ES descriptions, its capabilities, its console command catalog, and the server's recent log, with secrets masked. |
| AST-05 | P2 | **Optional assistant.** Off by default; only the owner can turn it on. It acts only as the signed-in user, and every change goes through AST-03 and is audited. Secrets and redacted log lines never leave the host. It is clearly labelled in the UI, and a server can run entirely without it. |
| AST-06 | P2 | **Providers** behind one pluggable interface, with the owner's own API keys. Planned: Anthropic, OpenAI, Google Gemini and xAI Grok. Also local models, through Ollama or any OpenAI-compatible endpoint, so nothing has to leave the host. There's no default provider: the owner picks one when turning the assistant on. |

## 9. Non-functional requirements

| ID | Area | Requirement |
|---|---|---|
| NFR-01 | Security | At least zomboid-server's controls, listed below. |
| NFR-02 | Security | The **orchestrator** is the only component with Docker access, and its API is narrow (see D3). Every server container gets `cap_drop: ALL`, `no-new-privileges`, a non-root user and a memory limit. It is never privileged, never on the host network, and has no host mounts beyond its own volumes and the install of its game version, mounted read-only. Install jobs are built the same way and publish no ports. Images come from an allowlist. An upgrade never loosens a container: one kept across an orchestrator release is one this stack's orchestrator created from the same spec, and a release that closes a security gap in how containers are built recreates every container built before it at once, even while its game runs, and says so in the audit log. |
| NFR-03 | Isolation | Each server gets its own internal network. A game container can't reach the panel, the orchestrator or another server. The panel and the orchestrator listen on unix sockets in volumes only they (and the TLS proxy, for the panel) mount, and the orchestrator has no network at all. A game server can still reach the public HTTPS address like any internet client. |
| NFR-04 | Reliability | Graceful stop with a time budget per game; state survives restarts; watchdogs per server. |
| NFR-05 | Portability | Linux, Windows and macOS through Docker, on x86-64 and ARM64, within each adapter's declared architectures (HST-05). Nothing in the core depends on the host OS. |
| NFR-06 | Footprint | Panel under 512 MB of RAM; agent overhead under 64 MB per server; the UI stays responsive with 10 servers. |
| NFR-07 | Testability | Each adapter has fixtures captured from a real server and a fake server for integration tests, and passes the shared adapter contract suite. `scripts/verify.sh` gates every commit. |
| NFR-08 | Maintainability | Adapters live in their own packages. The core never imports game-specific code or names a game; a lint rule and a test enforce it. |
| NFR-09 | Privacy | No telemetry. Secrets live only in `.env` and the database. The repository names no real host, person, IP or hostname. No server data leaves the host unless the owner turns on an optional integration that needs it (Discord, a future assistant), and even then secrets are masked. Output captured from a real server passes through `scripts/scrub-fixture.mjs` (and a person's reading) before it becomes a fixture. |

NFR-01's controls, carried over from zomboid-server:
- scrypt password hashes;
- server-side sessions in `__Host-` cookies;
- the exact Origin allowlist, plus the CSRF header;
- per-account sign-in slowdown with a global breaker;
- TOTP with recovery codes;
- strict CSP;
- schema validation on every route;
- argument-array process spawning;
- data-only writes to executable config files.

## 10. Architecture (proposed)

```
 browser ── HTTPS ──▶ caddy ──▶ panel ──(token)──▶ orchestrator ──▶ Docker Engine
                                   │                                    │ creates
                                   │ per-server network, token          ▼
                                   └──────────────▶ server container: agent + game  (one per server)
 players ── game ports ────────────────────────────▶ server container
```

- **Panel.** zomboid-server's panel, generalised:
  - a server registry;
  - per-server services (settings, backups, mods, schedules, players) keyed by server ID;
  - an adapter registry for the panel-side parts: settings schemas, mod sources, reset scopes, messages.
- **Agent.** zomboid-server's agent, generalised. It holds the runtime side of
  an adapter: install, launch, readiness, stop, control channel and player
  queries. There is one agent per server, inside that server's container.
- **Images per runtime family.**
  - `steam` (steamcmd and its libraries): Project Zomboid, Valheim, tModLoader
    (with Microsoft's .NET 8 runtime; steamcmd fetches its Workshop mods, the
    game itself comes from GitHub) and manifest games; Valheim's crossplay
    needs `libatomic1`, `libpulse0` and `libpulse-mainloop-glib0`.
  - `java` (Eclipse Temurin JREs 25, 21 and 17, picked per server from the
    Java major its Minecraft version declares): Minecraft.
  - `native` (with Microsoft's .NET 9 runtime): vanilla Terraria and TShock.

  Each adapter names its image; a flavour may name another one.
- **Orchestrator.** A small service that holds the Docker socket. It creates,
  starts, stops and removes server containers, volumes and networks from a
  fixed, validated spec, and does nothing else. It is reachable only by the
  panel and authenticates with a token.
- **Adapter contract** (`packages/adapter-api`): capabilities, install, launch,
  control, readiness, players, settings schema, backups (paths and the
  running-server method), reset scopes, mod sources, EN/ES strings.
- **Declarative adapters.** Simple Steam games are one manifest (a JSON file
  checked against a schema): app ID and branches, launch command with
  placeholders and typed launch settings, ports, readiness and fatal
  patterns, stop method, save command and its done line, config files (raw
  editing, with managed and secret keys), backup paths and how a running
  server is copied, player lines, moderation by console commands or list
  files, and notes for the limitations people see. Each manifest is an
  adapter of its own ID. A game whose manifest can't say everything adds code
  hooks (Valheim: which save files a running backup takes, and its player
  count from Steam's server queries).
- **Data.** SQLite, with the server ID on every per-server table. Volumes are
  named by server ID, installs by install ID (HST-09), and backups go to `BACKUP_DIR/<server>/`. `servers`
  keeps each server's row, including the fixed name the game uses for its
  files (`game_name`); per-server settings live in `server_settings` and
  per-server roles in `server_grants`. Server routes are
  `/api/servers/<id>/…`; the web addresses a server as `/s/<id>/…`. A server
  someone can't see answers "not found" before its request body is even
  checked. The API reference `docs/api.md` is generated from the route table
  and a test fails when it goes stale.
- **Package layout.** `packages/adapter-api` holds the contract (types plus
  shared contract test suites). Each game lives in `packages/adapter-<game>`,
  and `packages/adapters` is the single place that lists them, each enabled
  or not: an adapter whose game hasn't been measured yet (D5) is registered
  but not offered. Mod sources several games share live in
  `packages/source-<name>` (`source-workshop`: the Steam Workshop, for
  Project Zomboid and tModLoader). The core
  (`shared`, `formats`, `agent`, `panel`, `web`) never imports a game
  adapter; a lint rule enforces it (NFR-08). Captured output lives in
  `fixtures/<game>/<build>/` and measured facts in
  `docs/verification/<game>-<build>.md`.
- **Config files.** Each adapter declares its editable folders and each
  file's format. A format registry (parse, validate, serialise, highlight)
  serves both the forms and the text editor, so they can't drift apart
  (CFG-07…09). It covers ini, Java properties, Lua data, JSON, JSON5, YAML,
  TOML and line lists; edits keep comments and unknown keys, and an edit a
  format can't make in place (a value inside a TOML inline table) is left to
  the text editor rather than done by rewriting the file.
- **Assistant readiness.** The API is the only way to act (AST-01). Changes
  can be proposals awaiting approval (AST-03). Adapters describe themselves in
  machine-readable form (AST-04). A future assistant plugs in as one more API
  client, not as a special path.

### Decisions

| ID | Decision | Why | Alternatives considered |
|---|---|---|---|
| D1 | Multi-server panel on a single host. | The chosen scope. One machine keeps it simple for friend groups. | One game per install: smaller, but doesn't meet G1. |
| D2 | A new repository seeded from zomboid-server's public `main`. zomboid-server is frozen except for fixes. | The live server stays safe while this project restructures freely. | Evolving zomboid-server in place: risky for a working server. |
| D3 | One container per server, plus short-lived install jobs, created by an orchestrator with a restricted API. | Only one small component holds host-level power, and it can say no. | The panel holding the Docker socket: too much power in an internet-facing service. Generated Compose files run by hand: not self-service. A Docker socket proxy: can't restrict what a new container asks for. |
| D4 | An adapter is a code package; simple Steam games are only a manifest. | Depth where it matters, cheap breadth otherwise (G2, G4). | Everything declarative: too shallow for the main games. |
| D5 | Measured, not guessed: each adapter milestone starts by capturing fixtures from the real server. | zomboid-server found real surprises this way (RCON framing, file rewrites, steamcmd first-run errors). | Building from documentation and blog posts. |
| D6 | Minecraft Java only, with the loader picked per server: vanilla, Paper and Fabric (P0), Forge and NeoForge (P1). Mods come from Modrinth. The EULA is accepted explicitly. | The biggest audience. Owners choose their loader. Modrinth has an open API and hosts mods for every one of these loaders. The EULA is a legal requirement. | CurseForge (needs an API key and has its own terms): later. |
| D7 | The same stack as zomboid-server: TypeScript, Fastify, SQLite, React with Mantine, Caddy, Docker Compose. | Reuses tested code and know-how. | — |
| D8 | An assistant is optional, off by default and pluggable. It goes through the same API, permissions, approval and audit as a person. v1 builds only the readiness items (AST-01…04); the assistant and its providers (AST-05/06: Anthropic, OpenAI, Gemini, Grok, local models) come after v1. | Keeps the door open without shipping or depending on AI. Many players dislike AI features, so the panel must work fully without one, and nothing leaves the host unless the owner opts in. | Building an assistant into v1: scope creep and a privacy question for every user. Ignoring it: retrofitting approval flows and machine-readable schemas later costs more. |
| D9 | License: **PolyForm Noncommercial 1.0.0.** Free for personal use and for non-profit organisations; commercial use needs the author's permission. Provided as is, without warranty. The `LICENSE` file is added in M0. | Matches the intent: free for players and communities, not for hosting businesses. PolyForm is a standard, lawyer-drafted license, unlike a home-made one. | MIT, which allows commercial use. CC BY-NC, which Creative Commons itself advises against for software. Note: this is "source-available" rather than OSI "open source". Code carried over from zomboid-server also stays available under MIT in that repository, so this repo keeps a `NOTICE` for it. |
| D10 | OS-agnostic through Docker; adapters declare CPU architectures. | One stack for Linux, Windows and macOS (HST-05). Refusing unsupported combinations beats silently slow emulation. | Native installs per OS: far more work. Emulating x86 on ARM: slow and fragile for game servers. |
| D11 | The panel reaches a server's files only through that server's agent (file and archive endpoints). The panel mounts no game volumes. | Mods and plugins run arbitrary code inside a server; with shared mounts the panel would walk attacker-controlled trees next to every other server's data. Running backups stay consistent because the save-off/save-on steps run next to the data and always re-enable saving. Adding a server never needs the panel recreated, on Docker Desktop or Linux. | A shared volume with sub-paths mounted in the panel (weaker isolation); per-server mounts (panel recreated per server); backups through the orchestrator (widens its narrow API). |
| D12 | Shared installs: one install volume per game, flavour and version, filled by a separate install job (never by a running game) and mounted read-only by every server on that version; a game that writes into its install folder while it runs has those paths redirected into its server's own data, or keeps a per-server install filled by a local copy instead of a download. Updates install beside the running version and servers move at their next start. Measured in M7-0 (`docs/verification/shared-installs.md`): six of the nine games run from a read-only install as they are; Minecraft vanilla and Fabric need their bundler unpacked by the install job; tModLoader's logs and Project Zomboid's Workshop downloads are redirected into the server's data by symlinks the install job creates; TShock loads its plugins from the server's data with `-additionalplugins`. An update starts from a local copy of the install it replaces, so steamcmd downloads only what changed. | Downloads and disk: Project Zomboid is 7 GB per server, Counter-Strike 2 tens of GB; safe updates (a running server keeps its files); a read-only install can't be changed by a game or its mods. | One install per server (downloads and stores every copy); overlay filesystems (need privileges the containers never get, NFR-02); hard links (don't cross volumes). |

## 11. Milestones

Each milestone ends with its checks passing and a commit. No dates: order
matters, the calendar doesn't. M3, M5 and M6 can run in parallel once M2 is
done; M4 follows M3. `docs/traceability.md` maps every requirement ID to its
milestone and the tests that prove it, and is updated with every merge.

| # | Milestone | Covers | Done when |
|---|---|---|---|
| M0 | Bootstrap: private repo seeded from zomboid-server `main`, renamed, gates green, `LICENSE` and `NOTICE` | D2, D9, NFR-07, NFR-09 | `verify.sh` passes; no host or personal data in the repo; the Project Zomboid dev loop works; the license files are in place. |
| M1 | Adapter contract; Project Zomboid as the first adapter, still one server; format registry and the text editor for every config file, with diff preview | G3, G7, NFR-08, D4, CFG-01…10, AST-03, and for Project Zomboid: MOD-01, CON-01/03, PLY-01…03, BAK-01/03…06, UPD-01…04, SCH-01/03, ACC-01, HST-02 | All ported Project Zomboid tests pass through the adapter; the core has no Project Zomboid imports (lint); any Project Zomboid config file is editable in the browser with a preview, while unsafe paths and file types are refused (tests). |
| M2 | Multi-server core: data model, orchestrator, create/list/delete, per-server permissions, server list UI, API-first and actor-typed audit | G1, SRV-01…07, ACC-02/03, HST-01, NFR-02/03, AST-01/02/04, D11, and every M1 item per server | Two Project Zomboid servers run side by side with separate worlds, ports and schedules; cross-server permission tests pass; the orchestrator refuses any spec outside its allowlist; a test finds no UI action missing from the API. |
| M3 | Minecraft Java: fact-finding fixtures; vanilla, Paper and Fabric loaders; install and pinning; run; RCON; settings forms; players; running backups; reset; EULA flow | D5, D6, CFG, PLY, BAK-02, UPD-01…06 | A Minecraft server created from the UI with each of the three loaders; a client joins; build, back up, break, restore, and it's back. |
| M4 | Modrinth mods, then Forge and NeoForge loaders: search, compatibility, dependencies, updates | MOD-02, MOD-04, UPD-07 | Add a mod that has a dependency on Fabric, then on NeoForge; each server boots and a client joins. |
| M5 | Terraria: vanilla, TShock (REST API, plugins) and tModLoader; stdin control; world creation; Workshop mods for tModLoader | MOD-03, MOD-06, CON-02, CON-04, UPD-01…04 | Create a world from the panel for each flavour; join; kick and ban (TShock through REST); install a TShock plugin and a tModLoader mod. |
| M6 | Valheim, plus the declarative Steam manifest | G4, D4, and for Valheim and the manifest game: UPD-01…04, BAK-01…04, PLY-01/03, CFG-01…09, SRV-03, HST-05 | Valheim runs via manifest plus hooks. A second Steam game is added **with a manifest only**, and it boots, stops and backs up. |
| M7 | Shared installs (first, at the owner's request), host overview, job staggering, platform support: architecture checks and the Linux, Windows and macOS guides | HST-03, HST-05/06, HST-07, HST-09, D12, SCH-02, D10 | Two servers of the same game and version share one install, and an update moves each at its next start without a second download; smoke test (create, start, back up, restore) passes on Linux and Windows; the macOS guide exists but is marked untested until someone runs it on a Mac; an ARM host refuses an x86-only game with a clear reason; on Docker Desktop the host page and the address-ban dialogs show the hidden-address limitation, and whether Linux Docker Engine and Docker Engine in WSL (mirrored networking) keep players' addresses is measured and written into `docs/limitations.md`. |
| M8 | v1: docs, security review, EN/ES completeness, phone layout, 48 h soak with three servers, then publish | G5, G6, UX-01…04, NFR-01/04/05/06 | Every [success criterion](#12-success-criteria-v1) met; the repository goes public under D9. |

## 12. Success criteria (v1)

1. Project Zomboid parity: every zomboid-server feature works per server.
2. A new Minecraft, Terraria or Valheim server goes from nothing to joinable
   from the UI alone, without editing files by hand.
3. Three servers (Project Zomboid, Minecraft, Terraria) run 48 hours on one host with:
   - no crash loops;
   - memory within limits;
   - scheduled jobs staggered.
4. Security tests pass for cross-server isolation, the orchestrator allowlist,
   Origin/CSRF checks and 2FA.
5. A simple Steam game is added with a manifest only.
6. The smoke test passes on Linux and Windows (macOS: documented, untested until a Mac is available).

## 13. Risks

| Risk | Mitigation |
|---|---|
| The Docker socket is host-level power. | A tiny orchestrator with an allowlist and refusal tests, never exposed (D3, NFR-02). |
| Several servers compete for one PC's memory and CPU. | Per-server limits, capacity warnings, staggered jobs (SRV-05, SCH-02). |
| Game updates break things (new Minecraft versions, Project Zomboid builds). | Version pinning, update policies, safety backups, fixtures per version. |
| Mod platform APIs change or rate-limit (Modrinth, Steam, GitHub's 60 anonymous calls an hour). | Caching, backoff, degrading gracefully to "can't check right now". |
| Vanilla Terraria crashes on a burst of reconnects. | The crash watchdog restarts it (SRV-07); TShock, which survives them, is suggested for public servers. |
| Scope creep ("add game X"). | Change control, and the manifest path for simple games. |
| Legal. | Explicit Minecraft EULA acceptance; no game files redistributed; captured fixtures limited to test data. |
| Forge and NeoForge installers change often. | Pinned loader versions, fixtures per loader, and loaders shipped at P1 after the P0 ones are solid. |
| Third-party code in plugins and mods (Paper, TShock, tModLoader). | Admin-only installs with a warning and an audit record of each file; plugin links limited to GitHub release assets, downloaded by the server's own agent; the container isolation from NFR-02/03. |
| Docker Desktop hides players' and visitors' addresses (address bans hit everyone; per-address game limits treat all players as one). | Account-based bans first; TShock for public Terraria; the panel detects it and warns (HST-07); `docs/limitations.md` explains it with the fixes (Linux Docker Engine, Docker Engine in WSL) (UX-04). |
| Friends can't join, or the owner can't join their own public address from home. | The connection info names the router forwards per server and shows separate lines for this PC, the home network and the internet, since many routers can't loop a home player back through the public address (`docs/limitations.md`). |
| Hosts that can't run a game (ARM hosts such as Apple Silicon Macs or a Raspberry Pi). | Architecture declared per adapter, and a clear refusal (HST-05). |

## 14. Change control

- This document is the source of truth. Every commit and pull request points
  to the requirement IDs or the milestone it serves.
- Anything not covered here starts as a change to this document, with a
  changelog line, before any code.
- Non-goals stay non-goals until they move into scope that way.
- Deviations found during a milestone, like a game behaving differently than
  written, update this document in the same change that handles them.

## 15. Open questions

None open. New questions go here, with an ID, until they're answered.

| ID | Question | Answer | Lands in |
|---|---|---|---|
| Q9 | Who sees the host overview (CPU, memory, disk of the whole machine)? | The owner and admins with scope `all`, the same people who can create servers (integrator's call during M2.0; the owner can change it). | §5, HST-03 |
| Q10 | Paper turns on bStats (usage statistics sent to bstats.org) by default. Should new Paper servers start with it off? | Yes: off for new servers, and the owner can turn it on (owner, 2026-09-27). | §7, NFR-09 |
| Q11 | Which Minecraft versions are offered? | 1.16.5 and newer, which Temurin 17, 21 and 25 cover; older ones would need Java 8 (owner, 2026-09-27). | UPD-02, §10 |
| Q12 | Minecraft 26.x has a JSON-RPC management server (players, lists, settings, notifications). Use it instead of RCON and log reading? | Not in v1: RCON and logs work on every offered version; revisit after v1 (owner, 2026-09-27). | PLY-01/02, CON-02 |
| Q13 | A new Minecraft version has only ALPHA Paper builds for weeks. Does the version picker offer only versions with a STABLE build? | No: every version is offered, STABLE builds are picked when they exist, and a clear warning shows when only ALPHA or BETA builds do (owner, 2026-09-27). | UPD-02, UPD-05 |
| Q14 | Offer Valheim's crossplay (Xbox and Game Pass players), which registers the host's public address with Microsoft's PlayFab and needs extra image libraries? | Yes, off by default, with a note saying what it shares (owner, 2026-10-01). | §7, §10 |
| Q15 | Let Valheim servers appear in the game's public server list? | Yes, private by default; a listed server needs a password of at least 5 characters that isn't part of its name (owner, 2026-10-01). | §7 |
| Q16 | Share one install among servers of the same game and version instead of downloading each? | Yes, and build it before Counter-Strike 2 (owner, 2026-10-03). | HST-09, D12 |
| Q17 | When does Counter-Strike 2 come? | After v1, as the first new game (owner, 2026-10-03). | §7 |
| Q18 | Counter-Strike 2 plugins (Metamod, CounterStrikeSharp)? | Yes, as a second step after vanilla CS2, re-applied after every update (owner, 2026-10-03). | §7, MOD-06 |

### Answered

| ID | Question | Answer (0.3) | Lands in |
|---|---|---|---|
| Q1 | Product name? | `gameserver-panel`. | Header |
| Q2 | TShock in v1? | Yes: TShock as a Terraria flavour, with its REST API and plugins. | §7, CON-04, MOD-06, M5 |
| Q3 | Forge and NeoForge? | The owner picks the loader per server. Forge and NeoForge are v1 targets after vanilla, Paper and Fabric. | §7, UPD-06…08, D6, M4 |
| Q4 | Discord webhooks? | One webhook, with per-server overrides. | SCH-03 |
| Q5 | Which host OS? | OS-agnostic: Linux, Windows and macOS, on x86-64 and ARM64 where games allow. | HST-05/06, NFR-05, D10, M7 |
| Q6 | License? | Free for personal and non-profit use: PolyForm Noncommercial 1.0.0. | D9, M0 |
| Q7 | Move the live Project Zomboid server? | Not for now; it stays on zomboid-server. The importer drops to P2. | §4, HST-04 |
| Q8 | Assistant providers? | Planned: Anthropic, OpenAI, Gemini, Grok, and local models. Built after v1, with no default provider. | AST-06, D8 |

## 16. Glossary

| Term | Meaning |
|---|---|
| Adapter | The code (and optionally a manifest) that teaches the panel one game. |
| Agent | The small process inside each server container that runs and supervises the game. |
| Orchestrator | The only service allowed to create and remove containers. |
| Manifest | A declarative description of a simple Steam game. |
| Running backup | A backup taken without stopping the server, using the game's own save method. |
| Install | The server files of one game, flavour and version, shared read-only by every server on that version (HST-09). |
| Install job | The short-lived container that downloads an install; no game runs in it. |
| Fixture | Output captured from a real server and used in tests. |
| Flavour / loader | A variant of a game's server, picked per server (e.g. Minecraft vanilla, Paper, Fabric, Forge, NeoForge; Terraria vanilla, TShock, tModLoader). |
| Text editor | The in-browser editor for any config file an adapter declares (CFG-07). |
| Proposal | A pending change shown as a diff that a person approves or rejects (AST-03). |
| Assistant | An optional, pluggable helper that suggests and makes changes through the same API and approvals as a person (AST-05). |

## Changelog

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-09-24 | First draft: multi-server scope; Project Zomboid, Minecraft Java, Terraria, Valheim and Steam manifests for v1; private until v1. |
| 0.2 | 2026-09-24 | Product principles ("easy by default, never a ceiling"); text editor for every config file (CFG-07…10); assistant readiness (G8, AST-01…05, D8), with the assistant itself after v1; milestones M1 and M2 updated. |
| 0.3 | 2026-09-24 | Answers to Q1–Q8: name confirmed; TShock in v1 (CON-04, MOD-06); Minecraft loader per server, with Forge and NeoForge as P1 (UPD-06…08); OS-agnostic hosts (HST-05/06, D10); PolyForm Noncommercial license (D9); live server stays on zomboid-server (HST-04 to P2); assistant providers planned (AST-06). Milestones M0, M3, M4, M5, M7 and M8 updated. |
| 0.4 | 2026-09-24 | Execution review: every P0 requirement now appears in a milestone (M1, M2, M3, M5, M7, M8 "Covers"); `docs/traceability.md` added; D11 (server files only through the agent); NFR-03 spells out socket listeners; M3/M5/M6 may run in parallel after M2; macOS documented but untested (M7, §12). |
| 0.5 | 2026-09-24 | M1 contract landed: §10 names the package layout (`adapter-api`, `adapter-<game>`, `adapters`) and where fixtures and verification notes live per game. |
| 0.6 | 2026-09-24 | M1 closed: the adapter contract carries the server context panel-side adapter code needs, declared launch secrets and secret console arguments; NFR-08 is also enforced by tests (no game names in the core or the web). |
| 0.7 | 2026-09-24 | M2 contract step: server routes under `/api/servers/<id>` and web pages under `/s/<id>`; host vs server permissions and account scope (§5); unknown or ungranted servers answer "not found"; the orchestrator's server spec and the agent's file and archive routes (D11) are fixed; actor-typed audit; Q9 answered. |
| 0.8 | 2026-09-24 | M2 wave: the orchestrator service (only Docker holder, derived hardening, refusal-tested), server files and backups through each server's agent (D11), servers created, renamed and removed through the API with per-server roles, per-server schedules and Discord override (SCH-03 wording), `PANEL_LISTEN` unix socket behind the proxy, generated `docs/api.md`. |
| 0.9 | 2026-09-25 | M2 follow-ups: the orchestrator reports the host ports and memory it allows, new servers get free ports inside those ranges, memory and CPU limit changes apply at once (stopped) or at the next start (running), owner-only forced removal (SRV-04 wording), compose cleaned of the pre-orchestrator server settings. |
| 0.10 | 2026-09-25 | M2 closed: the multi-server web (list, create, delete, per-server roles, server switcher); the acceptance run on real Docker passed with two Project Zomboid servers side by side (`docs/verification/m2-acceptance.md`) and found two bugs, both fixed (a noexec `/tmp` in game containers, an empty world database left by a failed first boot); host-only audit entries (ACC-03), limits visible to a server's admin (SRV-05), the crash watchdog names the last fatal line (SRV-07), game-written keys are locked (CFG-04). |
| 0.11 | 2026-09-25 | M3 contract step: formats for properties, YAML, TOML, JSON5 and line lists (CFG-02/07/09); skeleton adapters for Minecraft, Terraria, Valheim and manifests, registered but not offered until measured (D4, D5); `java` and `native` runtime images; the Steam Workshop source shared by app id (MOD-03); the owner-only EULA flow (D6, §5, §7); the fixture scrubber (NFR-09); the removal's final backup has its own trigger and an unreachable agent needs a forced removal (SRV-04, BAK-01). |
| 0.12 | 2026-09-27 | M3 fact-finding: Minecraft Java 26.3 measured for vanilla, Paper and Fabric (`docs/verification/minecraft-26.3.md`, `fixtures/minecraft/26.3`, `tools/fake-minecraft`); UPD-05 pins Paper's build channel; the `java` image ships Temurin 25, 21 and 17 (§10); ARM64 for Minecraft is confirmed in M7 (§7); Q10–Q13 answered (bStats off by default, 1.16.5 and newer, every Paper version with a warning when not STABLE, the JSON-RPC API after v1). |
| 0.13 | 2026-09-27 | M3 runtime adapter: Minecraft vanilla, Paper and Fabric run on agents (install and pinning, Java per version, RCON one packet per write, running backups); UPD-05 takes Paper builds of the pinned channel or a more stable one; CON-02 refuses commands longer than the channel takes. |
| 0.14 | 2026-09-27 | M3 panel adapter: Minecraft offered in the panel with its loaders and the versions each offers (Paper's channel with the Q13 warning, Fabric's loader), the `server.properties` form, moderation by name or IP, the whitelist switched live, operator and ban lists changed only while stopped, running backups, restores and resets per loader; the contract gains name and IP bans, whitelist reads, launch choices and warnings. |
| 0.15 | 2026-09-29 | M3 fixes from the acceptance run: Minecraft's lists are checked before saving (CFG-02, CFG-08); refused player commands answer errors, not the game's reply (PLY-03); console replies and log lines lose Minecraft's § codes (CON-02); the settings the panel saved survive an operator's whitelist switch in game (CFG-05); the contract gains a file's own check, player-command refusals, a display hook and files re-applied at start. |
| 0.16 | 2026-09-29 | M5 fact-finding: Terraria 1.4.5.8 measured for vanilla, TShock 6.2.1 and tModLoader v2026.07.3.0 (`docs/verification/terraria-1.4.5.8.md`, `fixtures/terraria/1.4.5.8`, `tools/fake-terraria`); tModLoader installs from its GitHub releases and runs in the steam image with .NET 8, TShock in the native image with .NET 9, and a flavour may name its own image (§7, §10); no Terraria license gate (§7); CON-04's token lives in TShock's config; vanilla's IP bans and reconnect crash noted (§7, §13). |
| 0.17 | 2026-09-29 | M2 follow-up (M2-H): a newer runtime image reaches each server at its next start, the way changed limits do (HST-01, SRV-05, SRV-06); the orchestrator only inspects images, reports image ids and takes `keepImage` on PUT (D3). |
| 0.18 | 2026-09-29 | M5 runtime adapter: vanilla Terraria, TShock and tModLoader run on agents (installs checked against pinned or published digests, the world menu avoided, `exit` to stop, TShock's REST moderation as actions); a flavour may name its own image; installs unpack zip and tar; unchecked newer vanilla versions and memory needs noted (§7). |
| 0.19 | 2026-09-29 | M2 follow-up (M2-I): progress runs show as one line (CON-01); the agent's player polls stay out of the live log (PLY-01); a change in how the orchestrator builds containers waits for a running game's next start, except a security fix (SRV-05, SRV-06, NFR-02); the orchestrator takes `keepDerivation` on PUT and reports each container's `derivation` (D3). |
| 0.20 | 2026-09-29 | M5 panel adapter: Terraria offered in the panel for vanilla, TShock and tModLoader (versions with warnings, world size, a secret server password; settings forms with TShock's token hidden whole; moderation per flavour; backups, restores and resets); a Terraria world is named after the server's ID (§7); PLY-03 names the ban targets; CFG-04 hides secrets kept as keys; CFG-09 notes files the game prunes. |
| 0.21 | 2026-09-29 | M5 mods and plugins: tModLoader's Workshop mods through the shared Workshop source, downloaded before each start (MOD-03); TShock plugins by upload or GitHub release link, downloaded by the server's agent, with a restart badge and an audit record (MOD-06); plugin sources in the adapter contract; §7, §13. |
| 0.22 | 2026-10-01 | Owner's request for a public panel: limitations stated plainly. New UX-04 (`docs/limitations.md`, kept current by every change) and HST-07 (the panel detects host limitations such as Docker Desktop's hidden addresses and shows them where they matter); M7 measures whether Linux Docker Engine and Docker Engine in WSL keep players' addresses; a §13 risk row. |
| 0.23 | 2026-10-01 | M6 fact-finding: Valheim 1.0.16 and Avorion 2.5.13 measured (`docs/verification/valheim-1.0.16.md`, `avorion-2.5.13.md`, fixtures, `tools/fake-valheim`, `tools/fake-avorion`); Avorion is the manifest-only Steam game; Valheim has no console, saves on SIGINT/SIGTERM and backs up its newest complete save (§7, BAK-02); Q14 crossplay offered off by default, Q15 public listing offered private by default with the password rules; the manifest format (§10); M6 covers. |
| 0.24 | 2026-10-01 | M6 manifest engine: a manifest (checked against its schema) becomes an adapter of its own id; Avorion added with a manifest only and checked against the real server; ports that follow another, a running copy narrowed by a hook, in-app notes (§7, §10); the default server ports include Avorion's. |
| 0.25 | 2026-10-01 | M6 Valheim: a Steam manifest plus two hooks (a running backup's newest complete save set with the chunk files it uses; Steam's A2S player count on listed servers), offered on x86-64 with the public list and crossplay off by default; checked against the real server (chunk files carry their own versions) (§7, §10, BAK-02). M6's done-when is met. |
| 0.26 | 2026-10-02 | Owner's request: connection info for every server (SRV-08, now P0, done ahead of M7) with copy and share buttons, the game's own join format, the router forwards and the password for admins only; HST-08 the public address (DNS name, by default the DuckDNS name, or IP; optional home-network address; detect on demand). |
| 0.27 | 2026-10-02 | SRV-08 and HST-08 built: a "How to join" card per server with copy and share, the host's public and home addresses with an on-demand detect; each game declares how players join, verified only where a real client joined (Minecraft so far). |
| 0.28 | 2026-10-03 | The owner joined real servers locally: Minecraft (all three loaders), Terraria vanilla and TShock, Project Zomboid; their join facts are verified (SRV-08). M3 and M6 accepted; M5 accepted except a tModLoader client join. Shared installs (HST-09, D12) come first in M7 (Q16); Counter-Strike 2 is the first game after v1, with plugins as a second step (Q17, Q18; §7). |
| 0.29 | 2026-10-03 | M7-0 fact-finding for shared installs (`docs/verification/shared-installs.md`, `fixtures/shared-installs`): every game runs from a read-only install, three with a fix (Minecraft's bundler unpacked by the install job; tModLoader's logs and Project Zomboid's Workshop downloads redirected into the server's data); install jobs, install volumes and the `install` pending reason (D3, D12, HST-09, SRV-05, UPD-01, UPD-03, NFR-02, BAK-01); a beta branch is named to steamcmd explicitly. |
