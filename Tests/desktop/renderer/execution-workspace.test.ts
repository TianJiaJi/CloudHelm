import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppSnapshot, ConversationInputView, ExecutionJobView, OperationView, RequestObservation, TaskView } from '@cloudhelm/contracts';
import { AgentActivity } from '../../../apps/desktop/src/renderer/agent-activity.js';
import { ConversationQueue } from '../../../apps/desktop/src/renderer/conversation-queue.js';
import { ExecutionJobStatus } from '../../../apps/desktop/src/renderer/execution-job-status.js';
import { jobLabel, requestCost, terminalPresentation } from '../../../apps/desktop/src/renderer/execution-workspace-view.js';
import { appendLogPage } from '../../../apps/desktop/src/renderer/operation-log.js';
import { canCondenseOperation } from '../../../apps/desktop/src/renderer/agent-panel-parts.js';
import { conversationTurns } from '../../../apps/desktop/src/renderer/conversation-turns.js';
import { conversationTimeline } from '../../../apps/desktop/src/renderer/conversation-timeline.js';
import { useUi } from '../../../apps/desktop/src/renderer/store.js';

const task: TaskView = { id: 'task', goal: 'synthetic', status: 'answered', hostIds: ['host'], localScopes: [], modelId: 'fixture', createdAt: 1, updatedAt: 5, requestCount: 2, requestLimit: 100 };
const job: ExecutionJobView = { version: 1, jobId: 'job', operationId: 'operation', taskId: task.id, hostId: 'host', terminalId: 'A', terminalGeneration: 1,
  connectionId: 'connection', loginAs: 'user', runAs: 'user', status: 'running', createdAt: 1, updatedAt: 2, pid: 42, processSequence: 1, exitObserved: false };
const operation: OperationView = { id: job.operationId, taskId: task.id, hostId: 'host', kind: 'command', preview: 'synthetic', status: 'running', createdAt: 1, logRef: 'A', executionJob: job };
const request: RequestObservation = { kind: 'request', logicalRequestId: 'request', attempt: 1, purpose: 'conversation', provider: 'fixture', modelId: 'model', status: 'complete', startedAt: 1, observedAt: 3, cost: { usd: null, source: 'unknown' } };
const snapshot = (): AppSnapshot => ({ hosts: [], conversations: [task], terminals: [{ id: 'A', hostId: 'host', taskId: task.id, state: 'agent' }],
  operations: [operation], approvals: [], inputs: [], messages: [], profile: { provider: 'fixture', modelId: 'model', hasKey: false, hasJevKey: false },
  execution: { [task.id]: { model: 'idle', remote: 'running', stopping: false, canStop: true } } });
const report = vi.fn();
afterEach(() => { useUi.setState(useUi.getInitialState()); report.mockClear(); });

it('keeps answer completion, process start, stop request, unknown and actual exit separate', () => {
  expect(jobLabel(job)).toContain('健康未确认');
  expect(jobLabel({ ...job, status: 'starting' })).toContain('可信启动');
  expect(jobLabel({ ...job, status: 'stop-requested' })).toContain('尚未确认退出');
  expect(jobLabel({ ...job, status: 'unknown', stopRequestId: 'stop' })).toContain('未知');
  expect(jobLabel({ ...job, status: 'exited' })).toBe('退出未确认');
  expect(jobLabel({ ...job, status: 'failed', exitObserved: true, exitCode: 1 })).toContain('失败，已观察退出');
  expect(renderToStaticMarkup(createElement(ExecutionJobStatus, { operation, report }))).toContain('长期服务请使用服务管理器');
});
it('never folds a live job or an observed read-only failure behind a success or final answer', () => {
  const idle = { model: 'idle' as const, remote: 'idle' as const, stopping: false, canStop: false };
  for (const value of [{ ...operation, status: 'succeeded' as const }, { ...operation, executionJob: undefined, status: 'failed' as const, readOnly: true, effects: 'none' as const }]) {
    expect(canCondenseOperation(value)).toBe(false);
    const timeline = conversationTimeline([{ taskId: task.id, role: 'user', text: 'request', createdAt: 0 }, { taskId: task.id, role: 'agent', text: 'final answer', createdAt: 10 }], [value], []);
    expect(conversationTurns(timeline, { status: 'answered', execution: idle, pendingInteraction: false, liveReasoning: false })[0]!.foldable).toBe(false);
  }
});
it('projects terminal purpose only from observed operation capability and preserves human ownership', () => {
  const view = snapshot(), terminal = view.terminals[0]!;
  expect(terminalPresentation(terminal, view).title).toContain('后台进程');
  expect(terminalPresentation({ ...terminal, state: 'human' }, view).label).toMatch(/^人工/u);
  view.operations = [{ ...operation, executionJob: undefined, readOnly: true, preview: 'arbitrary spelling' }];
  expect(terminalPresentation(terminal, view).label).toContain('只读诊断');
  view.operations = [];
  expect(terminalPresentation(terminal, view).title).toContain('无已登记运行操作');
  expect(terminalPresentation(terminal, view).title).not.toContain('可输入');
});
it('distinguishes unknown, catalog estimate and provider-reported costs without inventing a total', () => {
  expect(requestCost(request)).toBe('费用未知');
  expect(requestCost({ ...request, cost: undefined })).toBe('费用未知');
  expect(requestCost({ ...request, cost: { source: 'estimate', usd: .001 } })).toContain('目录估算，非账单');
  expect(requestCost({ ...request, cost: { source: 'provider', usd: .01 } })).toContain('供应商报告');
});
it('shows independent model/tool/wait/background states and interruption rather than synthetic remote completion', () => {
  const view = snapshot();
  view.agentActivity = { [task.id]: { version: 1, runtimeLost: true, tools: [{ kind: 'tool', runId: 'run', callId: 'call', nativeId: 'hash', name: 'query', status: 'interrupted', parentCallId: 'parent', startedAt: 1, observedAt: 3, updates: 2 }], requests: [request], omittedTools: 2, omittedRequests: 3 } };
  const markup = renderToStaticMarkup(createElement(AgentActivity, { snapshot: view, conversation: task, report }));
  for (const value of ['模型：空闲', '后台待关注：1', '等待批准：0', '等待输入：0', '结果未确认', '子查询', '费用未知', 'token 用量未知', '不是完整历史或费用总账']) expect(markup).toContain(value);
  expect(markup).not.toContain('$0'); expect(report).not.toHaveBeenCalled();
});
it('makes queued, selected, expired and failed receipts explicit without restoring cancelled inputs', () => {
  const inputs: ConversationInputView[] = ['queued', 'delivering', 'expired', 'failed'].map((status, index) => ({ version: 1, id: `input-${index}`, taskId: task.id,
    kind: index ? 'followUp' : 'steer', status: status as ConversationInputView['status'], preview: 'same text', createdAt: 1, updatedAt: 2, expiresAt: 3, reason: status === 'expired' ? 'recovered' : undefined }));
  const markup = renderToStaticMarkup(createElement(ConversationQueue, { inputs, report }));
  for (const value of ['当前调整', '后续排队', '已选择，正在确认', '已过期', '投递失败', '不会自动投递']) expect(markup).toContain(value);
  expect(markup.match(/取消此消息/gu)).toHaveLength(1); expect(report).not.toHaveBeenCalled();
});
it('bounds incremental log display, accepts opaque cursors and rejects nonadvancing/oversized pages', () => {
  expect(appendLogPage('first', 13, { text: '\u001b[31mnext\u001b[0m', nextCursor: 500, more: false })).toEqual({ text: 'firstnext', cursor: 500, clipped: false });
  expect(appendLogPage('first', 13, { text: '', nextCursor: 13, more: false }).text).toBe('first');
  for (const page of [{ text: 'lost', nextCursor: 13, more: false }, { text: '', nextCursor: 12, more: false }, { text: '', nextCursor: 13, more: true }, { text: '中'.repeat(17000), nextCursor: 14, more: false }]) expect(() => appendLogPage('', 13, page)).toThrow('未跳过内容');
  const result = appendLogPage('a'.repeat(32768), 13, { text: '😀', nextCursor: 14, more: false });
  expect(result.clipped).toBe(true); expect(result.text.length).toBeLessThanOrEqual(32768); expect(result.text.endsWith('😀')).toBe(true);
});
it('does not change the selected tab, conversation or settings when background output or observations arrive', () => {
  const view = snapshot(); useUi.getState().setSnapshot(view); useUi.getState().openFiles('host'); useUi.getState().setSettingsOpen(true);
  const before = useUi.getState();
  useUi.getState().applyEvent({ type: 'terminal-data', terminalId: 'A', data: 'background output' });
  useUi.getState().setSnapshot({ ...view, operations: [{ ...operation, executionJob: { ...job, updatedAt: 4 } }] });
  const after = useUi.getState();
  expect([after.activeTabId, after.selectedConversationId, after.settingsOpen]).toEqual([before.activeTabId, before.selectedConversationId, true]);
});
