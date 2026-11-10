import { expect, it, vi } from 'vitest';
import { taskSessionEvents } from '../../../apps/desktop/src/worker/task-session-events.js';

it('projects native settlement as an observation without completing a task or stopping remote work', () => {
  const hooks = { event: vi.fn(), request: () => ({ count: 1, started: 1 }), activity: vi.fn(), compactionFailed: vi.fn(), diagnostic: vi.fn(), turnEnd: vi.fn() };
  const receive = taskSessionEvents('task', hooks);
  const value = { kind: 'run' as const, runId: 'run', status: 'settled' as const, aborted: true, startedAt: 1, observedAt: 2, durationMs: 1 };
  receive({ type: 'lifecycle', value });
  expect(hooks.event).toHaveBeenCalledExactlyOnceWith({ type: 'agent-lifecycle', taskId: 'task', value });
  expect(hooks.diagnostic).toHaveBeenCalledWith({ event: 'model.settled', status: 'aborted', durationMs: 1 });
  expect(hooks.turnEnd).not.toHaveBeenCalled(); expect(hooks.activity).not.toHaveBeenCalled(); expect(hooks.compactionFailed).not.toHaveBeenCalled();
});
