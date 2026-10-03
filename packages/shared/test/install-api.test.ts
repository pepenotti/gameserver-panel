// HST-09, D12: the shared-install contract the adapters, the agent and the
// panel share: how an install is shared, the redirects an install job may
// make, install ids, and what a server spec may never set itself.
import { describe, expect, it } from 'vitest';
import { installSharingOf, isInstallId, redirectProblem, redirectTarget, segmentMatches, SHARED_INSTALL_MARKER, SPEC_ENV_DENIED } from '../src/index';

describe('shared installs (HST-09, D12)', () => {
  it('takes install ids the panel makes: i, then 8-31 lowercase letters and digits', () => {
    for (const ok of ['i0123abcd', `i${'a'.repeat(31)}`, 'i1f2e3d4c5b6a7980']) expect(isInstallId(ok), ok).toBe(true);
    for (const bad of ['i1234567', `i${'a'.repeat(32)}`, 'x0123abcd', 'I0123abcd', 'i0123-abcd', 'i0123abcD', 'i0123abcd/', '', null, 42]) expect(isInstallId(bad), String(bad)).toBe(false);
  });

  it("never lets a spec say it is an install job or on a shared install: the orchestrator decides (NFR-02)", () => {
    expect(SPEC_ENV_DENIED).toEqual(expect.arrayContaining(['GSP_AGENT_MODE', 'GSP_INSTALL_SHARED']));
  });

  it("takes a flavour's sharing over its adapter's, and the server's own install when neither says", () => {
    const meta = {
      install: { mode: 'shared' as const },
      flavours: [{ id: 'logs', install: { mode: 'shared' as const, redirects: [{ path: 'game-*/Logs', to: '/data/Logs' }] } }, { id: 'plain' }],
    };
    expect(installSharingOf(meta, 'logs')).toEqual({ mode: 'shared', redirects: [{ path: 'game-*/Logs', to: '/data/Logs' }] });
    expect(installSharingOf(meta, 'plain')).toEqual({ mode: 'shared' });
    expect(installSharingOf(meta, null)).toEqual({ mode: 'shared' });
    expect(installSharingOf(meta, 'unknown')).toEqual({ mode: 'shared' });
    expect(installSharingOf({ flavours: [] }, null)).toEqual({ mode: 'own' });
  });

  it('takes redirects from a path inside the install to a target under /data only', () => {
    for (const ok of [
      { path: 'steamapps/workshop', to: '/data/.workshop/steamapps/workshop' },
      { path: 'tmodloader-*/tModLoader-Logs', to: '/data/tModLoader-Logs' },
      { path: 'a', to: '/data/b' },
    ]) {
      expect(redirectProblem(ok), ok.path).toBeNull();
      expect(redirectTarget(ok)).toBe(ok.to.slice('/data/'.length));
    }
    const problems: [string, string, RegExp][] = [
      ['/abs', '/data/x', /inside the install/],
      ['a/../b', '/data/x', /inside the install/],
      ['..', '/data/x', /inside the install/],
      ['a/./b', '/data/x', /inside the install/],
      ['a//b', '/data/x', /inside the install/],
      ['a/', '/data/x', /inside the install/],
      ['', '/data/x', /inside the install/],
      ['a b', '/data/x', /inside the install/],
      [SHARED_INSTALL_MARKER, '/data/x', /marker/],
      ['logs', '/tmp/x', /under \/data\//],
      ['logs', '/data', /under \/data\//],
      ['logs', '/data/', /inside the data root/],
      ['logs', '/data/../etc', /inside the data root/],
      ['logs', '/data/a/*', /\* in its target/],
      ['logs', 'data/x', /under \/data\//],
      ['game/*', '/data/x', /the linked path itself/],
    ];
    for (const [path, to, why] of problems) {
      expect(redirectProblem({ path, to }), `${path} → ${to}`).toMatch(why);
      expect(redirectTarget({ path, to })).toBeNull();
    }
  });

  it('matches a segment with * against plain names only, never across a slash', () => {
    expect(segmentMatches('tmodloader-*', 'tmodloader-v2026.07.3.0')).toBe(true);
    expect(segmentMatches('tmodloader-*', 'tshock-v6.2.1')).toBe(false);
    expect(segmentMatches('*', 'anything.at.all')).toBe(true);
    expect(segmentMatches('a.b', 'aXb')).toBe(false);
    expect(segmentMatches('a.b', 'a.b')).toBe(true);
    expect(segmentMatches('x*', 'x/y')).toBe(false);
  });
});
