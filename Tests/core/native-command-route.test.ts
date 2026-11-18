import { expect, it } from 'vitest';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { nativeCommandEligible, nativePtySudoEligible, operationFingerprint, operationIntentKey, type ProposedOperation } from '../../packages/core/src/index.js';

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

it('routes one literal sudo command to the credential-bound PTY, never nested, prompted or compound forms', async () => {
  expect(nativePtySudoEligible(base, await analyzer.analyze(base.command)), 'not a sudo command').toBe(false);
  for (const command of ['sudo id', 'sudo -u deploy id', 'sudo systemctl restart nginx', 'sudo -k apt update']) {
    expect(nativePtySudoEligible({ ...base, command }, await analyzer.analyze(command)), command).toBe(true);
  }
  const sudo = await analyzer.analyze('sudo id');
  expect(nativePtySudoEligible({ ...base, command: 'sudo id', privilege: 'root' }, sudo), 'root request still uses the PTY').toBe(true);
  for (const command of ['sudo id; sudo whoami', 'sudo id | cat', 'sudo id > /tmp/out', 'sudo -p "x" id',
    'sudo --prompt "x" id', 'sudo -A id', 'sudo --askpass id', 'env sudo id', 'sudo $CMD', 'sudo sudo id',
    'sudo su', 'sudo', 'sudo -s', 'sudo -i', 'id -u', 'echo "$HOME"']) {
    expect(nativePtySudoEligible({ ...base, command }, await analyzer.analyze(command)), command).toBe(false);
  }
  expect(nativePtySudoEligible({ ...base, command: 'sudo id', executionMode: 'background' }, sudo), 'background').toBe(false);
  expect(nativePtySudoEligible({ ...base, command: 'sudo id', processControl: { kind: 'interrupt', jobId: 'job',
    targetOperationId: 'op', pid: 1, processSequence: 1, connectionId: 'conn' } }, sudo), 'process control').toBe(false);
  expect(nativePtySudoEligible({ ...base, command: 'sudo id', scope: { ...base.scope, sessionId: 'session' } }, sudo), 'session-bound').toBe(false);
});
