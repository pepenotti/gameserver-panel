/**
 * What an install leaves behind, where each flavour's files live, and where
 * installs download from, for both halves (the panel reads the marker and
 * the data folder's files through the server's agent).
 */
import type { VersionInfo } from '@gsp/adapter-api';
import type { TerrariaFlavour } from './launch';

/** The install marker, relative to the install root. Written last, so it exists only after a whole install. */
export const INSTALL_MARKER = '.gsp-install.json';

/** `INSTALL_MARKER`'s content. */
export interface InstallMarker {
  schema: 1;
  flavour: TerrariaFlavour;
  /** What was installed, as `TerrariaLaunch.version` names it: vanilla `1.4.5.8`, else the release tag. */
  version: string;
  /**
   * The Terraria version it serves, as far as the source says: vanilla and
   * TShock `1.4.5.8` (TShock's release name); tModLoader `1.4.4` (its
   * release names give no more; the game prints the rest when it runs).
   */
  terraria: string | null;
  /** TShock `stable` or `prerelease`; tModLoader `stable` or `preview`; null for vanilla. */
  channel: string | null;
  /** The install's folder, under the install root (`vanilla-1458`, `tshock-v6.2.1`, `tmodloader-v2026.07.3.0`). */
  folder: string;
  /** Hex SHA-256 of the download. */
  sha256: string;
  /** Whether it matched a published digest (GitHub) or one pinned here (terraria.org publishes none). */
  verified: boolean;
  /** ISO time. */
  installedAt: string;
}

/** What each flavour starts, relative to its install folder. */
export const ENTRY: Record<TerrariaFlavour, string> = {
  // The binary itself: the `TerrariaServer` wrapper script passes its arguments unquoted.
  vanilla: 'TerrariaServer.bin.x86_64',
  tshock: 'TShock.Server',
  // Run with `dotnet` (the start scripts write into the install and ask questions).
  tmodloader: 'tModLoader.dll',
};

/** Why the panel should warn before a version is picked (`VersionInfo.warning`). */
export type VersionWarning =
  /** terraria.org publishes no checksum and this version's isn't pinned in the adapter: the download is taken as it comes. */
  | 'unverified-download'
  /** A TShock pre-release. */
  | 'tshock-prerelease'
  /** A tModLoader preview release. */
  | 'tml-preview';

/**
 * One entry of `versions()` (UPD-02), newest first: `id` is what
 * `TerrariaLaunch.version` takes. Vanilla: `build` is the download id
 * (`1458`). TShock: `description` names the Terraria version it is for,
 * `channel` is `stable` or `prerelease`. tModLoader: `channel` is `stable`
 * or `preview`, `description` the Terraria line (`1.4.4`).
 */
export interface TerrariaVersionInfo extends VersionInfo {
  warning?: VersionWarning;
  /** TShock: the Terraria version the release is for (from its name). */
  terraria?: string;
}

/**
 * Where installs download from; each can be pointed elsewhere through the
 * agent's environment (tests and the dev loop use
 * `tools/fake-terraria/downloads.mjs`, which serves both).
 */
export const DOWNLOAD_SOURCES = {
  /** terraria.org: the dedicated server's version name and its zips. */
  terraria: { env: 'GAME_TERRARIA_ORG_URL', url: 'https://terraria.org' },
  /** GitHub's API: TShock's and tModLoader's releases (60 anonymous calls an hour, 304s included). */
  github: { env: 'GAME_TERRARIA_GITHUB_URL', url: 'https://api.github.com' },
} as const;

/** The GitHub repositories releases come from. */
export const REPOS = { tshock: 'Pryaxis/TShock', tmodloader: 'tModLoader/tModLoader' } as const;

/**
 * Size and SHA-256 of every vanilla dedicated-server zip measured to exist
 * (downloaded from terraria.org on 2026-09-29; it publishes no checksum), by
 * download id. Installs of these are checked against them.
 */
export const VANILLA_PINS: Readonly<Record<string, { size: number; sha256: string }>> = {
  '1458': { size: 46_415_317, sha256: 'f513a4ac9789d34af766291ae217c9cd7d9472e13782a0e2b17512f70d7a8334' },
  '1457': { size: 46_412_675, sha256: 'c6a67b7355a6c2a1069ba3653ed4a17bd81be3cfb920a73408aade3c5a41a546' },
  '1456': { size: 45_635_619, sha256: 'd75c455ac217fd3434448c8f8251c1347f0875a85c438589dc71b557777e9155' },
  '1455': { size: 45_585_009, sha256: '0662d3e404c1be249f62e7370b1fda30750d4c1b3a4b9e861c917c60825786d5' },
  '1454': { size: 45_563_610, sha256: '54b063b7cb7767f695649b3d81f8902c41d5c74fc2b2036268ee6706b2b2b072' },
  '1453': { size: 45_480_893, sha256: 'e56e97a46696413b3d952cb5509abad1847a99fbdbdcb4edb3da692b4e573428' },
  '1452': { size: 45_467_839, sha256: '298e350f67d3be905a5ca6d7677b373375f9d9e31688245c3e5090266aad0b23' },
  '1451': { size: 45_468_795, sha256: 'd32b752d0a29dcaf80b5aa8e56bcee9b52f781130f52132a9c5be135296db0c7' },
  '1450': { size: 45_040_481, sha256: '3d103b70214bd962654f905ab76e0f4a0b3dae12eee02da6bb9cd66eeb7791d4' },
  '1449': { size: 44_628_067, sha256: '324fb9b3d3a59324cb5d96154f4fbc41c8f2d926f9bb2da1702f0230bd1b88d6' },
  '1448': { size: 44_557_993, sha256: 'b4e850f841bda32f5a983c413a9a146a140ea22158be05803f6cf682417f49eb' },
  '1447': { size: 44_579_553, sha256: '85c5660d93333c40574fc75e07f8a4eb80d174bda99a23762a96db6c3c5c070a' },
  '1445': { size: 44_565_771, sha256: 'defabded72b25e1c501e30c039eda091d4ae6e819b95cb6fa8348a960dc531fb' },
  '1444': { size: 44_556_715, sha256: 'b11355c025f33f015591a8e7824595b6c94d6e339f3a30c6bb6585728f23fe5b' },
  '1443': { size: 44_546_306, sha256: 'deadf9b99f74518f39866791c5e91670d98cb6b49ac8d90bd1a39346dea5e53e' },
  '1441': { size: 44_533_079, sha256: 'e832c322176c198845dc38a9ba0c2491e37ed7549c0475b3106156051beefafe' },
  '1436': { size: 43_392_536, sha256: '38523b53a32abb4f6921b80942cd0ef864bc8dfd6e56e84054426160d617ac11' },
  '1435': { size: 42_503_400, sha256: '3751a7c447b403a5aecf2d3c94bdc214f5a34091021867f9d38144fa59e10dcc' },
  '1423': { size: 42_109_253, sha256: '12bd93494a31a1487384af1d6e86ee52edce72e2f093e90ee9eaa516eabaa462' },
  '1412': { size: 41_871_820, sha256: '10e6a806e121abb31f3cf46731a6b7e37544d247ea656320b8deffe8e4f10ca2' },
};

// ------------------------------------------------------------------ the data folder (one layout for the three)

/**
 * Where each flavour keeps its files, relative to the data root. Every
 * flavour gets `-savedirectory` (tModLoader: `-tmlsavedirectory`) set to the
 * data root: without a writable save folder no world is created, and
 * nothing says so.
 */
export const DATA = {
  /** Worlds: `<world>.wld` (tModLoader adds `.twld`), the game's own `.bak` and `.bak2`; tModLoader's zips in `Backups/`. */
  worlds: 'Worlds',
  /** Read at start (`-config`), never written by the game. */
  serverConfig: 'serverconfig.txt',
  /** Vanilla's and tModLoader's IP bans (`-banlist`, absolute: without it `ban` fails). */
  banlist: 'banlist.txt',
  /** TShock's configuration, database and logs (`-configpath`). */
  tshock: 'tshock',
  /** TShock's settings, rewritten by TShock at every start (unknown keys dropped). */
  tshockConfig: 'tshock/config.json',
  /** Present before the first start: no setup code is printed or needed. */
  tshockSetupLock: 'tshock/setup.lock',
  /** TShock's accounts, bans and more (SQLite, rollback journal). */
  tshockDb: 'tshock/tshock.sqlite',
  tshockLogs: 'tshock/logs',
  tshockCrashes: 'tshock/crashes',
  /** tModLoader's enabled mods: a JSON array of mod names. */
  tmlEnabled: 'Mods/enabled.json',
  /** steamcmd's Workshop cache (the agent's `workshopDir`), which tModLoader reads its mods from. */
  workshop: '.workshop/steamapps/workshop',
} as const;

/** `serverconfig.txt` keys the agent writes before every start (CFG-04); the launch's `password` too when it gives one. */
export const MANAGED_SERVERCONFIG = ['port', 'world', 'worldpath', 'autocreate', 'banlist', 'language', 'upnp'] as const;

/** The name TShock's REST API knows the agent's token by (`ApplicationRestTokens`). */
export const REST_TOKEN_USER = 'gameserver-panel';
