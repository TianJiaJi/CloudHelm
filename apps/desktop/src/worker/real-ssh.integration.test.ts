import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HostKeyError, SshCommandTerminal, SshTransport, type SshHost } from '@cloudhelm/adapters';
import { TerminalManager } from '@cloudhelm/application';
import { operationFingerprint, type ProposedOperation } from '@cloudhelm/core';

const run = process.env.CLOUDHELM_TEST_SSH_KEY ? it : it.skip;

describe('real SSH direct process terminal', () => {
  run('executes ordinary commands and hands over a live process without a generated shell wrapper', async () => {
    const ssh = new SshTransport();
    const root = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'cloudhelm-pty-'));
    const host: SshHost = {
      id: 'host', label: 'Local SSH test', address: '127.0.0.1',
      port: Number(process.env.CLOUDHELM_TEST_SSH_PORT ?? '22388'),
      username: process.env.CLOUDHELM_TEST_SSH_USER ?? process.env.USER ?? '',
      auth: 'private-key', privateKeyPath: process.env.CLOUDHELM_TEST_SSH_KEY
    };
    try {
      try { await ssh.connect(host, {}); }
      catch (error) {
        if (!(error instanceof HostKeyError)) throw error;
        host.fingerprint = error.fingerprint;
      }
      await ssh.connect(host, {});
      const observed: string[] = [];
      const terminal = new TerminalManager({ data: (_id, data) => observed.push(data), state() {} });
      const channel = new SshCommandTerminal(ssh, host.id);
      const terminalId = terminal.open(host.id, channel, 'task', root);
      const scope = {
        taskId: 'task', hostId: host.id, cwd: root, runAs: host.username, terminalId,
        terminalGeneration: terminal.currentGeneration(terminalId), policyRevision: 1,
        allowedWorkingRoots: [root], protectedPaths: [], goal: 'Test direct execution'
      };
      const first: ProposedOperation = { id: 'first', kind: 'command', command: 'printf cloudhelm-command-ok', scope };
      expect(await terminal.execute(first, operationFingerprint(first))).toMatchObject({ status: 'succeeded', stdoutTail: 'cloudhelm-command-ok' });
      expect(observed.join('')).not.toMatch(/env -i|CLOUDHELM_DONE|SUDO_ASKPASS/u);
      const pending: ProposedOperation = { id: 'pending', kind: 'command',
        command: `python3 -c 'print("continue?", flush=True); print("answer=" + input())'`, scope };
      const running = terminal.execute(pending, operationFingerprint(pending));
      await vi.waitFor(() => expect(observed.join('')).toContain('continue?\r\n'), { timeout: 5000 });
      terminal.input(terminalId, 'y\n', true);
      const handedOver = await running;
      expect(handedOver.status).toBe('handed-over');
      expect(await handedOver.remoteCompletion).toBe('exited');
      expect(observed.join('')).toContain('answer=y');
      terminal.close(terminalId);
    } finally {
      ssh.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
