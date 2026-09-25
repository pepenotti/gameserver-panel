import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fillEnv } from './env-template.mjs';
import { checkEnv, parseEnvFile } from './stack-guard.mjs';
import { devEnvText, devHost, envConflict, overlapping, parseExcludedRanges, slotOverrides } from './worktree.mjs';

const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');

describe('slot env', () => {
  it('keeps slot 1 on 127.0.0.1 inside 30100-30199 under its own names', () => {
    const o = slotOverrides(1);
    expect(o).toMatchObject({
      COMPOSE_PROJECT_NAME: 'gsp-s1',
      IMAGE_TAG: 's1',
      PUBLISH_ADDR: '127.0.0.1',
      PANEL_TLS: 'internal',
      COMPOSE_PROFILES: '',
      PANEL_HOST: 'wt1.localhost',
      LAN_IP: '127.0.0.1',
      PANEL_PORT: '30143',
      PZ_GAME_PORT: '30161',
      PZ_UDP_PORT: '30162',
      BACKUP_DIR: './.tmp/backups',
      // The orchestrator's game servers stay in the slot's game ports, and may run fake images.
      ORCH_HOST_PORTS: '30150-30199',
      ORCH_ALLOW_FAKE: '1',
      SERVER_IMAGE_VARIANT: 'fake',
      ORCH_MAX_SERVERS: '4',
      ORCH_MAX_MEM_MB: '6144',
    });
    expect(devHost(0)).toBe('wt0.localhost');
    expect(slotOverrides(0).PANEL_HOST).toBe('wt0.localhost');
    expect(slotOverrides(9).ORCH_HOST_PORTS).toBe('30950-30999');
  });

  it('writes a .env that stack.mjs accepts, with fresh secrets and no DDNS credentials', () => {
    const a = parseEnvFile(fillEnv(example, '', { overrides: slotOverrides(3) }).text);
    const b = parseEnvFile(fillEnv(example, '', { overrides: slotOverrides(3) }).text);
    expect(checkEnv(a, [])).toEqual([]);
    expect(a.PANEL_PORT).toBe('30343');
    expect(a.AGENT_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(a.AGENT_TOKEN).not.toBe(b.AGENT_TOKEN);
    expect(a.ORCH_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(a.ORCH_TOKEN).not.toBe(a.AGENT_TOKEN);
    expect(a.ORCH_TOKEN).not.toBe(b.ORCH_TOKEN);
    expect(a.ORCH_HOST_PORTS).toBe('30350-30399');
    expect(a.ORCH_ALLOW_FAKE).toBe('1');
    expect(a.PANEL_OWNER_PASSWORD).not.toBe('');
    expect(a.DUCKDNS_TOKEN).toBe('');
    expect(a.NOIP_PASSWORD).toBe('');
  });

  it('refuses to replace a .env of another slot or of a real deployment', () => {
    expect(envConflict('A=1\nCOMPOSE_PROJECT_NAME=gsp-s2\n', 2)).toBeUndefined();
    expect(envConflict('COMPOSE_PROJECT_NAME=gsp-s2\n', 1)).toMatch(/gsp-s2/);
    expect(envConflict('AGENT_TOKEN=abc\nPANEL_HOST=yourname.ddns.net\n', 1)).toMatch(/not written for a worktree slot/);
  });

  it('gives the dev loop its block ports', () => {
    const dev = parseEnvFile(devEnvText(1));
    expect(dev).toEqual({
      DEV_HOST: 'wt1.localhost',
      DEV_PANEL_PORT: '30100',
      DEV_AGENT_PORT: '30101',
      DEV_WEB_PORT: '30105',
      DEV_RCON_PORT: '30110',
      DEV_ORCH_AGENT_PORTS: '30102-30104',
      DEV_ORCH_CONTROL_PORTS: '30111-30142',
      DEV_ORCH_HOST_PORTS: '30150-30199',
      DEV_STATE_DIR: '.tmp/dev',
    });
  });

  it('keeps a production .env generating the orchestrator token and refusing fake images', () => {
    const prod = parseEnvFile(fillEnv(example, '').text);
    expect(prod.ORCH_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(prod.ORCH_ALLOW_FAKE).toBe('0');
    expect(prod.SERVER_IMAGE_VARIANT).toBe('');
    expect(prod.ORCH_HOST_PORTS).toMatch(/^\d+(-\d+)?(,\d+(-\d+)?)*$/);
    expect(prod).not.toHaveProperty('PZ_MEM_LIMIT');
  });
});

describe('fillEnv', () => {
  const ex = '# c\nA=\nAGENT_TOKEN=\nB=keep\n';

  it('generates empty secrets and keeps existing values (init-env)', () => {
    const { text, generated } = fillEnv(ex, 'B=mine\nEXTRA=1\n');
    expect(generated).toEqual(['AGENT_TOKEN']);
    expect(text).toMatch(/^# c\nA=\nAGENT_TOKEN=[0-9a-f]{64}\nB=mine\nEXTRA=1\n$/);
  });

  it('applies overrides and appends unknown ones under a comment', () => {
    const { text } = fillEnv(ex, '', { overrides: { A: 'x', NEW: 'y' }, extrasComment: 'slot' });
    expect(text).toMatch(/^# c\nA=x\nAGENT_TOKEN=[0-9a-f]{64}\nB=keep\n\n# slot\nNEW=y\n$/);
  });
});

describe('Windows excluded port ranges', () => {
  const netsh = `
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      5357        5357
     30150       30249
     50000       50059     *

* - Administered port exclusions.
`;

  it('parses netsh output and finds overlaps with a block', () => {
    const ranges = parseExcludedRanges(netsh);
    expect(ranges).toEqual([
      [5357, 5357],
      [30150, 30249],
      [50000, 50059],
    ]);
    expect(overlapping(ranges, 30100, 30199)).toEqual([[30150, 30249]]);
    expect(overlapping(ranges, 30300, 30399)).toEqual([]);
  });
});
