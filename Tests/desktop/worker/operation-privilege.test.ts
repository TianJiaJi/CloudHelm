import { describe, expect, it, vi } from 'vitest';
import type { SafetyGate } from '@cloudhelm/application';
import { operationFingerprint, PrivilegeError, type OperationResult, type ProposedOperation } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { OperationPrivilege } from '../../../apps/desktop/src/worker/operation-privilege.js';
import { operationToolResult } from '../../../apps/desktop/src/worker/operation-feedback.js';
import type { RemoteToolDependencies } from '../../../apps/desktop/src/worker/remote-tool-dependencies.js';

function fixture(uid = '1000') {
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const state = { generation: 1, failure: undefined as Partial<OperationResult> | undefined };
  const gate = {} as SafetyGate;
  const scope: RemoteToolDependencies['scope'] = (_host, terminalId, cwd = '/') => ({ taskId: 'task', hostId: host.id, terminalId,
    terminalGeneration: state.generation, cwd, loginAs: host.username, runAs: terminalId === 'su-terminal' ? 'root' : host.username,
    ...(terminalId === 'su-terminal' ? { sessionId: 'su-session' } : {}),
    policyRevision: 1, protectedPaths: [], allowedWorkingRoots: ['/'], goal: 'Read authorized metadata as root' });
  const ensureTerminal = vi.fn(async (_hostId: string, session?: string) => session ? 'su-terminal' : 'ordinary');
  const requestRoot = vi.fn<NonNullable<RemoteToolDependencies['requestRoot']>>(async () => ({ sessionId: 'su-session', method: 'su', runAs: 'root' }));
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
  return { host, state, gate, scope, ensureTerminal, requestRoot, runOperation, routing, operation,
    run: () => routing.run(gate, host, operation), commands: () => runOperation.mock.calls.map(([, op]) => op.kind === 'command' ? op.command : '') };
}
const missing: Partial<OperationResult> = { status: 'failed', effects: 'none', exitCode: 127,
  privilege: { method: 'sudo', stage: 'preparation', code: 'sudo-unavailable', source: 'transport', businessCommand: 'not-started', recovery: 'confirm-alternative' } };

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
  it('offers only su after transport-proven missing sudo and reviews a new operation identity', async () => {
    const f = fixture(); f.state.failure = missing; const result = await f.run();
    expect(f.requestRoot).toHaveBeenCalledOnce(); expect(f.requestRoot.mock.calls[0]![5]).toBe('su');
    expect(f.requestRoot.mock.calls[0]![3]).toContain('不会自动安装');
    expect(f.commands()).toEqual(['id -u', 'sudo -- stat /root/example', 'stat /root/example']);
    const fallback = f.runOperation.mock.calls[2]![1];
    expect(fallback.id).not.toBe(f.operation.id); expect(fallback.scope).toMatchObject({ runAs: 'root', sessionId: 'su-session' });
    expect(result.details).toMatchObject({ priorOperationId: 'business' });
    await f.run(); expect(f.requestRoot).toHaveBeenCalledOnce(); expect(f.commands().at(-1)).toBe('stat /root/example');
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
      if (op.scope.sessionId) throw new Error('dispatch outcome unknown');
      return operationToolResult({ operationId: op.id, stdoutTail: '', ...missing } as OperationResult, 'host');
    });
    await expect(f.run()).rejects.toThrow('dispatch outcome unknown');
  });
  it('refuses malformed identity observations, nested authentication and conflicting sessions', async () => {
    const f = fixture('0\nnot-proof'); await f.run(); expect(f.commands()).toEqual(['id -u']);
    for (const command of ['sudo stat /root/example', 'su root', 'id; whoami', 'cat /x | sh']) {
      const other = fixture(); other.operation.command = command; expect((await other.run()).isError).toBe(true); expect(other.commands()).toEqual([]);
    }
    const conflict = fixture(); conflict.operation.scope.sessionId = 'old'; expect((await conflict.run()).isError).toBe(true); expect(conflict.commands()).toEqual([]);
  });
});
