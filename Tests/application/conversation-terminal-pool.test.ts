import { expect, it, vi } from 'vitest';
import { ConversationTerminalPool, HostSerialExecutor, TerminalManager } from '@cloudhelm/application';
import { operationFingerprint, type ExecutionTerminalBinding, type ProposedOperation, type RawTerminal } from '@cloudhelm/core';
class Channel implements RawTerminal {
  commands: string[] = []; writes: string[] = [];
  exited?: (code: number | undefined) => void; closed?: () => void;
  async execute(command: string) { this.commands.push(command); }
  complete() { this.exited?.(0); }
  write(data: string) { this.writes.push(data); }
  resize() {} onData() {}
  close = vi.fn(() => this.closed?.());
  onClose(listener: () => void) { this.closed = listener; }
  onExit(listener: (code: number | undefined) => void) { this.exited = listener; }
}
function fixture(maximum = 4) {
  const terminal = new TerminalManager({ data() {}, state() {} }), channels = new Map<string, Channel>();
  let binding: ExecutionTerminalBinding = { hostId: 'host', loginAs: 'fixture', connectionId: 'worker:1' };
  const open = vi.fn(async (hostId: string, taskId: string) => {
    const channel = new Channel(), id = terminal.open(hostId, channel, taskId, '/srv/app'); channels.set(id, channel); return id;
  });
  const pool = new ConversationTerminalPool('task', terminal, open, () => ({ ...binding }), maximum);
  return { terminal, channels, open, pool, change: (next: Partial<ExecutionTerminalBinding>) => { binding = { ...binding, ...next }; } };
}
const active = () => {};
function command(terminalId: string, generation: number, id = 'operation'): ProposedOperation {
  return { id, kind: 'command', command: 'mkdir -p /srv/app', scope: { hostId: 'host', taskId: 'task', runAs: 'fixture', loginAs: 'fixture',
    cwd: '/srv/app', terminalId, terminalGeneration: generation, policyRevision: 1, allowedWorkingRoots: ['/srv'], protectedPaths: [], goal: 'fixture' } };
}
it('coalesces initial allocation and reuses an idle terminal without changing ownership/generation', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.pool.acquire('host', active), f.pool.acquire('host', active)]);
  expect(a).toBe(b); expect(f.open).toHaveBeenCalledOnce();
  expect(await f.pool.acquire('host', active)).toBe(a); expect(f.terminal.currentGeneration(a)).toBe(1);
  expect(f.pool.snapshot()).toMatchObject([{ terminalId: a, connectionId: 'worker:1', loginAs: 'fixture', owner: 'agent', busy: false }]);
  f.pool.dispose();
});
it('allocates B while A runs, never injecting another command into A stdin, then reuses an idle matching terminal', async () => {
  const f = fixture(), a = await f.pool.acquire('host', active), operation = command(a, 1);
  const running = f.terminal.execute(operation, operationFingerprint(operation));
  const b = await f.pool.acquire('host', active);
  expect(b).not.toBe(a); expect(f.open).toHaveBeenCalledTimes(2); expect(f.channels.get(a)?.writes).toEqual([]);
  expect(f.pool.snapshot().find((item) => item.terminalId === a)?.busy).toBe(true);
  f.channels.get(a)!.complete(); await running;
  expect(await f.pool.acquire('host', active)).toBe(a); expect(f.open).toHaveBeenCalledTimes(2); f.pool.dispose();
});
it('never reclaims a human terminal and closes all conversation-owned generations on disposal', async () => {
  const f = fixture(), a = await f.pool.acquire('host', active); f.terminal.takeOver(a);
  const b = await f.pool.acquire('host', active);
  expect(a).not.toBe(b); expect(f.terminal.stateOf(a)).toBe('human'); expect(f.pool.owns(a)).toBe(true);
  f.pool.dispose(); expect(f.channels.get(a)!.close).toHaveBeenCalledOnce(); expect(f.channels.get(b)!.close).toHaveBeenCalledOnce();
  await expect(f.pool.acquire('host', active)).rejects.toThrow('closed');
});
it.each([{ loginAs: 'root' }, { connectionId: 'worker:2' }, { connectionId: 'new-worker:1' }])('does not alias changed identity/connection %j', async (change) => {
  const f = fixture(), a = await f.pool.acquire('host', active); f.change(change);
  const b = await f.pool.acquire('host', active);
  expect(b).not.toBe(a); expect(f.pool.snapshot()[0]?.connectionId).toBe('worker:1'); f.pool.dispose();
});
it('closes a late unused allocation after a control or connection change', async () => {
  const f = fixture(); let finish!: (id: string) => void;
  const id = f.terminal.open('host', new Channel(), 'task');
  f.open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  let current = true;
  const pending = f.pool.acquire('host', () => { if (!current) throw new Error('control changed'); });
  const failed = expect(pending).rejects.toThrow('control changed'); current = false; finish(id); await failed;
  expect(f.terminal.currentGeneration(id)).toBe(-1); f.pool.dispose();
});
it('preserves an explicit human takeover even when allocation returns after cancellation', async () => {
  const f = fixture(), channel = new Channel(); let finish!: (id: string) => void;
  const id = f.terminal.open('host', channel, 'task');
  f.open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  let current = true;
  const pending = f.pool.acquire('host', () => { if (!current) throw new Error('cancelled'); });
  const failed = expect(pending).rejects.toThrow('cancelled');
  f.terminal.takeOver(id); current = false; finish(id); await failed;
  expect(f.terminal.stateOf(id)).toBe('human'); expect(channel.close).not.toHaveBeenCalled(); f.pool.dispose();
});
it('counts human/suspended/opening resources against the capacity and never evicts them to bypass it', async () => {
  const f = fixture(2), a = await f.pool.acquire('host', active); f.terminal.takeOver(a);
  const b = await f.pool.acquire('host', active); f.terminal.suspend(b);
  await expect(f.pool.acquire('host', active)).rejects.toThrow('上限'); expect(f.open).toHaveBeenCalledTimes(2);
  f.terminal.close(a); expect(await f.pool.acquire('host', active)).not.toBe(b); f.pool.dispose();
});
it('reserves capacity for pending allocations instead of allowing an unbounded opening race', async () => {
  const f = fixture(2), finish: Array<() => void> = [];
  f.open.mockImplementation(async (hostId, taskId) => {
    const id = f.terminal.open(hostId, new Channel(), taskId);
    return new Promise((resolve) => { finish.push(() => resolve(id)); });
  });
  const first = f.pool.acquire('host', active), firstFailed = expect(first).rejects.toThrow('connection changed');
  f.change({ connectionId: 'worker:2' });
  const second = f.pool.acquire('host', active), secondFailed = expect(second).rejects.toThrow('connection changed');
  f.change({ connectionId: 'worker:3' });
  await expect(f.pool.acquire('host', active)).rejects.toThrow('上限');
  expect(f.open).toHaveBeenCalledTimes(2);
  finish.forEach((complete) => complete()); await Promise.all([firstFailed, secondFailed]); f.pool.dispose();
});
it('rejects but never closes an allocation owned by another conversation', async () => {
  const f = fixture(), channel = new Channel(), id = f.terminal.open('host', channel, 'other');
  f.open.mockResolvedValue(id);
  await expect(f.pool.acquire('host', active)).rejects.toThrow('foreign'); f.pool.dispose();
  expect(channel.close).not.toHaveBeenCalled(); expect(f.terminal.taskOf(id)).toBe('other'); f.terminal.close(id);
});
it('cannot bypass a host unresolved-operation lock by allocating another terminal', async () => {
  const f = fixture(), executor = new HostSerialExecutor(f.terminal);
  const a = await f.pool.acquire('host', active), first = command(a, 1, 'unknown-first');
  const running = executor.execute(first, operationFingerprint(first), undefined, { readOnly: false });
  await vi.waitFor(() => expect(f.terminal.hasPending(a)).toBe(true));
  f.terminal.suspend(a); expect((await running).status).toBe('unknown');
  const b = await f.pool.acquire('host', active), next = command(b, 1, 'fresh-terminal-write');
  expect(b).not.toBe(a);
  const blocked = await executor.execute(next, operationFingerprint(next), undefined, { readOnly: false });
  expect(blocked).toMatchObject({ failureKind: 'unresolved-prior-operation', effects: 'none' });
  expect(f.channels.get(b)?.commands).toEqual([]); expect(executor.canReconcile('host', first.id)).toBe(false);
  f.channels.get(a)!.complete(); f.pool.dispose();
});
