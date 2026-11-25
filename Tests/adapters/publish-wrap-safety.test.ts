import { describe, expect, it } from 'vitest';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { buildPublishPlan, decideSafety, type ProposedOperation } from '@cloudhelm/core';

const analyzer = new BashAnalyzer();

const settings = { mode: 'ask' as const, revision: 1 };
const scope = {
  taskId: 'task-1', hostId: 'host-1', cwd: '/', runAs: 'root',
  terminalId: 'terminal-1', terminalGeneration: 1, policyRevision: 1,
  allowedWorkingRoots: ['/home/admin'], protectedPaths: [], goal: '部署健康检查服务'
};

function command(value: string): Extract<ProposedOperation, { kind: 'command' }> {
  return { id: 'operation-1', kind: 'command', command: value, privilege: 'root', scope };
}

// The publish scripts traverse critical system trees with assertion-only find
// guards (no -delete, no -exec) and clean the candidate with unlink, the
// single-file primitive. Regression for the real-machine finding: the real
// analyzer plus decideSafety must route these backend-built wraps through
// review, never hard-deny them, while a find over a critical tree combined
// with rm stays denied.
describe('publish wrap safety integration', () => {
  it.each([
    ['/usr/local/share/g3-health/health_server.py'],
    ['/etc/systemd/system/g3-health.service'],
  ])('publish wraps for %s are reviewed, not hard-denied', async (targetPath) => {
    const plan = buildPublishPlan({ targetPath, contentSha256: 'a'.repeat(64), contentBytes: 64,
      mode: '644', owner: 'root:root',
      stagingPath: '/tmp/.cloudhelm-publish-0123456789abcdef0123456789abcdef.staging',
      nonce: '0123456789abcdef0123456789abcdef' });
    expect(plan).toBeDefined();
    for (const wrapped of [plan!.wrappedCandidateCommand, plan!.wrappedCommitCommand]) {
      const decision = decideSafety(command(wrapped), settings, await analyzer.analyze(wrapped));
      expect(decision.verdict).not.toBe('deny');
      expect(decision.verdict).not.toBe('error');
    }
  });

  it('still denies a find over a critical tree combined with rm', async () => {
    const raw = 'find /etc -maxdepth 1 -type f; rm -f /tmp/junk';
    const decision = decideSafety(command(raw), settings, await analyzer.analyze(raw));
    expect(decision).toMatchObject({ verdict: 'deny', ruleId: 'system-blacklist' });
  });
});
