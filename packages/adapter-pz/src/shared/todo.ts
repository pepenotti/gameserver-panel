/**
 * Placeholder for contract members the M1 wave still has to port from the
 * core into this adapter. M1-A fills `runtime/`, M1-B `panel/core/`, M1-C
 * `panel/config/`; this file goes once nothing calls it.
 */
export function todo(owner: 'M1-A' | 'M1-B' | 'M1-C', what: string): never {
  throw new Error(`Project Zomboid adapter: ${what} is not ported yet (${owner})`);
}
