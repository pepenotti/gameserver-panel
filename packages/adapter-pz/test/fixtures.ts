import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../fixtures/b42/', import.meta.url));

/** Read a captured B42 fixture byte-exact (as UTF-8 text). */
export function fixture(rel: string): string {
  return readFileSync(root + rel, 'utf8');
}
