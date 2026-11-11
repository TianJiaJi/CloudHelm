import { describe, expect, it, vi } from 'vitest';
import type { ExecutionOptions, OperationResult, ProposedOperation } from '@cloudhelm/core';
import { HostSerialExecutor } from '@cloudhelm/application';

const operation = (hostId: string, id = `write-${hostId}`): Extract<ProposedOperation, { kind: 'command' }> => ({ id, kind: 'command', command: 'touch /tmp/synthetic-target', scope: {
  taskId: 'task', hostId, cwd: '/tmp', runAs: 'user', terminalId: `terminal-${hostId}`, terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: ['/tmp'], protectedPaths: [], goal: 'Synthetic risk-domain test'
} });
const success = (id: string): OperationResult => ({ operationId: id, status: 'succeeded', exitCode: 0, stdoutTail: '' });
const blocked = { status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation' };
function fixture() {
  const downstream = { execute: vi.fn(async (value: ProposedOperation) => success(value.id)) };
  const serial = new HostSerialExecutor(downstream);
  const bind = () => serial.bindRiskDomains([{ hostId: 'old', riskDomainId: 'root' }, { hostId: 'new', riskDomainId: 'root' }]);
  return { serial, downstream, bind };
}

describe('risk-domain queue and unresolved outcome isolation', () => {
  it.each([true, false])('keeps restored locks across revisions when binding comes first=%s', async (first) => {
    const f = fixture(); if (first) f.bind();
    f.serial.restore([{ id: 'unknown', hostId: 'old' }]); if (!first) f.bind();
    expect(await f.serial.execute(operation('new'), 'fp')).toMatchObject(blocked);
    expect(f.serial.hasPendingOrUnresolved('new')).toBe(true);
    expect(f.downstream.execute).not.toHaveBeenCalled();
    expect((await f.serial.execute(operation('unrelated'), 'fp')).status).toBe('succeeded');
    expect((await f.serial.execute({ id: 'query', kind: 'command', command: 'pwd', scope: operation('new').scope }, 'fp', undefined, { readOnly: true })).status).toBe('succeeded');
  });
  it('retains every original owner and refuses to reconcile or observe through a different revision', async () => {
    const f = fixture(); f.bind(); f.serial.restore([{ id: 'a', hostId: 'old' }, { id: 'b', hostId: 'new' }]);
    f.serial.reconcile('new', 'a'); f.serial.observe('new', success('a'));
    expect(await f.serial.execute(operation('new'), 'fp')).toMatchObject(blocked);
    f.serial.reconcile('old', 'a');
    expect(await f.serial.execute(operation('new'), 'fp')).toMatchObject(blocked);
    f.serial.observe('new', success('b'));
    expect((await f.serial.execute(operation('new'), 'fp')).status).toBe('succeeded');
  });
  it('does not accept an operation-supplied domain override', async () => {
    const f = fixture(); f.bind(); f.serial.restore([{ id: 'unknown', hostId: 'old' }]);
    const value = operation('new'); Object.assign(value.scope, { riskDomainId: 'forged-free-domain' });
    expect(await f.serial.execute(value, 'fp')).toMatchObject(blocked); expect(f.downstream.execute).not.toHaveBeenCalled();
  });
  it('serializes different revisions and rechecks queued authorization before dispatch', async () => {
    const f = fixture(); f.bind();
    let enter!: () => void, finish!: (value: OperationResult) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    f.downstream.execute.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; enter(); }));
    const first = f.serial.execute(operation('old'), 'first'); await entered;
    let authorized = true;
    const queued = f.serial.execute(operation('new'), 'second', undefined, { isAuthorized: () => authorized });
    expect(f.downstream.execute).toHaveBeenCalledOnce(); authorized = false; finish(success('write-old'));
    await first;
    expect(await queued).toMatchObject({ status: 'failed', effects: 'none', stdoutTail: expect.stringContaining('Authorization expired') });
    expect(f.downstream.execute).toHaveBeenCalledOnce();
    expect(f.serial.hasPendingOrUnresolved('new')).toBe(false);
  });
  it('blocks a queued revision when the original in-flight command ends unknown', async () => {
    const f = fixture(); f.bind();
    let enter!: () => void, finish!: (value: OperationResult) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    f.downstream.execute.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; enter(); }));
    const first = f.serial.execute(operation('old'), 'first'); await entered;
    const queued = f.serial.execute(operation('new'), 'second');
    finish({ operationId: 'write-old', status: 'unknown', effects: 'possible', stdoutTail: '' }); await first;
    expect(await queued).toMatchObject(blocked); expect(f.downstream.execute).toHaveBeenCalledOnce();
  });
  it('keeps a live completion attached to its original recipient and accepts a later exit', async () => {
    const f = fixture(); f.bind(); let exit!: (value: 'exited' | 'unknown') => void;
    const completion = new Promise<'exited' | 'unknown'>((resolve) => { exit = resolve; });
    f.downstream.execute.mockResolvedValueOnce({ operationId: 'write-old', status: 'handed-over', stdoutTail: '', remoteCompletion: completion });
    await f.serial.execute(operation('old'), 'fp');
    expect(f.serial.canReconcile('old', 'write-old')).toBe(false);
    expect(f.serial.canControlOperation('old', 'write-old')).toBe(true);
    expect(f.serial.canControlOperation('new', 'write-old')).toBe(false);
    expect(await f.serial.execute(operation('new'), 'fp')).toMatchObject(blocked);
    exit('exited'); await completion;
    expect((await f.serial.execute(operation('new'), 'fp')).status).toBe('succeeded');
  });
  it('publishes no partial bindings on a conflict and never moves an existing domain', () => {
    const f = fixture(); f.bind(); f.serial.restore([{ id: 'unknown', hostId: 'old' }]);
    expect(() => f.serial.bindRiskDomains([{ hostId: 'candidate', riskDomainId: 'root' }, { hostId: 'old', riskDomainId: 'other' }])).toThrow('cannot be replaced');
    expect(f.serial.hasPendingOrUnresolved('candidate')).toBe(false);
    expect(f.serial.hasPendingOrUnresolved('new')).toBe(true);
    expect(() => f.serial.bindRiskDomains([{ hostId: 'root', riskDomainId: 'other' }])).toThrow('stable root');
  });
  it('refuses reparenting after handover while the remote completion is still live, then retains an unknown result', async () => {
    const f = fixture(); let exit!: (value: 'exited' | 'unknown') => void;
    const completion = new Promise<'exited' | 'unknown'>((resolve) => { exit = resolve; });
    f.downstream.execute.mockResolvedValueOnce({ operationId: 'write-old', status: 'handed-over', stdoutTail: '', remoteCompletion: completion });
    await f.serial.execute(operation('old'), 'fp');
    expect(f.serial.canReconcile('old', 'write-old')).toBe(false);
    try { expect(() => f.bind()).toThrow('queued or running'); }
    finally { exit('unknown'); await completion; }
    f.bind();
    expect(await f.serial.execute(operation('new'), 'fp')).toMatchObject(blocked);
    expect(f.downstream.execute).toHaveBeenCalledOnce();
  });
  it('also protects the yielded background-start window before the downstream result returns', async () => {
    let enter!: () => void, finish!: (value: OperationResult) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const downstream = { execute: vi.fn((_value: ProposedOperation, _fingerprint: string, _signal?: AbortSignal, options?: ExecutionOptions) =>
      new Promise<OperationResult>((resolve) => { finish = resolve; options?.onProcessStarted?.({ pid: 123 }); enter(); })) };
    const serial = new HostSerialExecutor(downstream);
    const active = serial.execute({ ...operation('old'), executionMode: 'background' }, 'fp'); await entered;
    expect(serial.canControlOperation('old', 'write-old')).toBe(true); // Queue yielded; live completion still owns the risk.
    try { expect(() => serial.bindRiskDomains([{ hostId: 'old', riskDomainId: 'root' }])).toThrow('queued or running'); }
    finally { finish({ operationId: 'write-old', status: 'unknown', effects: 'possible', stdoutTail: '' }); await active; }
    serial.bindRiskDomains([{ hostId: 'old', riskDomainId: 'root' }, { hostId: 'new', riskDomainId: 'root' }]);
    expect(await serial.execute(operation('new'), 'fp')).toMatchObject(blocked); expect(downstream.execute).toHaveBeenCalledOnce();
  });
  it('refuses to change identity while a host already has running work', async () => {
    const f = fixture(); let enter!: () => void, finish!: (value: OperationResult) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    f.downstream.execute.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; enter(); }));
    const active = f.serial.execute(operation('old'), 'fp'); await entered;
    try { expect(() => f.bind()).toThrow('queued or running'); }
    finally { finish(success('write-old')); await active; }
  });
});
