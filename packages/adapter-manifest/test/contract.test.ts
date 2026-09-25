// The manifest skeleton passes the adapter contract suites as it is (D4),
// and runs nothing yet (D5: measured, not guessed).
import { describe, expect, it } from 'vitest';
import { panelAdapterConfigSuite } from '@gsp/adapter-api/testing/panel-suite-config';
import { panelAdapterCoreSuite } from '@gsp/adapter-api/testing/panel-suite-core';
import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import type { RuntimeCtx } from '@gsp/adapter-api';
import { manifestPanelAdapter } from '../src/panel';
import { manifestRuntimeAdapter } from '../src/runtime';
import { MANIFEST_META } from '../src/shared';

const server = () => ({ id: 'steamgame', gameName: 'steamgame', flavour: null });

runtimeAdapterSuite(manifestRuntimeAdapter, { validLaunch: () => ({}) });
panelAdapterCoreSuite(manifestPanelAdapter, { server, secrets: () => ({}) });
// No config files are declared yet (they come from the captures), so the checks that need one are left out.
panelAdapterConfigSuite(manifestPanelAdapter);

describe('the manifest skeleton (D4, D5)', () => {
  it('shares one meta: the steam runtime, x86-64 only', () => {
    expect(manifestRuntimeAdapter.meta).toBe(MANIFEST_META);
    expect(manifestPanelAdapter.meta).toBe(MANIFEST_META);
    expect(MANIFEST_META).toMatchObject({ id: 'manifest', runtime: 'steam', arch: ['amd64'] });
  });

  it('runs nothing until M6 defines the manifest', async () => {
    const ctx = {} as RuntimeCtx;
    const p = manifestRuntimeAdapter.parseLaunch({});
    await expect(manifestRuntimeAdapter.prepare(ctx, p)).rejects.toThrow(/skeleton/);
    expect(() => manifestRuntimeAdapter.command(ctx, p)).toThrow(/skeleton/);
  });
});
