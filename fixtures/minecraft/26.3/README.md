# Minecraft Java 26.3 fixtures

Captured on 2026-09-25 during the M3 fact-finding (D5) from real servers:

| Loader | What ran |
|---|---|
| vanilla | Mojang's server jar for **26.3** (sha1 `33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c`) |
| paper | Paper **26.3 build 41** (channel ALPHA, the only one 26.3 had), plus one boot of **26.2 build 83** (channel STABLE) in `logs/first-boot-26.2-83-unpatched.log` |
| fabric | Fabric Loader **0.19.5** on 26.3, installed with the Fabric installer **1.1.2** (`logs/installer.log`); `logs/launcher-first-run-no-eula.log` is the one-file server launcher from Fabric's meta instead |

Every server ran on Eclipse Temurin **25.0.4+7** (`eclipse-temurin:25-jre`, amd64) in a
throwaway container shaped like the product's java containers: user 1000:1000, read-only
root, all capabilities dropped, a `/tmp` tmpfs, the working directory `/data` (a volume)
and the jars in `/opt/game` (another volume), started as
`java -Xms… -Xmx… -DbundlerRepoDir=/opt/game [-Dfabric.gameJarPath=/opt/game/server.jar] -jar /opt/game/<jar> nogui`.
The EULA was accepted on these test servers only, by the owner's leave, for testing.

`docs/verification/minecraft-26.3.md` says what each file shows.

## Layout (per loader)
- `api/`: the download APIs' answers, trimmed to a few entries and re-indented (Mojang's
  version manifest and version files, PaperMC's Fill v3, Fabric's meta). `vanilla/api/java-matrix.json`
  is derived: every release in the manifest with the Java major its version file declares.
  `vanilla/api/json-rpc-api-methods.json` lists the method names of the server's management
  protocol, from the server jar's own data generator.
- `logs/`: the game's stdout and stderr lines, as a non-TTY `docker run -i` delivered them
  (stderr lines interleave by arrival). `console-session.log` marks what was typed with `> `.
- `rcon/`: RCON sessions as JSON transcripts, in the format of `fixtures/pz/b42/rcon`:
  `t` (seconds since connecting), `dir`, then `kind` (`auth`, `cmd`, `sentinel`) and `id`/`body`
  for what was sent, `size`/`id`/`type`/`body` for each packet received. `kind: "bytes"` is one
  TCP read of `n` bytes (kept where the framing matters), `kind: "close"` the server closing the
  connection, and `sameWrite: true` a sentinel sent in the same TCP write as its command. The
  password is never recorded.
- `config/`: `server.properties.before` is the partial file written before the first boot
  (managed keys and probes), `.after` the file as the game left it after the runs (byte-exact),
  `.generated` and `eula.txt.generated` what the first start without `eula=true` wrote.
- `files/`: `ops.json`, `whitelist.json`, `banned-players.json`, `banned-ips.json`,
  `usercache.json` as the game wrote them after whitelist, op and ban commands (byte-exact
  content; the game writes no final newline).
- `tree/`: file lists (`type size path`) of the data and install folders; big folders
  (`libraries`, `versions`, `cache`, `.fabric`) are summed on one line.
- `paper/data/`: Paper's own config files as its first boot generated them.

## Scrubbing (NFR-09)
`node scripts/scrub-fixture.mjs` over every file (IPv4 addresses, which were only the Docker
gateway, became `192.0.2.x`; the RCON password and the generated `management-server-secret`
became `<redacted>`), then by hand: the kernel release in Paper's bootstrap line (the scrubber
had taken it for an address) became `<kernel release>`, bStats' random server id became a zero
UUID, and the crash report keeps only its header and exception (the system details describe the
test host's hardware).

Player names are the fact-finding's own test names (`gspff…`), used on offline-mode test servers
by a small test client; their UUIDs are the offline UUIDs derived from those names, not accounts.
Nothing here comes from a real player.
