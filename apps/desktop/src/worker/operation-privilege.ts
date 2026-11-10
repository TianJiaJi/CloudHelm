import { randomUUID } from 'node:crypto';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { canOfferSuFallback, PrivilegeError, privilegeGuidance, sudoContextCommand, type OperationScope,
  type ProposedOperation } from '@cloudhelm/core';
import type { SafetyGate } from '@cloudhelm/application';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { blockedOperationFeedback } from './operation-feedback.js';

type Command = Extract<ProposedOperation, { kind: 'command' }>;
type Feedback = Awaited<ReturnType<RemoteToolDependencies['runOperation']>>;

/** One operation-level route. Every probe and business action goes through the same gate.
 * Cached facts are bound to a backend terminal lease, never a model-supplied session id. */
export class OperationPrivilege {
  private readonly analyzer = new BashAnalyzer();
  private readonly identities = new Map<string, number>();
  private readonly alternatives = new Map<string, string>();
  constructor(private readonly deps: RemoteToolDependencies) {}

  async run(gate: SafetyGate, host: RuntimeHost, operation: Command, signal?: AbortSignal): Promise<Feedback> {
    const denied = (code: string, message: string) => blockedOperationFeedback(operation.id, code, message);
    if (operation.scope.sessionId) return denied('conflicting-identity', 'Use either privilege=root or an explicit legacy session, never both. Nothing executed.');
    let sudo: string;
    try {
      const analysis = await this.analyzer.analyze(operation.command);
      if (analysis.calls.some((call) => /(?:^|\/)(?:sudo|su)$/u.test(call.name)))
        return denied('nested-privilege', 'With privilege=root, submit the actual command without sudo/su. Backend selects the identity before review. Nothing executed.');
      sudo = sudoContextCommand(analysis);
    } catch { return denied('unsupported-root-command', 'Root routing accepts one literal action without expansion, pipes or redirection. Split independent actions; no business command executed.'); }
    signal?.throwIfAborted();
    const scope = this.deps.scope(host, operation.scope.terminalId, operation.scope.cwd);
    const key = this.lease(scope);
    const session = this.alternatives.get(key);
    if (session) return this.inSession(gate, host, operation, session, signal);
    let uid = this.identities.get(key);
    if (uid === undefined) {
      const identity = await this.deps.runOperation(gate, { id: randomUUID(), kind: 'command', command: 'id -u',
        scope: this.deps.scope(host, operation.scope.terminalId, '/') }, signal, host.label);
      const observed = identity.result;
      if (identity.isError || observed?.status !== 'succeeded' || observed.exitCode !== 0) return identity;
      if (observed.outputCapture?.truncated === true || !/^\d+\s*$/u.test(observed.stdoutTail))
        return denied('identity-unconfirmed', 'The identity observation is incomplete or invalid. No business command executed.');
      uid = Number(observed.stdoutTail.trim());
      if (!Number.isSafeInteger(uid)) return denied('identity-unconfirmed', 'Current identity could not be established; no business command executed.');
      this.assertLease(host, operation.scope.terminalId, key, signal);
      this.identities.set(key, uid);
    }
    const actual: Command = { ...operation, privilege: 'root', command: uid === 0 ? operation.command : sudo,
      scope: { ...this.deps.scope(host, operation.scope.terminalId, operation.scope.cwd), runAs: 'root' } };
    this.assertLease(host, operation.scope.terminalId, key, signal);
    const first = await this.deps.runOperation(gate, actual, signal, host.label);
    if (uid === 0 || !first.result || !canOfferSuFallback(first.result) || !this.deps.requestRoot) return first;
    this.assertLease(host, operation.scope.terminalId, key, signal);
    let fallbackSession: string;
    try {
      const context = await this.deps.requestRoot(host, operation.command, operation.scope.cwd,
        first.result.privilege?.code === 'sudo-unavailable'
          ? 'sudo 未安装或不可用，业务操作尚未启动。推荐配置 sudo，但本次可通过 su 继续；不会自动安装软件或修改 sudoers。'
          : 'sudo 授权阶段拒绝且业务操作未启动。可明确选择本次通过 su 执行；原 sudo 拒绝仍保留，操作会按 root 身份重新审核。', signal, 'su');
      this.assertLease(host, operation.scope.terminalId, key, signal);
      if (!context || typeof context !== 'object' || !('sessionId' in context) || typeof context.sessionId !== 'string'
        || !('method' in context) || context.method !== 'su' || !('runAs' in context) || context.runAs !== 'root')
        return denied('identity-unconfirmed', 'No confirmed su identity was returned. No fallback business command executed.');
      fallbackSession = context.sessionId;
    } catch (error) {
      return denied('privilege-unavailable', error instanceof PrivilegeError ? privilegeGuidance(error.feedback)
        : 'Privilege setup stopped or the authorization lease changed. No fallback business command was dispatched; do not switch identity or replay automatically.');
    }
    this.alternatives.set(key, fallbackSession);
    // Do not catch a dispatch failure as a setup failure: payload effects may be unknown.
    const next = await this.inSession(gate, host, { ...operation, id: randomUUID() }, fallbackSession, signal);
    return { ...next, details: { ...(next.details && typeof next.details === 'object' ? next.details : {}),
      priorOperationId: first.result.operationId }, content: [{ type: 'text',
        text: `Prior attempt ${first.result.operationId}: business action did not start. A separately reviewed su operation follows.\n${next.content.map((part) => part.text).join('\n')}` }] };
  }

  private async inSession(gate: SafetyGate, host: RuntimeHost, operation: Command, sessionId: string, signal?: AbortSignal): Promise<Feedback> {
    signal?.throwIfAborted();
    const terminal = await this.deps.ensureTerminal(host.id, sessionId);
    const scope = this.deps.scope(host, terminal, operation.scope.cwd);
    if (scope.sessionId !== sessionId || scope.runAs !== 'root')
      return blockedOperationFeedback(operation.id, 'identity-expired', 'The confirmed root identity expired. No business command executed.');
    return this.deps.runOperation(gate, { ...operation, privilege: 'root', scope }, signal, host.label);
  }

  private lease(scope: OperationScope): string {
    return JSON.stringify([scope.taskId, scope.hostId, scope.terminalId, scope.terminalGeneration, scope.connectionGeneration,
      scope.loginAs, scope.policyRevision, scope.conversationRevision, scope.reviewerRevision]);
  }
  private assertLease(host: RuntimeHost, terminal: string, expected: string, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.lease(this.deps.scope(host, terminal, '/')) !== expected) throw new Error('Operation identity lease changed');
  }
}
