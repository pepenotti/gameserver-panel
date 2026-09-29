# Runtime image of the native family (PRD §10): the agent on a slim Debian
# base, for game servers that ship as their own binaries: vanilla Terraria
# (an x86-64 build with Mono inside, needing only glibc) and TShock (a .NET 9
# single-file app host, needing Microsoft's .NET 9 runtime and ICU). The
# orchestrator runs one container per server from it, never Compose, as user
# node (1000:1000) with a read-only root and the server's own volumes:
#   /data       world, configs, logs, the agent's state   <stack>-srv-<id>-data
#   /opt/game   the game install                         <stack>-srv-<id>-install
# plus a /tmp tmpfs. Nothing else is written: the image needs no writable
# HOME (TShock unpacks its bundle into /tmp, DOTNET_BUNDLE_EXTRACT_BASE_DIR
# from the adapter), and the agent downloads the game into /opt/game itself.
# The game adapter (GAME_ADAPTER) and its settings come from the server's spec.
#
# Targets:
#   runtime  gsp/native       the plain base (the default)
#   fake     gsp/native-fake  fake games, no download; the orchestrator runs
#                             it only with ORCH_ALLOW_FAKE=1
# The orchestrator runs gsp/native[-fake]:<its own image tag>, so build them
# with the stack's IMAGE_TAG, through Compose's build-only services:
#   docker compose build native native-fake              (a host)
#   node scripts/stack.mjs build native native-fake      (a development worktree)

# Microsoft's .NET 9 runtime, copied whole into the base below (TShock 6: app host 9.x, tfm net9.0).
FROM mcr.microsoft.com/dotnet/runtime:9.0 AS dotnet9

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
    GAME_DATA_DIR=/data \
    DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1
# libicu: .NET's globalization (without it TShock stops with "Couldn't find a
# valid ICU package", as measured). Vanilla Terraria needs nothing more.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini procps tzdata libicu76 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/game /data /app \
 && chown -R node:node /opt/game /data /app
# TShock's app host finds the runtime through DOTNET_ROOT.
COPY --from=dotnet9 /usr/share/dotnet /usr/share/dotnet
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
COPY --chown=node:node tools/fake-terraria/ /app/fake/fake-terraria/
ENV GAME_START_COMMAND='["node","/app/fake/fake-orchestrator/fake-game.mjs","server"]'

FROM base AS runtime
