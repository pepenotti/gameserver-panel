// The host page and the notes about addresses in the web (HST-03, HST-05,
// HST-07, SRV-05, UX-01): shares of what the host has, the memory warning,
// the disk's parts, which notes show where, the settings of a server's game
// that act per address, and plain names for processors.
import { describe, expect, it } from 'vitest';
import type { HostOverviewTotals } from '../src/api/host';
import type { Meta } from '../src/api/meta';
import { en } from '../src/i18n/en';
import { es } from '../src/i18n/es';
import { addressNote, archKey, cpuShare, diskParts, formatPercent, memoryBar, memoryWarning, memShare, percent, perAddressIn } from '../src/lib/host';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

const memory = (over: Partial<HostOverviewTotals['memory']> = {}): HostOverviewTotals['memory'] => ({ limitsMb: 16384, runningLimitsMb: 4096, usedBytes: 2 * GIB, hostBytes: 16 * GIB, ...over });

describe('what the host page works out (HST-03, SRV-05)', () => {
  it('shares of what the host has, unknown where a part is', () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(2 * GIB, 16 * GIB)).toBe(13);
    expect(percent(null, 4)).toBeNull();
    expect(percent(1, null)).toBeNull();
    expect(percent(1, 0)).toBeNull();
    expect(memShare({ memBytes: 512 * MIB, memLimitMb: 1024 })).toBe(50);
    expect(memShare({ memBytes: null, memLimitMb: 1024 })).toBeNull();
    // Percent of one core over every core: 300 % of one core on 12 cores is a quarter of the computer.
    expect(cpuShare({ percent: 300, hostCpus: 12, limitsCpus: 0, unlimited: 2 })).toBe(25);
    expect(cpuShare({ percent: null, hostCpus: 12, limitsCpus: 0, unlimited: 2 })).toBeNull();
    expect(cpuShare({ percent: 50, hostCpus: null, limitsCpus: 0, unlimited: 2 })).toBeNull();
  });

  it('draws the memory bar capped at full, whatever the limits add up to', () => {
    expect(memoryBar(memory())).toEqual({ used: 13, limits: 100 });
    expect(memoryBar(memory({ limitsMb: 4096 }))).toEqual({ used: 13, limits: 25 });
    expect(memoryBar(memory({ usedBytes: null, hostBytes: null }))).toEqual({ used: null, limits: null });
  });

  it('warns about memory once, the louder warning when the running servers already exceed it (SRV-05)', () => {
    expect(memoryWarning({ warnings: [] })).toBeNull();
    expect(memoryWarning({ warnings: [{ code: 'memory-over', limitsMb: 20480, hostMb: 16384 }] })).toEqual({ key: 'host.memory.over', limitsBytes: 20 * GIB, hostBytes: 16 * GIB });
    expect(memoryWarning({ warnings: [{ code: 'memory-over', limitsMb: 1, hostMb: 1 }, { code: 'memory-over-running', limitsMb: 10240, hostMb: 8192 }] })).toMatchObject({ key: 'host.memory.overRunning', limitsBytes: 10 * GIB });
    for (const key of ['over', 'overRunning'] as const) {
      expect(en.host.memory[key]).toMatch(/\{\{limits\}\}.*\{\{host\}\}/);
      expect(es.host.memory[key]).toMatch(/\{\{limits\}\}.*\{\{host\}\}/);
    }
  });

  it('lists the disk in the same parts the API adds up, each named in both languages', () => {
    const parts = diskParts({ serversBytes: 1, installsBytes: null, backupsBytes: 3, panelBytes: 4, totalBytes: null });
    expect(parts.map((p) => p.bytes)).toEqual([1, null, 3, 4]);
    for (const p of parts) {
      const name = p.key.split('.').pop() as keyof typeof en.host.disk;
      expect(en.host.disk[name], p.key).toBeTruthy();
      expect(es.host.disk[name], p.key).toBeTruthy();
    }
  });

  it('writes percentages the way each language does', () => {
    expect(formatPercent(150, 'en')).toBe('150%');
    expect(formatPercent(150, 'es')).toBe('150 %');
    expect(formatPercent(2.54, 'en')).toBe('2.5%');
    expect(formatPercent(2.54, 'es')).toBe('2,5 %');
    expect(formatPercent(0, 'en')).toBe('0%');
    expect(formatPercent(null, 'en')).toBe('—');
  });

  it('names processors plainly, not as Docker does (HST-05)', () => {
    expect(archKey('amd64')).toBe('host.facts.archValue.amd64');
    expect(en.host.facts.archValue.amd64).toBe('x86-64');
    expect(es.host.facts.archValue.arm64).toMatch(/ARM/);
    expect(archKey('s390x')).toBeNull();
  });
});

describe('notes about addresses where they matter (HST-07)', () => {
  it('only where every visitor shares one address, or the panel can’t tell', () => {
    expect(addressNote('hidden')).toBe('hidden');
    expect(addressNote('unknown')).toBe('unknown');
    expect(addressNote('expected')).toBeNull();
    expect(addressNote('visible')).toBeNull();
    expect(addressNote(null)).toBeNull();
    expect(en.host.addresses.hidden).toMatch(/Docker Desktop/);
    expect(es.host.addresses.hidden).toMatch(/Docker Desktop/);
  });

  it('on a config file, the per-address settings of the server’s flavour in that file', () => {
    const meta = (flavour: string | null) =>
      ({
        adapter: {
          id: 'game',
          name: { en: 'Game', es: 'Juego' },
          runtime: 'java',
          memory: { minMb: 1, defaultMb: 1, overheadMb: 1 },
          capabilities: [],
          perAddress: [
            { id: 'throttle', file: 'main', key: 'settings.throttle', flavours: ['plus'], text: { en: 'a', es: 'a' } },
            { id: 'proxy', file: 'props', key: 'proxy-check', text: { en: 'b', es: 'b' } },
          ],
        },
        server: { gameName: 'g', flavour },
      }) as Pick<Meta, 'adapter' | 'server'>;
    expect(perAddressIn(meta('plus'), 'main').map((s) => s.id)).toEqual(['throttle']);
    expect(perAddressIn(meta('plain'), 'main')).toEqual([]);
    expect(perAddressIn(meta(null), 'main')).toEqual([]);
    expect(perAddressIn(meta('plain'), 'props').map((s) => s.id)).toEqual(['proxy']);
    expect(perAddressIn(null, 'props')).toEqual([]);
    expect(perAddressIn({ ...meta('plus'), adapter: { ...meta('plus').adapter, perAddress: undefined } }, 'main')).toEqual([]);
  });
});
