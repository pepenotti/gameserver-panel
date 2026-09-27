# Minecraft Java 1.16.5 fixtures

Captured on 2026-09-27 during the M3 runtime adapter check (`docs/verification/minecraft-26.3.md`,
"Runtime adapter check"): the oldest version the panel offers (Q11), which declares Java 8,
installed and run by the Minecraft adapter itself on Temurin **17.0.20** in the `gsp/java` image,
as a hardened container (user 1000:1000, read-only root, all capabilities dropped, a `/tmp`
tmpfs, 3 GiB, `/data` and `/opt/game` on volumes).

- `vanilla/logs/first-boot.log`: the game's console lines of a first boot as the agent read
  them (its event buffer; the JVM's first lines before the buffer's start are not in it), up to
  the RCON client the agent opened.
- `vanilla/tree/data-running.txt`: the data root while running (`type size path`), without the
  agent's own folder. The world is the pre-26.x layout: `world/region`, `world/DIM-1`,
  `world/DIM1`, `world/playerdata`.

The EULA was accepted on this throwaway test server only, by the owner's leave, for testing.
Scrubbed with `node scripts/scrub-fixture.mjs` (it changed nothing) and read by hand.
