import { describe, expect, it } from 'vitest';
import { mergeConnectionLosses, type ConnectionLossRecord, type OperationView } from '@cloudhelm/contracts';
import { classifyConnectionLoss, connectionLossText } from '../../../apps/desktop/src/worker/connection-loss.js';
import { connectionLossResumeContext } from '../../../apps/desktop/src/worker/recovery-context.js';

const view = (overrides: Partial<OperationView> & Pick<OperationView, 'id' | 'status'>): OperationView => ({
  taskId: 'task', hostId: 'host', kind: 'command', preview: 'fixture command', createdAt: 1, ...overrides
});

describe('connection loss classification', () => {
  it('classifies proposed and approved work as not handed off', () => {
    const record = classifyConnectionLoss({ hostId: 'host', lostAt: 10, pendingOperationIds: [],
      operations: [view({ id: 'a', status: 'proposed' }), view({ id: 'b', status: 'approved', readOnly: true })] });
    expect(record).toEqual({ version: 1, hostId: 'host', lostAt: 10, operations: [
      { operationId: 'a', classification: 'not-handed-off' },
      { operationId: 'b', classification: 'not-handed-off', readOnly: true }] });
  });

  it('classifies dispatched and unsettled work as handed off or unclear', () => {
    const record = classifyConnectionLoss({ hostId: 'host', lostAt: 10, pendingOperationIds: [],
      operations: [view({ id: 'a', status: 'running' }), view({ id: 'b', status: 'unknown', readOnly: true })] });
    expect(record.operations).toEqual([
      { operationId: 'a', classification: 'handed-off-or-unclear' },
      { operationId: 'b', classification: 'handed-off-or-unclear', readOnly: true }]);
  });

  it('lets an in-flight terminal command override its proposal status', () => {
    const record = classifyConnectionLoss({ hostId: 'host', lostAt: 10, pendingOperationIds: ['a'],
      operations: [view({ id: 'a', status: 'proposed' })] });
    expect(record.operations).toEqual([{ operationId: 'a', classification: 'handed-off-or-unclear' }]);
  });

  it('prefers a backend-observed completion over in-flight evidence', () => {
    const record = classifyConnectionLoss({ hostId: 'host', lostAt: 10, pendingOperationIds: ['a'],
      operations: [view({ id: 'a', status: 'unknown', exitObserved: true })] });
    expect(record.operations).toEqual([{ operationId: 'a', classification: 'observed-complete' }]);
  });

  it('keeps internal probes, reconciled operations, foreign hosts and settled outcomes out of the record', () => {
    const record = classifyConnectionLoss({ hostId: 'host', lostAt: 10, pendingOperationIds: [],
      operations: [view({ id: 'internal', status: 'running', internal: 'identity-probe' }),
        view({ id: 'reconciled', status: 'unknown', reconciledAt: 5 }),
        view({ id: 'foreign', status: 'running', hostId: 'other' }),
        view({ id: 'settled', status: 'succeeded', exitObserved: true }),
        view({ id: 'failed', status: 'failed', effects: 'none' })] });
    expect(record).toEqual({ version: 1, hostId: 'host', lostAt: 10, operations: [] });
  });
});

describe('connection loss persistence contract', () => {
  const record = (lostAt: number, hostId = 'host'): ConnectionLossRecord =>
    ({ version: 1, hostId, lostAt, operations: [{ operationId: 'op', classification: 'handed-off-or-unclear' }] });

  it('appends new losses, swallows redelivery and caps the history at eight records', () => {
    let losses = mergeConnectionLosses(undefined, record(1));
    expect(losses).toHaveLength(1);
    expect(mergeConnectionLosses(losses, record(1))).toBe(losses);
    for (let lostAt = 2; lostAt <= 10; lostAt++) losses = mergeConnectionLosses(losses, record(lostAt));
    expect(losses.map((loss) => loss.lostAt)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('keeps records for several hosts side by side and never clones on redelivery', () => {
    let losses = mergeConnectionLosses(undefined, record(1, 'a'));
    losses = mergeConnectionLosses(losses, record(2, 'b'));
    expect(losses.map((loss) => loss.hostId)).toEqual(['a', 'b']);
  });

  it('stores clones so later mutation of the input cannot rewrite history', () => {
    const input = record(1);
    const losses = mergeConnectionLosses(undefined, input);
    input.operations[0]!.classification = 'observed-complete';
    expect(losses[0]!.operations[0]!.classification).toBe('handed-off-or-unclear');
  });
});

describe('connection loss reporting', () => {
  it('summarizes affected operations and states what the evidence does not prove', () => {
    const text = connectionLossText({ version: 1, hostId: 'host', lostAt: 1, operations: [
      { operationId: 'a', classification: 'not-handed-off' },
      { operationId: 'b', classification: 'observed-complete' },
      { operationId: 'c', classification: 'handed-off-or-unclear' }] });
    expect(text).toBe('与主机 host 的连接中断。断线时共 3 项在途或待发操作：未交接 1、已观察完成 1、已交接或边界不明 1。'
      + '已交接或边界不明的操作不会自动重放，重连后先核验。重连成功不代表断线前的操作已完成。');
  });

  it('states when no operation was recorded in flight', () => {
    expect(connectionLossText({ version: 1, hostId: 'host', lostAt: 1, operations: [] }))
      .toBe('与主机 host 的连接中断。断线时没有记录到在途或待发操作。重连成功不代表断线前的操作已完成。');
  });

  it('reports the rebuilt connection with per-classification guidance and pending facts', () => {
    const context = connectionLossResumeContext([{ version: 1, hostId: 'host', lostAt: 7, operations: [
      { operationId: 'op-1', classification: 'handed-off-or-unclear' },
      { operationId: 'op-2', classification: 'not-handed-off', readOnly: true }] }],
      [view({ id: 'op-1', status: 'unknown' })]);
    expect(context).toContain('CloudHelm reconnected after a connection loss');
    expect(context).toContain('Connection success never proves an operation in flight during the loss finished');
    expect(context).toContain('restores no old shell, approval, password or challenge');
    expect(context).toContain('handed-off-or-unclear operations must never be re-run automatically');
    expect(context).toContain('not-handed-off operations never reached the host');
    expect(context).toContain('read-only losses add no business write lock');
    expect(context).toContain('"unresolvedOperationIds":["op-1"]');
    expect(context).toContain('op-2');
  });
});
