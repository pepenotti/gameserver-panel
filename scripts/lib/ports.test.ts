import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE, blockPorts, parseSlot, portBlock, slotOfPort } from './ports.mjs';

describe('portBlock', () => {
  it('lays out slot 1 as documented', () => {
    const b = portBlock(1);
    expect(b.base).toBe(30100);
    expect(b.range).toEqual([30100, 30199]);
    expect(b.devPanel).toBe(30100);
    expect(b.devAgents).toEqual([30101, 30102, 30103, 30104]);
    expect(b.devWeb).toBe(30105);
    expect(b.devOrchestrator).toBe(30106);
    expect(b.fakeControl()).toBe(30110);
    expect(b.fakeControl(3)).toBe(30113);
    expect(b.stackHttps).toBe(30143);
    expect(b.gamePorts[0]).toBe(30150);
    expect(b.gamePorts.at(-1)).toBe(30199);
    expect(b.gamePorts).toHaveLength(50);
  });

  it('gives every slot 0-9 its own block, all inside 30000-30999', () => {
    const seen = new Set<number>();
    for (let s = 0; s <= 9; s++) {
      const b = portBlock(s);
      expect(b.base).toBe(30000 + 100 * s);
      const ports = [b.devPanel, ...b.devAgents, b.devWeb, b.devOrchestrator, b.fakeControl(0), b.fakeControl(32), b.stackHttps, ...b.gamePorts];
      for (const p of ports) {
        expect(p).toBeGreaterThanOrEqual(b.range[0]);
        expect(p).toBeLessThanOrEqual(b.range[1]);
        expect(slotOfPort(p)).toBe(s);
      }
      for (const p of blockPorts(s)) {
        expect(seen.has(p)).toBe(false);
        seen.add(p);
      }
    }
    expect(seen.size).toBe(10 * BLOCK_SIZE);
    expect(Math.min(...seen)).toBe(30000);
    expect(Math.max(...seen)).toBe(30999);
  });

  it('keeps roles apart inside a block', () => {
    const b = portBlock(4);
    const fixed = [b.devPanel, ...b.devAgents, b.devWeb, b.devOrchestrator, b.stackHttps];
    const fakes = Array.from({ length: 33 }, (_, k) => b.fakeControl(k));
    const all = [...fixed, ...fakes, ...b.gamePorts];
    expect(new Set(all).size).toBe(all.length);
  });

  it('refuses slots and indexes outside the layout', () => {
    for (const bad of [-1, 10, 1.5, Number.NaN]) expect(() => portBlock(bad)).toThrow(RangeError);
    expect(() => portBlock(0).fakeControl(33)).toThrow(RangeError);
    expect(() => portBlock(0).fakeControl(-1)).toThrow(RangeError);
    expect(slotOfPort(29999)).toBeUndefined();
    expect(slotOfPort(31000)).toBeUndefined();
  });

  it('parses a slot argument strictly', () => {
    expect(parseSlot('0')).toBe(0);
    expect(parseSlot('9')).toBe(9);
    for (const bad of [undefined, '', '10', '-1', '1a', ' 1', '01']) expect(() => parseSlot(bad)).toThrow(RangeError);
  });
});
