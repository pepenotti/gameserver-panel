# Valheim 1.0.16 fixtures

Captured on 2026-10-01 during the M6 fact-finding (D5) from the real dedicated server: Steam app
**896660**, public branch **build 25527701**, which prints `Valheim version: l-1.0.16 (network
version 40)` (Unity 6000.0.75f1). `docs/verification/valheim-1.0.16.md` says what each file shows.

Every run used the product's `gsp/steam` image (built from this branch) in a throwaway container
shaped like the product's game containers: user 1000:1000, read-only root, all capabilities
dropped, `no-new-privileges`, a 256 MB `/tmp` tmpfs (exec), a 3 GiB memory limit (no swap), a
4096 pids limit, the install on its own volume mounted **read-only** at `/opt/game`, the data on
one at `/data`, steamcmd's HOME on a third at `/home/node`, ports published on 127.0.0.1 only.
The game ran as `/opt/game/valheim_server.x86_64` with `LD_LIBRARY_PATH=/opt/game/linux64` and
`SteamAppId=892970`, working directory `/opt/game`, under a small fact-finding harness that
timestamps lines, samples memory, watches folders and sends signals or stdin lines. Crossplay with
its libraries (`logs/crossplay.log`) ran in that image plus `libatomic1 libpulse0
libpulse-mainloop-glib0`.

## Layout
- `logs/`: the game's stdout and stderr as the harness read them, one line per line; lines the
  game wrote to stderr start with `[stderr] `, lines typed on its stdin with `> `. The first two
  lines (`# argv:`, `# cwd:`) are the harness's: the exact command line and working directory.
  The test passwords on those command lines are `<redacted>`; they were 10 characters in most
  runs, 3 characters in `private-short-password.log`, 4 in `fail-password-too-short-public.log`,
  a 5-character part of the server name in `fail-password-in-name.log`, and absent in
  `fail-no-password-public.log` and `private-no-password-other-port.log`. Nothing is cut: world
  generation's location lines (`… took more than 0.5 seconds to place …`, `Failed to place all …`)
  and Unity's warnings are as printed.
- `logs/logfile-stdout.log` and `logs/logfile-file.log`: one run with `-logfile`: what stdout
  still got, and the file the game wrote instead.
- `tree/`: file events from the harness's folder watch (`[+seconds] [fs] <event> <path> size=<n>`,
  `(gone)` when the file no longer existed; Node reports creations and renames as `rename`), with
  the game's lines around them; `sockets.txt`: the container's `/proc/net/udp{,6}` in several runs.
- `files/`: the three list files exactly as the first boot wrote them.
- `a2s/`: Steam server query answers (A2S_INFO, A2S_PLAYER, A2S_RULES) on the query port, decoded
  to JSON by the fact-finding's own client; `null` is no answer within 3 s.
- `steamcmd/`: `app_info_print 896660` (the app's block), the anonymous `app_update 896660
  validate` (progress lines cut to the first two and the last, with a `# … n more progress
  lines …` line), and the app manifest it left.

## Players
No client joined: Valheim's clients need a Steam (or PlayFab) account and the game. What only a
real client can show is listed in the verification document.

## Scrubbing (NFR-09)
By hand first, in the drafts: the host's free disk space in the `Available space …` lines
(`<free bytes>`, `<bytes>`), the PlayFab session's ids and connection string (`<hash>`,
`<entity id>`, `<network id>`, `<lobby id>`, `<connection string>`), the join code (`123456`), the
server's per-session Steam id (`90000000000000001`) and the test passwords on the command lines.
Then `node scripts/scrub-fixture.mjs` over everything with `--keep-ip 1.0.0.0` (the version A2S
reports): the host's public address became `192.0.2.1`, the anonymous Steam account id
`76561198000000001`. The scrubber read one line, `This is the serverIP used to register the
server: <address>`, as a version number ("…ver: ") and left the address alone; it was replaced by
hand before the scrubber ran. Everything was then read by hand.
