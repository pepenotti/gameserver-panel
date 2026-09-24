import { describe, expect, it } from 'vitest';
import { parseAppInfoBranches, parseAppManifest, parseVdf, vdfGet, VdfError } from '../src/vdf';

// Shaped like a real appmanifest_380870.acf (no owner SteamID in the fixture).
const manifest = `"AppState"
{
	"appid"		"380870"
	"Universe"		"1"
	"name"		"Project Zomboid Dedicated Server"
	"StateFlags"		"4"
	"installdir"		"Project Zomboid Dedicated Server"
	"LastUpdated"		"1788103919"
	"SizeOnDisk"		"5012345678"
	"buildid"		"24909800"
	"TargetBuildID"		"0"
	"UserConfig"
	{
		"BetaKey"		"legacy41"
	}
	"MountedConfig"
	{
		"BetaKey"		"legacy41"
	}
}
`;

const appInfoOutput = `Redirecting stderr to '/home/pz/Steam/logs/stderr.txt'
Loading Steam API...OK
Connecting anonymously to Steam Public...OK
Waiting for client config...OK
AppID : 380870, change number : 31234567/0, last change : Wed Aug 26 2026
"380870"
{
	"common"
	{
		"name"		"Project Zomboid Dedicated Server"
	}
	"depots"
	{
		"branches"
		{
			"public"
			{
				"buildid"		"24909800"
				"timeupdated"		"1787766000"
			}
			"legacy41"
			{
				"buildid"		"20111111"
				"description"		"Build 41 \\"legacy\\""
				"timeupdated"		"1787766001"
			}
			"42.19"
			{
				"buildid"		"23000000"
				"pwdrequired"		"0"
			}
		}
	}
}
Unloading Steam API...OK
`;

describe('parseVdf', () => {
  it('parses nested objects, escapes and comments', () => {
    const v = parseVdf('// comment\n"a" { "b" "x\\"y" "c" { "d" "1" } }');
    expect(v).toEqual({ a: { b: 'x"y', c: { d: '1' } } });
    expect(vdfGet(v, 'A', 'C', 'D')).toBe('1');
  });

  it('rejects broken input', () => {
    expect(() => parseVdf('"a" { "b" "1" ')).toThrow(VdfError);
    expect(() => parseVdf('"a" "unterminated')).toThrow(VdfError);
  });
});

describe('parseAppManifest', () => {
  it('reads the installed build and branch', () => {
    expect(parseAppManifest(manifest)).toEqual({
      appId: '380870',
      buildId: '24909800',
      branch: 'legacy41',
      sizeOnDisk: 5012345678,
      lastUpdated: 1788103919,
      stateFlags: 4,
    });
  });

  it('treats an empty or missing BetaKey as public', () => {
    expect(parseAppManifest(manifest.replace(/"BetaKey"\t\t"legacy41"/g, '"BetaKey"\t\t""')).branch).toBe('public');
    expect(parseAppManifest(manifest.replace(/\t"UserConfig"[\s\S]*?\}\n\t"MountedConfig"[\s\S]*?\}\n/, '')).branch).toBe('public');
  });
});

describe('parseAppInfoBranches', () => {
  it('extracts branch build ids from noisy steamcmd output', () => {
    const b = parseAppInfoBranches(appInfoOutput, '380870');
    expect(b.map((x) => [x.name, x.buildId])).toEqual([
      ['public', '24909800'],
      ['legacy41', '20111111'],
      ['42.19', '23000000'],
    ]);
    expect(b[1]!.description).toBe('Build 41 "legacy"');
    expect(b[0]!.timeUpdated).toBe(1787766000);
  });

  it('fails clearly when the block is missing', () => {
    expect(() => parseAppInfoBranches('Loading Steam API...OK\n', '380870')).toThrow(/No app_info block/);
  });
});
