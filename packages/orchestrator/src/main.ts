import http from 'node:http';
import { loadConfig } from './config';
import { DockerBackend } from './docker-backend';
import { DockerClient } from './docker';
import { createOrchestratorServer } from './http';
import { listenOnSocket } from './listen';
import { resolveSelf } from './self';

// The orchestrator (D3, NFR-02, NFR-03): the only process with the Docker
// socket. No network; it listens on ORCH_SOCKET for the panel alone.
//   node orchestrator.mjs            serve
//   node orchestrator.mjs --health   exit 0 when it answers /v1/health (the image's HEALTHCHECK)

if (process.argv.includes('--health')) {
  const socket = process.env.ORCH_SOCKET ?? '';
  const req = http.get({ socketPath: socket, path: '/v1/health', headers: { authorization: `Bearer ${process.env.ORCH_TOKEN ?? ''}` }, timeout: 4000 }, (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => process.exit(1));
} else {
  const cfg = loadConfig();
  const docker = new DockerClient(cfg.docker);
  const { stack, imageTag } = await resolveSelf(docker, cfg.self);
  const backend = new DockerBackend({ docker, policy: cfg.policy, ctx: { stack, imageTag, publishAddr: cfg.publishAddr, allowFake: cfg.policy.allowFake } });
  const server = createOrchestratorServer({ backend, token: cfg.token, version: cfg.version, policy: cfg.policy, log: (l) => console.log(l) });
  await listenOnSocket(server, cfg.socket);
  console.log(`orchestrator ${cfg.version} for stack ${stack} (images :${imageTag}) listening on ${cfg.socket}`);

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      server.close();
      process.exit(0);
    });
  }
}
