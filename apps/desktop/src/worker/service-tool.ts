import { randomUUID } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { serviceQuery, serviceLogQuery, serviceObservation, type BusinessTool } from '@cloudhelm/core';
import type { SafetyGate } from '@cloudhelm/application';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { feedbackTail } from './operation-feedback.js';
import { OperationPrivilege } from './operation-privilege.js';

const parameters = Type.Object({ hostId: Type.String(), unit: Type.String({ minLength: 1, maxLength: 200 }),
  action: Type.Union([Type.Literal('inspect'), Type.Literal('restart'), Type.Literal('logs')]),
  privilege: Type.Optional(Type.Union([Type.Literal('current'), Type.Literal('root')])),
  sudo: Type.Optional(Type.Boolean()), sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false });
type Phase = 'preflight' | 'restart' | 'check' | 'logs' | 'inspect';
interface Observation {
  phase: Phase; operationId: string; status: string; readOnly: boolean | 'unclassified';
  exitCode?: number; effects?: string; outputTruncated?: boolean | 'unknown';
}

/** A bounded existing-service workflow, not permission to install or retry jobs. */
export function createServiceTool(deps: RemoteToolDependencies, gate: SafetyGate): BusinessTool<Static<typeof parameters>> {
  const privilege = new OperationPrivilege(deps);
  return { name: 'manage_service', label: '检查与重启现有 systemd 服务', parameters, replay: 'never',
    description: 'Existing Linux systemd services: inspect state, logs (80 journal lines), or preflight/restart/check once; active is not application health. privilege=root routes EVERY step through the same reviewed operation-level root path as run_remote; deprecated sudo=true has that same meaning, including inspect/logs. Alternatively sessionId binds one explicit legacy identity; do not combine it with root/sudo. Cancellation, denial or unknown outcomes never switch identity or restart automatically. Inspect the original unit and read_operation_log for truncated output. No installation; restart has no rollback.',
    execute: async (_id, params, signal) => {
      const host = deps.hosts.find((item) => item.id === params.hostId);
      if (!host) throw new Error('Host is outside the conversation authorization scope');
      const query = serviceQuery(params.unit);
      const operations: Observation[] = [];
      const fragments: string[] = [];
      let outputTruncated: boolean | 'unknown' = false;
      const validSessionId = params.sessionId === undefined || (typeof params.sessionId === 'string' && params.sessionId.length > 0 && params.sessionId.length <= 200);
      const root = params.privilege === 'root' || params.sudo === true;
      const recovery = { hostId: host.id, unit: params.unit, ...(root ? { privilege: 'root' as const } : {}), ...(validSessionId && params.sessionId ? { sessionId: feedbackTail(params.sessionId, 800).text } : {}) };
      const finish = (code: string, isError: boolean, guidance: string, invocationId?: string) => {
        const details = { code, recovery, operations, outputTruncated, invocationId: invocationId ? feedbackTail(invocationId, 128).text : undefined,
          retrieval: 'read_operation_log by operationId in this conversation; retention/completeness unknown' };
        return { content: [{ type: 'text' as const, text: `[Service result ${JSON.stringify(details)}]\n${guidance}\n${fragments.join('\n')}` }], details, isError };
      };
      try {
        if ((params.privilege === 'current' && params.sudo === true) || (root && params.sessionId !== undefined))
          return finish('conflicting-identity', true, '权限意图冲突；选择 privilege=root 或 sessionId，不要混用。未分配终端、未发送命令。');
        if (!validSessionId) return finish('service-session-invalid', true, '会话标识无效；未选择普通终端或发送命令。');
        if (signal?.aborted) return finish('service-cancelled', true, '服务请求已取消；未发送命令。');
        const terminalId = await deps.ensureTerminal(host.id, params.sessionId);
        const scope = deps.scope(host, terminalId, '/');
        if (params.sessionId && scope.sessionId !== params.sessionId) throw new Error('Confirmed service identity unavailable');
        const run = async (phase: Phase, command: string) => {
          if (signal?.aborted) throw new Error('Operation aborted');
          if (params.sessionId && await deps.ensureTerminal(host.id, params.sessionId) !== terminalId) throw new Error('Service session changed');
          if (signal?.aborted) throw new Error('Operation aborted');
          const id = randomUUID();
          const observation: Observation = { phase, operationId: id, status: 'result-not-observed', readOnly: 'unclassified' };
          operations.push(observation);
          // TaskRunner derives sudo's effective runAs before fingerprinting. A
          // per-step copy prevents that derivation from contaminating later reads.
          const operation = { id, kind: 'command' as const, command, serviceUnit: params.unit, scope: structuredClone(scope) };
          const value = root ? await privilege.run(gate, host, operation, signal)
            : await deps.runOperation(gate, operation, signal, host.label);
          if (value.result && value.result.operationId !== id) throw new Error('Mismatched service operation observation');
          const bounded = feedbackTail(value.content.map((part) => part.text).join('\n'), 8 * 1024);
          const priorTruncation = value.result?.outputCapture?.truncated;
          Object.assign(observation, { status: value.result?.status ?? 'not-executed', readOnly: value.readOnly ?? 'unclassified',
            exitCode: value.result?.exitCode, effects: value.result?.effects ?? 'not-classified',
            outputTruncated: bounded.truncated || priorTruncation === true ? true : priorTruncation ?? 'unknown' });
          if (bounded.truncated || priorTruncation === true) outputTruncated = true;
          else if (priorTruncation === undefined && outputTruncated !== true) outputTruncated = 'unknown';
          fragments.push(`${phase} / ${id}\n${bounded.text}`);
          return value;
        };
        const first = await run(params.action === 'restart' ? 'preflight' : params.action,
          params.action === 'logs' ? serviceLogQuery(params.unit) : query);
        const firstFailed = first.isError || first.result?.status !== 'succeeded' || first.result.exitCode !== 0;
        if (firstFailed || params.action !== 'restart') return finish(firstFailed ? 'service-query-failed' : 'service-observed',
          firstFailed, '查询结果不是应用健康证明；输出不全时按操作ID读日志，不为补输出而重启。');
        const observed = serviceObservation(first.result?.stdoutTail ?? '');
        if (observed.LoadState !== 'loaded' || observed.CanStart !== 'yes' || observed.NeedDaemonReload !== 'no'
          || (observed.Job !== '' && observed.Job !== '0')) return finish('service-not-ready', true,
          '未重启：单元未就绪、配置待加载或存在运行中的任务；请先检查。');
        const changed = await run('restart', `systemctl restart -- ${params.unit}`);
        if (changed.isError || changed.result?.status !== 'succeeded' || changed.result.exitCode !== 0) return finish('service-restart-unresolved', true, '保留已返回的原结果。重连后先inspect同一服务，不要再次restart。');
        const checked = await run('check', query);
        const after = serviceObservation(checked.result?.stdoutTail ?? '');
        const active = !checked.isError && checked.result?.status === 'succeeded' && checked.result.exitCode === 0 && after.LoadState === 'loaded' && after.ActiveState === 'active'
          && after.InvocationID !== observed.InvocationID && after.Result === 'success' && (after.Job === '' || after.Job === '0') && !!after.InvocationID;
        return finish(active ? 'service-active-observed' : 'service-check-inconclusive', !active,
          `${active ? '服务已处于active状态；仍需按应用协议检查健康。' : '服务状态未通过核验；读取日志调查，不自动重启。'} 重启不可回滚；配置回退需单独审核。`, after.InvocationID || 'unknown');
      } catch {
        return finish('service-step-unavailable', true,
          '服务步骤已停止：会话、权限、策略或控制状态不再有效，或结果未能记录。保留已有操作引用，不自动换身份或重启；先核对原结果。');
      }
    }
  };
}
