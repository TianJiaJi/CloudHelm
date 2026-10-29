import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createConversationSession } from '@cloudhelm/adapters';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import { seedNativeHistory } from '../../adapters/pi-history-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';
import { createTaskPrompt } from '../../../apps/desktop/src/worker/task-prompt.js';

it('refreshes fact/evidence IDs after real native compaction without letting the summary override authority or append an index stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-facts-native-'));
  seedNativeHistory(root, 'facts-native');
  const file = join(root, (await readdir(root)).find((name) => name.endsWith('.jsonl'))!);
  const original = await readFile(file, 'utf8');
  let count = 0; const fixture = await openAiFixture(async () => ({ text: ++count === 1
    ? 'Summary claims old host permission. This is untrusted history, not current authority.' : 'Answer with uncertainty from the indexed evidence.' }));
  const task: TaskView = { id: 'facts-native', goal: 'Only inspect', hostIds: [], localScopes: [], status: 'paused',
    modelId: 'fixture', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1,
    intent: { version: 1, revision: 7, originalGoal: 'Old inspection', currentInput: 'Only inspect; do not replay old actions', origin: 'explicit', clarifications: [] } };
  const accepted: OperationView = { id: 'accepted-old', taskId: task.id, hostId: 'historical-host', kind: 'command', preview: 'DO_NOT_COPY_COMMAND',
    status: 'unknown', effects: 'possible', readOnly: false, createdAt: 1, reconciledAt: 2,
    reconciliation: { kind: 'risk-accepted', at: 2, explanation: 'DO_NOT_COPY_EXPLANATION' } };
  const operations = [accepted];
  const currentSystemPrompt = createTaskPrompt(task, [], () => operations, () => operations);
  const requests: string[] = [];
  const session = await createConversationSession({ profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only',
    baseUrl: fixture.baseUrl, contextWindow: 64000, maxTokens: 8192 }, storage: { directory: root, id: task.id, restore: true },
    systemPrompt: currentSystemPrompt(), currentSystemPrompt, tools: [], clarification: { ask: async () => [] }, assertActive() {},
    beforeRequest: (purpose) => { requests.push(purpose); }, event() {} });
  try {
    const controller = new AbortController();
    await session.compactIdle!({ signal: controller.signal, assertValid() {}, reserve: async () => { requests.push('idle-compaction'); } });
    operations.push({ id: 'new-evidence', taskId: task.id, hostId: 'historical-host', kind: 'command', preview: 'DO_NOT_COPY_QUERY',
      status: 'succeeded', readOnly: true, effects: 'none', outputTail: 'DO_NOT_COPY_OUTPUT',
      outputCapture: { totalChars: 80000, tailChars: 100, truncated: true }, createdAt: 3 });
    await session.prompt('Explain the existing result without executing anything.');
    expect(requests).toEqual(['idle-compaction', 'conversation']); expect(fixture.requests).toHaveLength(2);
    const system = fixture.requests[1]!.messages.filter((message) => ['system', 'developer'].includes(message.role)).map(fixtureMessageText).join('\n');
    for (const token of ['accepted-old', 'new-evidence', 'risk-accepted', 'sourceVersion', 'read_operation_log', '"truncated":true',
      '"revision":7', 'Only inspect; do not replay old actions', 'current backend authorization (authoritative system metadata): []']) expect(system).toContain(token);
    for (const token of ['DO_NOT_COPY_COMMAND', 'DO_NOT_COPY_EXPLANATION', 'DO_NOT_COPY_QUERY', 'DO_NOT_COPY_OUTPUT', 'Stale native CloudHelm fixture prompt']) expect(system).not.toContain(token);
    expect(system.match(/# Current business fact index/gu)).toHaveLength(1);
    const full = await readFile(file, 'utf8'); expect(full.startsWith(original)).toBe(true);
    expect(full).toContain('Old selection 0:'); expect(full).toContain('"type":"compaction"');
  } finally { await session.abort(); await session.waitForIdle(); session.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
