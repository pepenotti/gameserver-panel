#!/usr/bin/env node
// A stand-in for the download services a Minecraft install uses, for tests and the dev loop
// without the internet: Mojang's version manifest and files (piston-meta / piston-data), PaperMC's
// Fill v3 API and its files, Fabric's meta API and maven. The answers have the shapes captured in
// fixtures/minecraft/26.3/*/api/ (docs/verification/minecraft-26.3.md); the jars are a few bytes
// whose published checksums match — unless a failure is asked for.
//
//   node downloads.mjs [--port N]      prints "fake-minecraft downloads on http://127.0.0.1:N"
//   import { startFakeDownloads } from './downloads.mjs'
//
// Every service lives under one base URL: /mc/game/…, /v1/packages/…, /v1/objects/… (Mojang),
// /v3/projects/paper/… and /v1/objects/… (Paper), /v2/versions/… (Fabric meta), /maven/… (Fabric
// maven). GET /__requests lists what was asked, with each request's User-Agent.
// Failures (FAKE_MC_DOWNLOAD_FAIL, or the `fail` option): bad-checksum (files don't match what the
// API publishes) | not-found (every file is a 404) | rate-limit (every API call is a 429 with
// Retry-After: 1)
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const sha = (alg, buf) => crypto.createHash(alg).update(buf).digest('hex');
const jarBytes = (what) => Buffer.from(`FAKE-MINECRAFT ${what}\n`, 'utf8');

/** Releases and their Java majors, as the real manifest declares them (fixtures/minecraft/26.3/vanilla/api/java-matrix.json). */
const MOJANG = [
  { id: '26.4-snapshot-1', type: 'snapshot', java: 25, component: 'java-runtime-epsilon', time: '2026-09-22T13:38:53+00:00' },
  { id: '26.3', type: 'release', java: 25, component: 'java-runtime-epsilon', time: '2026-09-15T11:23:02+00:00' },
  { id: '26.2', type: 'release', java: 25, component: 'java-runtime-epsilon', time: '2026-06-16T12:03:33+00:00' },
  { id: '1.21.11', type: 'release', java: 21, component: 'java-runtime-delta', time: '2025-12-09T12:23:30+00:00' },
  { id: '1.20.6', type: 'release', java: 21, component: 'java-runtime-delta', time: '2024-04-29T12:00:00+00:00' },
  { id: '1.20.4', type: 'release', java: 17, component: 'java-runtime-gamma', time: '2023-12-07T12:00:00+00:00' },
  { id: '1.17.1', type: 'release', java: 16, component: 'java-runtime-alpha', time: '2021-07-06T12:00:00+00:00' },
  { id: '1.16.5', type: 'release', java: 8, component: 'jre-legacy', time: '2021-01-14T12:00:00+00:00' },
];
/** Paper builds, newest first per version; a new version has only ALPHA builds for weeks (measured on 26.3). */
const PAPER = {
  '26.3': { status: 'SUPPORTED', java: 25, builds: [41, 40, 39].map((id) => ({ id, channel: 'ALPHA' })) },
  '26.2': { status: 'SUPPORTED', java: 25, builds: [{ id: 129, channel: 'STABLE' }, { id: 128, channel: 'STABLE' }, { id: 82, channel: 'BETA' }, { id: 58, channel: 'ALPHA' }] },
  '1.21.11': { status: 'UNSUPPORTED', java: 21, builds: [{ id: 132, channel: 'STABLE' }] },
};
const FABRIC = {
  game: [
    { version: '26.4-snapshot-1', stable: false },
    { version: '26.3', stable: true },
    { version: '26.2', stable: true },
    { version: '1.21.11', stable: true },
  ],
  loader: [
    { separator: '.', build: 5, maven: 'net.fabricmc:fabric-loader:0.19.5', version: '0.19.5', stable: true },
    { separator: '.', build: 4, maven: 'net.fabricmc:fabric-loader:0.19.4', version: '0.19.4', stable: false },
  ],
  installer: ['1.1.2', '1.1.1'],
};

export async function startFakeDownloads({ port = 0, host = '127.0.0.1', fail = process.env.FAKE_MC_DOWNLOAD_FAIL ?? '' } = {}) {
  const requests = [];
  let base = '';
  /** Files by path. */
  const files = new Map();
  /** A fake jar, and the size and checksums its API publishes (someone else's with bad-checksum). */
  const jar = (what) => {
    const bytes = jarBytes(what);
    const published = fail === 'bad-checksum' ? jarBytes(`${what} (other)`) : bytes;
    return { bytes, size: published.length, sha1: sha('sha1', published), sha256: sha('sha256', published) };
  };
  const versionJson = new Map();
  for (const v of MOJANG) {
    // piston-data names a file by its sha1, as the real one does.
    const f = jar(`minecraft server ${v.id}`);
    const serverPath = `/v1/objects/${f.sha1}/server.jar`;
    files.set(serverPath, f.bytes);
    versionJson.set(v.id, () => ({ id: v.id, type: v.type, time: v.time, releaseTime: v.time, complianceLevel: 1, minimumLauncherVersion: 21, javaVersion: { component: v.component, majorVersion: v.java }, downloads: { server: { sha1: f.sha1, size: f.size, url: `${base}${serverPath}` } } }));
  }
  const paperBuild = (ver, b) => {
    // fill-data names a file by its sha256.
    const name = `paper-${ver}-${b.id}.jar`;
    const f = jar(`paper ${ver} build ${b.id}`);
    const p = `/v1/objects/${f.sha256}/${name}`;
    files.set(p, f.bytes);
    return () => ({ id: b.id, time: '2026-09-25T03:26:20Z', channel: b.channel, commits: [{ sha: '0'.repeat(40), time: '2026-09-25T03:24:50Z', message: 'FAKE build\n' }], downloads: { 'server:default': { name, checksums: { sha256: f.sha256 }, size: f.size, url: `${base}${p}` } } });
  };
  const paperBuilds = Object.fromEntries(Object.entries(PAPER).map(([v, d]) => [v, d.builds.map((b) => paperBuild(v, b))]));
  for (const iv of FABRIC.installer) {
    const f = jar(`fabric installer ${iv}`);
    const p = `/maven/net/fabricmc/fabric-installer/${iv}/fabric-installer-${iv}.jar`;
    files.set(p, f.bytes);
    files.set(`${p}.sha256`, f.sha256);
    files.set(`${p}.sha1`, f.sha1);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    requests.push({ method: req.method, path: `${p}${url.search}`, userAgent: req.headers['user-agent'] ?? null });
    const send = (status, body, headers = {}) => {
      const type = Buffer.isBuffer(body) ? 'application/java-archive' : typeof body === 'string' && !body.startsWith('{') ? 'text/plain' : 'application/json';
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      res.writeHead(status, { 'content-type': type, 'content-length': buf.length, ...headers });
      res.end(buf);
    };
    if (p === '/__requests') return send(200, requests.slice(0, -1));
    const isFile = files.has(p) || p.startsWith('/v1/objects/') || p.startsWith('/maven/') || p.endsWith('/server/jar');
    if (fail === 'rate-limit' && !isFile) return send(429, { error: 'rate limited' }, { 'retry-after': '1' });
    if (fail === 'not-found' && isFile) return send(404, { error: 'not found' });
    let m;
    // ---- Mojang
    if (p === '/mc/game/version_manifest_v2.json') {
      const versions = MOJANG.map((v) => {
        const text = JSON.stringify(versionJson.get(v.id)());
        const s = sha('sha1', text);
        return { id: v.id, type: v.type, url: `${base}/v1/packages/${s}/${v.id}.json`, time: v.time, releaseTime: v.time, sha1: s, complianceLevel: 1 };
      });
      return send(200, { latest: { release: '26.3', snapshot: '26.4-snapshot-1' }, versions });
    }
    if ((m = /^\/v1\/packages\/[0-9a-f]{40}\/(.+)\.json$/.exec(p)) && versionJson.has(m[1])) return send(200, JSON.stringify(versionJson.get(m[1])()));
    // ---- Paper (Fill v3; v2 is gone)
    if (p.startsWith('/v2/projects/')) return send(410, { ok: false, error: 'sunset', message: 'This API version has been sunset and is no longer available. To continue using the service, please upgrade to a supported API version.' });
    if (p === '/v3/projects/paper') {
      const groups = {};
      for (const v of Object.keys(PAPER)) (groups[v.split('.').slice(0, 2).join('.')] ??= []).push(v);
      return send(200, { project: { id: 'paper', name: 'Paper' }, versions: groups });
    }
    if ((m = /^\/v3\/projects\/paper\/versions\/([^/]+)(\/builds(?:\/([^/]+))?)?$/.exec(p))) {
      const d = PAPER[m[1]];
      if (!d) return send(404, { ok: false, error: 'version_not_found', message: 'No version was found with the given identifier.' });
      const version = { id: m[1], support: { status: d.status }, java: { version: { minimum: d.java }, flags: { recommended: ['-XX:+UseG1GC'] } } };
      const builds = paperBuilds[m[1]].map((b) => b());
      if (!m[2]) return send(200, { version, builds: builds.map((b) => b.id) });
      if (!m[3]) {
        const ch = url.searchParams.get('channel');
        // The channels seen on the real API; anything else (e.g. lower case) is a 400 there.
        if (ch !== null && !['ALPHA', 'BETA', 'STABLE'].includes(ch)) return send(400, { status: 400, error: 'Bad Request', path: p });
        return send(200, ch ? builds.filter((b) => b.channel === ch) : builds);
      }
      const b = m[3] === 'latest' ? builds[0] : builds.find((x) => String(x.id) === m[3]);
      return b ? send(200, b) : send(404, { ok: false, error: 'build_not_found', message: 'No build was found with the given identifier.' });
    }
    // ---- Fabric meta and maven
    if (p === '/v2/versions/game') return send(200, FABRIC.game);
    if (p === '/v2/versions/loader') return send(200, FABRIC.loader);
    if (p === '/v2/versions/installer') return send(200, FABRIC.installer.map((v, i) => ({ url: `${base}/maven/net/fabricmc/fabric-installer/${v}/fabric-installer-${v}.jar`, maven: `net.fabricmc:fabric-installer:${v}`, version: v, stable: i === 0 })));
    if ((m = /^\/v2\/versions\/loader\/([^/]+)$/.exec(p))) {
      if (!FABRIC.game.some((g) => g.version === m[1])) return send(400, []);
      return send(200, FABRIC.loader.map((l) => ({ loader: l, intermediary: { maven: 'net.fabricmc:intermediary:0.0.0', version: '0.0.0', stable: true }, launcherMeta: { version: 2, min_java_version: 8, mainClass: { server: 'net.fabricmc.loader.impl.launch.knot.KnotServer' } } })));
    }
    if ((m = /^\/v2\/versions\/loader\/([^/]+)\/([^/]+)\/([^/]+)\/server\/jar$/.exec(p))) {
      if (!FABRIC.game.some((g) => g.version === m[1]) || !FABRIC.loader.some((l) => l.version === m[2])) return send(400, []);
      // Measured: no checksum is published for the launcher jar, but it is the same bytes on every download.
      return send(200, jarBytes(`fabric server launcher ${m[1]} ${m[2]} ${m[3]}`), { 'content-disposition': `attachment; filename="fabric-server-mc.${m[1]}-loader.${m[2]}-launcher.${m[3]}.jar"` });
    }
    // ---- files
    if (files.has(p)) return send(200, files.get(p));
    return send(404, { error: 'not found' });
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
  console.log(`fake-minecraft downloads on ${s.url}`);
}
