import { expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { analyzeQueryImpact, decideSafety, describeCommandReview, type OperationScope } from '@cloudhelm/core';
const analyzer = new BashAnalyzer();
const scope: OperationScope = { taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'user', terminalId: 'terminal',
  terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'inspect' };

it.each([['ss -K', 'unsupported-query-form'], ['customctl inspect', 'unrecognized-operation'],
  ['ls "$TARGET"', 'dynamic-input'], ['df -h > /tmp/output', 'output-redirection'],
  ['df -h | head -n 3 &', 'pipeline-topology'], ['curl https://example.invalid/file | head -n 3', 'pipeline-source'],
  ['df -h | head /srv/other', 'pipeline-filter'], ['python3 -c "print(1)"', 'code-execution'],
  ['sudo cat /srv/public', 'privilege-review'], ['/tmp/ss -ltnp', 'custom-executable'],
  ['env LD_PRELOAD=/tmp/code.so df -h', 'launcher-context'], ['id; touch /tmp/change', 'compound-flow']])('explains %s with fixed reason %s without changing three-tier routing', async (command, code) => {
  const parsed = await analyzer.analyze(command);
  const facts = analyzeQueryImpact(parsed);
  expect(facts.reviewReasons).toContain(code);
  for (const [mode, verdict] of [['ask', 'ask'], ['ai-review', 'evaluate'], ['permissive', 'allow']] as const) {
    const result = decideSafety({ id: 'op', kind: 'command', command, scope }, { mode, revision: 1 }, parsed);
    expect(result.verdict).toBe(verdict);
    expect(result.reason).toContain(`[${code}]`);
  }
});

it('does not echo source, arguments, goals or raw parser diagnostics in the explanation', async () => {
  const parsed = await analyzer.analyze('customctl "synthetic-private-marker"');
  const text = describeCommandReview(analyzeQueryImpact(parsed).reviewReasons!);
  expect(text).not.toContain('synthetic-private-marker'); expect(text).not.toContain('customctl');
  expect(describeCommandReview(['dynamic-input', 'dynamic-input'])).not.toContain('；');
});

it('leaves proven automatic queries and hard prohibitions ahead of uncertainty explanations', async () => {
  for (const command of ['ss -ltnp', 'ss -ltnp | grep nginx']) {
    expect(analyzeQueryImpact(await analyzer.analyze(command)).reviewReasons).toBeUndefined();
    expect(decideSafety({ id: 'op', kind: 'command', command, scope }, { mode: 'ask', revision: 1 }, await analyzer.analyze(command)).verdict).toBe('allow');
  }
  const command = 'cat /srv/app/.env | head';
  expect(decideSafety({ id: 'op', kind: 'command', command, scope }, { mode: 'permissive', revision: 1 }, await analyzer.analyze(command)))
    .toMatchObject({ verdict: 'deny', ruleId: 'credential-resource' });
});
