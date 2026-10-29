import { expect, it, vi } from 'vitest';
import { contextBudget, type InputPreparationContext } from '@cloudhelm/core';
import type { RuntimeCall } from '@cloudhelm/contracts/runtime';
import { WorkerServer } from '../../../apps/desktop/src/worker/server.js';
function setup() {
  const server = new WorkerServer(() => undefined);
  const snapshot = { budget: contextBudget({ contextWindow: 32000, maxOutputTokens: 8192, historyTokens: 25000, frameTokens: 1000 }),
    historyTokens: 25000, hasHistory: true, modelIdle: true, remoteIdle: true, revision: 'before' };
  let preparingSignal: AbortSignal | undefined;
  const context: InputPreparationContext = { snapshot: () => snapshot,
    compact: async (signal) => { preparingSignal = signal; await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('preparation canceled')), { once: true });
    }); } };
  const runner = { task: { id: 'task', hostIds: ['host'] }, preparationContext: () => context, preparationSnapshot: () => snapshot,
    pause: vi.fn(), stopOperation: vi.fn(), setModel: vi.fn(), setThinking: vi.fn(), setReviewKey: vi.fn(),
    updateConversationReviewMode: vi.fn(), updateHostSafety: vi.fn(), addAuthorization: vi.fn(), message: vi.fn() };
  (server as unknown as { tasks: Map<string, typeof runner> }).tasks.set('task', runner);
  const profile = { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxTokens: 8192 };
  const call: Extract<RuntimeCall, { method: 'prepare-message' }> = { method: 'prepare-message', requestId: 'prepare', taskId: 'task',
    document: { requestId: 'prepare', parts: [{ type: 'text', text: 'x'.repeat(10000) }] }, bodies: [], profile, usedTokens: 0 };
  return { server, runner, call, snapshot, signal: () => preparingSignal };
}
const controls: RuntimeCall[] = [
  { method: 'pause-task', taskId: 'task' }, { method: 'stop-operation', taskId: 'task' },
  { method: 'set-conversation-thinking', taskId: 'task', level: 'off' },
  { method: 'set-conversation-model', taskId: 'task', profile: { provider: 'cloudhelm-custom', modelId: 'other', apiKey: 'fixture-only' } },
  { method: 'update-conversation-review-mode', taskId: 'task', hostId: 'host', mode: 'ask', revision: 2 },
  { method: 'set-review-key' }, { method: 'disconnect', hostId: 'host' },
  { method: 'update-host-safety', hostId: 'host', mode: 'ask', protectedReadPaths: [], protectedWritePaths: [], revision: 2 },
  { method: 'authorize-task', taskId: 'task', hosts: [], localScopes: [] },
  { method: 'cancel-message', requestId: 'prepare' }
];
it.each(controls)('revokes a live preparation on $method without dispatching the draft', async (control) => {
  const f = setup(); const pending = f.server.dispatch(f.call);
  const rejected = expect(pending).rejects.toThrow('preparation canceled');
  expect(f.signal()?.aborted).toBe(false);
  await f.server.dispatch(control); await rejected;
  expect(f.signal()?.aborted).toBe(true); expect(f.runner.message).not.toHaveBeenCalled();
});
it('passes the worker-issued version to final synchronous dispatch and deduplicates the message', async () => {
  const f = setup(); f.snapshot.budget = contextBudget({ contextWindow: 32000, maxOutputTokens: 8192, historyTokens: 1000, frameTokens: 1000 });
  f.call.document.parts = [{ type: 'text', text: 'small' }];
  const prepared = await f.server.dispatch(f.call) as { text: string; preparedContext: { revision: string } };
  const send: RuntimeCall = { method: 'task-message', taskId: 'task', text: prepared.text, document: f.call.document, preparedRevision: prepared.preparedContext.revision };
  await f.server.dispatch(send); await f.server.dispatch(send);
  expect(f.runner.message).toHaveBeenCalledExactlyOnceWith('small', f.call.document, undefined, 'before');
});
