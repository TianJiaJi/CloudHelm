import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { DiagnosticEvent } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import { TaskRunner } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

it('uses actual local scope checks, durable model budget and parent audits for native query scripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-query-'));
  const allowed = join(root, 'allowed'), denied = join(root, 'denied');
  await mkdir(allowed); await mkdir(denied);
  await writeFile(join(allowed, 'selected.txt'), 'SELECTED_PUBLIC');
  await writeFile(join(denied, 'private.txt'), 'DO_NOT_READ_OUTSIDE');
  let calls = 0;
  const code = `const good = await tools.read_selected_text_file({path:${JSON.stringify(join(allowed, 'selected.txt'))}}); const bad = await tools.list_selected_directory({path:${JSON.stringify(denied)}}); return {good:good.text, rejected:bad.isError};`;
  const provider = await openAiFixture(async () => ++calls === 1
    ? { calls: [{ id: 'query-script', name: 'codemode', arguments: { code } }] } : { text: 'Only the selected source was read.' });
  const task: TaskView = { id: 'query-task', goal: 'Read only the selected local source', hostIds: [],
    localScopes: [{ kind: 'directory', path: await realpath(allowed) }], provider: 'cloudhelm-custom', modelId: 'fixture',
    status: 'draft', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const terminal = new TerminalManager({ data() {}, state() {} });
  const open = vi.fn(async (): Promise<string> => { throw new Error('No SSH authorized'); });
  const review = vi.fn(async () => false), audit: DiagnosticEvent[] = [];
  const runner = new TaskRunner(task, [], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic', baseUrl: provider.baseUrl },
    [], terminal, terminal, open, { event() {}, requestApproval: review, cancelApproval() {}, diagnostic: (event) => audit.push(event) });
  try {
    await runner.start();
    expect(task.status).toBe('answered'); expect(task.requestCount).toBe(2); expect(calls).toBe(2);
    expect(open).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
    const output = provider.requests[1]!.messages.filter((message) => message.role === 'tool').map(fixtureMessageText).join('\n');
    expect(output).toContain('SELECTED_PUBLIC'); expect(output).toMatch(/"rejected"\s*:\s*true/u);
    expect(JSON.stringify(provider.requests)).not.toContain('DO_NOT_READ_OUTSIDE');
    expect(audit).toContainEqual(expect.objectContaining({ event: 'tool.start', tool: 'read_selected_text_file', parentToolCallId: 'query-script' }));
    expect(audit).toContainEqual(expect.objectContaining({ event: 'tool.end', tool: 'list_selected_directory', parentToolCallId: 'query-script', status: 'failed' }));
  } finally { runner.dispose(); await provider.close(); await rm(root, { recursive: true, force: true }); }
});
