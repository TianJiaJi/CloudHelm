import { expect, it, vi } from 'vitest';
import { SafetyGate, TerminalManager } from '@cloudhelm/application';
import type { ExecutionOptions, NativeStartTarget, OperationResult, ProposedOperation, RawTerminal } from '@cloudhelm/core';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';

const PID = 4242;

function procStat(pid: number, processStartTime: number): string {
  const tokens = ['S', '1', `${pid}`, `${pid}`, '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', `${processStartTime}`];
  return `${pid} (sh) ${tokens.join(' ')}`;
}

function backgroundTerminal(gateClaim: (target: NativeStartTarget) => boolean, autoClaim = true) {
  const calls: { command: string; claim?: (target: NativeStartTarget) => boolean }[] = [];
  const runNativeExec = vi.fn(async (host: string, input: { command: string; cwd: string }, _current: () => boolean,
    hooks: { stdout(data: Buffer): void; stderr(): void; claimStart?(target: NativeStartTarget): boolean },
    _signal?: AbortSignal) => {
    calls.push({ command: input.command, claim: hooks.claimStart });
    if (hooks.claimStart) {
      // The transport binds the dispatch target; the native exec consumes the
      // claim immediately before the one exec, mirroring production.
      if (autoClaim && !hooks.claimStart({ hostId: host, command: input.command, cwd: input.cwd }))
        return { state: 'not-dispatched' as const, reason: 'authorization-expired' };
      if (!autoClaim) return { state: 'not-dispatched' as const, reason: 'authorization-expired' };
    }
    if (input.command.includes('setsid /bin/sh -c')) { hooks.stdout(Buffer.from(`${PID}\n`)); return { state: 'exited' as const, exitCode: 0 }; }
    if (input.command.includes('cat ')) { hooks.stdout(Buffer.from(procStat(PID, 12345))); return { state: 'exited' as const, exitCode: 0 }; }
    if (input.command.startsWith('while [ -d')) { hooks.stdout(Buffer.from('__CLOUDHELM_EXIT__0\n')); return { state: 'exited' as const, exitCode: 0 }; }
    return { state: 'exited' as const, exitCode: 0 };
  });
  const transport = { connectionGeneration: () => 1, execFixed: vi.fn(async () => ({ exitCode: 0, output: '' })),
    runNativeExec } as unknown as CommandTransport;
  const terminal = new SshCommandTerminal(transport, 'host');
  const failure = vi.fn(), started = vi.fn(), exited = vi.fn();
  terminal.onExecutionFailure(failure); terminal.onProcessStarted(started); terminal.onExit(exited);
  return { terminal, runNativeExec, calls, failure, started, exited };
}

it('consumes the claim only at the setsid launch dispatch and rebinds the reviewed command', async () => {
  const gateClaim = vi.fn(() => true);
  const f = backgroundTerminal(gateClaim);
  await f.terminal.execute('sleep 300', '/srv', () => true, { executionChannel: 'native-background', claimStart: gateClaim });
  const launchCall = f.calls.find((call) => call.command.includes('setsid /bin/sh -c'));
  expect(launchCall?.claim).toBeTypeOf('function');
  expect(launchCall?.command).toContain('sleep 300');
  expect(f.calls.find((call) => call.command.includes('cat '))?.claim).toBeUndefined(); // Stat check never claims.
  expect(f.calls.find((call) => call.command.startsWith('while [ -d'))?.claim).toBeUndefined(); // Watcher never claims.
  expect(gateClaim).toHaveBeenCalledExactlyOnceWith({ hostId: 'host', command: 'sleep 300', cwd: '/srv' });
  expect(f.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off', businessStart: 'started' });
  expect(f.started).toHaveBeenCalledExactlyOnceWith({ pid: PID, logPath: expect.stringMatching(/^\/tmp\/\.cloudhelm-bg-/u),
    processStartTime: 12345 });
});

it('dispatches no launch when the claim is denied before the setsid handoff', async () => {
  const gateClaim = vi.fn(() => false);
  const f = backgroundTerminal(gateClaim);
  await f.terminal.execute('sleep 300', '/srv', () => true, { executionChannel: 'native-background', claimStart: gateClaim });
  expect(f.calls.length).toBe(1); // Only the launch attempt; no stat check, no watcher.
  expect(gateClaim).toHaveBeenCalledExactlyOnceWith({ hostId: 'host', command: 'sleep 300', cwd: '/srv' });
  expect(f.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'not-dispatched', effects: 'none',
    handoff: 'not-sent', businessStart: 'not-started' });
  expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(f.started).not.toHaveBeenCalled();
});

it('refuses a background claim whose dispatch binding does not match', async () => {
  const gateClaim = vi.fn(() => true);
  const f = backgroundTerminal(gateClaim, false);
  await f.terminal.execute('sleep 300', '/srv', () => true, { executionChannel: 'native-background', claimStart: gateClaim });
  const hook = f.calls[0]!.claim!;
  const launch = f.calls[0]!.command;
  expect(hook({ hostId: 'other', command: launch, cwd: '/srv' })).toBe(false);
  expect(hook({ hostId: 'host', command: 'sleep 300', cwd: '/srv' })).toBe(false); // Reviewed text is not the launch text.
  expect(hook({ hostId: 'host', command: launch, cwd: '/' })).toBe(false);
  expect(gateClaim).not.toHaveBeenCalled();
});

function scope(): ProposedOperation['scope'] {
  return { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: '', terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'background start claim' };
}

function gateFixture(operation: ProposedOperation, consumeClaim: boolean) {
  const manager = new TerminalManager({ data() {}, state() {} });
  const terminalId = manager.open('host', { onData() {}, onClose() {}, close() {} } as unknown as RawTerminal, 'task', '/');
  operation.scope.terminalId = terminalId;
  operation.scope.terminalGeneration = 1;
  let seen: ExecutionOptions | undefined;
  const executor = {
    execute: async (op: ProposedOperation, _fingerprint: string, _signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> => {
      seen = options;
      if (consumeClaim) options?.claimStart?.({ hostId: op.scope.hostId, command: op.kind === 'command' ? op.command : '', cwd: op.scope.cwd });
      return { operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '' };
    },
  };
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), executor, lease: manager,
    evaluator: { evaluate: async () => 'error' }, settings: () => ({ mode: 'ask', revision: 1 }),
    approvals: { requestApproval: async () => true, cancelApproval() {} },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} } });
  return { run: gate.execute(operation), seen: () => seen };
}

it('mints and fills the start claim for a native-background command', async () => {
  const f = gateFixture({ id: 'bg-claim', kind: 'command', command: 'sleep 300', executionChannel: 'native-background',
    executionMode: 'background', scope: scope() }, true);
  const outcome = await f.run;
  expect(typeof f.seen()?.claimStart).toBe('function');
  expect(outcome.result).toMatchObject({ status: 'succeeded', exitCode: 0, handoff: 'handed-off', businessStart: 'started' });
});

it('fills not-sent and not-started when a minted background claim is never consumed', async () => {
  const f = gateFixture({ id: 'bg-unclaimed', kind: 'command', command: 'sleep 300', executionChannel: 'native-background',
    executionMode: 'background', scope: scope() }, false);
  const outcome = await f.run;
  expect(outcome.result).toMatchObject({ status: 'succeeded', exitCode: 0, handoff: 'not-sent', businessStart: 'not-started' });
});
