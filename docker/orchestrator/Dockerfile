# The orchestrator (D3, NFR-02): the only container with the Docker socket.
# It creates, starts, stops and removes the game server containers from the
# panel's specs and nothing else. It has no network (compose: network_mode
# none) and listens on a unix socket in the orch-sock volume, which only the
# panel also mounts (NFR-03).
#
# It runs as root without any capability (compose: user 0:0, cap_drop ALL,
# no-new-privileges, read-only root). The Docker socket belongs to root on
# Docker Desktop, and to root and a docker group whose id differs from host to
# host on Linux; root without capabilities can use a socket it owns and
# nothing more, the same on every host (HST-05).
#
# Build from the repo root:  docker compose build orchestrator

FROM node:24-trixie-slim AS build
WORKDIR /src
# Explicit list, never `COPY . .`: nested worktrees and dot-directories in
# the checkout must not reach the image.
COPY package.json package-lock.json tsconfig.base.json VERSION ./
COPY packages/ packages/
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build -w @gsp/orchestrator \
 && cp VERSION packages/orchestrator/dist/VERSION

FROM node:24-trixie-slim
# The mount point of the orch-sock volume.
RUN mkdir -p /run/orch
COPY --from=build /src/packages/orchestrator/dist/ /app/
ENV NODE_ENV=production ORCH_SOCKET=/run/orch/orch.sock
USER root
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "/app/orchestrator.mjs", "--health"]
CMD ["node", "/app/orchestrator.mjs"]
