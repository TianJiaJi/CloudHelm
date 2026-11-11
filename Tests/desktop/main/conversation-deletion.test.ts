import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { AppEvent, ReferenceBody } from '@cloudhelm/contracts';
import { AppState } from '../../../apps/desktop/src/main/app-state.js';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
const resources: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of resources.splice(0).reverse()) close(); });
function setup() {
  const store = new SqliteStore(':memory:');
  const events: AppEvent[] = [];
  const state = new AppState(store, (event) => events.push(event));
  resources.push(() => { state.close(); store.close(); });
  const task = state.createTask('Synthetic deletion', [], 'fixture', []);
  const other = state.createTask('Keep this conversation', [], 'fixture', []);
  const body: ReferenceBody = { reference: { id: 'reference', kind: 'paste', capturedAt: 1 }, original: 'synthetic content' };
  store.putReference(body.reference.id, body);
  state.record({ type: 'task-message', taskId: task.id, role: 'user', text: 'synthetic', createdAt: 1,
    document: { requestId: 'request', parts: [{ type: 'reference', reference: body.reference }] } });
  state.record({ type: 'operation', value: { id: 'operation', taskId: task.id, hostId: 'host', kind: 'command',
    preview: 'pwd', status: 'succeeded', effects: 'none', readOnly: true, createdAt: 1 } });
  store.put('message-receipts', 'request', { conversationId: task.id, state: 'sent' });
  store.appendLog('operation:operation', 'synthetic output\n');
  state.requestBudgets.input(task.id, 'input-request');
  const disk = () => ({
    records: ['tasks', 'messages', 'operations', 'message-receipts', 'conversation-inputs', 'request-round-inputs', 'conversation-cleanups']
      .map((bucket) => [bucket, store.list(bucket)]),
    reference: store.readReference('reference'), log: store.readLog('operation:operation'),
    budget: store.requestBudgetReceipt(`task:${task.id}`, 'input:input-request')
  });
  return { store, state, events, task, other, disk };
}

describe('E01: atomic conversation record deletion', () => {
  it.each(['task', 'records', 'reference', 'logs'] as const)('rolls back %s failures without changing live projection or losing restart data', (point) => {
    const f = setup();
    const before = f.disk(), snapshot = f.state.snapshot(); f.events.length = 0;
    const fail = () => { throw new Error('synthetic deletion failure'); };
    if (point === 'task') {
      const remove = f.store.remove.bind(f.store);
      vi.spyOn(f.store, 'remove').mockImplementation((bucket, id) => { remove(bucket, id); if (bucket === 'tasks') fail(); });
    } else if (point === 'records') {
      const remove = f.store.removeWhere.bind(f.store);
      vi.spyOn(f.store, 'removeWhere').mockImplementation((bucket, field, value) => { remove(bucket, field, value); if (bucket === 'operations') fail(); });
    } else if (point === 'reference') {
      const remove = f.store.removeReference.bind(f.store);
      vi.spyOn(f.store, 'removeReference').mockImplementation((id) => { remove(id); fail(); });
    } else {
      const remove = f.store.removeLogs.bind(f.store);
      vi.spyOn(f.store, 'removeLogs').mockImplementation((id) => { remove(id); fail(); });
    }
    expect(() => f.state.deleteTask(f.task.id)).toThrow('synthetic deletion failure');
    expect(f.disk()).toEqual(before);
    expect(f.state.snapshot()).toEqual(snapshot);
    expect(f.events).toEqual([]);
    vi.restoreAllMocks();
    const restarted = new AppState(f.store, () => {});
    try { expect(restarted.getTask(f.task.id)).toEqual(f.state.getTask(f.task.id)); }
    finally { restarted.close(); }
  });

  it.each([false, true])('ignores late worker records even if the terminal already closed: %s', (closed) => {
    const f = setup();
    f.state.record({ type: 'terminal-state', terminalId: 'owned-terminal', taskId: f.task.id, hostId: 'host', state: 'agent' });
    f.state.record({ type: 'operation', value: { id: 'operation', taskId: f.task.id, hostId: 'host', kind: 'command',
      preview: 'pwd', status: 'succeeded', effects: 'none', readOnly: true, logRef: 'owned-terminal', createdAt: 1 } });
    if (closed) f.state.record({ type: 'terminal-state', terminalId: 'owned-terminal', taskId: f.task.id, hostId: 'host', state: 'closed' });
    f.state.deleteTask(f.task.id); const before = f.disk(); f.events.length = 0;
    expect(f.state.acceptsEvent({ type: 'terminal-data', terminalId: 'owned-terminal', data: 'late capture' })).toBe(false);
    f.state.record({ type: 'task-message', taskId: f.task.id, role: 'agent', text: 'late output', createdAt: 2 });
    f.state.record({ type: 'operation', value: { id: 'operation', taskId: f.task.id, hostId: 'host', kind: 'command',
      preview: 'pwd', status: 'succeeded', effects: 'none', readOnly: true, createdAt: 1 } });
    f.state.record({ type: 'terminal-state', terminalId: 'owned-terminal', hostId: 'host', state: 'human' });
    f.state.record({ type: 'terminal-data', terminalId: 'owned-terminal', data: 'late terminal output\n' });
    expect(f.disk()).toEqual(before); expect(f.events).toEqual([]);
    expect(f.state.snapshot().terminals).not.toContainEqual(expect.objectContaining({ id: 'owned-terminal' }));
    f.state.close(); expect(f.store.readLog('owned-terminal')).toBe('');
  });

  it('preserves legacy log/reference resources still used by another conversation', () => {
    const f = setup();
    const body = f.store.readReference<ReferenceBody>('reference')!;
    f.state.record({ type: 'task-message', taskId: f.other.id, role: 'user', text: 'keep', createdAt: 2,
      document: { requestId: 'other-request', parts: [{ type: 'reference', reference: body.reference }] } });
    for (const [id, taskId] of [['operation', f.task.id], ['other-operation', f.other.id]]) {
      f.state.record({ type: 'operation', value: { id: id!, taskId: taskId!, hostId: 'host', kind: 'command', preview: 'pwd',
        status: 'succeeded', effects: 'none', readOnly: true, logRef: 'shared-terminal', createdAt: 1 } });
    }
    f.store.appendLog('shared-terminal', 'keep this log');
    f.state.deleteTask(f.task.id);
    expect(f.store.readReference('reference')).toEqual(body);
    expect(f.store.readLog('shared-terminal')).toBe('keep this log');
    expect(f.store.get('operations', 'other-operation')).toBeDefined();
  });

  it('retains shared bodies referenced by another conversation input and collects them with the last owner', () => {
    const f = setup(); const body = f.store.readReference<ReferenceBody>('reference')!;
    f.store.put('conversation-inputs', 'queued-elsewhere', { id: 'queued-elsewhere', taskId: f.other.id, status: 'queued',
      document: { requestId: 'queued-request', parts: [{ type: 'reference', reference: body.reference }] } });
    f.state.deleteTask(f.task.id);
    expect(f.store.readReference('reference')).toEqual(body);
    f.store.commitConversationDeletion(f.other.id, [], []);
    expect(f.store.readReference('reference')).toBeUndefined();
  });

  it('commits an explicit cleanup receipt with deletion and retains unrelated conversations', () => {
    const f = setup(); f.events.length = 0;
    f.state.deleteTask(f.task.id);
    expect(f.store.get('tasks', f.task.id)).toBeUndefined();
    expect(() => f.state.getTask(f.task.id)).toThrow('Task not found');
    expect(f.store.get('tasks', f.other.id)).toEqual(f.state.getTask(f.other.id));
    expect(f.store.readReference('reference')).toBeUndefined();
    expect(f.store.readLog('operation:operation')).toBe('');
    expect(f.store.get('request-round-inputs', f.task.id)).toBeUndefined();
    expect(f.store.requestBudgetReceipt(`task:${f.task.id}`, 'input:input-request')).toBeUndefined();
    expect(f.store.get('conversation-cleanups', f.task.id)).toMatchObject({ version: 1, taskId: f.task.id, sessionId: f.task.id });
    expect(f.events.filter((event) => event.type === 'snapshot')).toHaveLength(1);
  });
});
