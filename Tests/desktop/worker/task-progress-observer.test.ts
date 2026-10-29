import { expect, it } from 'vitest';
import type { BusinessTool } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import { TaskProgress } from '../../../apps/desktop/src/worker/task-progress.js';
import { observeProgressTools } from '../../../apps/desktop/src/worker/task-progress-observer.js';

it('ignores plan wording and failed reads, regardless of new tool-call IDs', async () => {
  const progress = new TaskProgress();
  const tool: BusinessTool = { name: 'update_plan', label: '', description: '', parameters: {}, replay: 'never',
    execute: async (id) => ({ content: [{ type: 'text', text: id }], details: undefined }) };
  const observed = observeProgressTools([tool], progress, () => [])[0]!;
  for (let index = 0; index < 10; index++) { await observed.execute(`call-${index}`, {} as never); progress.endTurn(); }
  expect(progress.stalled).toBe(true);
  const failed = observeProgressTools([{ ...tool, name: 'read_selected_text_file',
    execute: async () => ({ content: [{ type: 'text', text: 'different failure' }], details: undefined, isError: true }) }], progress, () => [])[0]!;
  await failed.execute('another', { path: '/fixture' } as never); progress.endTurn();
  expect(progress.idleTurns).toBe(11);
});
it('deduplicates equal log observations even when operation IDs change', async () => {
  const progress = new TaskProgress(); let id = 'first';
  const operation = (): OperationView => ({ id, taskId: 'task', hostId: 'host', kind: 'command', preview: 'df -h',
    intentKey: 'same-command-identity', status: 'succeeded', readOnly: true, createdAt: 1 });
  const tool: BusinessTool = { name: 'read_operation_log', label: '', description: '', parameters: {}, replay: 'never',
    execute: async () => ({ content: [], details: { kind: 'operation-log', operationId: id, availability: 'available', cursor: 0, nextCursor: 1, sha256: 'same-observation' } }) };
  const observed = observeProgressTools([tool], progress, () => [operation()])[0]!;
  await observed.execute('call1', {} as never); progress.endTurn();
  id = 'different-proposal'; await observed.execute('call2', {} as never); progress.endTurn();
  expect(progress.idleTurns).toBe(1);
});
it('counts new successful local pages, not repeated content or IDs', async () => {
  const progress = new TaskProgress(); let page = 'page-one';
  const tool: BusinessTool = { name: 'read_selected_text_file', label: '', description: '', parameters: {}, replay: 'never',
    execute: async () => ({ content: [{ type: 'text', text: page }], details: undefined }) };
  const observed = observeProgressTools([tool], progress, () => [])[0]!;
  await observed.execute('one', { path: '/fixture' } as never); progress.endTurn();
  await observed.execute('two', { path: '/fixture' } as never); progress.endTurn(); expect(progress.idleTurns).toBe(1);
  page = 'page-two'; await observed.execute('three', { path: '/fixture' } as never); progress.endTurn(); expect(progress.idleTurns).toBe(0);
});
