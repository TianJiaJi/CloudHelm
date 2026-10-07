import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './sqlite-store.js';

const stores: SqliteStore[] = [];
function open(): SqliteStore {
  const store = new SqliteStore(':memory:');
  stores.push(store);
  return store;
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('record cleanup for deleted conversations', () => {
  it('removes records by JSON field and keeps other conversations', () => {
    const store = open();
    store.put('messages', 'm1', { taskId: 'a', text: 'hello' });
    store.put('messages', 'm2', { taskId: 'b', text: 'kept' });
    store.put('operations', 'o1', { taskId: 'a', preview: 'rm' });
    store.removeWhere('messages', 'taskId', 'a');
    expect(store.list('messages')).toEqual([{ taskId: 'b', text: 'kept' }]);
    expect(store.list('operations')).toHaveLength(1);
  });

  it('removes records by literal prefix without matching wildcard characters', () => {
    const store = open();
    store.put('model-requests', 'a:1', { taskId: 'a' });
    store.put('model-requests', 'a:2', { taskId: 'a' });
    store.put('model-requests', 'ab:1', { taskId: 'ab' });
    store.put('model-requests', 'a_1', { taskId: 'a' });
    store.removePrefix('model-requests', 'a:');
    expect(store.list('model-requests').map((item) => (item as { taskId: string }).taskId).sort()).toEqual(['a', 'ab']);
  });

  it('removes terminal logs of one session only', () => {
    const store = open();
    store.appendLog('t1', 'first');
    store.appendLog('t2', 'other');
    store.removeLogs('t1');
    expect(store.readLog('t1')).toBe('');
    expect(store.readLog('t2')).toBe('other');
  });

  it('rejects unsafe field names', () => {
    const store = open();
    expect(() => store.removeWhere('messages', "taskId') OR 1=1 --", 'a')).toThrow();
    expect(() => store.removeWhere('messages', 'task-id', 'a')).toThrow();
  });
});
