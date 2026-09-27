/**
 * The Java runtimes of the `java` image (docker/java, PRD §10): Eclipse
 * Temurin JREs side by side in `/opt/java/<major>`.
 */
import type { RuntimeCtx } from '@gsp/adapter-api';

export const JAVA_ROOT = '/opt/java';

/** The JRE majors the image ships. */
export const SHIPPED_JRES: readonly number[] = [25, 21, 17];

/**
 * The shipped JRE for the Java major a Minecraft version declares (Mojang's
 * `javaVersion.majorVersion`). Measured: 26.x declare 25, 1.20.5–1.21.11
 * declare 21, 1.18–1.20.4 declare 17; 1.17.x declare 16 and 1.16.5 declares
 * 8, and both ran on 17 (no Temurin 16 image exists). Anything else is
 * refused rather than guessed.
 */
export function jreFor(declared: number): number {
  if (declared === 8 || declared === 16) return 17;
  if (SHIPPED_JRES.includes(declared)) return declared;
  throw new Error(`This Minecraft version needs Java ${declared}, which the server image doesn't have (it has ${SHIPPED_JRES.join(', ')})`);
}

export function javaBin(jre: number): string {
  return `${JAVA_ROOT}/${jre}/bin/java`;
}

/** `java` itself, or the host's launcher standing in for it (tests and the dev loop run the fake with the same arguments). */
export function javaCommand(ctx: RuntimeCtx, jre: number): string[] {
  return ctx.tools.launcher ? [...ctx.tools.launcher] : [javaBin(jre)];
}
