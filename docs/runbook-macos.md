# macOS: set up and run game servers

> **Untested: nobody has run this project on a Mac yet.** This guide follows from how Docker
> Desktop works on macOS and from the [Windows](runbook-windows.md) and [Linux](runbook-linux.md)
> guides, which were tried. If you run it on a Mac, write down what worked and what didn't, so
> this guide and [limitations](limitations.md#macos-is-documented-but-untested) can be corrected.

This guide takes a Mac from nothing to game servers your friends can join, and then covers
running them day to day. You don't need to have run a game server before. Commands are typed in
**Terminal** (Applications → Utilities → Terminal); replace the example values
(`example.duckdns.org`, `192.168.1.50`) with your own.

## Before you start: which games your Mac can run

- **Apple Silicon Macs** (M1 and newer): only **Minecraft** is expected to run. Project Zomboid,
  Valheim, Terraria (vanilla, TShock and tModLoader) and Avorion publish servers for Intel
  processors only; the panel shows them as unavailable and says why, rather than running them
  slowly under emulation (see [limitations](limitations.md#arm-computers-cant-run-every-game)).
- **Intel Macs**: every game.

Docker Desktop on a Mac also has the limitations Docker Desktop has on Windows: players' addresses
are hidden (bans by address hit everyone), servers share the memory Docker Desktop is given, and
its disk only grows. They are explained in [limitations](limitations.md); read its **Host** part
before you open servers to the public.

**What you need**
- macOS 13 or newer, with an administrator account.
- Memory: the games' memory plus about 3 GB for macOS and Docker. Minecraft wants 2–4 GB for
  itself.
- Disk: 20 GB free to start.
- A router you can sign in to, to forward ports to this Mac.

## 1. Install Docker Desktop

1. Download **Docker Desktop for Mac** from docs.docker.com, the build for your processor (Apple
   silicon or Intel), drag it to Applications and open it. Accept its terms (that's your
   agreement with Docker).
2. **Settings → General**: turn on **Start Docker Desktop when you sign in to your computer**.
3. **Settings → Resources**: give Docker enough **Memory** for every server you'll run at once
   plus about 1 GB, and enough **Disk** for the games, worlds and backups. Every game server must
   fit inside these, not inside the Mac's own memory.
4. Check it works: `docker run --rm hello-world` prints "Hello from Docker!".

## 2. Get the panel and configure it

1. Install **Git** (`xcode-select --install` in Terminal installs it) and **Node.js 24** or newer
   (nodejs.org, the macOS installer). Node is only used for the setup scripts; the panel itself
   runs in Docker.
2. Get the project and create your settings file:

   ```bash
   git clone <the project's address> gameserver-panel
   cd gameserver-panel
   node scripts/init-env.mjs
   ```

   `init-env.mjs` writes `.env` with fresh random secrets, including the owner's first password.
   Never share `.env` or put it online.
3. Find this Mac's address on your network: `ipconfig getifaddr en0` (Wi-Fi; `en1` on some
   Macs), something like `192.168.1.50`.
4. Edit `.env` (`open -e .env` opens it in TextEdit) and set the same keys as on Windows (see the
   table in [Get the panel and configure it](runbook-windows.md#3-get-the-panel-and-configure-it)),
   with Mac paths: for example `BACKUP_DIR=/Users/yourname/game-backups`. Keep
   `CLIENT_IP_TRUSTWORTHY=false` (Docker Desktop hides visitors' addresses), and keep
   `ORCH_MAX_MEM_MB` under the memory you gave Docker.

## 3. Start the stack

```bash
docker compose build java
docker compose up -d --build
```

The first command builds the image Minecraft servers run from. On an **Intel Mac**, add the
others you'll use: `steam` (Project Zomboid, Valheim, tModLoader, Avorion) and `native` (vanilla
Terraria, TShock). On Apple Silicon, building them is pointless: their games can't run there. The
second command starts the panel, Caddy and the orchestrator.

Then sign in for the first time, create your first server and set the public address exactly as
the Windows guide describes, from
[Sign in for the first time](runbook-windows.md#5-sign-in-for-the-first-time) to
[A name that follows your address](runbook-windows.md#7-a-name-that-follows-your-address).

## 4. Open it to friends

1. **Router**: give this Mac a fixed address (a DHCP reservation of `LAN_IP`) and forward every
   port each server's **How to join** card lists under **Router forwards**, with its protocol, to
   it; also TCP 8443 if friends use the panel from outside. The steps are the same as on Windows:
   [Open it to friends](runbook-windows.md#8-open-it-to-friends).
2. **macOS firewall** (System Settings → Network → Firewall). It is off on a new Mac. If it is on,
   macOS may ask whether Docker may accept incoming connections the first time a server's port
   opens: allow it. If players at home can't connect while "On this PC" works, check **Options**
   there and allow Docker. *Expected, not measured.*
3. Test from a phone on mobile data, not Wi-Fi. Players at home use the "On the home network"
   line.

## 5. Keep the Mac available

- **Sleep**: a sleeping Mac stops its servers. System Settings → Energy (or Battery → Options on
  a laptop): turn on **Prevent automatic sleeping when the display is off** (on power adapter).
  A laptop with its lid closed sleeps unless it has an external display.
- **Signing in**: Docker Desktop starts when you sign in, and so do the servers that were running
  before. After a restart, sign in.
- **macOS updates**: schedule them for when nobody plays; the Mac restarts.

## 6. Day to day, upgrades, and when something goes wrong

The same as on Windows with Docker Desktop:
[Day to day](runbook-windows.md#10-day-to-day),
[Upgrade the panel](runbook-windows.md#11-upgrade-the-panel) (build the same runtime images as in
step 3) and [When something goes wrong](runbook-windows.md#12-when-something-goes-wrong). To give
Docker more memory, raise it in Docker Desktop's **Settings → Resources** (this restarts Docker
and stops the servers; start them again afterwards).
