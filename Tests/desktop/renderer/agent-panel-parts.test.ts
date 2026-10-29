import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OperationView, PlanStep } from '@cloudhelm/contracts';
import { AgentPlan, canCondenseOperation, OperationActivity } from '../../../apps/desktop/src/renderer/agent-panel-parts.js';

const operation: OperationView = { id: 'op', taskId: 'task', hostId: 'host', kind: 'command', preview: 'df -h', status: 'succeeded', createdAt: 1 };
const html = (steps: PlanStep[]) => renderToStaticMarkup(createElement(AgentPlan, { steps })).replace(/<!--.*?-->/gu, '');

describe('AI panel projections', () => {
  it('does not invent a planning phase or a plan without backend steps', () => {
    expect(html([])).toBe('');
    expect(html([{ id: 'a', title: '检查磁盘', status: 'pending' }])).toContain('执行计划');
  });

  it('counts only actual done steps, and keeps the active title in the dock', () => {
    const output = html([{ id: 'a', title: '查看环境', status: 'done' }, { id: 'b', title: '核对服务', status: 'running' }]);
    expect(output).toContain('1/2');
    expect(output).toContain('核对服务');
    expect(output).toContain('正在进行');
    expect(output).toContain('aria-expanded="false"');
    expect(output).toContain('aria-controls=');
    expect(output).toMatch(/<ol[^>]*hidden=""/u);
  });

  it('does not describe a blocked plan as completed', () => {
    expect(html([{ id: 'a', title: '需要批准', status: 'blocked' }])).toContain('计划受阻');
  });

  it.each(['proposed', 'approved', 'running', 'failed', 'denied', 'unknown'] as const)('keeps %s operations fully visible', (status) => {
    expect(canCondenseOperation({ ...operation, status })).toBe(false);
  });

  it('never hides privilege or reconciliation feedback in a summary', () => {
    expect(canCondenseOperation({ ...operation, reconciliation: { kind: 'risk-accepted' } as OperationView['reconciliation'] })).toBe(false);
    expect(canCondenseOperation({ ...operation, privilege: {} as OperationView['privilege'] })).toBe(false);
  });

  it('uses a disclosure only for ordinary successes, with the command still readable', () => {
    expect(canCondenseOperation(operation)).toBe(true);
    const output = renderToStaticMarkup(createElement(OperationActivity, { operation, report: () => {} }));
    expect(output).toContain('<details');
    expect(output).toContain('已完成远端命令');
    expect(output).toContain('df -h');
    expect(output).not.toContain('退出 0');
  });

  it('shows only an actual command exit code, not an invented success code', () => {
    const output = renderToStaticMarkup(createElement(OperationActivity, { operation: { ...operation, exitCode: 0 }, report: () => {} }));
    expect(output).toContain('退出 0');
  });

  it('keeps the full active step available when the compact preview is truncated', () => {
    const title = '核对服务配置、监听端口和当前主机的健康检查结果';
    expect(html([{ id: 'active', title, status: 'running' }])).toContain(`title="${title}"`);
  });
});
