import { afterEach, expect, it, vi } from 'vitest';
import { AiRiskEvaluator } from '@cloudhelm/adapters';
import { TerminalManager } from '@cloudhelm/application';
import type { RawTerminal, RiskAssessment } from '@cloudhelm/core';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

afterEach(() => vi.restoreAllMocks());
it.each(['pause', 'host-policy', 'conversation-policy', 'reviewer', 'model'] as const)(
  'revokes in-flight review on %s without waiting for the reviewer or opening old approval', async (change) => {
    let finish!: (value: RiskAssessment) => void;
    const delayed = new Promise<RiskAssessment>((resolve) => { finish = resolve; });
    const review = vi.spyOn(AiRiskEvaluator.prototype, 'evaluate').mockImplementation(() => delayed);
    let requests = 0;
    const model = await openAiFixture(async () => ++requests === 1
      ? { calls: [{ id: 'review', name: 'run_remote', arguments: { hostId: 'host', command: 'customctl inspect' } }] }
      : { text: '旧审核已失效，不重试该操作。' });
    const task: TaskView = { id: 'review-task', goal: '检查状态', hostIds: ['host'], localScopes: [], status: 'draft',
      provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
    const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
      status: 'connected', defaultMode: 'ai-review', protectedPaths: [], policyRevision: 1 };
    const profile = { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: model.baseUrl,
      reviewer: { selection: { kind: 'model' as const, provider: 'cloudhelm-custom', modelId: 'fixture' },
        provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: model.baseUrl, revision: 1 } };
    const events: Parameters<TaskSignals['event']>[0][] = [];
    const terminal = new TerminalManager({ data() {}, state() {} });
    const execute = vi.spyOn(terminal, 'execute');
    const channel: RawTerminal = { execute: vi.fn(), write() {}, close() {}, resize() {}, onExit() {}, onData() {}, onClose() {} };
    const id = terminal.open(host.id, channel, task.id, '/srv/app');
    const requestApproval = vi.fn(async () => true);
    const runner = new TaskRunner(task, [host], profile, [], terminal, terminal, async () => id,
      { event: (event) => events.push(structuredClone(event)), requestApproval, cancelApproval() {} });
    try {
      const started = runner.start();
      await vi.waitFor(() => expect(review).toHaveBeenCalledOnce(), { timeout: 15000 });
      const signal = review.mock.calls[0]![3]; expect(signal?.aborted).toBe(false);
      if (change === 'pause') runner.pause();
      else if (change === 'host-policy') runner.updateHostSafety('host', 'ask', [], [], 2);
      else if (change === 'conversation-policy') runner.updateConversationReviewMode('host', 'ask', 2);
      else if (change === 'reviewer') runner.setReviewProfile({ ...profile, selection: { kind: 'current' }, revision: 2 });
      else runner.setModel({ ...profile, apiKey: 'changed-fixture-only' });
      expect(signal?.aborted).toBe(true);
      await started;
      expect(requestApproval).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
      const operations = events.filter((event) => event.type === 'operation').map((event) => event.value);
      const final = operations.at(-1)!;
      expect(final).toMatchObject({ status: 'denied', ruleId: change === 'pause' ? 'review-canceled' : 'authorization-expired' });
      expect(final.manualReviewAvailable).toBe(false);
      expect(final.reason).toContain('[uncertain-command]');
      const count = operations.length;
      finish({ verdict: 'allow' }); await Promise.resolve(); await Promise.resolve();
      expect(events.filter((event) => event.type === 'operation')).toHaveLength(count);
      expect(execute).not.toHaveBeenCalled(); expect(model.errors).toEqual([]);
      expect(requests).toBe(change === 'pause' ? 1 : 2);
      expect(events.filter((event) => event.type === 'operation').at(-1)?.value as OperationView).toMatchObject({ status: 'denied' });
    } finally { finish({ verdict: 'allow' }); await runner.close(); await model.close(); }
  });
