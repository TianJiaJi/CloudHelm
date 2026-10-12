import { describe, expect, it } from 'vitest';
import { serialCall } from './serial-call.js';

describe('serial call queue', () => {
  it('runs calls strictly one at a time in arrival order', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = serialCall(async (name: string, wait?: Promise<void>) => {
      order.push(`${name}:start`);
      await wait;
      order.push(`${name}:end`);
      return name;
    });
    const first = run('first', gate);
    const second = run('second');
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    release();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('keeps the queue usable after a rejected call', async () => {
    const run = serialCall(async (fail: boolean) => {
      if (fail) throw new Error('boom');
      return 'ok';
    });
    await expect(run(true)).rejects.toThrow('boom');
    await expect(run(false)).resolves.toBe('ok');
  });
});
