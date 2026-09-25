import { describe, expect, it } from 'vitest';
import { checkEnv, checkOrchestrator, checkPublished, dropsVolumes, parseDockerPs, parseEnvFile, parseNameList, parsePortList, planCompose, portConflicts, publishedPorts, serverCleanup, serverLabel, slotOf } from './stack-guard.mjs';

const good = { COMPOSE_PROJECT_NAME: 'gsp-s1', PANEL_TLS: 'internal', COMPOSE_PROFILES: '', PUBLISH_ADDR: '127.0.0.1' };

describe('env checks', () => {
  it('accepts a slot env written by worktree-env.mjs', () => {
    expect(checkEnv(good, [])).toEqual([]);
    expect(slotOf('gsp-s1')).toBe(1);
  });

  it('refuses project names outside gsp-s<digit>', () => {
    for (const name of ['zomboid', 'gameserver-panel', 'gsp-s10', 'gsp-s', 'GSP-S1x', '']) {
      expect(checkEnv({ ...good, COMPOSE_PROJECT_NAME: name }, []).join()).toMatch(/COMPOSE_PROJECT_NAME/);
    }
    expect(checkEnv({ ...good, COMPOSE_PROJECT_NAME: undefined as unknown as string }, []).join()).toMatch(/COMPOSE_PROJECT_NAME/);
  });

  it('refuses protected projects, public TLS, profiles and public publishing', () => {
    expect(checkEnv(good, ['other', 'gsp-s1']).join()).toMatch(/protected/);
    expect(checkEnv({ ...good, PANEL_TLS: 'duckdns' }, []).join()).toMatch(/PANEL_TLS/);
    expect(checkEnv({ ...good, COMPOSE_PROFILES: 'duckdns' }, []).join()).toMatch(/COMPOSE_PROFILES/);
    expect(checkEnv({ ...good, PUBLISH_ADDR: '0.0.0.0' }, []).join()).toMatch(/PUBLISH_ADDR/);
    const { PUBLISH_ADDR: _, ...noAddr } = good;
    expect(checkEnv(noAddr, []).join()).toMatch(/PUBLISH_ADDR/);
    expect(checkEnv({ ...good, COMPOSE_FILE: 'other.yaml' }, []).join()).toMatch(/COMPOSE_FILE/);
  });

  it('parses env files and the protected list', () => {
    const env = parseEnvFile('# c\nA=1\nB="two words"\nexport C=\'x\'\n  D = spaced \nnot a line\nA=3\nE=\n');
    expect(env).toEqual({ A: '3', B: 'two words', C: 'x', D: 'spaced', E: '' });
    expect(parseNameList('zomboid\n# comment\n\n  other  # trailing\n')).toEqual(['zomboid', 'other']);
  });
});

describe('published ports', () => {
  const config = {
    services: {
      caddy: { ports: [{ target: 30143, published: '30143', protocol: 'tcp', host_ip: '127.0.0.1' }] },
      pz: {
        ports: [
          { target: 30161, published: '30161', protocol: 'udp', host_ip: '127.0.0.1' },
          { target: 30162, published: 30162, protocol: 'udp', host_ip: '127.0.0.1' },
        ],
      },
      panel: {},
    },
  };

  it('reads them from the rendered config, including ranges', () => {
    expect(publishedPorts(config).map((p) => `${p.service}:${p.port}/${p.protocol}@${p.hostIp}`)).toEqual([
      'caddy:30143/tcp@127.0.0.1',
      'pz:30161/udp@127.0.0.1',
      'pz:30162/udp@127.0.0.1',
    ]);
    expect(publishedPorts({ services: { x: { ports: [{ published: '30150-30152', protocol: 'udp', host_ip: '127.0.0.1' }] } } }).map((p) => p.port)).toEqual([30150, 30151, 30152]);
    expect(checkPublished(publishedPorts(config), 1)).toEqual([]);
  });

  it('refuses ports on other addresses or outside the slot block', () => {
    const wide = { services: { caddy: { ports: [{ published: '30143', protocol: 'tcp', host_ip: '0.0.0.0' }] } } };
    expect(checkPublished(publishedPorts(wide), 1).join()).toMatch(/not 127\.0\.0\.1/);
    const noIp = { services: { caddy: { ports: [{ published: '30143', protocol: 'tcp' }] } } };
    expect(checkPublished(publishedPorts(noIp), 1).join()).toMatch(/every address/);
    const prod = { services: { caddy: { ports: [{ published: '8443', protocol: 'tcp', host_ip: '127.0.0.1' }] } } };
    expect(checkPublished(publishedPorts(prod), 1).join()).toMatch(/outside slot 1's block 30100-30199/);
    expect(checkPublished(publishedPorts(config), 2).length).toBe(3);
  });

  it('finds ports already published by containers of other projects', () => {
    const ps = parseDockerPs(
      [
        'prodstack\t0.0.0.0:16261-16262->16261-16262/udp, [::]:16261-16262->16261-16262/udp, 0.0.0.0:8443->8443/tcp',
        'gsp-s2\t127.0.0.1:30243->30243/tcp',
        '\t127.0.0.1:30161->30161/udp',
        'gsp-s1\t127.0.0.1:30143->30143/tcp, 8081/tcp',
        'db\t',
      ].join('\n'),
    );
    expect(ps[0]!.ports).toContainEqual({ port: 16262, protocol: 'udp' });
    expect(ps[3]!.ports).toEqual([{ port: 30143, protocol: 'tcp' }]);
    expect(ps[4]!.ports).toEqual([]);
    const ours = publishedPorts(config);
    // Our own running containers are fine; the unlabelled one holding 30161/udp is not.
    expect(portConflicts(ours, ps, 'gsp-s1')).toEqual(['30161/udp is already published by a container outside Compose']);
    expect(portConflicts(ours, ps.slice(0, 2), 'gsp-s1')).toEqual([]);
    // Same number, other protocol: no clash.
    expect(portConflicts(ours, parseDockerPs('x\t127.0.0.1:30161->30161/tcp'), 'gsp-s1')).toEqual([]);
    expect(portConflicts(ours, parseDockerPs('prodstack\t0.0.0.0:30143->443/tcp'), 'gsp-s1')).toEqual(['30143/tcp is already published by project prodstack']);
  });
});

describe("the orchestrator's game servers (NFR-03)", () => {
  const orchestrator = (over: Record<string, unknown> = {}, env: Record<string, string | null> = {}) => ({
    services: {
      orchestrator: { network_mode: 'none', environment: { ORCH_HOST_PORTS: '30150-30199', ORCH_PUBLISH_ADDR: '127.0.0.1', ...env }, ...over },
    },
  });

  it('accepts an orchestrator with no network that keeps its servers on 127.0.0.1 inside the slot game ports', () => {
    expect(checkOrchestrator(orchestrator(), 1)).toEqual([]);
    expect(checkOrchestrator(orchestrator({}, { ORCH_HOST_PORTS: '30150,30160-30170' }), 1)).toEqual([]);
    expect(checkOrchestrator({ services: {} }, 1)).toEqual([]);
  });

  it('refuses one with a network or ports of its own', () => {
    expect(checkOrchestrator(orchestrator({ network_mode: 'host' }), 1).join()).toMatch(/no network/);
    expect(checkOrchestrator(orchestrator({ network_mode: undefined }), 1).join()).toMatch(/default network/);
    expect(checkOrchestrator(orchestrator({ ports: [{ published: '30150' }] }), 1).join()).toMatch(/must not publish/);
  });

  it('refuses servers published on other addresses, or outside the slot game ports', () => {
    expect(checkOrchestrator(orchestrator({}, { ORCH_PUBLISH_ADDR: '' }), 1).join()).toMatch(/every address/);
    expect(checkOrchestrator(orchestrator({}, { ORCH_PUBLISH_ADDR: '0.0.0.0' }), 1).join()).toMatch(/0\.0\.0\.0, not 127/);
    expect(checkOrchestrator(orchestrator({}, { ORCH_HOST_PORTS: '30143' }), 1).join()).toMatch(/outside slot 1's game ports 30150-30199/);
    expect(checkOrchestrator(orchestrator({}, { ORCH_HOST_PORTS: '30150-30200' }), 1).join()).toMatch(/30150-30200 is outside/);
    expect(checkOrchestrator(orchestrator({}, { ORCH_HOST_PORTS: '16261-16299' }), 1)).toHaveLength(1);
    expect(checkOrchestrator(orchestrator(), 2)).toHaveLength(1);
    for (const bad of ['', 'x', '30199-30150', '30150-', null]) expect(checkOrchestrator(orchestrator({}, { ORCH_HOST_PORTS: bad }), 1).join(), String(bad)).toMatch(/not a list/);
  });

  it('parses port lists', () => {
    expect(parsePortList('30150-30199, 30100')).toEqual([
      [30150, 30199],
      [30100, 30100],
    ]);
    expect(parsePortList('a')).toBeNull();
  });

  it("removes this stack's game servers after down, and their volumes only when volumes go", () => {
    const found = { containers: ['c1', 'c2'], networks: ['n1'], volumes: ['gsp-s1-srv-pz-data'] };
    expect(serverLabel('gsp-s1')).toBe('label=gsp.stack=gsp-s1');
    expect(serverCleanup('gsp-s1', found, false)).toEqual([
      ['stop', 'c1', 'c2'],
      ['rm', 'c1', 'c2'],
      ['network', 'rm', 'n1'],
    ]);
    expect(serverCleanup('gsp-s1', found, true).at(-1)).toEqual(['volume', 'rm', 'gsp-s1-srv-pz-data']);
    expect(serverCleanup('gsp-s1', { containers: [], networks: [], volumes: [] }, true)).toEqual([]);
    // Nothing that looks like a flag or another argument gets through.
    expect(serverCleanup('gsp-s1', { containers: ['--all', 'c1'], networks: ['-f'], volumes: [] }, true)).toEqual([
      ['stop', 'c1'],
      ['rm', 'c1'],
    ]);
    expect(() => serverCleanup('zomboid', found, true)).toThrow();
    expect(dropsVolumes(['down', '-v'])).toBe(true);
    expect(dropsVolumes(['down', '--volumes', '--rmi', 'local'])).toBe(true);
    expect(dropsVolumes(['down'])).toBe(false);
  });
});

describe('compose arguments', () => {
  it('passes ordinary commands through', () => {
    expect(planCompose(['config'])).toEqual({ args: ['config'] });
    expect(planCompose(['up', '-d', '--build'])).toEqual({ args: ['up', '-d', '--build'] });
    expect(planCompose(['logs', '-f', 'panel'])).toEqual({ args: ['logs', '-f', 'panel'] });
    expect(planCompose(['down'])).toEqual({ args: ['down'] });
  });

  it('expands clean to a volume-dropping down for this project only', () => {
    expect(planCompose(['clean'])).toEqual({ args: ['down', '--volumes', '--rmi', 'local'] });
  });

  it('needs --yes-this-stack to drop volumes with down', () => {
    for (const flag of ['-v', '--volumes', '--volumes=true', '-tv']) expect(planCompose(['down', flag])).toHaveProperty('error');
    expect(planCompose(['down', '-v', '--yes-this-stack'])).toEqual({ args: ['down', '-v'] });
  });

  it('refuses flags that would pick another project, file, env, profile or address', () => {
    for (const args of [
      [],
      ['-p', 'zomboid', 'down'],
      ['--project-name=zomboid', 'ps'],
      ['up', '-p', 'zomboid'],
      ['ps', '--project-name', 'zomboid'],
      ['up', '--env-file', 'x.env'],
      ['up', '--profile', 'duckdns'],
      ['config', '-f', 'other.yaml'],
      ['config', '--file=other.yaml'],
      ['run', '--publish', '8443:8443', 'panel'],
      ['run', '-p8443:8443', 'panel'],
      ['down', '--rmi', 'all'],
      ['down', '--rmi=all'],
    ]) {
      expect(planCompose(args), args.join(' ')).toHaveProperty('error');
    }
  });
});
