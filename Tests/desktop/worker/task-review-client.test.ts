import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BudgetCommand } from '@cloudhelm/contracts';
import type { DiagnosticEvent, ProposedOperation } from '@cloudhelm/core';
import type { RuntimeProfile } from '@cloudhelm/contracts/runtime';
import type { BudgetPort } from '../../../apps/desktop/src/worker/task-request-budget.js';
import { createTaskRiskEvaluator, createTaskReviewer } from '../../../apps/desktop/src/worker/task-review-client.js';

type FixtureModel = { api?: string };
const catalog = vi.hoisted(() => ({ getModelOfType: vi.fn((): FixtureModel => ({})), getModel: vi.fn((): FixtureModel | undefined => ({})), classify: vi.fn(), completeSimple: vi.fn() }));
vi.mock('@earendil-works/pi-ai/providers/all', () => ({ builtinModels: () => catalog }));
vi.mock('../../../packages/adapters/src/model-catalog.js', () => ({ createModelCatalog: () => catalog }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function reviewBudget(): BudgetPort & { commands: BudgetCommand[] } {
  const commands: BudgetCommand[] = [];
  const port: BudgetPort = async (command) => {
    commands.push(command);
    if (command.kind !== 'review') throw new Error('Fixture only authorizes review');
    return { kind: 'review', scopeId: command.operationId, used: 1, limit: 3 };
  };
  return Object.assign(port, { commands });
}

const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'docker compose up -d', scope: {
  taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: 'pty', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy service'
} };

describe('reviewer model diagnostics', () => {
  it.each(['jev', 'ordinary'] as const)('emits one model.request and one verdict model.response per %s review', async (route) => {
    catalog.classify.mockResolvedValue({ stopReason: 'stop', answers: { safe: { type: 'choice', choice: 'deny', confidence: 0.95 } } });
    catalog.completeSimple.mockResolvedValue({ stopReason: 'stop', content: [{ type: 'text', text: '{"verdict":"deny"}' }] });
    const diagnostics: DiagnosticEvent[] = [];
    const budget = reviewBudget();
    const client = createTaskReviewer('task', budget, () => {}, () => 'g1', { diagnostic: (event) => diagnostics.push(event) });
    const assessment = route === 'jev'
      ? await client.jev(operation, undefined, 'fixture-key')
      : await client.ordinary(operation, undefined, { provider: 'openai', modelId: 'test', apiKey: 'fixture' });
    expect(assessment).toMatchObject({ verdict: 'deny' });
    expect(budget.commands).toHaveLength(1);
    expect(diagnostics.filter((event) => event.event === 'model.request')).toHaveLength(1);
    const request = diagnostics.find((event) => event.event === 'model.request');
    expect(request).toMatchObject({ taskId: 'task', operationId: 'op', purpose: 'review', attempt: 1,
      transport: 'opaque', request: 1 });
    expect(request?.logicalRequestId).toMatch(/^[\w-]{1,200}$/u);
    const response = diagnostics.find((event) => event.event === 'model.response');
    expect(response).toMatchObject({ taskId: 'task', operationId: 'op', purpose: 'review', attempt: 1,
      transport: 'opaque', status: 'deny', responseAttributed: true });
    expect(response?.logicalRequestId).toBe(request?.logicalRequestId);
    expect(response?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports the reviewer identity from the model hook', async () => {
    catalog.completeSimple.mockResolvedValue({ stopReason: 'stop', content: [{ type: 'text', text: '{"verdict":"review"}' }] });
    const diagnostics: DiagnosticEvent[] = [];
    const client = createTaskReviewer('task', reviewBudget(), () => {}, () => 'g1', {
      model: () => ({ provider: 'review-provider', modelId: 'auditor' }), diagnostic: (event) => diagnostics.push(event) });
    await client.ordinary(operation, undefined, { provider: 'openai', modelId: 'test', apiKey: 'fixture' });
    expect(diagnostics.find((event) => event.event === 'model.request')).toMatchObject({ provider: 'review-provider', model: 'auditor' });
    expect(diagnostics.find((event) => event.event === 'model.response')).toMatchObject({ status: 'review' });
  });

  it('marks a review aborted after its attempt as aborted and a plain failure as error', async () => {
    catalog.completeSimple.mockResolvedValue({ stopReason: 'stop', content: [{ type: 'text', text: '{"verdict":"allow"}' }] });
    const diagnostics: DiagnosticEvent[] = [];
    const client = createTaskReviewer('task', reviewBudget(), () => {}, () => 'g1', { diagnostic: (event) => diagnostics.push(event) });
    const controller = new AbortController();
    catalog.completeSimple.mockImplementation(() => { controller.abort(); return Promise.reject(new Error('fixture review failure')); });
    await expect(client.ordinary(operation, undefined, { provider: 'openai', modelId: 'test', apiKey: 'fixture' },
      undefined, undefined, controller.signal)).rejects.toThrow('fixture review failure');
    expect(diagnostics.find((event) => event.event === 'model.request')).toMatchObject({ attempt: 1 });
    expect(diagnostics.find((event) => event.event === 'model.response')).toMatchObject({ status: 'aborted' });
    diagnostics.length = 0;
    await expect(client.ordinary(operation, undefined, { provider: 'openai', modelId: 'test', apiKey: 'fixture' }))
      .rejects.toThrow('fixture review failure');
    expect(diagnostics.find((event) => event.event === 'model.request')).toMatchObject({ attempt: 1 });
    expect(diagnostics.find((event) => event.event === 'model.response')).toMatchObject({ status: 'error' });
  });

  it('emits no request or response when no attempt was authorized', async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const denied: BudgetPort = async () => { throw new Error('review budget unavailable'); };
    const client = createTaskReviewer('task', denied, () => {}, () => 'g1', { diagnostic: (event) => diagnostics.push(event) });
    await expect(client.jev(operation, undefined, 'fixture-key')).rejects.toThrow('review budget unavailable');
    expect(diagnostics).toHaveLength(0);
    catalog.getModel.mockReturnValueOnce(undefined);
    const unavailable = await client.ordinary(operation, undefined, { provider: 'openai', modelId: 'test', apiKey: 'fixture' });
    expect(unavailable).toMatchObject({ verdict: 'error' });
    expect(diagnostics).toHaveLength(0);
  });

  it('resolves reviewer identity from the runtime profile and forwards diagnostics through createTaskRiskEvaluator', async () => {
    catalog.completeSimple.mockResolvedValue({ stopReason: 'stop', content: [{ type: 'text', text: '{"verdict":"deny","reason":"Unclear effect"}' }] });
    const profile: RuntimeProfile = { provider: 'conversation-provider', modelId: 'conversation-model', apiKey: 'conversation-key',
      reviewer: { selection: { kind: 'model', provider: 'review-provider', modelId: 'auditor' },
        provider: 'review-provider', modelId: 'auditor', apiKey: 'review-key', revision: 1 } };
    const diagnostics: DiagnosticEvent[] = [];
    const evaluator = createTaskRiskEvaluator('task', reviewBudget(), () => {}, () => 'g1', () => profile, () => [],
      (event) => diagnostics.push(event));
    expect(await evaluator.evaluate(operation, undefined)).toMatchObject({ verdict: 'deny', reviewer: 'auditor' });
    expect(diagnostics.find((event) => event.event === 'model.request')).toMatchObject({ provider: 'review-provider',
      model: 'auditor', purpose: 'review', operationId: 'op' });
    expect(diagnostics.find((event) => event.event === 'model.response')).toMatchObject({ status: 'deny', purpose: 'review' });
  });
});
