/**
 * Globs over `/`-separated relative paths, as adapters declare them:
 * `*` and `?` stay inside one path segment, `**` spans segments (`**` + `/`
 * also matches no folder at all).
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(rel: string, globs: readonly RegExp[]): boolean {
  return globs.some((g) => g.test(rel));
}
