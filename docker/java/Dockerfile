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

# The games' fakes, picked by GAME_ADAPTER (tools/fake-orchestrator/fake-game.mjs):
# the fake Minecraft server stands in for `java` itself (installer steps
# included), so the adapter's own argument lists run unchanged.
FROM base AS fake
COPY --chown=node:node tools/fake-orchestrator/fake-game.mjs /app/fake/fake-orchestrator/fake-game.mjs
COPY --chown=node:node tools/fake-minecraft/ /app/fake/fake-minecraft/
ENV GAME_START_COMMAND='["node","/app/fake/fake-orchestrator/fake-game.mjs","server"]'

# ---------------------------------------------------------------------------
# The Java runtimes (PRD §10). Each Minecraft version declares a Java major;
# the adapter runs it on /opt/java/<major>/bin/java, and on 17 for 1.16.5
# and 1.17.x (they declare 8 and 16; measured to run on 17). Temurin 25, 21
# and 17 cover Minecraft 1.16.5 and newer (Q11), and each is published for
# amd64 and arm64 (HST-05). They are read-only here; the game writes only
# /data, /opt/game and /tmp.
# ---------------------------------------------------------------------------
FROM base AS jre
COPY --from=eclipse-temurin:25-jre /opt/java/openjdk /opt/java/25
COPY --from=eclipse-temurin:21-jre /opt/java/openjdk /opt/java/21
COPY --from=eclipse-temurin:17-jre /opt/java/openjdk /opt/java/17

FROM jre AS runtime
