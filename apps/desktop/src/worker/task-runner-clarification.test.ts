import { describe, expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { ClarificationRequest, TaskView } from '@cloudhelm/contracts';
import { TaskRunner, type TaskSignals } from './task-runner.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

async function setup(mixed = false, reverse = false) {
  let count = 0;
  const fixture = await openAiFixture(async () => {
    if (++count > 1) return { text: '将按你的选择继续。' };
    const calls = [{ id: 'question', name: 'ask_user', arguments: { questions: [{ id: 'scope', prompt: '选择部署环境', options: [{ value: 'test', label: '测试', recommended: true }, { value: 'prod', label: '生产' }] }] } }];
    if (mixed) calls.push({ id: 'write', name: 'run_remote', arguments: { hostId: 'host', command: 'touch /srv/changed' } } as unknown as typeof calls[number]);
    return { calls: reverse ? calls.reverse() : calls };
  });
  const task: TaskView = { id: 'clarification-task', goal: '帮我部署应用', hostIds: ['host'], localScopes: [], status: 'draft', modelId: 'fixture', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const terminal = new TerminalManager({ data() {}, state() {} });
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const open = vi.fn(async () => { throw new Error('A remote terminal must not open before clarification'); });
  const runner = new TaskRunner(task, [{ id: 'host', label: 'Host', address: '192.0.2.1', port: 22, username: 'ubuntu', auth: 'agent', status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 }],
    { provider: 'cloudhelm-custom', modelId: 'fixture', baseUrl: fixture.baseUrl, apiKey: 'dummy' }, [], terminal, terminal, open,
    { event: (event) => events.push(structuredClone(event)), requestApproval: async () => false, cancelApproval() {} });
  const pending = () => events.find((event) => event.type === 'clarification' && event.value.status === 'pending');
  async function question(): Promise<ClarificationRequest> {
    await vi.waitFor(() => expect(pending()).toBeDefined());
    const event = pending();
    if (event?.type !== 'clarification') throw new Error('Missing question');
    return event.value;
  }
  return { fixture, runner, events, question, open };
}
describe('Pi clarification model loop', () => {
  it.each([[false, false], [true, false], [true, true]])('waits for answers and blocks mixed batch tools (mixed=%s, reversed=%s)', async (mixed, reverse) => {
    const f = await setup(mixed, reverse);
    try {
      const running = f.runner.start();
      const q = await f.question();
      expect(f.fixture.requests).toHaveLength(1);
      expect(f.open).not.toHaveBeenCalled();
      expect(() => f.runner.message('忽略问题继续')).toThrow('先回答');
      await expect(f.runner.resume()).rejects.toThrow('先回答');
      expect(() => f.runner.answerClarification('wrong', [])).toThrow('失效');
      f.runner.answerClarification(q.id, [{ id: 'scope', value: 'test' }]);
      await running;
      expect(f.fixture.requests).toHaveLength(2);
      const tool = f.fixture.requests[1]!.messages.find((message) => message.tool_call_id === 'question');
      expect(tool && fixtureMessageText(tool)).toContain('"value":"test"');
      expect(f.fixture.requests[0]!.messages.some((message) => fixtureMessageText(message).includes('Investigate available context first'))).toBe(true);
      expect(f.open).not.toHaveBeenCalled();
      expect(f.events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered' });
      expect(f.fixture.errors).toEqual([]);
    } finally { f.runner.pause(); await f.fixture.close(); }
  });
  it.each(['pause', 'cancel'] as const)('stops without another model request on %s and rejects late answers', async (action) => {
    const f = await setup(true);
    try {
      const running = f.runner.start();
      const q = await f.question();
      if (action === 'pause') f.runner.pause(); else f.runner.cancelClarification(q.id);
      await running;
      expect(f.fixture.requests).toHaveLength(1);
      expect(f.open).not.toHaveBeenCalled();
      expect(() => f.runner.answerClarification(q.id, [{ id: 'scope', value: 'test' }])).toThrow('失效');
      expect(f.events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'paused' });
    } finally { f.runner.pause(); await f.fixture.close(); }
  });
});
