// SRV-06, NFR-02: what `planContainer` derives from a spec only changes with
// DERIVATION_VERSION, so an orchestrator release can tell (and the panel can
// show) that a running game's container was built another way, and a
// security fix can be told apart by SAFE_DERIVATION.
import { describe, expect, it } from 'vitest';
import type { RuntimeFamily, ServerSpec } from '@gsp/shared';
import { DERIVATION, DERIVATION_VERSION, derivationState, LABEL, planContainer, SAFE_DERIVATION } from '../src/derive';

const ctx = { stack: 'gsp-ref', imageTag: 'ref', publishAddr: '0.0.0.0', allowFake: false };
const ref = (runtime: RuntimeFamily): ServerSpec => ({
  id: 'ref',
  runtime,
  env: { AGENT_TOKEN: 'reference-token-0123456789abcdef0123456789', GAME_ADAPTER: 'ref', TZ: 'UTC', GAME_PORT_GAME: '30000' },
  ports: [{ container: 30000, host: 30000, proto: 'udp' }],
  memoryMb: 2048,
  cpus: 2,
});

/** Each family's config hash of the reference spec, per derivation version. */
const PINNED: Record<number, Record<RuntimeFamily, string>> = {
  1: {
    steam: 'b3199d3257753cca982ea8e965647b135a37a2200236eb945f075bbe98d704b1',
    java: '0105bb5acb18bd99dfd4dd48174e757534912c9a6f93fd34b5ddf24244ab5a88',
    native: '894a6b69d98886a81f289a87e1e71862a1bf97f2ab763d2bae2a5964eae57706',
  },
};

describe('the derivation version (SRV-06, NFR-02)', () => {
  it('derives the same containers until DERIVATION_VERSION is raised', () => {
    const now = { steam: planContainer(ref('steam'), ctx).configHash, java: planContainer(ref('java'), ctx).configHash, native: planContainer(ref('native'), ctx).configHash };
    expect(
      now,
      'What the orchestrator derives changed: raise DERIVATION_VERSION, raise SAFE_DERIVATION to it too when the change closes a security gap (running games are then recreated at once), and pin the new hashes here.',
    ).toEqual(PINNED[DERIVATION_VERSION]);
    expect(SAFE_DERIVATION).toBeLessThanOrEqual(DERIVATION_VERSION);
    expect(DERIVATION).toEqual({ version: DERIVATION_VERSION, safeFrom: SAFE_DERIVATION });
  });

  it('labels each container with it, as part of its config hash', () => {
    const plan = planContainer(ref('steam'), ctx);
    expect(plan.body.Labels[LABEL.derivation]).toBe(String(DERIVATION_VERSION));
    const other = planContainer(ref('steam'), ctx, { version: DERIVATION_VERSION + 1, safeFrom: 0 });
    expect(other.specHash).toBe(plan.specHash);
    expect(other.configHash).not.toBe(plan.configHash);
  });

  it('tells a container derived another way, and one derived before a security fix, from its labels', () => {
    const d = { version: 5, safeFrom: 3 };
    expect(derivationState({ [LABEL.derivation]: '5' }, d)).toBe('current');
    expect(derivationState({ [LABEL.derivation]: '4' }, d)).toBe('changed');
    expect(derivationState({ [LABEL.derivation]: '3' }, d)).toBe('changed');
    expect(derivationState({ [LABEL.derivation]: '2' }, d)).toBe('security-fix');
    expect(derivationState({ [LABEL.derivation]: '6' }, d)).toBe('changed');
    // From before versions, or not one: version 0.
    const odd: (Record<string, string> | null)[] = [{}, null, { [LABEL.derivation]: 'x' }, { [LABEL.derivation]: '-1' }, { [LABEL.derivation]: '1e3' }];
    for (const labels of odd) expect(derivationState(labels, d)).toBe('security-fix');
    expect(derivationState({}, { version: 1, safeFrom: 0 })).toBe('changed');
  });
});
