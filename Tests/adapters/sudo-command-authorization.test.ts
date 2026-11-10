import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';
import { canOfferSuFallback, type OperationResult } from '@cloudhelm/core';

class Channel extends EventEmitter {
  stderr = new EventEmitter(); writes: Array<Record<string, unknown>> = [];
  write(value: string): void { this.writes.push(JSON.parse(value)); }
  end(): void {} close(): void { this.emit('close'); }
  event(value: unknown): void { this.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
}
async function fixture() {
  const channel = new Channel(), state = { current: true };
  const terminal = new SshCommandTerminal({ connectionGeneration: () => 1, prepareCommandProgram: async () => '/tmp/fixed.py',
    removeCommandProgram: async () => {}, openPipe: async () => channel } as unknown as CommandTransport, 'host');
  const failed = vi.fn(), exited = vi.fn(), auth = vi.fn();
  terminal.onExecutionFailure(failed); terminal.onExit(exited); terminal.onAuthentication(auth);
  await terminal.execute('sudo -- stat /root/example', '/', () => state.current, { sudoAuthorization: true });
  return { channel, state, terminal, failed, exited, auth };
}
it('uses an internal command-scoped authorization phase and checks the lease before dispatch', async () => {
  const f = await fixture();
  expect(f.channel.writes).toEqual([expect.objectContaining({ argv: ['sudo', '--', 'stat', '/root/example'], sudoAuthorization: true })]);
  expect(f.auth).not.toHaveBeenCalled(); f.channel.event({ type: 'sudo-authorized' });
  expect(f.channel.writes[1]).toEqual({ type: 'continue-authorized' });
  f.channel.event({ type: 'exit', code: 0 }); await vi.waitFor(() => expect(f.exited).toHaveBeenCalledWith(0));
  f.terminal.close();
  const canceled = await fixture(); canceled.state.current = false; canceled.channel.event({ type: 'sudo-authorized' });
  expect(canceled.channel.writes).toHaveLength(1); expect(canceled.exited).toHaveBeenCalledWith(undefined); canceled.terminal.close();
});
it('does not turn a listpw failure into an authentication request or a fallback assertion', async () => {
  const f = await fixture();
  f.channel.event({ type: 'sudo-policy-unconfirmed' });
  expect(f.auth).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  expect(f.channel.writes[1]).toEqual({ type: 'continue-authorized' });
  f.channel.event({ type: 'data', data: 'sudo: not in the sudoers file' });
  f.channel.event({ type: 'exit', code: 1 });
  await vi.waitFor(() => expect(f.exited).toHaveBeenCalledWith(1));
  expect(f.failed).not.toHaveBeenCalled(); f.terminal.close();
  const revoked = await fixture(); revoked.state.current = false;
  revoked.channel.event({ type: 'sudo-policy-unconfirmed' });
  expect(revoked.channel.writes).toHaveLength(1); expect(revoked.exited).toHaveBeenCalledWith(undefined);
  revoked.terminal.close();
});
it('distinguishes structured pre-payload refusal from arbitrary payload output', async () => {
  const f = await fixture(); f.channel.event({ type: 'sudo-authorization-failed', code: 'authorization-denied' });
  await vi.waitFor(() => expect(f.exited).toHaveBeenCalledWith(1));
  const result: OperationResult = { operationId: 'op', status: 'failed', exitCode: 1, stdoutTail: '', ...f.failed.mock.calls[0]![0] };
  expect(canOfferSuFallback(result)).toBe(true); expect(f.channel.writes).toHaveLength(1); f.terminal.close();
  const payload = await fixture(); payload.channel.event({ type: 'sudo-authorized' });
  payload.channel.event({ type: 'data', data: 'sudo: not in the sudoers file\n' }); payload.channel.event({ type: 'exit', code: 1 });
  await vi.waitFor(() => expect(payload.exited).toHaveBeenCalledWith(1)); expect(payload.failed).not.toHaveBeenCalled(); payload.terminal.close();
});
it('does not accept a late not-started assertion or duplicate continuation after authorization', async () => {
  for (const event of [{ type: 'sudo-authorization-failed', code: 'authorization-denied' }, { type: 'sudo-authorized' }]) {
    const f = await fixture(); f.channel.event({ type: 'sudo-authorized' }); f.channel.event(event);
    expect(f.failed).not.toHaveBeenCalled(); expect(f.exited).toHaveBeenCalledWith(undefined);
    expect(f.channel.writes).toHaveLength(2); f.terminal.close();
  }
});
it('never offers identity fallback after authentication rejection', async () => {
  const f = await fixture(); f.channel.event({ type: 'sudo-authorization-failed', code: 'authentication-rejected' });
  await vi.waitFor(() => expect(f.exited).toHaveBeenCalledWith(1));
  expect(canOfferSuFallback({ operationId: 'op', status: 'failed', exitCode: 1, stdoutTail: '', ...f.failed.mock.calls[0]![0] })).toBe(false);
  f.terminal.close();
});
