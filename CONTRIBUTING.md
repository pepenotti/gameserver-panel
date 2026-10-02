# Contributing

These are the conventions the code follows; `bash scripts/verify.sh` must
pass before a change is merged. [docs/PRD.md](docs/PRD.md) is the plan: work
that can't be traced to a requirement ID or a milestone there doesn't get
built until the PRD says so (its change control, §14).

## Commits
One coherent, green unit of work per commit. Subject in the imperative; the
body says *why* and names the PRD requirement IDs or the milestone the commit
serves (`M1`, `CFG-07`, `NFR-09`, `D11`, …). The commit-msg hook in
`.githooks/` rejects messages without one, and runs the privacy check on the
message (enable it once per clone with `git config core.hooksPath .githooks`).

Merge and revert commits need one too, so give them a message instead of
git's default:

```sh
git merge --no-ff -m "Merge m0/bootstrap (M0, D2, D9)" m0/bootstrap
git revert --edit <sha>        # and name the IDs in the message
```

## Limitations
Found something the panel can't do, or does differently on some host or for some
game? Add it to `docs/limitations.md` in the same change (UX-04): what people
will notice, why, the workaround, and whether you measured it (where) or only
expect it. Users read that page before opening a server to the public.

## Green means every gate
`scripts/verify.sh` runs lint, typecheck, tests, `npm audit` (runtime deps),
the privacy check and a CRLF check. Run it before every commit; `--offline`
skips the audit.

On Windows some tests skip: they need real POSIX signals, Unix sockets, file
modes or symlinks. `node scripts/verify-linux.mjs` runs the same gates in a
throwaway Linux container (`node:24-trixie`, as the unprivileged `node`
user), copying the working tree, staged or not. Run it before every merge
into `main` and whenever you touch process control, sockets, archives or
file safety; the gates there must be green too.

## Version (SemVer)
`VERSION` is the single source of truth, and it changes only in the
integrator's merge commits on `main`: a patch bump for every merged branch, a
minor bump when a milestone completes. Branches never bump it. While the
major is 0, a breaking change is a minor bump too. The images copy it next to
their bundles: the panel, the orchestrator and every agent report it.

```sh
git merge --no-ff --no-commit <branch>
node scripts/bump-version.mjs patch --allow-dirty   # or minor
git add VERSION && git commit -m "Merge <branch> (<IDs>)"
```

## Parallel work: worktrees, slots and Docker
Several branches are worked on at once, each in its own git worktree, on one
machine that may also run a live stack.

- **One slot per worktree.** `node scripts/worktree-env.mjs --slot N` (N = 0-9)
  writes `.env` and `.env.dev`; everything the worktree runs listens on
  127.0.0.1 inside ports 30000 + 100·N … +99, under the Compose project
  `gsp-sN` and image tag `sN`. `scripts/lib/ports.mjs` has the layout.
- **Docker only through `node scripts/stack.mjs`.** It refuses to run unless
  the project is this worktree's `gsp-sN`, not listed as protected in
  `<git common dir>/info/protected-projects`, TLS is `internal`, no Compose
  profiles are on, every port is published on 127.0.0.1 inside the slot's
  block, and no other project already publishes one of those ports.
  `clean` removes this stack's containers and volumes; `down -v` needs
  `--yes-this-stack`.
- **Never** run `docker compose` directly, `docker system|volume|image prune`,
  restart Docker Desktop or shut down WSL: other stacks on the machine depend
  on them.
- **File ownership.** During a parallel wave every branch owns the files and
  packages its task names; touching another branch's files needs the
  integrator's go-ahead first.
- **Frozen contracts.** While a wave runs, the shared contracts it builds on
  (types in `packages/shared`, the agent API, the database schema, the
  adapter contract once it exists) are frozen. A needed change goes to the
  integrator, lands on `main` on its own, and the branches rebase onto it.
- Timeouts in tests scale with `TEST_TIME_SCALE`, and `VITEST_MAX_WORKERS`
  caps the test workers (both set in a slot's `.env`). Never add retries to
  make a flaky test pass; fix the cause.

## Privacy (NFR-09)
Tracked files, fixtures and commit messages never name a real person, host,
IP, DDNS name, local path or other project. Use placeholders:
`yourname.ddns.net`, `my-zomboid.duckdns.org`, `192.168.1.50`, the test user
`alice`. Real values live in `.env` only.

`node scripts/check-private.mjs` (part of `verify.sh`) scans every tracked
file for home paths and personal e-mail addresses, and for every regex in the
local, untracked `<git common dir>/info/private-patterns` (one
case-insensitive regex per line). `--range main..HEAD` checks a branch's
commit messages and added lines; the commit-msg hook checks each message.
Hits show the file, line and pattern number, never the text.

## Packages
| Package | What it is |
|---|---|
| `shared` | Types and rules both sides use: permissions, the agent API, the orchestrator API (`orchestrator-api.ts`) |
| `formats` | The file and wire formats games share (pure) |
| `archive` | tar, zstd, and `RootedFiles`: a server's files on disk, rooted and link-free |
| `adapter-api` | The adapter contract and its shared test suites |
| `adapter-<game>` | One game (`adapter-pz`; `adapter-minecraft`, `adapter-terraria`, `adapter-valheim` and `adapter-manifest` are skeletons until measured); `adapters` is the one list of them, each enabled or not |
| `source-<name>` | A mod source several games share (`source-workshop`: the Steam Workshop, by app id) |
| `agent` | Runs inside each server's container: the game, its console, installer and files |
| `orchestrator` | The only component with Docker access |
| `panel` | The API: accounts, servers, settings, backups, schedules |
| `web` | The UI (React) |

`tools/` holds the fakes the dev loop and tests use: the fake orchestrator
(`tools/fake-orchestrator`), a recording Docker API (`tools/fake-docker`) and
fake games (`tools/fake-pz`).

## Architecture guard rails
- `packages/formats` is pure: no I/O, no Node APIs beyond Buffer. The file and
  wire formats games share (ini, Lua data, VDF, RCON frames, steamcmd output)
  live there; a game's own formats (PZ's mod.info and log lines) live in its
  adapter package. Both are tested against captured output in `fixtures/<game>/`
  (`fixtures/pz/b42/`) — real captured output, not guesses.
- The core (`shared`, `formats`, `archive`, `adapter-api`, `agent`,
  `orchestrator`, `panel`, `web`) never imports a game adapter (NFR-08): it
  works through the contract in `packages/adapter-api`, and only the agent's
  entry point and the panel's wiring (`packages/panel/src/wiring.ts`) pick
  adapters, from `@gsp/adapters`. ESLint enforces it, and
  `scripts/core-agnostic.test.ts` also refuses a game's app ids, file names and
  console commands in the core.
- The **orchestrator** (`packages/orchestrator`) is the only component with
  Docker access (D3, NFR-02). It takes a narrow spec from the panel, derives
  the image, user, capabilities, mounts, networks and names itself, and
  refuses anything else. Nothing else gets the Docker socket, and it gets no
  network. A change to what it accepts is a change to
  `packages/shared/src/orchestrator-api.ts`, a frozen contract.
- The **agent** (`packages/agent`, one per server, inside that server's
  container) is the only thing that spawns the game, speaks RCON or runs
  steamcmd, and the only thing that touches a server's files (D11): the panel
  reads, writes, backs up and restores them through the agent's file and
  archive routes, never through a mount. It knows nothing about users.
- The **panel** never spawns the game, opens RCON or reads a server's files; it
  goes through that server's agent client, with that server's own token. Every
  route declares a permission from `packages/shared/src/permissions.ts`.
- Never edit a game's install dir (`/opt/game` in a server's container):
  steamcmd `validate` overwrites it. JVM flags go on the command line.
- `SandboxVars.lua` / `spawnregions.lua` are executed by the game. Only the
  data-only serializer in `packages/formats` may write them.
- `spawn` with argument arrays only; never a shell string.

## Line endings
`.gitattributes` forces LF. Files under `docker/` run in Linux containers and
break with CRLF.

## Node
Containers run Node 24. Develop on Node 24 or newer, but keep code compatible
with 24 (`node:sqlite`, `fetch`, no newer-only APIs).
