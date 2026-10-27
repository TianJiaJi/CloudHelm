import { expect, it, vi } from 'vitest';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { createTaskPrompt } from './task-prompt.js';
import type { PrivilegedTaskAccess } from './privileged-access.js';

const host: RuntimeHost = { id: 'host', label: 'host', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
  status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
const task: TaskView = { id: 'task', goal: '只解释错误', hostIds: ['host'], localScopes: [], modelId: 'fixture',
  status: 'running', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1 };
const operation = (id: string, changes: Partial<OperationView> = {}): OperationView => ({ id, taskId: 'task', hostId: 'host',
  kind: 'command', preview: 'untrusted history is not capability', status: 'succeeded', createdAt: 1, ...changes });
function facts(prompt: string) {
  const encoded = prompt.split('\n').find((line) => line.startsWith('{"version":1,"tools":'));
  if (!encoded) throw new Error('Missing applicability projection');
  return JSON.parse(encoded) as { tools: Record<string, boolean | string>; reportCount: number; unresolvedCount: number;
    confirmedRootSessions: unknown[] | null; omittedRootSessions: number };
}
it('refreshes backend applicability without changing the stable thirteen declarations or using display text', () => {
  const current = structuredClone(task);
  let operations = [operation('query', { readOnly: true, effects: 'none' }), operation('foreign', { taskId: 'other' })];
  let reported = false;
  const prompt = createTaskPrompt(current, [host], () => operations, () => operations, undefined, () => reported);
  const first = facts(prompt());
  expect(Object.keys(first.tools)).toHaveLength(13);
  expect(first).toMatchObject({ tools: { read_selected_text_file: false, list_selected_directory: false, upload_selected_file: false,
    read_operation_log: true, submit_verification: false, record_reconciled_result: false, request_root_session: false }, reportCount: 0, unresolvedCount: 0 });
  expect(prompt().length).toBeLessThan(9000);
  current.localScopes = [{ path: 'C:/selected', kind: 'directory' }];
  operations = [operation('write', { readOnly: false }), operation('unknown', { status: 'unknown', effects: 'possible' })];
  expect(facts(prompt())).toMatchObject({ tools: { read_selected_text_file: true, list_selected_directory: true,
    upload_selected_file: true, submit_verification: true, record_reconciled_result: true }, reportCount: 1, unresolvedCount: 1 });
  reported = true;
  expect(facts(prompt())).toMatchObject({ tools: { submit_verification: false }, reportPending: false });
  expect(prompt()).toContain('not host-wide locks or approval');
  operations = [operation('handled', { status: 'unknown', effects: 'possible', reconciledAt: 3 })];
  expect(facts(prompt())).toMatchObject({ unresolvedCount: 0, reportCount: 0 });
});
it('bounds confirmed session hints, drops foreign hosts and never forwards extra credential fields', () => {
  const roots = Array.from({ length: 12 }, (_, i) => ({ sessionId: `root-${i}`, hostId: 'host', method: 'ssh' as const,
    runAs: 'root' as const, secret: 'must-not-be-projected' }));
  const confirmed = vi.fn(() => [...roots, { ...roots[0]!, hostId: 'foreign' }]);
  const privileged: PrivilegedTaskAccess = { request: async () => { throw new Error('not requested'); },
    terminal: () => 'terminal', scope: () => ({}), owns: () => false, close() {}, confirmed };
  const prompt = createTaskPrompt(task, [host], () => [], () => [], privileged);
  expect(facts(prompt())).toMatchObject({ omittedRootSessions: 4, tools: { request_root_session: 'conditional' } });
  expect(facts(prompt()).confirmedRootSessions).toHaveLength(8);
  expect(prompt()).not.toContain('must-not-be-projected');
  confirmed.mockReturnValue([]);
  expect(facts(prompt()).confirmedRootSessions).toEqual([]);
});
