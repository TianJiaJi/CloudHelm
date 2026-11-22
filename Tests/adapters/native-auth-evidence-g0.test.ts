import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { Client } from 'ssh2';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { openNativeSshPty } from '../../packages/adapters/src/native-ssh-pty.js';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';
import { suPtyCommand } from '../../packages/core/src/su-plan.js';

class Channel extends EventEmitter {
  destroyed = false;
  readonly writes: string[] = [];
  write(value: Buffer): boolean { this.writes.push(value.toString('utf8')); return true; }
  close(): void { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
  setWindow(): void {}
}

/** Simulated business output crosses the real production PTY parser and terminal
 * classifier. This demonstrates source ambiguity, NOT real PAM or SSH behavior. */
async function businessDiagnostic(method: 'sudo' | 'su') {
  const channel = new Channel();
  const client = { exec: (_command: string, _options: unknown, callback: (error: Error | null, stream: Channel) => void) => callback(null, channel) };
  let nonce = '';
  const transport = { connectionGeneration: () => 1,
    runNativePty: (_host: string, input: Parameters<typeof openNativeSshPty>[1], current: () => boolean,
      hooks: Parameters<typeof openNativeSshPty>[3], signal?: AbortSignal) => {
      nonce = input.nonce;
      return openNativeSshPty(client as unknown as Pick<Client, 'exec'>, input, current, hooks, signal);
    }
  } as unknown as CommandTransport;
  const terminal = new SshCommandTerminal(transport, 'synthetic-host');
  const failures = vi.fn(), output = vi.fn();
  let challenge = '';
  terminal.onExecutionFailure(failures); terminal.onData(output);
  terminal.onAuthentication((event) => { if (event.prompt) challenge = event.id; });
  const wrapped = method === 'su' ? suPtyCommand(await new BashAnalyzer().analyze('id'), '/') : 'sudo id';
  if (!wrapped) throw new Error('G0 fixture failed to construct the literal su action');
  const executing = terminal.execute(wrapped, '/', () => true,
    { executionChannel: 'native-pty', ...(method === 'su' ? { sudoAuthorization: true } : {}) });
  try {
    await vi.waitFor(() => expect(nonce).toMatch(/^[a-f0-9]{32}$/u));
    channel.emit('data', Buffer.from(method === 'sudo'
      ? `\rcloudhelm:${nonce} password: ` : `cloudhelm:${nonce}Password: `));
    expect(challenge).not.toBe('');
    expect(terminal.answerAuthentication(challenge, 'g0-synthetic-secret')).toBe(true);
    // The fixture explicitly models a payload which HAS started and then prints a diagnostic.
    channel.emit('data', Buffer.from('\nG0 business is running\n'));
    channel.emit('data', Buffer.from(method === 'sudo'
      ? 'sudo: user is not allowed to execute this command\n' : 'su: Authentication failure\n'));
    channel.emit('exit', 1); channel.emit('close');
    await executing;
    return { failures: failures.mock.calls.map(([failure]) => failure), output: output.mock.calls.map(([text]) => text).join(''), writes: channel.writes };
  } finally { terminal.close(); await executing.catch(() => {}); }
}

it.each(['sudo', 'su'] as const)('G0-A01 regression: %s business-like diagnostics remain unconfirmed observations', async (method) => {
  const observed = await businessDiagnostic(method);
  expect(observed.output).toContain('G0 business is running');
  expect(observed.output).not.toContain('g0-synthetic-secret');
  expect(observed.writes).toEqual(['g0-synthetic-secret\n']);
  expect(observed.failures).toContainEqual(expect.objectContaining({ effects: 'possible',
    privilege: expect.objectContaining({ source: 'output-inference', businessCommand: 'unknown', recovery: 'verify' }) }));
});

it.each(['sudo', 'su'] as const)('G0-A02: %s text alone must not prove a payload never started', async (method) => {
  const observed = await businessDiagnostic(method);
  expect(observed.failures).not.toContainEqual(expect.objectContaining({ effects: 'none',
    privilege: expect.objectContaining({ businessCommand: 'not-started' }) }));
});
