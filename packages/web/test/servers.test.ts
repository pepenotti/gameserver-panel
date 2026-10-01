// Creating a server in the web (SRV-01): what the form checks before the API
// does, the ports it suggests, and where it shows the API's refusals.
import { describe, expect, it } from 'vitest';
import { launchRefusalOf, type PortDecl } from '../src/api/meta';
import { en } from '../src/i18n/en';
import { es } from '../src/i18n/es';
import { choosablePorts, createErrorField, followersOf, formatRanges, idProblem, maxGameMemory, nameProblem, pendingHelpKeys, portProblem, slugify, suggestPorts } from '../src/lib/servers';

const port = (id: string, proto: 'tcp' | 'udp', dflt: number, publish = true): PortDecl => ({ id, proto, default: dflt, publish, sameInsideOut: true, label: { en: id, es: id } });
/** A game with a pair of UDP ports players use and a TCP port only its agent uses. */
const DECLS = [port('game', 'udp', 20000), port('direct', 'udp', 20001), port('admin', 'tcp', 21000, false)];

describe('server ids and names', () => {
  it('suggests an id from the name', () => {
    expect(slugify('Mi Server Ñandú #2')).toBe('mi-server-nandu-2');
    expect(slugify('  42 Friends  ')).toBe('friends');
    expect(slugify('A very long server name that goes on and on')).toBe('a-very-long-server-name');
    expect(slugify('A very long server name that goes on and on').length).toBeLessThanOrEqual(24);
  });

  it('checks an id the way the API does', () => {
    expect(idProblem('friends', [])).toBeNull();
    expect(idProblem('x', [])).toBe('invalid-server-id');
    expect(idProblem('2fast', [])).toBe('invalid-server-id');
    expect(idProblem('Upper', [])).toBe('invalid-server-id');
    expect(idProblem('default', [])).toBe('reserved-server-id');
    expect(idProblem('panel', [])).toBe('reserved-server-id');
    expect(idProblem('friends', ['friends'])).toBe('server-exists');
  });

  it('checks a name the way the API does (trimmed, one line, unique without case)', () => {
    expect(nameProblem('Friends', [])).toBeNull();
    expect(nameProblem('   ', [])).toBe('invalid-server-name');
    expect(nameProblem('two\nlines', [])).toBe('invalid-server-name');
    expect(nameProblem('x'.repeat(65), [])).toBe('invalid-server-name');
    expect(nameProblem(' friends ', ['Friends'])).toBe('server-name-taken');
  });
});

describe('ports', () => {
  it('suggests the defaults, shifted together past other servers’ ports', () => {
    expect(suggestPorts(DECLS, [])).toEqual({ game: 20000, direct: 20001 });
    // One of the pair is taken: both move by the width of the pair.
    expect(suggestPorts(DECLS, [{ port: 20001, proto: 'udp' }])).toEqual({ game: 20002, direct: 20003 });
    // The same number over another protocol is free.
    expect(suggestPorts(DECLS, [{ port: 20000, proto: 'tcp' }])).toEqual({ game: 20000, direct: 20001 });
    expect(suggestPorts([port('only', 'tcp', 65535)], [{ port: 65535, proto: 'tcp' }])).toBeNull();
    expect(suggestPorts([port('admin', 'tcp', 21000, false)], [])).toEqual({});
  });

  it('suggests ports inside what the host lets servers publish', () => {
    // The defaults are allowed: near them, as without ranges.
    expect(suggestPorts(DECLS, [{ port: 20000, proto: 'udp' }], [{ from: 19990, to: 20010 }])).toEqual({ game: 20002, direct: 20003 });
    // They aren't: as low as the pair fits in the ranges, past what is taken.
    const ranges = [{ from: 30350, to: 30399 }];
    expect(suggestPorts(DECLS, [], ranges)).toEqual({ game: 30350, direct: 30351 });
    expect(suggestPorts(DECLS, [{ port: 30351, proto: 'udp' }], ranges)).toEqual({ game: 30352, direct: 30353 });
    expect(suggestPorts(DECLS, [], [{ from: 30350, to: 30350 }])).toBeNull();
    expect(formatRanges([{ from: 2456, to: 2499 }, { from: 16261, to: 16261 }])).toBe('2456-2499, 16261');
  });

  it('says what is wrong with a port; an empty one is the panel’s to pick', () => {
    const taken = [{ port: 20002, proto: 'udp' as const, by: 'Other' }];
    expect(portProblem('game', { game: 20010, direct: 20011 }, DECLS, taken)).toBeNull();
    expect(portProblem('game', { game: null, direct: 20011 }, DECLS, taken)).toBeNull();
    expect(portProblem('game', { game: 80, direct: 20011 }, DECLS, taken)).toEqual({ kind: 'invalid' });
    expect(portProblem('game', { game: 20010, direct: 20011 }, DECLS, taken, [{ from: 30350, to: 30399 }])).toEqual({ kind: 'outside' });
    expect(portProblem('game', { game: 20011, direct: 20011 }, DECLS, taken)).toEqual({ kind: 'twice' });
    expect(portProblem('game', { game: 20002, direct: 20011 }, DECLS, taken)).toEqual({ kind: 'taken', by: 'Other', port: 20002 });
  });

  describe('that follow another (PortDecl.follows, SRV-01)', () => {
    /** A game port on UDP and TCP, and a query port always one above it. */
    const FOLLOWING: PortDecl[] = [port('game', 'udp', 2456), { ...port('gametcp', 'tcp', 2456), follows: { id: 'game', offset: 0 } }, { ...port('query', 'udp', 2457), follows: { id: 'game', offset: 1 } }];

    it('are never asked for: only the ports people choose are suggested, placed with the ones that follow them', () => {
      expect(choosablePorts(FOLLOWING).map((p) => p.id)).toEqual(['game']);
      expect(followersOf(FOLLOWING, 'game').map((p) => p.id)).toEqual(['gametcp', 'query']);
      expect(suggestPorts(FOLLOWING, [])).toEqual({ game: 2456 });
      // The block moves when a following port is taken, on its own protocol.
      expect(suggestPorts(FOLLOWING, [{ port: 2457, proto: 'udp' }])).toEqual({ game: 2458 });
      expect(suggestPorts(FOLLOWING, [{ port: 2456, proto: 'tcp' }])).toEqual({ game: 2458 });
      expect(suggestPorts(FOLLOWING, [{ port: 2457, proto: 'tcp' }])).toEqual({ game: 2456 });
    });

    it('make their port wrong when they can not be had, naming the number another server has', () => {
      const taken = [{ port: 30551, proto: 'udp' as const, by: 'Other' }];
      expect(portProblem('game', { game: 30550 }, FOLLOWING, taken)).toEqual({ kind: 'taken', by: 'Other', port: 30551 });
      expect(portProblem('game', { game: 30552 }, FOLLOWING, taken)).toBeNull();
      expect(portProblem('game', { game: 30599 }, FOLLOWING, [], [{ from: 30550, to: 30599 }])).toEqual({ kind: 'outside' });
      expect(portProblem('game', { game: 65535 }, FOLLOWING, [])).toEqual({ kind: 'invalid' });
      expect(portProblem('query', { game: 30550 }, FOLLOWING, [])).toBeNull();
    });

    it('put a refusal about them on the port they follow', () => {
      const ports = { game: 30550 };
      expect(createErrorField('port-conflict', { port: 30551, proto: 'udp', with: 'other' }, FOLLOWING, ports)).toEqual({ field: 'port:game', port: 30551 });
      expect(createErrorField('port-conflict', { field: 'ports[1].host', message: 'taken' }, FOLLOWING, ports)).toEqual({ field: 'port:game', port: 30550 });
      expect(createErrorField('port-conflict', { field: 'ports[2].host', message: 'taken' }, FOLLOWING, ports)).toEqual({ field: 'port:game', port: 30551 });
    });
  });

  it('caps a game’s memory at what the host gives one server, less the container’s own needs', () => {
    expect(maxGameMemory(6144, 3072, 512)).toBe(3072);
    expect(maxGameMemory(6000, 3072, 512)).toBe(2560);
    expect(maxGameMemory(6000, 3072)).toBe(2928);
    expect(maxGameMemory(null, 3072, 512)).toBeNull();
  });

  it('puts each API refusal on the field it is about', () => {
    const ports = { game: 20000, direct: 20001 };
    expect(createErrorField('server-exists', {}, DECLS, ports)).toEqual({ field: 'id' });
    expect(createErrorField('server-name-taken', {}, DECLS, ports)).toEqual({ field: 'name' });
    expect(createErrorField('arch-unsupported', { arch: 'arm64' }, DECLS, ports)).toEqual({ field: 'game' });
    expect(createErrorField('memory-too-low', { minMb: 4096 }, DECLS, ports)).toEqual({ field: 'memory' });
    expect(createErrorField('invalid-options', { message: 'x' }, DECLS, ports)).toEqual({ field: 'launch' });
    expect(createErrorField('invalid-port', { port: 'direct', min: 1024, max: 65535 }, DECLS, ports)).toEqual({ field: 'port:direct' });
    // The panel names the clashing port number…
    expect(createErrorField('port-conflict', { port: 20001, proto: 'udp', with: 'other' }, DECLS, ports)).toEqual({ field: 'port:direct', port: 20001 });
    // …the orchestrator the spec's field, in the order the game publishes its ports.
    expect(createErrorField('port-conflict', { field: 'ports[1].host', message: 'taken' }, DECLS, ports)).toEqual({ field: 'port:direct', port: 20001 });
    expect(createErrorField('orchestrator-refused', { field: 'ports[0].host' }, DECLS, ports)).toEqual({ field: 'port:game', port: 20000 });
    // Memory above what the host gives one server, from the panel's check or the orchestrator's.
    expect(createErrorField('orchestrator-refused', { field: 'memLimitMb', maxMb: 6144 }, DECLS, ports)).toEqual({ field: 'memory' });
    expect(createErrorField('orchestrator-refused', { field: 'memoryMb' }, DECLS, ports)).toEqual({ field: 'memory' });
    expect(createErrorField('orchestrator-refused', { field: 'env.GAME_X' }, DECLS, ports)).toEqual({ field: null });
    expect(createErrorField('invalid-port', { port: 'game', min: 30350, max: 30399, ranges: '30350-30399' }, DECLS, ports)).toEqual({ field: 'port:game' });
    expect(createErrorField('orchestrator-unavailable', {}, DECLS, ports)).toEqual({ field: null });
  });
});

describe("a launch setting the game's adapter refused (CFG-01, UX-01)", () => {
  it('is read from the refusal, setting and words in both languages; nothing else is', () => {
    expect(launchRefusalOf({ field: 'password', text: { en: 'Too short.', es: 'Muy corta.' }, message: 'x' })).toEqual({ field: 'password', text: { en: 'Too short.', es: 'Muy corta.' } });
    for (const extra of [{}, { message: 'x' }, { field: 'password' }, { field: 'password', text: 'Too short.' }, { field: 3, text: { en: 'a', es: 'b' } }]) expect(launchRefusalOf(extra)).toBeNull();
  });
});

describe('a container waiting for the next start (SRV-05, HST-01)', () => {
  it('says why: new limits, a newer runtime image, or both, in English and Spanish', () => {
    expect(pendingHelpKeys(['settings'])).toEqual(['servers.pendingStartHelp']);
    expect(pendingHelpKeys(['image'])).toEqual(['servers.pendingImageHelp']);
    expect(pendingHelpKeys(['settings', 'image'])).toEqual(['servers.pendingStartHelp', 'servers.pendingImageHelp']);
    expect(pendingHelpKeys([])).toEqual(['servers.pendingStartHelp']);
    for (const lang of [en, es]) {
      expect(lang.servers.pendingImageHelp).toMatch(/\S/);
      expect(lang.server.imageNextStart).toMatch(/\S/);
    }
    // Game-neutral: it speaks of the runtime image, never of a game.
    expect(en.servers.pendingImageHelp).toMatch(/runtime image/);
    expect(es.servers.pendingImageHelp).toMatch(/imagen de ejecución/);
  });

  it('says so when a panel update builds containers another way, alone or with the rest (SRV-06)', () => {
    expect(pendingHelpKeys(['derivation'])).toEqual(['servers.pendingDerivationHelp']);
    expect(pendingHelpKeys(['settings', 'image', 'derivation'])).toEqual(['servers.pendingStartHelp', 'servers.pendingImageHelp', 'servers.pendingDerivationHelp']);
    expect(en.servers.pendingDerivationHelp).toMatch(/panel update/);
    expect(es.servers.pendingDerivationHelp).toMatch(/actualización del panel/);
  });
});
