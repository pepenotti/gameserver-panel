# Terraria 1.4.5.8 fixtures

Captured on 2026-09-29 during the M5 fact-finding (D5) from real servers:

| Flavour | What ran |
|---|---|
| vanilla | Re-Logic's dedicated server **1.4.5.8** (`terraria-server-1458.zip`, sha256 `f513a4ac…d7a8334`), its `Linux/TerrariaServer.bin.x86_64` (MonoKickstart, Mono bundled) |
| tshock | **TShock 6.2.1** for Terraria 1.4.5.8 (`TShock-6.2.1-for-Terraria-1.4.5.8-linux-x64-Release.zip`, sha256 as GitHub's `digest`), on Microsoft's .NET runtime **9.0.20** |
| tmodloader | **tModLoader v2026.07.3.0** (the newest stable GitHub release; it is built on Terraria **1.4.4.9**, not 1.4.5.8), on .NET **8.0.31** |

Every server ran in a throwaway container shaped like the product's game containers: user
1000:1000, read-only root, all capabilities dropped, `no-new-privileges`, a 256 MB `/tmp` tmpfs
(exec), a 3 GiB memory limit, a pids limit, the data on one volume at `/data` and the install on
another (`/opt/game`, `/opt/tsh`, `/opt/tml`, mounted read-only unless a capture says otherwise),
ports published on 127.0.0.1 only. The images were `node:24-trixie-slim` plus the packages of the
`gsp/native` base stage, and for TShock and tModLoader Microsoft's .NET 9 and 8 runtimes copied from
`mcr.microsoft.com/dotnet/runtime:{9.0,8.0}` (and `libicu76`, where a capture doesn't say it was
left out). `docs/verification/terraria-1.4.5.8.md` says what each file shows.

## Layout (per flavour)
- `logs/`: the game's stdout and stderr lines as a non-TTY `docker run -i` delivered them (stderr
  interleaves by arrival). What was typed on stdin is marked `> `. The server prints its console
  prompt `: ` without a newline, so the next line often starts with `: `, and a lone `: ` line is
  a prompt that nothing followed. Vanilla starts with two byte-order marks (U+FEFF) on stdout and
  on stderr. World generation, loading and saving print a progress line per percent (30 000 lines
  for a small world): runs of those are cut to their first two and last line, with a `# … n more
  progress lines …` line saying how many were dropped. Lines `# client: …` are the fact-finding's
  test client (below), not the game.
- `console/`: console sessions as JSON transcripts, `[{ t, dir, text, partial? }]`: `t` seconds
  since the first line, `dir` `in` (typed), `out`, `err`, `client` (the test client) or `exit`;
  `partial` marks a prompt printed without a newline. Progress lines are left out.
- `rest/` (TShock): REST exchanges `[{ t, ms, method, path, status, headers, body }]`; the token
  is never recorded (`<token>`), stack traces are cut to three frames.
- `config/` (TShock): files the first boot generated (`*.generated`).
- `files/`: other files the games wrote (ban list, favourites, TShock's `ServerLog.txt` and its own
  log, tModLoader's `enabled.json`, Workshop metadata, the head of tModLoader's `server.log`).
  `vanilla/files/serverconfig.txt` is the fact-finding's own test config, not a shipped file.
- `tree/`: file lists (`type size [mode] path`) of install and data folders, and the order of the
  file events of a vanilla save (`inotifywait`).
- `api/`: the download services' answers, trimmed: terraria.org's version-name API and download
  headers, GitHub's release lists (bodies cut to their first line), GitHub's rate-limit headers.
- `steamcmd/` (tModLoader): steamcmd's anonymous `app_update 1281930`, `workshop_download_item
  1281930 <id>` and the trimmed `app_info_print 1281930`.

## Players
No real client was used. Joins, leaves, kicks and bans were driven by a small test client written
for the fact-finding (network release 326, made-up names `gspff…`, random UUIDs). It speaks only
the connection handshake; what only a real client shows is listed in the verification document.
It never joined tModLoader (its handshake differs).

## Scrubbing (NFR-09)
By hand first: TShock's first-run setup code (`/setup <redacted>`), the test host's kernel release
(`<kernel release>`), the container's hostname and the host's CPU and RAM figures in tModLoader's
logs, and the fact-finding's own test password typed on the console. Then
`node scripts/scrub-fixture.mjs` over everything (with `--keep-ip` for version numbers such as
`6.2.1.0` and the private ranges TShock's `whitelist.txt` names): the only addresses were Docker's
gateway (every client connects from it through the published port), now `192.0.2.1`; steamcmd's
anonymous account id became `76561198000000001`. Two over-matches of the scrubber were undone by
hand: the container's HOME `/home/node` in .NET's bundle error, and TShock's upstream CI path in
REST stack traces (`<upstream CI build dir>`).

## Added by the mods and plugins check (M5, MOD-06)
`tshock/logs/boot-with-plugin.log`: TShock 6.2.1's own output when it started with a third-party
plugin (Bagger v1.3.1, from its GitHub release) that the product's agent had downloaded and
copied into `ServerPlugins`, in the product's `gsp/native` image; the world generation's phase
names and blank lines are cut to one note line. Scrubbed with `scripts/scrub-fixture.mjs`
(`--keep-ip 6.2.1.0,2.1.0.0`), which changed nothing, and read by hand.
