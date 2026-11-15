import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

it('discovers a read-only preview in native Pi, persists its read audit, and never allocates SSH or dispatches a write', async () => {
  const source = 'port=80\n', sha256 = createHash('sha256').update(source).digest('hex');
  let requests = 0;
  const model = await openAiFixture(async (request) => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'discover', name: 'tool_search', arguments: { query: 'prepare_remote_edit', limit: 1 } }] };
    if (requests === 2) return { calls: [{ id: 'preview', name: 'prepare_remote_edit', arguments: {
      hostId: 'host', path: '/srv/config', expectedSha256: sha256, oldText: '80', newText: '90' } }] };
    const result = fixtureMessageText(request.messages.filter((message) => message.role === 'tool').at(-1)!);
    expect(result).toContain('"previewOnly":true'); expect(result).toContain('"commitSupported":false');
    expect(result).toContain('-port=80'); expect(result).toContain('+port=90');
    return { text: '仅预览差异，未修改文件；现有元数据保持提交能力不可用。' };
  });
  const host: RuntimeHost = { id: 'host', label: 'fixture', username: 'user', address: '192.0.2.1', port: 22,
    auth: 'agent', status: 'connected', defaultMode: 'ask', policyRevision: 1, protectedPaths: [] };
  const task: TaskView = { id: 'preview-task', goal: '仅预览配置变化，不修改文件', hostIds: ['host'], localScopes: [],
    status: 'draft', provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const terminal = new TerminalManager({ data() {}, state() {} });
  const execute = vi.spyOn(terminal, 'execute'), open = vi.fn(async (): Promise<string> => { throw new Error('No SSH authorized'); });
  const requestApproval = vi.fn(async () => false);
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const read = vi.fn(async () => ({ content: source, bytes: source.length, truncated: false, sha256, mode: 0o640, uid: 1, gid: 2 }));
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: model.baseUrl },
    [], terminal, terminal, open, { event: (event) => events.push(structuredClone(event)), requestApproval, cancelApproval() {} },
    undefined, undefined, undefined, undefined, undefined, [], read);
  try {
    await runner.start();
    expect(model.errors).toEqual([]); expect(requests).toBe(3); expect(task.status).toBe('answered');
    expect(read).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
    const records = new Map<string, OperationView>();
    for (const event of events) if (event.type === 'operation') records.set(event.value.id, event.value);
    expect([...records.values()]).toEqual([expect.objectContaining({ kind: 'read-file', status: 'succeeded', readOnly: true,
      effects: 'none', readAudit: expect.objectContaining({ events: expect.arrayContaining([expect.objectContaining({ phase: 'completed' })]) }) })]);
  } finally { await runner.close(); await model.close(); }
});
