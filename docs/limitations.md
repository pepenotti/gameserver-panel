# Known limitations and workarounds

What the panel can't do, or does differently, depending on where it runs and
which game a server plays: what you'll notice, why it happens, and what to do
about it. Read the **Host** section before you open servers to the public.

Each entry has a status:

- **Measured**: seen on a real setup, named in the entry.
- **Expected**: follows from how the platform or game works, but this project
  hasn't measured it yet. The entry says when it will be.

Found something that isn't here? It belongs in this list (UX-04): add it in
the same change that finds it.

## Host

### Players' addresses are hidden behind Docker Desktop

**Affects:** Windows and macOS hosts running Docker Desktop. Every game.

**What you'll notice:**
- Every player connects from the same private address, for example
  `172.17.0.1`. Game logs, player lists and ban lists all show it.
- A ban by address shuts out **every** player, not just the one you meant.
  - **Vanilla Terraria and tModLoader** can only ban by address, so on Docker
    Desktop they effectively can't ban one player.
  - **Minecraft's `ban-ip`** and **TShock's address bans** are affected the
    same way.
- Game features that count connections per address treat all your players as
  one. **Paper's `connection-throttle`** (on by default, 4 seconds) is expected
  to turn away a second player who joins within 4 seconds of the first.
  *Expected, not yet measured.*
- **TShock's `KickProxyUsers`** (on by default) has not been checked against
  the relay's address. *Unverified.*

**Why:** Docker Desktop relays each incoming connection into its virtual
machine, so the game sees the relay's address instead of the player's. Docker
Desktop has no setting that keeps the real address.

**Workarounds:**
- Ban by account, which isn't affected:
  - Project Zomboid: bans use Steam accounts.
  - Minecraft: `ban <name>` stores the player's account id.
  - TShock: ban by name, client id or account.
- For a Terraria server other people join, use **TShock** rather than vanilla
  or tModLoader.
- The panel tells you before an address ban when it can see that every player
  shares one address.

**Fixes:**
- **Run the stack on Linux with Docker Engine.** Docker Engine's port
  forwarding keeps the player's address. *Expected; measured in M7.*
- **On Windows, run Docker Engine inside WSL with `networkingMode=mirrored`**
  instead of Docker Desktop (see `runbook-windows.md`, option B). This is
  expected to keep the address too. *Expected; measured in M7.*

**Status:** Measured on Windows 11 with Docker Desktop (Engine 29.7.2), Sept
2026. The Minecraft and Terraria test servers and the panel's activity log
all saw the relay's address.

### The panel's visitors are hidden the same way

**Affects:** Windows and macOS hosts running Docker Desktop.

**What you'll notice:**
- The activity log and the list of signed-in sessions show the relay's
  address for everyone.
- Sign-in protection still works, because it doesn't rely on addresses.
  - Each account gets slower after repeated wrong passwords, so nobody can
    lock you out.
  - After 30 failed sign-ins in a minute, everyone's sign-ins are slowed for
    a minute. On Docker Desktop that brake can't tell one attacker from your
    users, so a password spray slows everyone.

**Why:** the same relay as above.

**Fix:** the same as above.

**Status:** Measured, Sept 2026 (activity log).

### Game servers share Docker's memory, not your PC's

**Affects:** Docker Desktop on Windows and macOS.

**What you'll notice:** servers fail to start, or are refused, long before
your PC's memory is used up. Docker Desktop's virtual machine has its own
limit, smaller than the PC's.

**Workaround:** raise the virtual machine's memory.
- On Windows, set `[wsl2] memory=` in `%USERPROFILE%\.wslconfig`, then restart
  WSL. That also restarts the running servers.
- On macOS, change it in Docker Desktop's settings.

The panel's limit per server, `ORCH_MAX_MEM_MB`, must fit inside it.

**Status:** Measured. A 32 GB Windows PC gave Docker Desktop 15.6 GiB.

### Docker Desktop's disk only grows

**Affects:** Docker Desktop on Windows and macOS.

**What you'll notice:** deleting servers doesn't give the space back to the PC.
For scale, one Project Zomboid install is about 7 GB.

**Workaround:** keep a margin before downloading big games. When you need the
space back, compact the virtual disk with Docker Desktop's or Windows' own
disk tools.

**Status:** Expected (how Docker Desktop's virtual disk works).

### Some ports can't be used on Windows

**Affects:** Windows hosts.

**What you'll notice:** a server can't start because its port is "in use",
although nothing you know of uses it.

**Why:** Windows reserves port ranges for Hyper-V and WSL. They're listed by
`netsh interface ipv4 show excludedportrange protocol=tcp` (and
`protocol=udp`), and they differ between PCs.

**Workaround:** give the server ports outside those ranges.

**Status:** Measured. On one test PC, UDP 50000–50059 and 58592–58891 were
reserved.

### ARM computers can't run every game

**Affects:** ARM64 hosts such as Apple Silicon Macs or a Raspberry Pi.

**What you'll notice:** the create form shows these games disabled, with the
reason. The panel won't create servers it can't run.

**Why:** these games publish x86-64 builds only:
- Project Zomboid, Valheim and tModLoader, which are installed through Steam;
- vanilla Terraria and TShock.

Minecraft's server is Java and is expected to run on ARM64.

**Status:** The refusal is tested. Minecraft on a real ARM64 host is
*expected*, and is measured in M7.

### macOS is documented but untested

**Affects:** macOS hosts.

**What you'll notice:** the setup guide exists, but nobody has run this project
on a Mac yet.

**Status:** Untested until someone runs it on a Mac (M7).

## Panel

### Typed console commands on some games answer in the log

**Affects:** games controlled through their console instead of a remote
console: Terraria (all flavours).

**What you'll notice:** a command typed on the Console page shows its reply in
the live log below, not next to the command.

**Status:** Measured, Sept 2026.

### Version and update checks share one GitHub allowance

**Affects:** TShock and tModLoader servers.

**What you'll notice:** "can't check right now" for versions or updates after
many checks in a short time.

**Why:** GitHub allows 60 anonymous requests an hour for each public address.
Every server and the panel on one host share that allowance.

**Workaround:** the panel caches answers for 10 minutes and waits for GitHub's
reset when the allowance runs out. Checks resume on their own.

**Status:** Measured (the limit, and that a "not modified" answer still
counts).

## Project Zomboid

- **The first start downloads about 7 GB.** A second server on the same host
  can copy the first one's install instead (see
  `verification/m2-acceptance.md`, step 4). Measured.

## Minecraft

- **The game rewrites `server.properties` on its own.** It does so at every
  start and when the whitelist is switched in game.
  - The panel puts its settings back before every start it makes.
  - Edits made in the file while the server runs, outside the panel, can be
    lost.

  Measured, 26.3.
- **Operator and ban lists can only be edited while the server is stopped,**
  because the running game writes them back from memory. Measured.
- **Whitelisting needs the player's Java Edition name.** It is looked up with
  Mojang, so Microsoft account names and Bedrock gamertags won't be found. Add
  players on the Players page. Measured.
- **A brand-new Minecraft version has only test builds of Paper** (ALPHA) for
  a few weeks. The panel offers them with a warning. Measured.
- **Only Minecraft 1.16.5 and newer are offered** (owner's decision, Q11).
- **Console commands are limited to 1446 bytes, and `say` to 256
  characters.** Longer ones are refused before they're sent. Measured.
- **Paper's usage statistics (bStats) start off** on new servers. You can turn
  them on in the server's settings. Owner's decision, Q10.

## Terraria

- **Vanilla and tModLoader ban by address only.** Read "Players' addresses
  are hidden behind Docker Desktop" above.
  - A ban is lifted while the server is stopped, because the game keeps its
    ban list in memory.

  Measured.
- **Vanilla Terraria crashes when clients reconnect quickly.** About six quick
  connects did it in testing. The panel restarts it, but TShock doesn't have
  the problem and is the better choice for public servers. Measured, 1.4.5.8.
- **The world is named after the server's ID,** the name you choose when you
  create the server.
- **tModLoader runs on Terraria 1.4.4,** while vanilla and TShock follow
  1.4.5. Players join a tModLoader server from tModLoader, with the same
  mods. Measured.
- **terraria.org publishes no checksums for its server downloads.** The panel
  checks the versions it measured against checksums it recorded. A newer
  version installs with a warning that it couldn't be checked. Measured.
- **TShock rewrites its own config at every start** and drops keys it doesn't
  know. The panel's settings page says so. Measured, TShock 6.2.1.
- **TShock plugins run code inside the server.**
  - Only admins can add them, after a warning.
  - Links must be GitHub release files.
  - TShock silently skips a plugin it can't load, so "in use" means the file
    was in place, not that TShock accepted it.

  Measured.
- **TShock needs .NET 9, whose support ends in November 2026.** TShock plans to
  move to a newer .NET, and the panel's image will follow.
- **Large worlds need at least 2 GiB.** tModLoader uses about 1 GiB before any
  mod. Measured.
