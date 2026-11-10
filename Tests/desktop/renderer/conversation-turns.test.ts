import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { AppSnapshot, ClarificationRequest, ConversationMessage, ExecutionView, OperationView, TaskStatus, TaskView } from '@cloudhelm/contracts';
import { conversationTimeline } from '../../../apps/desktop/src/renderer/conversation-timeline.js';
import { conversationTurns } from '../../../apps/desktop/src/renderer/conversation-turns.js';
import { ConversationTranscript } from '../../../apps/desktop/src/renderer/conversation-transcript.js';

const task: TaskView = { id: 'task', goal: '检查', status: 'answered', hostIds: ['host'], localScopes: [], provider: 'fixture', modelId: 'fixture',
  createdAt: 1, updatedAt: 10, requestCount: 2, requestLimit: 100, plan: [{ id: 'p', title: '核对输出', status: 'done' }] };
const messages: ConversationMessage[] = [
  { taskId: task.id, role: 'user', source: 'input', entryId: 'input-1', text: '第一个请求', createdAt: 1 },
  { taskId: task.id, role: 'agent', entryId: 'progress', text: '中间说明', createdAt: 2 },
  { taskId: task.id, role: 'agent', entryId: 'final', text: '最终答复', createdAt: 5,
    reasoning: { text: '最终回答前的思考', kind: 'thinking', status: 'complete' } }
];
const operation: OperationView = { id: 'op', taskId: task.id, hostId: 'host', kind: 'command', preview: 'printf example',
  status: 'succeeded', createdAt: 3, completedAt: 4, exitCode: 0 };
const idle: ExecutionView = { model: 'idle', remote: 'idle', stopping: false, canStop: false };
const settled = { status: 'answered' as TaskStatus, execution: idle, pendingInteraction: false, liveReasoning: false };
function group(ops = [operation], control = settled, input = messages, clarifications: ClarificationRequest[] = []) {
  return conversationTurns(conversationTimeline(input, ops, clarifications), control);
}

it('folds a completed turn while separating its final answer from intermediate work', () => {
  const turns = group(); expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ key: 'message:input-1', foldable: true, latest: true, operationCount: 1, messageCount: 1,
    answer: { value: { entryId: 'final' } }, input: { value: { entryId: 'input-1' } } });
  expect(turns[0]!.entries).toHaveLength(3);
});
it.each(['running', 'waiting-review', 'waiting-user', 'paused', 'failed', 'recovering', 'human-control'] as const)(
  'does not fold a current %s turn even when all plan steps say done', (status) => {
    expect(group([operation], { ...settled, status })[0]!.foldable).toBe(false);
  });
it.each([
  { ...idle, model: 'running' as const }, { ...idle, remote: 'running' as const }, { ...idle, remote: 'unknown' as const },
  { ...idle, stopping: true }, { ...idle, canStop: true }
])('respects backend execution state independently of the task label', (execution) => {
  expect(group([operation], { ...settled, execution })[0]!.foldable).toBe(false);
});
it.each(['pendingInteraction', 'liveReasoning'] as const)('does not fold while %s remains', (flag) => {
  expect(group([operation], { ...settled, [flag]: true })[0]!.foldable).toBe(false);
});
it.each(['proposed', 'approved', 'running', 'unknown', 'failed'] as const)('does not hide %s operations with unresolved effects', (status) => {
  expect(group([{ ...operation, status, effects: 'possible' }])[0]!.foldable).toBe(false);
});
it('keeps read-only unknown results expanded too, without pretending they were observed', () => {
  expect(group([{ ...operation, status: 'unknown', readOnly: true }])[0]!.foldable).toBe(false);
});
it('retains explicit risk-acceptance provenance rather than changing the operation to success', () => {
  const op = { ...operation, status: 'unknown' as const, reconciledAt: 4,
    reconciliation: { kind: 'risk-accepted' } as OperationView['reconciliation'] };
  expect(group([op])[0]).toMatchObject({ foldable: true, riskCount: 1 }); expect(op.status).toBe('unknown');
});
it('does not treat an earlier progress message or an answer preceding completion as final', () => {
  expect(group([operation], settled, messages.slice(0, 2))[0]!.foldable).toBe(false);
  expect(group([{ ...operation, completedAt: 8 }])[0]!.foldable).toBe(false);
});
it('keeps earlier turns separately expandable while a later turn runs', () => {
  const input: ConversationMessage[] = [...messages,
    { taskId: task.id, role: 'user', entryId: 'input-2', source: 'input', text: '第二个请求', createdAt: 6 },
    { taskId: task.id, role: 'agent', text: '正在继续', createdAt: 7 }];
  const turns = group([operation], { ...settled, status: 'running' }, input);
  expect(turns.map((turn) => turn.foldable)).toEqual([true, false]);
  expect(turns[0]!.answer?.value.text).toBe('最终答复'); expect(turns[1]!.input?.value.text).toBe('第二个请求');
});
it('does not start a new turn for a provenance-bound clarification answer', () => {
  const answer: ConversationMessage = { taskId: task.id, role: 'user', source: 'clarification', text: '范围说明', createdAt: 4 };
  expect(group([operation], settled, [...messages, answer])).toHaveLength(1);
  expect(group([operation], settled, [...messages, { ...answer, source: 'input' }])).toHaveLength(2);
});
it('keeps pending clarification controls visible', () => {
  const question: ClarificationRequest = { id: 'q', taskId: task.id, toolCallId: 'q', generation: 'g', createdAt: 4, expiresAt: 100,
    status: 'pending', questions: [{ id: 'env', prompt: 'Which environment?' }] };
  expect(group([operation], settled, messages, [question])[0]!.foldable).toBe(false);
});
it('includes all operations rather than only the most recent six', () => {
  expect(group(Array.from({ length: 9 }, (_, i) => ({ ...operation, id: `op-${i}` })))[0]!.operationCount).toBe(9);
});
it('renders the final answer, but neither intermediate text nor a green plan dock by default', () => {
  const snapshot = { messages, operations: [operation], approvals: [], inputs: [], execution: { [task.id]: idle } } as unknown as AppSnapshot;
  const markup = renderToStaticMarkup(createElement(ConversationTranscript, { snapshot, conversation: task, report() {} }));
  expect(markup).toContain('第一个请求'); expect(markup).toContain('最终答复'); expect(markup).toContain('执行过程');
  expect(markup).not.toContain('中间说明'); expect(markup).not.toContain('最终回答前的思考');
  expect(markup).not.toContain('aria-label="执行计划"'); expect(markup).not.toContain('open=""');
  expect(markup).not.toContain('计划已完成'); expect(markup).not.toContain('本轮结果');
});
