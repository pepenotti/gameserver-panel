/**
 * Valve KeyValues text (VDF): `appmanifest_380870.acf` and the output of
 * `steamcmd +app_info_print 380870`.
 */

export type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

export class VdfError extends Error {}

export function parseVdf(text: string): VdfObject {
  let i = 0;
  const n = text.length;

  const skip = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i]!)) i++;
      if (text.startsWith('//', i)) {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      // Platform conditionals like [$WIN32] are ignored.
      if (text[i] === '[' && text[i + 1] === '$') {
        while (i < n && text[i] !== ']') i++;
        i++;
        continue;
      }
      return;
    }
  };

  const token = (): string | '{' | '}' | null => {
    skip();
    if (i >= n) return null;
    const c = text[i]!;
    if (c === '{' || c === '}') {
      i++;
      return c;
    }
    if (c === '"') {
      i++;
      let out = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1]!;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else out += text[i++];
      }
      if (i >= n) throw new VdfError('Unclosed string');
      i++;
      return out;
    }
    const s = i;
    while (i < n && !/[\s{}"]/.test(text[i]!)) i++;
    return text.slice(s, i);
  };

  const parseObject = (top: boolean): VdfObject => {
    const obj: VdfObject = {};
    for (;;) {
      const k = token();
      if (k === null) {
        if (top) return obj;
        throw new VdfError('Unexpected end of input');
      }
      if (k === '}') {
        if (top) throw new VdfError('Unexpected "}"');
        return obj;
      }
      if (k === '{') throw new VdfError('Expected a key, got "{"');
      const v = token();
      if (v === null || v === '}') throw new VdfError(`Missing value for "${k}"`);
      obj[k] = v === '{' ? parseObject(false) : v;
    }
  };

  return parseObject(true);
}

/** Case-insensitive path lookup: Steam is inconsistent about key case. */
export function vdfGet(obj: VdfValue | undefined, ...path: string[]): VdfValue | undefined {
  let cur: VdfValue | undefined = obj;
  for (const p of path) {
    if (cur === undefined || typeof cur === 'string') return undefined;
    const want = p.toLowerCase();
    const key: string | undefined = Object.keys(cur).find((k) => k.toLowerCase() === want);
    cur = key === undefined ? undefined : cur[key];
  }
  return cur;
}

export function vdfString(obj: VdfValue | undefined, ...path: string[]): string | undefined {
  const v = vdfGet(obj, ...path);
  return typeof v === 'string' ? v : undefined;
}

export interface InstalledApp {
  appId: string;
  buildId: string;
  /** Beta branch the install tracks; `public` when none is set. */
  branch: string;
  sizeOnDisk?: number;
  lastUpdated?: number;
  /** 4 = fully installed. */
  stateFlags?: number;
}

/** Read `steamapps/appmanifest_<id>.acf`. */
export function parseAppManifest(text: string): InstalledApp {
  const root = parseVdf(text);
  const state = vdfGet(root, 'AppState');
  const appId = vdfString(state, 'appid');
  const buildId = vdfString(state, 'buildid');
  if (!appId || !buildId) throw new VdfError('Not an app manifest');
  const beta = vdfString(state, 'UserConfig', 'BetaKey') ?? vdfString(state, 'MountedConfig', 'BetaKey');
  const num = (k: string) => {
    const v = vdfString(state, k);
    return v === undefined ? undefined : Number(v);
  };
  return {
    appId,
    buildId,
    branch: beta && beta !== '' ? beta : 'public',
    sizeOnDisk: num('SizeOnDisk'),
    lastUpdated: num('LastUpdated'),
    stateFlags: num('StateFlags'),
  };
}

export interface BranchInfo {
  name: string;
  buildId: string;
  timeUpdated?: number;
  description?: string;
  passwordRequired: boolean;
}

/**
 * Pull the branches out of `steamcmd +app_info_print <id>` output, which is
 * log noise followed by `"<id>" { … }`.
 */
export function parseAppInfoBranches(output: string, appId: string): BranchInfo[] {
  const re = new RegExp(`^\\s*"${appId}"\\s*$`, 'm');
  const m = re.exec(output);
  if (!m) throw new VdfError(`No app_info block for ${appId}`);
  // Parse from the id line to the matching close brace.
  const start = m.index;
  let depth = 0;
  let end = -1;
  let inStr = false;
  for (let i = output.indexOf('{', start); i < output.length; i++) {
    const c = output[i];
    if (c === '"' && output[i - 1] !== '\\') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) throw new VdfError('Unterminated app_info block');
  const root = parseVdf(output.slice(start, end));
  const branches = vdfGet(root, appId, 'depots', 'branches');
  if (!branches || typeof branches === 'string') throw new VdfError('No branches in app_info');
  return Object.entries(branches)
    .filter((e): e is [string, VdfObject] => typeof e[1] !== 'string')
    .map(([name, b]) => ({
      name,
      buildId: vdfString(b, 'buildid') ?? '',
      timeUpdated: vdfString(b, 'timeupdated') ? Number(vdfString(b, 'timeupdated')) : undefined,
      description: vdfString(b, 'description'),
      passwordRequired: vdfString(b, 'pwdrequired') === '1',
    }))
    .filter((b) => b.buildId !== '');
}
