import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';

const base = { AGENT_TOKEN: 'x'.repeat(40), PZ_ADMIN_PASSWORD: 'secret' };

describe('loadEnv', () => {
  it('keeps origins exact, dropping default ports the way browsers do', () => {
    const env = loadEnv({ ...base, PANEL_ORIGINS: 'https://panel.example.net:8443, https://play.example.org:443/,https://192.168.1.50:8443' });
    expect(env.origins).toEqual(['https://panel.example.net:8443', 'https://play.example.org', 'https://192.168.1.50:8443']);
  });

  it('refuses anything that is not a bare origin', () => {
    expect(() => loadEnv({ ...base, PANEL_ORIGINS: 'https://panel.example.net:8443/panel' })).toThrow(/exact origin/);
    expect(() => loadEnv({ ...base, PANEL_ORIGINS: 'https://user@panel.example.net:8443' })).toThrow(/exact origin/);
  });

  it('requires the secrets and a safe server name', () => {
    expect(() => loadEnv({ PZ_ADMIN_PASSWORD: 'x' })).toThrow(/AGENT_TOKEN/);
    expect(() => loadEnv({ ...base, AGENT_TOKEN: 'short' })).toThrow(/32/);
    expect(() => loadEnv({ ...base, PZ_SERVER_NAME: '../etc' })).toThrow(/PZ_SERVER_NAME/);
  });
});
