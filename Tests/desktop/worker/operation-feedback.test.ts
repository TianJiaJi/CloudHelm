import { expect, it } from 'vitest';
import { operationFeedback, operationFeedbackDetails, operationToolResult } from '../../../apps/desktop/src/worker/operation-feedback.js';
it('keeps successful retry warnings out of model output while explaining the final outcome', () => {
  const result = { operationId: 'op', status: 'succeeded' as const, exitCode: 0, authentication: 'succeeded' as const,
    stdoutTail: 'Sorry, try again.\nNETWORK ID NAME\n' };
  const feedback = operationFeedback(result, 'host');
  expect(feedback).toContain('Authentication: succeeded'); expect(feedback).toContain('NETWORK ID NAME');
  expect(feedback).not.toContain('Sorry, try again.'); expect(feedback).toContain('do not test sudo');
  expect(result.stdoutTail).toContain('Sorry, try again.');
});
it('does not ask to verify partial effects after an attested no-effect permission failure', () => {
  const feedback = operationFeedback({ operationId: 'query', status: 'failed', exitCode: 1,
    failureKind: 'permission-denied', effects: 'none', stdoutTail: 'permission denied' }, 'host');
  expect(feedback).toContain('no effects');
  expect(feedback).toContain('normal review');
  expect(feedback).not.toContain('Verify possible partial effects');
  expect(operationFeedback({ operationId: 'write', status: 'failed', exitCode: 1,
    failureKind: 'permission-denied', effects: 'possible', stdoutTail: 'permission denied' }, 'host'))
    .toContain('Verify possible partial effects');
});
it('front-loads authoritative capability, truncation and bounded log retrieval without dumping an oversized tail', () => {
  const text = operationFeedback({ operationId: 'large-query', status: 'succeeded', exitCode: 0,
    stdoutTail: '中'.repeat(20000), logRef: 'terminal',
    outputCapture: { totalChars: 100000, tailChars: 20000, truncated: true } }, 'host', true);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
  expect(text.slice(0, 2000)).toContain('Read-only capability: true');
  expect(text.slice(0, 2000)).toContain('Output truncated: true');
  expect(text.slice(0, 2000)).toContain('read_operation_log');
  expect(text.slice(0, 2000)).toContain('large-query');
  expect(text).not.toContain('Effects: completed');
});
it('does not infer complete capture or retrievable logs when old result metadata is absent', () => {
  const text = operationFeedback({ operationId: 'legacy', status: 'succeeded', stdoutTail: 'small' }, 'host');
  expect(text).toContain('Output truncated: unknown');
  expect(text).toContain('Log availability: unknown');
  expect(text).toContain('Read-only capability: unclassified');
});
it('does not claim the command succeeded merely because private authentication succeeded', () => {
  const text = operationFeedback({ operationId: 'authenticated-failure', status: 'failed', exitCode: 1,
    authentication: 'succeeded', stdoutTail: 'command failed', effects: 'none' }, 'host');
  expect(text).not.toContain('completed successfully');
  expect(text).toContain('Status: failed');
});
it('describes a non-interactive password requirement as recoverable', () => {
  expect(operationFeedback({ operationId: 'probe', status: 'failed', authentication: 'required', stdoutTail: '', effects: 'none' }, 'host'))
    .toContain('not a rejected password');
});
it('carries the do-not-blindly-resend warning only on an in-flight unknown result (category ②)', () => {
  expect(operationFeedback({ operationId: 'op', status: 'unknown', failureKind: 'unknown', stdoutTail: '' }, 'host'))
    .toContain('远端可能仍在执行此命令，禁止盲目重发；先用只读方式确认状态');
  expect(operationFeedback({ operationId: 'op', status: 'failed', failureKind: 'unknown', effects: 'none', exitCode: 1, stdoutTail: '' }, 'host'))
    .not.toContain('禁止盲目重发');
});
it('spreads the orthogonal v2 facts into structured details', () => {
  const blocked = operationFeedbackDetails({ operationId: 'blocked', status: 'failed', effects: 'none',
    failureKind: 'not-dispatched', stdoutTail: '' }, true);
  expect(blocked).toMatchObject({ version: 2, receipt: 'rejected', handoff: 'not-sent', businessStart: 'not-started',
    liveness: 'unknown', exit: null, effects: 'none', nextActions: ['revise-operation'], replay: 'never' });
  const pending = operationFeedbackDetails({ operationId: 'pending', status: 'unknown', stdoutTail: '', logRef: 'terminal' });
  expect(pending).toMatchObject({ receipt: 'done', handoff: 'unknown', businessStart: 'unknown',
    liveness: 'unknown', exit: null, nextActions: ['verify-outcome', 'read-log'] });
});
it('reports the requested identity from the reviewed scope without inventing an observed one', () => {
  const tool = operationToolResult({ operationId: 'op', status: 'succeeded', exitCode: 0, stdoutTail: 'ok' }, 'host', false,
    { taskId: 'task', hostId: 'host', cwd: '/srv', runAs: 'deploy', terminalId: 'terminal', terminalGeneration: 1,
      policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'deploy' });
  expect(tool.structuredContent).toMatchObject({ taskId: 'task', hostId: 'host', terminalId: 'terminal',
    identity: { requested: 'deploy', observed: 'unknown', evidenceSource: 'not-observed' } });
});
