import { describe, expect, it } from 'vitest';
import type { OperationResult, ProposedOperation } from '../../../packages/core/src/model.js';
import { dispatchNeverReached, retrySafeReadonly, withReadOnlyRetry } from '../../../apps/desktop/src/worker/retry-policy.js';
import { BashAnalyzer } from '../../../packages/adapters/src/bash-analyzer.js';

const analyzer = new BashAnalyzer();
const scope = { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal',
  terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'inspect' };
const command = (value: string, extra: Partial<ProposedOperation> = {}): ProposedOperation =>
  ({ id: 'operation-1', kind: 'command', command: value, scope, ...extra }) as ProposedOperation;
const result = (extra: Partial<OperationResult>): OperationResult =>
  ({ operationId: 'operation-1', status: 'failed', stdoutTail: '', ...extra }) as OperationResult;

describe('dispatchNeverReached (category ① only)', () => {
  it('accepts a transport-proven never-dispatched failure', () => {
    expect(dispatchNeverReached(result({ failureKind: 'not-dispatched', effects: 'none' }))).toBe(true);
  });
  it.each([
    ['in-flight unknown', result({ status: 'unknown', failureKind: 'unknown' })],
    ['executor throw converted to unknown', result({ status: 'unknown' })],
    ['failed with possible effects', result({ failureKind: 'not-dispatched', effects: 'possible' })],
    ['requires user action', result({ failureKind: 'not-dispatched', effects: 'none', requiresUserAction: true })],
    ['ordinary command failure', result({ failureKind: 'unknown', effects: 'none', exitCode: 1 })],
    ['success', result({ status: 'succeeded', exitCode: 0 })]
  ])('rejects %s', (_label, value) => { expect(dispatchNeverReached(value)).toBe(false); });
});

describe('retrySafeReadonly pre-classification', () => {
  it('accepts an analyzer-confirmed effect-free query', async () => {
    expect(await retrySafeReadonly(command('cat /etc/hostname'), analyzer)).toBe(true);
  });
  it('rejects writes, background launches, process control, file kinds and analysis failures', async () => {
    expect(await retrySafeReadonly(command('rm -rf /tmp/data'), analyzer)).toBe(false);
    expect(await retrySafeReadonly(command('cat /etc/hostname', { executionMode: 'background' }), analyzer)).toBe(false);
    expect(await retrySafeReadonly(command('kill -TERM 1', { processControl: { jobId: 'job', targetOperationId: 'op', pid: 1, processSequence: 1, connectionId: 'c' } as never }), analyzer)).toBe(false);
    expect(await retrySafeReadonly(command('cat /etc/hostname', { kind: 'write-file', path: '/srv/app' } as never), analyzer)).toBe(false);
    expect(await retrySafeReadonly(command('cat /etc/hostname'), { analyze: () => Promise.reject(new Error('parse')) } as never)).toBe(false);
  });
  it('rejects an unparseable command instead of guessing', async () => {
    expect(await retrySafeReadonly(command(''), analyzer)).toBe(false);
  });
});

interface Scripted { outcome: 'not-dispatched' | 'unknown' | 'success'; }
async function retryFixture(script: Scripted['outcome'][], options: { signal?: AbortSignal; classify?: (operation: ProposedOperation) => Promise<boolean> } = {}) {
  const seen: string[] = [];
  const waits: number[] = [];
  const retries: Array<[string, number]> = [];
  const value = await withReadOnlyRetry<Scripted>({
    operation: command('cat /etc/hostname'),
    signal: options.signal,
    classifyRetrySafe: options.classify ?? (async () => true),
    retryableOutcome: (attempt) => attempt.outcome === 'not-dispatched' ? result({ operationId: seen.at(-1) ?? 'operation-1', failureKind: 'not-dispatched', effects: 'none' }) : undefined,
    attempt: async (operation) => { seen.push(operation.id); return { outcome: script[seen.length - 1] ?? 'success' }; },
    onRetry: (previousOperationId, nextAttempt) => retries.push([previousOperationId, nextAttempt]),
    wait: async (milliseconds) => { waits.push(milliseconds); }
  });
  return { value, seen, waits, retries };
}

describe('withReadOnlyRetry', () => {
  it('retries a read-only category-① failure twice with fresh operation IDs and 500/1500ms backoff', async () => {
    const f = await retryFixture(['not-dispatched', 'not-dispatched', 'success']);
    expect(f.value).toEqual({ outcome: 'success' });
    expect(f.seen).toHaveLength(3);
    expect(new Set(f.seen).size).toBe(3);
    expect(f.waits).toEqual([500, 1500]);
    expect(f.retries.map(([, attempt]) => attempt)).toEqual([2, 3]);
    expect(f.retries[0]![0]).toBe('operation-1');
    expect(f.retries[1]![0]).not.toBe('operation-1');
  });
  it('stops after three dispatches even when every attempt fails category-①', async () => {
    const f = await retryFixture(['not-dispatched', 'not-dispatched', 'not-dispatched']);
    expect(f.seen).toHaveLength(3);
    expect(f.waits).toEqual([500, 1500]);
  });
  it('never retries a category-② in-flight failure, even read-only', async () => {
    const f = await retryFixture(['unknown']);
    expect(f.seen).toHaveLength(1);
    expect(f.waits).toEqual([]);
  });
  it('never retries when the pre-classification refuses (writes)', async () => {
    const f = await retryFixture(['not-dispatched', 'success'], { classify: async () => false });
    expect(f.seen).toHaveLength(1);
  });
  it('stops immediately when the signal is already aborted', async () => {
    const f = await retryFixture(['not-dispatched', 'success'], { signal: AbortSignal.abort() });
    expect(f.seen).toHaveLength(1);
    expect(f.waits).toEqual([]);
  });
  it('stops when the signal aborts during backoff', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    await withReadOnlyRetry<Scripted>({
      operation: command('cat /etc/hostname'), signal: controller.signal,
      classifyRetrySafe: async () => true,
      retryableOutcome: (attempt) => attempt.outcome === 'not-dispatched' ? result({ failureKind: 'not-dispatched', effects: 'none' }) : undefined,
      attempt: async (operation) => { seen.push(operation.id); return { outcome: 'not-dispatched' }; },
      wait: async () => { controller.abort(); }
    });
    expect(seen).toHaveLength(1);
  });
  it('forwards non-retryable outcomes untouched', async () => {
    const f = await retryFixture(['success']);
    expect(f.value).toEqual({ outcome: 'success' });
    expect(f.seen).toEqual(['operation-1']);
  });
});
