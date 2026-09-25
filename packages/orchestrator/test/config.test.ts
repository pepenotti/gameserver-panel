import { describe, expect, it } from 'vitest';
import { startFakeDocker } from '../../../tools/fake-docker/fake-docker';
import { loadConfig } from '../src/config';
import { DockerClient } from '../src/docker';
import { imageTagOf, resolveSelf } from '../src/self';

const base = { ORCH_SOCKET: '/run/orch/orch.sock', ORCH_TOKEN: 't'.repeat(32), ORCH_HOST_PORTS: '30150-30199' };

describe('orchestrator configuration', () => {
  it('reads its own limits from the environment, with defaults', () => {
    const c = loadConfig({ ...base, ORCH_VERSION: 'x' });
    expect(c).toMatchObject({
      version: 'x',
      socket: '/run/orch/orch.sock',
      docker: { socketPath: '/var/run/docker.sock' },
      policy: { hostPorts: [[30150, 30199]], maxMemMb: 16384, maxServers: 10, allowFake: false },
      publishAddr: '0.0.0.0',
    });
    expect(c.self).not.toBe('');
    const d = loadConfig({ ...base, ORCH_DOCKER_URL: 'http://127.0.0.1:2375', ORCH_MAX_MEM_MB: '4096', ORCH_MAX_SERVERS: '4', ORCH_ALLOW_FAKE: '1', ORCH_PUBLISH_ADDR: '127.0.0.1', ORCH_SELF: 'abc' });
    expect(d).toMatchObject({ docker: { url: 'http://127.0.0.1:2375' }, policy: { maxMemMb: 4096, maxServers: 4, allowFake: true }, publishAddr: '127.0.0.1', self: 'abc' });
    expect(loadConfig({ ...base, ORCH_DOCKER_SOCKET: '/x/docker.sock' }).docker).toEqual({ socketPath: '/x/docker.sock' });
  });

  it('refuses to start without a socket, a real token or port ranges, or with odd limits', () => {
    for (const bad of [
      { ORCH_SOCKET: '' },
      { ORCH_TOKEN: 'short' },
      { ORCH_HOST_PORTS: '' },
      { ORCH_HOST_PORTS: '80-90' },
      { ORCH_ALLOW_FAKE: 'yes' },
      { ORCH_MAX_MEM_MB: '1e9' },
      { ORCH_MAX_MEM_MB: '64' },
      { ORCH_MAX_SERVERS: '0' },
      { ORCH_PUBLISH_ADDR: 'example.org' },
    ]) {
      expect(() => loadConfig({ ...base, ...bad }), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('who it is (its stack and image tag, from its own container)', () => {
  it('takes the tag of its image', () => {
    expect(imageTagOf('gsp/orchestrator:s1')).toBe('s1');
    expect(imageTagOf('registry.example:5000/gsp/orchestrator:local')).toBe('local');
    expect(imageTagOf('gsp/orchestrator')).toBeNull();
    expect(imageTagOf('registry.example:5000/gsp/orchestrator')).toBeNull();
    expect(imageTagOf('gsp/orchestrator@sha256:abc')).toBeNull();
  });

  it('reads its Compose project and tag, and refuses to run outside Compose', async () => {
    const fd = await startFakeDocker();
    try {
      const docker = new DockerClient({ url: fd.url });
      const me = fd.addContainer({ name: 'gsp-s1-orchestrator-1', image: 'gsp/orchestrator:s1', labels: { 'com.docker.compose.project': 'gsp-s1' } });
      expect(await resolveSelf(docker, me.Id.slice(0, 12))).toEqual({ stack: 'gsp-s1', imageTag: 's1' });
      await expect(resolveSelf(docker, 'nothere')).rejects.toThrow(/not known to Docker/);
      me.Config.Labels = {};
      await expect(resolveSelf(docker, me.Id)).rejects.toThrow(/compose.project/);
      me.Config.Labels = { 'com.docker.compose.project': 'gsp-s1' };
      me.Config.Image = 'gsp/orchestrator';
      await expect(resolveSelf(docker, me.Id)).rejects.toThrow(/no tag/);
    } finally {
      await fd.close();
    }
  });
});
