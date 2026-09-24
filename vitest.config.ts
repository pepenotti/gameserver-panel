import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Several worktrees may run their tests at once on one machine. A worktree's
// .env (scripts/worktree-env.mjs) caps the workers and stretches the agent
// tests' timeouts; the shell environment wins over it. Only these two keys
// are read from .env.
const fromEnvFile: Record<string, string> = {};
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^(VITEST_MAX_WORKERS|TEST_TIME_SCALE)=(\S+)$/.exec(line);
    if (m) fromEnvFile[m[1]!] = m[2]!;
  }
}
// Test workers inherit this process's environment.
if (!process.env.TEST_TIME_SCALE && fromEnvFile.TEST_TIME_SCALE) process.env.TEST_TIME_SCALE = fromEnvFile.TEST_TIME_SCALE;
const maxWorkers = Number(process.env.VITEST_MAX_WORKERS || fromEnvFile.VITEST_MAX_WORKERS) || undefined;

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'tools/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    ...(maxWorkers ? { maxWorkers } : {}),
  },
});
