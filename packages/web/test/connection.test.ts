// How players join, in the web (SRV-08): the message a Share sends, in
// English and Spanish, and copying and sharing with their fallbacks (the
// Clipboard API missing or refused, no share sheet, a share sheet closed).
// The address form's own check is HST-08's.
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import type { ConnectionInfo } from '@gsp/shared';
import { en } from '../src/i18n/en';
import { es } from '../src/i18n/es';
import { addressProblemKey, clientLine, copyText, shareMessage, shareText, type PageLike, type TextArea, type Translate } from '../src/lib/connection';

async function translator(lng: 'en' | 'es'): Promise<Translate> {
  const i = i18next.createInstance();
  await i.init({ resources: { en: { translation: en }, es: { translation: es } }, lng, fallbackLng: 'en', interpolation: { escapeValue: false } });
  return (key, o) => i.t(key, o);
}

const both = (en: string, es = en) => ({ en, es });

/** A game players join with host:port, its whitelist on, a password set, measured with a real client. */
function info(over: Partial<ConnectionInfo> = {}): ConnectionInfo {
  return {
    server: { id: 'mc', name: 'Friends' },
    game: both('Blockgame'),
    port: { id: 'game', number: 30450, proto: 'tcp', label: both('Game port', 'Puerto del juego') },
    format: 'host:port',
    defaultPort: 25565,
    where: both('Multiplayer, then Direct Connection', 'Multijugador, luego Conexión directa'),
    client: { name: both('Blockgame'), sameVersion: true, version: '26.3' },
    places: [
      { place: 'pc', address: '127.0.0.1', text: '127.0.0.1:30450' },
      { place: 'home', address: '192.168.1.50', text: '192.168.1.50:30450' },
      { place: 'internet', address: 'example.duckdns.org', text: 'example.duckdns.org:30450' },
    ],
    password: { game: true, set: true, value: 'hunter-22', canInclude: true },
    steps: [{ id: 'whitelist', text: both('Ask an admin to add your name.', 'Pedile a un administrador que agregue tu nombre.'), applies: 'yes' }],
    forwards: [{ id: 'game', port: 30450, proto: 'tcp', label: both('Game port'), typed: true }],
    verified: true,
    source: 'test',
    note: null,
    publicAddress: { set: true, canSet: false },
    ...over,
  };
}

describe('the message a Share sends (SRV-08)', () => {
  it('lists the internet first, then home and this PC, where to type it, the client and its version, and the steps', async () => {
    const t = await translator('en');
    expect(shareMessage(info(), t, 'en')).toBe(
      [
        'Join Friends (Blockgame)',
        'From the internet: example.duckdns.org:30450',
        'On the home network: 192.168.1.50:30450',
        'On this PC: 127.0.0.1:30450',
        'Where: Multiplayer, then Direct Connection',
        'Game: Blockgame 26.3',
        'It has a password: ask an admin for it.',
        '- Ask an admin to add your name.',
      ].join('\n'),
    );
  });

  it('carries the password only when it was asked for and given', async () => {
    const t = await translator('en');
    expect(shareMessage(info(), t, 'en', { includePassword: true })).toContain('Password: hunter-22');
    expect(shareMessage(info({ password: { game: true, set: true, value: null, canInclude: false } }), t, 'en', { includePassword: true })).not.toContain('Password:');
    expect(shareMessage(info({ password: { game: true, set: false, value: null, canInclude: true } }), t, 'en', { includePassword: true })).not.toMatch(/password/i);
    expect(shareMessage(info({ password: { game: false, set: false, value: null, canInclude: false } }), t, 'en')).not.toMatch(/password/i);
  });

  it('skips places without an address, and says the address and port apart for a game that asks for them so', async () => {
    const t = await translator('en');
    const separate = info({
      format: 'separate',
      defaultPort: null,
      places: [
        { place: 'pc', address: '127.0.0.1', text: '127.0.0.1' },
        { place: 'home', address: null, text: null },
        { place: 'internet', address: null, text: null },
      ],
    });
    const lines = shareMessage(separate, t, 'en').split('\n');
    expect(lines.filter((l) => /^(From the internet|On the home network|On this PC)/.test(l))).toEqual(['On this PC: address 127.0.0.1, port 30450']);
  });

  it('says what may apply and what is unverified, in the game’s own note when it has one', async () => {
    const t = await translator('en');
    const unsure = info({ verified: false, steps: [{ id: 'x', text: both('Make an account.'), applies: 'unknown' }] });
    expect(shareMessage(unsure, t, 'en').split('\n').slice(-2)).toEqual(['- (may apply) Make an account.', 'Not yet checked with a real client.']);
    const noted = info({ verified: false, note: both('Unverified: try the next port if that fails.', 'Sin verificar: probá el siguiente puerto si falla.') });
    expect(shareMessage(noted, t, 'en').split('\n').at(-1)).toBe('Unverified: try the next port if that fails.');
  });

  it('is written in Spanish for a Spanish reader, the game’s words included', async () => {
    const t = await translator('es');
    const text = shareMessage(info({ verified: false }), t, 'es', { includePassword: true });
    expect(text.split('\n')).toEqual([
      'Entrá a Friends (Blockgame)',
      'Desde internet: example.duckdns.org:30450',
      'En la red de casa: 192.168.1.50:30450',
      'En esta PC: 127.0.0.1:30450',
      'Dónde: Multijugador, luego Conexión directa',
      'Juego: Blockgame 26.3',
      'Contraseña: hunter-22',
      '- Pedile a un administrador que agregue tu nombre.',
      'Todavía sin comprobar con un cliente real.',
    ]);
  });

  it('names the client with the server’s version only when it must match and is known', () => {
    expect(clientLine(info(), 'en')).toBe('Blockgame 26.3');
    expect(clientLine(info({ client: { name: both('Blockgame'), sameVersion: true, version: null } }), 'en')).toBe('Blockgame');
    expect(clientLine(info({ client: { name: both('Blockgame'), sameVersion: false, version: '26.3' } }), 'en')).toBe('Blockgame');
  });
});

/** A page whose copy command works (or not), recording what it was given. */
function fakePage(works = true) {
  const areas: (TextArea & { appended: boolean; removed: boolean; selected: boolean; attrs: Record<string, string> })[] = [];
  const commands: string[] = [];
  const page: PageLike = {
    body: {
      appendChild: (a) => {
        (a as (typeof areas)[number]).appended = true;
      },
    },
    createElement: () => {
      const a = {
        value: '',
        style: { position: '', top: '', opacity: '' },
        attrs: {} as Record<string, string>,
        appended: false,
        removed: false,
        selected: false,
        setAttribute(n: string, v: string) {
          this.attrs[n] = v;
        },
        select() {
          this.selected = true;
        },
        remove() {
          this.removed = true;
        },
      };
      areas.push(a);
      return a;
    },
    execCommand: (c) => {
      commands.push(`${c}:${areas.at(-1)?.value}`);
      return works;
    },
  };
  return { page, areas, commands };
}

describe('copying (SRV-08)', () => {
  it('uses the Clipboard API when it is there', async () => {
    const written: string[] = [];
    const { page, commands } = fakePage();
    expect(await copyText('203.0.113.7:30450', { clipboard: { writeText: async (s) => void written.push(s) }, page })).toBe(true);
    expect(written).toEqual(['203.0.113.7:30450']);
    expect(commands).toEqual([]);
  });

  it('falls back to a hidden, read-only text area and the copy command, and cleans up after it', async () => {
    for (const clipboard of [null, { writeText: () => Promise.reject(new Error('NotAllowedError')) }]) {
      const { page, areas, commands } = fakePage();
      expect(await copyText('line', { clipboard, page })).toBe(true);
      expect(commands).toEqual(['copy:line']);
      expect(areas).toHaveLength(1);
      expect(areas[0]).toMatchObject({ appended: true, selected: true, removed: true, attrs: { readonly: '' }, style: { position: 'fixed', opacity: '0' } });
    }
  });

  it('says it could not copy when nothing worked', async () => {
    expect(await copyText('x', { clipboard: null, page: null })).toBe(false);
    const { page, areas } = fakePage(false);
    expect(await copyText('x', { clipboard: null, page })).toBe(false);
    expect(areas[0]!.removed).toBe(true);
  });
});

describe('sharing (SRV-08)', () => {
  const data = { title: 'Join Friends', text: 'the whole message' };

  it("opens the phone's share sheet with the title and the whole message", async () => {
    const shared: unknown[] = [];
    const { page, commands } = fakePage();
    expect(await shareText(data, { share: async (d) => void shared.push(d), page })).toBe('shared');
    expect(shared).toEqual([data]);
    expect(commands).toEqual([]);
  });

  it('copies nothing when the person closes the sheet', async () => {
    const { page, commands } = fakePage();
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    expect(await shareText(data, { share: () => Promise.reject(abort), page })).toBe('cancelled');
    expect(commands).toEqual([]);
  });

  it('copies the whole message without a share sheet, when it fails, or when it can’t take the message', async () => {
    for (const env of [{ share: null }, { share: () => Promise.reject(new Error('NotAllowedError')) }, { share: async () => undefined, canShare: () => false }]) {
      const written: string[] = [];
      expect(await shareText(data, { ...env, clipboard: { writeText: async (s) => void written.push(s) } })).toBe('copied');
      expect(written).toEqual(['the whole message']);
    }
    expect(await shareText(data, { share: null, clipboard: null, page: null })).toBe('failed');
  });
});

describe('the address form (HST-08)', () => {
  it('names the problem the API would, and takes an empty field (the default)', () => {
    expect(addressProblemKey('')).toBeNull();
    expect(addressProblemKey('example.duckdns.org')).toBeNull();
    expect(addressProblemKey('203.0.113.7')).toBeNull();
    expect(addressProblemKey('https://example.duckdns.org')).toBe('hostSettings.address.problems.scheme');
    expect(addressProblemKey('example.duckdns.org:8443')).toBe('hostSettings.address.problems.port');
    expect(addressProblemKey('example.org/x')).toBe('hostSettings.address.problems.path');
    expect(addressProblemKey('no way')).toBe('hostSettings.address.problems.invalid');
    // Every problem has its words, in both languages.
    for (const p of ['empty', 'too-long', 'scheme', 'path', 'port', 'invalid'] as const) {
      expect(en.hostSettings.address.problems[p]).toBeTruthy();
      expect(es.hostSettings.address.problems[p]).toBeTruthy();
    }
  });
});
