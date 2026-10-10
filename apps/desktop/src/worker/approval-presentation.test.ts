import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '@cloudhelm/core';
import { approvalPresentation } from './approval-presentation.js';

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
});
