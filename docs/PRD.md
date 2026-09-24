# Game Server Panel — Product Requirements

| | |
|---|---|
| Status | Draft 0.2 |
| Date | 2026-09-24 |
| Name | `gameserver-panel` (working name, see [open questions](#15-open-questions)) |
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
- Minecraft Bedrock; Minecraft Forge and NeoForge; CurseForge.
- Valheim mods (BepInEx / Thunderstore) and TShock plugins for Terraria.
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
  servers", act everywhere.
- 2FA is mandatory for admins and the owner.
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
| Minecraft Java | vanilla, Paper, Fabric | official downloads, version pinned | RCON + stdin | `server.properties`, whitelist / ops / bans | Modrinth (Paper plugins, Fabric mods) | TCP 25565 |
| Terraria | vanilla, tModLoader | official download / steamcmd | stdin only | `serverconfig.txt`, world options | tModLoader via Steam Workshop | TCP 7777 |
| Valheim | — | steamcmd | none: signals + log parsing | launch options, admin / banned / permitted lists | — (v1) | UDP 2456–2457 |
| Other Steam games | — | steamcmd | per manifest | raw files | — | per manifest |

- **Minecraft EULA:** Minecraft needs the owner to accept Mojang's EULA. The
  panel asks explicitly and never accepts it on the owner's behalf.
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
| SRV-04 | P0 | Delete a server after typing its name. A final backup is taken first; backups are kept unless the owner chooses otherwise. |
| SRV-05 | P0 | Memory and CPU limits per server. A host view warns when the limits add up to more than the host has. |
| SRV-06 | P0 | Each server returns to its previous state after a Docker or host restart. |
| SRV-07 | P0 | Per-server crash watchdog that halts after repeated crashes, as in zomboid-server. |
| SRV-08 | P1 | Connection info per server (address, port, protocol, whether a password is set), plus the router forwards it needs. |
| SRV-09 | P2 | Clone a server: settings only, or settings plus world. |

### 8.2 Install and updates — UPD

| ID | P | Requirement |
|---|---|---|
| UPD-01 | P0 | Install from the adapter's source, with progress shown in the UI. |
| UPD-02 | P0 | Choose and pin a version: Steam branch, Minecraft version, loader version. |
| UPD-03 | P0 | Update checks with a per-server policy: apply when nobody is playing, apply after a countdown, or only notify. |
| UPD-04 | P0 | Every update takes a safety backup first. |
| UPD-05 | P0 | Minecraft never moves to a new game version on its own, since that breaks mods and worlds. It only takes builds of the pinned version, unless an admin chooses a new version. |

### 8.3 Settings — CFG

| ID | P | Requirement |
|---|---|---|
| CFG-01 | P0 | Settings forms from each adapter's schema: types, ranges, choices, EN/ES descriptions, search. |
| CFG-02 | P0 | Raw editor per file, validated by format. Files the game executes (Lua) must parse as plain data. |
| CFG-03 | P0 | History per file, with diff and one-click revert. |
| CFG-04 | P0 | Settings the panel manages itself (ports, RCON, paths) are locked. |
| CFG-05 | P0 | Each setting says when it applies (live, or after a restart), and the UI shows a pending-restart badge. |
| CFG-06 | P1 | Presets per game (e.g. Project Zomboid sandbox presets, Minecraft difficulty and game mode). |
| CFG-07 | P0 | **Text editor for every config file.** Admins can browse the configuration folders each adapter declares (game settings, plugin and mod configs) and edit any text file there in the browser. It has syntax highlighting for the format (properties, ini, YAML, TOML, JSON/JSON5, Lua, plain text), validation where a parser exists, a diff preview before saving, and history with revert (CFG-03). |
| CFG-08 | P0 | **Editor safety.** Only paths inside the adapter's declared folders; no symlinks out; text files only, with a size cap. Files the game runs as code (e.g. Project Zomboid's `SandboxVars.lua`) must parse as plain data (CFG-02); scripts and binaries (`.jar`, `.dll`, `.sh`, mod code) are never editable. Panel-managed keys (CFG-04) are re-applied on save, with a note explaining why. |
| CFG-09 | P0 | Forms and text stay in sync (principle 3): editing either updates the other; unknown keys are kept, and so are comments where the format allows. |
| CFG-10 | P1 | "Advanced" section and search in every settings form, so rare settings are reachable without cluttering the common ones (principle 1). |

### 8.4 Console and logs — CON

| ID | P | Requirement |
|---|---|---|
| CON-01 | P0 | Live log per server for operators and up, with secrets redacted and a filter. |
| CON-02 | P0 | Raw console (RCON or stdin) for admins, with command arguments sanitised. |
| CON-03 | P1 | Broadcast a message to players where the game supports it. |

### 8.5 Players — PLY

| ID | P | Requirement |
|---|---|---|
| PLY-01 | P0 | Online players, wherever the game exposes them (RCON, stdin or logs). |
| PLY-02 | P1 | Join and leave history. |
| PLY-03 | P0 | Kick, ban and unban, whitelist, and operator/admin levels, mapped to what each game supports. |

### 8.6 Mods — MOD

| ID | P | Requirement |
|---|---|---|
| MOD-01 | P0 | Project Zomboid Steam Workshop mods, at parity with zomboid-server. |
| MOD-02 | P0 | Minecraft through Modrinth: search, add by link or ID, filter by loader and game version, resolve dependencies, check for updates. |
| MOD-03 | P1 | tModLoader mods through the Steam Workshop, reusing the Project Zomboid code. |
| MOD-04 | P1 | Mod update checks with the same policies as game updates (UPD-03). |
| MOD-05 | P2 | Thunderstore (Valheim), CurseForge, TShock plugins. |

### 8.7 Backups, restore, reset — BAK

| ID | P | Requirement |
|---|---|---|
| BAK-01 | P0 | Per-server backups (manual, scheduled, and before updates, restores and resets), each with a manifest, a checksum and retention per server. |
| BAK-02 | P0 | Consistent backups while running, using each game's own method. Project Zomboid: `save`, then SQLite snapshots. Minecraft: `save-off`, `save-all flush`, then `save-on` after the copy. Otherwise save, then copy, or a stopped-server backup. |
| BAK-03 | P0 | Restore with a choice of parts, a staging folder, atomic swap and undo. |
| BAK-04 | P0 | Reset scopes from each adapter (world only; world and players; factory). A backup is always taken first. |
| BAK-05 | P1 | Download (admins) and upload (owner) of backups. Every uploaded archive entry is validated. |
| BAK-06 | P1 | Nightly copy of the panel's own database. |

### 8.8 Schedules and notifications — SCH

| ID | P | Requirement |
|---|---|---|
| SCH-01 | P0 | Per-server schedules: restarts with a quiet backup, backups, update checks. |
| SCH-02 | P1 | Stagger jobs so servers don't restart or back up at the same moment. |
| SCH-03 | P0 | Discord webhooks with per-event switches in EN/ES, and a per-server override. |

### 8.9 Accounts, permissions, audit — ACC

| ID | P | Requirement |
|---|---|---|
| ACC-01 | P0 | Accounts, 2FA, sessions and the host recovery tool, as in zomboid-server. |
| ACC-02 | P0 | Global roles plus per-server grants, enforced on every route and websocket topic. Tests prove nobody reaches a server they have no grant for. |
| ACC-03 | P0 | Audit log with the server on every entry, filterable by server. |

### 8.10 Host and access — HST

| ID | P | Requirement |
|---|---|---|
| HST-01 | P0 | One Docker Compose stack for the panel, the orchestrator and the TLS proxy. Game servers are containers the orchestrator creates. |
| HST-02 | P0 | HTTPS with a self-signed certificate, or Let's Encrypt through DuckDNS, as in zomboid-server. |
| HST-03 | P1 | Host overview: CPU, memory and disk per server and in total. |
| HST-04 | P1 | Import an existing zomboid-server deployment: world, settings, mods, backups and panel users. |

### 8.11 Language and usability — UX

| ID | P | Requirement |
|---|---|---|
| UX-01 | P0 | EN/ES for all of the UI, game setting labels, Discord messages and in-game warnings. |
| UX-02 | P0 | Every page usable on a phone. |
| UX-03 | P1 | First-run wizard that walks the owner through the first server. |

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
| AST-05 | P2 | **Optional assistant.** Off by default; only the owner can turn it on. The model provider is pluggable (hosted, or a local model). It acts only as the signed-in user, and every change goes through AST-03 and is audited. Secrets and redacted log lines never leave the host. It is clearly labelled in the UI, and a server can run entirely without it. |

## 9. Non-functional requirements

| ID | Area | Requirement |
|---|---|---|
| NFR-01 | Security | At least zomboid-server's controls, listed below. |
| NFR-02 | Security | The **orchestrator** is the only component with Docker access, and its API is narrow (see D3). Every server container gets `cap_drop: ALL`, `no-new-privileges`, a non-root user and a memory limit. It is never privileged, never on the host network, and has no host mounts beyond its own volumes. Images come from an allowlist. |
| NFR-03 | Isolation | Each server gets its own internal network. A game container can't reach the panel, the orchestrator or another server. |
| NFR-04 | Reliability | Graceful stop with a time budget per game; state survives restarts; watchdogs per server. |
| NFR-05 | Portability | Linux hosts, and Windows with Docker Desktop or Docker Engine inside WSL. |
| NFR-06 | Footprint | Panel under 512 MB of RAM; agent overhead under 64 MB per server; the UI stays responsive with 10 servers. |
| NFR-07 | Testability | Each adapter has fixtures captured from a real server and a fake server for integration tests, and passes the shared adapter contract suite. `scripts/verify.sh` gates every commit. |
| NFR-08 | Maintainability | Adapters live in their own packages. The core never imports game-specific code, and a lint rule enforces it. |
| NFR-09 | Privacy | No telemetry. Secrets live only in `.env` and the database. The repository names no real host, person, IP or hostname. No server data leaves the host unless the owner turns on an optional integration that needs it (Discord, a future assistant), and even then secrets are masked. |

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
  - `steam` (steamcmd and its libraries): Project Zomboid, Valheim, tModLoader and manifest games.
  - `java` (a JRE matched to the Minecraft version): Minecraft.
  - `native`: vanilla Terraria.

  Each adapter names its image.
- **Orchestrator.** A small service that holds the Docker socket. It creates,
  starts, stops and removes server containers, volumes and networks from a
  fixed, validated spec, and does nothing else. It is reachable only by the
  panel and authenticates with a token.
- **Adapter contract** (`packages/adapter-api`): capabilities, install, launch,
  control, readiness, players, settings schema, backups (paths and the
  running-server method), reset scopes, mod sources, EN/ES strings.
- **Declarative adapters.** Simple Steam games are one manifest: app ID, launch
  command, ports, readiness pattern, stop method, config files (raw editing)
  and backup paths.
- **Data.** SQLite, with the server ID on every per-server table. Volumes are
  named by server ID, and backups go to `BACKUP_DIR/<server>/`.
- **Config files.** Each adapter declares its editable folders and each
  file's format. A format registry (parse, validate, serialise, highlight)
  serves both the forms and the text editor, so they can't drift apart
  (CFG-07…09).
- **Assistant readiness.** The API is the only way to act (AST-01). Changes
  can be proposals awaiting approval (AST-03). Adapters describe themselves in
  machine-readable form (AST-04). A future assistant plugs in as one more API
  client, not as a special path.

### Decisions

| ID | Decision | Why | Alternatives considered |
|---|---|---|---|
| D1 | Multi-server panel on a single host. | The chosen scope. One machine keeps it simple for friend groups. | One game per install: smaller, but doesn't meet G1. |
| D2 | A new repository seeded from zomboid-server's public `main`. zomboid-server is frozen except for fixes. | The live server stays safe while this project restructures freely. | Evolving zomboid-server in place: risky for a working server. |
| D3 | One container per server, created by an orchestrator with a restricted API. | Only one small component holds host-level power, and it can say no. | The panel holding the Docker socket: too much power in an internet-facing service. Generated Compose files run by hand: not self-service. A Docker socket proxy: can't restrict what a new container asks for. |
| D4 | An adapter is a code package; simple Steam games are only a manifest. | Depth where it matters, cheap breadth otherwise (G2, G4). | Everything declarative: too shallow for the main games. |
| D5 | Measured, not guessed: each adapter milestone starts by capturing fixtures from the real server. | zomboid-server found real surprises this way (RCON framing, file rewrites, steamcmd first-run errors). | Building from documentation and blog posts. |
| D6 | Minecraft Java only: vanilla, Paper and Fabric, with mods from Modrinth. The EULA is accepted explicitly. | The biggest audience; Modrinth has an open API; the EULA is a legal requirement. | Forge, NeoForge, CurseForge (needs an API key and has terms): later. |
| D7 | The same stack as zomboid-server: TypeScript, Fastify, SQLite, React with Mantine, Caddy, Docker Compose. | Reuses tested code and know-how. | — |
| D8 | An assistant is optional, off by default and pluggable. It goes through the same API, permissions, approval and audit as a person. v1 builds only the readiness items (AST-01…04). | Keeps the door open without shipping or depending on AI. Many players dislike AI features, so the panel must work fully without one, and nothing leaves the host unless the owner opts in. | Building an assistant into v1: scope creep and a privacy question for every user. Ignoring it: retrofitting approval flows and machine-readable schemas later costs more. |

## 11. Milestones

Each milestone ends with its checks passing and a commit. No dates: order
matters, the calendar doesn't.

| # | Milestone | Covers | Done when |
|---|---|---|---|
| M0 | Bootstrap: private repo seeded from zomboid-server `main`, renamed, gates green | D2, NFR-07, NFR-09 | `verify.sh` passes; no host or personal data in the repo; the Project Zomboid dev loop works. |
| M1 | Adapter contract; Project Zomboid as the first adapter, still one server; format registry and the text editor for every config file, with diff preview | G3, G7, NFR-08, D4, CFG-07…10, AST-03 | All ported Project Zomboid tests pass through the adapter; the core has no Project Zomboid imports (lint); any Project Zomboid config file is editable in the browser with a preview, while unsafe paths and file types are refused (tests). |
| M2 | Multi-server core: data model, orchestrator, create/list/delete, per-server permissions, server list UI, API-first and actor-typed audit | G1, SRV-01…07, ACC-02/03, HST-01, NFR-02/03, AST-01/02/04 | Two Project Zomboid servers run side by side with separate worlds, ports and schedules; cross-server permission tests pass; the orchestrator refuses any spec outside its allowlist; a test finds no UI action missing from the API. |
| M3 | Minecraft Java: fact-finding fixtures, install and pinning, run, RCON, settings forms, players, running backups, reset, EULA flow | D5, D6, CFG, PLY, BAK-02, UPD-05 | A Minecraft server created from the UI; a client joins; build, back up, break, restore, and it's back. |
| M4 | Modrinth mods for Paper and Fabric: search, compatibility, dependencies, updates | MOD-02, MOD-04 | Add a mod that has a dependency; the server boots; a client joins. |
| M5 | Terraria: vanilla and tModLoader, stdin control, world creation, Workshop mods for tModLoader | MOD-03, CON-02 | Create a world from the panel; join; kick and ban from the console; install a tModLoader mod. |
| M6 | Valheim, plus the declarative Steam manifest | G4, D4 | Valheim runs via manifest plus hooks. A second Steam game is added **with a manifest only**, and it boots, stops and backs up. |
| M7 | zomboid-server import, host overview, job staggering | HST-03/04, SCH-02 | A copy of a live zomboid-server deployment imports with world, mods and users intact. |
| M8 | v1: docs, security review, EN/ES completeness, phone layout, 48 h soak with three servers, then publish | G5, G6, UX-01/02 | Every [success criterion](#12-success-criteria-v1) met; the repository goes public. |

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

## 13. Risks

| Risk | Mitigation |
|---|---|
| The Docker socket is host-level power. | A tiny orchestrator with an allowlist and refusal tests, never exposed (D3, NFR-02). |
| Several servers compete for one PC's memory and CPU. | Per-server limits, capacity warnings, staggered jobs (SRV-05, SCH-02). |
| Game updates break things (new Minecraft versions, Project Zomboid builds). | Version pinning, update policies, safety backups, fixtures per version. |
| Mod platform APIs change or rate-limit (Modrinth, Steam). | Caching, backoff, degrading gracefully to "can't check right now". |
| Scope creep ("add game X"). | Change control, and the manifest path for simple games. |
| Legal. | Explicit Minecraft EULA acceptance; no game files redistributed; captured fixtures limited to test data. |

## 14. Change control

- This document is the source of truth. Every commit and pull request points
  to the requirement IDs or the milestone it serves.
- Anything not covered here starts as a change to this document, with a
  changelog line, before any code.
- Non-goals stay non-goals until they move into scope that way.
- Deviations found during a milestone, like a game behaving differently than
  written, update this document in the same change that handles them.

## 15. Open questions

| ID | Question |
|---|---|
| Q1 | Product name (`gameserver-panel` is a working name). |
| Q2 | Terraria: add TShock (plugins, REST API) in v1, or keep it as a P2? |
| Q3 | Minecraft: Forge and NeoForge after v1? |
| Q4 | Discord: one webhook with per-server overrides (current plan), or one webhook per server only? |
| Q5 | Host: this Windows PC only, or also document a Linux VPS path for v1? |
| Q6 | License when the repository goes public (zomboid-server uses MIT). |
| Q7 | Does the live Project Zomboid server move to this panel at v1, or stay on zomboid-server? |
| Q8 | Assistant (AST-05, after v1): which providers first, and should a local model be the default? |

## 16. Glossary

| Term | Meaning |
|---|---|
| Adapter | The code (and optionally a manifest) that teaches the panel one game. |
| Agent | The small process inside each server container that runs and supervises the game. |
| Orchestrator | The only service allowed to create and remove containers. |
| Manifest | A declarative description of a simple Steam game. |
| Running backup | A backup taken without stopping the server, using the game's own save method. |
| Fixture | Output captured from a real server and used in tests. |
| Text editor | The in-browser editor for any config file an adapter declares (CFG-07). |
| Proposal | A pending change shown as a diff that a person approves or rejects (AST-03). |
| Assistant | An optional, pluggable helper that suggests and makes changes through the same API and approvals as a person (AST-05). |

## Changelog

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-09-24 | First draft: multi-server scope; Project Zomboid, Minecraft Java, Terraria, Valheim and Steam manifests for v1; private until v1. |
| 0.2 | 2026-09-24 | Product principles ("easy by default, never a ceiling"); text editor for every config file (CFG-07…10); assistant readiness (G8, AST-01…05, D8), with the assistant itself after v1; milestones M1 and M2 updated. |
