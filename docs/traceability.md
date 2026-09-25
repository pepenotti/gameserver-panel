# Traceability

Every requirement in [PRD.md](PRD.md), the milestones that deliver it, and the
tests (or other evidence) that prove it. Updated with every merge; a P0 row
without a milestone is a PRD bug.

| ID | Priority | Milestones | Proven by |
|---|---|---|---|
| SRV-01 | P0 | M2 | `panel/test/registry.test.ts` "creating a server" (spec, secrets, ports, every refusal, rollback); `panel/test/servers.test.ts` create API; ports inside the orchestrator's ranges: `registry.test.ts` (slot ranges, other ranges, clashes inside the container), `orchestrator/test/http.test.ts` (host reports ports and memory), `servers.test.ts` (adapters host); web create form: `web/test/servers.test.ts`, `web/src/pages/CreateServer.tsx` (ports inside `hostPorts`, memory capped at `maxMemMb`, refusals on their field) |
| SRV-02 | P0 | M2 | `panel/test/servers.test.ts` "the server list" (state, players, version, next restart, role, ports); web: `web/test/servers.test.ts`, `web/src/pages/Servers.tsx` (live via the websocket `servers`/`gone` messages) |
| SRV-03 | P0 | M2 | `panel/test/server.test.ts` (start, stop, restart, kill, countdown warnings and cancel), per server under `/api/servers/:sid`; `panel/test/cross-server.test.ts` (only that server's users) |
| SRV-04 | P0 | M2 | `panel/test/registry.test.ts` "removing a server" (typed name, stopped, final backup, container + volumes, rows purged, audit kept); `panel/test/servers.test.ts` delete API; forced removal: `registry.test.ts` (busy, running, unreachable agent), `servers.test.ts` (owner-only force); web: delete dialog with typed name and the owner's force (`web/src/components/ServerAdmin.tsx`) |
| SRV-05 | P0 | M2 | `orchestrator/test/docker-backend.test.ts` (memory and CPU limits, `ORCH_MAX_MEM_MB`); capacity warning in M7; `registry.test.ts` "changing memory and CPU limits (SRV-05)" and create-time memory refusal; `servers.test.ts` limits through the API; web: container-limits card and "applies at next start" badge (`web/src/pages/Server.tsx`) |
| SRV-06 | P0 | M2 | `panel/test/registry.test.ts` "reconcile" (re-apply, recreate, start, retry); orchestrator derives restart `unless-stopped` (`docker-backend.test.ts`); real restart check in M2-E; `registry.test.ts` reconcile keeps a running game's container while a change waits |
| SRV-07 | P0 | M2 | `panel/test/schedules.test.ts` per-server block (a crash alert names its server); `panel/test/cross-server.test.ts` (alerts reach only that server's users) |
| SRV-08 | P1 | M7 | — |
| SRV-09 | P2 | after v1 | — |
| UPD-01 | P0 | M1, M3, M5 | `agent.test.ts` install progress and "install before start"; `agent/test/http.test.ts` "installs and lists versions" |
| UPD-02 | P0 | M1, M3, M5 | `agent.test.ts` branch change and latest builds per branch; `adapter-pz` runtime install tests |
| UPD-03 | P0 | M1, M3, M5 | `agent.test.ts` "updates on start when asked"; `panel/test/server.test.ts`, `panel/test/schedules.test.ts`; `adapter-pz/test/panel-core.test.ts` (update check); `panel/test/agent-e2e.test.ts` (update check through `ServerCtx.versions()`) |
| UPD-04 | P0 | M1, M3, M5 | `panel/test/server.test.ts` (safety backup before update) |
| UPD-05 | P0 | M3 | — |
| UPD-06 | P0 | M3 | — |
| UPD-07 | P1 | M4 | — |
| UPD-08 | P2 | after v1 | — |
| CFG-01 | P0 | M1 | `panel/test/config.test.ts` (validation, masking); `adapter-pz/test/panel-config-contract.test.ts` |
| CFG-02 | P0 | M1 | `formats/test/registry.test.ts`, `formats/test/lua-data.test.ts`; `config.test.ts` "rejects raw Lua"; config suite data-only check |
| CFG-03 | P0 | M1 | `config.test.ts` "history (CFG-03)" |
| CFG-04 | P0 | M1 | `config.test.ts` "puts managed keys back"; config suite managed values |
| CFG-05 | P0 | M1 | `config.test.ts` "applies live"; `panel-config-contract.test.ts` afterWrite |
| CFG-06 | P1 | M1 | `config.test.ts` "applies a game preset"; config suite presets; `panel/test/reset.test.ts` preset test |
| CFG-07 | P0 | M1 | `panel/test/files.test.ts` "text editor API"; `registry.test.ts` formatFor |
| CFG-08 | P0 | M1 | `panel/test/files.test.ts` (LocalServerFiles, editor policy, editor API refusals); `panel/test/server-files.test.ts` (both ServerFiles implementations), `agent/test/files.test.ts`, `archive/test/rooted.test.ts` |
| CFG-09 | P0 | M1 | `registry.test.ts` comment preservation; `config.test.ts` comments kept |
| CFG-10 | P1 | M1 | manual UI check (Advanced section, search); `web/src/pages/config/OptionsForm.tsx` |
| CON-01 | P0 | M1 | `agent.test.ts` "never leaks the admin or RCON password"; `agent/test/http.test.ts` event stream; `panel/test/agent-e2e.test.ts` (no secret in any log line) |
| CON-02 | P0 | M5 | — |
| CON-03 | P1 | M1 | `panel/test/server.test.ts` (broadcast); `adapter-pz/test/panel-core.test.ts` (messages) |
| CON-04 | P0 | M5 | — |
| PLY-01 | P0 | M1 | `agent.test.ts` (join/leave); `adapter-pz/test/runtime.test.ts` (players); live runtime suite "lists who is online" |
| PLY-02 | P1 | M1 | `panel/test/players.test.ts` "records joins and leaves", "emits join/leave events" |
| PLY-03 | P0 | M1 | `panel/test/players.test.ts`; `adapter-pz/test/panel-core.test.ts` (players); panel core suite (moderation arguments) |
| MOD-01 | P0 | M1 | `panel/test/mods.test.ts`; `adapter-pz/test/panel-core.test.ts` (Steam Workshop source) |
| MOD-02 | P0 | M4 | — |
| MOD-03 | P1 | M5 | — |
| MOD-04 | P1 | M4 | — |
| MOD-05 | P2 | after v1 | — |
| MOD-06 | P1 | M5 | — |
| BAK-01 | P0 | M1 | `panel/test/backups.test.ts`; `panel/test/core-adapter.test.ts` (symlinks skipped); `panel/test/server.test.ts` (pre-update backup); `panel/test/agent-e2e.test.ts` (hot backup through the agent); `archive/test/tar.test.ts` |
| BAK-02 | P0 | M3 | PZ: `archive/test/rooted.test.ts` (hot packs), `agent/test/files.test.ts`, `panel/test/server-files.test.ts` "hot packs through the agent"; a hot backup saves once (`schedules.test.ts`, `backups.test.ts`) |
| BAK-03 | P0 | M1 | `panel/test/backups.test.ts` restoring block (parts + undo, running server, damaged archive, staging-only writes); `panel/test/server-files.test.ts` (restore round trip, hostile archives); `agent-e2e.test.ts` (restore + undo) |
| BAK-04 | P0 | M1 | `panel/test/reset.test.ts`; `adapter-pz/test/panel-core.test.ts` (backup parts, resets) |
| BAK-05 | P1 | M1 | `panel/test/backups.test.ts` "lets admins download and the owner upload; not operators"; `backups.test.ts` "restores another server's backup under this server's names" |
| BAK-06 | P1 | M1 | `panel/test/schedules.test.ts` "copies the panel database nightly" |
| SCH-01 | P0 | M1 | `panel/test/schedules.test.ts` schedules block (daily restart, periodic cold/hot backups, update policy, skip when stopped); `panel/test/wiring.test.ts`; `schedules.test.ts` "keeps each server's schedules and timers apart", "runs a scheduled job on its own server only" |
| SCH-02 | P1 | M7 | — |
| SCH-03 | P0 | M1 | `panel/test/schedules.test.ts` "Discord notifications" block (per-server override: M2); `schedules.test.ts` per-server webhook override, server named in every message; web: panel webhook in `web/src/pages/HostSettings.tsx`, per-server override on Schedules |
| ACC-01 | P0 | M1 | `panel/test/auth.test.ts`, `panel/test/users.test.ts`, `panel/test/cli.test.ts` (panelctl) |
| ACC-02 | P0 | M2 | `shared/test/permissions.test.ts`; `panel/test/cross-server.test.ts` (generated from the route table, both directions, websocket); `panel/test/servers.test.ts` grants/scope API; `panel/test/api-first.test.ts`; web: account scope and per-server roles (`web/src/pages/Users.tsx`) |
| ACC-03 | P0 | M2 | `panel/test/servers.test.ts` (audit by server); `panel/test/migrations.test.ts` (backfill); web: activity log filtered by server, actor badges (`web/src/pages/Audit.tsx`) |
| HST-01 | P0 | M2 | `orchestrator/test/*` (spec, Docker backend, HTTP); `scripts/lib/stack-guard.test.ts`; compose rendered by `stack.mjs config`; real stack in M2-E; `scripts/lib/worktree.test.ts` (fresh `.env` has no pre-orchestrator settings); checklist `docs/verification/m2-acceptance.md` |
| HST-02 | P0 | M1 | `panel/test/env.test.ts` (PANEL_HOST default Caddy accepts); `caddy validate` of `docker/caddy/Caddyfile` in both TLS modes (see `docs/verification/pz-b42.md`); real stack run in M2-E |
| HST-03 | P1 | M7 | — |
| HST-04 | P2 | after v1 | — |
| HST-05 | P0 | M7 | `panel/test/registry.test.ts` "refuses a game the host cannot run natively"; `GET /api/adapters` `supported` |
| HST-06 | P0 | M7 | — |
| UX-01 | P0 | M8 | `web/test/i18n.test.ts`; `web/test/game-neutral.test.ts` alert-title check |
| UX-02 | P0 | M8 | M2 pages checked at 375×812 during M2-D (server list, menu, create, users, audit, delete, schedules, config) |
| UX-03 | P1 | M8 | — |
| AST-01 | P0 | M2 | `panel/test/api-first.test.ts` (every web call has a route; each route declares permission/public/session); `panel/test/api-docs.test.ts` + generated `docs/api.md` |
| AST-02 | P0 | M2 | `panel/test/servers.test.ts` (user/schedule/recovery/system actors); `panel/test/registry.test.ts` |
| AST-03 | P1 | M1 | `panel/test/proposals.test.ts` |
| AST-04 | P1 | M2 | `panel/test/core-adapter.test.ts` (`GET /api/servers/:sid/meta`) — first step; M2 completes it; `web/test/game-neutral.test.ts` capability mirror; pages driven by `/api/meta`; `web/test/config-layout.test.ts` (labels, groups, launch hints and reset options from the contract) |
| AST-05 | P2 | after v1 | — |
| AST-06 | P2 | after v1 | — |
| NFR-01 | NFR | M8 | — |
| NFR-02 | NFR | M2 | `orchestrator/test/spec.test.ts` (every refusal), `orchestrator/test/docker-backend.test.ts` (derived hardening field by field, other stacks untouched), `orchestrator/test/http.test.ts` (token on every route); real `docker inspect` in M2-E; real check: `docs/verification/m2-acceptance.md` steps 5–6 |
| NFR-03 | NFR | M2 | `orchestrator/test/docker-backend.test.ts` (own network per server, only named volumes); `panel/test/listen.test.ts` (unix socket, 0666, X-Forwarded-For from the proxy only); files through the agent: `agent/test/files.test.ts`, `panel/test/server-files.test.ts`; reachability checked for real in M2-E; real check: `docs/verification/m2-acceptance.md` steps 5–6 |
| NFR-04 | NFR | M8 | — |
| NFR-05 | NFR | M8 | — |
| NFR-06 | NFR | M8 | — |
| NFR-07 | NFR | M0 | `scripts/verify.sh` gates; `scripts/lib/*.test.ts`, `scripts/dev.test.ts`; per-slot isolation (`worktree-env.mjs`, `stack.mjs`); runtime, panel-core and panel-config contract suites (`adapter-api/src/testing/*`) run against the PZ adapter |
| NFR-08 | NFR | M1 | `no-restricted-imports` rule in `eslint.config.js` (lint step of `verify.sh`); done when `LEGACY_GAME_IMPORTERS` is empty; `scripts/core-agnostic.test.ts` (no adapter imports outside `agent/src/main.ts` and `panel/src/wiring.ts`, no game tokens in core `src/**`); `web/test/game-neutral.test.ts`; `web/test/game-neutral.test.ts` also refuses the removed M1 fallback strings |
| NFR-09 | NFR | M0 | `scripts/check-private.mjs` and the `privacy` step in `verify.sh`; `scripts/lib/privacy.test.ts`; `.githooks/commit-msg` |
