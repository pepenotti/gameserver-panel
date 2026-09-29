// Reading the console as captured from the three flavours (CON-01, SRV-07,
// PLY-01, PLY-02, BAK-02): readiness, the version, joins and leaves, saves,
// the world menu nobody answers, fatal lines, and the player list.
import { describe, expect, it } from 'vitest';
import { classify } from '../src/runtime';
import { bare, display, parsePlaying } from '../src/shared';
import { BOM, fixture, fixtureLines } from './helpers';

const signals = (lines: string[]) => lines.map(classify);

describe('the console as captured (CON-01, SRV-07)', () => {
  it.each([
    ['vanilla', 'vanilla/logs/boot-savedirectory.log', '1.4.5.8'],
    ['vanilla, an existing world', 'vanilla/logs/boot-existing-world.log', '1.4.5.8'],
    ['TShock', 'tshock/logs/first-boot.log', '1.4.5.8'],
    ['tModLoader', 'tmodloader/logs/first-boot.log', '1.4.4.9'],
  ])('%s: one ready line, the Terraria version, nothing fatal', (_what, file, version) => {
    const s = signals(fixtureLines(...file.split('/')));
    expect(s.filter((x) => x.ready)).toHaveLength(1);
    expect([...new Set(s.flatMap((x) => (x.version ? [x.version] : [])))]).toEqual([version]);
    expect(s.filter((x) => x.fatal || x.blockingPrompt)).toEqual([]);
  });

  it('says nothing is ready while a world is generated, nor when the port was taken (a silent exit 0)', () => {
    for (const file of ['first-boot-small.log', 'port-in-use.log', 'missing-world-no-autocreate.log']) {
      const s = signals(fixtureLines('vanilla', 'logs', file));
      expect(s.some((x) => x.ready), file).toBe(false);
      expect(s.filter((x) => x.fatal || x.blockingPrompt), file).toEqual([]);
    }
  });

  it('reads through the byte-order marks and the prompt printed without a newline', () => {
    expect(fixture('vanilla', 'logs', 'first-boot-small.log').startsWith(`${BOM}${BOM}Error Logging Enabled.`)).toBe(true);
    expect(classify(`${BOM}${BOM}Error Logging Enabled.`).message).toBe('Error Logging Enabled.');
    expect(classify(': Server started')).toMatchObject({ message: 'Server started', ready: true });
    expect(classify(': : gspffbob has left.')).toMatchObject({ message: 'gspffbob has left.', leave: 'gspffbob' });
    // Printed even when the port is taken (then a silent exit 0): never readiness.
    expect(classify('Listening on port 7777').ready).toBeUndefined();
  });

  it('sees joins and leaves, but not TShock\'s second join line with the address (PLY-02)', () => {
    const vanilla = signals(fixtureLines('vanilla', 'logs', 'players.log'));
    expect(vanilla.flatMap((s) => (s.join ? [s.join] : []))).toContain('gspffalice');
    expect(vanilla.flatMap((s) => (s.leave ? [s.leave] : []))).toContain('gspffalice');
    const tshock = signals(fixtureLines('tshock', 'logs', 'setup-lock-players-moderation.log'));
    expect(tshock.flatMap((s) => (s.join ? [s.join] : []))).toEqual(['gspffalice', 'gspffbob']);
    expect(tshock.flatMap((s) => (s.leave ? [s.leave] : []))).toEqual(['gspffalice', 'gspffbob']);
    expect(classify('gspffalice has joined. IP: 192.0.2.1').join).toBeUndefined();
  });

  it('marks the end of a save: the world file is complete (BAK-02)', () => {
    expect(classify(': Backing up world file').saved).toBe(true);
    expect(classify('Saving modded world data').saved).toBe(true);
    expect(classify('Saving world data: 100%').saved).toBeUndefined();
    expect(signals(fixtureLines('vanilla', 'logs', 'save-then-exit.log')).some((s) => s.saved)).toBe(true);
  });

  it.each([
    ['vanilla', 'vanilla/logs/no-args-world-menu.log'],
    ['tModLoader', 'tmodloader/logs/no-world-menu.log'],
  ])('%s: the world menu is a prompt nobody will answer', (_what, file) => {
    const s = signals(fixtureLines(...file.split('/')));
    // Anything typed redraws the menu (tModLoader's capture typed `exit`).
    expect(s.filter((x) => x.blockingPrompt).length).toBeGreaterThan(0);
    expect(s.find((x) => x.blockingPrompt)!.blockingPrompt).toMatch(/world menu/);
    expect(s.some((x) => x.ready)).toBe(false);
  });

  it.each([
    ['a corrupt world (then a silent exit 0)', 'vanilla/logs/corrupt-world-garbage.log', 'Load failed!  No backup found.'],
    ['the crash after a burst of reconnects', 'vanilla/logs/crash-reconnect-burst.log', '[ERROR] FATAL UNHANDLED EXCEPTION: System.ObjectDisposedException: Cannot access a disposed object.'],
    ['no writable save folder: no world, yet "Server started"', 'vanilla/logs/first-boot-readonly-home.log', 'Failed to create the file: "\\home\\node\\.local\\share\\Terraria\\favorites.json"!'],
    ['no .NET', 'tshock/logs/no-dotnet-runtime.log', 'You must install .NET to run this application.'],
    ['no ICU', 'tshock/logs/no-icu.log', null],
    ['no bundle folder', 'tshock/logs/bundle-extract-readonly-home.log', 'Failure processing application bundle.'],
    ['tModLoader without a writable install', 'tmodloader/logs/readonly-install-logging.log', 'tModLoader v2026.7.3.0 Fatal Error'],
  ])('fatal: %s (SRV-07)', (_what, file, line) => {
    const s = signals(fixtureLines(...file.split('/')));
    const fatal = s.filter((x) => x.fatal).map((x) => x.message);
    expect(fatal.length).toBeGreaterThan(0);
    if (line) expect(fatal).toContain(line);
  });

  it("marks .NET's own unhandled exceptions fatal, and nothing ordinary", () => {
    expect(classify("Unhandled exception. System.IO.FileNotFoundException: Could not load file or assembly 'ReLogic'").fatal).toBe(true);
    for (const l of ['Unhandled Exception', 'Invalid command.', '192.0.2.1:50212 was booted: You are not using the same version as this server.', 'No players connected.']) expect(classify(l).fatal, l).toBeUndefined();
  });
});

describe('what people see (CON-01)', () => {
  it("drops the prompt and byte-order marks, and hides TShock's setup code", () => {
    expect(display(`${BOM}${BOM}Error Logging Enabled.`)).toBe('Error Logging Enabled.');
    expect(display(': Server started')).toBe('Server started');
    expect(display('To setup the server, join the game and type /setup 1234567')).toBe('To setup the server, join the game and type /setup <hidden>');
    expect(bare(': ')).toBe('');
  });
});

describe('the player list (PLY-01)', () => {
  it("reads vanilla's and tModLoader's playing: one line per player, then the count", () => {
    expect(parsePlaying(['gspffalice (192.0.2.1:60688)', '1 player connected.'])).toEqual({ count: 1, names: ['gspffalice'] });
    expect(parsePlaying([': gspff alice (1) (192.0.2.1:1)', 'bob (192.0.2.1:2)', '192.0.2.1:3 is connecting...', '2 players connected.'])).toEqual({ count: 2, names: ['gspff alice (1)', 'bob'] });
    expect(parsePlaying([': No players connected.'])).toEqual({ count: 0, names: [] });
    expect(parsePlaying(['alice (192.0.2.1:1)'])).toBeNull();
  });

  it("reads TShock's: none, or a count and the names on the line after it", () => {
    expect(parsePlaying(['Server executed: /playing.', 'There are currently no players online.'])).toEqual({ count: 0, names: [] });
    expect(parsePlaying(['Server executed: /playing.', 'Online Players (1/8)', 'gspffbob'])).toEqual({ count: 1, names: ['gspffbob'] });
    expect(parsePlaying(['Online Players (2/8)', 'a, b'])).toEqual({ count: 2, names: ['a', 'b'] });
    expect(parsePlaying(['Server executed: /playing.', 'Online Players (2/8)'])).toBeNull();
  });

  it('reads the replies captured from the real servers', () => {
    const players = fixtureLines('vanilla', 'logs', 'players.log');
    const at = players.indexOf('gspffalice (192.0.2.1:60688)');
    expect(parsePlaying(players.slice(at))).toEqual({ count: 1, names: ['gspffalice'] });
    const tshock = fixtureLines('tshock', 'logs', 'setup-lock-players-moderation.log');
    const t = tshock.indexOf('Server executed: /playing.');
    expect(parsePlaying(tshock.slice(t))).toEqual({ count: 1, names: ['gspffbob'] });
  });
});
