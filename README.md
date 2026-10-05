# gameserver-panel

A self-hosted web panel to run several game servers side by side on one
machine: Project Zomboid, Minecraft Java, Terraria, Valheim and other Steam
dedicated servers. Real settings forms, safe backups and restores, resets,
players, mods, schedules, Discord alerts, roles with 2FA, in English and
Spanish. Forms for the common settings, and a text editor in the browser
for every config file, so nothing is out of reach.

Status: early development. The panel runs several servers, each in its own
container; Project Zomboid is the first game (seeded from zomboid-server).
The product requirements are in [docs/PRD.md](docs/PRD.md), and work follows
its milestones.

## How it fits together

```
 browser ── HTTPS ──▶ caddy ──(socket)──▶ panel ──(socket, token)──▶ orchestrator ──▶ Docker
                                            │                              │ creates
                                            │ each server's own network,   ▼
                                            └── its own token ──────▶ one container per server:
                                                                      agent + game
 players ── game ports ──────────────────────────────────────────────▶ server containers
```

- **Panel** (`packages/panel`, UI in `packages/web`): accounts, roles,
  settings, backups, schedules, the API. It listens only on a unix socket that
  Caddy reaches, has no Docker access and mounts no game files.
- **Orchestrator** (`packages/orchestrator`): the only part with Docker access.
  It creates, starts, stops and removes the servers' containers, volumes and
  networks from a narrow spec, derives everything that makes them safe itself,
  and refuses the rest. It has no network; the panel reaches it over a socket
  with a token.
- **One container per server**, from a runtime image per game family
  (`docker/steam`). Inside, the **agent** (`packages/agent`) runs the game,
  its console and installer, and is the only thing that touches the server's
  files: the panel reads, backs up and restores them through it.

[docs/security.md](docs/security.md) explains what each part can reach.

## Develop

Needs Node 24 or newer and Git; Docker only for the full stack. Each checkout
(worktree) takes a slot from 0 to 9 and owns the 100 ports from
30000 + 100 × slot, so several worktrees can run next to each other, and next
to a live stack on the same machine:

```sh
npm ci
node scripts/worktree-env.mjs --slot 1   # .env and .env.dev for slot 1 (ports 30100-30199)
node scripts/dev.mjs                     # panel + Vite + fake orchestrator + agent; prints the URL
bash scripts/verify.sh                   # every gate (--offline skips npm audit)
```

- `dev.mjs` needs no Docker. It runs the panel, Vite, and a **fake
  orchestrator**: the real orchestrator API and checks, where each server is a
  local agent driving a fake game instead of a container. Servers you create
  (in the UI, or `POST /api/servers`) get ports inside the slot's game ports
  (slot 1: 30150-30199). It also runs the agent of the older `default` server
  with a fake Project Zomboid.
- Slot 1 serves http://wt1.localhost:30105; the first login is `owner` /
  `dev-owner-password`, and you are asked to change it.
- `git config core.hooksPath .githooks` turns on the commit-msg hook
  (PRD IDs and the privacy check). See [CONTRIBUTING.md](CONTRIBUTING.md).

### The full stack, in a worktree

Docker only through `node scripts/stack.mjs <compose args>`: it refuses
anything that could touch another stack. Never run `docker compose` directly
from a worktree, and never prune.

```sh
node scripts/stack.mjs config                    # render it (read-only)
node scripts/stack.mjs build steam steam-fake    # the servers' runtime images (build-only services)
node scripts/stack.mjs up -d --build             # panel, orchestrator, Caddy
node scripts/stack.mjs logs -f panel orchestrator
node scripts/stack.mjs down                      # also removes the stack's server containers and networks
node scripts/stack.mjs clean                     # …and every volume of the stack and its servers
```

A slot's stack serves `https://wt<slot>.localhost:30<slot>43` and runs the
fake game images unless `.env` says otherwise (`SERVER_IMAGE_VARIANT`).
[docs/verification/m2-acceptance.md](docs/verification/m2-acceptance.md) walks
through a run with real servers, and `node scripts/smoke.mjs` checks a running
stack end to end ([docs/verification/smoke.md](docs/verification/smoke.md)).

To host real servers, follow the setup and operations guide for your
computer: [Linux](docs/runbook-linux.md), [Windows](docs/runbook-windows.md)
or [macOS](docs/runbook-macos.md) (untested so far). What each platform and
game can't do is in [docs/limitations.md](docs/limitations.md).

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free for personal use and for
non-profit organisations; commercial use needs the authors' permission.
Provided as is, without warranty. Parts come from zomboid-server and remain
available there under the MIT License; see [NOTICE](NOTICE).
