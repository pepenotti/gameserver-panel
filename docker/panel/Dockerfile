# The web panel: API + built UI in one Node process. It listens on a unix
# socket in the panel-sock volume that only Caddy also mounts (PANEL_LISTEN,
# NFR-03), reaches the orchestrator over the orch-sock volume, and each
# server's agent on that server's network (the orchestrator joins the panel
# to it). It mounts no game volumes (D11).

FROM node:24-trixie-slim AS build
WORKDIR /src
# Explicit list, never `COPY . .`: nested worktrees and dot-directories in
# the checkout must not reach the image.
COPY package.json package-lock.json tsconfig.base.json VERSION ./
COPY packages/ packages/
COPY tools/ tools/
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build -w @gsp/web \
 && npm run build -w @gsp/panel \
 && cp VERSION packages/panel/dist/VERSION \
 && cp -r packages/web/dist packages/panel/dist/public

FROM node:24-trixie-slim
# tar + zstd for backups; tini to reap tar/zstd children.
# /run/panel is the mount point of the panel-sock volume: a fresh volume takes
# this directory's owner, so the panel (node) can create its socket there.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tar zstd tini ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/panel /backups /data /opt/pz /run/panel \
 && chown node:node /var/lib/panel /backups /data /opt/pz /run/panel
USER node
ENV NODE_ENV=production PANEL_DATA_DIR=/var/lib/panel PZ_DATA_DIR=/data PZ_INSTALL_DIR=/opt/pz BACKUP_DIR=/backups
COPY --from=build --chown=node:node /src/packages/panel/dist/ /app/
EXPOSE 8080
# On its socket when PANEL_LISTEN=unix:<path>, else on 127.0.0.1:8080.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "const l=process.env.PANEL_LISTEN||'';const t=l.startsWith('unix:')?{socketPath:l.slice(5)}:{host:'127.0.0.1',port:8080};require('http').get({...t,path:'/api/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/panel.mjs"]
