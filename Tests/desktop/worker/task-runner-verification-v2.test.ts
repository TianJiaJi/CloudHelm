import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalManager } from '@cloudhelm/application';
import type { RawTerminal } from '@cloudhelm/core';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';
const channel: RawTerminal = { write() { throw new Error('No real shell'); }, resize() {}, close() {}, onData() {}, onClose() {} };
it.each(['passed', 'failed', 'inconclusive'] as const)('explains %s observations without report tools or repeating changes', async (status) => {
  const directory = await mkdtemp(join(tmpdir(), 'cloudhelm-v2-report-'));
  let requests = 0;
  const fixture = await openAiFixture(async (request) => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'create', name: 'run_remote', arguments: { hostId: 'host', command: 'mkdir -p /srv/report-fixture' } }] };
    if (requests === 2) return { calls: [{ id: 'inspect', name: 'run_remote', arguments: { hostId: 'host', command: 'stat /srv/report-fixture' } }] };
    expect(request.tools!.some((tool) => tool.function.name === 'submit_verification')).toBe(false);
    return { text: status === 'passed' ? '目录检查通过，不代表应用健康。' : '检查未全部通过，不声称目标已完成，也不重复写入。' };
  });
  const task: TaskView = { id: 'report-fixture', goal: '创建目录并检查', hostIds: ['host'], localScopes: [], status: 'draft',
    modelId: 'fixture', provider: 'cloudhelm-custom', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1 };
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const profile = { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl };
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const terminal = new TerminalManager({ data() {}, state() {} });
  const execute = vi.fn(async (operation: { id: string; command?: string }) => ({ operationId: operation.id,
    status: operation.command?.startsWith('stat') && status !== 'passed' ? 'failed' as const : 'succeeded' as const,
    exitCode: operation.command?.startsWith('stat') && status !== 'passed' ? 1 : 0, stdoutTail: 'fixture observation' }));
  const make = (view: TaskView, prior: OperationView[] = [], restore = false) => new TaskRunner(view, [host], profile, prior, terminal, { execute },
    async () => terminal.open('host', channel, task.id, '/srv'),
    { event: (event) => events.push(structuredClone(event)), requestApproval: async () => true, cancelApproval() {} },
    undefined, undefined, { id: task.id, directory, restore });
  let runner = make(task);
  try {
    await runner.start(); expect(fixture.errors).toEqual([]); expect(requests).toBe(3); expect(execute).toHaveBeenCalledTimes(2);
    const report = events.filter((event) => event.type === 'work-report' && event.report).at(-1);
    expect(report).toMatchObject({ report: { version: 3, facts: { registration: 'automatic', operations: expect.any(Array) } } });
    expect(task.report?.goalChecks?.some((check) => check.authority === 'model')).toBe(false);
    const verification = events.filter((event) => event.type === 'verification-state').at(-1);
    expect(verification).toMatchObject({ value: undefined });
    expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered', resumeReason: undefined });
    await expect(runner.resume()).rejects.toThrow('没有可自动继续'); expect(requests).toBe(3);
    if (status !== 'passed') {
      const indexed = new Map<string, OperationView>(); for (const event of events) if (event.type === 'operation') indexed.set(event.value.id, event.value);
      const file = join(directory, (await readdir(directory)).find((name) => name.endsWith('.jsonl'))!);
      const beforeRestore = await readFile(file, 'utf8');
      runner.dispose();
      runner = make(structuredClone(task), [...indexed.values()], true); await runner.start(true);
      await expect(runner.resume()).rejects.toThrow('没有可自动继续'); expect(requests).toBe(3);
      runner.message('现在仅解释检查限制，不要重复变更');
      await vi.waitFor(() => expect({ requests, failure: events.filter((event) => event.type === 'task-status').at(-1)?.summary })
        .toEqual({ requests: 4, failure: undefined }), { timeout: 15000 });
      await vi.waitFor(() => expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered' }));
      expect(execute).toHaveBeenCalledTimes(2);
      expect(events.filter((event) => event.type === 'verification-state').at(-1)).toMatchObject({ value: undefined });
      expect((await readFile(file, 'utf8')).startsWith(beforeRestore)).toBe(true);
    }
  } finally { runner.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
