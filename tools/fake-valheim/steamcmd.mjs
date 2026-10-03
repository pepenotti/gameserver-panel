#!/usr/bin/env node
// A stand-in for steamcmd as the Valheim dedicated server (app 896660) meets it
// (docs/verification/valheim-1.0.16.md, fixtures/valheim/1.0.16/steamcmd/): the +commands the agent uses.
//   +app_update 896660 [-beta <branch>] [validate]  writes the app manifest (build id of the branch) and a
//                                                   stub valheim_server.x86_64 and start_server.sh
//   +app_info_print 896660                          its public branches, as measured (private ones aren't listed)
// Failures: FAKE_STEAMCMD_FAIL = disk | timeout | missing-config (the "Missing configuration" error a fresh
// steamcmd gave on its first app_update in the fact-finding). FAKE_BUILDID overrides the public build id.
import fs from 'node:fs';
import path from 'node:path';

const APP = '896660';
const BRANCHES = {
  public: process.env.FAKE_BUILDID ?? '25527701',
  default_old: '25390671',
  default_pre1_0: '21981590',
  default_preal: '20221240',
  default_prebw: '20221628',
  default_precta: '20221863',
  default_preml: '20222098',
};
const DESCRIPTIONS = {
  default_old: 'Previous stable',
  default_pre1_0: 'Last stable build before 1.0',
  default_preal: 'Last stable build before Ashlands',
  default_prebw: 'Last stable build before Bog Witch',
  default_precta: 'Last stable build before Call to Arms',
  default_preml: 'Last stable build before Mistlands',
};
const args = process.argv.slice(2);
const fail = process.env.FAKE_STEAMCMD_FAIL;
let installDir = '.';
/** The beta branch an install is on (its app manifest's BetaKey), or null. */
function betaKeyOf(dir, appId) {
  try {
    return /"BetaKey"\s+"([^"]+)"/.exec(fs.readFileSync(path.join(dir, 'steamapps', `appmanifest_${appId}.acf`), 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}
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
    let named = false;
    while (args[i + 1] && !args[i + 1].startsWith('+')) {
      const opt = args[++i];
      if (opt === '-beta') {
        branch = args[++i];
        named = true;
      }
    }
    // Measured on Avorion (docs/verification/shared-installs.md, "Branch switches"): without -beta, an
    // install of a beta branch stays on it, and steamcmd says it is up to date.
    if (!named && ![null, 'public'].includes(betaKeyOf(installDir, appId))) {
      out(`Success! App '${appId}' already up to date.`);
      continue;
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
    for (const p of [10.59, 47.99, 86.32]) process.stdout.write(` Update state (0x61) downloading, progress: ${p} (${Math.round(p * 21866492.64)} / 2186649264)\r`);
    process.stdout.write('\n');
    if (fail === 'disk') {
      out(`Error! App '${appId}' state is 0x202 after update job.`);
      continue;
    }
    fs.mkdirSync(path.join(installDir, 'steamapps'), { recursive: true });
    fs.mkdirSync(path.join(installDir, 'linux64'), { recursive: true });
    fs.writeFileSync(path.join(installDir, 'valheim_server.x86_64'), 'FAKE valheim_server.x86_64\n', { mode: 0o755 });
    fs.writeFileSync(path.join(installDir, 'start_server.sh'), '#!/bin/bash\n# fake\n', { mode: 0o755 });
    fs.writeFileSync(path.join(installDir, 'linux64', 'steamclient.so'), 'FAKE\n');
    fs.writeFileSync(
      path.join(installDir, 'steamapps', `appmanifest_${appId}.acf`),
      `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"Universe"\t\t"1"\n\t"name"\t\t"Valheim Dedicated Server"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"Valheim dedicated server"\n\t"SizeOnDisk"\t\t"2186649264"\n\t"buildid"\t\t"${buildId}"\n\t"InstalledDepots"\n\t{\n\t\t"1006"\n\t\t{\n\t\t\t"manifest"\t\t"4559160656493359681"\n\t\t\t"size"\t\t"111284048"\n\t\t}\n\t\t"896661"\n\t\t{\n\t\t\t"manifest"\t\t"1285123405092214913"\n\t\t\t"size"\t\t"2075365216"\n\t\t}\n\t}\n\t"UserConfig"\n\t{\n${branch === 'public' ? '' : `\t\t"BetaKey"\t\t"${branch}"\n`}\t}\n\t"MountedConfig"\n\t{\n\t}\n}\n`,
    );
    out(`Success! App '${appId}' fully installed.`);
  } else if (a === '+app_info_update') i++;
  else if (a === '+app_info_print') {
    const appId = args[++i];
    out(`AppID : ${appId}, change number : 39376442/39376442, last change : Thu Oct  1 15:31:02 2026 `);
    const branches = Object.entries(BRANCHES)
      .map(([b, id]) => `\t\t\t"${b}"\n\t\t\t{\n\t\t\t\t"buildid"\t\t"${id}"\n${DESCRIPTIONS[b] ? `\t\t\t\t"description"\t\t"${DESCRIPTIONS[b]}"\n` : ''}\t\t\t}`)
      .join('\n');
    out(`"${appId}"\n{\n\t"common"\n\t{\n\t\t"name"\t\t"Valheim Dedicated Server"\n\t\t"type"\t\t"Tool"\n\t\t"parent"\t\t"892970"\n\t\t"oslist"\t\t"windows,macos,linux"\n\t\t"freetodownload"\t\t"1"\n\t}\n\t"depots"\n\t{\n\t\t"branches"\n\t\t{\n${branches}\n\t\t}\n\t\t"privatebranches"\t\t"1"\n\t}\n}`);
  } else if (a === '+quit') break;
}
out('Unloading Steam API...OK');
