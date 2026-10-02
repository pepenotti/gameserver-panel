// How players join a server (SRV-08), as the web shows and shares it: the
// lines of each place, the client line, the whole message a Share sends,
// and copying with a fallback for browsers without the Clipboard API.
// Pure apart from `browserEnv`: tests give their own clipboard, page and
// share sheet.
import { checkAddress, type ConnectionInfo, type JoinPlace } from '@gsp/shared';
import { localize } from '../api/meta';

/** A translator (`t` from react-i18next, or an i18next instance's). */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The places as a shared message lists them: friends first (the internet), then home, then this PC. */
export const SHARE_ORDER: readonly JoinPlace[] = ['internet', 'home', 'pc'];

/** The client players need, with the server's version when it must match and is known: "Game 1.2.3". */
export function clientLine(info: Pick<ConnectionInfo, 'client'>, lang: string): string {
  const name = localize(info.client.name, lang);
  return info.client.sameVersion && info.client.version ? `${name} ${info.client.version}` : name;
}

/** What players type at a place, as one line: the game's own format, or the address and the port when it asks for them apart. */
export function placeText(info: Pick<ConnectionInfo, 'format' | 'port'>, text: string, t: Translate): string {
  return info.format === 'separate' ? t('connection.share.addressAndPort', { address: text, port: info.port.number }) : text;
}

/**
 * The whole message a Share (or "Copy all") sends, in the reader's
 * language: the server and its game, what to type from each place that has
 * an address, where in the game, the client, the password (its value only
 * when it was asked for and given), the steps, and that it isn't verified
 * yet when it isn't.
 */
export function shareMessage(info: ConnectionInfo, t: Translate, lang: string, o: { includePassword?: boolean } = {}): string {
  const lines = [t('connection.share.title', { server: info.server.name, game: localize(info.game, lang) })];
  for (const place of SHARE_ORDER) {
    const p = info.places.find((x) => x.place === place);
    if (p?.text) lines.push(`${t(`connection.places.${place}`)}: ${placeText(info, p.text, t)}`);
  }
  lines.push(t('connection.share.where', { where: localize(info.where, lang) }));
  lines.push(t('connection.share.client', { client: clientLine(info, lang) }));
  if (info.password.set === true) lines.push(o.includePassword && info.password.value !== null ? t('connection.share.password', { password: info.password.value }) : t('connection.share.passwordAsk'));
  for (const s of info.steps) lines.push(`- ${s.applies === 'unknown' ? `${t('connection.share.mayApply')} ` : ''}${localize(s.text, lang)}`);
  if (!info.verified) lines.push(info.note ? localize(info.note, lang) : t('connection.share.unverified'));
  return lines.join('\n');
}

/**
 * What the host settings form says about an address the owner is typing
 * (HST-08), before the API does: null when it is fine (empty included: the
 * default), else the translation key of its problem.
 */
export function addressProblemKey(value: string): string | null {
  if (value.trim() === '') return null;
  const c = checkAddress(value);
  return c.ok ? null : `hostSettings.address.problems.${c.problem}`;
}

// --------------------------------------------------------------- copying

/** The few page features copying uses (the DOM's, or a test's fakes). */
export interface TextArea {
  value: string;
  style: { position: string; top: string; opacity: string };
  setAttribute(name: string, value: string): void;
  select(): void;
  remove(): void;
}
export interface PageLike {
  body: { appendChild(node: TextArea): unknown } | null;
  createElement(tag: 'textarea'): TextArea;
  /** The old copy command: the fallback where the Clipboard API is missing (plain HTTP, older browsers). */
  execCommand(command: 'copy'): boolean;
}

export interface ShareData {
  title: string;
  text: string;
}

export interface CopyEnv {
  /** `navigator.clipboard`: absent outside a secure page and in older browsers. */
  clipboard?: { writeText(text: string): Promise<void> } | null;
  page?: PageLike | null;
}

export interface ShareEnv extends CopyEnv {
  /** `navigator.share`: the phone's share sheet, where the browser has one. */
  share?: ((data: ShareData) => Promise<void>) | null;
  canShare?: ((data: ShareData) => boolean) | null;
}

/** The browser's own clipboard, page and share sheet. */
export function browserEnv(): ShareEnv {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { share?: (d: ShareData) => Promise<void>; canShare?: (d: ShareData) => boolean });
  return {
    clipboard: nav?.clipboard ?? null,
    page: typeof document === 'undefined' ? null : (document as unknown as PageLike),
    share: typeof nav?.share === 'function' ? (d) => nav.share!(d) : null,
    canShare: typeof nav?.canShare === 'function' ? (d) => nav.canShare!(d) : null,
  };
}

/**
 * Copies `text`: through the Clipboard API, else through a hidden text
 * area and the page's copy command. False when neither worked (people then
 * select the text themselves).
 */
export async function copyText(text: string, env: CopyEnv = browserEnv()): Promise<boolean> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (no permission, the page not focused): the fallback below.
    }
  }
  const page = env.page;
  if (!page?.body) return false;
  const area = page.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.opacity = '0';
  page.body.appendChild(area);
  try {
    area.select();
    return page.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** What a Share did: the share sheet took it, the person closed it, or (without one, or when it failed) the message was copied, or not. */
export type ShareResult = 'shared' | 'cancelled' | 'copied' | 'failed';

/**
 * Opens the phone's share sheet (Web Share API) with the message where the
 * browser has one; copies the whole message otherwise, and when the sheet
 * fails for any reason but the person closing it.
 */
export async function shareText(data: ShareData, env: ShareEnv = browserEnv()): Promise<ShareResult> {
  if (env.share && (!env.canShare || env.canShare(data))) {
    try {
      await env.share(data);
      return 'shared';
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
    }
  }
  return (await copyText(data.text, env)) ? 'copied' : 'failed';
}
