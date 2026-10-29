import { expect, it, vi } from 'vitest';
import { createRequestBudget, reserveRoundRequest, safeDiagnostic, type ModelRequestAttempt } from '@cloudhelm/core';
import { eventDiagnostic, reservationDiagnostic } from '../../../apps/desktop/src/worker/diagnostic-events.js';
import { taskSessionEvents } from '../../../apps/desktop/src/worker/task-session-events.js';
import { taskToolDiagnostic } from '../../../apps/desktop/src/worker/task-tool-diagnostic.js';
const attempt: ModelRequestAttempt = { logicalRequestId: 'logical-one', purpose: 'conversation', attempt: 2, transport: 'http' };
it('logs logical/attempt/round/purpose metadata but does not call a receipt an HTTP response', () => {
  const budget = reserveRoundRequest(createRequestBudget('round'));
  expect(reservationDiagnostic({ kind: 'reserve', taskId: 'task', roundId: 'round', attempt },
    { kind: 'reserve', taskId: 'task', budget, duplicate: false })).toMatchObject({ event: 'model.reservation',
    roundId: 'round', logicalRequestId: 'logical-one', attempt: 2, purpose: 'conversation', transport: 'http' });
  expect(eventDiagnostic({ event: { type: 'model-request', taskId: 'task', purpose: 'conversation', roundId: 'round',
    logicalRequestId: 'logical-one', attempt: 2, transport: 'http', request: 10, model: { provider: 'fixture', modelId: 'fixture' }, createdAt: 1 } }))
    .toMatchObject({ event: 'model.request', request: 10, purpose: 'conversation', attempt: 2, logicalRequestId: 'logical-one' });
});
it('never attributes duplicate or unbound assistant notifications to another model request', () => {
  const diagnostic = vi.fn();
  const observe = taskSessionEvents('task', { diagnostic, event() {}, request: () => ({ count: 10, started: Date.now() - 100 }),
    activity() {}, compactionFailed() {}, turnEnd() {} });
  observe({ type: 'response', attempt, status: 'stop' }); observe({ type: 'response', attempt, status: 'stop' });
  observe({ type: 'response' });
  expect(diagnostic.mock.calls.filter(([event]) => event.event === 'model.response')).toHaveLength(1);
  expect(diagnostic.mock.calls[0]?.[0]).toMatchObject({ request: 10, logicalRequestId: 'logical-one', attempt: 2, responseAttributed: true });
  expect(diagnostic.mock.calls.at(-1)?.[0]).toEqual({ event: 'model.response-unattributed', responseAttributed: false });
});
it('keeps chat, command/file bodies, output and raw error prose out of production diagnostic events', () => {
  const sentinel = 'private-file-content-not-a-recognizable-credential';
  const chat = eventDiagnostic({ event: { type: 'task-message', taskId: 'task', role: 'user', text: sentinel, createdAt: 1 } });
  const operation = eventDiagnostic({ event: { type: 'operation', value: { id: 'op', taskId: 'task', hostId: 'host', kind: 'command',
    preview: sentinel, outputTail: sentinel, status: 'succeeded', readOnly: true, effects: 'none', createdAt: 1 } } });
  const failure = eventDiagnostic({ event: { type: 'task-status', taskId: 'task', status: 'failed', summary: sentinel, resumeReason: 'model' } });
  const tool = taskToolDiagnostic({ type: 'tool-start', id: 'call', name: 'write_remote_file', args: { path: '/safe/file', content: sentinel } });
  const command = taskToolDiagnostic({ type: 'tool-start', id: 'command', name: 'run_remote', args: { command: sentinel } });
  expect(JSON.stringify([chat, operation, failure, tool, command])).not.toContain(sentinel);
  expect(chat).toMatchObject({ size: Buffer.byteLength(sentinel) });
  expect(operation).toMatchObject({ readOnly: true, classification: 'effect-free' });
  expect(failure).toMatchObject({ resumeReason: 'model', errorCode: 'model-incomplete' });
  expect(tool.sha256).toMatch(/^[a-f0-9]{64}$/u);
});
it('caps evidence references, preserves classification/resolution tags and drops unknown credential containers', () => {
  const input = { event: 'operation', readOnly: false, classification: 'unclassified', reconciliationKind: 'risk-accepted',
    evidenceOperationIds: [...Array.from({ length: 12 }, (_, i) => `evidence-${i}`), 'token=private-secret'],
    roundId: 'round', attempt: 1, headers: { Authorization: 'Bearer private-secret' }, apiKey: 'private-secret' };
  const safe = safeDiagnostic(input);
  expect(safe).toMatchObject({ readOnly: false, classification: 'unclassified', reconciliationKind: 'risk-accepted', evidenceOmitted: 5 });
  expect(safe.evidenceOperationIds).toHaveLength(8); expect(JSON.stringify(safe)).not.toContain('private-secret');
});
