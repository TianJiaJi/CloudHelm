import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ExecutionView, TaskView } from '@cloudhelm/contracts';
import { RequestBudgetCard } from '../../../apps/desktop/src/renderer/request-budget-card.js';

const task: TaskView = { id: 'task', goal: 'fixture', hostIds: [], localScopes: [], modelId: 'fixture', status: 'paused',
  resumeReason: 'budget-exhausted', requestCount: 300, requestLimit: 100, createdAt: 1, updatedAt: 1,
  session: { version: 1, id: 'task' }, budget: { version: 1, roundId: 'round', budgetRevision: 100,
    roundUsed: 100, roundLimit: 100, defaultRoundLimit: 100, totalUsed: 300, closed: false, origin: 'explicit' } };
function render(view = task, execution?: ExecutionView): string {
  return renderToStaticMarkup(createElement(RequestBudgetCard, { task: view, execution, report() {} }));
}
it('shows separate cumulative and round counts and disables additions without backend idle confirmation', () => {
  const markup = render();
  expect(markup).toContain('本轮请求 100/100 · 累计 300');
  expect(markup).toContain('追加100次并继续');
  expect(markup).toContain('disabled');
  expect(markup).toContain('不会解除审核拒绝或远端安全限制');
  expect(render(task, { model: 'idle', remote: 'idle', stopping: false, canStop: false })).not.toContain('disabled');
});
it('does not invent legacy remaining allowance or offer an addition to a nonexhausted round', () => {
  const legacy = render({ ...task, budget: undefined });
  expect(legacy).toContain('轮次额度待后端确认');
  expect(legacy).not.toContain('追加100次并继续');
  expect(render({ ...task, budget: { ...task.budget!, roundLimit: 200 } })).not.toContain('追加100次并继续');
  expect(render({ ...task, budget: { ...task.budget!, closed: true } })).not.toContain('追加100次并继续');
});
