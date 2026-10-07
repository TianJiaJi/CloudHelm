import { InteractionCoordinator, type InteractionSink, type TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, SshTransport } from '@cloudhelm/adapters';
import { isSudo, operationFingerprint, type ExecutionOptions, type InputRequest, type OperationExecutor, type OperationResult, type ProposedOperation } from '@cloudhelm/core';
import { aptHasNoRemovals, inputPlan } from './operation-input-plan.js';

/** The reviewed command remains unchanged. Only the process transport owns sudo's credential channel. */
export class OperationInputBridge implements OperationExecutor {
  private readonly analyzer = new BashAnalyzer();

  constructor(private readonly terminal: TerminalManager, private readonly ssh: SshTransport,
    private readonly interactions: InteractionCoordinator,
    private readonly onAutoConfirmation?: (taskId: string, hostId: string) => void) {}

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    if (operation.kind !== 'command') return this.terminal.execute(operation, fingerprint, signal, options);
    const { hostId, terminalId, taskId, terminalGeneration } = operation.scope;
    const connectionGeneration = this.ssh.connectionGeneration(hostId);
    const current = () => !signal?.aborted && operationFingerprint(operation) === fingerprint
      && options?.isAuthorized?.() !== false && this.terminal.hostOf(terminalId) === hostId
      && this.terminal.taskOf(terminalId) === taskId && this.terminal.isAgentOwner(terminalId)
      && this.terminal.currentGeneration(terminalId) === terminalGeneration
      && this.ssh.connectionGeneration(hostId) === connectionGeneration;
    if (!current()) throw new Error('Operation authorization expired');
    const analysis = await this.analyzer.analyze(operation.command);
    if (analysis.hasError) throw new Error('Cannot authenticate an incomplete command parse');
    if (!current()) throw new Error('Operation authorization expired during analysis');
    const plan = inputPlan(analysis);
    if (!plan) {
      if (analysis.calls.some((call) => /(?:^|\/)(?:sudo|su)$/u.test(call.name))) {
        this.terminal.suspend(terminalId);
        return { operationId: operation.id, status: 'failed', requiresUserAction: true, failureKind: 'unsupported', effects: 'none',
          stdoutTail: 'This authentication form requires manual takeover; no command was sent. Do not wrap it or switch tools to bypass this result.' };
      }
      return this.terminal.execute(operation, fingerprint, signal, options);
    }
    let active = true;
    let waiting: string | undefined;
    let attempts = 0;
    const maxAttempts = 3 * Math.max(1, analysis.steps?.filter(({ call }) => isSudo(call)).length ?? 0);
    const cancel = () => {
      if (!active) return;
      if (waiting) this.terminal.answerAuthentication(terminalId, operation.id, waiting, null);
      waiting = undefined;
      this.interactions.cancelForTerminal(terminalId);
      if (this.terminal.isAgentOwner(terminalId)) this.terminal.suspend(terminalId);
    };
    const unsubscribeAuth = this.terminal.subscribeAuthentication(terminalId, (challenge) => {
      if (!active) return;
      if (!challenge.prompt) {
        if (waiting === challenge.id) { waiting = undefined; this.interactions.cancelForTerminal(terminalId); }
        return;
      }
      if (!plan.auth || !current() || waiting || ++attempts > maxAttempts) {
        this.terminal.answerAuthentication(terminalId, operation.id, challenge.id, null);
        cancel(); return;
      }
      waiting = challenge.id;
      const sink: InteractionSink = {
        isWaiting: (request) => active && current() && waiting === challenge.id
          && request.operationId === operation.id && request.connectionGeneration === connectionGeneration,
        deliver: async (request, answer) => {
          if (!sink.isWaiting(request)) return false;
          const sent = this.terminal.answerAuthentication(terminalId, operation.id, challenge.id, answer);
          waiting = undefined;
          if (!sent) cancel();
          return sent;
        }
      };
      const goal = operation.scope.goal.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 160);
      const details: Omit<InputRequest, 'id' | 'expiresAt'> = {
        taskId, operationId: operation.id, hostId, terminalId, terminalGeneration, connectionGeneration,
        kind: 'secret', recipient: 'sudo', prompt: 'sudo 身份验证',
        reason: `为了完成“${goal}”，本次已审核的 sudo 命令需要密码。密码仅交给 sudo 的独立认证进程，不进入命令输入、AI 上下文或日志。`
      };
      void this.interactions.request(details, sink).then((status) => {
        if (status !== 'submitted' && active) cancel();
      }).catch(cancel);
    });
    let output = '';
    let confirmed = false;
    const unsubscribeOutput = this.terminal.subscribeData(terminalId, (data) => {
      output = (output + data).slice(-8192);
      if (!active || !plan.aptInstall || confirmed || !current()
        || !/Do you want to continue\?\s*\[Y\/n\]\s*$/u.test(output)) return;
      if (!aptHasNoRemovals(output)) {
        this.terminal.confirmInput(terminalId, operation.id, 'n\n'); cancel(); return;
      }
      confirmed = this.terminal.confirmInput(terminalId, operation.id, 'y\n');
      if (confirmed) this.onAutoConfirmation?.(taskId, hostId);
    });
    const leaseCheck = setInterval(() => { if (!current()) cancel(); }, 100);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await this.terminal.execute(operation, fingerprint, signal, options);
      // sudo itself reports authentication/policy rejection. Ordinary payload errors remain failures.
      if (plan.auth && result.status === 'failed' && /(?:^|[\r\n])sudo:\s/iu.test(result.stdoutTail)) {
        result.requiresUserAction = true;
        result.failureKind = 'authentication-failed';
        result.effects = 'possible';
        this.terminal.suspend(terminalId);
      }
      return result;
    } finally {
      active = false;
      if (waiting) this.terminal.answerAuthentication(terminalId, operation.id, waiting, null);
      clearInterval(leaseCheck);
      signal?.removeEventListener('abort', cancel);
      unsubscribeAuth(); unsubscribeOutput();
      this.interactions.cancelForTerminal(terminalId);
    }
  }
}
