import { describe, expect, it, vi } from 'vitest';
import type { ProposedOperation } from '@cloudhelm/core';
import { AiRiskEvaluator, type ReviewClient, type ReviewProfile } from '../../packages/adapters/src/ai-risk-evaluator.js';

const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'docker compose up -d', scope: {
  taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: 'pty', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy service'
} };

function setup(profile: ReviewProfile): { evaluator: AiRiskEvaluator; jev: ReturnType<typeof vi.fn>; ordinary: ReturnType<typeof vi.fn> } {
  const jev = vi.fn().mockResolvedValue('allow');
  const ordinary = vi.fn(async (..._args: unknown[]) => 'allow' as const);
  const client: ReviewClient = { jev, ordinary };
  return { evaluator: new AiRiskEvaluator(() => profile, client), jev, ordinary };
}

describe('paid Jev and ordinary model review selection', () => {
  it('uses ordinary LLM independently when no Jev key is configured', async () => {
    const { evaluator, jev, ordinary } = setup({ provider: 'anthropic', modelId: 'model', apiKey: 'main-key' });
    expect(await evaluator.evaluate(operation, undefined)).toMatchObject({ verdict: 'allow', reviewer: 'model' });
    expect(ordinary).toHaveBeenCalledOnce();
    expect(jev).not.toHaveBeenCalled();
  });

  it('forwards only a safe high-impact classification and script hash to the independent reviewer', async () => {
    const { evaluator, ordinary } = setup({ provider: 'anthropic', modelId: 'model', apiKey: 'main-key' });
    await evaluator.evaluate(operation, undefined, { classification: {
      verdict: 'evaluate', ruleId: 'high-impact-script', reason: 'Changes account access', impact: 'high'
    }, inspectedScriptSha256: 'sha256-safe' });
    expect(ordinary.mock.calls[0]?.[4]).toMatchObject({ classification: { ruleId: 'high-impact-script' }, inspectedScriptSha256: 'sha256-safe' });
  });

  it('uses Jev only when explicitly selected and never falls back after its failure', async () => {
    const { evaluator, jev, ordinary } = setup({ provider: 'anthropic', modelId: 'model', apiKey: 'jev-key', kind: 'jev' });
    jev.mockRejectedValue(new Error('gateway unavailable'));
    expect(await evaluator.evaluate(operation, undefined)).toMatchObject({ verdict: 'error' });
    expect(ordinary).not.toHaveBeenCalled();
  });
});
