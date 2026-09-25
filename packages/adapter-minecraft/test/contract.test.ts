// The Minecraft skeleton passes the adapter contract suites as it is (D4),
// declares the EULA with its agreement (D6), and launches nothing yet (D5:
// measured, not guessed).
import { describe, expect, it } from 'vitest';
import { panelAdapterConfigSuite } from '@gsp/adapter-api/testing/panel-suite-config';
import { panelAdapterCoreSuite } from '@gsp/adapter-api/testing/panel-suite-core';
import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import type { RuntimeCtx } from '@gsp/adapter-api';
import { minecraftPanelAdapter } from '../src/panel';
import { minecraftRuntimeAdapter } from '../src/runtime';
import { MINECRAFT_META } from '../src/shared';

const server = () => ({ id: 'mc', gameName: 'mc', flavour: 'vanilla' });

runtimeAdapterSuite(minecraftRuntimeAdapter, { validLaunch: () => ({}) });
panelAdapterCoreSuite(minecraftPanelAdapter, { server, secrets: () => ({}) });
// No config files are declared yet (they come from the captures), so the checks that need one are left out.
panelAdapterConfigSuite(minecraftPanelAdapter);

describe('the Minecraft skeleton (D4, D5, D6)', () => {
  it('shares one meta: the java runtime, x86-64 and ARM64, the loaders, and the EULA with its agreement', () => {
    expect(minecraftRuntimeAdapter.meta).toBe(MINECRAFT_META);
    expect(minecraftPanelAdapter.meta).toBe(MINECRAFT_META);
    expect(MINECRAFT_META).toMatchObject({ id: 'minecraft', runtime: 'java', arch: ['amd64', 'arm64'], capabilities: ['eula'] });
    expect(MINECRAFT_META.flavours.map((f) => f.id)).toEqual(['vanilla', 'paper', 'fabric']);
    expect(MINECRAFT_META.eula?.url).toMatch(/^https:\/\//);
  });

  it('launches nothing until the fact-finding measured the game', async () => {
    const ctx = { eulaAccepted: true } as RuntimeCtx;
    const p = minecraftRuntimeAdapter.parseLaunch({});
    await expect(minecraftRuntimeAdapter.prepare(ctx, p)).rejects.toThrow(/skeleton/);
    expect(() => minecraftRuntimeAdapter.command(ctx, p)).toThrow(/skeleton/);
    expect(minecraftRuntimeAdapter.channel(ctx, p)).toEqual({ kind: 'none' });
  });
});
