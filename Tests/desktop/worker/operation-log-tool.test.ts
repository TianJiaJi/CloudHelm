import { expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { OperationView } from '@cloudhelm/contracts';
import type { LogPage } from '@cloudhelm/contracts/runtime';
import { createOperationLogTool } from '../../../apps/desktop/src/worker/operation-log-tool.js';

const own = (): OperationView => ({ id: 'own', taskId: 'task', hostId: 'host', kind: 'command',
  preview: 'opaque command', status: 'failed', effects: 'possible', readOnly: false, createdAt: 1 });
const args = { operationId: 'own' };
it('pages actual stored Unicode and escaping-heavy logs without loss, duplicate text, or oversized responses', async () => {
  const store = new SqliteStore(':memory:');
  const original = `\ufeff${'中'.repeat(4095)}\u0000🙂\\\"\n`.repeat(14);
  store.appendLog('operation:own', original);
  const readLog = vi.fn(async (id: string, cursor: number) => store.readLogPage(`operation:${id}`, cursor));
  const tool = createOperationLogTool('task', () => [own()], readLog);
  let cursor = 0;
  let reconstructed = '';
  let pages = 0;
  try {
    for (; pages < 20; pages++) {
      const response = await tool.execute('log', { ...args, cursor });
      expect(response.isError).toBe(false);
      const text = response.content[0]!.text;
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
      expect(text.slice(0, 2000)).toContain('"operationId":"own"');
      expect(text.slice(0, 2000)).toContain('"nextCursor":');
      expect(response.details).toMatchObject({ sourceStatus: 'failed', sourceReadOnly: false, completeness: 'unknown', cursor });
      const details = response.details as { nextCursor: number; more: boolean };
      expect(details.nextCursor).toBeGreaterThan(cursor);
      reconstructed += text.slice(text.indexOf('\n', text.indexOf('\n') + 1) + 1);
      cursor = details.nextCursor;
      if (!details.more) break;
    }
    expect(pages).toBeGreaterThan(0);
    expect(pages).toBeLessThan(20);
    expect(reconstructed).toBe(original);
    expect(reconstructed).not.toContain('\ufffd');
    const eof = await tool.execute('eof', { ...args, cursor });
    expect(eof.details).toMatchObject({ availability: 'end-of-retained-log', more: false, completeness: 'unknown' });
  } finally { store.close(); }
});
it('distinguishes missing/expired logs from backend-recorded empty output and never infers operation success', async () => {
  const operation = own();
  const readLog = vi.fn(async () => ({ text: '', nextCursor: 0, more: false }));
  const tool = createOperationLogTool('task', () => [operation], readLog);
  const missing = await tool.execute('missing', args);
  expect(missing).toMatchObject({ isError: true, details: { code: 'log-unavailable', completeness: 'unknown' } });
  expect(missing.content[0]!.text).toContain('never rerun');
  operation.outputCapture = { totalChars: 0, tailChars: 0, truncated: false };
  expect(await tool.execute('empty', args)).toMatchObject({ isError: false, details: { availability: 'recorded-empty', sourceStatus: 'failed' } });
});
it.each(['revoke', 'change-host', 'abort'] as const)('rechecks scope and cancellation after log I/O: %s', async (change) => {
  let operations = [own()];
  const controller = new AbortController();
  const readLog = vi.fn(async () => {
    if (change === 'revoke') operations = [];
    else if (change === 'change-host') operations[0]!.hostId = 'other';
    else controller.abort();
    return { text: 'must-not-be-disclosed', nextCursor: 1, more: false };
  });
  const tool = createOperationLogTool('task', () => operations, readLog);
  const result = await tool.execute('changed', args, controller.signal);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain('must-not-be-disclosed');
});
it('never fetches a foreign operation or starts retrieval after cancellation', async () => {
  const readLog = vi.fn(async () => ({ text: 'no', nextCursor: 1, more: false }));
  const tool = createOperationLogTool('task', () => [{ ...own(), taskId: 'other' }], readLog);
  expect((await tool.execute('foreign', args)).isError).toBe(true);
  const controller = new AbortController(); controller.abort();
  expect((await tool.execute('cancel', args, controller.signal)).isError).toBe(true);
  expect(readLog).not.toHaveBeenCalled();
});
it.each<LogPage>([
  { text: '', nextCursor: 0, more: true }, { text: 'data', nextCursor: 0, more: false },
  { text: 'data', nextCursor: -1, more: false }, { text: 'data', nextCursor: Number.MAX_SAFE_INTEGER + 1, more: false },
  { text: '中'.repeat(20000), nextCursor: 1, more: false }
])('rejects nonadvancing/invalid/oversized pages without consuming the cursor', async (page) => {
  const tool = createOperationLogTool('task', () => [own()], async () => page);
  const result = await tool.execute('invalid', args);
  expect(result.isError).toBe(true);
  expect(result.details).not.toHaveProperty('nextCursor');
  expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(50 * 1024);
});
it('redacts body secrets and suppresses storage exception details', async () => {
  const readLog = vi.fn(async () => ({ text: 'password=fixture-only-private-value\n', nextCursor: 1, more: false }));
  const tool = createOperationLogTool('task', () => [own()], readLog);
  const first = await tool.execute('redacted', args);
  expect(first.content[0]!.text).toContain('[REDACTED]');
  expect(JSON.stringify(first)).not.toContain('fixture-only-private-value');
  readLog.mockRejectedValueOnce(new Error('password=storage-private-value'));
  const failed = await tool.execute('unavailable', args);
  expect(failed).toMatchObject({ isError: true, details: { code: 'log-unavailable' } });
  expect(JSON.stringify(failed)).not.toContain('storage-private-value');
});
