# Linux: set up and run game servers

This guide takes a Linux computer (a PC at home, a mini PC, or a rented server, a "VPS") from
nothing to game servers your friends can join, and then covers running them day to day. You
don't need to have run a game server before. Commands are typed in a terminal; replace the
example values (`example.duckdns.org`, `192.168.1.50`) with your own.

The same project runs on [Windows](runbook-windows.md) and [macOS](runbook-macos.md). Linux with
Docker Engine is the setup with the fewest limitations: what works differently elsewhere is in
[limitations](limitations.md).

## What you are setting up

- **The panel**: the web page where you and your friends create, start, configure and back up
  servers, at `https://<this computer>:8443`.
- **The stack**: the panel, Caddy (HTTPS in front of it) and the orchestrator (the only part
  allowed to create containers), each in a Docker container.
- **One container per game server**, created by the orchestrator when you create a server in the
  panel. Servers don't see each other.

**What you need**
- A 64-bit Linux with systemd: Ubuntu 22.04 or newer, or Debian 12 or newer, are the easiest.
  Other distributions work with Docker's instructions for them.
- An x86-64 processor for every game. On an ARM computer (a Raspberry Pi, an ARM VPS) only
  Minecraft runs; the panel shows the others as unavailable and says why.
- Memory: the games' memory plus about 1 GB for Linux and the panel. Project Zomboid wants 4–8 GB
  for itself, Minecraft 2–4 GB, Terraria 1–2 GB, Valheim about 1.5 GB.
- Disk: 20 GB free to start; Project Zomboid alone is 7 GB, plus worlds and backups.
- At home: a router you can sign in to, to forward ports. On a VPS: access to its provider's
  firewall settings.
- A user that can run `sudo`.

## 1. Install Docker Engine

1. Follow docs.docker.com → Docker Engine → Install → your distribution ("Install using the apt
   repository" on Ubuntu and Debian). It installs Docker Engine and the Compose plugin.
2. Let your user run Docker without `sudo`, then sign out and in again:

   ```bash
   sudo usermod -aG docker $USER
   ```

3. Docker starts at boot by itself (`sudo systemctl enable --now docker` if it doesn't). Check:
   `docker run --rm hello-world` prints "Hello from Docker!".

Docker Engine on Linux gives containers the computer's whole memory and disk: there is no
separate virtual machine to size, as on Windows and macOS.

## 2. Get the panel and configure it

1. Install Git and Node.js 24 or newer: `sudo apt install git`, and Node.js from nodejs.org's
   instructions for your distribution. Node is only used for the setup scripts; the panel itself
   runs in Docker.
2. Get the project and create your settings file:

   ```bash
   git clone <the project's address> gameserver-panel
   cd gameserver-panel
   node scripts/init-env.mjs
   ```

   `init-env.mjs` writes `.env` with fresh random secrets, readable only by you, including the
   owner's first password. Never share `.env` or put it online.
3. Find this computer's address: `ip -4 addr` (at home, something like `192.168.1.50`; on a VPS,
   its public address).
4. Edit `.env` (`nano .env`) and set:

   | Key | What to put |
   |---|---|
   | `PANEL_HOST` | The name people type to reach the panel, such as `example.duckdns.org`. Until you have one, leave `panel.localhost` |
   | `LAN_IP` | This computer's address from step 3 |
   | `PANEL_PORT` | `8443` (leaves 80 and 443 to anything else on this computer) |
   | `TZ` | Your time zone, such as `Europe/Madrid`. Schedules use it |
   | `BACKUP_DIR` | `./backups`, or a folder on a bigger disk such as `/srv/game-backups` |
   | `ORCH_HOST_PORTS` | The ports game servers may use. The default covers every game's usual ports |
   | `ORCH_MAX_MEM_MB` | The most memory one server may have, in MB |
   | `ORCH_MAX_SERVERS` | How many servers this computer may have (default 10) |
   | `CLIENT_IP_TRUSTWORTHY` | `true`: Docker Engine on Linux passes players' and visitors' real addresses |

5. Create the backups folder owned by user id 1000, the user the panel runs as. If Docker
   creates it, root owns it and every backup fails:

   ```bash
   mkdir -p backups && sudo chown 1000:1000 backups
   ```

   (Use your `BACKUP_DIR` instead of `backups` if you changed it.)

## 3. Start the stack

```bash
docker compose build steam java native
docker compose up -d --build
```

The first command builds the images game servers run from: `steam` for Project Zomboid, Valheim,
tModLoader and Avorion, `java` for Minecraft, `native` for vanilla Terraria and TShock. Leave out
the ones you won't use. It takes several minutes the first time. The second starts the panel,
Caddy and the orchestrator; `docker compose ps` lists the three as running.

Then sign in for the first time, create your first server and set the public address exactly as
the Windows guide describes, from
[Sign in for the first time](runbook-windows.md#5-sign-in-for-the-first-time) to
[A name that follows your address](runbook-windows.md#7-a-name-that-follows-your-address). On a
computer without a browser, open `https://<LAN_IP>:8443` from another computer on the same
network.

## 4. Firewall

Only two kinds of ports need to be reachable: the panel's (**TCP 8443**) and each game server's
own ports, which the server's **How to join** card lists under **Router forwards**. Nothing else
is published: consoles (RCON) and the servers' agents stay inside Docker.

**Know this first: Docker opens published ports itself.** Docker Engine adds its own firewall
rules for every port a container publishes, ahead of ufw's and firewalld's. A `ufw deny` does
not close a port Docker publishes. What keeps the rest closed here is that game servers can only
publish ports inside `ORCH_HOST_PORTS` (narrow it to close more), and `PUBLISH_ADDR` in `.env`,
which can bind every port to one address (`127.0.0.1`: this computer only).

Still allow the ports in your firewall, so it says what is meant to be open and keeps working if
Docker's own rules change:

- **ufw** (Ubuntu):

  ```bash
  sudo ufw allow 8443/tcp
  sudo ufw allow 16261:16262/udp     # a server's ports, as its card lists them
  sudo ufw status
  ```

- **firewalld** (Fedora, RHEL, Rocky…):

  ```bash
  sudo firewall-cmd --permanent --add-port=8443/tcp
  sudo firewall-cmd --permanent --add-port=16261-16262/udp
  sudo firewall-cmd --reload
  ```

On a **VPS**, the provider's firewall (often called a security group) sits in front of all of
this and is the reliable place to allow and deny: allow TCP 8443 and each server's ports there.

## 5. Router (a computer at home)

Friends on the internet reach your computer through your router.

1. **Give this computer a fixed address**: in the router's settings, a **DHCP reservation**
   ("static lease") of `LAN_IP` for this computer.
2. **Forward each server's ports**: every port the server's **How to join** card lists under
   **Router forwards**, with its protocol (UDP or TCP), to `LAN_IP`. Each new server has its own.
3. **TCP 8443** too, if friends use the panel from outside.
4. Test from a phone on mobile data, not Wi-Fi. Players at home use the "On the home network"
   line: many routers can't send them through the public address (see
   [limitations](limitations.md#players-at-home-may-not-get-in-through-the-public-address)).

A VPS has a public address of its own: no router, only step 4 of the firewall.

<a id="a-real-certificate"></a>

## 6. A real certificate

- **DuckDNS** (works at home and on a VPS, keeps ports 80 and 443 free): the same as on
  Windows, see [A name that follows your address](runbook-windows.md#7-a-name-that-follows-your-address).
  This is the way the project is tested.
- **On a VPS whose DNS name points at it, with port 443 free**, Caddy can get a Let's Encrypt
  certificate by itself: set `PANEL_PORT=443`, and in `docker/caddy/Caddyfile` remove the line
  `import tls-{$PANEL_TLS:internal}` from the `{$PANEL_HOST}:{$PANEL_PORT}` block. *Not tried
  with this version of the project.* See [security](security.md#tls) for what each choice
  means.

## 7. Day to day

Running servers is the same as on Windows: see
[Day to day](runbook-windows.md#10-day-to-day) (starting and stopping, logs, users, updates of
the games, scheduled jobs taking turns, backups) and
[When something goes wrong](runbook-windows.md#12-when-something-goes-wrong), with Linux paths.
What differs on Linux:

- **After a reboot**, Docker starts at boot and brings back the stack and every server that was
  running (their `restart: unless-stopped` policy and each agent's saved state). Nobody needs to
  sign in.
- **Memory**: the servers' limits share the computer's memory directly. Keep their total under
  what the computer has, leaving about 1 GB for Linux and the panel.
- **Disk**: deleting servers and game versions gives the space back. `docker system df` shows
  what Docker uses.
- **Backups** land in `BACKUP_DIR/<server id>/` and `BACKUP_DIR/panel/` (the nightly copy of the
  panel's database), owned by user id 1000. Copy them off the computer now and then, privately:
  they hold secrets and players' data. For example, nightly with `rsync` to another disk.

## 8. Upgrade the panel

Your servers keep running during an upgrade.

```bash
git fetch && git log --oneline HEAD..origin/main     # what changed
git pull
docker compose build steam java native               # the runtime images you use
docker compose up -d --build
```

The panel updates its database by itself when it starts. Each game server moves to the rebuilt
image at its next start; a stopped one moves at once. If an upgrade goes wrong, put back the
nightly copy of the panel's database (see
[When something goes wrong](runbook-windows.md#12-when-something-goes-wrong)); every server's
backups are untouched.

## Moving from Windows or another computer

Follow [Moving to another computer](runbook-windows.md#moving-to-another-computer): download each
server's backup and the newest panel database copy on the old computer, put the database in place
before the first `docker compose up` here, then upload and restore each server's backup.
