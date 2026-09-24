# Runbook: Linux host or VPS

The same Compose stack runs unchanged on Linux. What differs is covered here:
Docker install, the firewall, the backups folder, and moving an existing world
over from Windows.

## Sizing

- **RAM:** Java heap (8 GB default) + about 3 GB for the JVM and container +
  1 GB for the panel and OS. 12–16 GB covers a group of friends with a
  moderate mod list.
- **CPU:** PZ leans on one or two fast cores more than on many slow ones.
- **Disk:** about 10 GB for the game, plus the world (grows with exploration),
  plus backups. A world backup is compressed, but budget 1–3 GB each.

## Install

1. Install Docker Engine and the Compose plugin from Docker's repository
   (docs.docker.com → Engine → your distro).
2. Clone the repo and create `.env`:
   ```bash
   git clone <repo> zomboid-server && cd zomboid-server
   node scripts/init-env.mjs     # or copy .env.example and fill the three secrets by hand
   ```
3. Edit `.env`:

   | Key | On Linux |
   |---|---|
   | `PANEL_HOST` | The server's DNS name |
   | `LAN_IP` | The server's own IP (public IP on a VPS) |
   | `BACKUP_DIR` | `./backups`, or a mounted disk |
   | `CLIENT_IP_TRUSTWORTHY` | `true`: Docker on Linux passes the real client IPs |
   | `PZ_MEM_LIMIT` | Java memory + 3 GB |

4. Create the backups folder owned by uid 1000, the user the panel runs as.
   If Docker creates it, it's owned by root and backups fail:
   ```bash
   mkdir -p backups && sudo chown 1000:1000 backups
   ```
5. Start it:
   ```bash
   docker compose up -d --build
   ```
   Then follow "Configure and start" from the
   [Windows runbook](runbook-windows.md#2-configure-and-start), step by step
   from opening the panel.

## Firewall

Open **UDP 16261–16262** and **TCP 8443**. Nothing else is needed. RCON and
the agent API aren't published.

Docker publishes ports through its own iptables rules, **before ufw sees
them**. So `ufw deny` does not close a published port. To close one, remove
it from `compose.yaml`. On a VPS, the provider's firewall (security group)
is the reliable place for rules.

## A real certificate

With a public IP and ports 80/443 free on the Linux box, Caddy can get a Let's
Encrypt certificate by itself. In `docker/caddy/Caddyfile`, delete the `tls { … }`
block, and publish `80:80` and `443:443` for Caddy in `compose.yaml`. Set
`PANEL_PORT=443`. Browsers then stop warning. See [security](security.md#tls)
for the options when 80/443 aren't free.

## Moving the world from Windows

1. On Windows, in the panel: **Backups → Back up now** with the server
   stopped, so the copy is a quiet one. Download it. Also copy the newest
   `BACKUP_DIR/panel/panel-*.sqlite`.
2. On Linux, before the first start, put the panel database in place. This
   keeps accounts, 2FA, settings, schedules and config history:
   ```bash
   docker compose create
   docker run --rm -v zomboid_panel-data:/dst -v "$PWD":/src:ro alpine sh -c \
     "cp /src/panel-<time>.sqlite /dst/panel.db && chown 1000:1000 /dst/panel.db"
   docker compose up -d
   ```
3. Sign in, press **Start** once so the game installs, then stop it.
4. **Backups → Upload** the archive (owner only), then **Restore** with every
   part ticked.
5. Update the router and DNS (or `PANEL_HOST`) to point at the new machine.

If you skip step 2, you start with a fresh owner account from `.env`. The
world, player accounts and game config still come back with the restore.

## Operating

Same as on Windows ([day to day](runbook-windows.md#4-day-to-day),
[when something goes wrong](runbook-windows.md#5-when-something-goes-wrong)),
with Linux paths. The Compose `restart: unless-stopped` policy and the
agent's saved desired state bring the game back after a reboot. No sign-in
is needed on Linux.
