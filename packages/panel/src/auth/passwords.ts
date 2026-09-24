import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEYLEN = 64;

/** `scrypt$N$r$p$salt$hash` (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { ...PARAMS, maxmem: 128 * PARAMS.N * PARAMS.r * 2 });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, saltB64, hashB64] = stored.split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash that never verifies, to spend the same time on unknown usernames. */
let dummy: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(12).toString('hex'));
  await verifyPassword(password, await dummy);
}

export interface PasswordProblem {
  code: 'too-short' | 'too-long' | 'same-as-username' | 'too-common';
}

const COMMON = new Set(['password', 'password1', '12345678', '123456789', 'qwertyuiop', 'contraseña', 'zomboid', 'projectzomboid', 'iloveyou', '11111111', 'admin123', 'administrator']);

export function checkPasswordPolicy(password: string, username: string): PasswordProblem | null {
  if ([...password].length < 10) return { code: 'too-short' };
  if (password.length > 200) return { code: 'too-long' };
  if (password.toLowerCase() === username.toLowerCase()) return { code: 'same-as-username' };
  if (COMMON.has(password.toLowerCase())) return { code: 'too-common' };
  return null;
}
