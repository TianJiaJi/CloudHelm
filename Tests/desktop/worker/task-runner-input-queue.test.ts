import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { ConversationInput } from '@cloudhelm/core';
import type { MessageDocument, TaskView } from '@cloudhelm/contracts';
import { TaskRunner } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';
const document = (id: string, text: string): MessageDocument => ({ requestId: id, parts: [{ type: 'text', text }] });
async function fixture() {
  let release!: () => void;
  const firstReply = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const provider = await openAiFixture(async () => { if (++calls === 1) await firstReply; return { text: 'synthetic answer' }; });
  const task: TaskView = { id: 'queued-task', goal: 'initial request', hostIds: [], localScopes: [],
    provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const receipts: ConversationInput[] = [];
  const terminal = new TerminalManager({ data() {}, state() {} });
  const open = vi.fn(async (): Promise<string> => { throw new Error('No SSH authorized in queue fixture'); });
  const runner = new TaskRunner(task, [], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic', baseUrl: provider.baseUrl },
    [], terminal, terminal, open, { event() {}, requestApproval: async () => false, cancelApproval() {},
      commitInput: async (value) => { receipts.push(structuredClone(value)); } });
  return { runner, task, provider, receipts, open, release, calls: () => calls };
}
it('switches intent only at real delivery, in steer/followUp order, with no SSH or unbudgeted request', async () => {
  const f = await fixture();
  try {
    const start = f.runner.start(); await vi.waitFor(() => expect(f.calls()).toBe(1));
    await f.runner.message('follow-up request', document('follow', 'follow-up request'), undefined, undefined, 'followUp');
    await f.runner.message('current correction', document('steer', 'current correction'), undefined, undefined, 'steer');
    expect(f.task.intent?.currentInput).toBe('initial request');
    expect(f.receipts.filter((value) => value.status === 'delivered')).toEqual([]);
    f.release(); await start;
    expect(f.calls()).toBe(3); expect(f.task.status).toBe('answered');
    expect(f.receipts.filter((value) => value.status === 'delivered').map((value) => value.id)).toEqual(['steer', 'follow']);
    expect(f.task.intent?.currentInput).toBe('follow-up request');
    const system = (index: number) => f.provider.requests[index]!.messages.filter((message) => ['system', 'developer'].includes(message.role)).map(fixtureMessageText).join('\n');
    expect(system(1)).toContain('current correction'); expect(system(2)).toContain('follow-up request');
    expect(f.task.requestCount).toBe(3); expect(f.open).not.toHaveBeenCalled();
  } finally { f.release(); f.runner.dispose(); await f.provider.close(); }
});
it('cancels waiting inputs on model pause and never delivers them with a later explicit message', async () => {
  const f = await fixture();
  try {
    const start = f.runner.start(); await vi.waitFor(() => expect(f.calls()).toBe(1));
    await f.runner.message('cancelled future request', document('cancelled', 'cancelled future request'), undefined, undefined, 'followUp');
    f.runner.pause(); f.release(); await start;
    await vi.waitFor(() => expect(f.receipts.at(-1)).toMatchObject({ id: 'cancelled', status: 'cancelled' }));
    await f.runner.message('fresh explicit request', document('fresh', 'fresh explicit request'));
    await vi.waitFor(() => expect(f.task.status).toBe('answered'));
    expect(f.calls()).toBe(2);
    expect(f.provider.requests[1]!.messages.map(fixtureMessageText).join('\n')).not.toContain('cancelled future request');
    expect(f.task.intent?.currentInput).toBe('fresh explicit request'); expect(f.open).not.toHaveBeenCalled();
  } finally { f.release(); f.runner.dispose(); await f.provider.close(); }
});
