/**
 * A manifest game's launch settings (CFG-01, UPD-02), checked the same way
 * by the panel before it saves them and by the agent before a start:
 * the branch, updates before each start and the game's memory, which every
 * manifest game has, then the manifest's own settings with their types,
 * ranges, lengths, patterns and rules. A refusal names its setting and says
 * why in English and Spanish (`LaunchSettingRefusal`).
 */
import type { I18n, LaunchSettingRefusal } from '@gsp/adapter-api';
import type { Condition, ManifestSetting, SteamGameManifest } from './types';

export type SettingValue = string | number | boolean;

/** What the panel stores for a server (its `launch` settings). */
export interface ManifestSettings {
  /** The Steam branch installed and run (UPD-02). */
  branch: string;
  /** steamcmd looks for an update before every start. */
  updateOnStart: boolean;
  /** The game's memory, MiB: the container gets `memory.overheadMb` more (SRV-05). */
  memoryMb: number;
  [setting: string]: SettingValue;
}

/** What the agent is sent (`LaunchEnvelope.params`): the settings, the server's game name and its generated secrets, at the top level. */
export interface ManifestLaunch extends ManifestSettings {
  name: string;
}

/** Keys every manifest game's launch has; no setting or secret may take them. */
export const RESERVED_KEYS = ['name', 'branch', 'updateOnStart', 'memoryMb'] as const;
export const MEMORY_STEP = 256;
export const MEMORY_MAX_MB = 65_536;
const BRANCH = /^[A-Za-z0-9._-]{1,64}$/;
/** The server's game name, as a file name the game takes. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A text setting's longest value, as the panel's form takes them. */
const TEXT_MAX = 200;

/** An `Error` the panel answers with the setting and the EN/ES text. */
export function refusal(field: string, text: I18n): Error & LaunchSettingRefusal {
  return Object.assign(new Error(`${field}: ${text.en}`), { field, text });
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** A setting's value as it starts: its default (a secret's is empty). */
export function settingDefault(s: ManifestSetting): SettingValue {
  if (s.default !== undefined) return s.default;
  return s.type === 'boolean' ? false : s.type === 'integer' ? (s.min ?? 0) : '';
}

/** The settings a new server starts with. */
export function settingDefaults(m: SteamGameManifest): ManifestSettings {
  const out: ManifestSettings = { branch: m.steam.defaultBranch, updateOnStart: true, memoryMb: m.memory.defaultMb };
  for (const s of m.settings) out[s.id] = settingDefault(s);
  return out;
}

/** Whether a condition on the settings holds. */
export function holds(c: Condition, values: Readonly<Record<string, unknown>>): boolean {
  const v = values[c.setting];
  if (c.equals !== undefined && v !== c.equals) return false;
  if (c.notEmpty && (v === undefined || v === '' || v === false || v === null)) return false;
  return true;
}

/** What people call a setting, in both languages. */
const named = (s: { label: I18n }) => s.label;

const say = (en: string, es: string): I18n => ({ en, es });

function checkOne(s: ManifestSetting, v: unknown): SettingValue {
  const n = named(s);
  const bad = (text: I18n): never => {
    throw refusal(s.id, text);
  };
  switch (s.type) {
    case 'boolean':
      if (typeof v !== 'boolean') bad(say(`${n.en} must be on or off.`, `${n.es} debe estar activado o desactivado.`));
      return v as boolean;
    case 'integer': {
      if (typeof v !== 'number' || !Number.isInteger(v)) bad(say(`${n.en} must be a whole number.`, `${n.es} debe ser un número entero.`));
      const x = v as number;
      if ((s.min !== undefined && x < s.min) || (s.max !== undefined && x > s.max)) {
        bad(say(`${n.en} must be from ${s.min ?? '…'} to ${s.max ?? '…'}.`, `${n.es} debe estar entre ${s.min ?? '…'} y ${s.max ?? '…'}.`));
      }
      if (s.step !== undefined && (x - (s.min ?? 0)) % s.step !== 0) bad(say(`${n.en} must go in steps of ${s.step}.`, `${n.es} debe ir de ${s.step} en ${s.step}.`));
      return x;
    }
    case 'enum':
      if (typeof v !== 'string' || !(s.choices ?? []).some((c) => c.value === v)) bad(say(`${n.en} must be one of its choices.`, `${n.es} debe ser una de sus opciones.`));
      return v as string;
    case 'string':
    case 'secret': {
      if (typeof v !== 'string') bad(say(`${n.en} must be text.`, `${n.es} debe ser texto.`));
      const x = v as string;
      if (/[\r\n\0]/.test(x)) bad(say(`${n.en} must be one line.`, `${n.es} debe ser una sola línea.`));
      const length = [...x].length;
      const max = Math.min(s.maxLength ?? TEXT_MAX, TEXT_MAX);
      // An empty secret is none (a server without a password), whatever its least length.
      const empty = s.type === 'secret' && x === '';
      if (!empty && s.minLength !== undefined && length < s.minLength) {
        bad(s.minLength === 1 ? say(`${n.en} can't be empty.`, `${n.es} no puede quedar vacío.`) : say(`${n.en} needs at least ${s.minLength} characters.`, `${n.es} necesita al menos ${s.minLength} caracteres.`));
      }
      if (length > max) bad(say(`${n.en} can have at most ${max} characters.`, `${n.es} puede tener como máximo ${max} caracteres.`));
      if (!empty && s.pattern !== undefined && !new RegExp(s.pattern).test(x)) bad(say(`${n.en} isn't in a form the game takes.`, `${n.es} no tiene una forma que el juego acepte.`));
      return x;
    }
  }
}

/** The manifest's rules across settings (Valheim's password of a public server), in order; the first broken one refuses. */
function checkRules(m: SteamGameManifest, values: Readonly<Record<string, SettingValue>>): void {
  for (const s of m.settings) {
    for (const r of s.rules ?? []) {
      if (r.if && !holds(r.if, values)) continue;
      const v = values[s.id];
      const text = typeof v === 'string' ? v : v === undefined ? '' : String(v);
      if (r.required && (text === '' || v === false)) throw refusal(s.id, r.message);
      if (r.minLength !== undefined && [...text].length < r.minLength) throw refusal(s.id, r.message);
      if (r.notIn !== undefined && text !== '') {
        const other = values[r.notIn];
        if (typeof other === 'string' && other.toLowerCase().includes(text.toLowerCase())) throw refusal(s.id, r.message);
      }
    }
  }
}

/**
 * Launch settings as people save them (the panel's form, or the API): every
 * key the manifest declares and nothing else, over the defaults; throws a
 * refusal for the first value the game can't take.
 */
export function checkSettings(m: SteamGameManifest, input: unknown): ManifestSettings {
  if (!isObject(input)) throw new Error('Launch settings must be an object');
  const v: Record<string, unknown> = { ...settingDefaults(m), ...input };
  const known = new Set<string>(['branch', 'updateOnStart', 'memoryMb', ...m.settings.map((s) => s.id)]);
  const extra = Object.keys(v).find((k) => !known.has(k));
  if (extra !== undefined) throw new Error(`Unknown launch setting ${extra}`);
  const branches = m.steam.branches === 'listed' ? null : [m.steam.defaultBranch, ...m.steam.branches];
  if (typeof v.branch !== 'string' || !BRANCH.test(v.branch) || (branches && !branches.includes(v.branch))) {
    throw refusal('branch', say('The Steam branch must be one of those the game offers (letters, digits, dots, dashes).', 'La rama de Steam debe ser una de las que ofrece el juego (letras, dígitos, puntos, guiones).'));
  }
  if (typeof v.updateOnStart !== 'boolean') throw refusal('updateOnStart', say('Updating before every start must be on or off.', 'Actualizar antes de cada inicio debe estar activado o desactivado.'));
  const mem = v.memoryMb;
  if (typeof mem !== 'number' || !Number.isInteger(mem) || mem < m.memory.minMb || mem > MEMORY_MAX_MB || mem % MEMORY_STEP !== 0) {
    throw refusal('memoryMb', say(`The game's memory must be a multiple of ${MEMORY_STEP} MiB from ${m.memory.minMb} to ${MEMORY_MAX_MB}.`, `La memoria del juego debe ser un múltiplo de ${MEMORY_STEP} MiB entre ${m.memory.minMb} y ${MEMORY_MAX_MB}.`));
  }
  const out: ManifestSettings = { branch: v.branch, updateOnStart: v.updateOnStart, memoryMb: mem };
  for (const s of m.settings) out[s.id] = checkOne(s, v[s.id]);
  checkRules(m, out);
  return out;
}

/**
 * The agent's launch params (`RuntimeAdapter.parseLaunch`): the server's
 * game name, its settings (checked again, rules included) and its
 * generated secrets.
 */
export function parseLaunch(m: SteamGameManifest, input: unknown): ManifestLaunch {
  if (!isObject(input)) throw new Error('Launch params must be an object');
  const { name, ...rest } = input;
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('name must be 1-64 letters, digits, dots, dashes or underscores');
  const secrets: Record<string, string> = {};
  for (const s of m.secrets ?? []) {
    const value = rest[s.id];
    if (typeof value !== 'string' || value === '' || value.length > 256 || /[\r\n\0]/.test(value)) throw new Error(`The secret ${s.id} is missing`);
    secrets[s.id] = value;
    delete rest[s.id];
  }
  // Every setting must be there: the agent never makes one up.
  for (const k of ['branch', 'updateOnStart', 'memoryMb', ...m.settings.map((s) => s.id)]) if (!Object.hasOwn(rest, k)) throw new Error(`${k} is missing`);
  return { ...checkSettings(m, rest), ...secrets, name };
}
