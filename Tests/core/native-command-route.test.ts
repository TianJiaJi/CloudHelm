import { expect, it } from 'vitest';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { nativeCommandEligible, operationFingerprint, operationIntentKey, type ProposedOperation } from '../../packages/core/src/index.js';

const base: ProposedOperation = { id: 'route', kind: 'command', command: 'id -u', scope: {
  taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'identity'
} };
const analyzer = new BashAnalyzer();

it('routes only a literal foreground single command without privileged or opaque execution', async () => {
  expect(nativeCommandEligible(base, await analyzer.analyze(base.command))).toBe(true);
  for (const command of ['sudo id', 'env sudo id', 'busybox sh -c "sudo id"', 'nohup sleep 30',
    'sh -c "id -u"', 'python3 -c "print(1)"', 'id -u | cat',
    'id -u; whoami', 'id -u &', 'echo "$HOME"']) {
    expect(nativeCommandEligible({ ...base, command }, await analyzer.analyze(command)), command).toBe(false);
  }
  expect(nativeCommandEligible({ ...base, executionMode: 'background' }, await analyzer.analyze(base.command))).toBe(false);
  expect(nativeCommandEligible({ ...base, privilege: 'root' }, await analyzer.analyze(base.command))).toBe(false);
});

it('binds the reviewed route but not replay intent to the transport choice', () => {
  const selected: ProposedOperation = { ...base, executionChannel: 'native-exec' };
  expect(operationFingerprint(selected)).not.toBe(operationFingerprint(base));
  expect(operationIntentKey(selected)).toBe(operationIntentKey(base));
});
