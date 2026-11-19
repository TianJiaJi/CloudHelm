import { expect, it } from 'vitest';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { nativeBackgroundEligible, nativeCommandEligible, nativePtySudoEligible, nativePtySuEligible, operationFingerprint, operationIntentKey, suPtyCommand, type ProposedOperation } from '../../packages/core/src/index.js';

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

it('routes only one literal background command to the native background launch', async () => {
  const background: ProposedOperation = { ...base, executionMode: 'background' };
  expect(nativeBackgroundEligible(background, await analyzer.analyze('sleep 300')), 'literal background').toBe(true);
  expect(nativeBackgroundEligible(background, await analyzer.analyze('id -u')), 'command text is irrelevant to the route').toBe(true);
  // The mode is mandatory: foreground commands never take this channel.
  expect(nativeBackgroundEligible(base, await analyzer.analyze('sleep 300')), 'foreground').toBe(false);
  for (const command of ['nohup sleep 300', 'setsid sleep 300', 'timeout 30 sleep 300', 'nice sleep 300',
    'sh -c "sleep 300"', 'python3 -c "import time; time.sleep(300)"', 'sleep 300 &', 'sleep 300; id',
    'sleep 300 | cat', 'sleep 300 > /tmp/out', 'sleep "$DURATION"', 'sudo sleep 300']) {
    expect(nativeBackgroundEligible({ ...background, command }, await analyzer.analyze(command)), command).toBe(false);
  }
  expect(nativeBackgroundEligible({ ...background, privilege: 'root' }, await analyzer.analyze('sleep 300')), 'root request').toBe(false);
  expect(nativeBackgroundEligible({ ...background, processControl: { kind: 'interrupt', jobId: 'job',
    targetOperationId: 'op', pid: 1, processSequence: 1, connectionId: 'conn' } }, await analyzer.analyze('sleep 300')), 'process control').toBe(false);
  expect(nativeBackgroundEligible({ ...background, scope: { ...background.scope, sessionId: 'session' } }, await analyzer.analyze('sleep 300')), 'session-bound').toBe(false);
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

it('routes only the backend-built privilege-root su wrap to the native PTY', async () => {
  const wrapped = suPtyCommand(await analyzer.analyze('systemctl restart nginx'), '/srv');
  expect(typeof wrapped).toBe('string');
  const operation: ProposedOperation = { ...base, command: wrapped!, privilege: 'root' };
  expect(nativePtySuEligible(operation, await analyzer.analyze(wrapped!)), 'backend wrap').toBe(true);
  // Rebuilds with a different body are distinct reviewed operations, both eligible.
  const other = suPtyCommand(await analyzer.analyze('systemctl restart postgresql'), '/srv');
  expect(other).not.toBe(wrapped);
  expect(nativePtySuEligible({ ...base, command: other!, privilege: 'root' }, await analyzer.analyze(other!)), 'second wrap').toBe(true);
  // Agent-supplied or degenerate su forms never take this route.
  for (const command of ['su root', 'su -c id root', `su -l -s /bin/sh root -c 'id'`, 'sudo su root', 'su', 'id -u']) {
    expect(nativePtySuEligible({ ...base, command, privilege: 'root' }, await analyzer.analyze(command)), command).toBe(false);
  }
  // Without the backend privilege marker a literal backend wrap is just an agent command.
  expect(nativePtySuEligible({ ...base, command: wrapped! }, await analyzer.analyze(wrapped!)), 'missing privilege marker').toBe(false);
  expect(nativePtySuEligible({ ...base, command: wrapped!, privilege: 'root', executionMode: 'background' }, await analyzer.analyze(wrapped!)), 'background').toBe(false);
  expect(nativePtySuEligible({ ...base, command: wrapped!, privilege: 'root', processControl: { kind: 'interrupt', jobId: 'job',
    targetOperationId: 'op', pid: 1, processSequence: 1, connectionId: 'conn' } }, await analyzer.analyze(wrapped!)), 'process control').toBe(false);
  expect(nativePtySuEligible({ ...base, command: wrapped!, privilege: 'root', scope: { ...base.scope, sessionId: 'session' } }, await analyzer.analyze(wrapped!)), 'session-bound').toBe(false);
});
