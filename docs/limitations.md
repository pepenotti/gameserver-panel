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
console: Terraria (all flavours), Avorion and other games added with a manifest.

**What you'll notice:** a command typed on the Console page shows its reply in
the live log below, not next to the command.

**Status:** Measured, Sept 2026 (Terraria); the same for Avorion, Oct 2026.

### Games added with a manifest have no settings forms

**Affects:** Steam games the panel runs from a manifest (Avorion, and Valheim,
a manifest plus a little code).

**What you'll notice:**
- Their launch settings (name, slots, branch, memory…) have a form, but the
  game's own settings files are edited as text, with the keys the panel
  manages locked and passwords hidden.
- A problem the game reports without stopping (no access to Steam, for
  example) is said once in the live log, not on the server's page.
- Moderation answers with the first line the game prints after the command.
  If the game prints something else at that moment, that line is what you see.

**Why:** a manifest describes the game in data; forms per setting and richer
replies need code (PRD §7, §10).

**Status:** Measured with Avorion and Valheim, Oct 2026.

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

## Valheim

Measured on the dedicated server 1.0.16 (`verification/valheim-1.0.16.md`), Oct 2026, without a
game client; "Expected" items need a player to confirm. The panel runs Valheim from a Steam manifest
plus two pieces of code (M6, `packages/adapter-valheim`), checked against the real server ("Adapter
check" in that document).

- **There is no server console.** The panel can't send Valheim commands, warn players in game
  before a restart, broadcast, or ask the game to save. It stops the server with a signal
  (SIGINT), and the game saves the world first. Measured.
- **A running backup holds the world as of the last autosave.** Valheim saves on its own timer and
  when it stops; it can't be asked to save. The panel starts it with a 5-minute save interval (the
  game's own is 30 minutes; the *Autosave every* launch setting changes it, from 1 minute to an
  hour) and copies the newest complete save, so a backup taken while it runs misses what happened
  since. Measured.
  - A shorter save interval narrows the gap.
  - A backup of a stopped server is complete.
  - A backup taken while the game is saving doesn't wait for that save: it takes the save before
    it, which is complete (the new one isn't until the game marks it so), with the world files
    that save uses. The save layout and its versioned chunk files are measured (the adapter
    check); a copy overlapping a real save's writing wasn't caught (a save takes 0.1 s), so that
    part is tested with the fake. Worlds bigger than one chunk file weren't measured: how the
    game names their chunks is *expected* to follow the same rule.
- **Kick and ban happen in the game.** Only admins (their SteamIDs in the admin list) can kick or
  ban, from the game's own console. The panel bans, allows and makes admins by SteamID in the
  game's lists (`bannedlist.txt`, `permittedlist.txt`, `adminlist.txt`) and edits them as text,
  **only while the server is stopped**: the game never rewrote them in testing, but whether it
  notices an edit while it runs is *Expected*, not measured, so the panel doesn't rely on it. Bans
  name SteamIDs, so Docker Desktop's hidden addresses don't affect them.
  - A non-empty allowed list lets only those players in. A list the panel emptied may keep one
    blank line; whether Valheim takes a blank line for an entry isn't measured. Check the allowed
    list's file after removing its last player, and leave it truly empty (or with only its `//`
    heading) to let everyone in.
- **A server in the public list needs a real password.** Listing is off by default. A listed
  server refuses to start with a password shorter than 5 characters, or one that is part of the
  server's name: the panel refuses those settings before it starts, in its own words. Private
  servers take any password, or none (the panel then passes no password at all). Measured.
- **The number of players online is only known for servers in the public list.** Valheim answers
  Steam's server queries only when it is listed; the panel counts players that way (the count
  only: names aren't read). For a private server the panel follows the join and leave lines in the
  log and lists players by SteamID. *Expected*, not measured with a player.
  - A listed server that stops answering those queries is reported as not responding after a few
    polls, as a game whose console stops answering is.
- **Crossplay shares your public address.** Crossplay (Xbox, Game Pass and other platforms, joined
  by a code the game prints in its log) is off by default. On, the game uses Microsoft's PlayFab
  instead of Steam's networking, registers your public address with PlayFab and prints it in its
  log. Its libraries are in the panel's steam image since M6; an image without them makes the game
  start but nobody can join through crossplay, which the panel says in the log. Measured (crossplay
  was run once, in the fact-finding; joining by code needs a player).
- **No world presets or modifiers yet.** Valheim takes them on its command line (`-preset`,
  `-modifier`), and they are stored in the world, but only one preset was tried and what one does
  to an existing world wasn't measured, so the panel doesn't offer them.
- **The world is named after the server's ID**, the name the game uses for its files
  (`worlds_local/<id>/`). Measured with an ID with dashes in the adapter check.
- **Valheim's own backups are left as the game sets them.** They never ran in any measured session
  ("World session not long enough"), so where they would go and how big they get isn't known.
  A running backup of the panel takes only the newest complete save and would leave them out.
  *Expected*.
- **It needs about 1.4 GiB and keeps a third of a CPU core busy**, even with nobody online. The
  panel gives it 3 GiB plus 256 MiB by default (2 GiB at least). Measured.
- **The first start downloads about 2.2 GB, and a new world takes a minute and a half** to
  generate before the server is ready (45 seconds for an existing one). Measured.
- **A server port taken by something else isn't reported.** The game says it is ready but no one
  can connect. The panel gives every server its own ports, so this matters only for ports used
  outside the panel. Measured.
- **Without access to Steam the server starts but players can't join**: it keeps logging
  `Game server connected failed`, and the panel says so once in the log. *Expected* (joining not
  tried).
- **x86-64 only**, like every game installed through Steam. Measured.
- **Mods (BepInEx) aren't supported** (PRD §4): they install into the game's own folder, which the
  panel keeps untouched.

## Avorion (a Steam game run from a manifest)

Measured on the dedicated server 2.5.13 (`verification/avorion-2.5.13.md`), Oct 2026, without a
game client. Avorion is the first game the panel runs from a manifest alone
(`packages/adapter-manifest/manifests/avorion.json`, M6); the manifest adapter was checked against
the real server too ("Manifest adapter check" in that document).

- **`server.ini`, `admin.xml` and the lists can only be edited while the server is stopped.** The
  running game writes its own settings back over `server.ini` at every save (every 5 minutes as
  the panel starts it) and when it stops, and drops keys it doesn't know and comments. The panel
  refuses an edit while it runs. Measured for `server.ini`; the other files are treated the same
  to be safe (*expected*).
- **Some settings come from the launch settings.** The port, the server's name, the player slots,
  the public listing and the autosave interval are passed on the command line, and the game writes
  them into `server.ini`: change them in the launch settings, not in the file. Measured.
- **Crash reports to the game's maker are on by default.** The panel starts Avorion with them off,
  and keeps them off in `server.ini`. Measured.
- **Avorion makes its own backups every hour** into the server's `avorion-backups` folder (on the
  server's data volume, not in the panel's backups). They take disk space; old ones are not
  removed by the panel. *Expected* (the hourly backup wasn't seen: sessions were shorter).
  - **Except during a new galaxy's first run** (a new server, or after a reset): the game writes
    its `server.ini` on that start, so the panel can set the backup folder only from the next
    start; until then its backups go to the steam folder (`~/.avorion/backups`). Writing a
    `server.ini` before the first start isn't an option: the game then gives every new galaxy the
    same seed (0, or an empty one). Measured.
- **The panel's backups hold the whole galaxy folder,** the game's log files (`serverlog`,
  `server-stats`) included. Measured.
- **A reset makes a new galaxy, settings included**: `server.ini` lives in the galaxy's folder, so
  it goes too. The next start writes a fresh one with the game's defaults and the launch
  settings, and a new random seed. Measured.
- **Without access to Steam it falls back to older, unsafe network protocols** after 30 seconds,
  and isn't listed; the same happens when its Steam query port is taken. The panel says so in the
  log. Measured.
- **Which ports players need isn't known yet.** With Steam networking the game listened only on
  its two query ports; the panel publishes the game port (UDP and TCP) as well. Steam is told each
  port's number, so the panel publishes them at the same numbers inside and out. *Expected*, needs
  a player.
- **A server that isn't listed publicly should keep the default query port, 27003.** With another
  one Avorion warns at every start that players may not be able to connect (the panel repeats
  the warning in the log). The panel picks ports near Avorion's defaults (27000, 27003, 27020)
  only when the host allows them: add `27000-27021` to `ORCH_HOST_PORTS` for an Avorion server,
  or list it publicly. The warning is measured; whether players really can't join is *expected*,
  needs a player.
- **Moderation with players online isn't measured**: kick, ban and the player list were only
  tried with nobody connected. Bans name the player (`/ban <name>`), which Docker Desktop's hidden
  addresses don't affect; Avorion's ban by address (`/banip`) looked the address up as a player
  name and isn't offered. Measured. A reason given for a kick or ban in the panel isn't passed on:
  how the console takes one wasn't measured.
- **Console commands start with `/`.** The panel adds it to what you type. Measured.
- **x86-64 only.** Measured.
