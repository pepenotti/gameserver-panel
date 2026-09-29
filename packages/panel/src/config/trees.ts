/**
 * Objects of a JSON or JSON5 config file that are secret whole, keys
 * included (`ConfigFileDecl.secretTrees`, CFG-04): a game that keeps a token
 * as an object key (TShock's `ApplicationRestTokens`) can't be masked value
 * by value. What people see of such a file (forms, the text editor, diffs,
 * history) has the object replaced by a masked string, and a save puts back
 * what is on disk there, whatever the text holds. A file that doesn't parse
 * is still masked, by a tolerant scan for the object's key.
 */
import { formatFor, getJsonMember, parseJson, parseJson5, type FormatId, type JsonDoc } from '@gsp/formats';

interface Span {
  start: number;
  end: number;
}

function parse(format: FormatId, text: string): JsonDoc | null {
  try {
    if (format === 'json') return parseJson(text);
    if (format === 'json5') return parseJson5(text);
  } catch {
    return null;
  }
  return null;
}

/** The value of `path` in a parsed document; null when it isn't there. */
function exactSpan(doc: JsonDoc, path: string): Span | null {
  const hit = getJsonMember(doc.root, path);
  return hit ? { start: hit.member.value.start, end: hit.member.value.end } : null;
}

/** Where a value starting at `i` ends: a balanced object or list (strings skipped), else the next separator. */
function valueEnd(text: string, i: number): number {
  const open = text[i];
  if (open === '{' || open === '[') {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (c === '"' || c === "'") {
        for (j++; j < text.length && text[j] !== c; j++) if (text[j] === '\\') j++;
        continue;
      }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return text.length;
  }
  if (open === '"' || open === "'") {
    let j = i + 1;
    for (; j < text.length && text[j] !== open; j++) if (text[j] === '\\') j++;
    return Math.min(j + 1, text.length);
  }
  const m = /[,}\]\r\n]/.exec(text.slice(i));
  return m ? i + m.index : text.length;
}

/** Every value of a member named like the path's last key, for a text that doesn't parse. */
function tolerantSpans(text: string, path: string): Span[] {
  const key = path.split('.').at(-1)!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out: Span[] = [];
  const re = new RegExp(`(?:"${key}"|'${key}'|(?<![\\w$])${key}(?![\\w$]))\\s*:\\s*`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[0].length;
    if (start >= text.length) break;
    const end = valueEnd(text, start);
    out.push({ start, end });
    re.lastIndex = end;
  }
  return out;
}

/** Whether a value's text holds anything to hide (not an empty object, list or string). */
const hasContent = (value: string) => !/^(?:\{\s*\}|\[\s*\]|""|''|null)$/.test(value.trim());

function replace(text: string, spans: Span[], by: string): string {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + by + out.slice(s.end);
  return out;
}

/** `text` with each tree that holds anything replaced by `mask` (as a JSON string). */
export function maskTrees(format: FormatId, text: string, paths: readonly string[], mask: string): string {
  let out = text;
  for (const path of paths) {
    const doc = parse(format, out);
    const spans = doc ? [exactSpan(doc, path)].filter((s): s is Span => s !== null) : tolerantSpans(out, path);
    const hidden = spans.filter((s) => hasContent(out.slice(s.start, s.end)));
    if (hidden.length) out = replace(out, hidden, JSON.stringify(mask));
  }
  return out;
}

/** The text of a tree's value as it is on disk; null when it isn't there. */
function diskValue(format: FormatId, disk: string | null, path: string): string | null {
  if (disk === null) return null;
  const doc = parse(format, disk);
  const span = doc ? exactSpan(doc, path) : (tolerantSpans(disk, path)[0] ?? null);
  return span ? disk.slice(span.start, span.end) : null;
}

/**
 * `proposed` (which parses) with each tree as it is on disk: put back when
 * it was changed or removed, taken out when the disk has none. `touched`:
 * the trees the text had changed (other than leaving the mask in place).
 */
export function restoreTrees(format: FormatId, proposed: string, disk: string | null, paths: readonly string[], mask: string): { text: string; touched: string[] } {
  let out = proposed;
  const touched: string[] = [];
  const masked = JSON.stringify(mask);
  for (const path of paths) {
    const want = diskValue(format, disk, path);
    const doc = parse(format, out);
    if (!doc) throw new Error('The file is not valid JSON');
    const span = exactSpan(doc, path);
    const have = span ? out.slice(span.start, span.end) : null;
    if (have === want) continue;
    if (want === null) {
      out = formatFor({ format }).edit(out, { [path]: null });
      touched.push(path);
      continue;
    }
    if (span === null) {
      // Removed: back where it belongs, through a placeholder the format knows how to add.
      out = formatFor({ format }).edit(out, { [path]: mask });
      const again = exactSpan(parse(format, out)!, path)!;
      out = replace(out, [again], want);
      touched.push(path);
      continue;
    }
    out = replace(out, [span], want);
    if (have !== masked) touched.push(path);
  }
  return { text: out, touched };
}

/** Whether a flattened key is a tree or lies inside one. */
export function inTree(key: string, paths: readonly string[]): boolean {
  return paths.some((p) => key === p || key.startsWith(`${p}.`));
}
