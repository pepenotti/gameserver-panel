import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import { runtimeAdapter } from '@gsp/adapters/runtime';
import { fakeServer, fakeSteamcmd, launch } from './helpers';
import { agentHost } from './runtime-host';

// Each runtime adapter the agent can run, against its fake server, through
// the agent's own process, channel and steamcmd plumbing (NFR-07).
runtimeAdapterSuite(runtimeAdapter('pz'), {
  validLaunch: () => launch,
  live: agentHost({ launcher: fakeServer, steamcmd: fakeSteamcmd }),
});
