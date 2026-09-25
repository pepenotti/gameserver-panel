# Security

The panel faces the internet on port 8443. Behind it are the controls for
every game server, their configuration, and backups that hold player
password hashes. Each game server runs mods and plugins, which are other
people's code. This page describes how all of that is kept apart and what to
do when something goes wrong.

## What is exposed

| Where | What | Reachable from |
|---|---|---|
| Each server's game ports (inside `ORCH_HOST_PORTS`, e.g. UDP 16261–16262) | The game | Internet (router forward) |
| TCP 8443 | Caddy → panel | Internet (router forward) |
| `panel.sock` in the `panel-sock` volume | Panel API | Caddy only: the only other container that mounts it |
| `orch.sock` in the `orch-sock` volume (token) | Orchestrator API | The panel only: the only other container that mounts it |
| TCP 8081 on a server's own network (that server's token) | That server's agent | The panel, which the orchestrator joins to each server's network |
| RCON and other game-internal ports | The game's console | Only inside that server's container |

The panel and the orchestrator have no TCP port at all; the orchestrator has
no network at all. Nothing but the game ports and 8443 is published.

## The containers

The stack (`compose.yaml`) runs three services, each with every Linux
capability dropped, `no-new-privileges`, a read-only root filesystem, a
memory cap and log rotation:

- **caddy**: TLS, and the only way in to the panel (it keeps the one
  capability its binary needs to bind a port).
- **panel**: user `node`. It mounts its database volume, its socket volume,
  the orchestrator's socket volume read-only and the backups folder. **No game
  files** (D11).
- **orchestrator**: the only container with the Docker socket (D3, NFR-02).
  Root without any capability, because the socket belongs to root; no network
  (`network_mode: none`), so the socket volume the panel also mounts is the
  only way to reach it, with `ORCH_TOKEN` on every request.

Every **game server** is a container the orchestrator creates from the
panel's spec. The spec says only which game family and variant, the
environment the agent needs, the ports, and the memory and CPU limits; the
orchestrator checks every key and value against its allowlist
(`packages/orchestrator/src/spec.ts`) and refuses anything else: extra keys
(privileged, mounts, capabilities, devices, networks, images, users, labels),
host ports outside `ORCH_HOST_PORTS` or below 1024, the agent's port,
environment keys outside `AGENT_TOKEN`, `GAME_ADAPTER`, `GAME_FLAVOUR`, `TZ`,
`GAME_*` and `GSP_*`, more memory than `ORCH_MAX_MEM_MB`, more servers than
`ORCH_MAX_SERVERS`, and the fake images unless `ORCH_ALLOW_FAKE=1`.
Everything that makes the container safe it derives itself, never from the
panel:

- the image from its allowlist, `gsp/<family>[-fake]:<its own tag>`;
- user `1000:1000`, all capabilities dropped, `no-new-privileges`, never
  privileged, a private IPC namespace, at most 4096 processes;
- a read-only root filesystem, with only `/tmp` writable (a 256 MB tmpfs);
- the memory limit with no extra swap, and the CPU limit when one is set;
- only the server's own named volumes (`<stack>-srv-<id>-data`, `-install`,
  and `-steam` for steamcmd's home): no bind mount, no Docker socket;
- its own bridge network `<stack>-net-<id>`, which only it and the panel join;
- restart `unless-stopped`, a 240 s stop timeout, json-file logs of 10 MB × 3;
- its names and labels (`gsp.stack`, `gsp.server`). The orchestrator only
  ever touches containers, volumes and networks that carry its own stack's
  labels and names; anything else with such a name is refused, not reused.

## Isolation between servers (NFR-03)

- **Networks.** Each server has its own network. Docker keeps bridge networks
  apart, so one server's container can't resolve or reach another's. The
  panel is on every server's network, but it listens only on its unix socket,
  so a game container finds no port open on it. The orchestrator has no
  network. A game container can still reach the internet, and the host's
  published ports like any internet client (other servers' game ports, the
  panel's HTTPS address).
- **A token per server.** The panel generates each server's agent token when
  it creates the server and keeps it in its database (`servers.secrets`),
  never in `.env`. The agent refuses every call without it (except its
  health check), and starts the game without it in its environment. One
  server's token opens that server's agent only.
- **Files only through the agent (D11).** The panel mounts no game volume.
  It lists, reads, writes, backs up and restores a server's files through
  that server's agent, which keeps every path inside the server's roots,
  refuses links, `..`, absolute paths and oversized reads and writes, and
  keeps the install read-only. A running backup is made consistent next to the
  data (Project Zomboid: `save`, then SQLite snapshots). The panel treats what
  an agent sends as untrusted: listings and reads are size-capped, every
  archive entry is checked, and config files are parsed as data.

### What a compromised game container can and can't reach

A mod that escapes its game's sandbox runs as the container's user. It
**can** reach: that server's files (its world, configs and install), that
server's agent (the game runs as the same Unix user, so it can read the
agent's token from the process list and start, stop or reconfigure its own
game), the internet, and the host's published ports. It can fill its own
volumes (named volumes have no size quota) and use the CPU unless the server
has a CPU limit.

It **can't** reach: the panel's API or database (no TCP port, and the socket
is in a volume it doesn't mount), the orchestrator (no network, socket not
mounted), Docker, another server's agent, files or network, the host's files,
or more privileges (no capabilities, `no-new-privileges`, non-root, read-only
root). Panel accounts, other servers' tokens and `.env` stay out of reach.
Only add mods you trust anyway: the world and the player accounts of that
server are in its hands.

## Signing in

- **Passwords** are hashed with scrypt. They must be at least 10 characters,
  not the username and not a common password.
- **Wrong passwords** slow that account down exponentially, up to 5 minutes
  between tries. There's no lockout, because everyone may appear to come from
  one IP. When failures spike across all accounts, a global breaker pauses
  sign-ins for 60 s and sends a Discord alert.
- **2FA** uses an authenticator app (TOTP). It's mandatory for admins and the
  owner, and optional for others. A code can't be used twice. There are 10
  single-use recovery codes, stored hashed.
- **The first owner password** comes from `.env` and must be changed at first
  sign-in.

## Sessions

- A random 256-bit token lives in a `__Host-gspsid` cookie: HttpOnly, Secure,
  SameSite=Strict. The database keeps only its SHA-256.
- A session ends after 7 days unused or 30 days in total. Changing your
  password signs you out everywhere. Everyone can see and end their own
  sessions on **My account**.

## Requests

- **Cross-site protection.** Another site on port 443 of the same hostname
  would share its cookies, since cookies aren't separated by port. So every
  change and every websocket must come from an exact origin in
  `PANEL_ORIGINS` (scheme, host and port). Every change also needs the
  `X-GSP-CSRF` header and a JSON body.
- **Permissions.** Every route and websocket topic checks the role matrix in
  `packages/shared/src/permissions.ts`. The UI only hides what the server
  refuses anyway.
- **Input.**
  - Every route validates its input with a schema.
  - Files are chosen from fixed lists, never from a path in the request.
  - Processes get argument arrays, never shell strings.
  - RCON arguments can't contain quotes, line breaks or control characters.
  - Raw edits to `SandboxVars.lua` and the spawn files must parse as plain
    data. The game executes those files, so code is refused.
- **Headers.** Strict CSP, `frame-ancestors 'none'`, `nosniff` and
  `no-referrer`. **No HSTS**: it applies to every port of a hostname, so it
  would also bind any other site on 443 under the same name.

## Secrets

| Secret | Lives in | Notes |
|---|---|---|
| `ORCH_TOKEN` | `.env`; `panel` and `orchestrator` environment | Panel ↔ orchestrator |
| Each server's agent token | Panel database (`servers.secrets`); that server's container environment | Panel ↔ that server's agent. Generated per server; not passed to the game |
| Each server's game admin password (Project Zomboid) | Panel database (`servers.secrets`); the game's command line | Generated per server, re-applied to the in-game `admin` account on every start. Redacted from logs |
| RCON password | Agent state in the server's data volume; the server ini | Random, generated by the agent. Masked in the panel |
| Discord webhooks | Panel database | The host's and each server's own. Shown masked after saving |
| `DUCKDNS_TOKEN` (optional) | `.env`; `caddy` and `duckdns` environment | Controls the DuckDNS name. If leaked, regenerate it on duckdns.org |
| Panel users | Panel database (`panel-data` volume) | Password hashes, TOTP secrets, session hashes |
| Player accounts | Each server's data volume (Project Zomboid: `db/<server>.db`) | bcrypt hashes, bans, whitelist |

`.env` is never committed. On Linux, `init-env.mjs` writes it readable only by
its owner.

## Backups

- **World backups** go to `BACKUP_DIR/<server>/`, packed by that server's
  agent. A Project Zomboid backup includes `db/<server>.db`, with player
  password hashes, and the ini, with the server password. Downloading is
  admin-only and audited.
  Uploading is owner-only and capped at 20 GB. Every entry in an uploaded
  archive is checked before anything is written: only plain files and
  folders, only under `data/`, no `..`, no absolute paths, no links.
- **Panel database copies** (`BACKUP_DIR/panel/`) hold everything in the
  panel, including TOTP secrets. They're written readable by the owner only
  and can't be downloaded from the panel.
- Keep `BACKUP_DIR` private. If you copy it to the cloud, encrypt it first.

## TLS

The certificate comes from Caddy's own authority (`tls internal`), so browsers
warn until each person accepts it. The certificate is signed straight by
Caddy's 10-year root and lives 180 days. Caddy renews it around day 120, and
then the warning shows again. Chrome forgets accepted warnings after about a
week anyway.

- Share the certificate's SHA-256 fingerprint through a channel friends trust,
  so they can check it before clicking through. The
  [Windows runbook](runbook-windows.md#certificates) has the command.
- **Don't have friends install Caddy's root certificate.** It can sign a
  certificate for any website, and its key sits on the server (the `caddy-data`
  volume). If that key leaked, everyone who trusted it could be spied on.
  Installing it on your own devices is your call.
- `caddy-data` holds that key. Back it up only to places as private as `.env`.

**Removing the warning.** Set `PANEL_TLS=duckdns` with a DuckDNS name (steps in
the [Windows runbook](runbook-windows.md#a-real-certificate-no-warning-with-duckdns)).
Our Caddy image includes the `caddy-dns/duckdns` module. Let's Encrypt checks
a TXT record that Caddy sets through the DuckDNS API (DNS-01), so ports 80/443
can stay with another web server. The DuckDNS token can repoint the name and
get certificates for it, so it lives only in `.env`. Caddy reads it at runtime and never writes it
into its config. The updater never prints it. On a VPS with 80/443 free,
plain Let's Encrypt works without DuckDNS (see the
[Linux runbook](runbook-linux.md#a-real-certificate)).

## Audit log

Sign-ins, failed sign-ins, every change (server control, config, mods, users,
backups, restores, resets, schedules) and every `panelctl` command are logged
with who, when and from which IP. Admins read it on **Activity log**.

On Docker Desktop, every client may show the same IP. `CLIENT_IP_TRUSTWORTHY`
decides whether IP-based features (IP bans) are shown.

## When something goes wrong

| Situation | Do |
|---|---|
| A friend's account may be stolen | **Users** → disable it; then reset its password and 2FA. `panelctl reset-2fa` also signs it out everywhere |
| You lost your 2FA phone | Use a recovery code. No codes left: `docker compose exec panel node /app/panelctl.mjs reset-2fa owner` |
| Forgot the owner password | `docker compose exec panel node /app/panelctl.mjs reset-password owner` |
| `ORCH_TOKEN` may have leaked | Delete its line from `.env`, run `node scripts/init-env.mjs`, then `docker compose up -d`. The panel and the orchestrator restart; the game servers keep running |
| A server's agent token or game admin password may have leaked | The panel can't rotate them yet. Take a backup, remove the server (its container goes with its token), create it again and restore the backup |
| Discord webhook leaked | Delete it in Discord, create a new one, paste it in **Schedules** |
| Sign-in spike alert on Discord | Check **Activity log**. The breaker already slowed the attempts. Make sure every admin has 2FA |
