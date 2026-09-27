import path from 'node:path';
import { afterAll, beforeAll, describe } from 'vitest';
import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import { runtimeAdapter } from '@gsp/adapters/runtime';
import { startFakeDownloads, type FakeDownloads } from '../../../tools/fake-minecraft/downloads.mjs';
import { fakeServer, fakeSteamcmd, launch, tools } from './helpers';
import { agentHost } from './runtime-host';

// Each runtime adapter the agent can run, against its fake server, through
// the agent's own process, channel, steamcmd and download plumbing (NFR-07).
runtimeAdapterSuite(runtimeAdapter('pz'), {
  validLaunch: () => launch,
  live: agentHost({ launcher: fakeServer, steamcmd: fakeSteamcmd }),
});

// Minecraft, per loader (UPD-06): installed from the fake download services,
// run by the fake server in java's place, with the owner's EULA acceptance (D6).
const fakeJava = [process.execPath, path.join(tools, '..', 'fake-minecraft', 'server.mjs')];
/** Each loader's environment; the download URLs are filled in once the fake services listen. */
const envs: Record<string, string>[] = [];
let downloads: FakeDownloads;
beforeAll(async () => {
  downloads = await startFakeDownloads({ fail: '' });
  for (const env of envs) for (const k of ['MC_MOJANG_META_URL', 'MC_PAPER_API_URL', 'MC_FABRIC_META_URL']) env[k] = downloads.url;
});
afterAll(() => downloads.close());

for (const [loader, version] of [
  ['vanilla', '26.3'],
  // Paper's default channel is STABLE, which the fake's 26.2 has (its 26.3 is ALPHA only, as measured).
  ['paper', '26.2'],
  ['fabric', '26.3'],
] as const) {
  const env: Record<string, string> = { FAKE_MC_VERSION: version, FAKE_MC_BOOT_MS: '100' };
  envs.push(env);
  describe(`minecraft ${loader}`, () => {
    runtimeAdapterSuite(runtimeAdapter('minecraft'), {
      validLaunch: () => ({ version, loader, memoryMb: 1024 }),
      live: agentHost({ launcher: fakeJava, steamcmd: fakeSteamcmd }, { env, eulaAccepted: true }),
    });
  });
}
