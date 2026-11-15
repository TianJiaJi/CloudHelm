import { expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@cloudhelm/core';
import type { ApprovalView } from '@cloudhelm/contracts';
import { createTaskApprovals } from '../../../apps/desktop/src/worker/task-approval.js';

const request: ApprovalRequest = { id: 'approval', fingerprint: 'exact', ruleId: 'code-execution', reason: 'Code may execute',
  expiresAt: 1234, impact: 'unknown', targets: ['/srv/app'], operation: { id: 'op', kind: 'command', command: 'docker build .',
    executionMode: 'background', scope: { taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'user', terminalId: 'terminal',
      terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'maintain' } } };

it('preserves exact approval binding and background warning, and settles after refusal', async () => {
  const waiting = vi.fn(), settled = vi.fn(), cancelApproval = vi.fn();
  const requestApproval = vi.fn(async (view: ApprovalView) => {
    expect(waiting).toHaveBeenCalledOnce(); expect(settled).not.toHaveBeenCalled();
    expect(view).toMatchObject({ id: request.id, fingerprint: 'exact', taskId: 'task', hostId: 'host', operationId: 'op',
      cwd: '/srv/app', account: 'user', expiresAt: 1234, impact: 'unknown', targets: ['/srv/app'], preview: 'preview' });
    expect(view.explanation).toContain('后台执行'); expect(view.explanation).toContain('code-execution');
    return false;
  });
  const approvals = createTaskApprovals({ requestApproval, cancelApproval }, () => 'preview', waiting, settled);
  expect(await approvals.requestApproval(request)).toBe(false);
  expect(settled).toHaveBeenCalledOnce(); approvals.cancelApproval?.(request.id);
  expect(cancelApproval).toHaveBeenCalledWith(request.id);
});

it('settles rejected approval ports without converting errors into permission', async () => {
  const settled = vi.fn();
  const approvals = createTaskApprovals({ requestApproval: async () => { throw new Error('unavailable'); }, cancelApproval: vi.fn() },
    () => 'preview', vi.fn(), settled);
  await expect(approvals.requestApproval(request)).rejects.toThrow('unavailable');
  expect(settled).toHaveBeenCalledOnce();
});
