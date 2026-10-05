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
- **Minecraft's `prevent-proxy-connections`** (off by default) is expected to
  turn every player away when it is on: the game asks Mojang whether a player
  joins from the address they signed in from, and sees the relay's.
  *Expected, not yet measured.*
- **TShock's whitelist** (`EnableWhitelist`) lists addresses, so it lets
  everyone in or nobody; **TShock's GeoIP** names the relay's private address
  instead of the player's country. *Expected, not yet measured.*

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
- The panel knows when it runs on Docker Desktop: the orchestrator asks Docker
  (HST-07), whatever `.env` says. It then says so on the host page (**This
  computer**), in the ban dialogs before an address ban, above the activity
  log's addresses and the signed-in devices, and on a game's settings that act
  per address (the ones above).
- On Docker Engine the host page says the addresses are expected to arrive but
  not yet measured. Once you have checked that they do (two players from
  different places show different addresses), set `CLIENT_IP_TRUSTWORTHY=true`
  in `.env` and the notes go away. When the orchestrator can't say, the
  panel warns as if the addresses were hidden.

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

The host page lists this limitation on an ARM host.

**Status:** The refusal is tested end to end, the orchestrator reading an ARM
host from a fake Docker. Minecraft on a real ARM64 host is *expected*, and is
measured in M7.

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

### The host page's numbers are a few seconds old

**Affects:** the host page (**This computer**), for the owner and admins on every server.

**What you'll notice:**
- CPU and memory are one sample per running server, taken again every few seconds while the page is
  open. CPU is in percent of one core: a server busy on two cores shows 200%. Memory leaves out
  the page cache the kernel can drop, as Docker's own `docker stats` does.
- Disk sizes are measured by Docker at most every 30 seconds, because measuring reads every file of
  every volume: a download in progress grows on the page with a delay. While Docker is measuring
  for someone else, the page keeps the last sizes and says when they were measured.
- The memory warning adds up the servers' limits only. The panel, the orchestrator, the web proxy
  and each game download running (1 GiB at most each) take memory too.
- On Docker Desktop, "the memory Docker has" is its virtual machine's, not the computer's (see
  "Game servers share Docker's memory, not your PC's"), and disk sizes are inside its virtual disk.

**Why:** the numbers come from Docker (HST-03); asking it more often would slow it down for the
servers.

**Status:** By design.

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

## Joining a server

Every server's **How to join** card (SRV-08) shows what players type on this PC, on the home
network and from the internet, and the router forwards the server needs. The addresses come from
**Panel settings** (HST-08).

### Players at home may not get in through the public address

**Affects:** every host behind a home router. Every game.

**What you'll notice:** friends on the internet join with the "From the internet" line, but a
player on your own network (Wi-Fi or cable at home) can't join with that same line.

**Why:** that player reaches your router's public address from inside, and the router has to send
the connection back into your network ("loopback" or "hairpin" NAT). Many home routers can't.

**Workaround:** at home, use the "On the home network" line (this PC's address on your network,
set in Panel settings; by default the panel's `LAN_IP`).

**Status:** *Expected* for routers in general. One test router did loop back: the panel was
reached through its public name from inside the network (`verification/pz-b42.md`, M13).

### The ports must be forwarded in your router

**Affects:** every server friends join from the internet.

**What you'll notice:** the "From the internet" line doesn't work for anyone until the router
sends those ports to this PC.

**Why:** the panel doesn't change your router: automatic router setup (UPnP) is out of scope
(PRD §4).

**Workaround:** forward every port the card lists under **Router forwards**, with its protocol
(UDP or TCP), to this PC's home-network address, and give this PC a fixed address in the router
(a DHCP reservation). Some games use more ports than the one players type (the next port, a query
port): forward them all.

**Status:** *Expected* (how home routers work). A forward of the panel's own TCP port was measured
working (`verification/pz-b42.md`, M13).

### With Docker Desktop, game ports listen on the PC itself

**Affects:** Windows and macOS hosts running Docker Desktop.

**What you'll notice:** a server's ports are open on the PC's own addresses, so "On this PC"
(`127.0.0.1`) and the home-network address both reach it.
- With `PUBLISH_ADDR` empty (the default), every address of the PC, IPv4 and IPv6, takes them.
- With `PUBLISH_ADDR=127.0.0.1` (development slots), only this PC does: the home and internet
  lines won't work.

**Why:** Docker Desktop publishes each port from a process of its own on the PC
(`com.docker.backend`) and relays it into its virtual machine.

**Workaround:** none needed. Windows' firewall may have to let Docker Desktop accept connections
from other computers: if players on your network can't get in while "On this PC" works, check it.

**Status:** Measured on Windows 11 with Docker Desktop (Engine 29.7.2), Oct 2026: published game
ports (UDP and TCP) listened on every address (`::`) or on `127.0.0.1` as published, held by
`com.docker.backend`. The firewall part is *expected*, not measured.

### A home connection's public IP address can change

**Affects:** hosts on home internet connections.

**What you'll notice:** the "From the internet" line stops working after the router gets a new
address from your provider.

**Workaround:** set the public address to a DNS name that follows the address, such as the
DuckDNS name the panel already uses for HTTPS (the default when it has one), rather than an IP.

**Status:** *Expected* (most home connections get a changing address).

### Detect sends one request to api.ipify.org

**Affects:** the owner, in Panel settings.

**What you'll notice:** nothing else: the button fills in this PC's public IPv4 address, and
nothing is saved until you press Save.

**Why:** the panel can't see its public address from inside your network, so it asks one fixed
public service, `https://api.ipify.org`, only when you press the button. That one HTTPS request
carries nothing but itself; like any web request, it shows the service your public address.
Each press is recorded in the activity log. Without the button, the panel never contacts it
(NFR-09).

**Status:** By design; tested against a fake service.

### Which joining facts are measured

The card says **Unverified** where a real client hasn't joined that way yet, with the game's own
note:
- **Minecraft:** measured. A real 26.3 client joined from Direct Connection at
  `127.0.0.1:<the published port>`; the address alone works on port 25565, the client's default.
- **Project Zomboid:** *unverified* with this panel. Players type the game port (UDP 16261 by
  default); the next port is forwarded with it.
- **Terraria:** *unverified* with a real client (a test client joined through a published port).
  tModLoader's players need tModLoader.
- **Valheim:** *unverified*: whether Join IP takes the game port or the next one hasn't been
  tried. Type the game port; if that fails, the next one.
- **Avorion:** *unverified*: how its client takes the address, and which port it uses.

### The password can travel with the message

**Affects:** admins and the owner.

**What you'll notice:** with **Include the password** on, the copied or shared message holds the
server's join password in clear text; whoever gets the message has it.

**Why:** that's the point of sharing it; everyone else only sees whether a password is set. Each
time the password is shown, the activity log records who saw it (never the password).

**Status:** By design (SRV-08).

## Shared installs

Servers of the same game and version will share one install, downloaded once and mounted
read-only (HST-09, M7). What was measured before building it is in
`verification/shared-installs.md`; these are the parts you'll notice.

### A Steam server switched back from a beta branch keeps the beta

**Affects:** Steam games: Project Zomboid, Valheim and games added with a manifest (Avorion).
Today, before shared installs.

**What you'll notice:** after you change a server's branch from a beta (Avorion's `previous`,
say) back to `public`, the update says it succeeded, but the server still runs the beta's build
and its page still names the beta branch.

**Why:** steamcmd remembers the branch inside the install, and the panel asks for `public` by
naming no branch, which steamcmd reads as "the branch already installed".

**Workaround:** none from the panel yet. Back the server up, create a new one on `public`, and
restore the backup into it.

**Fix:** ask steamcmd for `public` by name. With shared installs each branch gets an install of
its own, so a server changes branch by moving to another install.

**Status:** Measured with Avorion's `previous` branch, Oct 2026; expected for every Steam game.
Fixed in M7 (shared installs, runtime side): the agent now always names the branch to steamcmd,
`public` included.

### Old versions stay on disk until you remove them

**Affects:** every game, once installs are shared.

**What you'll notice:** after an update, the version servers used before stays on disk until no
server uses it and you confirm its removal in **Panel settings**. Sizes, measured: Project Zomboid
7.2 GB, Valheim 2.2 GB, Paper 237 MB, Avorion 191 MB, tModLoader 174 MB, Fabric and vanilla
Minecraft about 135 MB, TShock 102 MB, vanilla Terraria 59 MB.

**Why:** a running server keeps its version until its next start, and the panel never deletes a
version on its own.

**Workaround:** remove versions no server uses in **Panel settings**, under **Game files**; the
host page (**This computer**) shows what each server's game files take.

**Status:** Expected (the sizes are measured).

### Mods are still downloaded per server

**Affects:** Project Zomboid and tModLoader servers with Workshop mods, once installs are shared.

**What you'll notice:** two servers with the same mod each download and keep their own copy.

**Why:** mods differ between servers, so they stay in each server's data: tModLoader's already
are; Project Zomboid downloads its mods into the install, and the shared install points that
folder at the server's data instead (measured to work).

**Status:** Measured, Oct 2026.

### Each Steam server keeps its own copy of steamcmd

**Affects:** Steam games (Project Zomboid, Valheim, tModLoader, games added with a manifest).
Today, and with shared installs.

**What you'll notice:** about 200 MB of disk per server besides its world.

**Why:** the game's Steam connection loads Steam's library from the server's home folder and
writes its settings and logs there, so every server has a home folder of its own, filled from
the runtime image.

**Status:** Measured, Oct 2026 (204 MB per server).

### A server on a shared install can't update or check its own game files

**Affects:** every game, once a server runs from a shared install.

**What you'll notice:** an update, a version change or a file check (Steam's "validate") of such
a server goes through a new install of that version, made once by an install job; the server
itself refuses (`shared-install`). A start whose settings ask for another version than its
install holds fails with `install-mismatch` until the server is moved to an install that fits.
A Steam game's "update when it starts" setting does nothing there: updates come as new installs.

**Why:** the install is mounted read-only in every server on it, so one server can't change the
files the others run. steamcmd needs the install writable to update or check it (on a read-only
one, `validate` fails after about 2 minutes, measured).

**Workaround:** none needed: the panel makes the new install and moves each server at its next
start (UPD-03).

**Status:** Measured (steamcmd on a read-only install, Oct 2026); the agent's refusals are tested.

### TShock loads plugins from the server's data folder

**Affects:** TShock servers, once the panel's agent is of M7.

**What you'll notice:** nothing changes on the Plugins page. TShock's own `ServerPlugins` folder in
its install holds only TShock's plugins; the panel's are loaded from `tshock/plugins` in the
server's data (not from `tshock/plugins/disabled`). Copies an older agent put in `ServerPlugins`
are removed at the server's next start. A plugin file named like one of TShock's own
(`TShockAPI.dll`), put there by hand, now sits next to TShock's and the log says so.

**Why:** the install may be shared and read-only, so nothing is copied into it; TShock's
`-additionalplugins` option loads the plugins in a folder (not its subfolders).

**Status:** Measured with TShock 6.2.1 and a real plugin, Oct 2026.

### A new server waits for its game files

**Affects:** every game, the first server of a game, flavour and version.

**What you'll notice:** the server is created at once, but its page says its game files are being
downloaded (with the progress) and it has no container yet: its console, files and backups answer
only once they are ready. Pressing Start meanwhile waits for them, then starts it. If the download
fails, the page says why, and the next start (or "Try again") downloads again. A second server of
the same version uses the same files and is ready at once.

**Why:** the game is installed once, by an install job of its own, before any server mounts it
read-only (D12).

**Status:** Expected (the panel side is tested against the fake orchestrator; install jobs were
measured in the runtime side check).

### Servers from before shared installs move at their next start

**Affects:** every server created before the panel had shared installs.

**What you'll notice:** its "applies at next start" badge says it moves to shared game files. At
its next start through the panel, its container stops for a moment while its own game files are
copied (no download: a 7.2 GB Project Zomboid install took about 30–40 s, measured), then it
starts as usual on the shared files. Its own old copy stays on disk, listed on the panel settings
page, until the owner removes it. A server that holds the same version as another one ends up on
that one's files. If the move fails, it starts on its own files as before and tries again at its
next start. An admin of the server can also move a stopped server at once from its page.

**Why:** a server's own install volume is adopted by a local copy, never touched, so nothing is
lost if the move fails; worlds, settings and mods were never in it.

**Workaround:** none needed. Remove the old copies from the panel settings page once you are
happy with the moved servers.

**Status:** Expected (tested against the fake orchestrator; the copy time is measured).

### Servers that kept different builds may update twice after the move

**Affects:** Steam games and loaders with builds (Project Zomboid, Valheim, games added with a
manifest, Paper, Fabric), during the move to shared installs.

**What you'll notice:** two servers of the same version whose own installs held different builds
(one updated before the move, one not) end up on two installs. The next update of the older one
may download what changed again, then keeps only one copy.

**Why:** the panel can't tell which of two builds is newer before an install job reads them; the
update then finds the same files already shared and drops its copy.

**Status:** Expected.

### Release channels get installs of their own

**Affects:** Minecraft Paper (its build channel) and tModLoader (stable or preview releases).

**What you'll notice:** two servers of the same version that take different channels (one only
stable builds, one test builds too) use two installs, even when the newest build is the same for
both.

**Why:** an install made for test builds may hold one a stable-only server must not run, so the
panel never gives one channel's install to the other.

**Status:** Expected.

### A file check makes a new copy of the game files

**Affects:** every game, a server on shared game files.

**What you'll notice:** "Verify game files" makes a checked copy of the files its server runs from
(a local copy, then the check), and every server on the old files moves to the checked copy at its
next start (at once when stopped). The old copy stays until the owner removes it.

**Why:** the files are shared and read-only, so a check can't repair them in place.

**Status:** Expected.

### One server's update reaches every server on the same files

**Affects:** every game, servers sharing game files, whatever each one's update policy.

**What you'll notice:** when one server updates (its own policy, or someone pressing "Update now"),
every other server on the same files gets "applies at next start": a stopped one moves to the new
version at once, a running one at its next start (a scheduled restart included), each after a safety
backup. A server set to "only notify" moves too, at its next start; its policy only decides that it
isn't stopped for the update.

**Why:** the new version is downloaded once for every server on the old one (UPD-03); a server
staying behind would keep the old files on disk for itself.

**Workaround:** to keep a server on an older version, pin that version in its launch settings
(where the game has versions to pin); it then keeps an install of that version.

**Status:** Expected (tested against the fake orchestrator; seen on the real stack with a file
check, which works the same way).

### At most four game installs are made at once

**Affects:** every game.

**What you'll notice:** with four installs already being made, a fifth (a new server of yet another
version, an update) fails at once with the orchestrator's reason; its server's next start tries
again.

**Why:** the orchestrator runs at most four install jobs at a time, so a pile of downloads can't
starve the host.

**Status:** Expected.
