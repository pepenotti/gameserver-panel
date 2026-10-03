# Shared installs fixtures

Captured on 2026-10-03 during the M7-0 fact-finding for shared installs (HST-09, D12; D5: measured,
not guessed). `docs/verification/shared-installs.md` says what each file shows and how it was
measured. Builds: Project Zomboid build 25485538 (42.21.0), Valheim build 25527701 (1.0.16),
Avorion build 22295362 (2.5.13) and branch `previous` build 21146556 (2.5.11), Minecraft 26.3
(vanilla; Fabric Loader 0.19.5) and Paper 26.2 build 129, Terraria 1.4.5.8, TShock v6.2.1,
tModLoader v2026.07.3.0.

Every run used the product's runtime images built from this branch (`gsp/steam`, `gsp/java`,
`gsp/native`) with the product's agent, in containers hardened as the orchestrator makes them
(user 1000:1000, read-only root, a 256 MB `/tmp` tmpfs, all capabilities dropped,
`no-new-privileges`, a memory limit, named volumes only, no published ports). An **install job**
filled an install volume read-write; **runs** mounted it read-only (or read-write, to see what a
game writes) at `/opt/game`, with the server's data at `/data` and, for the steam image, its HOME
at `/home/node`.

## Layout
- `trees/<game>.txt`: the install volume after its install job, to a depth that shows its shape
  (`d` folders with the bytes and the number of files under them, `f` files with their size).
- `rw-diff/<game>.txt`: what a run with the install mounted read-write created, changed or deleted
  in it, from listings with every file's SHA-256 before and after. `unchanged.txt` holds the
  summary lines of the games whose runs changed nothing; `minecraft-warmup.txt` is the install
  job's warm-up instead of a run; `project-zomboid-workshop.txt` is a `find -newermt` listing
  (type, size, path) after a start with one Workshop mod, the mod's own files cut after 12.
- `logs/`: the agent's event stream for a run (`[out]` and `[err]` are the game's stdout and
  stderr, `[agent]` the agent's own lines, `!!` its alerts, `== state` its state changes), cut to
  the lines that show something; a `# … n lines cut …` line marks every cut. The
  `terraria-tshock-*` logs (other than `-agent-readonly`) are TShock started by hand with the
  agent's command line (`# argv:`, `# cwd:` first), keeping only its plugin lines and the result.
  `minecraft-warmup.log` is the warm-up's own output.
- `steamcmd/`: `validate` on a read-only install, a branch switch with and without `-beta`
  (`branch-switch.txt`: the result lines and the app manifest's `buildid`, `BytesToDownload`,
  `BetaKey`), every file's inode before and after an update run on a copy (`update-inodes.txt`),
  and the time of local copies.
- `home/<game>-job.txt`: steamcmd's HOME before and after an install job (the same comparison as
  `rw-diff/`); `home/<game>-run.txt`: the files a run wrote in its HOME.
- `markers/`: what identifies each install, as the job left it: Steam's app manifests
  (`appmanifest_<app>.acf`) and the agent's markers (`.gsp-install.json`).
- `api/file-api-symlink.txt`: the agent's file API (D11) asked about a symlink in the install.

## Scrubbing
Every file went through `scripts/scrub-fixture.mjs` (`--keep-ip 1.4.5.8`: Terraria's version
looks like an address) and was read before it was committed. It replaced the one Steam ID a
run printed with `76561198000000001`.
Before that, the fact-finding replaced the Project Zomboid admin password on the agent's start
lines with `<redacted>` (the agent itself already prints the game's own `-adminpassword` echo
redacted), a Steam account folder number in a HOME path with `<account>`, and a container's
own name in the Minecraft warm-up's log with `<container>`. No player, host, address or path of
the machine appears: the paths are the containers' own (`/opt/game`, `/data`, `/home/node`).
