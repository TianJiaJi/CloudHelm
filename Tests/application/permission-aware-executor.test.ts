import { describe, expect, it, vi } from 'vitest';
import type { CommandAnalysis, ProposedOperation } from '@cloudhelm/core';
import { PermissionAwareExecutor } from '../../packages/application/src/permission-aware-executor.js';
import { HostSerialExecutor } from '../../packages/application/src/host-serial-executor.js';
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
  it.each(['docker images', 'docker image ls', 'docker container ls'])('shares the known default-daemon failure with %s', async (command) => {
    const execute = vi.fn(async (op: ProposedOperation) => ({ operationId: op.id, status: 'failed' as const, exitCode: 1,
      effects: 'possible' as const, stdoutTail: 'Docker daemon socket: permission denied' }));
    const executor = new PermissionAwareExecutor({ execute }, analyzer);
    const first = await executor.execute(operation('docker ps'), 'hash');
    expect(first.effects).toBe('possible'); // Only the gate can attest that the first operation was effect-free.
    const blocked = await executor.execute(operation(command), 'hash');
    expect(blocked).toMatchObject({ status: 'failed', failureKind: 'permission-denied', effects: 'none' });
    expect(execute).toHaveBeenCalledOnce();
    const root = operation(command); root.scope.runAs = 'root';
    await executor.execute(root, 'root-review');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not reuse the observation for endpoint changes or a mutating image subcommand', async () => {
    const execute = vi.fn(async (op: ProposedOperation) => ({ operationId: op.id, status: 'failed' as const,
      stdoutTail: 'Docker daemon socket: permission denied' }));
    const executor = new PermissionAwareExecutor({ execute }, analyzer);
    for (const command of ['docker images', 'docker image rm alpine', 'docker --context other image ls',
      'docker -Htcp://other image ls', 'docker images --host=tcp://other']) await executor.execute(operation(command), 'hash');
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
