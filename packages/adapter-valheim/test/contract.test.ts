// The Valheim skeleton passes the adapter contract suites as it is (D4),
// and launches nothing yet (D5: measured, not guessed).
import { describe, expect, it } from 'vitest';
import { panelAdapterConfigSuite } from '@gsp/adapter-api/testing/panel-suite-config';
import { panelAdapterCoreSuite } from '@gsp/adapter-api/testing/panel-suite-core';
import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import type { RuntimeCtx } from '@gsp/adapter-api';
import { valheimPanelAdapter } from '../src/panel';
import { valheimRuntimeAdapter } from '../src/runtime';
import { VALHEIM_META } from '../src/shared';

const server = () => ({ id: 'vh', gameName: 'vh', flavour: null });

runtimeAdapterSuite(valheimRuntimeAdapter, { validLaunch: () => ({}) });
panelAdapterCoreSuite(valheimPanelAdapter, { server, secrets: () => ({}) });
// No config files are declared yet (they come from the captures), so the checks that need one are left out.
panelAdapterConfigSuite(valheimPanelAdapter);

describe('the Valheim skeleton (D4, D5)', () => {
  it('shares one meta: the steam runtime, x86-64 only', () => {
    expect(valheimRuntimeAdapter.meta).toBe(VALHEIM_META);
    expect(valheimPanelAdapter.meta).toBe(VALHEIM_META);
    expect(VALHEIM_META).toMatchObject({ id: 'valheim', runtime: 'steam', arch: ['amd64'] });
  });

  it('launches nothing until the fact-finding measured the game', async () => {
    const ctx = {} as RuntimeCtx;
    const p = valheimRuntimeAdapter.parseLaunch({});
    await expect(valheimRuntimeAdapter.prepare(ctx, p)).rejects.toThrow(/skeleton/);
    expect(() => valheimRuntimeAdapter.command(ctx, p)).toThrow(/skeleton/);
  });
});
