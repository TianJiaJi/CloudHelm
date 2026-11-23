import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DebugReplay } from '../../../apps/desktop/src/main/debug-replay.js';

const roots: string[] = [];
function setup(limit?: number) {
  const root = mkdtempSync(join(tmpdir(), 'cloudhelm-debug-replay-'));
  roots.push(root);
  return { root, replay: new DebugReplay(root, limit) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('captures visible messages only while explicitly enabled, without backfill or raw terminal data', () => {
  const { root, replay } = setup();
  const user = { type: 'task-message', taskId: 'task', role: 'user', createdAt: 1 } as const;
  replay.event({ ...user, text: 'prior-private-data' });
  expect(existsSync(replay.file)).toBe(false);
  expect(replay.control('enable').enabled).toBe(true);
  replay.event({ ...user, text: '检查磁盘\n保留完整正文' });
  replay.event({ ...user, role: 'agent', text: '收到。' });
  replay.event({ type: 'terminal-data', terminalId: 'terminal', data: 'private-pty-data' });
  replay.control('disable');
  replay.event({ ...user, text: 'after-disable' });
  const text = replay.control('read').text!;
  expect(text.trim().split('\n').map((line) => JSON.parse(line).type)).toEqual(['capture-start', 'message', 'message']);
  expect(text).toContain('检查磁盘\\n保留完整正文');
  expect(text).not.toMatch(/private-pty-data|prior-private-data|after-disable/u);
  expect(new DebugReplay(root).control('status').enabled).toBe(false);
  replay.control('clear');
  expect(existsSync(replay.file)).toBe(false);
});

it('redacts known secrets and never expands reference or clarification text', () => {
  const { replay } = setup();
  replay.control('enable');
  const message = { type: 'task-message', taskId: 'task', role: 'user', createdAt: 1 } as const;
  replay.event({ ...message, text: 'expanded-reference', document: { requestId: 'r', parts: [
    { type: 'text', text: 'token=secret-value-123 ' },
    { type: 'reference', reference: { id: 'ref', kind: 'terminal', capturedAt: 1 }, content: 'reference-secret' }
  ] } });
  replay.event({ ...message, source: 'clarification', text: 'clarification-answer' });
  const text = replay.control('read').text!;
  expect(text).toContain('引用正文未记录');
  expect(text).not.toMatch(/expanded-reference|reference-secret|secret-value-123|clarification-answer/u);
});

it('stops at the local capacity limit without truncating existing records', () => {
  const { replay } = setup(512);
  replay.control('enable');
  const before = replay.control('read').text;
  replay.event({ type: 'task-message', taskId: 'task', role: 'user', createdAt: 1, text: '内容'.repeat(1024) });
  expect(replay.control('read')).toMatchObject({ enabled: false, error: expect.stringContaining('容量上限'), text: before });
});

it('keeps separate operation IDs for one tool call and omits unrelated fields', () => {
  const { replay } = setup();
  replay.control('enable');
  const op = { taskId: 'task', hostId: 'host', toolCallId: 'call', kind: 'command', createdAt: 1 } as const;
  replay.operation({ ...op, id: 'observation', status: 'succeeded', preview: 'id', exitCode: 0, outputTail: 'unrecorded-terminal-output' });
  replay.operation({ ...op, id: 'candidate', status: 'denied', preview: 'blocked command', ruleId: 'continuation-read-only' });
  const lines = replay.control('read').text!.trim().split('\n').map((line) => JSON.parse(line));
  expect(lines.slice(1)).toMatchObject([{ toolCallId: 'call', operationId: 'observation', exitCode: 0 },
    { toolCallId: 'call', operationId: 'candidate', ruleId: 'continuation-read-only' }]);
  expect(JSON.stringify(lines)).not.toContain('unrecorded-terminal-output');
});
