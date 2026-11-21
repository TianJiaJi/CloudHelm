import { describe, expect, it, vi } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import type { SafetyGate } from '@cloudhelm/application';
import { operationFingerprint, PrivilegeError, suPtyCommand, type OperationResult, type ProposedOperation } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { OperationPrivilege } from '../../../apps/desktop/src/worker/operation-privilege.js';
import { operationToolResult } from '../../../apps/desktop/src/worker/operation-feedback.js';
import type { RemoteToolDependencies } from '../../../apps/desktop/src/worker/remote-tool-dependencies.js';

function fixture(uid = '1000') {
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const state = { generation: 1, failure: undefined as Partial<OperationResult> | undefined };
  const analyzer = new BashAnalyzer();
  const gate = {} as SafetyGate;
  const scope: RemoteToolDependencies['scope'] = (_host, terminalId, cwd = '/') => ({ taskId: 'task', hostId: host.id, terminalId,
    terminalGeneration: state.generation, cwd, loginAs: host.username, runAs: terminalId === 'su-terminal' ? 'root' : host.username,
    ...(terminalId === 'su-terminal' ? { sessionId: 'su-session' } : {}),
    policyRevision: 1, protectedPaths: [], allowedWorkingRoots: ['/'], goal: 'Read authorized metadata as root' });
  const ensureTerminal = vi.fn(async (_hostId: string, session?: string) => session ? 'su-terminal' : 'ordinary');
  const requestRoot = vi.fn<NonNullable<RemoteToolDependencies['requestRoot']>>(async () => ({ method: 'su', runAs: 'root' }));
  const runOperation = vi.fn<RemoteToolDependencies['runOperation']>(async (actualGate, operation) => {
    expect(actualGate).toBe(gate);
    const command = operation.kind === 'command' ? operation.command : '';
    const result: OperationResult = { operationId: operation.id, status: 'succeeded', exitCode: 0,
      stdoutTail: command === 'id -u' ? `${uid}\n` : 'observed\n',
      ...(command.startsWith('sudo') ? state.failure : {}) };
    return operationToolResult(result, host.label, true);
  });
  const deps = { hosts: [host], scope, ensureTerminal, requestRoot, runOperation } as unknown as RemoteToolDependencies;
  const routing = new OperationPrivilege(deps);
  const operation: Extract<ProposedOperation, { kind: 'command' }> = { id: 'business', kind: 'command', command: 'stat /root/example', scope: scope(host, 'ordinary') };
  const wrap = async (): Promise<string> => {
    const wrapped = suPtyCommand(await analyzer.analyze(operation.command), operation.scope.cwd);
    if (!wrapped) throw new Error('fixture wrap failed');
    return wrapped;
  };
  return { host, state, gate, scope, ensureTerminal, requestRoot, runOperation, routing, operation, wrap,
    run: () => routing.run(gate, host, operation), commands: () => runOperation.mock.calls.map(([, op]) => op.kind === 'command' ? op.command : '') };
}
const missing: Partial<OperationResult> = { status: 'failed', effects: 'none', exitCode: 127,
  privilege: { method: 'sudo', stage: 'preparation', code: 'sudo-unavailable', source: 'transport', businessCommand: 'not-started', recovery: 'confirm-alternative' } };
const denied: Partial<OperationResult> = { status: 'failed', failureKind: 'authentication-failed', effects: 'none', exitCode: 1,
  privilege: { method: 'sudo', stage: 'authorization', code: 'authorization-denied', source: 'transport', businessCommand: 'not-started', recovery: 'confirm-alternative' } };
const suRejected: Partial<OperationResult> = { status: 'failed', failureKind: 'authentication-failed', effects: 'none', exitCode: 1,
  stdoutTail: '', requiresUserAction: true,
  privilege: { method: 'su', stage: 'authentication', code: 'authentication-rejected', source: 'transport', businessCommand: 'not-started', recovery: 'user-action' } };

describe('operation-level privilege routing', () => {
  it('verifies UID and routes through sudo without requesting a prepared session or password', async () => {
    const f = fixture(); await f.run();
    expect(f.commands()).toEqual(['id -u', 'sudo -- stat /root/example']); expect(f.requestRoot).not.toHaveBeenCalled();
    const actual = f.runOperation.mock.calls[1]![1];
    expect(actual).toMatchObject({ privilege: 'root', scope: { runAs: 'root', loginAs: 'user' } });
    expect(operationFingerprint(actual)).not.toBe(operationFingerprint(f.operation));
    await f.run(); expect(f.commands()).toEqual(['id -u', 'sudo -- stat /root/example', 'sudo -- stat /root/example']);
  });
  it('uses a verified root identity directly even when the login name is different', async () => {
    const f = fixture('0'); await f.run();
    expect(f.commands()).toEqual(['id -u', 'stat /root/example']); expect(f.requestRoot).not.toHaveBeenCalled();
    expect(f.runOperation.mock.calls[1]![1].scope.runAs).toBe('root');
  });
  it('does not infer root solely from an account label or reuse an old terminal generation', async () => {
    const f = fixture(); f.host.username = 'root'; await f.run(); expect(f.commands()[1]).toContain('sudo');
    f.state.generation++; await f.run(); expect(f.commands().filter((command) => command === 'id -u')).toHaveLength(2);
  });
  it('offers only the stateless su route after transport-proven missing sudo and dispatches a separately reviewed wrap', async () => {
    const f = fixture(); f.state.failure = missing; const result = await f.run();
    expect(f.requestRoot).toHaveBeenCalledOnce(); expect(f.requestRoot.mock.calls[0]![5]).toBe('su');
    expect(f.requestRoot.mock.calls[0]![3]).toContain('不会自动安装');
    const wrapped = await f.wrap();
    expect(f.commands()).toEqual(['id -u', 'sudo -- stat /root/example', wrapped]);
    const fallback = f.runOperation.mock.calls[2]![1];
    expect(fallback.id).not.toBe(f.operation.id);
    expect(fallback).toMatchObject({ privilege: 'root' });
    expect(fallback.scope).toMatchObject({ runAs: 'root', loginAs: 'user' });
    expect(fallback.scope.sessionId).toBeUndefined();
    expect(operationFingerprint(fallback)).not.toBe(operationFingerprint(f.operation));
    expect(result.details).toMatchObject({ priorOperationId: 'business' });
    // The confirmed route is lease-keyed: a repeat dispatches the wrap without a second request.
    await f.run(); expect(f.requestRoot).toHaveBeenCalledOnce(); expect(f.commands().at(-1)).toBe(wrapped);
  });
  it('offers the stateless su route after a transport-proven sudoers authorization denial', async () => {
    const f = fixture(); f.state.failure = denied; const result = await f.run();
    expect(f.requestRoot).toHaveBeenCalledOnce();
    expect(f.requestRoot.mock.calls[0]![3]).toContain('sudo 授权阶段拒绝');
    expect(f.requestRoot.mock.calls[0]![5]).toBe('su');
    expect(f.commands()).toEqual(['id -u', 'sudo -- stat /root/example', await f.wrap()]);
    expect(result.details).toMatchObject({ priorOperationId: 'business' });
  });
  it('clears the confirmed su route only for transport-classified su outcomes, keeping it for unknown results', async () => {
    const rejected = fixture(); rejected.state.failure = missing;
    rejected.runOperation.mockImplementation(async (_gate, op) => {
      const command = op.kind === 'command' ? op.command : '';
      if (command.startsWith('su ')) return operationToolResult({ operationId: op.id, ...suRejected } as OperationResult, 'host', true);
      const result: OperationResult = { operationId: op.id, status: 'succeeded', exitCode: 0,
        stdoutTail: command === 'id -u' ? '1000\n' : 'observed\n', ...(command.startsWith('sudo') ? rejected.state.failure : {}) };
      return operationToolResult(result, rejected.host.label, true);
    });
    await rejected.run(); await rejected.run();
    expect(rejected.requestRoot).toHaveBeenCalledTimes(2);

    const unknown = fixture(); unknown.state.failure = missing;
    unknown.runOperation.mockImplementation(async (_gate, op) => {
      const command = op.kind === 'command' ? op.command : '';
      if (command.startsWith('su ')) return operationToolResult({ operationId: op.id, status: 'unknown', stdoutTail: '' } as OperationResult, 'host', true);
      const result: OperationResult = { operationId: op.id, status: 'succeeded', exitCode: 0,
        stdoutTail: command === 'id -u' ? '1000\n' : 'observed\n', ...(command.startsWith('sudo') ? unknown.state.failure : {}) };
      return operationToolResult(result, unknown.host.label, true);
    });
    await unknown.run(); await unknown.run();
    expect(unknown.requestRoot).toHaveBeenCalledOnce();
    expect(unknown.commands().filter((command) => command.startsWith('su -l -s /bin/sh root'))).toHaveLength(2);
  });
  it.each([
    { ...missing, status: 'unknown' }, { ...missing, effects: 'possible' },
    { ...missing, privilege: { ...missing.privilege!, source: 'output-inference' } },
    { ...missing, privilege: { ...missing.privilege!, businessCommand: 'unknown' } },
    ...['cancelled', 'authentication-rejected', 'timeout', 'attempts-exhausted'].map((code) => ({ ...missing, privilege: { ...missing.privilege!, code } }))
  ] as Partial<OperationResult>[])('never falls back for unproven or control-stop results %#', async (failure) => {
    const f = fixture(); f.state.failure = failure; await f.run();
    expect(f.requestRoot).not.toHaveBeenCalled(); expect(f.commands()).toHaveLength(2);
  });
  it('does not fall back after a denied operation', async () => {
    const f = fixture(); f.runOperation.mockImplementationOnce(async (_gate, op) => operationToolResult({ operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '1000' }, 'host'))
      .mockResolvedValueOnce({ isError: true, details: { code: 'human-denied' }, content: [] });
    await f.run(); expect(f.requestRoot).not.toHaveBeenCalled();
  });
  it('does not dispatch after su cancellation and never treats a dispatch exception as not-started', async () => {
    const f = fixture(); f.state.failure = missing;
    f.requestRoot.mockRejectedValueOnce(new PrivilegeError({ method: 'su', stage: 'authentication', code: 'cancelled',
      source: 'transport', businessCommand: 'not-started', recovery: 'user-action' }));
    expect((await f.run()).isError).toBe(true); expect(f.commands()).toHaveLength(2);
    f.runOperation.mockImplementation(async (_gate, op) => {
      const command = op.kind === 'command' ? op.command : '';
      if (command.startsWith('su ')) throw new Error('dispatch outcome unknown');
      const result: OperationResult = command === 'id -u'
        ? { operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '1000\n' }
        : { operationId: op.id, stdoutTail: '', ...f.state.failure, ...missing } as OperationResult;
      return operationToolResult(result, 'host', true);
    });
    await expect(f.run()).rejects.toThrow('dispatch outcome unknown');
  });
  it('refuses a su confirmation that returns a different method or identity', async () => {
    const f = fixture(); f.state.failure = missing;
    f.requestRoot.mockResolvedValueOnce({ method: 'sudo', runAs: 'root' });
    const result = await f.run();
    expect(result.isError).toBe(true); expect(f.commands()).toHaveLength(2);
  });
  it('binds the identity probe into the business delegation without a toolCallId', async () => {
    const f = fixture();
    f.operation.delegationId = 'deleg-alpha';
    f.operation.toolCallId = 'call-alpha';
    await f.run();
    const probe = f.runOperation.mock.calls[0]![1];
    expect(probe).toMatchObject({ command: 'id -u', probe: 'identity', delegationId: 'deleg-alpha' });
    expect(probe.toolCallId).toBeUndefined();
    const business = f.runOperation.mock.calls[1]![1];
    expect(business).toMatchObject({ command: 'sudo -- stat /root/example', delegationId: 'deleg-alpha', toolCallId: 'call-alpha' });
  });
  it('keeps the reviewed su dispatch inside the same delegation and tool call', async () => {
    const f = fixture();
    f.state.failure = missing;
    f.operation.delegationId = 'deleg-beta';
    f.operation.toolCallId = 'call-beta';
    await f.run();
    const suDispatch = f.runOperation.mock.calls[2]![1];
    expect(suDispatch).toMatchObject({ privilege: 'root', delegationId: 'deleg-beta', toolCallId: 'call-beta' });
  });
  it('refuses malformed identity observations, nested authentication and conflicting sessions', async () => {
    const f = fixture('0\nnot-proof'); await f.run(); expect(f.commands()).toEqual(['id -u']);
    for (const command of ['sudo stat /root/example', 'su root', 'id; whoami', 'cat /x | sh']) {
      const other = fixture(); other.operation.command = command; expect((await other.run()).isError).toBe(true); expect(other.commands()).toEqual([]);
    }
    const conflict = fixture(); conflict.operation.scope.sessionId = 'old'; expect((await conflict.run()).isError).toBe(true); expect(conflict.commands()).toEqual([]);
  });
});
