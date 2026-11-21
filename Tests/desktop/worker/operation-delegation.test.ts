import { expect, it } from 'vitest';
import type { SafetyGate } from '@cloudhelm/application';
import type { ProposedOperation } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { createRemoteTools } from '../../../apps/desktop/src/worker/remote-tools.js';
import { operationToolResult } from '../../../apps/desktop/src/worker/operation-feedback.js';
import type { RemoteToolDependencies } from '../../../apps/desktop/src/worker/remote-tool-dependencies.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function harness() {
  const dispatched: ProposedOperation[] = [];
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user',
    auth: 'agent', status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
  const deps = {
    hosts: [host],
    localFiles: { hasScopes: true, read: async () => ({ data: Buffer.from('payload'), scope: { path: 'C:\\selected' } }) },
    ensureTerminal: async () => 'terminal-1',
    scope: (_host: RuntimeHost, terminalId: string, cwd?: string) => ({ taskId: 'task', hostId: 'host', cwd: cwd ?? '/',
      runAs: 'user', loginAs: 'user', terminalId, terminalGeneration: 1, policyRevision: 1,
      allowedWorkingRoots: [], protectedPaths: [], goal: '委派打点' }),
    runOperation: async (_gate: SafetyGate, operation: ProposedOperation) => {
      dispatched.push(structuredClone(operation));
      return operationToolResult({ operationId: operation.id, status: 'succeeded', exitCode: 0, stdoutTail: 'ok' }, 'fixture', true);
    }
  } as unknown as RemoteToolDependencies;
  return { dispatched, tools: createRemoteTools(deps, {} as SafetyGate) };
}

it('mints one delegation per run_remote call and traces it back to the model tool call', async () => {
  const f = harness();
  const tool = f.tools.find((item) => item.name === 'run_remote')!;
  await tool.execute('call-one', { hostId: 'host', command: 'echo one' } as never);
  await tool.execute('call-two', { hostId: 'host', command: 'echo two' } as never);
  expect(f.dispatched.map((operation) => operation.kind === 'command' ? operation.command : operation.kind))
    .toEqual(['echo one', 'echo two']);
  const [first, second] = f.dispatched as Array<Extract<ProposedOperation, { kind: 'command' }>>;
  expect(first!.toolCallId).toBe('call-one');
  expect(second!.toolCallId).toBe('call-two');
  expect(first!.delegationId).toMatch(UUID);
  expect(second!.delegationId).toMatch(UUID);
  expect(first!.delegationId).not.toBe(second!.delegationId);
});

it('stamps the structural file operations with their own delegations and tool call ids', async () => {
  const f = harness();
  await f.tools.find((item) => item.name === 'write_remote_file')!
    .execute('write-call', { hostId: 'host', path: '/srv/a', content: 'text', createOnly: true } as never);
  await f.tools.find((item) => item.name === 'delete_remote_file')!
    .execute('delete-call', { hostId: 'host', path: '/srv/a' } as never);
  await f.tools.find((item) => item.name === 'upload_selected_file')!
    .execute('upload-call', { hostId: 'host', localPath: 'C:\\selected\\a.bin', remotePath: '/srv/a.bin' } as never);
  const [write, remove, upload] = f.dispatched;
  expect(write).toMatchObject({ kind: 'write-file', path: '/srv/a', toolCallId: 'write-call' });
  expect(remove).toMatchObject({ kind: 'delete-path', path: '/srv/a', toolCallId: 'delete-call' });
  expect(upload).toMatchObject({ kind: 'upload', remotePath: '/srv/a.bin', toolCallId: 'upload-call' });
  for (const operation of f.dispatched) {
    expect(operation.delegationId).toMatch(UUID);
  }
  expect(new Set(f.dispatched.map((operation) => operation.delegationId)).size).toBe(3);
});
