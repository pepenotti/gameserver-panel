import type { AdapterMeta, Capability, InstallSharing, JoinDecl, JoinSetting, PortDecl } from '@gsp/adapter-api';
import type { ManifestJoin, ManifestJoinSetting, SteamGameManifest } from './types';

/**
 * What a manifest game supports, from what its manifest declares: a console
 * on stdin; a save command; a running backup unless only a stopped server
 * can be copied; players from a console list, from join and leave lines or
 * from Steam's queries; kicks and bans from console templates or list files;
 * a whitelist and an admin level from list files; broadcasts; its Steam
 * branches and update checks; its agreement.
 */
export function capabilitiesOf(m: SteamGameManifest): Capability[] {
  const caps: Capability[] = [];
  const stdin = m.console.kind === 'stdin';
  const p = m.players;
  const mod = m.moderation;
  if (stdin) caps.push('stdinConsole');
  if (stdin && m.broadcast) caps.push('broadcast');
  if (stdin && m.save) caps.push('save');
  if (m.backups.running !== 'stopped-only') caps.push('hotBackup');
  if ((stdin && p?.list) || (p?.join && p.leave) || p?.steamQuery) caps.push('players', 'playerHistory');
  if (stdin && mod?.kick) caps.push('kick');
  if ((stdin && mod?.ban && mod.unban) || mod?.listFiles?.ban) caps.push('ban');
  if (mod?.listFiles?.allow) caps.push('whitelist');
  if (mod?.listFiles?.admin) caps.push('accessLevels');
  caps.push('branches', 'updateCheck');
  if (m.eula) caps.push('eula');
  return caps;
}

const metas = new WeakMap<SteamGameManifest, AdapterMeta>();

/**
 * The adapter's meta, shared by both halves of a manifest's adapter (one
 * object per manifest, as the adapter list expects): the steam image,
 * x86-64, no flavours, the ports, memory and stop budget it declares.
 */
export function manifestMeta(m: SteamGameManifest): AdapterMeta {
  let meta = metas.get(m);
  if (!meta) {
    const ports: PortDecl[] = m.ports.map((p) => ({ id: p.id, proto: p.proto, default: p.default, publish: p.publish, sameInsideOut: p.sameInsideOut, label: p.label, ...(p.follows ? { follows: { ...p.follows } } : {}) }));
    meta = {
      id: m.id,
      name: m.name,
      // PRD §10: manifest games run in the steam image, as they are.
      runtime: 'steam',
      arch: [...m.arch],
      flavours: [],
      ports,
      memory: { ...m.memory },
      capabilities: capabilitiesOf(m),
      stopBudgetMs: m.stop.budgetMs,
      ...(m.eula ? { eula: m.eula } : {}),
      ...(m.notes?.length ? { notes: m.notes.map((n) => ({ ...n })) } : {}),
      ...(m.join ? { join: joinOf(m.join) } : {}),
      install: installOf(m),
    };
    metas.set(m, meta);
  }
  return meta;
}

/**
 * How the game's installs are shared (HST-09, D12), in the contract's
 * terms: `shared`, with its redirects, once the manifest says so; `own`
 * (each server keeps its own install) otherwise.
 */
export function installOf(m: SteamGameManifest): InstallSharing {
  if (!m.install?.shared) return { mode: 'own' };
  const redirects = (m.install.redirects ?? []).map((r) => ({ path: r.path, to: r.to }));
  return redirects.length ? { mode: 'shared', redirects } : { mode: 'shared' };
}

/** A manifest's setting, as the contract names a launch setting (`launch`) or a config key. */
function settingOf(s: ManifestJoinSetting): JoinSetting {
  return 'setting' in s ? { launch: s.setting } : { file: s.file, key: s.key };
}

/** How players join (SRV-08), in the contract's terms. */
export function joinOf(j: ManifestJoin): JoinDecl {
  return {
    port: j.port,
    format: j.format,
    ...(j.defaultPort !== undefined ? { defaultPort: j.defaultPort } : {}),
    where: { ...j.where },
    client: { name: { ...j.client.name }, sameVersion: j.client.sameVersion },
    ...(j.steps ? { steps: j.steps.map((s) => ({ id: s.id, text: { ...s.text }, ...(s.when ? { when: { ...settingOf(s.when), equals: s.when.equals } } : {}) })) } : {}),
    ...(j.password ? { password: settingOf(j.password) } : {}),
    verified: j.verified,
    source: j.source,
    ...(j.note ? { note: { ...j.note } } : {}),
  };
}
