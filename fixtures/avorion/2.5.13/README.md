# Avorion 2.5.13 fixtures

Captured on 2026-10-01 during the M6 fact-finding (D5) from the real Avorion dedicated server:
Steam app **565060**, public branch **build 22295362**, which prints `Avorion server 2.5.13
0417ab29738c` (publicly `2.5.13.44140`). Avorion is the "second Steam game" measured for the
manifest-only path (PRD M6); `docs/verification/avorion-2.5.13.md` says what each file shows and
why it was chosen.

Every run used the product's `gsp/steam` image (built from this branch, nothing added) in a
throwaway container shaped like the product's game containers: user 1000:1000, read-only root,
all capabilities dropped, `no-new-privileges`, a 256 MB `/tmp` tmpfs (exec), a 3 GiB memory limit
(no swap), a 4096 pids limit, the install on its own volume mounted **read-only** at `/opt/game`,
the data on one at `/data`, steamcmd's HOME on a third at `/home/node`, ports published on
127.0.0.1 only. The game ran as `/opt/game/bin/AvorionServer` with
`LD_LIBRARY_PATH=/opt/game/linux64`, working directory `/opt/game` (except
`fail-wrong-working-directory.log`), under the same fact-finding harness as Valheim's.

## Layout
- `logs/`: stdout and stderr as the harness read them; stderr lines start with `[stderr] `, lines
  typed on stdin with `> `; the first two lines (`# argv:`, `# cwd:`) are the harness's. Nothing
  is cut. `help.txt` is `AvorionServer --help`.
- `config/`: the galaxy's `server.ini` and `admin.xml` after the first boot, and `server.ini`
  after the later runs (their command-line values written back, an edit made while stopped kept).
  The game's own commented copy (`server.ini - readme.txt`) is not included; the verification
  document describes it.
- `tree/`: file events from the harness's folder watch (see the Valheim fixtures' README for the
  format) around saves, stops and an autosave; `ini-edit-while-running.txt` summarises what was
  left of `server.ini` after edits made while running and while stopped.
- `a2s/listed.json`: the Steam query answers on the Steam query port with `--listed true`.
- `steamcmd/`: `app_info_print 565060` (the app's block), the anonymous `app_update 565060
  validate` (progress cut as in the Valheim fixtures), the first try on a fresh steamcmd that
  failed with `Missing configuration`, and the app manifest.

## Players
No client joined (Avorion's clients need a Steam account that owns the game). What only a real
client can show is listed in the verification document.

## Scrubbing (NFR-09)
By hand first, in the drafts: the host's CPU model and memory size in the boot banner
(`<host CPU>`, `<host RAM>`) and the server's per-session Steam id (`90000000000000001`). Then
`node scripts/scrub-fixture.mjs` over everything with `--keep-ip 1.0.0.0`: the anonymous Steam
account id became `76561198000000001`. It also turned the placeholder `arg` after `--rcon-password`
in `help.txt` into `<redacted>`; that file was put back as captured (it holds no secret). The
address in `/banip 192.0.2.77` was a documentation address to begin with. Everything was then
read by hand.
