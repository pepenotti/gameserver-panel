// Port blocks for parallel worktrees on one machine. Pure: no I/O.
//
// Slot N (0-9) owns the 100 ports B..B+99 with B = 30000 + 100*N:
//   B+0       dev panel API          B+10+k   fake game control port k (RCON…)
//   B+1..B+4  dev agents             B+43     stack HTTPS (Caddy)
//   B+5       dev web (Vite)         B+50..99 game ports of the slot's stack
//   B+6       dev orchestrator
// Nothing a slot runs may listen outside its block.

export const SLOTS = 10;
export const FIRST_PORT = 30000;
export const BLOCK_SIZE = 100;
/** fakeControl(k) stays below stackHttps. */
export const MAX_FAKE_CONTROL = 32;

/** @param {number} n */
function checkSlot(n) {
  if (!Number.isInteger(n) || n < 0 || n >= SLOTS) throw new RangeError(`slot must be an integer from 0 to ${SLOTS - 1}, got ${n}`);
}

/** Parses a slot given on the command line ("1"); throws on anything else. */
export function parseSlot(/** @type {string | undefined} */ text) {
  if (text === undefined || !/^\d$/.test(text)) throw new RangeError(`slot must be a digit from 0 to ${SLOTS - 1}, got ${text ?? 'nothing'}`);
  const n = Number(text);
  checkSlot(n);
  return n;
}

/** @param {number} slot */
export function portBlock(slot) {
  checkSlot(slot);
  const base = FIRST_PORT + BLOCK_SIZE * slot;
  const span = (/** @type {number} */ from, /** @type {number} */ to) => Array.from({ length: to - from + 1 }, (_, i) => base + from + i);
  return {
    slot,
    base,
    /** First and last port of the block, inclusive. */
    range: /** @type {[number, number]} */ ([base, base + BLOCK_SIZE - 1]),
    devPanel: base,
    devAgents: span(1, 4),
    devWeb: base + 5,
    devOrchestrator: base + 6,
    /** @param {number} [k] */
    fakeControl(k = 0) {
      if (!Number.isInteger(k) || k < 0 || k > MAX_FAKE_CONTROL) throw new RangeError(`fake control index must be 0-${MAX_FAKE_CONTROL}, got ${k}`);
      return base + 10 + k;
    },
    stackHttps: base + 43,
    gamePorts: span(50, 99),
  };
}

/** Every port of a slot's block, in order. */
export function blockPorts(/** @type {number} */ slot) {
  const [first, last] = portBlock(slot).range;
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** The slot whose block contains `port`, or undefined. */
export function slotOfPort(/** @type {number} */ port) {
  const n = Math.floor((port - FIRST_PORT) / BLOCK_SIZE);
  return Number.isInteger(port) && n >= 0 && n < SLOTS ? n : undefined;
}
