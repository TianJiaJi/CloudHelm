import { expect, it } from 'vitest';
import type { AppEvent, OperationView, TaskView, VerificationRound } from '@cloudhelm/contracts';
import { VerificationRoundTracker } from '../../../apps/desktop/src/worker/verification-round.js';
const task: TaskView = { id: 'task', goal: 'test', status: 'answered', resumeReason: 'report', localScopes: [], hostIds: ['host'],
  modelId: 'fixture', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1,
  verificationState: { status: 'unverified', operationIds: ['write'], reasonCode: 'report-missing' } };
const write: OperationView = { id: 'write', taskId: 'task', hostId: 'host', kind: 'write-file', status: 'succeeded', readOnly: false, preview: 'write', createdAt: 1 };
it('restores legacy missing-report membership and persists explicit IDs, not an array offset', () => {
  const events: AppEvent[] = [];
  const tracker = new VerificationRoundTracker(task, [write], (event) => events.push(event));
  expect(tracker.closed).toBe(false);
  expect(tracker.operations([write])).toEqual([write]);
  const saved = (events.at(-1) as Extract<AppEvent, { type: 'verification-round' }>).value;
  const restored = new VerificationRoundTracker({ ...task, verificationRound: saved }, [write], () => {});
  expect(restored.operations([{ ...write, id: 'older' }, write])).toEqual([write]);
  expect(restored.id).toBe(tracker.id);
  expect(saved).toMatchObject({ version: 1, operationIds: ['write'], closed: false });
});
it('adds operations once and closes explicitly; a fresh round cannot erase persisted membership snapshots', () => {
  const snapshots: VerificationRound[] = [];
  const tracker = new VerificationRoundTracker(task, [write], (event) => { if (event.type === 'verification-round') snapshots.push(event.value); });
  tracker.record(task.id, 'check'); tracker.record(task.id, 'check');
  const old = snapshots.at(-1)!;
  expect(tracker.operations([{ ...write, id: 'check' }, write]).map((op) => op.id)).toEqual(['write', 'check']);
  tracker.close(task.id); tracker.begin(task.id);
  expect(old.operationIds).toEqual(['write', 'check']);
  expect(tracker.id).not.toBe(old.id);
  expect(tracker.operations([write])).toEqual([]);
});
