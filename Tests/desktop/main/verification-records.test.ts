import { expect, it } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { TaskView, VerificationReport } from '@cloudhelm/contracts';
import { recordVerificationReport } from '../../../apps/desktop/src/main/verification-records.js';
const task = (): TaskView => ({ id: 'task', goal: 'test', hostIds: [], localScopes: [], status: 'answered', modelId: 'fixture',
  requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 });
const report = (summary: string): VerificationReport => ({ summary, access: [], changes: [], recovery: [], evidenceOperationIds: [] });
it('archives every report revision and keeps previous uncertainty when starting another round', () => {
  const store = new SqliteStore(':memory:');
  try {
    const view = task();
    recordVerificationReport(store, view, report('有未验证项'));
    recordVerificationReport(store, view, undefined);
    expect(view.report).toBeUndefined();
    expect(view.verificationHistory).toEqual([report('有未验证项')]);
    recordVerificationReport(store, view, report('新轮次的观察'));
    expect(store.list<{ taskId: string; report: VerificationReport }>('verification-reports').map((row) => row.report.summary))
      .toEqual(expect.arrayContaining(['有未验证项', '新轮次的观察']));
    expect(view.verificationHistory?.[0]?.summary).toBe('有未验证项');
  } finally { store.close(); }
});
it('bounds the recent UI projection without deleting the complete archive', () => {
  const store = new SqliteStore(':memory:');
  try {
    const view = task();
    for (let i = 0; i < 25; i++) recordVerificationReport(store, view, report(`revision ${i}`));
    expect(view.verificationHistory).toHaveLength(20);
    expect(store.list('verification-reports')).toHaveLength(25);
  } finally { store.close(); }
});
