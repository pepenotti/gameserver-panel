// Creating a server in the web (SRV-01): what the form checks before the API
// does, the ports it suggests, and where it shows the API's refusals.
import { describe, expect, it } from 'vitest';
import type { PortDecl } from '../src/api/meta';
import { createErrorField, idProblem, nameProblem, portProblem, slugify, suggestPorts } from '../src/lib/servers';

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

  it('says what is wrong with a port', () => {
    const taken = [{ port: 20002, proto: 'udp' as const, by: 'Other' }];
    expect(portProblem('game', { game: 20010, direct: 20011 }, DECLS, taken)).toBeNull();
    expect(portProblem('game', { game: null, direct: 20011 }, DECLS, taken)).toEqual({ kind: 'required' });
    expect(portProblem('game', { game: 80, direct: 20011 }, DECLS, taken)).toEqual({ kind: 'invalid' });
    expect(portProblem('game', { game: 20011, direct: 20011 }, DECLS, taken)).toEqual({ kind: 'twice' });
    expect(portProblem('game', { game: 20002, direct: 20011 }, DECLS, taken)).toEqual({ kind: 'taken', by: 'Other' });
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
    expect(createErrorField('orchestrator-refused', { field: 'memoryMb' }, DECLS, ports)).toEqual({ field: null });
    expect(createErrorField('orchestrator-unavailable', {}, DECLS, ports)).toEqual({ field: null });
  });
});
