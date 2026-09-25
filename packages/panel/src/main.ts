import { buildApp } from './app';
import { bootstrapOwner } from './auth/bootstrap';
import { openDb } from './db/db';
import { loadEnv } from './env';
import { listenOn } from './listen';
import { createPanelDeps } from './wiring';

const env = loadEnv();
const db = openDb(env.dataDir);
const deps = createPanelDeps({ env, db });

// What only a running panel does: timers, and each server's agent stream.
deps.hostJobs.start();
await bootstrapOwner(deps);
setInterval(() => deps.sessions.purgeExpired(), 3_600_000).unref();

const app = await buildApp(deps, { logger: true });
await listenOn(app, env.listen);

// Containers back in line with the servers table (SRV-06), without holding up the API.
void deps.servers.start().then((r) => {
  if (r.failed.length || r.orphans.length) app.log.warn({ reconcile: r }, 'servers not reconciled yet; retrying the failed ones');
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    deps.servers.stop();
    deps.hostJobs.stop();
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
