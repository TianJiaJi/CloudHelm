import type { CommandAnalysis, CommandAnalyzer, ExecutionOptions, OperationExecutor, OperationResult, ProposedOperation } from '@cloudhelm/core';

function defaultDockerDaemon(analysis: CommandAnalysis): boolean {
  if (analysis.hasError || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection || analysis.steps?.length !== 1) return false;
  const call = analysis.steps[0]!.call;
  if (!['docker', '/usr/bin/docker', '/usr/local/bin/docker'].includes(call.name)) return false;
  if (call.args.some((arg) => ['-H', '--host', '--context', '-c'].includes(arg) || /^(?:--host|--context)=/u.test(arg))) return false;
  const [verb, action] = call.args;
  return ['ps', 'version', 'info', 'images', 'inspect', 'stats', 'logs'].includes(verb ?? '')
    || (verb === 'network' && ['ls', 'inspect'].includes(action ?? ''))
    || (verb === 'compose' && ['ps', 'logs'].includes(action ?? ''));
}

/** Runs INSIDE the host queue: later queued calls see earlier permission failures. */
export class PermissionAwareExecutor implements OperationExecutor {
  private readonly denied = new Map<string, { operationId: string; expires: number }>();
  constructor(private readonly downstream: OperationExecutor, private readonly analyzer: CommandAnalyzer,
    private readonly now: () => number = Date.now) {}
  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    if (operation.kind !== 'command') return this.downstream.execute(operation, fingerprint, signal, options);
    const analysis = await this.analyzer.analyze(operation.command);
    const docker = defaultDockerDaemon(analysis);
    const scope = operation.scope;
    const key = JSON.stringify([scope.taskId, scope.hostId, scope.terminalId, scope.terminalGeneration, scope.connectionGeneration, scope.runAs]);
    for (const [id, entry] of this.denied) if (entry.expires <= this.now()) this.denied.delete(id);
    const previous = this.denied.get(key);
    if (docker && previous) return { operationId: operation.id, status: 'failed', failureKind: 'permission-denied', effects: 'none',
      stdoutTail: `Not executed: operation ${previous.operationId} already established permission denial for the default Docker socket with this identity. Submit the necessary bounded sudo command through normal review, or use an already confirmed root session. Do not repeat unprivileged Docker queries. This does not override any approval denial or authentication stop.` };
    const result = await this.downstream.execute(operation, fingerprint, signal, options);
    if (docker && result.status === 'failed' && /permission denied/iu.test(result.stdoutTail)
      && /(?:Docker daemon socket|\/var\/run\/docker\.sock)/iu.test(result.stdoutTail)) {
      this.denied.set(key, { operationId: operation.id, expires: this.now() + 60_000 });
      return { ...result, failureKind: result.failureKind ?? 'permission-denied' };
    }
    return result;
  }
}
