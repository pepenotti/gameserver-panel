import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import { pzRuntimeAdapter } from '../src/runtime';
import { fixture } from './fixtures';

const lines = (rel: string) => fixture(rel).split(/\r?\n/);

// The live half (the fake server through the agent's plumbing) runs in
// packages/agent/test/runtime-contract.test.ts.
runtimeAdapterSuite(pzRuntimeAdapter, {
  validLaunch: () => ({ serverName: 'zomboid', adminUsername: 'admin', adminPassword: 'Adm1nPassw0rd!', memoryMb: 8192, branch: 'public', updateOnStart: true }),
  captured: {
    boot: lines('logs/boot-with-rcon.log'),
    bootVersion: '42.20.4',
    prompt: lines('logs/admin-prompt.log'),
    // Standard JVM messages (none was captured from PZ itself).
    fatal: ['Exception in thread "main" java.lang.IllegalStateException: boom', 'java.lang.OutOfMemoryError: Java heap space', 'Error: Could not reserve enough space for object heap'],
  },
});
