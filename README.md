# gameserver-panel

A self-hosted web panel to run several game servers side by side on one
machine: Project Zomboid, Minecraft Java, Terraria, Valheim and other Steam
dedicated servers. Real settings forms, safe backups and restores, resets,
players, mods, schedules, Discord alerts, roles with 2FA, in English and
Spanish. Forms for the common settings, and a text editor in the browser
for every config file, so nothing is out of reach.

Status: early development. The code runs one Project Zomboid server (seeded
from zomboid-server); the product requirements are in
[docs/PRD.md](docs/PRD.md), and work follows its milestones.

## Develop

Needs Node 24 or newer and Git; Docker only for the full stack. Each checkout
(worktree) takes a slot from 0 to 9 and owns the 100 ports from
30000 + 100 × slot, so several worktrees can run next to each other, and next
to a live stack on the same machine:

```sh
npm ci
node scripts/worktree-env.mjs --slot 1   # .env and .env.dev for slot 1 (ports 30100-30199)
node scripts/dev.mjs                     # agent + fake game server + panel + Vite; prints the URL
bash scripts/verify.sh                   # every gate (--offline skips npm audit)
```

- `dev.mjs` needs no Docker: the agent drives a fake Project Zomboid server.
  Slot 1 serves http://wt1.localhost:30105; the first login is `owner` /
  `dev-owner-password`, and you are asked to change it.
- Docker only through `node scripts/stack.mjs <compose args>`, for example
  `config`, `up -d --build`, `logs -f panel`, `down` or `clean`. It refuses
  anything that could touch another stack. Never run `docker compose`
  directly from a worktree, and never prune.
- `git config core.hooksPath .githooks` turns on the commit-msg hook
  (PRD IDs and the privacy check). See [CONTRIBUTING.md](CONTRIBUTING.md).

To host a real server, see [docs/runbook-linux.md](docs/runbook-linux.md) or
[docs/runbook-windows.md](docs/runbook-windows.md).

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free for personal use and for
non-profit organisations; commercial use needs the authors' permission.
Provided as is, without warranty. Parts come from zomboid-server and remain
available there under the MIT License; see [NOTICE](NOTICE).
