import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConversationTerminalPool, TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { serviceQuery, type OperationExecutor, type OperationResult, type OperationScope, type ProposedOperation, type RawTerminal } from '@cloudhelm/core';
import type { ResumeReason, TaskStatus, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { createBackgroundOperations } from '../../../apps/desktop/src/worker/background-operations.js';
import { ExecutionScheduler } from '../../../apps/desktop/src/worker/execution-scheduler.js';
import { RecoveryManager } from '../../../apps/desktop/src/worker/recovery-manager.js';
import { TaskProgress } from '../../../apps/desktop/src/worker/task-progress.js';
import { TaskRequestBudget } from '../../../apps/desktop/src/worker/task-request-budget.js';
import { TaskReviewLifetime } from '../../../apps/desktop/src/worker/task-review-lifetime.js';
import { VerificationRoundTracker } from '../../../apps/desktop/src/worker/verification-round.js';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

const UNIT = 'nginx.service';
const RESTART = `systemctl restart -- ${UNIT}`;
const SECRET = 'sk-aaaaaaaaaaaaaaaaaaaa01';
const PROPS_READY = ['Id=nginx.service', 'LoadState=loaded', 'ActiveState=active', 'SubState=running', 'Result=success',
  'ExecMainCode=0', 'ExecMainStatus=0', 'InvocationID=run-4f0c9d2e', 'Job=', 'CanStart=yes', 'NeedDaemonReload=no'].join('\n');
const PROPS_PROBE = ['Id=nginx.service', 'LoadState=loaded', 'ActiveState=active', 'SubState=running', 'Result=success',
  'ExecMainCode=0', 'ExecMainStatus=0', `InvocationID=${SECRET}`, 'Job=', 'CanStart=yes', 'NeedDaemonReload=no'].join('\n');
const UNKNOWN_PAUSE = '远端操作结果未知，已暂停。请先核验，避免重复执行。';

type SignalEvent = Parameters<TaskSignals['event']>[0];
type OperationSignalEvent = Extract<SignalEvent, { type: 'operation' }>;

const operationEvents = (events: SignalEvent[]): OperationSignalEvent[] =>
  events.filter((event): event is OperationSignalEvent => event.type === 'operation');

const commandOf = (operation: ProposedOperation): string =>
  operation.kind === 'command' ? operation.command : operation.kind;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class ScriptedTerminal implements RawTerminal {
  readonly commands: string[] = [];
  private dataListener?: (data: string) => void;
  private exitListener?: (code: number | undefined) => void;
  private closeListener?: () => void;
  constructor(private readonly script: (command: string) => { output: string; exit: number } | undefined) {}
  async execute(command: string): Promise<void> {
    this.commands.push(command);
    const reply = this.script(command);
    if (reply) queueMicrotask(() => {
      this.dataListener?.(reply.output);
      this.exitListener?.(reply.exit);
    });
  }
  onData(listener: (data: string) => void): void { this.dataListener = listener; }
  onExit(listener: (code: number | undefined) => void): void { this.exitListener = listener; }
  onClose(listener: () => void): void { this.closeListener = listener; }
  close(): void { this.closeListener?.(); }
  write(): void {}
  resize(): void {}
}

class IdleTerminal implements RawTerminal {
  async execute(): Promise<void> {}
  onExit(): void {}
  onData(): void {}
  onClose(): void {}
  write(): void {}
  resize(): void {}
  close(): void {}
}

class RecordingProgress extends TaskProgress {
  readonly observations: string[] = [];
  override observe(kind: string, identity: string): void {
    this.observations.push(`${kind}:${identity}`);
    super.observe(kind, identity);
  }
}

class ProbeRefusingAnalyzer extends BashAnalyzer {
  override async analyze(command: string) {
    if (command.startsWith('systemctl show --no-pager')) throw new Error('analysis refused');
    return super.analyze(command);
  }
}

describe('unknown 自动探测（全管线）', () => {
  it('probes an unknown service restart through the real pipeline, stays unpaused, and the model reconciles with the probe evidence', async () => {
    let requests = 0;
    let restartId: string | undefined;
    let probeId: string | undefined;
    const fixture = await openAiFixture(async () => {
      requests++;
      if (requests === 1) return { calls: [{ id: `svc-${requests}`, name: 'manage_service',
        arguments: { hostId: 'host', unit: UNIT, action: 'restart' } }] };
      if (requests === 2) {
        if (!restartId || !probeId) throw new Error('操作 ID 尚未捕获');
        return { calls: [{ id: `rec-${requests}`, name: 'record_reconciled_result',
          arguments: { operationId: restartId, evidenceOperationIds: [probeId], outcome: 'succeeded',
            explanation: '重启结果未知；只读探针显示单元已加载且无运行中的任务，确认重启已生效。' } }] };
      }
      return { text: '已按探针证据核验重启结果。' };
    });
    const host: RuntimeHost = { id: 'host', label: '测试主机', address: '192.0.2.1', port: 22, username: 'ubuntu',
      auth: 'agent', status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
    const task: TaskView = { id: 'unknown-probe-pipeline', goal: '重启 nginx 服务', hostIds: [host.id], localScopes: [],
      provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
    const events: Parameters<TaskSignals['event']>[0][] = [];
    const terminal = new TerminalManager({ data() {}, state() {}, completed: (result) => runner.recordRemoteResult(result) });
    const sessions: Array<{ id: string; channel: ScriptedTerminal }> = [];
    const openTerminal = vi.fn(async () => {
      const probeChannel = sessions.length === 1;
      const channel = new ScriptedTerminal((command) => command === serviceQuery(UNIT)
        ? { output: probeChannel ? PROPS_PROBE : PROPS_READY, exit: 0 } : undefined);
      const id = terminal.open(host.id, channel, task.id, '/home/ubuntu');
      sessions.push({ id, channel });
      return id;
    });
    const executor: OperationExecutor = {
      execute: (operation, fingerprint, signal, options) => terminal.execute(operation, fingerprint, signal, options),
      reconcile: () => true
    };
    const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
      [], terminal, executor, openTerminal,
      { clearCredentials: () => {}, event: (event) => {
        events.push(structuredClone(event));
        if (event.type === 'operation') {
          if (event.value.internal === 'recovery-probe') probeId = event.value.id;
          if (event.value.preview.includes('systemctl restart')) restartId = event.value.id;
        }
      }, requestApproval: async () => true, cancelApproval() {} });
    try {
      const running = runner.start();
      await vi.waitFor(() => expect(sessions[0]?.channel.commands).toHaveLength(2), { timeout: 15_000 });
      sessions[0]!.channel.close();
      await running;
      expect(requests).toBe(3);
      expect(events.filter((event) => event.type === 'task-status' && (event.status === 'paused' || event.resumeReason === 'verify'))).toHaveLength(0);
      expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered' });
      expect(typeof probeId).toBe('string');
      expect(typeof restartId).toBe('string');
      const probeView = operationEvents(events).filter((event) => event.value.id === probeId).at(-1)?.value;
      expect(probeView).toMatchObject({ internal: 'recovery-probe', status: 'succeeded', readOnly: true, recoveryProbeTarget: restartId });
      expect(probeView?.toolCallId).toBeUndefined();
      const restartViews = operationEvents(events).filter((event) => event.value.id === restartId).map((event) => event.value);
      expect(restartViews.some((view) => view.status === 'unknown')).toBe(true);
      const restartView = restartViews.at(-1);
      expect(restartView).toMatchObject({ status: 'succeeded', readOnly: false,
        reconciliation: { kind: 'evidence', outcome: 'succeeded', evidenceOperationIds: [probeId] } });
      expect(typeof restartView?.reconciledAt).toBe('number');
      // 探针不是重放：新终端上第一条命令是白名单只读查询，绝不是原命令。
      expect(sessions[1]?.channel.commands).toEqual([serviceQuery(UNIT)]);
      expect(sessions[1]?.channel.commands[0]).not.toBe(RESTART);
      const secondRequest = JSON.stringify(fixture.requests[1]?.messages);
      expect(secondRequest).toContain('Recovery probe (read-only systemd query)');
      expect(secondRequest).toContain('InvocationID=[REDACTED KEY]');
      expect(secondRequest).not.toContain(SECRET);
      expect(openTerminal).toHaveBeenCalledTimes(2);
    } finally {
      runner.pause();
      await fixture.close();
    }
  }, 30_000);
});

interface DirectOptions {
  analyzer?: BashAnalyzer;
  ensureTerminal?: (hostId: string) => Promise<string>;
}

function directHarness(options: DirectOptions = {}) {
  const task: TaskView = { id: 'unknown-probe-direct', goal: '核验 unknown 结果', hostIds: ['host1', 'host2'], localScopes: [],
    provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const host1: RuntimeHost = { id: 'host1', label: '主机一', address: '192.0.2.11', port: 22, username: 'ubuntu', auth: 'agent',
    status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
  const host2: RuntimeHost = { id: 'host2', label: '主机二', address: '192.0.2.12', port: 22, username: 'ubuntu', auth: 'agent',
    status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const blockCalls: Array<{ reason: string; human?: boolean; resumeReason?: ResumeReason }> = [];
  const statusCalls: Array<{ status: TaskStatus; summary?: string; resumeReason?: ResumeReason }> = [];
  const executorCalls: ProposedOperation[] = [];
  const scripts = new Map<string, (operation: ProposedOperation) => OperationResult | Promise<OperationResult>>();
  const signals: TaskSignals = {
    event: (event) => events.push(structuredClone(event)),
    requestApproval: async () => true,
    cancelApproval() {}
  };
  let status: TaskStatus = 'running';
  let remoteBlocked: string | undefined;
  let controlVersion = 0;
  const setStatus = (next: TaskStatus, summary?: string, resumeReason?: ResumeReason): void => {
    status = next;
    statusCalls.push({ status: next, summary, resumeReason });
  };
  const blockRemote = (reason: string, human?: boolean, resumeReason?: ResumeReason): void => {
    if (remoteBlocked) return;
    remoteBlocked = reason;
    blockCalls.push({ reason, human, resumeReason });
    setStatus(human || status === 'human-control' ? 'human-control' : 'paused', reason, resumeReason);
  };
  const terminal = new TerminalManager({ data() {}, state() {}, completed() {} });
  const terminalIds = new Map<string, string>();
  for (const host of [host1, host2]) terminalIds.set(host.id, terminal.open(host.id, new IdleTerminal(), task.id, '/home/ubuntu'));
  const terminalPool = new ConversationTerminalPool(task.id, terminal,
    async () => { throw new Error('此测试不应打开新终端'); },
    (hostId) => ({ hostId, loginAs: 'ubuntu', connectionId: 'direct-harness' }));
  const scope = (host: RuntimeHost, terminalId: string, cwd = terminal.workingDirectory(terminalId)): OperationScope => ({
    taskId: task.id, hostId: host.id, cwd, runAs: host.username, loginAs: host.username,
    terminalId, terminalGeneration: terminal.currentGeneration(terminalId), policyRevision: host.policyRevision,
    conversationRevision: task.reviewRevision ?? 1, reviewerRevision: 1,
    allowedWorkingRoots: ['/srv', '/opt', `/home/${host.username}`, '/root'],
    protectedPaths: [...host.protectedPaths], protectedReadPaths: [...host.protectedPaths], protectedWritePaths: [...host.protectedPaths],
    goal: task.goal
  });
  const progress = new RecordingProgress();
  const reviews = new TaskReviewLifetime();
  const verification = new VerificationRoundTracker(task, [], signals.event);
  const budget = new TaskRequestBudget(task.id);
  const executor: OperationExecutor = {
    execute: async (operation: ProposedOperation) => {
      executorCalls.push(operation);
      const script = scripts.get(operation.kind === 'command' ? operation.command : operation.kind);
      if (!script) throw new Error(`未编排的命令：${operation.kind === 'command' ? operation.command : operation.kind}`);
      return script(operation);
    }
  };
  const ensureTerminal = options.ensureTerminal !== undefined
    ? vi.fn(options.ensureTerminal)
    : vi.fn(async (hostId: string): Promise<string> => {
      const id = terminalIds.get(hostId);
      if (!id) throw new Error(`未知主机：${hostId}`);
      return id;
    });
  const execution: ExecutionScheduler = new ExecutionScheduler({
    task, hosts: [host1, host2], terminal, executor,
    analyzer: options.analyzer ?? new BashAnalyzer(),
    signals, priorOperations: [], progress, terminalPool, reviews,
    journal: () => { throw new Error('此测试不应触碰 journal'); },
    verification: () => verification,
    background: () => background,
    profile: () => ({ provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture' }),
    status: () => status,
    remoteBlocked: () => remoteBlocked,
    isRunning: () => ['running', 'waiting-review', 'waiting-user', 'recovering'].includes(status),
    agent: () => undefined,
    controlVersion: () => controlVersion,
    requestGeneration: () => 'direct',
    assertRemoteActive: () => {
      if (remoteBlocked || !['running', 'waiting-review'].includes(status))
        throw new Error(remoteBlocked ?? 'Task is paused; wait for an explicit user continuation.');
    },
    setStatus,
    blockRemote,
    probeUnknown: (operation, signal) => recovery.probeUnknown(operation, signal),
    finishRun: () => {},
    publishExecution: () => {},
    scope
  });
  const background = createBackgroundOperations(task.id, [], execution.operationRecords,
    (operation) => signals.event({ type: 'operation', value: operation }), () => {});
  const recovery: RecoveryManager = new RecoveryManager({
    hosts: [host1, host2], terminal, terminalPool, budget,
    agent: () => undefined,
    status: () => status,
    resumeReason: () => undefined,
    controlVersion: () => controlVersion,
    operationViews: () => execution.operationViews(),
    bumpControlVersion: () => ++controlVersion,
    setStatus,
    blockRemote,
    clearRemoteBlocked: () => { remoteBlocked = undefined; },
    resetProgress: () => progress.reset(),
    finishRun: () => {},
    event: signals.event,
    ensureTerminal,
    scope,
    runRecoveryProbe: (probe, signal) => execution.runRecoveryProbe(probe, signal)
  });
  const labels = new Map<string, string>();
  const op = (label: string, command: string, host: RuntimeHost, serviceUnit?: string, delegationId?: string): ProposedOperation => {
    const operation: ProposedOperation = { id: randomUUID(), kind: 'command', command,
      ...(serviceUnit !== undefined ? { serviceUnit } : {}),
      ...(delegationId !== undefined ? { delegationId } : {}),
      scope: scope(host, terminalIds.get(host.id)!) };
    labels.set(operation.id, label);
    return operation;
  };
  return { task, host1, host2, execution, recovery, events, blockCalls, statusCalls, executorCalls, scripts, progress, ensureTerminal, scope, op, labels };
}

describe('unknown 自动探测（直连调度器矩阵）', () => {
  it('runs the probe on the independent lane while a queued write waits: dispatch order is original, probe, queued write', async () => {
    const f = directHarness();
    const w1Gate = deferred();
    const w1 = f.op('w1b', RESTART, f.host1, UNIT);
    const w2 = f.op('w2b', 'mkdir -p /srv/deploy', f.host2);
    f.scripts.set(RESTART, (operation) => w1Gate.promise.then(() => ({ operationId: operation.id, status: 'unknown', stdoutTail: '', effects: 'possible' })));
    f.scripts.set(serviceQuery(UNIT), (operation) => ({ operationId: operation.id, status: 'succeeded', exitCode: 0, stdoutTail: PROPS_PROBE }));
    f.scripts.set('mkdir -p /srv/deploy', (operation) => ({ operationId: operation.id, status: 'succeeded', exitCode: 0, stdoutTail: '' }));
    const w1Run = f.execution.runOperation(f.execution.createGate(), w1, undefined, '主机一');
    const w2Run = f.execution.runOperation(f.execution.createGate(), w2, undefined, '主机二');
    await vi.waitFor(() => expect(f.executorCalls).toHaveLength(1));
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    w1Gate.resolve();
    const [w1Feedback, w2Feedback] = await Promise.all([w1Run, w2Run]);
    expect(f.executorCalls.map(commandOf))
      .toEqual([RESTART, serviceQuery(UNIT), 'mkdir -p /srv/deploy']);
    expect(f.blockCalls).toEqual([]);
    expect(w1Feedback.structuredContent).toMatchObject({ recoveryProbe: { status: 'succeeded' } });
    expect(w2Feedback.result?.status).toBe('succeeded');
  });

  it('keeps the verbatim unknown pause without a probe template: no terminal is touched', async () => {
    const f = directHarness();
    const w1 = f.op('w2a', 'mkdir -p /srv/no-unit', f.host1);
    f.scripts.set('mkdir -p /srv/no-unit', (operation) => ({ operationId: operation.id, status: 'unknown', stdoutTail: '', effects: 'possible' }));
    const feedback = await f.execution.runOperation(f.execution.createGate(), w1, undefined, '主机一');
    expect(f.ensureTerminal).not.toHaveBeenCalled();
    expect(f.executorCalls.map(commandOf)).toEqual(['mkdir -p /srv/no-unit']);
    expect(feedback.result?.status).toBe('unknown');
    expect(f.blockCalls).toEqual([{ reason: UNKNOWN_PAUSE, human: false, resumeReason: 'verify' }]);
  });

  it('falls back to the verbatim unknown pause when acquiring a probe terminal fails', async () => {
    const f = directHarness({ ensureTerminal: async () => { throw new Error('终端不可用'); } });
    const w1 = f.op('w3a', RESTART, f.host1, UNIT);
    f.scripts.set(RESTART, (operation) => ({ operationId: operation.id, status: 'unknown', stdoutTail: '', effects: 'possible' }));
    const feedback = await f.execution.runOperation(f.execution.createGate(), w1, undefined, '主机一');
    expect(f.ensureTerminal).toHaveBeenCalledOnce();
    expect(f.executorCalls.map(commandOf)).toEqual([RESTART]);
    expect(feedback.result?.status).toBe('unknown');
    expect(f.blockCalls).toEqual([{ reason: UNKNOWN_PAUSE, human: false, resumeReason: 'verify' }]);
  });

  it('does not dispatch a probe the preflight refuses (analyzer failure) and keeps the verbatim pause', async () => {
    const f = directHarness({ analyzer: new ProbeRefusingAnalyzer() });
    const w1 = f.op('w4a', RESTART, f.host1, UNIT);
    f.scripts.set(RESTART, (operation) => ({ operationId: operation.id, status: 'unknown', stdoutTail: '', effects: 'possible' }));
    f.scripts.set(serviceQuery(UNIT), (operation) => ({ operationId: operation.id, status: 'succeeded', exitCode: 0, stdoutTail: PROPS_PROBE }));
    const feedback = await f.execution.runOperation(f.execution.createGate(), w1, undefined, '主机一');
    expect(f.ensureTerminal).toHaveBeenCalledOnce();
    expect(f.executorCalls.map(commandOf)).toEqual([RESTART]);
    expect(feedback.result?.status).toBe('unknown');
    expect(f.blockCalls).toEqual([{ reason: UNKNOWN_PAUSE, human: false, resumeReason: 'verify' }]);
  });

  it('does not retry or replay when the probe itself observes an unknown result', async () => {
    const f = directHarness();
    const w1 = f.op('w5a', RESTART, f.host1, UNIT);
    f.scripts.set(RESTART, (operation) => ({ operationId: operation.id, status: 'unknown', stdoutTail: '', effects: 'possible' }));
    f.scripts.set(serviceQuery(UNIT), (operation) => ({ operationId: operation.id, status: 'unknown', stdoutTail: '' }));
    const feedback = await f.execution.runOperation(f.execution.createGate(), w1, undefined, '主机一');
    expect(f.executorCalls.map(commandOf)).toEqual([RESTART, serviceQuery(UNIT)]);
    expect(feedback.result?.status).toBe('unknown');
    expect(f.blockCalls).toEqual([{ reason: UNKNOWN_PAUSE, human: false, resumeReason: 'verify' }]);
  });

  it('keeps the unknown host write lock: later writes on the same host are refused before dispatch, the read-only probe is not', async () => {
    const f = directHarness();
    const u = f.op('u6a', RESTART, f.host1, UNIT);
    f.scripts.set(RESTART, (operation) => ({ operationId: operation.id, status: 'unknown', stdoutTail: '', effects: 'possible' }));
    f.scripts.set(serviceQuery(UNIT), (operation) => ({ operationId: operation.id, status: 'succeeded', exitCode: 0, stdoutTail: PROPS_PROBE }));
    const unknownFeedback = await f.execution.runOperation(f.execution.createGate(), u, undefined, '主机一');
    expect(unknownFeedback.result?.status).toBe('unknown');
    expect(f.blockCalls).toEqual([]);
    const w3 = f.op('w3b', 'mkdir -p /srv/after-unknown', f.host1);
    const w3Feedback = await f.execution.runOperation(f.execution.createGate(), w3, undefined, '主机一');
    expect(w3Feedback.isError).toBe(true);
    expect(w3Feedback.details).toMatchObject({ code: 'unresolved-prior-operation', status: 'not-executed' });
    expect(f.executorCalls.map(commandOf)).toEqual([RESTART, serviceQuery(UNIT)]);
    expect(f.blockCalls).toEqual([]);
  });

  it('returns bounded redacted evidence that inherits the delegation but carries no toolCallId', async () => {
    const f = directHarness();
    const w1 = f.op('w7a', RESTART, f.host1, UNIT, 'deleg-alpha');
    f.scripts.set(RESTART, (operation) => ({ operationId: operation.id, status: 'unknown', stdoutTail: '', effects: 'possible' }));
    f.scripts.set(serviceQuery(UNIT), (operation) => ({ operationId: operation.id, status: 'succeeded', exitCode: 0, stdoutTail: PROPS_PROBE }));
    const feedback = await f.execution.runOperation(f.execution.createGate(), w1, undefined, '主机一');
    expect(feedback.result?.status).toBe('unknown');
    expect(f.blockCalls).toEqual([]);
    expect(JSON.stringify(feedback)).toContain('Recovery probe (read-only systemd query)');
    expect(JSON.stringify(feedback)).toContain('InvocationID=[REDACTED KEY]');
    expect(JSON.stringify(feedback)).not.toContain(SECRET);
    expect(feedback.structuredContent).toMatchObject({ recoveryProbe: { status: 'succeeded', exitCode: 0,
      observations: { InvocationID: '[REDACTED KEY]', LoadState: 'loaded' } } });
    const probeEvents = operationEvents(f.events).filter((event) => event.value.internal === 'recovery-probe');
    const probeView = probeEvents.at(-1)?.value;
    expect(probeView).toMatchObject({ status: 'succeeded', readOnly: true, delegationId: 'deleg-alpha', recoveryProbeTarget: w1.id });
    expect(probeView?.toolCallId).toBeUndefined();
    const w1View = operationEvents(f.events).filter((event) => event.value.id === w1.id).at(-1)?.value;
    expect(w1View).toMatchObject({ status: 'unknown', delegationId: 'deleg-alpha' });
  });

  it('does not reset the same-operation failure counter and never enters the progress index', async () => {
    const f = directHarness();
    const f1 = f.op('f1', 'mkdir -p /srv/retry-key', f.host2);
    const u = f.op('u8a', RESTART, f.host1, UNIT);
    const f2 = f.op('f2', 'mkdir -p /srv/retry-key', f.host2);
    const f3 = f.op('f3', 'mkdir -p /srv/retry-key', f.host2);
    f.scripts.set('mkdir -p /srv/retry-key', (operation) => ({ operationId: operation.id, status: 'failed', exitCode: 1,
      stdoutTail: 'mkdir: cannot create directory', effects: 'none' }));
    f.scripts.set(RESTART, (operation) => ({ operationId: operation.id, status: 'unknown', stdoutTail: '', effects: 'possible' }));
    f.scripts.set(serviceQuery(UNIT), (operation) => ({ operationId: operation.id, status: 'succeeded', exitCode: 0, stdoutTail: PROPS_PROBE }));
    await f.execution.runOperation(f.execution.createGate(), f1, undefined, '主机二');
    await f.execution.runOperation(f.execution.createGate(), u, undefined, '主机一');
    expect(f.statusCalls.filter((call) => call.status === 'paused')).toEqual([]);
    await f.execution.runOperation(f.execution.createGate(), f2, undefined, '主机二');
    expect(f.statusCalls.filter((call) => call.status === 'paused')).toEqual([]);
    await f.execution.runOperation(f.execution.createGate(), f3, undefined, '主机二');
    expect(f.statusCalls.filter((call) => call.status === 'paused'))
      .toEqual([{ status: 'paused', summary: 'The same operation failed three consecutive times', resumeReason: undefined }]);
    expect(f.blockCalls).toEqual([]);
    expect(f.executorCalls.map(commandOf))
      .toEqual(['mkdir -p /srv/retry-key', RESTART, serviceQuery(UNIT), 'mkdir -p /srv/retry-key', 'mkdir -p /srv/retry-key']);
    expect(f.progress.observations).toEqual([]);
  });
});
