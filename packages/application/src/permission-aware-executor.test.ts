import { describe, expect, it, vi } from 'vitest';
import type { CommandAnalysis, ProposedOperation } from '@cloudhelm/core';
import { PermissionAwareExecutor } from './permission-aware-executor.js';
import { HostSerialExecutor } from './host-serial-executor.js';
function operation(command: string, id = command): ProposedOperation {
  return { id, kind: 'command', command, scope: { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal',
    terminalGeneration: 1, policyRevision: 1, protectedPaths: [], allowedWorkingRoots: ['/'], goal: 'deploy' } };
}
const analyzer = { analyze: async (raw: string): Promise<CommandAnalysis> => {
  const [name, ...args] = raw.split(' '); const call = { name: name!, args, dynamic: false, redirects: false };
  return { raw, calls: [call], steps: [{ call, condition: 'always' }], redirectTargets: [], hasError: false,
    hasCompound: false, hasExpansion: false, hasRedirection: false, hasPipeline: false };
} };
describe('shared Docker permission prerequisite', () => {
  it('suppresses redundant queued daemon queries, but never silently inserts sudo', async () => {
    const execute = vi.fn(async (op: ProposedOperation) => ({ operationId: op.id, status: 'failed' as const, exitCode: 1,
      stdoutTail: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock' }));
    const queue = new HostSerialExecutor(new PermissionAwareExecutor({ execute }, analyzer));
    const results = await Promise.all(['docker version', 'docker network ls', 'docker ps -a'].map((command) => queue.execute(operation(command), 'hash')));
    expect(execute).toHaveBeenCalledTimes(1); expect(results[1]).toMatchObject({ effects: 'none', failureKind: 'permission-denied' });
    expect(results[2]?.stdoutTail).toContain('Not executed');
    await queue.execute(operation('sudo docker ps'), 'new-review'); expect(execute).toHaveBeenCalledTimes(2);
  });
  it('does not assume all Docker endpoints or local subcommands share daemon permission', async () => {
    const execute = vi.fn(async (op: ProposedOperation) => ({ operationId: op.id, status: 'failed' as const, stdoutTail: 'Docker daemon socket: permission denied' }));
    const executor = new PermissionAwareExecutor({ execute }, analyzer);
    for (const command of ['docker ps', 'docker compose version', 'docker --context other ps', 'docker -H tcp://other ps', 'docker compose build']) await executor.execute(operation(command), 'hash');
    expect(execute).toHaveBeenCalledTimes(5);
  });
  it('expires observations and isolates identity, terminal and connection changes', async () => {
    let now = 0;
    const execute = vi.fn(async (op: ProposedOperation) => ({ operationId: op.id, status: 'failed' as const, stdoutTail: 'Docker daemon socket: permission denied' }));
    const executor = new PermissionAwareExecutor({ execute }, analyzer, () => now);
    await executor.execute(operation('docker ps'), 'hash');
    const changed = operation('docker ps'); changed.scope.terminalGeneration++; await executor.execute(changed, 'hash');
    now = 60_001; await executor.execute(operation('docker ps'), 'hash'); expect(execute).toHaveBeenCalledTimes(3);
  });
});
