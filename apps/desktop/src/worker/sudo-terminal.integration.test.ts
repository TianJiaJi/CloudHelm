import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SshCommandTerminal, type SshTransport } from '@cloudhelm/adapters';
import { InteractionCoordinator, TerminalManager } from '@cloudhelm/application';
import { operationFingerprint, type InputRequest, type ProposedOperation } from '@cloudhelm/core';
import { OperationInputBridge } from './operation-input-bridge.js';

// Real PTYs and helper processes; only SSH transport and the privileged sudo binary are replaced.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(password: boolean) {
  const directory = await mkdtemp('/tmp/cloudhelm-sudo-');
  const children: ChildProcessWithoutNullStreams[] = [];
  cleanups.push(async () => {
    for (const child of children) child.kill();
    await rm(directory, { recursive: true, force: true });
  });
  const sudo = path.join(directory, 'sudo');
  const helper = path.join(directory, 'process.py');
  await writeFile(path.join(directory, 'test'), 'Hello world\n');
  await writeFile(sudo, `#!/usr/bin/env python3
import os, subprocess, sys
if sys.argv[1] != '-A': sys.exit(99)
if ${password ? 'True' : 'False'}:
    answer = subprocess.run([os.environ['SUDO_ASKPASS']], stdout=subprocess.PIPE)
    if answer.returncode or answer.stdout != b'synthetic-password\\n':
        print('sudo: authentication failed', file=sys.stderr)
        sys.exit(1)
os.execvp(sys.argv[2], sys.argv[2:])
`, { mode: 0o700 });
  const launches: string[][] = [];
  const ssh = {
    connectionGeneration: () => 1,
    prepareCommandProgram: async (_host: string, source: string) => {
      await writeFile(helper, source, { mode: 0o700 }); return helper;
    },
    openPipe: async () => {
      const child = spawn('python3', [helper, '--serve']); children.push(child);
      const channel = new EventEmitter() as EventEmitter & {
        stderr: typeof child.stderr; write(data: string): void; end(): void; close(): void;
      };
      channel.stderr = child.stderr;
      child.stdout.on('data', (data) => channel.emit('data', data));
      child.on('close', () => channel.emit('close'));
      child.on('error', (error) => channel.emit('error', error));
      channel.write = (data) => {
        const message = JSON.parse(data);
        if (message.argv) {
          launches.push([...message.argv]);
          if (message.argv[0] === 'sudo') message.argv[0] = sudo;
        }
        child.stdin.write(JSON.stringify(message) + '\n');
      };
      channel.end = () => child.stdin.end();
      channel.close = () => child.kill();
      return channel;
    }
  } as unknown as SshTransport;
  const visible: string[] = [];
  const terminal = new TerminalManager({ data: (_id, data) => visible.push(data), state() {} });
  const terminalId = terminal.open('host', new SshCommandTerminal(ssh, 'host'), 'task', directory);
  const requests: InputRequest[] = [];
  const coordinator = new InteractionCoordinator(terminal, { opened: (request) => requests.push(request), closed() {} });
  const bridge = new OperationInputBridge(terminal, ssh, coordinator);
  const execute = (command: string) => {
    const operation: ProposedOperation = { id: 'operation', kind: 'command', command, scope: {
      taskId: 'task', hostId: 'host', cwd: directory, runAs: 'test', terminalId, terminalGeneration: 1,
      policyRevision: 1, allowedWorkingRoots: [directory], protectedPaths: [], goal: '验证 sudo 命令和终端显示'
    } };
    return bridge.execute(operation, operationFingerprint(operation));
  };
  return { execute, visible, requests, coordinator, launches, directory };
}

describe.skipIf(process.platform === 'win32')('sudo command chain through worker, terminal and real helper', () => {
  it.each([false, true])('runs the reported ls/echo/cat chain (password required: %s)', async (password) => {
    const f = await fixture(password);
    const command = `sudo ls -la ${f.directory}; echo '--- content ---'; sudo cat ${f.directory}/test`;
    const running = f.execute(command);
    if (password) {
      for (let index = 0; index < 2; index++) {
        await vi.waitFor(() => expect(f.requests).toHaveLength(index + 1), { timeout: 10000 });
        expect(await f.coordinator.answer(f.requests[index]!.id, 'synthetic-password')).toBe(true);
      }
    }
    const result = await running;
    expect(result).toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(result.stdoutTail).toContain('--- content ---\r\nHello world\r\n');
    expect(f.launches.map((argv) => argv[0])).toEqual(['sudo', 'echo', 'sudo']);
    expect(f.requests).toHaveLength(password ? 2 : 0);
    expect(f.visible.join('')).toContain(command);
    expect(f.visible.join('')).toContain('@');
    expect(f.visible.join('')).not.toContain('synthetic-password');
    expect(result.stdoutTail).not.toContain(command);
  }, 20000);

  it('canceling a real askpass challenge prevents dispatch of the next command', async () => {
    const f = await fixture(true);
    const running = f.execute('sudo id; sudo echo must-not-run');
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 10000 });
    f.coordinator.cancel(f.requests[0]!.id);
    const result = await running;
    await result.remoteCompletion;
    expect(result.status).toBe('unknown');
    expect(f.launches).toEqual([['sudo', 'id']]);
  }, 15000);
});
