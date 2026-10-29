import { expect, it, vi } from 'vitest';
import { BashAnalyzer, SqliteStore } from '@cloudhelm/adapters';
import type { CommandAnalyzer } from '@cloudhelm/core';
import type { AppEvent, TaskView, OperationView, VerificationReport } from '@cloudhelm/contracts';
import { userWorkflow, triangleOutput } from '../worker/verification-user-workflow-fixture.js';
import { rebuildRecordedVerification } from '../../../apps/desktop/src/main/rebuild-verification.js';
import { AppState } from '../../../apps/desktop/src/main/app-state.js';
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } }));

async function legacy() {
  const operations = await userWorkflow();
  for (const op of operations) if (op.kind === 'command') op.verificationSource = undefined;
  const report: VerificationReport = { version: 3, summary: '旧规则：运行成功但汇总失败', access: [], changes: ['旧占位说明'], recovery: [],
    evidenceOperationIds: [], goalChecks: [], facts: { roundId: 'round', revision: 1, registration: 'automatic', execution: 'failed', goals: 'not-checked',
      impact: 'not-assessed', operations: operations.map((op) => ({ operationId: op.id, hostId: op.hostId, status: op.status })),
      riskOperationIds: [], unresolvedOperationIds: [], uncheckedOperationIds: ['mkdir', 'stage', 'install', 'run', 'cleanup'] } };
  const task: TaskView = { id: 'task', goal: '在/root/test创建并运行三角形脚本', hostIds: ['host'], localScopes: [], status: 'answered', modelId: 'fixture',
    requestCount: 8, requestLimit: 100, createdAt: 1, updatedAt: 20, report,
    verificationRound: { version: 1, id: 'round', closed: true, operationIds: operations.map((op) => op.id) } };
  return { task, operations };
}
it('rebuilds the existing seven-operation automatic report offline without changing any canonical operation or inventing an expected output', async () => {
  const { task, operations } = await legacy(); const before = structuredClone({ task, operations });
  const report = await rebuildRecordedVerification(task, operations, new BashAnalyzer());
  expect(report.facts).toMatchObject({ execution: 'succeeded-after-retry', goals: 'execution-observed', recoveredAttemptIds: ['not-started'], revision: 2 });
  expect(report.goalChecks?.[0]).toMatchObject({ kind: 'run-completion', status: 'passed', observed: expect.stringContaining(triangleOutput) });
  expect(report.goalChecks?.some((check) => check.kind === 'run-output' || check.kind === 'file-content')).toBe(false);
  expect({ task, operations }).toEqual(before);
});
it('does not trust a changed or truncated preview when its original full command digest no longer matches', async () => {
  const { task, operations } = await legacy();
  operations.find((op) => op.id === 'run')!.preview = 'sudo -- python3 /root/other.py';
  const report = await rebuildRecordedVerification(task, operations, new BashAnalyzer());
  expect(report.facts?.recoveredAttemptIds).toEqual([]);
  expect(report.facts?.execution).toBe('failed');
});
it('refuses in-flight, unresolved, foreign or incomplete rounds and never clears their locks', async () => {
  const { task, operations } = await legacy();
  for (const patch of [{ status: 'unknown' }, { status: 'running' }, { taskId: 'foreign' }] as Array<Partial<OperationView>>) {
    const changed = operations.map((op) => op.id === 'install' ? { ...op, ...patch } : op);
    await expect(rebuildRecordedVerification(task, changed, new BashAnalyzer())).rejects.toThrow();
  }
  await expect(rebuildRecordedVerification(task, operations.slice(1), new BashAnalyzer())).rejects.toThrow('不完整');
  await expect(rebuildRecordedVerification({ ...task, status: 'running' }, operations, new BashAnalyzer())).rejects.toThrow('已结束');
});
it('does not replace submitted judgments and does not infer a business goal from the observed output', async () => {
  const { task, operations } = await legacy(); task.report!.facts!.registration = 'submitted';
  await expect(rebuildRecordedVerification(task, operations, new BashAnalyzer())).rejects.toThrow('自动报告');
});
it('persists the rebuilt report and original history without model requests, new operations or task status changes', async () => {
  const { task, operations } = await legacy(); const store = new SqliteStore(':memory:');
  store.put('tasks', task.id, task); store.put('verification-reports', 'old', { taskId: task.id, report: task.report });
  for (const op of operations) store.put('operations', op.id, op);
  const events: AppEvent[] = []; const state = new AppState(store, (event) => events.push(event));
  try {
    const original = structuredClone(state.snapshot().operations); const stored = store.list('operations');
    await state.rebuildVerificationReport(task.id, new BashAnalyzer());
    expect(state.getTask(task.id)).toMatchObject({ status: 'answered', report: { facts: { execution: 'succeeded-after-retry' } },
      verificationHistory: [{ summary: task.report!.summary }] });
    expect(state.snapshot().operations).toEqual(original);
    expect(store.list('operations')).toEqual(stored);
    expect(store.list('verification-reports')).toHaveLength(2);
    expect(events.some((event) => event.type === 'model-request')).toBe(false);
    const count = state.getTask(task.id).requestCount;
    await state.rebuildVerificationReport(task.id, new BashAnalyzer());
    expect(store.list('verification-reports')).toHaveLength(2); expect(state.getTask(task.id).requestCount).toBe(count);
  } finally { state.close(); store.close(); }
});
it('times out offline parsing without saving a report or launching any work', async () => {
  const { task, operations } = await legacy(); const store = new SqliteStore(':memory:');
  store.put('tasks', task.id, task); for (const op of operations) store.put('operations', op.id, op);
  const state = new AppState(store, () => {});
  vi.useFakeTimers();
  try {
    const pending = state.rebuildVerificationReport(task.id, { analyze: async () => new Promise(() => {}) });
    const rejected = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(5001); await rejected;
    expect(state.getTask(task.id).report).toEqual(task.report); expect(store.list('verification-reports')).toEqual([]);
  } finally { vi.useRealTimers(); state.close(); store.close(); }
});
it('rejects a stale offline result if task state changes while commands are parsed', async () => {
  const { task, operations } = await legacy(); const store = new SqliteStore(':memory:');
  store.put('tasks', task.id, task); for (const op of operations) store.put('operations', op.id, op);
  const state = new AppState(store, () => {}); const parser = new BashAnalyzer();
  let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
  const analyzer: CommandAnalyzer = { analyze: async (command) => { await hold; return parser.analyze(command); } };
  try {
    const pending = state.rebuildVerificationReport(task.id, analyzer);
    state.record({ type: 'task-status', taskId: task.id, status: 'running' }); release();
    await expect(pending).rejects.toThrow('记录已变化');
    expect(state.getTask(task.id).report).toEqual(task.report); expect(store.list('verification-reports')).toEqual([]);
  } finally { state.close(); store.close(); }
});
