# Runtime image of the steam family (PRD §10): the agent plus steamcmd, for
# every game installed through Steam (Project Zomboid, Valheim, tModLoader,
# manifest games). The orchestrator runs one container per server from it,
# never Compose, as user node with a read-only root and the server's own
# volumes:
#   /data       world, configs, logs, the agent's state   <stack>-srv-<id>-data
#   /opt/game   the game install                         <stack>-srv-<id>-install
#   /home/node  steamcmd and its state                   <stack>-srv-<id>-steam (seeded from this image)
# The game adapter (GAME_ADAPTER) and its settings come from the server's spec.
#
# Targets:
#   runtime  gsp/steam       Valve's steamcmd (the default)
#   fake     gsp/steam-fake  fake games and a fake steamcmd, no download; the
#                            orchestrator runs it only with ORCH_ALLOW_FAKE=1
# The orchestrator runs gsp/steam[-fake]:<its own image tag>, so build them
# with the stack's IMAGE_TAG, through Compose's build-only services:
#   docker compose build steam steam-fake                (a host)
#   node scripts/stack.mjs build steam steam-fake        (a development worktree)
# The agent's file and archive routes need nothing beyond Node 24: tar is
# JavaScript, zstd is node:zlib, SQLite snapshots are node:sqlite.

FROM node:24-trixie-slim AS build
WORKDIR /src
# Explicit list, never `COPY . .`: nested worktrees and dot-directories in
# the checkout must not reach the image.
COPY package.json package-lock.json tsconfig.base.json VERSION ./
COPY packages/ packages/
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build -w @gsp/agent \
 && cp VERSION packages/agent/dist/VERSION

FROM node:24-trixie-slim AS base
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/node \
    GAME_INSTALL_DIR=/opt/game \
    GAME_DATA_DIR=/data
# steamcmd is 32-bit: it needs the multilib gcc/stdc++ runtimes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl lib32gcc-s1 lib32stdc++6 tini procps tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/game /data /app \
 && chown -R node:node /opt/game /data /home/node /app
COPY --from=build --chown=node:node /src/packages/agent/dist/ /app/
COPY --chown=node:node tools/agentctl.mjs /app/agentctl.mjs
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8081/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/agent.mjs"]

# The games' fakes, picked by GAME_ADAPTER (tools/fake-orchestrator/fake-game.mjs).
FROM base AS fake
COPY --chown=node:node tools/fake-orchestrator/fake-game.mjs /app/fake/fake-orchestrator/fake-game.mjs
COPY --chown=node:node tools/fake-pz/ /app/fake/fake-pz/
ENV STEAMCMD_COMMAND='["node","/app/fake/fake-orchestrator/fake-game.mjs","steamcmd"]' \
    GAME_START_COMMAND='["node","/app/fake/fake-orchestrator/fake-game.mjs","server"]'

# Valve's steamcmd, in HOME: the server's steam volume holds it, so it can
# update itself although the root is read-only.
FROM base AS runtime
ENV STEAMCMD_COMMAND='["/home/node/steamcmd/steamcmd.sh"]'
# Valve's tarball rather than Debian's package (which needs i386 + a licence prompt).
# Running it once bakes steamcmd's self-update into the image.
RUN mkdir -p /home/node/steamcmd /home/node/.steam/sdk64 \
 && curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar -xz -C /home/node/steamcmd \
 && (/home/node/steamcmd/steamcmd.sh +quit || true) \
 && ln -sf /home/node/steamcmd/linux64/steamclient.so /home/node/.steam/sdk64/steamclient.so
