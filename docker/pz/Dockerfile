# The game server container: steamcmd + the PZ dedicated server (installed at
# runtime into a volume) + the Node agent that supervises it.
# Build from the repo root:  docker compose build pz

FROM node:24-trixie-slim AS build
WORKDIR /src
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build -w @pz/agent \
 && cp VERSION packages/agent/dist/VERSION

FROM node:24-trixie-slim
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/node \
    PZ_INSTALL_DIR=/opt/pz \
    PZ_DATA_DIR=/data \
    STEAMCMD_COMMAND='["/opt/steamcmd/steamcmd.sh"]'

# steamcmd is 32-bit: it needs the multilib gcc/stdc++ runtimes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl lib32gcc-s1 lib32stdc++6 tini procps tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/steamcmd /opt/pz /data /home/node/Steam /home/node/.steam/sdk64 /app \
 && chown -R node:node /opt/steamcmd /opt/pz /data /home/node /app

USER node
# Valve's tarball rather than Debian's package (which needs i386 + a licence prompt).
# Running it once bakes steamcmd's self-update into the image.
RUN curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar -xz -C /opt/steamcmd \
 && (/opt/steamcmd/steamcmd.sh +quit || true) \
 && ln -sf /opt/steamcmd/linux64/steamclient.so /home/node/.steam/sdk64/steamclient.so

COPY --from=build --chown=node:node /src/packages/agent/dist/ /app/
COPY --chown=node:node tools/agentctl.mjs /app/agentctl.mjs

EXPOSE 8081 16261/udp 16262/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8081/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/agent.mjs"]
