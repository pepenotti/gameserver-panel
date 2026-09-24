# The web panel: API + built UI in one Node process. Talks to the pz agent
# over the backend network; never exposed directly (Caddy fronts it).

FROM node:24-trixie-slim AS build
WORKDIR /src
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build -w @pz/web \
 && npm run build -w @pz/panel \
 && cp VERSION packages/panel/dist/VERSION \
 && cp -r packages/web/dist packages/panel/dist/public

FROM node:24-trixie-slim
# tar + zstd for backups; tini to reap tar/zstd children.
# /data and /opt/pz are volumes shared with the pz container: whichever
# container mounts an empty volume first sets its owner, so node here too.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tar zstd tini ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/panel /backups /data /opt/pz \
 && chown node:node /var/lib/panel /backups /data /opt/pz
USER node
ENV NODE_ENV=production PANEL_DATA_DIR=/var/lib/panel PZ_DATA_DIR=/data PZ_INSTALL_DIR=/opt/pz BACKUP_DIR=/backups
COPY --from=build --chown=node:node /src/packages/panel/dist/ /app/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/panel.mjs"]
