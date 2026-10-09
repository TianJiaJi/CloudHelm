import { randomUUID } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { serviceQuery, serviceLogQuery, serviceObservation, type BusinessTool } from '@cloudhelm/core';
import type { SafetyGate } from '@cloudhelm/application';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';

const parameters = Type.Object({ hostId: Type.String(), unit: Type.String(),
  action: Type.Union([Type.Literal('inspect'), Type.Literal('restart'), Type.Literal('logs')]),
  sudo: Type.Optional(Type.Boolean()) });
/** A deliberately narrow workflow for an existing systemd service; PID 1 owns the job across SSH loss. */
export function createServiceTool(deps: RemoteToolDependencies, gate: SafetyGate): BusinessTool<Static<typeof parameters>> {
  return { name: 'manage_service', label: '检查与重启现有 systemd 服务', parameters, replay: 'never',
    description: 'Existing Linux systemd services only. inspect retrieves job, invocation ID, progress and last process exit status after reconnect; logs retrieves 80 journal lines. restart preflights the loaded unit, performs one reviewed restart, then verifies active state. No installation or unit creation. Use this for service restarts. After disconnect use inspect/logs with the original host and unit; never restart merely to recover. sudo applies only to the actual restart, with the private authentication channel. A service reference survives SSH loss but is not a permanent job archive; host reboot/unit replacement may destroy evidence.',
    execute: async (_id, params, signal) => {
      const host = deps.hosts.find((item) => item.id === params.hostId);
      if (!host) throw new Error('Host is outside the conversation authorization scope');
      const query = serviceQuery(params.unit);
      const terminalId = await deps.ensureTerminal(host.id);
      const scope = deps.scope(host, terminalId, '/');
      const evidence: string[] = [];
      const run = async (command: string) => {
        const value = await deps.runOperation(gate, { id: randomUUID(), kind: 'command', command, serviceUnit: params.unit, scope }, signal, host.label);
        evidence.push(...value.content.map((part) => part.text));
        return value;
      };
      const first = await run(params.action === 'logs' ? serviceLogQuery(params.unit) : query);
      if (params.action !== 'restart' || first.isError) return first;
      const observed = serviceObservation(first.result?.stdoutTail ?? '');
      if (observed.LoadState !== 'loaded' || observed.CanStart !== 'yes' || observed.NeedDaemonReload !== 'no'
        || (observed.Job !== '' && observed.Job !== '0')) {
        return { content: [{ type: 'text', text: evidence.join('\n') + '\n未重启：单元未就绪、配置待加载或存在运行中的任务；请先检查。' }], details: undefined, isError: true };
      }
      const changed = await run(`${params.sudo ? 'sudo ' : ''}systemctl restart -- ${params.unit}`);
      if (changed.isError) return { ...changed, content: [{ type: 'text', text: evidence.join('\n') + '\n重连后先 inspect 同一服务，不要再次 restart。' }] };
      const checked = await run(query);
      const after = serviceObservation(checked.result?.stdoutTail ?? '');
      const verified = !checked.isError && after.LoadState === 'loaded' && after.ActiveState === 'active'
        && after.InvocationID !== observed.InvocationID && after.Result === 'success' && (after.Job === '' || after.Job === '0') && !!after.InvocationID;
      return { content: [{ type: 'text', text: evidence.join('\n') + `\n${verified ? '服务已处于 active 状态；仍需按应用协议检查健康。' : '服务状态未通过核验；读取日志调查，不自动重启。'} 恢复引用：${host.id} / ${params.unit}；InvocationID=${after.InvocationID || 'unknown'}。重启不可回滚；配置回退需单独审核。` }], details: undefined, isError: !verified };
    }
  };
}
