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
| UPD-01 | P0 | M1, M3, M5 | — |
| UPD-02 | P0 | M1, M3, M5 | — |
| UPD-03 | P0 | M1, M3, M5 | — |
| UPD-04 | P0 | M1, M3, M5 | — |
| UPD-05 | P0 | M3 | — |
| UPD-06 | P0 | M3 | — |
| UPD-07 | P1 | M4 | — |
| UPD-08 | P2 | after v1 | — |
| CFG-01 | P0 | M1 | — |
| CFG-02 | P0 | M1 | — |
| CFG-03 | P0 | M1 | — |
| CFG-04 | P0 | M1 | — |
| CFG-05 | P0 | M1 | — |
| CFG-06 | P1 | M1 | — |
| CFG-07 | P0 | M1 | — |
| CFG-08 | P0 | M1 | — |
| CFG-09 | P0 | M1 | — |
| CFG-10 | P1 | M1 | — |
| CON-01 | P0 | M1 | — |
| CON-02 | P0 | M5 | — |
| CON-03 | P1 | M1 | — |
| CON-04 | P0 | M5 | — |
| PLY-01 | P0 | M1 | — |
| PLY-02 | P1 | M1 | — |
| PLY-03 | P0 | M1 | — |
| MOD-01 | P0 | M1 | — |
| MOD-02 | P0 | M4 | — |
| MOD-03 | P1 | M5 | — |
| MOD-04 | P1 | M4 | — |
| MOD-05 | P2 | after v1 | — |
| MOD-06 | P1 | M5 | — |
| BAK-01 | P0 | M1 | — |
| BAK-02 | P0 | M3 | — |
| BAK-03 | P0 | M1 | — |
| BAK-04 | P0 | M1 | — |
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
| AST-03 | P1 | M1 | — |
| AST-04 | P1 | M2 | — |
| AST-05 | P2 | after v1 | — |
| AST-06 | P2 | after v1 | — |
| NFR-01 | NFR | M8 | — |
| NFR-02 | NFR | M2 | — |
| NFR-03 | NFR | M2 | — |
| NFR-04 | NFR | M8 | — |
| NFR-05 | NFR | M8 | — |
| NFR-06 | NFR | M8 | — |
| NFR-07 | NFR | M0 | `scripts/verify.sh` gates; `scripts/lib/*.test.ts`, `scripts/dev.test.ts`; per-slot isolation (`worktree-env.mjs`, `stack.mjs`) |
| NFR-08 | NFR | M1 | `no-restricted-imports` rule in `eslint.config.js` (lint step of `verify.sh`); done when `LEGACY_GAME_IMPORTERS` is empty |
| NFR-09 | NFR | M0 | `scripts/check-private.mjs` and the `privacy` step in `verify.sh`; `scripts/lib/privacy.test.ts`; `.githooks/commit-msg` |
