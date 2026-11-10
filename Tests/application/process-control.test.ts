import { expect, it, vi } from 'vitest';
import { operationFingerprint, processControlReviewCommand, validProcessControl, type ProposedOperation, type RawTerminal } from '@cloudhelm/core';
import { TerminalManager } from '../../packages/application/src/terminal-manager.js';
import { HostSerialExecutor } from '../../packages/application/src/host-serial-executor.js';

function fixture() {
  let started!: (event: { pid: number }) => void, exited!: (code: number | undefined) => void;
  const channel: RawTerminal = { onData() {}, onClose() {}, write: vi.fn(), close() {}, resize() {}, execute: vi.fn(async () => {}),
    onProcessStarted: (listener) => { started = listener; }, onExit: (listener) => { exited = listener; },
    interrupt: vi.fn(async () => 'sent' as const) };
  const terminal = new TerminalManager({ data() {}, state() {} }), id = terminal.open('host', channel, 'task');
  const target: ProposedOperation = { id: 'target', kind: 'command', command: 'sleep 10', scope: {
    taskId: 'task', hostId: 'host', terminalId: id, terminalGeneration: 1, runAs: 'user', cwd: '/',
    policyRevision: 1, allowedWorkingRoots: ['/'], protectedPaths: [], goal: 'Temporary job' } };
  const pending = terminal.execute(target, operationFingerprint(target)); started({ pid: 42 });
  const processControl = { kind: 'interrupt' as const, jobId: 'job', targetOperationId: target.id, pid: 42, processSequence: 1, connectionId: 'worker:1' };
  const control: ProposedOperation = { id: 'stop', kind: 'command', command: processControlReviewCommand(processControl), processControl, scope: { ...target.scope } };
  return { terminal, channel, pending, target, control, exit: () => exited(130) };
}
it('never executes control review text as shell and requires an exact grant for the existing operation', async () => {
  const f = fixture();
  await expect(f.terminal.execute(f.control, operationFingerprint(f.control))).rejects.toThrow('cannot be executed as a shell');
  expect(() => f.terminal.interruptOperation(f.control, operationFingerprint(f.control), () => false)).toThrow('authorization');
  expect(await f.terminal.interruptOperation(f.control, operationFingerprint(f.control), () => true)).toBe('sent');
  expect(f.channel.interrupt).toHaveBeenCalledExactlyOnceWith(42); expect(f.channel.write).not.toHaveBeenCalled();
  expect(f.channel.execute).toHaveBeenCalledTimes(1); expect(f.terminal.hasPending(f.control.scope.terminalId)).toBe(true);
  expect(() => f.terminal.interruptOperation(f.control, operationFingerprint(f.control), () => true)).toThrow('already requested');
  f.exit(); expect((await f.pending).exitCode).toBe(130);
});
it.each(['taskId', 'hostId', 'terminalGeneration'] as const)('rejects changed %s without signalling', async (field) => {
  const f = fixture(), altered = { ...f.control, scope: { ...f.control.scope, [field]: field === 'terminalGeneration' ? 2 : 'foreign' } };
  expect(() => f.terminal.interruptOperation(altered, operationFingerprint(altered), () => true)).toThrow('recipient');
  expect(f.channel.interrupt).not.toHaveBeenCalled(); f.exit(); await f.pending;
});
it('binds target and process into approval, and rejects a read-only-looking review command', async () => {
  const f = fixture(); if (f.control.kind !== 'command') throw new Error('fixture');
  const altered = { ...f.control, processControl: { ...f.control.processControl!, pid: 43 } };
  expect(operationFingerprint(altered)).not.toBe(operationFingerprint(f.control));
  expect(validProcessControl({ ...f.control, command: 'df -h' })).toBe(false);
  expect(validProcessControl({ ...f.control, executionMode: 'background' })).toBe(false);
  expect(() => f.terminal.interruptOperation(altered, operationFingerprint(altered), () => true)).toThrow();
  expect(f.channel.interrupt).not.toHaveBeenCalled(); f.exit(); await f.pending;
});
it('does not allow controlling one job past a different or unknown host write lock', async () => {
  const serial = new HostSerialExecutor({ execute: vi.fn() });
  expect(serial.canControlOperation('host', 'target')).toBe(true);
  serial.restore([{ id: 'other', hostId: 'host' }]);
  expect(serial.canControlOperation('host', 'target')).toBe(false);
  expect(serial.canControlOperation('host', 'other')).toBe(false);
});
