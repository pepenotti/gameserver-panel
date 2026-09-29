#!/usr/bin/env node
// A stand-in for steamcmd as tModLoader meets it (docs/verification/terraria-1.4.5.8.md,
// fixtures/terraria/1.4.5.8/tmodloader/steamcmd/): the +commands the agent uses.
//   +app_update 1281930   anonymously "succeeds" and installs nothing (measured: tModLoader's depots
//                         need an account that owns Terraria); FAKE_TML_STEAM_OWNED=1 installs a stub
//   +app_info_print 1281930  its branches (public, 1.4.3-legacy, preview-…)
//   +workshop_download_item 1281930 <id>  <dir>/steamapps/workshop/content/1281930/<id>/<tML version>/<Mod>.tmod,
//                         workshop.json and appworkshop_1281930.acf, as measured
// Failures: FAKE_STEAMCMD_FAIL = disk | timeout | missing-item. The mod's name: FAKE_TML_MOD_NAMES
// ("<id>=<Name>,…"), else Mod<id>.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const fail = process.env.FAKE_STEAMCMD_FAIL;
const names = new Map((process.env.FAKE_TML_MOD_NAMES ?? '').split(',').filter(Boolean).map((p) => p.split('=')));
let installDir = '.';
const out = (l) => process.stdout.write(`${l}\n`);

out('Redirecting stderr to \'/home/node/Steam/logs/stderr.txt\'');
out('Loading Steam API...OK');
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '+force_install_dir') installDir = args[++i];
  else if (a === '+login') {
    const who = args[++i];
    out(who === 'anonymous' ? 'Connecting anonymously to Steam Public...OK' : `Logging in user '${who}' to Steam Public...OK`);
    out('Waiting for client config...OK');
    out('Waiting for user info...OK');
  } else if (a === '+app_update') {
    const appId = args[++i];
    while (args[i + 1] && !args[i + 1].startsWith('+')) i++;
    if (fail === 'timeout') {
      out(`Error! App '${appId}' state is 0x602 after update job.`);
      continue;
    }
    if (fail === 'disk') {
      out(`Error! App '${appId}' state is 0x202 after update job.`);
      continue;
    }
    const owned = process.env.FAKE_TML_STEAM_OWNED === '1';
    out(' Update state (0x0) unknown, progress: 0.00 (0 / 0)');
    fs.mkdirSync(path.join(installDir, 'steamapps'), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, 'steamapps', `appmanifest_${appId}.acf`),
      `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"name"\t\t"tModLoader"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"tModLoader"\n\t"SizeOnDisk"\t\t"${owned ? 173801542 : 0}"\n\t"buildid"\t\t"25047440"\n\t"InstalledDepots"\n\t{\n\t}\n}\n`,
    );
    if (owned) fs.writeFileSync(path.join(installDir, 'tModLoader.dll'), 'FAKE tModLoader from Steam\n');
    // measured: the same success line whether or not a single file came down
    out(`Success! App '${appId}' fully installed.`);
  } else if (a === '+app_info_print') {
    const appId = args[++i];
    out(`AppID : ${appId}, change number : 1/0`);
    out(`"${appId}"\n{\n\t"common"\n\t{\n\t\t"name"\t\t"tModLoader"\n\t\t"type"\t\t"Game"\n\t\t"parent"\t\t"105600"\n\t}\n\t"extended"\n\t{\n\t\t"mustownapptopurchase"\t\t"105600"\n\t\t"isfreeapp"\t\t"1"\n\t}\n\t"depots"\n\t{\n\t\t"workshopdepot"\t\t"1281930"\n\t\t"branches"\n\t\t{\n\t\t\t"public"\n\t\t\t{\n\t\t\t\t"buildid"\t\t"25047440"\n\t\t\t}\n\t\t\t"1.4.3-legacy"\n\t\t\t{\n\t\t\t\t"buildid"\t\t"24978752"\n\t\t\t}\n\t\t\t"preview-v2026.08"\n\t\t\t{\n\t\t\t\t"buildid"\t\t"25471574"\n\t\t\t}\n\t\t}\n\t}\n}`);
  } else if (a === '+workshop_download_item') {
    const app = args[++i];
    const id = args[++i];
    process.stdout.write(`Downloading item ${id} ...`);
    if (fail === 'missing-item' || fail === 'timeout') {
      out(`ERROR! Download item ${id} failed (${fail === 'timeout' ? 'Timeout' : 'File Not Found'}).`);
      continue;
    }
    const item = path.join(installDir, 'steamapps', 'workshop', 'content', app, id);
    const name = names.get(id) ?? `Mod${id}`;
    for (const v of ['2025.9', '2026.7']) {
      fs.mkdirSync(path.join(item, v), { recursive: true });
      fs.writeFileSync(path.join(item, v, `${name}.tmod`), `TMOD FAKE ${name} for tModLoader ${v}\n`);
    }
    fs.writeFileSync(path.join(item, 'workshop.json'), JSON.stringify({ WorkshopPublishedVersion: 1, ContentType: 'Mod', SteamEntryId: Number(id), Tags: ['Utilities', 'English', '1.4.4'], Publicity: 2 }, null, 2));
    const acf = path.join(installDir, 'steamapps', 'workshop', `appworkshop_${app}.acf`);
    fs.writeFileSync(acf, `"AppWorkshop"\n{\n\t"appid"\t\t"${app}"\n\t"WorkshopItemsInstalled"\n\t{\n\t\t"${id}"\n\t\t{\n\t\t\t"size"\t\t"123"\n\t\t\t"timeupdated"\t\t"1788581217"\n\t\t}\n\t}\n}\n`);
    out(`Success. Downloaded item ${id} to "${item}" (123 bytes) `);
  } else if (a === '+quit') break;
}
out('Unloading Steam API...OK');
