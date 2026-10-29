import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { TaskView } from '@cloudhelm/contracts';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

async function setup(needsAnotherRequest: boolean) {
  const fixture = await openAiFixture(async () => needsAnotherRequest
    ? { calls: [{ id: 'plan', name: 'update_plan', arguments: { steps: [{ id: 'one', title: '解释概念', status: 'pending' }] } }] }
    : { text: '这是概念解释，不需要远端操作。' });
  const task: TaskView = { id: 'budget-task', goal: '解释 SSH', hostIds: [], localScopes: [], modelId: 'fixture',
    status: 'draft', requestCount: 0, requestLimit: 1, createdAt: 1, updatedAt: 1 };
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const execute = vi.fn(async () => { throw new Error('No remote execution permitted'); });
  const runner = new TaskRunner(task, [], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl },
    [], new TerminalManager({ data() {}, state() {} }), { execute }, async () => { throw new Error('No SSH permitted'); },
    { event: (event) => events.push(structuredClone(event)), requestApproval: async () => false, cancelApproval() {} });
  const status = () => events.filter((event) => event.type === 'task-status').at(-1);
  return { runner, fixture, events, execute, status, close: async () => { runner.dispose(); await fixture.close(); } };
}
it('starts a fresh allowance only for a real input after a clean completed round while retaining cumulative counts', async () => {
  const f = await setup(false);
  try {
    await f.runner.start();
    expect(f.status()).toMatchObject({ status: 'answered', requestCount: 1 });
    await f.runner.message('另一个独立问题：解释 SFTP');
    await vi.waitFor(() => expect(f.status()?.status).not.toBe('running'));
    expect(f.status()).toMatchObject({ status: 'answered', requestCount: 2 });
    expect(f.fixture.requests).toHaveLength(2);
    expect(f.execute).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
it('uses a distinct budget pause and ordinary continuation cannot refill the exhausted round', async () => {
  const f = await setup(true);
  try {
    await f.runner.start();
    expect(f.fixture.requests).toHaveLength(1);
    expect(f.status()).toMatchObject({ status: 'paused', resumeReason: 'budget-exhausted' });
    await expect(f.runner.resume()).rejects.toThrow(/预算|budget/u);
    expect(f.fixture.requests).toHaveLength(1);
    await f.runner.message('继续解释');
    await vi.waitFor(() => expect(f.status()?.status).not.toBe('running'));
    expect(f.fixture.requests).toHaveLength(1);
    expect(f.status()).toMatchObject({ status: 'paused', resumeReason: 'budget-exhausted', requestCount: 1 });
    expect(f.execute).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
