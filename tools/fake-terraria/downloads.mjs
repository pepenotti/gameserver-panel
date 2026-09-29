#!/usr/bin/env node
// A stand-in for the download services a Terraria install uses, for tests and the dev loop without
// the internet: terraria.org's dedicated-server names and zips, and GitHub's release API and
// assets for TShock (Pryaxis/TShock) and tModLoader (tModLoader/tModLoader). The answers have the
// shapes captured in fixtures/terraria/1.4.5.8/*/api/ (docs/verification/terraria-1.4.5.8.md); the
// archives are tiny but real zips (and TShock's tar inside its zip) laid out like the real ones.
//
//   node downloads.mjs [--port N]      prints "fake-terraria downloads on http://127.0.0.1:N"
//   import { startFakeDownloads } from './downloads.mjs'
//
// Paths: /api/get/dedicated-servers-names, /api/download/pc-dedicated-server/terraria-server-<id>.zip
// (terraria.org); /repos/<owner>/<repo>/releases[/latest|/tags/<tag>] (GitHub API);
// /<owner>/<repo>/releases/download/<tag>/<asset> (GitHub assets); a fake TShock plugin's release,
// /gspff/HelloPlugin/releases/{download/v1.0.0,latest/download}/<file>, redirected to the asset
// host like github.com's (HelloPlugin.dll, HelloPlugins.zip, NotAPlugin.dll, Escape.zip with a path
// outside its folder, Huge.dll one byte over 16 MiB, Notes.txt, Elsewhere.dll sent on to another
// host). GET /__requests lists what was asked, with each request's User-Agent. GitHub answers carry
// x-ratelimit-* headers: 60 an hour, every request counts, a conditional one answered 304 too
// (measured).
// Failures (FAKE_TERRARIA_DOWNLOAD_FAIL, or the `fail` option): bad-checksum (assets don't match the
// published digest; terraria.org publishes none, so its zips come truncated) | not-found (every
// file is a 404) | rate-limit (every GitHub API call is a 403 "API rate limit exceeded", the shape
// GitHub documents: not captured, the fact-finding didn't spend the host's hourly budget)
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------ archives
/**
 * A zip of stored (uncompressed) entries. `unix` marks entries as made on Unix with their mode (as
 * tModLoader's zip); without it no mode is stored (as terraria.org's zip: nothing is executable).
 * @param {{ name: string; data: Buffer | string; mode?: number }[]} entries
 */
// 2026-08-23 18:39:50 in DOS form (the date of the 1.4.5.8 zip)
const DOS_TIME = (18 << 11) | (39 << 5) | 25;
const DOS_DATE = ((2026 - 1980) << 9) | (8 << 5) | 23;
export function makeZip(entries, { unix = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const crc = zlib.crc32(data);
    const dir = e.name.endsWith('/');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(unix ? 0x031e : 0x0014, 4); // made by: Unix 3.0, or MS-DOS 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 30); // extra, comment lengths
    central.writeUInt32LE(0, 34); // disk, internal attributes
    const mode = e.mode ?? (dir ? 0o40755 : 0o100644);
    central.writeUInt32LE(unix ? ((mode << 16) >>> 0) : dir ? 0x10 : 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A ustar archive (TShock's release zip holds one of these, and it keeps the exec bits). */
export function makeTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const dir = e.name.endsWith('/');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write(`${(e.mode ?? (dir ? 0o755 : 0o644)).toString(8).padStart(7, '0')}\0`, 100);
    h.write('0001750\0', 108); // uid 1000
    h.write('0001750\0', 116);
    h.write(`${(dir ? 0 : data.length).toString(8).padStart(11, '0')}\0`, 124);
    h.write(`${Math.floor(Date.parse('2026-09-27T14:43:00Z') / 1000).toString(8).padStart(11, '0')}\0`, 136);
    h.write('        ', 148);
    h.write(dir ? '5' : '0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h);
    if (!dir) {
      blocks.push(data);
      if (data.length % 512) blocks.push(Buffer.alloc(512 - (data.length % 512)));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const script = (what) => `#!/bin/sh\necho "FAKE ${what}: tests start tools/fake-terraria/server.mjs instead"\nexit 1\n`;

/** terraria-server-<id>.zip: <id>/{Linux,Windows,Mac}; nothing marked executable (measured). */
function vanillaZip(id) {
  const L = `${id}/Linux/`;
  return makeZip([
    { name: `${id}/`, data: '' },
    { name: L, data: '' },
    { name: `${L}TerrariaServer`, data: '#!/bin/bash\n# MonoKickstart Shell Script (FAKE)\ncd "`dirname "$0"`"\nexport MONO_IOMAP=all\n./TerrariaServer.bin.x86_64 $@\n' },
    { name: `${L}TerrariaServer.bin.x86_64`, data: script(`TerrariaServer.bin.x86_64 ${id}`) },
    { name: `${L}TerrariaServer.exe`, data: `FAKE TerrariaServer.exe ${id}\n` },
    { name: `${L}monoconfig`, data: '<configuration>\n</configuration>\n' },
    { name: `${L}lib64/`, data: '' },
    { name: `${L}lib64/libSDL3.so.0`, data: 'FAKE\n' },
    { name: `${L}changelog.txt`, data: `Version ${id} Changes (FAKE)\n` },
    { name: `${id}/Windows/`, data: '' },
    { name: `${id}/Windows/TerrariaServer.exe`, data: 'FAKE\n' },
    { name: `${id}/Windows/serverconfig.txt`, data: '#world=\n#autocreate=\n#port=\n' },
    { name: `${id}/Mac/`, data: '' },
  ]);
}

/** TShock-<v>-for-Terraria-<t>-linux-<arch>-Release.zip: one tar, TShock.Server executable in it. */
function tshockZip(version, arch) {
  const tar = makeTar([
    { name: 'GeoIP.dat', data: 'FAKE GeoIP\n' },
    { name: 'ServerPlugins/' },
    { name: 'ServerPlugins/TShockAPI.dll', data: `FAKE TShockAPI ${version}\n` },
    { name: 'TShock.Installer', data: script('TShock.Installer'), mode: 0o755 },
    { name: 'TShock.Server', data: script(`TShock.Server ${version} ${arch}`), mode: 0o755 },
    { name: 'bin/' },
    { name: 'bin/OTAPI.dll', data: 'FAKE OTAPI\n', mode: 0o744 },
    { name: 'bin/TerrariaServer.dll', data: 'FAKE\n' },
    { name: 'i18n/' },
  ]);
  return makeZip([{ name: `TShock-Beta-linux-${arch}-Release.tar`, data: tar }], { unix: true });
}

/** tModLoader.zip: the release folder at the top, scripts not executable (measured). */
function tmlZip(tag) {
  return makeZip(
    [
      { name: 'tModLoader.dll', data: `FAKE tModLoader ${tag}\n` },
      { name: 'tModLoader.runtimeconfig.json', data: '{\n  "runtimeOptions": {\n    "tfm": "net8.0",\n    "framework": {\n      "name": "Microsoft.NETCore.App",\n      "version": "8.0.0"\n    }\n  }\n}' },
      { name: 'start-tModLoaderServer.sh', data: script('start-tModLoaderServer.sh') },
      { name: 'serverconfig.txt', data: '#world=\n#autocreate=\n#modpath=\n' },
      { name: 'LaunchUtils/', data: '' },
      { name: 'LaunchUtils/ScriptCaller.sh', data: script('ScriptCaller.sh') },
      { name: 'Libraries/', data: '' },
      { name: 'Libraries/Native/', data: '' },
      { name: 'Libraries/Native/Linux/', data: '' },
      { name: 'Libraries/Native/Linux/libSDL2-2.0.so.0', data: 'FAKE\n' },
    ],
    { unix: true },
  );
}

// ------------------------------------------------------------------ TShock plugins (MOD-06)
/**
 * A fake TShock plugin: it starts like every .NET assembly (`MZ`), and
 * `server.mjs` loads it from `ServerPlugins/` by its marker line, printing
 * the line TShock prints for a plugin it initialised. Without the marker
 * (`fakeAssembly`) it is an assembly that isn't a plugin: TShock ignores it
 * without a word (measured).
 */
export function fakePlugin(name, version = '1.0.0', author = 'gspff') {
  return Buffer.from(`MZ\u0090\u0000 FAKE .NET assembly\nFAKE-TSHOCK-PLUGIN name=${name} version=${version} author=${author}\n`, 'latin1');
}
export function fakeAssembly(name) {
  return Buffer.from(`MZ\u0090\u0000 FAKE .NET assembly ${name}, not a plugin\n`, 'latin1');
}

/** Largest plugin the panel takes (16 MiB): `Huge.dll` is one byte more. */
const PLUGIN_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Release assets of a fake plugin repository (`gspff/HelloPlugin`), served
 * the way github.com serves release downloads: a 302 to the asset host
 * (measured: `release-assets.githubusercontent.com`), here `/__release-assets/`
 * on the same server. `latest/download/<file>` redirects to the tag first.
 */
const PLUGIN_REPO = { owner: 'gspff', repo: 'HelloPlugin', tag: 'v1.0.0' };
function pluginAssets() {
  return new Map([
    ['HelloPlugin.dll', () => fakePlugin('HelloPlugin')],
    ['HelloPlugins.zip', () => makeZip([{ name: 'ServerPlugins/', data: '' }, { name: 'ServerPlugins/HelloPlugin.dll', data: fakePlugin('HelloPlugin', '1.1.0') }, { name: 'ServerPlugins/HelloLib.dll', data: fakeAssembly('HelloLib') }, { name: 'README.md', data: '# HelloPlugin (FAKE)\n' }])],
    ['NotAPlugin.dll', () => Buffer.from('just some text\n')],
    ['Escape.zip', () => makeZip([{ name: '../Escape.dll', data: fakePlugin('Escape') }])],
    ['Huge.dll', () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(PLUGIN_MAX_BYTES - 1)])],
    ['Notes.txt', () => Buffer.from('not a plugin\n')],
  ]);
}

// ------------------------------------------------------------------ catalogue (as measured on 2026-09-29)
const VANILLA = [
  { id: '1458', lastModified: 'Sun, 23 Aug 2026 18:39:51 GMT' },
  { id: '1457', lastModified: 'Wed, 19 Aug 2026 20:34:33 GMT' },
  { id: '1449', lastModified: 'Thu, 17 Nov 2022 16:30:15 GMT' },
];
const TSHOCK = [
  { tag: 'v6.2.1', name: 'TShock 6.2.1 for Terraria 1.4.5.8', prerelease: false, terraria: '1.4.5.8', published: '2026-09-27T14:57:16Z', archs: ['arm', 'arm64', 'x64'], naming: 'x64' },
  { tag: 'v6.1.0', name: 'TShock 6.1 for Terraria 1.4.5.6', prerelease: false, terraria: '1.4.5.6', published: '2026-03-11T18:42:52Z', archs: ['arm', 'arm64', 'x64'], naming: 'x64' },
  { tag: 'v6.0.0-pre3', name: 'TShock 6 for Terraria 1.4.5.5 Pre-release 2 (B) (.NET 9)', prerelease: true, terraria: '1.4.5.5', published: '2026-03-07T06:49:18Z', archs: ['arm', 'arm64', 'x64'], naming: 'beta' },
  { tag: 'v5.2.4', name: 'TShock 5.2.4 for Terraria 1.4.4.9', prerelease: false, terraria: '1.4.4.9', published: '2025-05-09T09:23:08Z', archs: ['amd64', 'arm64'], naming: 'amd64' },
];
const TML = [
  { tag: 'v2026.08.2.2', name: '1.4.4-refs/heads/preview Version Update: v2026.08.2.2', prerelease: true, published: '2026-09-23T01:07:55Z' },
  { tag: 'v2026.07.3.0', name: '1.4.4-refs/heads/stable Version Update: v2026.07.3.0', prerelease: false, published: '2026-09-01T00:11:46Z' },
  { tag: 'v2026.06.3.6', name: '1.4.4-refs/heads/stable Version Update: v2026.06.3.6', prerelease: false, published: '2026-08-13T02:54:26Z' },
];

export async function startFakeDownloads({ port = 0, host = '127.0.0.1', fail = process.env.FAKE_TERRARIA_DOWNLOAD_FAIL ?? '' } = {}) {
  const requests = [];
  let base = '';
  let used = 0;
  const reset = Math.floor(Date.now() / 1000) + 3600;
  /** Files by path, with the digest GitHub publishes for them. */
  const files = new Map();
  const put = (p, bytes) => {
    const published = fail === 'bad-checksum' ? sha256(Buffer.concat([bytes, Buffer.from('other')])) : sha256(bytes);
    files.set(p, { bytes: fail === 'bad-checksum' && p.startsWith('/api/download/') ? bytes.subarray(0, bytes.length - 40) : bytes, digest: `sha256:${published}` });
    return files.get(p);
  };
  for (const v of VANILLA) put(`/api/download/pc-dedicated-server/terraria-server-${v.id}.zip`, vanillaZip(v.id));
  const asset = (owner, repo, tag, name, bytes, type = 'application/zip') => {
    const f = put(`/${owner}/${repo}/releases/download/${tag}/${name}`, bytes);
    return () => ({ name, size: f.bytes.length, content_type: type, digest: f.digest, browser_download_url: `${base}/${owner}/${repo}/releases/download/${tag}/${name}` });
  };
  const tshockReleases = TSHOCK.map((r) => {
    const v = r.tag.replace(/^v/, '').replace(/-pre\d+$/, '');
    const assets = r.archs.map((a) => {
      const name = r.naming === 'beta' ? `TShock-Beta-linux-${a}-Release.zip` : `TShock-${v}-for-Terraria-${r.terraria}-linux-${a}-Release.zip`;
      return asset('Pryaxis', 'TShock', r.tag, name, tshockZip(v, a === 'amd64' ? 'x64' : a));
    });
    return () => ({ tag_name: r.tag, name: r.name, prerelease: r.prerelease, draft: false, published_at: r.published, html_url: `https://github.com/Pryaxis/TShock/releases/tag/${r.tag}`, body: 'FAKE release notes', assets: assets.map((x) => x()) });
  });
  const tmlReleases = TML.map((r) => {
    const assets = [asset('tModLoader', 'tModLoader', r.tag, 'tModLoader.zip', tmlZip(r.tag)), asset('tModLoader', 'tModLoader', r.tag, 'ExampleMod.zip', makeZip([{ name: 'ExampleMod/', data: '' }], { unix: true }))];
    return () => ({ tag_name: r.tag, name: r.name, prerelease: r.prerelease, draft: false, published_at: r.published, html_url: `https://github.com/tModLoader/tModLoader/releases/tag/${r.tag}`, body: 'FAKE', assets: assets.map((x) => x()) });
  });

  const pluginFiles = pluginAssets();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    requests.push({ method: req.method, path: `${p}${url.search}`, userAgent: req.headers['user-agent'] ?? null });
    const send = (status, body, headers = {}) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const type = Buffer.isBuffer(body) ? 'application/zip' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
      res.writeHead(status, { 'content-type': type, 'content-length': buf.length, ...headers });
      res.end(req.method === 'HEAD' ? undefined : buf);
    };
    if (p === '/__requests') return send(200, requests.slice(0, -1));
    // ---- terraria.org
    if (p === '/api/get/dedicated-servers-names') return send(200, ['terraria-server-1458.zip', 'terraria-server-1458.zip']);
    if (p.startsWith('/api/download/pc-dedicated-server/')) {
      const f = files.get(p);
      if (!f || fail === 'not-found') return send(404, 'Not Found');
      const id = /terraria-server-(\d+)\.zip$/.exec(p)[1];
      return send(200, f.bytes, { 'content-disposition': `attachment; filename="terraria-server-${id}.zip"`, 'last-modified': VANILLA.find((v) => v.id === id).lastModified, 'accept-ranges': 'bytes' });
    }
    // ---- GitHub API (every call counts against the hourly 60, a 304 too)
    let m;
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/releases(?:\/(latest|tags\/[^/]+))?$/.exec(p))) {
      used++;
      const limits = { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': String(Math.max(0, 60 - used)), 'x-ratelimit-used': String(used), 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'core' };
      if (fail === 'rate-limit') return send(403, { message: 'API rate limit exceeded for 192.0.2.1. (But here\'s the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)', documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting' }, { ...limits, 'x-ratelimit-remaining': '0' });
      const list = m[1] === 'Pryaxis' && m[2] === 'TShock' ? tshockReleases : m[1] === 'tModLoader' && m[2] === 'tModLoader' ? tmlReleases : null;
      if (!list) return send(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }, limits);
      let body;
      if (!m[3]) body = list.map((r) => r()).slice(0, Number(url.searchParams.get('per_page') ?? 30));
      else if (m[3] === 'latest') body = list.map((r) => r()).find((r) => !r.prerelease);
      else body = list.map((r) => r()).find((r) => r.tag_name === decodeURIComponent(m[3].slice(5)));
      if (!body) return send(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/releases/releases' }, limits);
      const etag = `W/"${sha256(JSON.stringify(body))}"`;
      const headers = { ...limits, etag, 'cache-control': 'public, max-age=60, s-maxage=60' };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      return send(200, body, headers);
    }
    // ---- a plugin's GitHub release assets: github.com redirects to the asset host
    const pr = `/${PLUGIN_REPO.owner}/${PLUGIN_REPO.repo}/releases/`;
    if (p.startsWith(pr)) {
      if (fail === 'not-found') return send(404, 'Not Found');
      const rest = p.slice(pr.length);
      if (rest.startsWith('latest/download/')) return send(302, '', { location: `${pr}download/${PLUGIN_REPO.tag}/${rest.slice('latest/download/'.length)}` });
      const file = rest.startsWith(`download/${PLUGIN_REPO.tag}/`) ? decodeURIComponent(rest.slice(`download/${PLUGIN_REPO.tag}/`.length)) : null;
      // Sent on to another host than the one the link names (localhost for 127.0.0.1): a download must refuse it.
      if (file === 'Elsewhere.dll') return send(302, '', { location: `http://localhost:${server.address().port}/__release-assets/HelloPlugin.dll` });
      if (file !== null && pluginFiles.has(file)) return send(302, '', { location: `${base}/__release-assets/${encodeURIComponent(file)}` });
      return send(404, 'Not Found');
    }
    if (p.startsWith('/__release-assets/')) {
      const make = pluginFiles.get(decodeURIComponent(p.slice('/__release-assets/'.length)));
      if (!make) return send(404, 'Not Found');
      return send(200, make(), { 'content-type': 'application/octet-stream' });
    }
    // ---- GitHub assets
    if (/^\/[^/]+\/[^/]+\/releases\/download\//.test(p)) {
      const f = files.get(p);
      if (!f || fail === 'not-found') return send(404, 'Not Found');
      return send(200, f.bytes, { 'content-type': 'application/octet-stream' });
    }
    return send(404, 'Not Found');
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  base = `http://${host}:${server.address().port}`;
  return {
    url: base,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port');
  const s = await startFakeDownloads({ port: i > 0 ? Number(process.argv[i + 1]) : 0 });
  console.log(`fake-terraria downloads on ${s.url}`);
}
