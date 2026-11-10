import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { TaskView, VerificationFacts } from '@cloudhelm/contracts';
import { VerificationCard } from '../../../apps/desktop/src/renderer/workspace-pages.js';

function render(patch: Partial<VerificationFacts> = {}) {
  const conversation: TaskView = { id: 'summary', goal: '操作说明', status: 'answered', hostIds: ['host'], localScopes: [], modelId: 'fixture',
    requestCount: 1, requestLimit: 10, createdAt: 1, updatedAt: 2,
    report: { version: 3, summary: '具体记录', access: [], changes: [], recovery: [], evidenceOperationIds: ['run'],
      facts: { roundId: 'round', revision: 1, registration: 'automatic', execution: 'succeeded', goals: 'not-checked', impact: 'not-assessed',
        operations: [{ operationId: 'run', hostId: 'host', status: 'succeeded', exitCode: 0, readOnly: false }],
        unresolvedOperationIds: [], riskOperationIds: [], uncheckedOperationIds: ['run'], ...patch } } };
  return renderToStaticMarkup(createElement(VerificationCard, { conversation, report() {}, compact: true }));
}
it('does not append a second result card or disclaimer to a normal final answer', () => {
  expect(render()).toBe('');
});
it.each(['failed', 'inconclusive', 'not-checked', 'passed'] as const)('never treats report goal metadata %s as a separate task verdict', (goals) => {
  expect(render({ goals })).toBe('');
});
it('keeps real task errors visible with redacted details instead of folding them as report history', () => {
  const conversation: TaskView = { id: 'failure', goal: '检查', status: 'failed', summary: 'Unauthorized; password=must-never-render',
    hostIds: [], localScopes: [], modelId: 'fixture', requestCount: 1, requestLimit: 10, createdAt: 1, updatedAt: 2 };
  const markup = renderToStaticMarkup(createElement(VerificationCard, { conversation, report() {}, compact: true }));
  expect(markup.split('<details>')[0]).toContain('模型身份验证未通过');
  expect(markup).toContain('查看错误详情'); expect(markup).toContain('查看对话记录');
  expect(markup).not.toContain('must-never-render'); expect(markup).not.toContain('展开检查与历史记录');
});
it('does not mark inconclusive optional comparisons as overall task failure', () => {
  expect(render({ goals: 'inconclusive' })).toBe('');
});
