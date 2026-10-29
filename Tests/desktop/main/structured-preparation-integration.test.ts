import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { StructuredSend } from '@cloudhelm/contracts';
import type { BudgetCommand } from '@cloudhelm/contracts';
import type { RuntimeCall, RuntimeMessage } from '@cloudhelm/contracts/runtime';
import { seedNativeHistory } from '../../adapters/pi-history-fixture.js';
import { openAiFixture, type FixtureResponse } from '../worker/openai-sse-fixture.js';
import { WorkerServer } from '../../../apps/desktop/src/worker/server.js';
import { AppState } from '../../../apps/desktop/src/main/app-state.js';
import { registerConversationIpc } from '../../../apps/desktop/src/main/conversation-ipc.js';
import type { RuntimeBridge } from '../../../apps/desktop/src/main/runtime-bridge.js';
import type { ReferenceStore } from '../../../apps/desktop/src/main/reference-store.js';
const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
  ipcMain: { handle: (channel: string, listener: (...args: unknown[]) => unknown) => ipc.handlers.set(channel, listener) } }));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); ipc.handlers.clear(); });
const invoke = async (method: string, ...args: unknown[]) => await ipc.handlers.get(`cloudhelm:${method}`)!({}, ...args);
async function setup(options: { singleLarge?: boolean; reply?: () => Promise<FixtureResponse> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-preparation-e2e-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fixture = await openAiFixture(async (request) => options.reply ? options.reply()
    : { text: request.tools?.length ? 'Answered only the new explicit input.' : '## Goal\nInspect only.\n## Progress\nOld observations retained; do not replay.' });
  cleanups.push(fixture.close);
  const store = new SqliteStore(':memory:'); const events: RuntimeMessage[] = [];
  const state = new AppState(store, () => {}); cleanups.push(() => { state.close(); store.close(); });
  state.saveProfile({ provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl,
    contextWindow: 64000, maxTokens: 8192 });
  const profile = state.runtimeProfile();
  const task = state.createTask('Inspect-only original goal', [], 'fixture', []); state.setTaskModel(task.id, profile);
  const directory = join(root, task.id); await mkdir(directory); seedNativeHistory(directory, task.id, options.singleLarge);
  const file = join(directory, (await readdir(directory)).find((name) => name.endsWith('.jsonl'))!);
  const original = await readFile(file, 'utf8');
  state.record({ type: 'task-status', taskId: task.id, status: 'answered' });
  state.record({ type: 'execution', taskId: task.id, value: { model: 'idle', remote: 'idle', stopping: false, canStop: false } });
  const closed = state.requestBudgets.complete(task.id);
  const budgetCalls: BudgetCommand[] = []; let hold: ((command: BudgetCommand, deliver: () => void) => boolean) | undefined;
  const worker = new WorkerServer((message) => {
    events.push(structuredClone(message));
    if ('event' in message) state.record(message.event);
    if ('budgetRequest' in message) {
      const { id, command } = message.budgetRequest; budgetCalls.push(command);
      const result = state.requestBudget(command); // durable Main commit BEFORE optional lost acknowledgment
      const deliver = () => queueMicrotask(() => worker.resolveBudget({ id, ...result }));
      if (!hold?.(command, deliver)) deliver();
    }
  });
  cleanups.push(async () => {
    await worker.dispatch({ method: 'pause-task', taskId: task.id });
    if (await worker.dispatch({ method: 'has-task', taskId: task.id })) await worker.dispatch({ method: 'delete-task', taskId: task.id });
  });
  const calls: RuntimeCall[] = [];
  const call = async <T>(input: RuntimeCall): Promise<T> => { calls.push(structuredClone(input)); return await worker.dispatch(input) as T; };
  registerConversationIpc({ sessionRoot: root, store, state, runtime: { call } as RuntimeBridge,
    references: { save() {}, read() { throw new Error('No reference selected'); } } as unknown as ReferenceStore,
    connectHost: async () => { throw new Error('Test must not connect SSH'); },
    takeSelections: () => [], restoreSelections() {} });
  const input: StructuredSend = { conversationId: task.id, hostId: null, localSelectionTokens: [],
    document: { requestId: 'new-real-input', parts: [{ type: 'text', text: 'New explicit inspect-only request. '.repeat(900) }] } };
  return { state, store, worker, task, input, fixture, original, file, calls, events, budgetCalls, closed,
    hold: (next: typeof hold) => { hold = next; } };
}
it('prepares once via Main authority and native compaction, then sends exactly the new turn without status promotion', async () => {
  const f = await setup();
  await Promise.all([invoke('send-structured', f.input), invoke('send-structured', f.input)]);
  await vi.waitFor(() => expect({ status: f.state.getTask(f.task.id).status,
    failure: f.state.getTask(f.task.id).status === 'failed' ? f.state.getTask(f.task.id).summary : undefined })
    .toEqual({ status: 'answered', failure: undefined }), { timeout: 15000 });
  await invoke('send-structured', f.input);
  expect(f.fixture.requests).toHaveLength(2);
  expect(f.fixture.requests[0]?.tools ?? []).toHaveLength(0);
  expect(f.fixture.requests[1]?.tools?.length).toBeGreaterThan(0);
  const request = JSON.stringify(f.fixture.requests[1]?.messages);
  expect(request).toContain('# Current business fact index');
  expect(request).toContain('New explicit inspect-only request.');
  expect(request).not.toContain('Stale native CloudHelm fixture prompt');
  expect(request).not.toContain('Pending input fact-index reserve');
  expect(f.calls.filter((call) => call.method === 'prepare-message')).toHaveLength(1);
  expect(f.calls.filter((call) => call.method === 'task-message')).toHaveLength(1);
  const compaction = f.budgetCalls.find((call) => call.kind === 'reserve' && call.attempt.purpose === 'compaction');
  expect(compaction).toMatchObject({ preparationId: f.input.document.requestId });
  const requests = f.events.flatMap((message) => 'event' in message && message.event.type === 'model-request' ? [message.event] : []);
  expect(requests.map((request) => request.purpose)).toEqual(['compaction', 'conversation']);
  const budget = f.state.requestBudgets.current(f.task.id);
  expect(budget).toMatchObject({ roundUsed: 2, totalUsed: 2 }); expect(budget.roundId).not.toBe(f.closed.roundId);
  const text = await readFile(f.file, 'utf8'); expect(text.startsWith(f.original)).toBe(true); expect(text).toContain('"type":"compaction"');
  // The native initial system entry may persist the initial frame once;
  // per-request refreshes must not append a new growing control-message stream.
  expect(text.match(/# Current business fact index/gu)?.length ?? 0).toBeLessThanOrEqual(1);
  const entries = text.trim().split('\n').map((line) => JSON.parse(line));
  expect(entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user'
    && JSON.stringify(entry.message.content).includes('New explicit inspect-only request.'))).toHaveLength(1);
  const beforeRequest = f.events.slice(0, f.events.findIndex((message) => 'event' in message && message.event.type === 'model-request'));
  expect(beforeRequest.some((message) => 'event' in message && message.event.type === 'task-status' && message.event.status === 'running')).toBe(false);
});
it('retains a committed charge when canceled before acknowledgment; no HTTP, prompt, refund or refreshed round', async () => {
  const f = await setup(); let acknowledge: (() => void) | undefined;
  f.hold((command, deliver) => { if (command.kind !== 'reserve') return false; acknowledge = deliver; return true; });
  const pending = invoke('send-structured', f.input); const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
  const charged = f.state.requestBudgets.current(f.task.id); expect(charged.roundUsed).toBe(1);
  await invoke('cancel-message', f.input.document.requestId); acknowledge!(); await rejected;
  expect(f.fixture.requests).toHaveLength(0); expect(f.calls.some((call) => call.method === 'task-message')).toBe(false);
  expect(f.state.requestBudgets.complete(f.task.id)).toMatchObject({ roundId: charged.roundId, roundUsed: 1, closed: false });
  expect(f.state.requestBudgets.input(f.task.id, 'replacement').budget).toMatchObject({ roundId: charged.roundId, roundUsed: 1 });
  expect(await readFile(f.file, 'utf8')).not.toContain('"type":"compaction"');
});
it.each(['credentials', 'reviewer', 'model', 'unsupported-thinking', 'stop'] as const)('revokes %s changes after durable charge but before acknowledgment', async (change) => {
  const f = await setup(); let acknowledge: (() => void) | undefined;
  f.hold((command, deliver) => { if (command.kind !== 'reserve') return false; acknowledge = deliver; return true; });
  const pending = invoke('send-structured', f.input); const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
  try {
  if (change === 'credentials') f.state.saveProfile({ provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'new-fixture-only',
    baseUrl: f.fixture.baseUrl, contextWindow: 64000, maxTokens: 8192 });
  if (change === 'reviewer') f.state.saveReviewSettings({ reviewer: { kind: 'current' } });
  if (change === 'model') await invoke('set-conversation-model', f.task.id, { provider: 'cloudhelm-custom', modelId: 'other' });
  // Custom models advertise no thinking levels. Rejection must still cancel an
  // already-pending preparation; supported high-level changes are covered by
  // pi-idle-compaction.test.ts against the catalog-backed reasoning model.
  if (change === 'unsupported-thinking') await expect(invoke('set-conversation-thinking', f.task.id, 'off')).rejects.toThrow('不支持此思考档位');
  if (change === 'stop') await invoke('stop-operation', f.task.id);
  } finally { acknowledge!(); await rejected; }
  expect(f.fixture.requests).toHaveLength(0);
  expect(f.state.requestBudgets.current(f.task.id)).toMatchObject({ roundUsed: 1, totalUsed: 1 });
  expect(f.calls.some((call) => call.method === 'task-message')).toBe(false);
});
it('rejects no-space-after-native-success without a compaction loop, summary fallback or original prompt replay', async () => {
  const f = await setup({ singleLarge: true });
  await expect(invoke('send-structured', f.input)).rejects.toThrow('整理后输入空间仍不足');
  expect(f.fixture.requests).toHaveLength(1); expect(f.fixture.requests[0]?.tools ?? []).toHaveLength(0);
  expect(f.calls.some((call) => call.method === 'task-message')).toBe(false);
  expect(f.state.requestBudgets.current(f.task.id).roundUsed).toBe(1);
  expect((await readFile(f.file, 'utf8')).startsWith(f.original)).toBe(true);
});
