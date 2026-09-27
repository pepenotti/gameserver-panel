/**
 * What an install leaves behind and what `versions()` answers, for both
 * halves: the panel reads the install marker through the server's files
 * (install root, read-only) and the version list through the agent.
 */
import type { VersionInfo } from '@gsp/adapter-api';
import type { Loader, PaperChannel } from './launch';

/** The install marker, relative to the install root. Written last, so it exists only after a whole install. */
export const INSTALL_MARKER = '.gsp-install.json';

/** `INSTALL_MARKER`'s content. */
export interface InstallMarker {
  schema: 1;
  loader: Loader;
  /** Minecraft version. */
  version: string;
  /** Paper: the build and its channel. */
  build: number | null;
  channel: PaperChannel | null;
  /** Fabric: the loader and installer versions. */
  loaderVersion: string | null;
  installerVersion: string | null;
  /** The Java major Mojang's metadata declares for the version. */
  javaMajor: number;
  /** The Temurin JRE the server runs on (`/opt/java/<jre>`): the declared major, or the nearest shipped one. */
  jre: number;
  /** The jar started, relative to the install root. */
  jar: string;
  /** Hex digest of the downloaded jar, as published (`sha1` for Mojang's, `sha256` for Paper's and Fabric's installer). */
  sha1: string | null;
  sha256: string | null;
  /** ISO time. */
  installedAt: string;
}

/** The jar each loader starts, in the install root. */
export const LOADER_JARS: Record<Loader, string> = {
  vanilla: 'server.jar',
  paper: 'paper.jar',
  fabric: 'fabric-server-launch.jar',
};

/** Why the panel should warn before a version is picked. */
export type VersionWarning =
  /** Paper has only ALPHA or BETA builds of this version (Q13): offered, with a warning, and the server needs that channel. */
  'paper-no-stable-build';

/**
 * One entry of `versions()` (UPD-02): `id` is always a Minecraft release,
 * 1.16.5 or newer (Q11), newest first; `timeUpdated` is its release (Paper:
 * its newest build). The extra fields travel through the agent's API as they
 * are; the core reads only `VersionInfo`'s.
 */
export interface MinecraftVersionInfo extends VersionInfo {
  /** Paper: `build` is the newest build (any channel) and this its channel. Fabric: `build` is the newest stable loader. */
  channel?: PaperChannel;
  warning?: VersionWarning;
  /** Paper, on the launch's own version only: its builds, newest first (at most 50). */
  builds?: { id: number; channel: PaperChannel; timeUpdated: number }[];
  /** Fabric, on the launch's own version only: the loader versions for it, newest first (at most 50). */
  loaders?: { version: string; stable: boolean }[];
}

/**
 * Where installs download from; each can be pointed elsewhere through the
 * agent's environment (tests and the dev loop use
 * `tools/fake-minecraft/downloads.mjs`, which serves all three).
 */
export const DOWNLOAD_SOURCES = {
  /** Mojang's version manifest and files (`/mc/game/version_manifest_v2.json`). */
  mojang: { env: 'GAME_MC_MOJANG_URL', url: 'https://piston-meta.mojang.com' },
  /** PaperMC's Fill v3 API (`/v3/projects/paper`). */
  paper: { env: 'GAME_MC_PAPER_URL', url: 'https://fill.papermc.io' },
  /** Fabric's meta API (`/v2/versions`); the installer jar comes from the URL it gives. */
  fabric: { env: 'GAME_MC_FABRIC_URL', url: 'https://meta.fabricmc.net' },
} as const;

/** `server.properties` keys the agent writes before every start (CFG-04): the game rewrites the file, so they are applied again each time. */
export const MANAGED_PROPERTIES = ['server-port', 'server-ip', 'enable-rcon', 'rcon.port', 'rcon.password', 'enable-query', 'management-server-enabled', 'level-name'] as const;

/** The world folder (`level-name`), which backups and resets name. */
export const LEVEL_NAME = 'world';
