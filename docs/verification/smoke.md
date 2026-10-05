# Smoke test: create, start, back up, restore (M7)

M7's done-when asks for a smoke test that passes on Linux and Windows: create a server, start it,
back it up, restore it (PRD §11, §12 success criterion 6). `scripts/smoke.mjs` is that test. It
drives a running stack's panel through its HTTPS API as the owner, the same API the web uses
(AST-01), and leaves nothing behind. This file records its runs.

## What it does

| Step | Through the API | Passes when |
|---|---|---|
| sign in | `POST /api/auth/login`; on a fresh stack also `/api/auth/password` and `/api/auth/totp/setup` + `enable` | The session has nothing pending |
| create | `POST /api/servers` (vanilla Terraria, a small world, 1 GiB by default) | 200, with its ports |
| game files | `GET …/install` until its install is ready and its container made, then `GET …/status` until its agent answers | The install is ready (HST-09) |
| start | `POST …/server/start`, then `GET …/ops/current` and `…/status` | The game is `running` |
| back up | `POST …/backups` | A manual backup is listed, with its parts |
| stop | `POST …/server/stop` | The game is `stopped` |
| restore | `POST …/backups/<name>/restore` with every part the backup holds | The restore operation ended well |
| start again | as start | The game is `running` again |
| delete | `DELETE /api/servers/<id>` with its backups and no final backup (stopped first; by force only if the panel refuses otherwise), then `DELETE /api/host/installs/<id>` for each install the run made that nobody uses | Removed; nothing it made is left |

It exits 0 when every step passed, 1 otherwise (the delete step still runs), 2 on bad arguments.
`node scripts/smoke.mjs --help` lists the options (another game, address or id, `--keep`,
`--json`). It never accepts a game's EULA, so Minecraft isn't a choice for it.

**Signing in.** On a fresh stack it signs in with `PANEL_OWNER_USERNAME` and
`PANEL_OWNER_PASSWORD` from the `.env`, sets a new random password and enrols 2FA, as the web asks
an owner to on a first sign-in. The password, the 2FA secret and the session are kept in
`.tmp/smoke-owner.json` (untracked, by panel address, readable by its owner only) and reused by
later runs; the report never shows them. A stack whose owner enrolled 2FA elsewhere can't be
signed in to by the script.

**Its address.** `https://<PANEL_HOST>:<PANEL_PORT>` from the `.env` (or `--url`). A name ending in
`.localhost` is answered as this computer by the script itself (RFC 6761; Windows and plain Linux
resolvers don't). A panel on this computer has Caddy's own certificate, which the script doesn't
check (the connection never leaves the computer); any other address needs `--ca <root.crt>` or
`--insecure`.

## Windows, Docker Desktop — 2026-10-05

**Setup.** Windows 11, Docker Desktop with Engine 29.7.2 (Linux engine, amd64, 12 CPUs, 15.6 GiB
given to Docker). A development slot's stack (`node scripts/worktree-env.mjs --slot 5`: ports on
127.0.0.1 only) built from this branch at `96a1645` with `node scripts/stack.mjs build orchestrator
panel caddy native`, with `SERVER_IMAGE_VARIANT` empty: the real game, downloaded from
terraria.org by the install job. One game server at a time. Command: `node scripts/smoke.mjs`.

**Result: pass.**

```
Smoke test of https://wt5.localhost:30543: terraria vanilla, server smoke-b6c5b5
  ok    sign in           0.0 s  session reused; certificate not checked (this computer)
  ok    create            0.2 s  ports TCP 30550
  ok    game files       14.1 s  version 1.4.5.8, 56 MB, shared install
  ok    start            48.6 s  running, version 1.4.5.8
  ok    back up           2.0 s  terraria-smoke-b6c5b5-20261005T144710Z-manual.tar.zst, 1.1 MB, parts world, settings
  ok    stop              2.0 s  stopped
  ok    restore           2.0 s  terraria-smoke-b6c5b5-20261005T144710Z-manual.tar.zst, every part
  ok    start again       6.1 s  running, version 1.4.5.8
  ok    delete            3.3 s  stopped, removed with its backups, install i329747426e815cca removed
PASS: 9 of 9 steps passed in 1 min 18 s
```

"start" includes generating the small world (the first start); "start again" loads the restored
one. The first of these runs (an earlier one) signed in on the fresh stack itself: `signed in (new
password set, 2FA enrolled)`.

**What the earlier runs found.**
1. *In the panel (reported, not changed here):* a **Start pressed while a new server's game files
   are still being installed can fail** with `start failed: Game server agent unreachable: fetch
   failed`. In the activity log: the server created and Start pressed at 14:41:45.4, the install
   ready at 14:41:52.8, the container created by the panel's own install follow-up (`system`,
   "container created: its install is ready") at 14:41:54.6, and the start failing about a second
   later. The start found the container already made, so it didn't wait for the new container's
   agent to answer, as it does when it makes the container itself. PRD SRV-01 says "a start waits
   for it". The script now waits for the game files and the agent before pressing Start, as a
   person would after the progress bar; the race itself is for the panel to fix.
2. *In the script (fixed):* Node sends a `DELETE`'s body only with its length, and the panel
   refuses to remove a running server (409 `server-running`): the script now gives the length and
   stops the server first. The two servers those runs left were removed through the panel the
   same way.

**Left behind: nothing.** After the run, `docker ps -a`, `docker volume ls` and
`docker network ls` filtered by `gsp.stack=gsp-s5` listed no game server, install or network, and
the slot's backups folder was empty. At the end of the work the slot's stack was removed with
`node scripts/stack.mjs clean` and its images (`gsp/*:s5`) with `docker rmi`. No other stack was
touched.

## Linux, Docker Engine — to be recorded

Run the same way on Linux (Docker Engine inside WSL counts), from a checkout of the branch:

```bash
node scripts/worktree-env.mjs --slot N            # a free slot; or init-env.mjs for a stack of its own
sed -i 's/^SERVER_IMAGE_VARIANT=.*/SERVER_IMAGE_VARIANT=/' .env   # the real game
node scripts/stack.mjs build orchestrator panel caddy native
node scripts/stack.mjs up -d
node scripts/smoke.mjs
node scripts/stack.mjs clean && docker rmi gsp/orchestrator:sN gsp/panel:sN gsp/caddy:sN gsp/native:sN
```

Only Node 24 is needed for the script itself (no `npm ci`). Record the report here, with the
distribution, Docker Engine's version and the commit.
