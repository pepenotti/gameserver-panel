# Runbook: Windows host

How to run the stack on a Windows PC: install, open it to friends, and keep it
running. Commands are for PowerShell in the repo folder unless noted.

> **If Docker Desktop won't start:** on Windows 11 build 26200 it can crash at
> startup on undeletable socket files (see `verification-log.md`, M3). Option B
> below, Docker Engine inside WSL, avoids Docker Desktop entirely. Everything
> after "Install Docker" is the same for both options.

## 1. Install Docker

**Option A: Docker Desktop** (on any PC where it works)
1. Install Docker Desktop with the WSL 2 backend.
2. Settings → General → turn on **Start Docker Desktop when you sign in**.

**Option B: Docker Engine inside WSL** (no Docker Desktop)
1. `wsl --install -d Ubuntu`, then in Ubuntu make sure `/etc/wsl.conf` has
   `[boot]` `systemd=true`.
2. Install Docker Engine from Docker's apt repository (docs.docker.com →
   Engine → Ubuntu).
3. In `%USERPROFILE%\.wslconfig`, set `[wsl2]` `networkingMode=mirrored`. This
   makes ports opened in WSL listen on the Windows LAN IP. Mirrored mode also
   needs an inbound rule in the Hyper-V firewall for UDP 16261–16262 and TCP
   8443. That is a security setting, so you apply it yourself.
4. WSL stops a distro when nothing uses it. Add a Task Scheduler task at sign-in
   that runs `wsl.exe -d Ubuntu --exec sleep infinity` to keep it up. Check
   after a day or two that it stays running.
5. Clone the repo inside WSL (`~/zomboid-server`), not under `/mnt/c`. Set
   `BACKUP_DIR=/mnt/d/zomboid-backups` in `.env`.

**Both options: memory.** The game, any other containers and WSL share one VM. Create
`%USERPROFILE%\.wslconfig` with:

```ini
[wsl2]
memory=20GB
swap=8GB
[experimental]
autoMemoryReclaim=gradual
```

Then run `wsl --shutdown` once. This stops every WSL distro and Docker, so do it
when nothing is running.

## 2. Configure and start

```bash
node scripts/init-env.mjs
```

It creates `.env` with random secrets. Open `.env` and check:

| Key | Set it to |
|---|---|
| `PANEL_HOST` | The name people type, e.g. a No-IP name like `yourname.ddns.net` |
| `LAN_IP` | This PC's LAN address, e.g. `192.168.1.50` |
| `PANEL_PORT` | `8443`, which leaves 80/443 to any other web server on this PC |
| `BACKUP_DIR` | A folder on a disk with room, e.g. `D:/zomboid-backups` |
| `PZ_MEM_LIMIT` | About 3 GB more than the Java memory you'll set in the panel |
| `TZ` | Your time zone. Schedules and log times use it |

```bash
docker compose up -d --build
```

Then:
1. Open `https://localhost:8443` and accept the warning (see
   [certificates](#certificates)).
2. Sign in as `owner` with `PANEL_OWNER_PASSWORD` from `.env`.
3. Set a new password, then scan the 2FA QR code with an authenticator app.
   Keep the recovery codes somewhere safe, off this PC.
4. Press **Start** on the dashboard. The first start downloads the game (a few
   GB) and takes a few minutes. Watch it on **Console**.
5. In **Configuration**, set the server's public name, password and welcome
   message. In **Schedules**, check the time zone and the daily restart.

`PANEL_OWNER_PASSWORD` in `.env` is only used on the very first boot. After
that, change passwords in the panel.

## 3. Open it to friends

On the router:
- Forward **UDP 16261–16262** (game) and **TCP 8443** (panel) to `LAN_IP`.
- Add a DHCP reservation so this PC keeps `LAN_IP`.
- Leave any existing 80/443 forwards as they are.

Friends join the game at your `PANEL_HOST` name, port `16261`. The panel is
at `https://<PANEL_HOST>:8443`. Test both from a phone on mobile data, not
Wi-Fi: many routers can't loop back to their own public IP.

If nothing else keeps your No-IP name up to date, run the No-IP updater. Create
a DDNS Key in No-IP (Dynamic DNS → DDNS Keys) and put it in `.env`
(`NOIP_USERNAME`, `NOIP_PASSWORD`). Then:

```bash
docker compose --profile public up -d
```

Keep the PC awake: in Settings → System → Power, set sleep to **Never** while
plugged in, and set Windows Update **active hours** around when people play.
The server only runs while this PC is on and someone is signed in.

## 4. Day to day

| To… | Do |
|---|---|
| Start, stop, restart, update the game | The panel's dashboard and **Game server** page |
| See why something failed | Panel **Console**, or `docker compose logs -f pz` / `panel` |
| Update the panel | `git pull`, then `docker compose up -d --build panel`. The game keeps running |
| Update the agent (`pz` image) | `docker compose up -d --build pz`. The world is saved first, and the game starts again by itself; players are dropped for a few minutes |
| Stop everything | `docker compose stop`. It waits up to 4 minutes for the world to save |
| Run the agent without the panel | `docker compose exec pz node /app/agentctl.mjs status` (also `start`, `stop`, `cmd "players"`, `logs`) |

Backups land in `BACKUP_DIR`:
- `pz-<server>-<time>-<trigger>.tar.zst` are world backups, each with a `.json`
  sidecar holding its checksum and contents. They're listed in the panel.
- `panel/panel-<time>.sqlite` are nightly copies of the panel's own database
  (users, 2FA, settings, history). The last 7 are kept.

Copy `BACKUP_DIR` to another disk or cloud storage now and then. A backup on
the same PC doesn't survive that PC dying.

## 5. When something goes wrong

**Locked out of the panel** (lost the 2FA phone and the recovery codes, or
forgot the password). From this PC:

```bash
docker compose exec panel node /app/panelctl.mjs users
docker compose exec panel node /app/panelctl.mjs reset-2fa owner
docker compose exec panel node /app/panelctl.mjs reset-password owner
```

**Panel database lost or damaged.** Restore last night's copy:

```bash
docker compose stop panel
docker run --rm -v zomboid_panel-data:/dst -v <BACKUP_DIR>/panel:/src:ro alpine sh -c "rm -f /dst/panel.db-wal /dst/panel.db-shm && cp /src/panel-<time>.sqlite /dst/panel.db && chown 1000:1000 /dst/panel.db"
docker compose start panel
```

**A restore or reset went wrong.** Every restore and reset takes a backup
first, marked "Before restore" or "Before reset"; restore that one to go back.
If the server won't start after a restore, **Backups** also offers **Undo
restore**, which puts the replaced files straight back.

**"The panel cannot reach the game server container".** Run
`docker compose ps`. If `pz` is restarting, `docker compose logs pz` says why.
After a PC restart, give it a minute.

**Friends can't join.** Check in this order:
1. The server shows *Online* on the dashboard.
2. Their game version matches the server's. Steam updates their game; the
   server follows on its next update check. **Game server → Check for
   updates** forces it.
3. The UDP forwards on the router.
4. They're using your `PANEL_HOST` name and port `16261`.

**Crash loop.** After 3 crashes in 10 minutes the watchdog stops trying. The
dashboard shows why. A broken mod is the usual cause: disable it in **Mods**,
then start.

## Certificates

The panel's certificate is signed by Caddy's own authority, so browsers warn
that it isn't trusted. That's expected. Each person clicks through once, and
again when the certificate renews (about every 4 months). Chrome also asks
again after a week.

Share the certificate's fingerprint with friends (on Discord, say) so they can
tell your certificate from someone else's. In Git Bash on this PC:

```bash
openssl s_client -connect 127.0.0.1:8443 -servername <PANEL_HOST> </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256
```

### A real certificate (no warning) with DuckDNS

The panel can get a free Let's Encrypt certificate under a DuckDNS name. It
can run alongside an existing No-IP name (which keeps serving the game and
anything else on it), and the panel moves to `https://<name>.duckdns.org:8443`. Nothing is installed on
anyone's device; browsers already trust Let's Encrypt.

1. Sign in at [duckdns.org](https://www.duckdns.org) (Google, GitHub, …) and
   add a subdomain, e.g. `my-zomboid`. Copy the token shown at the top.
2. In `.env`:
   ```ini
   PANEL_HOST=my-zomboid.duckdns.org
   PANEL_TLS=duckdns
   DUCKDNS_SUBDOMAIN=my-zomboid
   DUCKDNS_TOKEN=<the token>
   COMPOSE_PROFILES=duckdns
   ```
3. `docker compose up -d`. The `duckdns` container points the name at your
   public IP every 5 minutes. Caddy proves ownership through a DuckDNS TXT
   record, gets the certificate within a minute or two, and renews it by
   itself. Watch it with `docker compose logs -f caddy duckdns`.

The LAN IP and `localhost` keep the self-signed certificate: public
authorities don't issue for those. Going back is `PANEL_TLS=internal` and the
old `PANEL_HOST`.
