import { readdirSync, readFileSync, statfsSync } from 'node:fs';
import type { DiskStats, ProcessStats } from '@pz/shared';

const CLK_TCK = 100;
const PAGE = 4096;

interface Sample {
  at: number;
  ticks: number;
}

function readNum(file: string): number | null {
  try {
    const v = readFileSync(file, 'utf8').trim();
    return v === 'max' ? null : Number(v);
  } catch {
    return null;
  }
}

/** Sum RSS and CPU ticks over every process in the group (bash + JVM). Linux only. */
export class ProcessSampler {
  private last: Sample | null = null;

  sample(pgid: number | null): ProcessStats | null {
    if (process.platform !== 'linux' || pgid === null) return null;
    let rssPages = 0;
    let ticks = 0;
    let found = false;
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      } catch {
        continue;
      }
      // Fields after the ")" of comm; comm can contain spaces.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) !== pgid) continue; // pgrp
      found = true;
      ticks += Number(fields[11]) + Number(fields[12]); // utime + stime
      rssPages += Number(fields[21]); // rss
    }
    if (!found) return null;
    const now = Date.now();
    let cpuPercent = 0;
    if (this.last && now > this.last.at) cpuPercent = Math.max(0, ((ticks - this.last.ticks) / CLK_TCK / ((now - this.last.at) / 1000)) * 100);
    this.last = { at: now, ticks };
    return {
      rssBytes: rssPages * PAGE,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      cgroupBytes: readNum('/sys/fs/cgroup/memory.current'),
      cgroupLimitBytes: readNum('/sys/fs/cgroup/memory.max'),
    };
  }

  reset(): void {
    this.last = null;
  }
}

export function diskStats(paths: string[]): DiskStats[] {
  const out: DiskStats[] = [];
  for (const p of paths) {
    try {
      const s = statfsSync(p);
      out.push({ path: p, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize });
    } catch {
      // Missing mount: skip.
    }
  }
  return out;
}
