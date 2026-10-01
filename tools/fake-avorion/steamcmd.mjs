#!/usr/bin/env node
// A stand-in for steamcmd as the Avorion dedicated server (app 565060) meets it
// (docs/verification/avorion-2.5.13.md, fixtures/avorion/2.5.13/steamcmd/): the +commands the agent uses.
//   +app_update 565060 [-beta <branch>] [validate]  the app manifest with the branch's build id, and stubs of
//                                                   bin/AvorionServer, server.sh, steam_appid.txt and data/
//   +app_info_print 565060                          its public branches, as measured
// Failures: FAKE_STEAMCMD_FAIL = missing-config (measured: a fresh steamcmd's first app_update) | disk | timeout.
// FAKE_BUILDID overrides the public build id.
import fs from 'node:fs';
import path from 'node:path';

const APP = '565060';
const BRANCHES = {
  public: process.env.FAKE_BUILDID ?? '22295362',
  beta: '22295362',
  previous: '21146556',
  '2.5.2': '14719268',
  '2.4.3': '13518580',
  '2.0.11': '7755067',
  '1.0.0': '4995671',
};
const DESCRIPTIONS = {
  beta: 'Beta Branch - Newest Changes & Experimental Features',
  previous: 'Previous Build 2.5.11 - Will be disabled soon',
  '2.5.2': '2.5.2 - Secondary Block Colors and Photo Mode',
  '2.4.3': '2.4.3 - Behemoth DLC, World Bosses, Ship Mgt, AMD crash fix',
  '2.0.11': '2.0.11 - Update 2.0',
  '1.0.0': '1.0 - Full Release',
};
const args = process.argv.slice(2);
const fail = process.env.FAKE_STEAMCMD_FAIL;
let installDir = '.';
const out = (l) => process.stdout.write(`${l}\n`);

out("Redirecting stderr to '/home/node/Steam/logs/stderr.txt'");
out('Loading Steam API...OK');
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '+force_install_dir') installDir = args[++i];
  else if (a === '+login') {
    i++;
    out('Connecting anonymously to Steam Public...OK');
    out('Waiting for client config...OK');
    out('Waiting for user info...OK');
  } else if (a === '+app_update') {
    const appId = args[++i];
    let branch = 'public';
    while (args[i + 1] && !args[i + 1].startsWith('+')) {
      const o = args[++i];
      if (o === '-beta') branch = args[++i];
    }
    if (fail === 'missing-config') {
      out(`ERROR! Failed to install app '${appId}' (Missing configuration)`);
      continue;
    }
    if (fail === 'timeout') {
      out(`Error! App '${appId}' state is 0x602 after update job.`);
      continue;
    }
    const buildId = appId === APP ? BRANCHES[branch] : undefined;
    if (!buildId) {
      // An unknown or password-protected branch: steamcmd's own words for it were not captured.
      out(`ERROR! Failed to install app '${appId}' (Invalid platform)`);
      continue;
    }
    out(' Update state (0x3) reconfiguring, progress: 0.00 (0 / 0)');
    for (const p of [0.55, 47.28, 77.45]) process.stdout.write(` Update state (0x61) downloading, progress: ${p} (${Math.round(p * 1914051.19)} / 191405119)\r`);
    process.stdout.write('\n');
    if (fail === 'disk') {
      out(`Error! App '${appId}' state is 0x202 after update job.`);
      continue;
    }
    for (const d of ['steamapps', 'bin', 'linux64', path.join('data', 'scripts', 'server')]) fs.mkdirSync(path.join(installDir, d), { recursive: true });
    fs.writeFileSync(path.join(installDir, 'bin', 'AvorionServer'), 'FAKE AvorionServer\n', { mode: 0o755 });
    fs.writeFileSync(path.join(installDir, 'server.sh'), '#!/bin/bash\n# fake\n', { mode: 0o755 });
    fs.writeFileSync(path.join(installDir, 'steam_appid.txt'), '445220\n');
    fs.writeFileSync(path.join(installDir, 'data', 'scripts', 'server', 'server.lua'), '-- fake\n');
    fs.writeFileSync(
      path.join(installDir, 'steamapps', `appmanifest_${appId}.acf`),
      `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"Universe"\t\t"1"\n\t"name"\t\t"Avorion Dedicated Server"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"AvorionServer"\n\t"SizeOnDisk"\t\t"191405119"\n\t"buildid"\t\t"${buildId}"\n\t"InstalledDepots"\n\t{\n\t\t"565061"\n\t\t{\n\t\t\t"manifest"\t\t"3169308613424354701"\n\t\t\t"size"\t\t"36957350"\n\t\t}\n\t}\n\t"UserConfig"\n\t{\n${branch === 'public' ? '' : `\t\t"BetaKey"\t\t"${branch}"\n`}\t}\n\t"MountedConfig"\n\t{\n\t}\n}\n`,
    );
    out(`Success! App '${appId}' fully installed.`);
  } else if (a === '+app_info_update') i++;
  else if (a === '+app_info_print') {
    const appId = args[++i];
    out(`AppID : ${appId}, change number : 38905983/38905983, last change : Thu Oct  1 15:33:34 2026 `);
    const branches = Object.entries(BRANCHES)
      .map(([b, id]) => `\t\t\t"${b}"\n\t\t\t{\n\t\t\t\t"buildid"\t\t"${id}"\n${DESCRIPTIONS[b] ? `\t\t\t\t"description"\t\t"${DESCRIPTIONS[b]}"\n` : ''}\t\t\t}`)
      .join('\n');
    out(`"${appId}"\n{\n\t"common"\n\t{\n\t\t"name"\t\t"Avorion Dedicated Server"\n\t\t"parent"\t\t"445220"\n\t\t"oslist"\t\t"windows,linux"\n\t\t"osarch"\t\t"64"\n\t\t"freetodownload"\t\t"1"\n\t}\n\t"depots"\n\t{\n\t\t"branches"\n\t\t{\n${branches}\n\t\t}\n\t\t"privatebranches"\t\t"1"\n\t}\n}`);
  } else if (a === '+quit') break;
}
out('Unloading Steam API...OK');
