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

it('forwards streaming reasoning and body text with the owning task', () => {
  const hooks = { event: vi.fn(), request: () => ({ count: 1, started: 1 }), activity: vi.fn(), compactionFailed: vi.fn(), diagnostic: vi.fn(), turnEnd: vi.fn() };
  const receive = taskSessionEvents('task', hooks);
  const reasoning = { id: 'r', createdAt: 1, model: { provider: 'p', modelId: 'm' }, reasoning: { text: '思考', status: 'streaming' as const, kind: 'thinking' as const } };
  const text = { id: 't', createdAt: 2, model: { provider: 'p', modelId: 'm' }, text: '部分' };
  receive({ type: 'reasoning-progress', value: reasoning });
  receive({ type: 'text-progress', value: text });
  receive({ type: 'text-progress', value: null });
  expect(hooks.event).toHaveBeenNthCalledWith(1, { type: 'reasoning-progress', taskId: 'task', value: reasoning });
  expect(hooks.event).toHaveBeenNthCalledWith(2, { type: 'text-progress', taskId: 'task', value: text });
  expect(hooks.event).toHaveBeenNthCalledWith(3, { type: 'text-progress', taskId: 'task', value: null });
  expect(hooks.diagnostic).not.toHaveBeenCalled();
});
