# Traceability

Every requirement in [PRD.md](PRD.md), the milestones that deliver it, and the
tests (or other evidence) that prove it. Updated with every merge; a P0 row
without a milestone is a PRD bug.

| ID | Priority | Milestones | Proven by |
|---|---|---|---|
| SRV-01 | P0 | M2 | — |
| SRV-02 | P0 | M2 | — |
| SRV-03 | P0 | M2 | — |
| SRV-04 | P0 | M2 | — |
| SRV-05 | P0 | M2 | — |
| SRV-06 | P0 | M2 | — |
| SRV-07 | P0 | M2 | — |
| SRV-08 | P1 | M7 | — |
| SRV-09 | P2 | after v1 | — |
| UPD-01 | P0 | M1, M3, M5 | `agent.test.ts` install progress and "install before start"; `agent/test/http.test.ts` "installs and lists versions" |
| UPD-02 | P0 | M1, M3, M5 | `agent.test.ts` branch change and latest builds per branch; `adapter-pz` runtime install tests |
| UPD-03 | P0 | M1, M3, M5 | `agent.test.ts` "updates on start when asked"; `panel/test/server.test.ts`, `panel/test/schedules.test.ts`; `adapter-pz/test/panel-core.test.ts` (update check) |
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
| CFG-06 | P1 | M1 | `config.test.ts` "applies a game preset"; config suite presets |
| CFG-07 | P0 | M1 | `panel/test/files.test.ts` "text editor API"; `registry.test.ts` formatFor |
| CFG-08 | P0 | M1 | `panel/test/files.test.ts` (LocalServerFiles, editor policy, editor API refusals) |
| CFG-09 | P0 | M1 | `registry.test.ts` comment preservation; `config.test.ts` comments kept |
| CFG-10 | P1 | M1 | manual UI check (Advanced section, search); `web/src/pages/config/OptionsForm.tsx` |
| CON-01 | P0 | M1 | `agent.test.ts` "never leaks the admin or RCON password"; `agent/test/http.test.ts` event stream |
| CON-02 | P0 | M5 | — |
| CON-03 | P1 | M1 | `panel/test/server.test.ts` (broadcast); `adapter-pz/test/panel-core.test.ts` (messages) |
| CON-04 | P0 | M5 | — |
| PLY-01 | P0 | M1 | `agent.test.ts` (join/leave); `adapter-pz/test/runtime.test.ts` (players); live runtime suite "lists who is online" |
| PLY-02 | P1 | M1 | — |
| PLY-03 | P0 | M1 | `panel/test/players.test.ts`; `adapter-pz/test/panel-core.test.ts` (players); panel core suite (moderation arguments) |
| MOD-01 | P0 | M1 | `panel/test/mods.test.ts`; `adapter-pz/test/panel-core.test.ts` (Steam Workshop source) |
| MOD-02 | P0 | M4 | — |
| MOD-03 | P1 | M5 | — |
| MOD-04 | P1 | M4 | — |
| MOD-05 | P2 | after v1 | — |
| MOD-06 | P1 | M5 | — |
| BAK-01 | P0 | M1 | `panel/test/backups.test.ts`; `panel/test/core-adapter.test.ts` (symlinks skipped); `panel/test/server.test.ts` (pre-update backup) |
| BAK-02 | P0 | M3 | — |
| BAK-03 | P0 | M1 | — |
| BAK-04 | P0 | M1 | `panel/test/reset.test.ts`; `adapter-pz/test/panel-core.test.ts` (backup parts, resets) |
| BAK-05 | P1 | M1 | — |
| BAK-06 | P1 | M1 | — |
| SCH-01 | P0 | M1 | — |
| SCH-02 | P1 | M7 | — |
| SCH-03 | P0 | M1 | — |
| ACC-01 | P0 | M1 | — |
| ACC-02 | P0 | M2 | — |
| ACC-03 | P0 | M2 | — |
| HST-01 | P0 | M2 | — |
| HST-02 | P0 | M1 | — |
| HST-03 | P1 | M7 | — |
| HST-04 | P2 | after v1 | — |
| HST-05 | P0 | M7 | — |
| HST-06 | P0 | M7 | — |
| UX-01 | P0 | M8 | — |
| UX-02 | P0 | M8 | — |
| UX-03 | P1 | M8 | — |
| AST-01 | P0 | M2 | — |
| AST-02 | P0 | M2 | — |
| AST-03 | P1 | M1 | `panel/test/proposals.test.ts` |
| AST-04 | P1 | M2 | `panel/test/core-adapter.test.ts` (`GET /api/meta`) — first step; M2 completes it |
| AST-05 | P2 | after v1 | — |
| AST-06 | P2 | after v1 | — |
| NFR-01 | NFR | M8 | — |
| NFR-02 | NFR | M2 | — |
| NFR-03 | NFR | M2 | — |
| NFR-04 | NFR | M8 | — |
| NFR-05 | NFR | M8 | — |
| NFR-06 | NFR | M8 | — |
| NFR-07 | NFR | M0 | `scripts/verify.sh` gates; `scripts/lib/*.test.ts`, `scripts/dev.test.ts`; per-slot isolation (`worktree-env.mjs`, `stack.mjs`); runtime, panel-core and panel-config contract suites (`adapter-api/src/testing/*`) run against the PZ adapter |
| NFR-08 | NFR | M1 | `no-restricted-imports` rule in `eslint.config.js` (lint step of `verify.sh`); done when `LEGACY_GAME_IMPORTERS` is empty |
| NFR-09 | NFR | M0 | `scripts/check-private.mjs` and the `privacy` step in `verify.sh`; `scripts/lib/privacy.test.ts`; `.githooks/commit-msg` |
