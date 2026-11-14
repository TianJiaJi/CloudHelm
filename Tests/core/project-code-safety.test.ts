import { expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { decideSafety, inspectScriptSafety, isEffectFreeQuery, type OperationScope, type ProposedOperation } from '@cloudhelm/core';

const scope: OperationScope = { taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'user',
  terminalId: 'terminal', terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'build' };
const operation = (command: string): Extract<ProposedOperation, { kind: 'command' }> => ({ id: 'op', kind: 'command', command, scope });
const analyzer = new BashAnalyzer();

it('does not auto-approve package hooks or build rules merely by executable name', async () => {
  for (const command of ['npm install', 'pnpm install', 'yarn build', 'pip install .', 'make', 'cmake --build build', 'sudo npm install']) {
    const analysis = await analyzer.analyze(command);
    expect(decideSafety(operation(command), { mode: 'ask', revision: 1 }, analysis))
      .toMatchObject({ verdict: 'ask', ruleId: 'project-code-entry' });
    expect(decideSafety(operation(command), { mode: 'ai-review', revision: 1 }, analysis))
      .toMatchObject({ verdict: 'evaluate', ruleId: 'project-code-entry' });
    expect(isEffectFreeQuery(analysis)).toBe(false);
  }
});

it('keeps exact version probes light without granting a query capability to extra arguments', async () => {
  for (const command of ['npm --version', 'make --version', 'cmake --version']) {
    const analysis = await analyzer.analyze(command);
    expect(decideSafety(operation(command), { mode: 'ask', revision: 1 }, analysis)).toMatchObject({ verdict: 'allow' });
    expect(isEffectFreeQuery(analysis)).toBe(true);
  }
  expect(isEffectFreeQuery(await analyzer.analyze('make --version -f project.mk'))).toBe(false);
});

it('keeps explicit full-access policy and does not launder builds through script inspection', async () => {
  const analysis = await analyzer.analyze('make');
  expect(decideSafety(operation('make'), { mode: 'permissive', revision: 1 }, analysis))
    .toMatchObject({ verdict: 'allow', ruleId: 'project-code-entry', impact: 'unknown' });
  expect(inspectScriptSafety(operation('sh build.sh'), 'make', analysis, { mode: 'ask', revision: 1 }))
    .toMatchObject({ verdict: 'ask', ruleId: 'script-uncertain' });
});
