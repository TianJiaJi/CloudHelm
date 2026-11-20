import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '@cloudhelm/core';
import { approvalPresentation } from '../../../apps/desktop/src/worker/approval-presentation.js';

describe('approval presentation', () => {
  it('describes the pending operation without carrying an older conversation goal', () => {
    const request = { id: 'approval', fingerprint: 'fingerprint', ruleId: 'uncertain-command',
      reason: 'Command effects cannot be determined', expiresAt: Date.now() + 60_000,
      operation: { id: 'operation', kind: 'command', command: 'docker ps -a', scope: {
        taskId: 'task', hostId: 'host', cwd: '/home/ubuntu', runAs: 'ubuntu', terminalId: 'terminal',
        terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/home/ubuntu'],
        protectedPaths: [], goal: '检查磁盘占用\n用户最近补充：查看 Docker 服务'
      } } } satisfies ApprovalRequest;
    const view = approvalPresentation(request);
    expect(view.explanation).toContain('无法可靠判断这条命令');
    expect(view.explanation).not.toContain('磁盘占用');
    expect(view.title).toBe('批准这次远程命令');
  });

  it('keeps concrete reasons visible while redacting and bounding untrusted detail', () => {
    const request: ApprovalRequest = { id: 'approval', fingerprint: 'fingerprint', ruleId: 'uncertain-command',
      reason: '[dynamic-input] 存在动态输入\npassword="synthetic-sensitive"', expiresAt: 1,
      operation: { id: 'op', kind: 'command', command: 'ls "$TARGET"', scope: {
        taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
        policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'not-an-approval-reason' } } };
    const view = approvalPresentation(request);
    expect(view.explanation).toContain('[dynamic-input]');
    expect(view.explanation).not.toContain('synthetic-sensitive');
    expect(view.explanation).not.toContain('not-an-approval-reason');
    expect(view.explanation).not.toContain('\n');
    request.reason = 'x'.repeat(5000);
    expect(approvalPresentation(request).explanation.length).toBeLessThan(1200);
  });

  it('presents the three-phase service transaction on a manage_service restart approval (P0-2)', () => {
    const scope = { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'root', loginAs: 'user',
      terminalId: 'terminal', terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'restart' };
    const restart = approvalPresentation({ id: 'approval', fingerprint: 'fingerprint', ruleId: 'high-impact-command',
      reason: '可能改变主机访问、服务可用性，或大范围删除数据', expiresAt: Date.now() + 60_000,
      operation: { id: 'operation', kind: 'command', command: 'sudo -- systemctl restart -- nginx.service',
        serviceUnit: 'nginx.service', privilege: 'root', scope } } satisfies ApprovalRequest);
    expect(restart.explanation).toContain('只读预检已通过');
    expect(restart.explanation).toContain('本操作重启该服务');
    expect(restart.explanation).toContain('InvocationID/ActiveState/Result');
    expect(restart.explanation).not.toContain('\n');
  });

  it('keeps the transaction copy off ordinary restarts and read-only service steps', () => {
    const scope = { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal',
      terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'restart' };
    const ordinary = approvalPresentation({ id: 'approval', fingerprint: 'fingerprint', ruleId: 'high-impact-command',
      reason: '可能改变主机访问、服务可用性，或大范围删除数据', expiresAt: Date.now() + 60_000,
      operation: { id: 'operation', kind: 'command', command: 'systemctl restart nginx', scope } } satisfies ApprovalRequest);
    expect(ordinary.explanation).not.toContain('只读预检已通过');
    const readOnly = approvalPresentation({ id: 'approval', fingerprint: 'fingerprint', ruleId: 'high-impact-command',
      reason: '可能改变主机访问、服务可用性，或大范围删除数据', expiresAt: Date.now() + 60_000,
      operation: { id: 'operation', kind: 'command', command: 'systemctl show nginx.service',
        serviceUnit: 'nginx.service', scope } } satisfies ApprovalRequest);
    expect(readOnly.explanation).not.toContain('只读预检已通过');
  });
});
