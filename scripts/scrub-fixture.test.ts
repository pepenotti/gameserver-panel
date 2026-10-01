// The fixture scrubber (NFR-09, D5): captured game output becomes a tracked
// fixture only after this has replaced what could name a person, a host,
// an address or a path. Everything below is made up for the test.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createScrubber, defaultOut } from './scrub-fixture.mjs';

const script = fileURLToPath(new URL('./scrub-fixture.mjs', import.meta.url));
const temp: string[] = [];
afterAll(() => {
  // rmSync never follows a link: the test's own link out stays a link.
  for (const d of temp) rmSync(d, { recursive: true, force: true });
});

describe('the fixture scrubber (NFR-09)', () => {
  it('replaces Steam64 ids and IPv4 addresses stably, with RFC 5737 addresses', () => {
    const s = createScrubber();
    const out = s.scrub('join 76561198123456789 from 203.45.67.89:16261\nagain 76561198123456789 from 203.45.67.89, then 76561197960287930 from 10.0.0.7');
    expect(out).toBe('join 76561198000000001 from 192.0.2.1:16261\nagain 76561198000000001 from 192.0.2.1, then 76561198000000002 from 192.0.2.2');
    // Stable across texts of one run.
    expect(s.scrub('10.0.0.7 and 76561197960287930')).toBe('192.0.2.2 and 76561198000000002');
    expect(s.counts).toMatchObject({ steam64: 4, ipv4: 4 });
  });

  it('leaves loopback, any-address, masks, documentation addresses and version numbers alone', () => {
    const s = createScrubber({ keepIps: ['10.1.2.3'] });
    const text = 'bind 0.0.0.0 and 127.0.0.1 mask 255.255.255.0 doc 198.51.100.7 version 1.4.4.9 v1.2.3.4 build 42.20.4.1 kept 10.1.2.3 no 300.1.1.1 long 1.2.3.4.5';
    expect(s.scrub(text)).toBe(text);
    expect(s.counts).toEqual({});
  });

  it('takes a word that merely ends in "ver" for what it is: an address after "server:" is scrubbed', () => {
    const s = createScrubber();
    expect(s.scrub('PlayFab server: 11.22.33.44 registered; ver 1.0.16.0 stays')).toBe('PlayFab server: 192.0.2.1 registered; ver 1.0.16.0 stays');
    expect(s.counts).toEqual({ ipv4: 1 });
  });

  it('turns the given player names into Player1, Player2… whole words only, any case', () => {
    const s = createScrubber({ names: ['Rick', 'RickGrimes'] });
    expect(s.scrub('RickGrimes joined; rick left; Rickety and xRick stay; <Rick> said hi')).toBe('Player2 joined; Player1 left; Rickety and xRick stay; <Player1> said hi');
  });

  it('redacts secrets after known keys in every syntax, keeping empty ones and the layout', () => {
    const s = createScrubber();
    const input = [
      'rcon.password=hunter2',
      'RCONPassword=abc123 # the agent owns it',
      'Password=',
      'server-password: "s3cret"',
      'api_key = \'k-1\'',
      '  "RestApiToken": "tok-123",',
      '  "Password": "",',
      'start.sh -adminpassword Adm1n! -servername x',
      'java --token=zzz -jar x.jar',
      'Authorization: Bearer abc.def-ghi',
      'hook https://discord.com/api/webhooks/123/abcDEF',
      'motd=Welcome, no secret here',
    ].join('\n');
    expect(s.scrub(input).split('\n')).toEqual([
      'rcon.password=<redacted>',
      'RCONPassword=<redacted> # the agent owns it',
      'Password=',
      'server-password: "<redacted>"',
      "api_key = '<redacted>'",
      '  "RestApiToken": "<redacted>",',
      '  "Password": "",',
      'start.sh -adminpassword <redacted> -servername x',
      'java --token=<redacted> -jar x.jar',
      'Authorization: Bearer <redacted>',
      'hook https://discord.com/api/webhooks/<redacted>',
      'motd=Welcome, no secret here',
    ]);
  });

  it('turns home folders, Docker volume folders and given host roots into /data', () => {
    const s = createScrubber({ hostRoots: ['D:\\games\\capture'] });
    expect(s.scrub('C:\\Users\\yourname\\Zomboid\\Server\\x.ini')).toBe('/data/Zomboid/Server/x.ini');
    expect(s.scrub('/home/yourname/pz/log.txt and /Users/yourname/x and /c/Users/yourname/y')).toBe('/data/pz/log.txt and /data/x and /data/y');
    expect(s.scrub('/var/lib/docker/volumes/gsp-s1-srv-mc-data/_data/world')).toBe('/data/world');
    expect(s.scrub('D:\\games\\capture\\logs and D:/games/capture/x')).toBe('/data\\logs and /data/x');
    // The containers' own users are not people.
    expect(s.scrub('/home/node/steamcmd and /opt/game')).toBe('/home/node/steamcmd and /opt/game');
  });

  it('replaces every match of the local private patterns', () => {
    const s = createScrubber({ patterns: [/my-house-pc/i, /secret\.example\.net/i] });
    expect(s.scrub('host My-House-PC at secret.example.net')).toBe('host <private> at <private>');
    expect(s.counts['private-pattern']).toBe(2);
  });

  it('writes scrubbed copies of a folder, names included, skipping binaries and links, and says what it replaced', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'gsp-scrub-'));
    temp.push(base);
    const input = path.join(base, 'capture');
    mkdirSync(path.join(input, 'players', '76561198123456789'), { recursive: true });
    writeFileSync(path.join(input, 'latest.log'), 'Rick joined from 203.0.1.9\r\nhost my-house-pc\r\n');
    writeFileSync(path.join(input, 'players', '76561198123456789', 'Rick.json'), '{ "name": "Rick", "token": "t" }\n');
    writeFileSync(path.join(input, 'world.bin'), Buffer.from([1, 0, 2, 3]));
    const outside = path.join(base, 'outside.txt');
    writeFileSync(outside, 'not part of the capture');
    let linked = true;
    try {
      symlinkSync(outside, path.join(input, 'link.txt'));
    } catch {
      linked = false; // Windows without the right to make links.
    }
    const patterns = path.join(base, 'patterns');
    writeFileSync(patterns, '# local\nmy-house-pc\n');

    const out = path.join(base, 'scrubbed');
    const r = spawnSync(process.execPath, [script, input, '--out', out, '--names', 'Rick', '--patterns', patterns], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(path.join(out, 'latest.log'), 'utf8')).toBe('Player1 joined from 192.0.2.1\r\nhost <private>\r\n');
    expect(readFileSync(path.join(out, 'players', '76561198000000001', 'Player1.json'), 'utf8')).toBe('{ "name": "Player1", "token": "<redacted>" }\n');
    expect(existsSync(path.join(out, 'world.bin'))).toBe(false);
    expect(readdirSync(out).sort()).toEqual(['latest.log', 'players']);
    expect(r.stdout).toMatch(/2 file\(s\) written/);
    expect(r.stdout).toMatch(/ipv4: 1 replaced/);
    expect(r.stdout).toMatch(/skipped \(binary\): world\.bin/);
    if (linked) expect(r.stdout).toMatch(/skipped \(symbolic link\): link\.txt/);
    // The report never repeats what it found.
    expect(r.stdout).not.toMatch(/Rick|203\.0\.1\.9|my-house-pc|76561198123456789/);
    // The originals are untouched, and a second run doesn't write over the first without --force.
    expect(readFileSync(path.join(input, 'latest.log'), 'utf8')).toContain('Rick');
    expect(spawnSync(process.execPath, [script, input, '--out', out], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(process.execPath, [script, input, '--out', path.join(input, 'inside')], { encoding: 'utf8' }).status).toBe(2);
  });

  it('names the copy next to the original by default', () => {
    expect(defaultOut(path.join('cap', 'latest.log'), false)).toBe(path.join('cap', 'latest.scrubbed.log'));
    expect(defaultOut(path.join('cap', 'logs') + path.sep, true)).toBe(path.join('cap', 'logs-scrubbed'));
  });
});
