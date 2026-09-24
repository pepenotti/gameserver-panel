import { AgentClient } from './agent/client';
import { buildApp } from './app';
import { bootstrapOwner } from './auth/bootstrap';
import { openDb } from './db/db';
import { loadEnv } from './env';
import { createPanelDeps } from './wiring';

const env = loadEnv();
const db = openDb(env.dataDir);
const agent = new AgentClient(env.agentUrl, env.agentToken);
const deps = createPanelDeps({ env, db, agent, feed: agent });

// What only a running panel does: timers and the agent's event stream.
deps.scheduler.reload();
await bootstrapOwner(deps);
agent.startStream();
setInterval(() => deps.sessions.purgeExpired(), 3_600_000).unref();

const app = await buildApp(deps, { logger: true });
await app.listen({ host: env.host, port: env.port });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    agent.stopStream();
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
