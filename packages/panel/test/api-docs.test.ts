// AST-01 "documented API": docs/api.md is generated from the route table
// (scripts/gen-api-docs.ts) and must match the routes the panel has now.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_DOCS, apiRoutes, renderApiDocs } from '../../../scripts/gen-api-docs';

describe('the API reference (AST-01)', () => {
  it('documents every route as it is: run `npx tsx scripts/gen-api-docs.ts` when this fails', async () => {
    const routes = await apiRoutes();
    const expected = renderApiDocs(routes);
    const actual = readFileSync(API_DOCS, 'utf8').replace(/\r\n/g, '\n');
    expect(actual).toBe(expected);
    // Every route has its row, with its guard.
    for (const r of routes) expect(expected, `${r.method} ${r.url}`).toMatch(new RegExp(`\\| ${r.method} \\| \``));
    expect(expected).not.toContain('**none**');
  });
});
