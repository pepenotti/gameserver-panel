#!/usr/bin/env node
// A stand-in for steamcmd: understands the +commands the agent uses and
// writes an appmanifest like the real one.
//   FAKE_BUILDID (default 24909800), FAKE_STEAMCMD_FAIL = disk | timeout
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const fail = process.env.FAKE_STEAMCMD_FAIL;
const buildId = process.env.FAKE_BUILDID ?? '24909800';
let installDir = '.';
const out = (l) => process.stdout.write(`${l}\n`);
/** The beta branch an install is on (its app manifest's BetaKey), or null. */
function betaKeyOf(dir, appId) {
  try {
    return /"BetaKey"\s+"([^"]+)"/.exec(fs.readFileSync(path.join(dir, 'steamapps', `appmanifest_${appId}.acf`), 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

out('Redirecting stderr to \'/home/node/Steam/logs/stderr.txt\'');
out('Loading Steam API...OK');
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '+force_install_dir') installDir = args[++i];
  else if (a === '+login') out(`Connecting anonymously to Steam Public...OK`);
  else if (a === '+app_update') {
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
    if (fail === 'timeout') {
      out(`Error! App '${appId}' state is 0x602 after update job.`);
      continue;
    }
    for (const p of [10.5, 55.25, 99.9]) process.stdout.write(` Update state (0x61) downloading, progress: ${p} (1 / 2)\r`);
    process.stdout.write('\n');
    if (fail === 'disk') {
      out(`Error! App '${appId}' state is 0x202 after update job.`);
      continue;
    }
    fs.mkdirSync(path.join(installDir, 'steamapps'), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, 'steamapps', `appmanifest_${appId}.acf`),
      `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"StateFlags"\t\t"4"\n\t"buildid"\t\t"${buildId}"\n\t"UserConfig"\n\t{\n\t\t"BetaKey"\t\t"${branch === 'public' ? '' : branch}"\n\t}\n}\n`,
    );
    out(`Success! App '${appId}' fully installed.`);
  } else if (a === '+app_info_print') {
    const appId = args[++i];
    out(`AppID : ${appId}, change number : 1/0`);
    out(`"${appId}"\n{\n\t"depots"\n\t{\n\t\t"branches"\n\t\t{\n\t\t\t"public"\n\t\t\t{\n\t\t\t\t"buildid"\t\t"${process.env.FAKE_LATEST_BUILDID ?? buildId}"\n\t\t\t}\n\t\t\t"legacy41"\n\t\t\t{\n\t\t\t\t"buildid"\t\t"20111111"\n\t\t\t}\n\t\t}\n\t}\n}`);
  } else if (a === '+workshop_download_item') {
    const app = args[++i];
    const id = args[++i];
    const dir = path.join(installDir, 'steamapps', 'workshop', 'content', app, id, 'mods', `Mod${id}`, '42');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mod.info'), `name=Mod ${id}\nid=Mod${id}\nversionMin=42.0\n`);
    out(`Downloading item ${id} ...`);
    out(`Success. Downloaded item ${id} to "${path.dirname(path.dirname(path.dirname(dir)))}" (123 bytes)`);
  } else if (a === '+quit') break;
}
out('Unloading Steam API...OK');
