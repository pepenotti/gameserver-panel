import { describe, expect, it } from 'vitest';
import { checkAddress, isDnsName, isIPv4, isIPv6, isPrivateIPv4, joinText } from '../src/connection';

describe('the address people type for the host (HST-08)', () => {
  it('takes a DNS name or an IPv4 or IPv6 address, trimmed and lower case', () => {
    expect(checkAddress(' Example.DuckDNS.org ')).toEqual({ ok: true, address: 'example.duckdns.org', kind: 'dns' });
    expect(checkAddress('example.duckdns.org.')).toEqual({ ok: true, address: 'example.duckdns.org', kind: 'dns' });
    expect(checkAddress('gamepc')).toEqual({ ok: true, address: 'gamepc', kind: 'dns' });
    expect(checkAddress('203.0.113.7')).toEqual({ ok: true, address: '203.0.113.7', kind: 'ipv4' });
    expect(checkAddress('2001:DB8::1')).toEqual({ ok: true, address: '2001:db8::1', kind: 'ipv6' });
    expect(checkAddress('[2001:db8::1]')).toEqual({ ok: true, address: '2001:db8::1', kind: 'ipv6' });
    expect(checkAddress('::ffff:192.0.2.1')).toEqual({ ok: true, address: '::ffff:192.0.2.1', kind: 'ipv6' });
  });

  it('refuses a scheme, a port, a path and what is no address, saying which', () => {
    expect(checkAddress('')).toEqual({ ok: false, problem: 'empty' });
    expect(checkAddress('   ')).toEqual({ ok: false, problem: 'empty' });
    expect(checkAddress('https://example.duckdns.org')).toEqual({ ok: false, problem: 'scheme' });
    expect(checkAddress('example.duckdns.org:8443')).toEqual({ ok: false, problem: 'port' });
    expect(checkAddress('203.0.113.7:27015')).toEqual({ ok: false, problem: 'port' });
    expect(checkAddress('[2001:db8::1]:8443')).toEqual({ ok: false, problem: 'port' });
    expect(checkAddress('example.duckdns.org/panel')).toEqual({ ok: false, problem: 'path' });
    expect(checkAddress('example.org?x=1')).toEqual({ ok: false, problem: 'path' });
    expect(checkAddress('256.1.1.1')).toEqual({ ok: false, problem: 'invalid' });
    expect(checkAddress('1.2.3')).toEqual({ ok: false, problem: 'invalid' });
    expect(checkAddress('under_score.example')).toEqual({ ok: false, problem: 'invalid' });
    expect(checkAddress('-bad.example')).toEqual({ ok: false, problem: 'invalid' });
    expect(checkAddress('two words')).toEqual({ ok: false, problem: 'invalid' });
    expect(checkAddress('1::2::3')).toEqual({ ok: false, problem: 'invalid' });
    expect(checkAddress(`${'a'.repeat(250)}.org`)).toEqual({ ok: false, problem: 'too-long' });
  });

  it('knows the address kinds on their own', () => {
    expect(isIPv4('0.0.0.0')).toBe(true);
    expect(isIPv4('01.2.3.4')).toBe(false);
    expect(isIPv6('1:2:3:4:5:6:7:8')).toBe(true);
    expect(isIPv6('1:2:3:4:5:6:7')).toBe(false);
    expect(isIPv6('::1')).toBe(true);
    expect(isIPv6('fe80::1%eth0')).toBe(false);
    expect(isDnsName(`${'a'.repeat(63)}.example`)).toBe(true);
    expect(isDnsName(`${'a'.repeat(64)}.example`)).toBe(false);
    expect(isDnsName('1.2.3.4')).toBe(false);
  });

  it('tells a home-network address (RFC 1918) from the others', () => {
    for (const a of ['10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.50']) expect(isPrivateIPv4(a), a).toBe(true);
    for (const a of ['127.0.0.1', '172.32.0.1', '203.0.113.7', 'gamepc']) expect(isPrivateIPv4(a), a).toBe(false);
  });
});

describe('what players type, in a game format (SRV-08)', () => {
  it('puts the port after the address, IPv6 in brackets', () => {
    expect(joinText('203.0.113.7', 30450, 'host:port')).toBe('203.0.113.7:30450');
    expect(joinText('example.duckdns.org', 30450, 'host:port', 25565)).toBe('example.duckdns.org:30450');
    expect(joinText('2001:db8::1', 30450, 'host:port')).toBe('[2001:db8::1]:30450');
  });

  it('leaves the port out when it is the one the client assumes', () => {
    expect(joinText('example.duckdns.org', 25565, 'host:port', 25565)).toBe('example.duckdns.org');
    expect(joinText('2001:db8::1', 25565, 'host:port', 25565)).toBe('[2001:db8::1]');
  });

  it('gives the address alone when the client asks for the port in its own field', () => {
    expect(joinText('192.168.1.50', 7777, 'separate')).toBe('192.168.1.50');
    expect(joinText('2001:db8::1', 7777, 'separate', 7777)).toBe('2001:db8::1');
  });
});
