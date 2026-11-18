import { expect, it, vi } from 'vitest';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';
import { SafetyGate } from '../../packages/application/src/safety-gate.js';
import { TerminalManager } from '../../packages/application/src/terminal-manager.js';
import { operationFingerprint, type OperationAudit, type OperationExecutor, type ProposedOperation, type TerminalLease } from '../../packages/core/src/index.js';
import { taskOperationPreflight } from '../../apps/desktop/src/worker/task-operation-preflight.js';

it('binds and audits native transport before executing id -u without placing Python or using SFTP', async () => {
  const runNativeExec = vi.fn(async (_hostId: string, _request: unknown, _current: () => boolean,
    hooks: { stdout(data: Buffer): void; stderr(data: Buffer): void }) => {
    hooks.stdout(Buffer.from('1000\n')); return { state: 'exited' as const, exitCode: 0 };
  });
  const prepareCommandProgram = vi.fn(), openPipe = vi.fn();
  const transport = { connectionGeneration: () => 1, execFixed: async () => ({ exitCode: 0, output: '' }),
    runNativeExec, prepareCommandProgram, openPipe } as unknown as CommandTransport;
  const manager = new TerminalManager({ data() {}, state() {} });
  const terminalId = manager.open('host', new SshCommandTerminal(transport, 'host'), 'task', '/');
  const operation: ProposedOperation = { id: 'native-identity', kind: 'command', command: 'id -u', scope: {
    taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', loginAs: 'user', terminalId, terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'inspect identity' } };
  const analyzer = new BashAnalyzer();
  const preflight = await taskOperationPreflight(operation, { analyzer, operations: () => [], replayProtected: new Set() });
  if (!('operation' in preflight)) throw new Error('preflight refused a plain identity query');
  expect(preflight.operation).toMatchObject({ executionChannel: 'native-exec' });
  const stages: string[] = [];
  const audit: OperationAudit = {
    proposed: async (proposed, fingerprint) => {
      expect(proposed).toMatchObject({ executionChannel: 'native-exec' });
      expect(fingerprint).toBe(operationFingerprint(proposed)); stages.push('proposed');
    },
    decided: async (_id, decision) => { expect(decision.verdict).toBe('allow'); stages.push('decided'); },
    completed: async (result) => { expect(result.status).toBe('succeeded'); stages.push('completed'); }
  };
  const gate = new SafetyGate({ analyzer, audit, executor: manager, lease: manager,
    settings: () => ({ mode: 'permissive', revision: 1 }),
    evaluator: { evaluate: async () => { throw new Error('read-only query must not request evaluation'); } },
    approvals: { requestApproval: async () => { throw new Error('read-only query must not request approval'); } } });
  const outcome = await gate.execute(preflight.operation);
  expect(outcome.result).toMatchObject({ status: 'succeeded', exitCode: 0, stdoutTail: '1000\n' });
  expect(stages).toEqual(['proposed', 'decided', 'completed']);
  expect(runNativeExec).toHaveBeenCalledOnce();
  expect(prepareCommandProgram).not.toHaveBeenCalled(); expect(openPipe).not.toHaveBeenCalled();
});

it('refuses a native PTY channel that does not match an eligible literal sudo command', async () => {
  const decided = vi.fn(async () => {});
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(),
    audit: { proposed: vi.fn(async () => {}), decided, completed: vi.fn(async () => {}) },
    executor: {} as unknown as OperationExecutor, lease: {} as unknown as TerminalLease,
    settings: () => ({ mode: 'permissive', revision: 1 }),
    evaluator: { evaluate: async () => { throw new Error('a misrouted channel must not be evaluated'); } },
    approvals: { requestApproval: async () => { throw new Error('a misrouted channel must not be approved'); } } });
  const outcome = await gate.execute({ id: 'misrouted-pty', kind: 'command', command: 'id -u', executionChannel: 'native-pty', scope: {
    taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'identity' } });
  expect(outcome.decision).toMatchObject({ verdict: 'error', ruleId: 'invalid-execution-channel' });
  expect(decided).toHaveBeenCalledExactlyOnceWith('misrouted-pty',
    expect.objectContaining({ verdict: 'error', ruleId: 'invalid-execution-channel' }), expect.any(String));
});
