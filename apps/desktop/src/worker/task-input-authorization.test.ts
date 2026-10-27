import { expect, it, vi } from 'vitest';
import { contextBudget } from '@cloudhelm/core';
import type { LocalScope, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { authorizeTaskInput } from './task-input-authorization.js';
function setup() {
  const task = { id: 'task', localScopes: [], hostIds: [] } as unknown as TaskView;
  const hosts: RuntimeHost[] = []; const scopes: LocalScope[] = [{ path: '/selected/file', kind: 'file' }];
  const base = { budget: contextBudget({ contextWindow: 32000, maxOutputTokens: 8192, historyTokens: 1000, frameTokens: 1000 }),
    historyTokens: 1000, hasHistory: true, modelIdle: true, remoteIdle: true, revision: 'before' };
  const event = vi.fn();
  const snapshot = (added?: LocalScope[]) => ({ ...base, revision: added?.length ? 'after' : base.revision });
  return { task, hosts, scopes, base, event, snapshot, prepared: { beforeRevision: 'before', revision: 'after', text: 'small' } };
}
it('validates the baseline and prospective frame before applying exactly the selected scope', () => {
  const f = setup(); authorizeTaskInput(f.task, f.hosts, [], f.scopes, f.snapshot, f.event, f.prepared);
  expect(f.task.localScopes).toEqual(f.scopes); expect(f.event).toHaveBeenCalledOnce();
});
it.each(['beforeRevision', 'revision'] as const)('rejects stale %s without granting scope or emitting an authorization event', (field) => {
  const f = setup(); f.prepared[field] = 'stale';
  expect(() => authorizeTaskInput(f.task, f.hosts, [], f.scopes, f.snapshot, f.event, f.prepared)).toThrow('版本已失效');
  expect(f.task.localScopes).toEqual([]); expect(f.event).not.toHaveBeenCalled();
});
it('rejects a changed target host and insufficient projected capacity without partial grant', () => {
  const f = setup();
  expect(() => authorizeTaskInput(f.task, f.hosts, [{ id: 'foreign' } as RuntimeHost], f.scopes, f.snapshot, f.event, f.prepared)).toThrow('主机授权');
  f.prepared.text = 'x'.repeat(100000);
  expect(() => authorizeTaskInput(f.task, f.hosts, [], f.scopes, f.snapshot, f.event, f.prepared)).toThrow('空间不足');
  expect(f.task.localScopes).toEqual([]); expect(f.task.hostIds).toEqual([]); expect(f.event).not.toHaveBeenCalled();
});
