// The fake orchestrator of the development loop (scripts/dev.mjs): the real
// orchestrator API and spec checks, with local agents and fake games in place
// of Docker containers.
//
//   node --import tsx tools/fake-orchestrator/main.ts
//
// Environment: ORCH_SOCKET, ORCH_TOKEN, ORCH_HOST_PORTS, ORCH_MAX_MEM_MB,
// ORCH_MAX_SERVERS, ORCH_ALLOW_FAKE as for the real one, plus
//   FAKE_ORCH_STATE_DIR      servers.json and each server's folders (default .tmp/dev/orch)
//   FAKE_ORCH_AGENT_PORTS    ports for the agents, e.g. 30102-30104
//   FAKE_ORCH_CONTROL_PORTS  ports for what would stay inside a container (RCON), e.g. 30111-30142
//   FAKE_ORCH_ARCH           the host's architecture it reports: amd64 or arm64 (default this machine's)
//   FAKE_ORCH_DOCKER         desktop: it reports Docker Desktop (players' addresses hidden); default engine
//   FAKE_ORCH_PLATFORM       windows, macos or linux (default this machine's)
// FAKE_* variables (FAKE_PZ_BOOT_MS…) reach the fake games, and GAME_MC_*_URL
// and GAME_TERRARIA_*_URL the agents (Minecraft's and Terraria's download
// services: tools/fake-minecraft/downloads.mjs and
// tools/fake-terraria/downloads.mjs in the dev loop).
import { createOrchestratorServer, listenOnSocket, loadConfig, parsePortRanges, type PortRange } from '@gsp/orchestrator';
import { agentEnvFrom, FakeBackend } from './backend';

const expand = (ranges: readonly PortRange[]) => ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
const need = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} must be set`);
  return v;
};

const cfg = loadConfig({ ORCH_ALLOW_FAKE: '1', ...process.env, ORCH_VERSION: 'fake' });
const fakeEnv = agentEnvFrom(process.env);
const oneOf = <T extends string>(key: string, values: readonly T[]): T | undefined => {
  const v = process.env[key];
  if (!v) return undefined;
  if (!(values as readonly string[]).includes(v)) throw new Error(`${key} must be one of ${values.join(', ')}`);
  return v as T;
};
const docker = oneOf('FAKE_ORCH_DOCKER', ['desktop', 'engine'] as const);
const platform = oneOf('FAKE_ORCH_PLATFORM', ['windows', 'macos', 'linux'] as const);
const host = {
  arch: oneOf('FAKE_ORCH_ARCH', ['amd64', 'arm64'] as const),
  traits: { ...(docker ? { docker, addressesVisible: docker === 'desktop' ? false : ('expected' as const) } : {}), ...(platform ? { platform } : {}) },
};
const backend = new FakeBackend({
  stateDir: process.env.FAKE_ORCH_STATE_DIR || '.tmp/dev/orch',
  policy: cfg.policy,
  agentPorts: expand(parsePortRanges(need('FAKE_ORCH_AGENT_PORTS'))),
  controlPorts: expand(parsePortRanges(need('FAKE_ORCH_CONTROL_PORTS'))),
  env: fakeEnv,
  log: (l) => console.log(l),
  host,
});
const server = createOrchestratorServer({ backend, token: cfg.token, version: cfg.version, policy: cfg.policy, log: (l) => console.log(l) });
await listenOnSocket(server, cfg.socket);
console.log(`fake orchestrator listening on ${cfg.socket} (host ports ${process.env.ORCH_HOST_PORTS})`);
await backend.init();

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    void backend.shutdown().then(() => process.exit(0));
  });
}
