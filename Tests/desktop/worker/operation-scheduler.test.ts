import { describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProposedOperation } from '../../../packages/core/src/model.js';
import type { CommandAnalyzer } from '../../../packages/core/src/ports.js';
import { BashAnalyzer } from '../../../packages/adapters/src/bash-analyzer.js';
import { classifyForScheduling, FULLY_SERIAL_LIMITS, OperationScheduler, type SchedulerKey } from '../../../apps/desktop/src/worker/operation-scheduler.js';

const analyzer = new BashAnalyzer();
const failingAnalyzer = { analyze: () => Promise.reject(new Error('analyzer unavailable')) } as unknown as CommandAnalyzer;
const scope = { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal',
  terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'inspect' };
const command = (id: string, value = 'true'): ProposedOperation => ({ id, kind: 'command', command: value, scope }) as ProposedOperation;
const structured = (id: string, kind: 'inspect-file' | 'list-recovery' | 'write-file' | 'upload'): ProposedOperation =>
  ({ id, kind, ...(kind === 'inspect-file' ? { path: '/srv/app.conf' } : {}),
    ...(kind === 'write-file' ? { path: '/srv/app.conf', content: '' } : {}),
    ...(kind === 'upload' ? { localPath: '/tmp/local', remotePath: '/srv/remote' } : {}), scope }) as ProposedOperation;
const key: SchedulerKey = { taskId: 'task-1', terminalId: 'conversation' };

describe('classifyForScheduling (ordering only, never authorization)', () => {
  it('classifies analyzer-confirmed effect-free commands as reads', async () => {
    expect(await classifyForScheduling(command('a', 'cat /etc/hostname'), analyzer)).toBe('read');
  });
  it('classifies mutations and write kinds as writes', async () => {
    expect(await classifyForScheduling(command('a', 'rm -rf /tmp/data'), analyzer)).toBe('write');
    expect(await classifyForScheduling(structured('b', 'write-file'), analyzer)).toBe('write');
    expect(await classifyForScheduling(structured('c', 'upload'), analyzer)).toBe('write');
  });
  it('classifies structured read kinds as reads without analysis', async () => {
    expect(await classifyForScheduling(structured('a', 'inspect-file'), failingAnalyzer)).toBe('read');
    expect(await classifyForScheduling(structured('b', 'list-recovery'), failingAnalyzer)).toBe('read');
  });
  it('fails closed to write on analysis failure or unparseable input', async () => {
    expect(await classifyForScheduling(command('a', 'cat /etc/hostname'), failingAnalyzer)).toBe('write');
    expect(await classifyForScheduling(command('b', ''), analyzer)).toBe('write');
  });
});

describe('OperationScheduler fully-serial equivalence (P0-3a)', () => {
  it('executes N operations strictly in submission order with no overlap', async () => {
    const scheduler = new OperationScheduler(FULLY_SERIAL_LIMITS);
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const submit = (id: string, ms: number) => scheduler.run(key, command(id), failingAnalyzer, async () => {
      active++; maxActive = Math.max(maxActive, active);
      events.push(`start:${id}`);
      await delay(ms);
      events.push(`end:${id}`);
      active--;
      return id;
    });
    const all = Promise.all([submit('a', 15), submit('b', 0), submit('c', 8), submit('d', 0)]);
    expect(await all).toEqual(['a', 'b', 'c', 'd']);
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c', 'start:d', 'end:d']);
    expect(maxActive).toBe(1);
  });

  it('propagates a failed attempt to its own caller without blocking later entries', async () => {
    const scheduler = new OperationScheduler(FULLY_SERIAL_LIMITS);
    const events: string[] = [];
    const first = scheduler.run(key, command('a'), failingAnalyzer, async () => { events.push('a'); return 'a'; });
    const second = scheduler.run(key, command('b'), failingAnalyzer, async () => { events.push('b'); throw new Error('signal aborted'); });
    const third = scheduler.run(key, command('c'), failingAnalyzer, async () => { events.push('c'); return 'c'; });
    await expect(second).rejects.toThrow('signal aborted');
    expect(await first).toBe('a');
    expect(await third).toBe('c');
    expect(events).toEqual(['a', 'b', 'c']);
  });

  it('keeps scheduling keys isolated: another task lane never waits behind this one', async () => {
    const scheduler = new OperationScheduler(FULLY_SERIAL_LIMITS);
    let releaseA!: () => void;
    const heldA = new Promise<void>((resolve) => { releaseA = resolve; });
    const first = scheduler.run(key, command('a'), failingAnalyzer, async () => { await heldA; return 'a'; });
    const otherKey: SchedulerKey = { taskId: 'task-2', terminalId: 'conversation' };
    const second = scheduler.run(otherKey, command('b'), failingAnalyzer, async () => 'b');
    expect(await second).toBe('b');
    releaseA();
    expect(await first).toBe('a');
  });

  it('drains a lane completely and accepts new work afterwards', async () => {
    const scheduler = new OperationScheduler(FULLY_SERIAL_LIMITS);
    const first = scheduler.run(key, command('a'), failingAnalyzer, async () => 'a');
    const second = scheduler.run(key, command('b'), failingAnalyzer, async () => 'b');
    expect(await Promise.all([first, second])).toEqual(['a', 'b']);
    expect(await scheduler.run(key, command('c'), failingAnalyzer, async () => 'c')).toBe('c');
  });
});
