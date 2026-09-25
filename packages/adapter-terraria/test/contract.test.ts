// The Terraria skeleton passes the adapter contract suites as it is (D4),
// and launches nothing yet (D5: measured, not guessed).
import { describe, expect, it } from 'vitest';
import { panelAdapterConfigSuite } from '@gsp/adapter-api/testing/panel-suite-config';
import { panelAdapterCoreSuite } from '@gsp/adapter-api/testing/panel-suite-core';
import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import type { RuntimeCtx } from '@gsp/adapter-api';
import { terrariaPanelAdapter } from '../src/panel';
import { terrariaRuntimeAdapter } from '../src/runtime';
import { TERRARIA_META } from '../src/shared';

const server = () => ({ id: 'tr', gameName: 'tr', flavour: 'vanilla' });

runtimeAdapterSuite(terrariaRuntimeAdapter, { validLaunch: () => ({}) });
panelAdapterCoreSuite(terrariaPanelAdapter, { server, secrets: () => ({}) });
// No config files are declared yet (they come from the captures), so the checks that need one are left out.
panelAdapterConfigSuite(terrariaPanelAdapter);

describe('the Terraria skeleton (D4, D5)', () => {
  it('shares one meta: the native runtime and the three flavours', () => {
    expect(terrariaRuntimeAdapter.meta).toBe(TERRARIA_META);
    expect(terrariaPanelAdapter.meta).toBe(TERRARIA_META);
    expect(TERRARIA_META).toMatchObject({ id: 'terraria', runtime: 'native' });
    expect(TERRARIA_META.flavours.map((f) => f.id)).toEqual(['vanilla', 'tshock', 'tmodloader']);
  });

  it('launches nothing until the fact-finding measured the game', async () => {
    const ctx = {} as RuntimeCtx;
    const p = terrariaRuntimeAdapter.parseLaunch({});
    await expect(terrariaRuntimeAdapter.prepare(ctx, p)).rejects.toThrow(/skeleton/);
    expect(() => terrariaRuntimeAdapter.command(ctx, p)).toThrow(/skeleton/);
  });
});
