import path from 'node:path';
import { afterAll, beforeAll, describe } from 'vitest';
import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import { runtimeAdapter } from '@gsp/adapters/runtime';
import { startFakeDownloads, type FakeDownloads } from '../../../tools/fake-minecraft/downloads.mjs';
import { startFakeDownloads as startTerrariaDownloads, type FakeDownloads as TerrariaDownloads } from '../../../tools/fake-terraria/downloads.mjs';
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
  for (const env of envs) for (const k of ['GAME_MC_MOJANG_URL', 'GAME_MC_PAPER_URL', 'GAME_MC_FABRIC_URL']) env[k] = downloads.url;
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

// Terraria, per flavour (M5): installed from the fake terraria.org and GitHub (unpacked with the
// agent's extract), run by the fake server in the game's place (and dotnet's, for tModLoader, whose
// flavour runs in the steam image: its installs get the steamcmd driver). TShock's players come
// over its REST API, set up by prepare with the agent's token.
const fakeTerraria = [process.execPath, path.join(tools, '..', 'fake-terraria', 'server.mjs')];
const terrariaEnvs: Record<string, string>[] = [];
let terrariaDownloads: TerrariaDownloads;
beforeAll(async () => {
  terrariaDownloads = await startTerrariaDownloads({ fail: '' });
  for (const env of terrariaEnvs) for (const k of ['GAME_TERRARIA_ORG_URL', 'GAME_TERRARIA_GITHUB_URL']) env[k] = terrariaDownloads.url;
});
afterAll(() => terrariaDownloads.close());

// Avorion, from its manifest alone (M6, G4): installed with its fake steamcmd, run by its fake
// server in the game's place, its console on stdin.
const fakeAvorion = (kind: 'server' | 'steamcmd') => [process.execPath, path.join(tools, '..', 'fake-avorion', `${kind}.mjs`)];
describe('avorion (a manifest)', () => {
  runtimeAdapterSuite(runtimeAdapter('avorion'), {
    validLaunch: () => ({ name: 'gal', branch: 'public', updateOnStart: false, memoryMb: 2048, serverName: 'Gal test', maxPlayers: 8, listed: false, saveInterval: 300 }),
    live: agentHost({ launcher: fakeAvorion('server'), steamcmd: fakeAvorion('steamcmd') }, { env: { FAKE_AVORION_BOOT_MS: '100' } }),
  });
});

// Valheim, a manifest plus hooks (M6, D4): installed with its fake steamcmd, run by its fake server in
// the game's place. It has no console and stops on SIGINT, which saves first; Windows can't deliver
// SIGINT to a child that handles it (the child is killed instead, and the suite rightly finds an
// exit by signal), so this runs where signals work: Linux, as in the steam image.
const fakeValheim = (kind: 'server' | 'steamcmd') => [process.execPath, path.join(tools, '..', 'fake-valheim', `${kind}.mjs`)];
describe.skipIf(process.platform === 'win32')('valheim (a manifest plus hooks)', () => {
  runtimeAdapterSuite(runtimeAdapter('valheim'), {
    validLaunch: () => ({ name: 'vh', branch: 'public', updateOnStart: false, memoryMb: 3072, serverName: 'Contract test', password: 'secret12', public: false, crossplay: false, saveInterval: 60 }),
    live: agentHost({ launcher: fakeValheim('server'), steamcmd: fakeValheim('steamcmd') }, { env: { FAKE_VALHEIM_BOOT_MS: '100', FAKE_VALHEIM_GEN_MS: '50', FAKE_VALHEIM_STOP_MS: '50' } }),
  });
});

for (const flavour of ['vanilla', 'tshock', 'tmodloader'] as const) {
  const env: Record<string, string> = { FAKE_TERRARIA_BOOT_MS: '50' };
  terrariaEnvs.push(env);
  describe(`terraria ${flavour}`, () => {
    runtimeAdapterSuite(runtimeAdapter('terraria'), {
      validLaunch: () => ({ flavour, world: 'world', worldSize: 1, maxPlayers: 8, memoryMb: 2048 }),
      live: agentHost({ launcher: fakeTerraria, steamcmd: fakeSteamcmd }, { env, flavour }),
    });
  });
}
