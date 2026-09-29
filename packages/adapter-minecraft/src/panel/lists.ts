/**
 * What the game needs of its player lists (CFG-02, CFG-08). It writes them
 * as JSON arrays of objects (docs/verification/minecraft-26.3.md, "Config";
 * fixtures/minecraft/26.3/<loader>/files): `{uuid, name}` in the whitelist,
 * `{uuid, name, level, bypassesPlayerLimit}` for operators,
 * `{uuid, name, created, source, expires, reason}` for banned players and
 * `{ip, created, source, expires, reason}` for banned addresses. A list the
 * game can't read is not a list it half-reads: the owner's acceptance run
 * saved a whitelist of bare names (`["<name>"]`), and the next start logged
 * "Failed to load white-list … Expected entry to be a JsonObject" and ran
 * with an empty whitelist, refusing the owner. The ids come from the game's
 * own account lookup, so people add players on the Players page, not here.
 */
import { isIP } from 'node:net';
import type { ConfigIssue, I18n } from '@gsp/adapter-api';
import { lineColAt, parseJson, type JsonDoc, type JsonNode } from '@gsp/formats';

export type ListFile = 'whitelist' | 'ops' | 'banned-players' | 'banned-ips';

/** A player id as the game writes it (`8-4-4-4-12` hex digits). */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** More issues than this say nothing new. */
const MAX_ISSUES = 20;

type Check = (v: JsonNode) => boolean;
const text: Check = (v) => v.type === 'string';
const uuid: Check = (v) => v.type === 'string' && UUID.test(v.value);
const name: Check = (v) => v.type === 'string' && v.value.trim() !== '';
/** Operator levels as the game reads them (`op-permission-level` gives new operators 4). */
const level: Check = (v) => v.type === 'number' && Number.isInteger(v.value) && v.value >= 0 && v.value <= 4;
const bool: Check = (v) => v.type === 'boolean';
const ip: Check = (v) => v.type === 'string' && isIP(v.value) !== 0;

interface Shape {
  /** Keys every entry must have, and what their values must be. */
  required: Record<string, Check>;
  /** Keys the game also writes: when present, their values must be what it writes. */
  optional: Record<string, Check>;
  /** What an entry is, for people. */
  entry: I18n;
  /** Where to do it instead. */
  instead: I18n;
}

const BAN_DETAILS = { created: text, source: text, expires: text, reason: text };
const LOOKUP: I18n = { en: 'which lets the game look up each player’s id', es: 'así el juego busca el id de cada uno' };

const SHAPES: Record<ListFile, Shape> = {
  whitelist: {
    required: { uuid, name },
    optional: {},
    entry: {
      en: 'each entry is an object with the player’s "uuid" and "name", as the game writes it',
      es: 'cada entrada es un objeto con el "uuid" y el "name" del jugador, como lo escribe el juego',
    },
    instead: { en: `Add players on the Players page instead, ${LOOKUP.en}.`, es: `Agregá a los jugadores desde la página Jugadores, ${LOOKUP.es}.` },
  },
  ops: {
    required: { uuid, name, level },
    optional: { bypassesPlayerLimit: bool },
    entry: {
      en: 'each operator is an object with the player’s "uuid" and "name", a "level" from 0 to 4 and "bypassesPlayerLimit" (true or false), as the game writes it',
      es: 'cada operador es un objeto con el "uuid" y el "name" del jugador, un "level" de 0 a 4 y "bypassesPlayerLimit" (true o false), como lo escribe el juego',
    },
    instead: { en: `Give players their access level on the Players page instead, ${LOOKUP.en}.`, es: `Dales el nivel de acceso desde la página Jugadores, ${LOOKUP.es}.` },
  },
  'banned-players': {
    required: { uuid, name },
    optional: BAN_DETAILS,
    entry: {
      en: 'each ban is an object with the player’s "uuid" and "name", and "created", "source", "expires" and "reason" as text, as the game writes it',
      es: 'cada baneo es un objeto con el "uuid" y el "name" del jugador, y "created", "source", "expires" y "reason" como texto, como lo escribe el juego',
    },
    instead: { en: `Ban players on the Players page instead, ${LOOKUP.en}.`, es: `Baneá a los jugadores desde la página Jugadores, ${LOOKUP.es}.` },
  },
  'banned-ips': {
    required: { ip },
    optional: BAN_DETAILS,
    entry: {
      en: 'each ban is an object with the "ip" address, and "created", "source", "expires" and "reason" as text, as the game writes it',
      es: 'cada baneo es un objeto con la dirección "ip", y "created", "source", "expires" y "reason" como texto, como lo escribe el juego',
    },
    instead: { en: 'Ban addresses on the Players page instead.', es: 'Baneá las direcciones desde la página Jugadores.' },
  },
};

/** Whether an entry has the shape the game reads. */
function fits(node: JsonNode, shape: Shape): boolean {
  if (node.type !== 'object') return false;
  const member = (k: string) => node.members.findLast((m) => m.key === k)?.value;
  for (const [k, ok] of Object.entries(shape.required)) {
    const v = member(k);
    if (!v || !ok(v)) return false;
  }
  for (const [k, ok] of Object.entries(shape.optional)) {
    const v = member(k);
    if (v && !ok(v)) return false;
  }
  return true;
}

/** `ConfigFileDecl.check` for one of the game's player lists: one issue per entry the game couldn't load. */
export function listCheck(file: ListFile): (text: string) => ConfigIssue[] {
  const shape = SHAPES[file];
  return (src) => {
    let doc: JsonDoc;
    try {
      doc = parseJson(src);
    } catch {
      // Not JSON at all: the format's own check says where.
      return [];
    }
    const at = (n: JsonNode) => lineColAt(doc.src, n.start);
    if (doc.root.type !== 'array') {
      return [
        {
          ...at(doc.root),
          message: {
            en: `The game expects a list here ([ … ]), where ${shape.entry.en}. ${shape.instead.en}`,
            es: `El juego espera una lista acá ([ … ]), donde ${shape.entry.es}. ${shape.instead.es}`,
          },
        },
      ];
    }
    const issues: ConfigIssue[] = [];
    for (const [i, item] of doc.root.items.entries()) {
      if (fits(item, shape)) continue;
      issues.push({
        ...at(item),
        message: {
          en: `The game can’t load entry ${i + 1}: ${shape.entry.en}. ${shape.instead.en}`,
          es: `El juego no puede cargar la entrada ${i + 1}: ${shape.entry.es}. ${shape.instead.es}`,
        },
      });
      if (issues.length >= MAX_ISSUES) break;
    }
    return issues;
  };
}
