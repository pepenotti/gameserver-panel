// Shared installs in the web (HST-09, D12, UX-01): what an install holds in a
// few words, a server's install line and the move it waits for, the create
// form's line about a new server's game files, what the owner may remove,
// and the "applies at next start" badge's words for another install.
import { describe, expect, it } from 'vitest';
import type { InstallView, ServerInstallView } from '../src/api/installs';
import { en } from '../src/i18n/en';
import { es } from '../src/i18n/es';
import { canMoveNow, installLabel, jobPercent, planLine, removable, serverInstallLine, wantedLabel } from '../src/lib/installs';
import { pendingHelpKeys } from '../src/lib/servers';

const view = (over: Partial<ServerInstallView> = {}): ServerInstallView => ({
  mode: 'shared',
  id: 'i0123456789abcdef',
  state: 'ready',
  key: { flavour: null, version: null, build: '25485538', branch: 'public' },
  bytes: 7_206_116_309,
  files: 39_186,
  sharedWith: 2,
  job: null,
  error: null,
  waiting: false,
  next: null,
  ...over,
});

const install = (over: Partial<InstallView> = {}): InstallView => ({
  id: 'i0123456789abcdef',
  adapter: 'game',
  adapterName: { en: 'Game', es: 'Juego' },
  flavour: null,
  flavourName: null,
  state: 'ready',
  key: { flavour: null, version: '1.2', build: null, branch: null },
  wanted: [],
  error: null,
  bytes: 1000,
  files: 3,
  origin: 'download',
  superseded: false,
  servers: [],
  job: null,
  createdAt: '2026-10-03T10:00:00.000Z',
  readyAt: '2026-10-03T10:01:00.000Z',
  removable: true,
  ...over,
});

describe('what an install holds, in a few words (HST-09)', () => {
  it('joins the version, branch and build the game has', () => {
    expect(installLabel({ version: null, build: '25485538', branch: 'public' })).toBe('public · 25485538');
    expect(installLabel({ version: '26.3', build: '0.19.5', branch: null })).toBe('26.3 · 0.19.5');
    expect(installLabel({ version: 'v6.2.1', build: null, branch: null })).toBe('v6.2.1');
    expect(installLabel({ version: null, build: null, branch: null })).toBeNull();
    expect(installLabel(null)).toBeNull();
    // What an install being made was asked for: what the launch pinned, with the channel it takes.
    expect(wantedLabel({ flavour: 'paper', version: '26.2', build: null, branch: null, channel: 'STABLE' })).toBe('26.2 (STABLE)');
    expect(wantedLabel({ flavour: 'vanilla', version: null, build: null, branch: null, channel: null })).toBeNull();
  });

  it('shows a job’s progress as a percentage, or none when the job doesn’t say', () => {
    expect(jobPercent({ phase: 'install', progress: 55.25, message: '' })).toBe(55);
    expect(jobPercent({ phase: 'install', progress: 120, message: '' })).toBe(100);
    expect(jobPercent({ phase: 'copy', progress: null, message: '' })).toBeNull();
    expect(jobPercent(null)).toBeNull();
  });
});

describe('a server’s install line (HST-09)', () => {
  it('says what it runs from, while it is made, why it failed, or that it has its own', () => {
    expect(serverInstallLine(view())).toEqual({ kind: 'shared', label: 'public · 25485538', sharedWith: 2, bytes: 7_206_116_309 });
    const job = { phase: 'install' as const, progress: 10, message: 'Downloading' };
    expect(serverInstallLine(view({ state: 'installing', waiting: true, key: null, job }))).toEqual({ kind: 'installing', job });
    expect(serverInstallLine(view({ state: 'failed', error: 'Disk full' }))).toEqual({ kind: 'failed', error: 'Disk full' });
    expect(serverInstallLine(view({ mode: 'own', id: null, state: null, key: null }))).toEqual({ kind: 'own' });
  });

  it('offers the move now only when there is one to make: off its own install, a failed install, a move waiting', () => {
    expect(canMoveNow(view())).toBe(false);
    expect(canMoveNow(view({ mode: 'own', id: null, state: null, next: { id: null, key: null, state: null, job: null } }))).toBe(true);
    expect(canMoveNow(view({ state: 'failed' }))).toBe(true);
    expect(canMoveNow(view({ next: { id: 'i1111111111111111', key: null, state: 'ready', job: null } }))).toBe(true);
    expect(canMoveNow(view({ mode: 'own', id: null, state: null }))).toBe(false);
  });

  it('words the "applies at next start" badge for another install, in both languages (SRV-05, UX-01)', () => {
    expect(pendingHelpKeys(['install'])).toEqual(['servers.pendingInstallHelp']);
    expect(pendingHelpKeys(['settings', 'image', 'install'])).toEqual(['servers.pendingStartHelp', 'servers.pendingImageHelp', 'servers.pendingInstallHelp']);
    expect(en.servers.pendingInstallHelp).toMatch(/next time the server starts/);
    expect(es.servers.pendingInstallHelp).toMatch(/próxima vez que prenda el servidor/);
  });
});

describe('the create form and the host page (HST-09, UX-01)', () => {
  const bytes = (n: number) => `${n} B`;
  it('says whether a new server downloads its game or uses the files already here', () => {
    expect(planLine({ mode: 'existing', bytes: 1000, servers: 2 }, bytes)).toEqual({ key: 'create.installExisting', values: { size: '1000 B', count: 2 } });
    expect(planLine({ mode: 'installing', bytes: null, servers: 1 }, bytes)).toEqual({ key: 'create.installInstalling', values: { count: 1 } });
    expect(planLine({ mode: 'download', bytes: 5000, servers: 0 }, bytes)).toEqual({ key: 'create.installDownload', values: { size: '5000 B' } });
    expect(planLine({ mode: 'download', bytes: null, servers: 0 }, bytes)).toEqual({ key: 'create.installDownloadUnknown', values: {} });
    expect(planLine({ mode: 'own', bytes: null, servers: 0 }, bytes)).toBeNull();
    expect(planLine(undefined, bytes)).toBeNull();
    for (const k of ['installExisting', 'installInstalling', 'installDownload', 'installDownloadUnknown'] as const) {
      expect(en.create[k], k).toBeTruthy();
      expect(es.create[k], k).toBeTruthy();
    }
  });

  it('counts what the owner may remove: installs nobody uses', () => {
    expect(removable([install(), install({ id: 'i2222222222222222', removable: false, bytes: 50 }), install({ id: 'i3333333333333333', bytes: null })])).toEqual({ ids: ['i0123456789abcdef', 'i3333333333333333'], bytes: 1000 });
    expect(removable([])).toEqual({ ids: [], bytes: 0 });
  });

  it('names how each install was filled, in both languages', () => {
    for (const o of ['download', 'update', 'adopted'] as const) {
      expect(en.hostSettings.installs.origin[o]).toBeTruthy();
      expect(es.hostSettings.installs.origin[o]).toBeTruthy();
    }
  });
});
