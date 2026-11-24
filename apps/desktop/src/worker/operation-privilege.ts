import { randomUUID } from 'node:crypto';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { canOfferSuFallback, PrivilegeError, privilegeGuidance, suPtyCommand, sudoContextCommand, type CommandAnalysis,
  type OperationScope, type ProposedOperation } from '@cloudhelm/core';
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
  /** Lease-keyed marker that the user confirmed the stateless su route. */
  private readonly alternatives = new Map<string, 'su'>();
  constructor(private readonly deps: RemoteToolDependencies) {}

  async run(gate: SafetyGate, host: RuntimeHost, operation: Command, signal?: AbortSignal): Promise<Feedback> {
    const denied = (code: string, message: string) => blockedOperationFeedback(operation.id, code, message);
    if (operation.scope.sessionId) return denied('conflicting-identity', 'Use either privilege=root or an explicit legacy session, never both. Nothing executed.');
    let analysis: CommandAnalysis;
    let sudo: string;
    try {
      analysis = await this.analyzer.analyze(operation.command);
      if (analysis.calls.some((call) => /(?:^|\/)(?:sudo|su)$/u.test(call.name)))
        return denied('nested-privilege', 'With privilege=root, submit the actual command without sudo/su. Backend selects the identity before review. Nothing executed.');
      sudo = sudoContextCommand(analysis);
    } catch { return denied('unsupported-root-command', 'Root routing accepts one literal action without expansion, pipes or redirection. Split independent actions; no business command executed.'); }
    signal?.throwIfAborted();
    const scope = this.deps.scope(host, operation.scope.terminalId, operation.scope.cwd);
    const key = this.lease(scope);
    if (this.alternatives.get(key) === 'su') return this.dispatchSu(gate, host, operation, analysis, key, signal);
    let uid = this.identities.get(key);
    if (uid === undefined) {
      const identity = await this.deps.runOperation(gate, { id: randomUUID(), kind: 'command', command: 'id -u', probe: 'identity',
        delegationId: operation.delegationId,
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
    if (uid !== 0 && this.deps.selectElevation) {
      let route: Awaited<ReturnType<NonNullable<RemoteToolDependencies['selectElevation']>>>;
      try {
        route = await this.deps.selectElevation(host, { operationId: operation.id, command: operation.command, cwd: scope.cwd }, signal);
        this.assertLease(host, operation.scope.terminalId, key, signal);
      } catch {
        return denied('elevation-selection-invalidated', 'Elevation choice was interrupted or its scope changed. No privileged command dispatched.');
      }
      if (route === 'su') return this.dispatchSu(gate, host, operation, analysis, key, signal, operation.id);
      if (route !== 'sudo') return denied('elevation-selection-cancelled', 'No elevation route was selected. No privileged command dispatched.');
    }
    const actual: Command = { ...operation, privilege: 'root', command: uid === 0 ? operation.command : sudo,
      scope: { ...this.deps.scope(host, operation.scope.terminalId, operation.scope.cwd), runAs: 'root' } };
    this.assertLease(host, operation.scope.terminalId, key, signal);
    const first = await this.deps.runOperation(gate, actual, signal, host.label);
    if (this.deps.selectElevation || uid === 0 || !first.result || !canOfferSuFallback(first.result) || !this.deps.requestRoot) return first;
    this.assertLease(host, operation.scope.terminalId, key, signal);
    try {
      const context = await this.deps.requestRoot(host, operation.command, operation.scope.cwd,
        first.result.privilege?.code === 'sudo-unavailable'
          ? 'sudo 未安装或不可用，业务操作尚未启动。推荐配置 sudo，但本次可通过 su 继续；不会自动安装软件或修改 sudoers。'
          : 'sudo 授权阶段拒绝且业务操作未启动。可明确选择本次通过 su 执行；原 sudo 拒绝仍保留，操作会按 root 身份重新审核。', signal, 'su');
      this.assertLease(host, operation.scope.terminalId, key, signal);
      if (!context || typeof context !== 'object' || !('method' in context) || context.method !== 'su'
        || !('runAs' in context) || context.runAs !== 'root')
        return denied('identity-unconfirmed', 'No confirmed su identity was returned. No fallback business command executed.');
    } catch (error) {
      return denied('privilege-unavailable', error instanceof PrivilegeError ? privilegeGuidance(error.feedback)
        : 'Privilege setup stopped or the authorization lease changed. No fallback business command was dispatched; do not switch identity or replay automatically.');
    }
    this.alternatives.set(key, 'su');
    // Do not catch a dispatch failure as a setup failure: payload effects may be unknown.
    const next = await this.dispatchSu(gate, host, operation, analysis, key, signal);
    return { ...next, details: { ...(next.details && typeof next.details === 'object' ? next.details : {}),
      priorOperationId: first.result.operationId }, content: [{ type: 'text',
        text: `Prior attempt ${first.result.operationId}: business action did not start. A separately reviewed su operation follows.\n${next.content.map((part) => part.text).join('\n')}` }] };
  }

  /** Stateless per-operation su route: the reviewed business command is wrapped for
   * the credential-bound native PTY and dispatched as its own reviewed operation.
   * No session, no persistent credential, one password window per dispatch. */
  private async dispatchSu(gate: SafetyGate, host: RuntimeHost, operation: Command, analysis: CommandAnalysis,
    key: string, signal?: AbortSignal, operationId: string = randomUUID()): Promise<Feedback> {
    const denied = (code: string, message: string) => blockedOperationFeedback(operation.id, code, message);
    signal?.throwIfAborted();
    const wrapped = suPtyCommand(analysis, operation.scope.cwd);
    if (!wrapped) return denied('unsupported-root-command', 'Root routing accepts one literal action without expansion, pipes or redirection. Split independent actions; no business command executed.');
    this.assertLease(host, operation.scope.terminalId, key, signal);
    const feedback = await this.deps.runOperation(gate, { id: operationId, kind: 'command', command: wrapped, privilege: 'root',
      delegationId: operation.delegationId, toolCallId: operation.toolCallId,
      scope: { ...this.deps.scope(host, operation.scope.terminalId, operation.scope.cwd), runAs: 'root' } }, signal, host.label);
    // A transport-classified su outcome (authentication rejected or route unsupported)
    // kills the confirmed alternative; an unclassified result keeps it: su is
    // stateless, so an unknown or business-level failure never invalidates the route.
    if (feedback.result?.privilege?.method === 'su') this.alternatives.delete(key);
    return feedback;
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
