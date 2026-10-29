import { randomUUID } from 'node:crypto';
import type { TaskView, VerificationReport } from '@cloudhelm/contracts';
import type { SqliteStore } from '@cloudhelm/adapters';

/** Append revisions before changing the current projection; clearing a card never accepts or erases its risks. */
export function recordVerificationReport(store: Pick<SqliteStore, 'put'>, task: TaskView, report?: VerificationReport): void {
  if (report) store.put('verification-reports', `${task.id}:${report.facts?.roundId ?? 'legacy'}:${randomUUID()}`,
    { taskId: task.id, createdAt: Date.now(), report: structuredClone(report) });
  if (task.report && JSON.stringify(task.report) !== JSON.stringify(report)) {
    task.verificationHistory = [...(task.verificationHistory ?? []), structuredClone(task.report)].slice(-20);
  }
  task.report = report;
}
