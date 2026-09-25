# Runtime image of the java family (PRD §10): the agent plus the Java
# runtimes Minecraft Java servers need. The orchestrator runs one container
# per server from it, never Compose, as user node (1000:1000) with a
# read-only root and the server's own volumes:
#   /data       world, configs, logs, the agent's state   <stack>-srv-<id>-data
#   /opt/game   the game install (server jar, loader)    <stack>-srv-<id>-install
# plus a /tmp tmpfs. Nothing else is written: the image needs no writable
# HOME, and the agent downloads the game into /opt/game itself.
# The game adapter (GAME_ADAPTER) and its settings come from the server's spec.
#
# Targets:
#   runtime  gsp/java       the Java runtimes (the default)
#   fake     gsp/java-fake  fake games, no Java and no download; the
#                           orchestrator runs it only with ORCH_ALLOW_FAKE=1
# The orchestrator runs gsp/java[-fake]:<its own image tag>, so build them
# with the stack's IMAGE_TAG, through Compose's build-only services:
#   docker compose build java java-fake                  (a host)
#   node scripts/stack.mjs build java java-fake          (a development worktree)

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
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini procps tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/game /data /app \
 && chown -R node:node /opt/game /data /app
COPY --from=build --chown=node:node /src/packages/agent/dist/ /app/
COPY --chown=node:node tools/agentctl.mjs /app/agentctl.mjs
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8081/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/agent.mjs"]

# The games' fakes, picked by GAME_ADAPTER (tools/fake-orchestrator/fake-game.mjs).
# TODO(M3 fact-finding): copy the Minecraft fake here once it exists
# (tools/fake-minecraft/, next to tools/fake-pz/ in docker/steam).
FROM base AS fake
COPY --chown=node:node tools/fake-orchestrator/fake-game.mjs /app/fake/fake-orchestrator/fake-game.mjs
ENV GAME_START_COMMAND='["node","/app/fake/fake-orchestrator/fake-game.mjs","server"]'

# ---------------------------------------------------------------------------
# The Java runtimes. Each Minecraft version needs a particular Java, so the
# image holds the ones the supported versions need, side by side (e.g.
# /opt/java/<major>), and the Minecraft adapter picks one per server.
# TODO(M3 fact-finding): choose the Eclipse Temurin JRE majors from the
# versions the fact-finding pins, and install each here, for example
#   COPY --from=eclipse-temurin:<major>-jre /opt/java/openjdk /opt/java/<major>
# (both architectures, amd64 and arm64: HST-05). None is chosen yet, so this
# stage adds nothing.
# ---------------------------------------------------------------------------
FROM base AS jre

FROM jre AS runtime
