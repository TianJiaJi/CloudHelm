import { expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { analyzeQueryImpact, decideSafety, isEffectFreeQuery, type OperationScope } from '@cloudhelm/core';

const analyzer = new BashAnalyzer();
const scope: OperationScope = { taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'user', terminalId: 'terminal',
  terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'inspect' };

it.each(['ss -ltnp', 'ip -br addr show', 'lsblk -o NAME,SIZE,TYPE', 'lscpu --json', 'nproc --all',
  'ping -c 1 -W 2 example.test', 'df -h && free -m', 'id; ls -ld /srv/app',
  'ping -c 1 -W 1 192.0.2.1 || ping -c 1 -W 1 192.0.2.2'])('uses the same effect proof to permit bounded query %s', async (command) => {
  const parsed = await analyzer.analyze(command);
  expect(analyzeQueryImpact(parsed)).toMatchObject({ effects: 'none', autoApproval: 'eligible' });
  expect(isEffectFreeQuery(parsed)).toBe(true);
  for (const mode of ['ask', 'ai-review', 'permissive'] as const)
    expect(decideSafety({ id: 'op', kind: 'command', command, scope }, { mode, revision: 1 }, parsed))
      .toMatchObject({ verdict: 'allow', ruleId: 'low-risk-command' });
});

it.each(['timeout 10s df -h', 'timeout -k 5s 10s df -h', 'timeout --foreground 10s df -h', 'timeout -s KILL 5s ss -ltnp',
  'nice -n 10 free -m', 'time ls', 'time -p ls', 'env LANG=C.UTF-8 id', 'env -i df -h', 'env -u LC_ALL df -h',
  'busybox df -h', 'env ping -c 1 -W 1 example.test'])('proves the same bounded query when wrapped by a harmless launcher: %s', async (command) => {
  const parsed = await analyzer.analyze(command);
  expect(analyzeQueryImpact(parsed)).toMatchObject({ effects: 'none', autoApproval: 'eligible', evidence: 'wrapped-query' });
  expect(isEffectFreeQuery(parsed)).toBe(true);
  for (const mode of ['ask', 'ai-review', 'permissive'] as const)
    expect(decideSafety({ id: 'op', kind: 'command', command, scope }, { mode, revision: 1 }, parsed))
      .toMatchObject({ verdict: 'allow', ruleId: 'low-risk-command' });
});

it.each(['nohup uptime', 'setsid df -h', 'xargs ls', 'command -p df -h', 'exec df -h',
  'env FOO=bar df -h', 'env -S "A=1" df -h',
  'env -C /tmp df -h', 'time -o /tmp/timing.txt ls', 'exec -a custom df -h',
  'timeout 10s rm -rf /tmp/x', 'timeout 10s df -h; touch /tmp/changed'])('keeps unproven launchers and wrapper options out of auto-approval: %s', async (command) => {
  expect(analyzeQueryImpact(await analyzer.analyze(command))).toMatchObject({ effects: 'unknown', autoApproval: 'review-required' });
});

it.each(['ss -K', 'ip link set eth0 down', 'lsblk --output-all', 'ping example.test', 'ping -f -c 1 -W 1 example.test',
  '/tmp/ss -ltnp', 'df -h; touch /tmp/changed', 'df -h > /tmp/result', 'id; ls "$(touch /tmp/changed)"',
  'df -h | cat', 'env LD_PRELOAD=/tmp/code.so df -h', 'sudo -u root df -h', 'make -f project.mk'])('does not infer auto-approval from a familiar program inside %s', async (command) => {
  expect(analyzeQueryImpact(await analyzer.analyze(command))).toMatchObject({ effects: 'unknown', autoApproval: 'review-required' });
});

it('keeps privileged effects separate from approval and applies path policy before query eligibility', async () => {
  const privileged = await analyzer.analyze('sudo cat /srv/app/plain.txt');
  expect(analyzeQueryImpact(privileged)).toMatchObject({ effects: 'none', autoApproval: 'review-required', evidence: 'privileged-query' });
  expect(decideSafety({ id: 'op', kind: 'command', command: privileged.raw, scope }, { mode: 'ask', revision: 1 }, privileged))
    .toMatchObject({ verdict: 'ask' });
  for (const command of ['cat /srv/app/.env; df -h', 'cat /srv/app/private.key; df -h', 'cat /srv/app/protected.txt; df -h']) {
    const parsed = await analyzer.analyze(command);
    expect(analyzeQueryImpact(parsed).autoApproval).toBe('eligible');
    expect(decideSafety({ id: 'op', kind: 'command', command, scope: { ...scope, protectedReadPaths: ['/srv/app/protected.txt'] } },
      { mode: 'permissive', revision: 1 }, parsed)).toMatchObject({ verdict: 'deny' });
  }
});
