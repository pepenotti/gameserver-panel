import { Agent } from './agent';
import { loadConfig } from './config';
import { EventHub } from './events';
import { createAgentServer } from './http';
import { StateStore } from './state-store';

const cfg = loadConfig();
const hub = new EventHub(cfg.logBufferLines + 500);
const store = new StateStore(cfg.stateDir);
const agent = new Agent(cfg, store, hub);
const server = createAgentServer(agent, hub, cfg.token);

server.listen(cfg.port, cfg.host, () => {
  console.log(`pz agent ${cfg.version} listening on ${cfg.host}:${cfg.port}`);
  void agent.init();
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping the game server cleanly…`);
  // Keep the desired state so the game comes back when the container does.
  await agent.shutdown();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
