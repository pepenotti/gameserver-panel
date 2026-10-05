# Windows: set up and run game servers

This guide takes a Windows 10 or 11 PC from nothing to game servers your friends can join, and
then covers running them day to day. You don't need to have run a game server before. Commands
are typed in **PowerShell** (Start menu → "PowerShell") unless a step says otherwise; replace the
example values (`example.duckdns.org`, `192.168.1.50`) with your own.

The same project runs on [Linux](runbook-linux.md) and [macOS](runbook-macos.md). What works
differently on each, and why, is in [limitations](limitations.md): read its **Host** part before
you open servers to the public.

## What you are setting up

- **The panel**: the web page where you and your friends create, start, configure and back up
  servers. You reach it at `https://<this PC>:8443`.
- **The stack**: three small programs in Docker containers: the panel, Caddy (HTTPS in front of
  it) and the orchestrator (the only part allowed to create containers).
- **One container per game server**, created by the orchestrator when you create a server in the
  panel. Servers don't see each other.

Everything runs inside **Docker**. On Windows, Docker runs in a small Linux virtual machine that
WSL (the Windows Subsystem for Linux) provides.

**What you need**
- Windows 10 or 11, 64-bit, with virtualisation turned on (most PCs from the last ten years have
  it; Docker's installer says if it isn't).
- Memory: the games' memory plus about 2 GB for Windows and Docker. Project Zomboid wants 4–8 GB
  for itself, Minecraft 2–4 GB, Terraria 1–2 GB, Valheim about 1.5 GB.
- Disk: 20 GB free to start; Project Zomboid alone is 7 GB, plus worlds and backups.
- A router you can sign in to, to forward ports to this PC.
- An administrator account on the PC for the installs and the firewall.

## 1. Choose how Docker runs

There are two ways. Pick one; everything after step 2 is the same for both.

| | A: Docker Desktop | B: Docker Engine inside WSL |
|---|---|---|
| Effort | An installer, a few clicks | About 15 minutes of commands |
| Players' addresses | **Hidden**: every player seems to come from one address, so bans by address hit everyone (see [limitations](limitations.md#players-addresses-are-hidden-behind-docker-desktop)) | Kept, with mirrored networking (see [limitations](limitations.md#players-addresses-are-hidden-behind-docker-desktop) for whether this is measured yet) |
| Starts | When you sign in to Windows | When WSL starts (a scheduled task keeps it up) |
| Good for | Friends only; trying it out | Servers open to people you don't know |

If you're unsure, start with **A**. You can move to B later: your servers and backups move with a
backup and a restore (see [Moving to another computer](#moving-to-another-computer)).

## 2. Install Docker

### A: Docker Desktop

1. Download Docker Desktop from docs.docker.com ("Install Docker Desktop on Windows") and run the
   installer. Keep **Use WSL 2** ticked. Restart when it asks.
2. Open Docker Desktop and accept its terms (that's your agreement with Docker).
3. **Settings → General**: turn on **Start Docker Desktop when you sign in to your computer**.
4. **Memory.** Docker Desktop's virtual machine gets part of your PC's memory, and every game
   server must fit inside it. Create the file `%USERPROFILE%\.wslconfig` (in Notepad: File →
   Save as, "All files", name `.wslconfig`, in your user folder) with, for a 32 GB PC:

   ```ini
   [wsl2]
   memory=20GB
   swap=8GB
   ```

   Then run `wsl --shutdown` once in PowerShell. It stops WSL and Docker for a moment, so do it
   before you create servers.
5. Check it works: `docker run --rm hello-world` prints "Hello from Docker!".

> **If Docker Desktop won't start:** on some Windows 11 builds it crashes at startup on socket
> files it can't delete. Option B avoids Docker Desktop entirely.

### B: Docker Engine inside WSL

1. Install Ubuntu in WSL: `wsl --install -d Ubuntu`. Restart if asked, then open **Ubuntu** from
   the Start menu and choose a user name and password for it (a Linux account, separate from
   your Windows one).
2. In Ubuntu, turn on systemd so Docker can start by itself: run `sudo nano /etc/wsl.conf`, make
   it contain

   ```ini
   [boot]
   systemd=true
   ```

   save (Ctrl+O, Enter, Ctrl+X), then in PowerShell run `wsl --shutdown` and open Ubuntu again.
3. Install Docker Engine and its Compose plugin in Ubuntu by following docs.docker.com → Docker
   Engine → Install → Ubuntu ("Install using the apt repository"), then
   `sudo usermod -aG docker $USER`, close Ubuntu and open it again. `docker run --rm hello-world`
   should work without `sudo`.
4. **Networking and memory.** Create `%USERPROFILE%\.wslconfig` (see A.4 for how) with:

   ```ini
   [wsl2]
   networkingMode=mirrored
   memory=20GB
   swap=8GB
   ```

   Mirrored networking makes ports opened in WSL listen on your PC's own network address, so
   your router can reach the game servers, and lets the games see players' real addresses. Run
   `wsl --shutdown` once afterwards.
5. **Keep WSL running.** WSL stops Ubuntu when no window uses it. In **Task Scheduler** → Create
   Task: trigger "At log on" (your account), action "Start a program": `wsl.exe` with arguments
   `-d Ubuntu --exec sleep infinity`, and on the Settings tab untick "Stop the task if it runs
   longer than". Check after a day that `wsl -l -v` still shows Ubuntu **Running**.
6. Do every following step **inside Ubuntu** (its own terminal), with the project in your Ubuntu
   home folder (`~/gameserver-panel`), not under `/mnt/c`: files on the Windows side are slow
   from WSL.

## 3. Get the panel and configure it

1. Install **Git** (git-scm.com) and **Node.js 24** or newer (nodejs.org, the LTS installer). In
   Ubuntu (option B): `sudo apt install git` and Node.js from nodejs.org's instructions for
   Ubuntu. Node is only used for the setup scripts; the panel itself runs in Docker.
2. Get the project and create your settings file:

   ```powershell
   git clone <the project's address> gameserver-panel
   cd gameserver-panel
   node scripts/init-env.mjs
   ```

   `init-env.mjs` writes `.env` with fresh random secrets, including the owner's first password.
   `.env` holds secrets: never share it or put it online.
3. Find this PC's address on your network: `ipconfig` in PowerShell, the **IPv4 Address** of
   your Wi-Fi or Ethernet adapter, such as `192.168.1.50`.
4. Open `.env` in a text editor and set:

   | Key | What to put |
   |---|---|
   | `PANEL_HOST` | The name people type to reach the panel, such as `example.duckdns.org` (see [A name that follows your address](#7-a-name-that-follows-your-address)). Until you have one, leave `panel.localhost` |
   | `LAN_IP` | This PC's address from step 3, such as `192.168.1.50` |
   | `PANEL_PORT` | `8443` (leaves 80 and 443 to anything else on this PC) |
   | `TZ` | Your time zone, such as `Europe/Madrid` or `America/Argentina/Buenos_Aires`. Schedules use it |
   | `BACKUP_DIR` | A folder on a disk with room, such as `D:/game-backups` (option B: `/mnt/d/game-backups`) |
   | `ORCH_HOST_PORTS` | The ports game servers may use. The default covers every game's usual ports; leave it |
   | `ORCH_MAX_MEM_MB` | The most memory one server may have, in MB. It must fit inside Docker's memory (step 2) |
   | `ORCH_MAX_SERVERS` | How many servers this PC may have (default 10) |
   | `CLIENT_IP_TRUSTWORTHY` | `false` with Docker Desktop; `true` with option B |

## 4. Start the stack

In the project folder:

```powershell
docker compose build steam java native
docker compose up -d --build
```

The first command builds the images game servers run from: `steam` for Project Zomboid, Valheim,
tModLoader and Avorion, `java` for Minecraft, `native` for vanilla Terraria and TShock. Leave out
the ones you won't use; build them later if you change your mind. It takes several minutes the
first time. The second starts the panel, Caddy and the orchestrator; `docker compose ps` should
list the three as running.

## 5. Sign in for the first time

1. Open `https://localhost:8443` in your browser. It warns that the connection isn't private:
   the panel's certificate is signed by Caddy, not by a public authority. Choose **Advanced →
   Continue** (see [Certificates](#certificates) for why, and how to remove the warning).
2. Sign in as `owner` with the `PANEL_OWNER_PASSWORD` from `.env`. It's used only for this first
   sign-in.
3. Choose a new password, then set up two-factor sign-in: scan the QR code with an authenticator
   app (Google Authenticator, Microsoft Authenticator, Aegis…) and type its code.
4. Keep the recovery codes it shows somewhere safe, **off this PC** (printed, or in a password
   manager). They're your way back in if you lose your phone.

## 6. Create your first server

1. **Servers → Create**. Pick a game, its flavour and version, a name and its memory. The panel
   picks free ports for it.
2. The first server of a game version downloads that game's files once (its page shows the
   progress). Every later server on the same version uses the same files and is ready at once.
3. Press **Start**. Watch it come up on **Console**. A new world is made on the first start.
4. Look through **Configuration** (the server's name, password, welcome message) and
   **Schedules** (daily restart, backups, update checks).
5. On the dashboard, the **How to join** card shows what players type, from this PC, from your
   home network and from the internet.

Minecraft asks the owner to accept Mojang's EULA before its first start; only you can, on the
server's page.

<a id="a-real-certificate-no-warning-with-duckdns"></a>

## 7. A name that follows your address

Your home internet address can change. A free DuckDNS name follows it, and also gives the panel
a real certificate (no browser warning).

1. Sign in at duckdns.org (with Google, GitHub…), add a subdomain such as `example`, and copy
   the **token** shown at the top. The token controls the name: treat it like a password.
2. In `.env`:

   ```ini
   PANEL_HOST=example.duckdns.org
   PANEL_TLS=duckdns
   DUCKDNS_SUBDOMAIN=example
   DUCKDNS_TOKEN=<the token>
   COMPOSE_PROFILES=duckdns
   ```

3. `docker compose up -d`. The `duckdns` container points the name at your public address every
   5 minutes; Caddy gets a Let's Encrypt certificate for it within a minute or two and renews it
   by itself. `docker compose logs -f caddy duckdns` shows them doing it.
4. In the panel, **Panel settings → How friends reach this computer**: the public address is
   your DuckDNS name by default, and the home-network address your `LAN_IP`. Every server's
   "How to join" uses them. Without a DuckDNS name, type your public IP address there, or press
   **Detect** (it asks one public service, api.ipify.org, once).

## 8. Open it to friends

Friends on the internet reach your PC through your router, which needs to be told which PC gets
which ports ("port forwarding"). Players at home don't need any of this.

1. **Give this PC a fixed address.** In your router's settings (usually `http://192.168.1.1`;
   the address and password are often on a sticker), find **DHCP reservation** (or "static
   lease", "address reservation") and reserve `LAN_IP` for this PC.
2. **Forward each server's ports.** Open the server's **How to join** card: under **Router
   forwards** it lists every port that server needs and its protocol (UDP or TCP). In the
   router's **Port forwarding** (or "virtual servers", "NAT") page, forward each one, with its
   protocol, to `LAN_IP`. Some games need more than the port players type (the next port, a
   query port): forward them all. Each new server has its own ports.
3. **The panel itself**, if friends use it from outside: forward **TCP 8443** to `LAN_IP` too.
   Leave any forwards you already have for 80/443 alone.
4. **Windows firewall.**
   - *Docker Desktop:* Windows may ask whether **Docker Desktop Backend** may accept connections
     the first time a server's port opens; allow it on **Private** networks. If you dismissed it,
     or players at home can't connect while "On this PC" works: Windows Security → Firewall &
     network protection → **Allow an app through firewall** → tick Docker Desktop Backend for
     Private. Your home network must be marked **Private** too (Settings → Network & internet →
     your connection → Private network). *Expected, not measured.*
   - *Option B (mirrored WSL):* WSL has its own firewall in front of Ubuntu. Allow the panel's
     port and each server's ports into it, in PowerShell **as administrator** (this changes your
     PC's security settings, so it's yours to run), once per port or range:

     ```powershell
     New-NetFirewallHyperVRule -Name gsp-panel -DisplayName "Game panel" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 8443 -Action Allow
     New-NetFirewallHyperVRule -Name gsp-pz-1 -DisplayName "Zomboid server" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol UDP -LocalPorts 16261-16262 -Action Allow
     ```

     The long id is WSL's own; the ports are the ones the server's card lists.
5. **Test from outside**: on a phone with Wi-Fi off (mobile data), open
   `https://example.duckdns.org:8443` and join a server with its "From the internet" line. Many
   routers can't send players at home through the public address, so players at home use the
   "On the home network" line instead (see
   [limitations](limitations.md#players-at-home-may-not-get-in-through-the-public-address)).

## 9. Keep the PC available

- **Power**: Settings → System → Power, **Sleep: Never** while plugged in. Servers stop when the
  PC sleeps.
- **Windows Update**: set **active hours** around when people play, so restarts happen outside
  them.
- **Signing in**: Docker Desktop starts when you sign in to Windows, and so do the servers that
  were running before. After a restart, sign in (and lock the screen if you like). With option B,
  the scheduled task keeps WSL up once you're signed in.
- After a restart, give it a minute: every server that was running starts again by itself.

## 10. Day to day

| To… | Do |
|---|---|
| Start, stop, restart a server | Its dashboard, or **Servers** for all of them |
| See why something failed | The server's **Console**; `docker compose logs -f panel orchestrator`; `docker logs -f gameserver-panel-srv-<server id>` |
| Change who can do what | **Users**: roles per server (viewer, operator, admin) |
| Back up now | The server's **Backups → Back up now** |
| Restore | **Backups → Restore**, choosing what to bring back; **Undo restore** puts the replaced files back if it won't start |
| See what happened | **Activity log** (who did what, and every scheduled job) |
| Stop everything cleanly | Stop each server in the panel (each saves its world), then `docker compose stop` |

**Updates of the games.** Each server's **Schedules** page sets how often it checks for an update
and what to do with one: apply it when nobody is playing, apply it after warning players, or only
tell you on Discord. A new version is downloaded **once** for every server on the old one, and
each server moves to it at its next start, after a safety backup. The old version stays on disk
until no server uses it and you remove it in **Panel settings → Game files**. To keep a server on
a version, pin the version in its launch settings.

**Scheduled jobs take turns.** Restarts, backups and updates of all your servers never run at the
same moment: each server's times are moved by a few minutes of its own (the Schedules page says
how many), and when two are due together the second waits until the first is done, plus a short
rest. A job you start by hand never waits.

**Backups.**
- Each server's backups are in `BACKUP_DIR/<server id>/`: one `.tar.zst` archive and a `.json`
  file with its checksum and contents each. The panel lists them, keeps the newest ones by
  itself (it says how many on the Backups page) and never deletes pinned ones.
- `BACKUP_DIR/panel/` has a nightly copy of the panel's own database (accounts, 2FA, settings,
  every server's secrets); the newest 7 are kept.
- Game files are never backed up: they're downloaded again when needed.
- A backup on the same PC doesn't survive the PC dying. Copy `BACKUP_DIR` to another disk or a
  cloud drive now and then; it holds secrets and players' data, so keep the copy private
  (encrypted, if it's in the cloud).

**Memory and disk.**
- The servers' memory limits must add up to less than Docker's memory (step 2), not the PC's.
  To give Docker more, raise `memory=` in `.wslconfig` and run `wsl --shutdown` (this stops the
  servers; start them again after). See
  [limitations](limitations.md#game-servers-share-dockers-memory-not-your-pcs).
- Docker Desktop's virtual disk grows but doesn't shrink when you delete servers or game
  versions. Keep a margin before downloading big games, and see
  [limitations](limitations.md#docker-desktops-disk-only-grows).

## 11. Upgrade the panel

Your servers keep running during an upgrade.

1. Read what changed: `git fetch`, then `git log --oneline HEAD..origin/main`.
2. Get it and rebuild:

   ```powershell
   git pull
   docker compose build steam java native
   docker compose up -d --build
   ```

   (Build the same runtime images you built in step 4.)
3. The panel updates its database by itself when it starts. Each game server moves to the
   rebuilt image at its next start (its page says "applies at next start"); a stopped one moves
   at once. Nothing is restarted for you.

If an upgrade goes wrong, the nightly copy of the panel's database in `BACKUP_DIR/panel/` brings
the panel back (see below), and every server's backups are untouched.

## 12. When something goes wrong

**Locked out of the panel** (lost the 2FA phone and the recovery codes, or forgot the password).
From this PC, in the project folder:

```powershell
docker compose exec panel node /app/panelctl.mjs users
docker compose exec panel node /app/panelctl.mjs reset-2fa owner
docker compose exec panel node /app/panelctl.mjs reset-password owner
```

**The panel's database is lost or damaged.** Put last night's copy back (replace `<BACKUP_DIR>`
and `<time>`):

```powershell
docker compose stop panel
docker run --rm -v gameserver-panel_panel-data:/dst -v <BACKUP_DIR>/panel:/src:ro alpine sh -c "rm -f /dst/panel.db-wal /dst/panel.db-shm && cp /src/panel-<time>.sqlite /dst/panel.db && chown 1000:1000 /dst/panel.db"
docker compose start panel
```

**A restore or reset went wrong.** Every restore and reset takes a backup first ("Before restore",
"Before reset"): restore that one. If the server won't start after a restore, **Undo restore**
puts the replaced files straight back.

**"The panel cannot reach the game server container".** `docker ps -a --filter
label=gsp.server=<server id>` shows its container. If it keeps restarting, `docker logs
gameserver-panel-srv-<server id>` says why, and `docker compose logs orchestrator` shows anything
the orchestrator refused. The owner can remove a server that won't run (forced removal; it says
whether the final backup was taken).

**Friends can't join.** In this order:
1. The server shows *Online*.
2. Their game version matches the server's (the card names it). A server that is behind updates
   at its next update check; **Game server → Check for updates** asks now.
3. Every port under **Router forwards** is forwarded, with its protocol, to `LAN_IP`, and `LAN_IP`
   is still this PC's address.
4. The firewall step above.
5. They use the "From the internet" line; players at home use "On the home network".

**A port is "in use" though nothing uses it.** Windows reserves some port ranges for itself; see
[limitations](limitations.md#some-ports-cant-be-used-on-windows) and give the server other
ports.

**Crash loop.** After 3 crashes in 10 minutes the watchdog stops trying; the dashboard shows the
last error the game printed. A broken mod is the usual cause: disable it in **Mods**, then start.

## Moving to another computer

1. On the old PC: stop each server and press **Backups → Back up now** (a backup of a stopped
   server is the quietest), then **Download** it. Copy the newest `BACKUP_DIR/panel/panel-*.sqlite`
   too.
2. On the new one, follow this guide (or the [Linux](runbook-linux.md) one) up to step 4, but
   before the first `docker compose up`, put the panel's database in place; this keeps accounts,
   2FA, settings and schedules:

   ```powershell
   docker compose create
   docker run --rm -v gameserver-panel_panel-data:/dst -v "${PWD}:/src:ro" alpine sh -c "cp /src/panel-<time>.sqlite /dst/panel.db && chown 1000:1000 /dst/panel.db"
   docker compose up -d
   ```

3. For each server: if it's listed, start it once so its game files are downloaded, stop it,
   then **Backups → Upload** the archive (owner only) and **Restore** it with every part ticked.
4. Point your router's forwards (and `LAN_IP`) at the new computer.

## Certificates

Without DuckDNS, the panel's certificate is signed by Caddy's own authority, so browsers warn.
Each person clicks through once, and again when the certificate renews (about every 4 months);
Chrome also asks again after a week. Don't ask friends to install Caddy's root certificate: it
could sign a certificate for any website (see [security](security.md#tls)).

To let friends check they reached your panel and not someone else's, share the certificate's
fingerprint with them on a channel they trust. In Git Bash on this PC:

```bash
openssl s_client -connect 127.0.0.1:8443 -servername <PANEL_HOST> </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256
```

The DuckDNS setup in [step 7](#7-a-name-that-follows-your-address) removes the warning for the
DuckDNS name. The home-network address and `localhost` keep Caddy's certificate: public
authorities don't issue certificates for those.

## What Docker Desktop changes

Docker Desktop relays every connection into its virtual machine, which has these effects (each
explained, with workarounds, in [limitations](limitations.md)):

- Players' and visitors' addresses are hidden: bans by address hit everyone, and the activity log
  shows one address for everybody.
- Game servers share Docker's memory, not the PC's.
- Its disk only grows.
- Game ports listen on the PC itself (on every address, unless `PUBLISH_ADDR` says otherwise).

Option B (Docker Engine inside WSL, mirrored networking) is the way around the first one.
