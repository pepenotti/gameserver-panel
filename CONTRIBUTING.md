# Contributing

Issues and pull requests are welcome. These are the conventions the code
follows; `bash scripts/verify.sh` must pass before a change is merged.

## Commits
One coherent, green unit of work per commit. Subject in the imperative; the
body says *why*.

## Green means every gate
`scripts/verify.sh` runs lint, typecheck, tests, `npm audit` (runtime deps)
and a CRLF check. Run it before every commit; `--offline` skips the audit.

## Version on every change (SemVer)
`VERSION` is the single source of truth. Bump in the same commit as the change:
`node scripts/bump-version.mjs patch|minor|major`. While the major is 0, a
breaking change bumps the minor and everything else bumps the patch.

## Architecture guard rails
- `packages/pz-formats` is pure: no I/O, no Node APIs beyond Buffer. Everything
  that reads PZ output (ini, sandbox Lua, VDF, mod.info, RCON frames, log lines)
  lives there and is tested against `fixtures/b42/` — real captured output, not
  guesses.
- The **agent** (`packages/agent`, runs in the `pz` container) is the only thing
  that spawns the game, speaks RCON or runs steamcmd. It knows nothing about users.
- The **panel** never spawns the game or opens RCON; it goes through the agent
  client. Every route declares a permission from `packages/shared/src/permissions.ts`.
- Never edit the game install dir (`/opt/pz`): steamcmd `validate` overwrites it.
  JVM flags go on the command line.
- `SandboxVars.lua` / `spawnregions.lua` are executed by the game. Only the
  data-only serializer in `pz-formats` may write them.
- `spawn` with argument arrays only; never a shell string.

## Line endings
`.gitattributes` forces LF. Files under `docker/` run in Linux containers and
break with CRLF.

## Node
Containers run Node 24. Develop on Node 24 or newer, but keep code compatible
with 24 (`node:sqlite`, `fetch`, no newer-only APIs).
