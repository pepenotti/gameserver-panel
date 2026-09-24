import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { addedLines, messageLines, parsePatternList, scanLine, scanText } from './privacy.mjs';

// Made-up values only, assembled at runtime so this file passes the check itself.
const win = (...parts: string[]) => parts.join('\\');
const mail = (local: string, domain: string) => `${local}@${domain}`;
const rules = (line: string, patterns = parsePatternList('').patterns) => scanLine(line, patterns).map((h) => h.rule);

describe('generic checks', () => {
  it('flags home folders of real-looking users', () => {
    expect(rules(`see ${win('C:', 'Users', 'carol', 'repos')}`)).toEqual(['home-path']);
    expect(rules(`cd ${['D:', 'Users', 'carol'].join('/')}/x`)).toEqual(['home-path']);
    expect(rules(`open ${'/Users/' + 'carol'}/Library`)).toEqual(['home-path']);
    expect(rules(`cd ${'/c/Users/' + 'carol'}/repos`)).toEqual(['home-path']);
    expect(rules(`ls ${'/home/' + 'carol'}/.ssh`)).toEqual(['home-path']);
  });

  it('allows service accounts and placeholders', () => {
    expect(rules('HOME=/home/node')).toEqual([]);
    expect(rules("Redirecting stderr to '/home/pz/Steam/logs/stderr.txt'")).toEqual([]);
    expect(rules(win('C:', 'Users', '<you>', 'repos'))).toEqual([]);
    expect(rules(win('C:', 'Users', 'yourname', 'repos'))).toEqual([]);
    expect(rules(win('C:', 'Users', '%USERNAME%', 'repos'))).toEqual([]);
    expect(rules('/home/$USER/backups')).toEqual([]);
    expect(rules('GET /api/Users/carol')).toEqual([]); // a URL path, not a home folder
  });

  it('flags e-mail addresses except example, .example and noreply ones', () => {
    expect(rules(`contact ${mail('carol', 'mail.test')}`)).toEqual(['email']);
    expect(rules(mail('carol.smith+pz', 'provider.co.uk'))).toEqual(['email']);
    expect(rules('alice@example.com bob@example.org ops@panel.example.net')).toEqual([]);
    expect(rules('admin@host.example')).toEqual([]);
    expect(rules(mail('12345+someone', 'users.noreply.github.com'))).toEqual([]);
    expect(rules('import x from "@gsp/shared"; vite@8.3.0')).toEqual([]);
  });
});

describe('local pattern list', () => {
  it('numbers pattern lines from 1, skipping comments and blanks, case-insensitively', () => {
    const { patterns, invalid } = parsePatternList('# people\nzorblax\n\n  # hosts\nquux-\\d+\\.lan\n');
    expect(patterns.map((p) => p.index)).toEqual([1, 2]);
    expect(invalid).toEqual([]);
    const hits = scanText('ok\nZORBLAX was here\nping quux-7.lan', patterns);
    expect(hits).toEqual([
      { line: 2, col: 1, rule: 'private pattern #1' },
      { line: 3, col: 6, rule: 'private pattern #2' },
    ]);
  });

  it('reports invalid regexes by number', () => {
    const { patterns, invalid } = parsePatternList('good\n(unclosed\nalso-good');
    expect(patterns.map((p) => p.index)).toEqual([1, 3]);
    expect(invalid).toEqual([2]);
  });
});

describe('commit messages and patches', () => {
  it('ignores comment lines and everything below the scissors line', () => {
    const msg = 'M0: subject\n\nbody\n# a comment zorblax\nlast\n# ------------------------ >8 ------------------------\nzorblax in the diff\n';
    expect(messageLines(msg).map((l) => l.text)).toEqual(['M0: subject', '', 'body', 'last']);
    expect(messageLines(msg).map((l) => l.line)).toEqual([1, 2, 3, 5]);
  });

  it('extracts added lines with their commit, path and new line number', () => {
    const patch = [
      '\x01aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '',
      'diff --git a/docs/x.md b/docs/x.md',
      'index 1..2 100644',
      '--- a/docs/x.md',
      '+++ b/docs/x.md',
      '@@ -3,0 +4,2 @@ heading',
      '+first added',
      '++ starts with a plus',
      '@@ -10 +12 @@',
      '-old',
      '+replaced',
      'diff --git a/gone.txt b/gone.txt',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/logo.png b/logo.png',
      'Binary files /dev/null and b/logo.png differ',
    ].join('\n');
    expect(addedLines(patch)).toEqual([
      { commit: 'a'.repeat(40), path: 'docs/x.md', line: 4, text: 'first added' },
      { commit: 'a'.repeat(40), path: 'docs/x.md', line: 5, text: '+ starts with a plus' },
      { commit: 'a'.repeat(40), path: 'docs/x.md', line: 12, text: 'replaced' },
    ]);
  });
});

describe('check-private.mjs --message', () => {
  const script = fileURLToPath(new URL('../check-private.mjs', import.meta.url));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-privacy-'));
  const patterns = path.join(dir, 'patterns');
  writeFileSync(patterns, '# test list\nzorblax\n');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (message: string) => {
    const file = path.join(dir, 'COMMIT_EDITMSG');
    writeFileSync(file, message);
    return spawnSync(process.execPath, [script, '--message', file, '--patterns', patterns], { encoding: 'utf8' });
  };

  it('passes a clean message', () => {
    const r = run('M0: add the privacy check\n\nNFR-09\n# zorblax only in a comment\n');
    expect(r.status).toBe(0);
  });

  it('fails on a listed string or a home path and never prints what matched', () => {
    const r = run(`M0: thanks Zorblax\n\nfrom ${win('C:', 'Users', 'carol')}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('commit message:1:');
    expect(r.stderr).toContain('private pattern #1');
    expect(r.stderr).toContain('commit message:3:');
    expect(r.stderr).toContain('home-path');
    expect(r.stderr.toLowerCase()).not.toContain('zorblax');
    expect(r.stderr).not.toContain('carol');
  });

  it('refuses an invalid local pattern without printing it', () => {
    writeFileSync(path.join(dir, 'bad'), 'fine\n(zorblax\n');
    const file = path.join(dir, 'MSG');
    writeFileSync(file, 'M0\n');
    const r = spawnSync(process.execPath, [script, '--message', file, '--patterns', path.join(dir, 'bad')], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('#2');
    expect(r.stderr).not.toContain('zorblax');
  });
});
