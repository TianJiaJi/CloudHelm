import { expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { analyzeQueryImpact, decideSafety, isEffectFreeQuery, type OperationScope } from '@cloudhelm/core';

const analyzer = new BashAnalyzer();
const scope: OperationScope = { taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'user', terminalId: 'terminal',
  terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'inspect' };

it.each(['ss -ltnp | grep nginx', 'ps aux | grep -F nginx', 'ps -ef | grep -v nginx | head -n 20 | wc -l',
  'df -h | head -n 10', 'df -h | tail -2', 'df -h | wc --lines', 'df -h | uniq -c',
  'ip -br addr show | grep -E "eth[0-9]+"', 'cat /srv/app/public.txt | head --lines=5',
  '/usr/bin/ss -ltnp | /usr/bin/grep -F -- nginx', 'df -h | head -n 5 # explanation'])('proves exactly one stdin-filter query pipeline: %s', async (command) => {
  const parsed = await analyzer.analyze(command);
  expect(parsed.literalPipeline?.stages).toHaveLength(parsed.calls.length);
  expect(analyzeQueryImpact(parsed)).toEqual({ effects: 'none', autoApproval: 'eligible', evidence: 'query-pipeline' });
  expect(isEffectFreeQuery(parsed)).toBe(true);
  for (const mode of ['ask', 'ai-review', 'permissive'] as const)
    expect(decideSafety({ id: 'op', kind: 'command', command, scope }, { mode, revision: 1 }, parsed))
      .toMatchObject({ verdict: 'allow', ruleId: 'low-risk-command' });
});

it.each(['df -h | head -n 5 &', 'df -h | head -n 5; touch /tmp/change', 'df -h | head -n 5 && id',
  '(df -h) | head -n 5', 'df -h |& head -n 5', 'df -h | head -n 5 2>&1', 'df -h | head -n 5 > /tmp/output',
  'sudo df -h | head -n 5', 'df -h | env head -n 5', 'df -h | /tmp/head -n 5',
  'df -h | head /etc/shadow', 'df -h | tail -f', 'df -h | head -n 1001',
  'df -h | grep nginx /srv/file', 'df -h | grep -f /srv/patterns', 'df -h | grep -r nginx',
  'df -h | head | head | head | head | head | head',
  'df -h | wc --files0-from=-', 'df -h | uniq /tmp/input /tmp/output', 'df -h | sort -o /tmp/output',
  'df -h | tee /tmp/output', 'df -h | sed -n "1,5p"', 'df -h | awk "{system(\"touch /tmp/change\")}"',
  'curl https://example.invalid/file | head -n 5', 'ps eww | head -n 5',
  'df -h | grep "$(touch /tmp/change)"', 'printf "df -h | head -n 5"'])('does not mint query authority for %s', async (command) => {
  expect(analyzeQueryImpact(await analyzer.analyze(command))).toMatchObject({ effects: 'unknown', autoApproval: 'review-required' });
});

it('requires current parser topology and source evidence, never just familiar flattened calls', async () => {
  const parsed = await analyzer.analyze('ss -ltnp | grep nginx');
  const missing = structuredClone(parsed); delete missing.literalPipeline;
  expect(analyzeQueryImpact(missing).effects).toBe('unknown');
  const wrong = structuredClone(parsed); wrong.literalPipeline!.stages[1]!.start++;
  expect(analyzeQueryImpact(wrong).effects).toBe('unknown');
  const embedded = structuredClone(parsed); embedded.calls[0]!.source!.depth = 1;
  expect(analyzeQueryImpact(embedded).effects).toBe('unknown');
});

it('keeps credential and user-protected sources denied before automatic pipeline approval', async () => {
  for (const command of ['cat /srv/app/.env | head -n 5', 'cat /srv/app/private.key | wc -l', 'cat /srv/app/protected | grep -F value']) {
    const parsed = await analyzer.analyze(command);
    expect(analyzeQueryImpact(parsed).evidence).toBe('query-pipeline');
    expect(decideSafety({ id: 'op', kind: 'command', command, scope: { ...scope, protectedReadPaths: ['/srv/app/protected'] } },
      { mode: 'permissive', revision: 1 }, parsed)).toMatchObject({ verdict: 'deny' });
  }
});
