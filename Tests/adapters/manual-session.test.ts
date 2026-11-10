import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { Client, ClientChannel } from 'ssh2';
import { manualSessionStartup, startManualKeepalive } from '../../packages/adapters/src/manual-session.js';
import { integratedShellCommand, openIntegratedShell, ShellMarkerParser } from '../../packages/adapters/src/shell-integration.js';

class Channel extends EventEmitter {
  resume = vi.fn(); end = vi.fn(); close = vi.fn(() => this.emit('close')); stderr = { resume: vi.fn() };
  write = vi.fn();
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.useRealTimers(); });
function keepalive() {
  vi.useFakeTimers();
  const channel = new Channel(), exec = vi.fn((_command: string, callback: (error: Error | null, channel: ClientChannel) => void) => callback(null, channel as unknown as ClientChannel));
  const assert = vi.fn(), canRun = vi.fn(() => true), notice = vi.fn();
  const close = startManualKeepalive({ exec } as unknown as Client, { initialization: 'must-not-repeat-startup', keepaliveCommand: 'printf heartbeat', keepaliveIntervalMs: 10000 }, assert, canRun, notice);
  cleanups.push(close); return { channel, exec, assert, canRun, notice, close };
}
it('does not run a custom keepalive immediately or inject it into terminal stdin', () => {
  const f = keepalive(); expect(f.exec).not.toHaveBeenCalled(); vi.advanceTimersByTime(10000);
  expect(f.exec).toHaveBeenCalledOnce(); expect(f.exec.mock.calls[0]![0]).toContain('printf heartbeat');
  expect(f.exec.mock.calls[0]![0]).not.toContain('must-not-repeat-startup');
  expect(f.channel.write).not.toHaveBeenCalled(); expect(f.channel.end).toHaveBeenCalledOnce();
});
it('does not overlap calls, and schedules again only after a known successful exit', () => {
  const f = keepalive(); vi.advanceTimersByTime(10000); vi.advanceTimersByTime(10000);
  expect(f.exec).toHaveBeenCalledOnce(); f.channel.emit('exit', 0); f.channel.emit('close');
  vi.advanceTimersByTime(9999); expect(f.exec).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1); expect(f.exec).toHaveBeenCalledTimes(2);
});
it.each(['nonzero', 'unknown', 'error', 'timeout'] as const)('stops without retry after %s and never exposes raw transport diagnostics', (failure) => {
  const f = keepalive(); vi.advanceTimersByTime(10000);
  if (failure === 'nonzero') { f.channel.emit('exit', 1); f.channel.emit('close'); }
  if (failure === 'unknown') f.channel.emit('close');
  if (failure === 'error') f.channel.emit('error', new Error('password=private-value'));
  if (failure === 'timeout') vi.advanceTimersByTime(15000);
  vi.advanceTimersByTime(100000); expect(f.exec).toHaveBeenCalledOnce(); expect(f.notice).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.notice.mock.calls)).not.toContain('private-value');
});
it('pauses while the backend reports active or unresolved Agent work', () => {
  const f = keepalive(); f.canRun.mockReturnValue(false); vi.advanceTimersByTime(30000); expect(f.exec).not.toHaveBeenCalled();
  f.canRun.mockReturnValue(true); vi.advanceTimersByTime(10000); expect(f.exec).toHaveBeenCalledOnce();
});
it('rechecks authorization immediately before dispatch and stops on revocation', () => {
  const f = keepalive(); f.assert.mockImplementation(() => { throw new Error('revoked'); });
  vi.advanceTimersByTime(30000); expect(f.exec).not.toHaveBeenCalled(); expect(f.notice).toHaveBeenCalledOnce();
});
it('stops its timer when the parent manual terminal closes', () => {
  const f = keepalive(); f.close(); vi.advanceTimersByTime(30000); expect(f.exec).not.toHaveBeenCalled();
});
it('quotes environment and directory as data and keeps commands in the explicit startup segment', () => {
  const script = manualSessionStartup({ directory: '~/a b', environment: [{ name: 'LABEL', value: "a'b; $(false)" }], initialization: 'printf ready' });
  expect(script).toContain('cd -- "$HOME"/\'a b\''); expect(script).toContain("export LABEL='a'\"'\"'b; $(false)'");
  expect(script).toContain("eval 'printf ready'");
  expect(integratedShellCommand('fixture')).not.toContain('printf ready'); expect(integratedShellCommand('fixture', script)).toContain('printf ready');
});
it('rejects invalid/reserved environment names before generating a shell command', () => {
  for (const name of ['A; rm', 'CLOUDHELM_SHELL_DIR', 'A\nB']) expect(() => manualSessionStartup({ environment: [{ name, value: 'x' }] })).toThrow();
});
it('passes the chosen TERM to SSH and does not dispatch after grant revocation', async () => {
  const exec = vi.fn((_command, _options, callback) => callback(null, new Channel()));
  const assertAuthorized = vi.fn();
  await openIntegratedShell({ exec } as unknown as Client, 120, 40, { settings: { version: 1, terminal: { term: 'vt100' } }, assertAuthorized });
  expect(exec.mock.calls[0]![1]).toMatchObject({ pty: { term: 'vt100', cols: 120, rows: 40 } });
  assertAuthorized.mockImplementation(() => { throw new Error('revoked'); });
  await expect(openIntegratedShell({ exec } as unknown as Client, 80, 24, { settings: { version: 1 }, assertAuthorized })).rejects.toThrow('revoked');
  expect(exec).toHaveBeenCalledOnce();
});
it('projects valid cwd markers separately, across splits, without interpreting prompt-looking text', () => {
  const marker = `\x1b]777;cloudhelm;fixture;cwd;${Buffer.from('/srv/目录').toString('hex')}\x07`;
  for (let split = 0; split <= marker.length; split++) {
    const cwd = vi.fn(), command = vi.fn(), output = vi.fn(), parser = new ShellMarkerParser('fixture', output, command, cwd);
    parser.push(marker.slice(0, split)); parser.push(marker.slice(split)); expect(cwd).toHaveBeenCalledExactlyOnceWith('/srv/目录'); expect(command).not.toHaveBeenCalled();
  }
  const cwd = vi.fn(), parser = new ShellMarkerParser('fixture', () => {}, () => {}, cwd);
  for (const path of ['relative', '/line\nbreak', '/nul\0byte']) parser.push(`\x1b]777;cloudhelm;fixture;cwd;${Buffer.from(path).toString('hex')}\x07`);
  parser.push('\x1b]777;cloudhelm;other;cwd;2f737276\x07user@server:/tmp $ '); expect(cwd).not.toHaveBeenCalled();
});
