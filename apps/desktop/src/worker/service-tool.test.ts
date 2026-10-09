import { expect, it, vi } from 'vitest';
import { SafetyGate, HostSerialExecutor } from '@cloudhelm/application';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { serviceQuery, serviceLogQuery, isReadOnlyQuery, type OperationResult } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { createServiceTool } from './service-tool.js';
import { LocalFileAccess } from './local-file-access.js';

const loaded = 'LoadState=loaded\nCanStart=yes\nNeedDaemonReload=no\nJob=\nActiveState=active\nResult=success\nInvocationID=fixture-invocation\nExecMainStatus=0';
function setup(reply: (command: string) => Partial<OperationResult> = () => ({ status: 'succeeded', stdoutTail: loaded })) {
  const commands: string[] = [];
  const host: RuntimeHost = { id: 'host', label: 'test', address: 'localhost', port: 22, username: 'user', auth: 'agent', status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
  const serial = new HostSerialExecutor({ execute: async (op) => {
    const command = op.kind === 'command' ? op.command : ''; commands.push(command);
    const result = { operationId: op.id, status: 'succeeded' as const, stdoutTail: '', ...reply(command) };
    if (commands.some((item) => item.includes('restart'))) result.stdoutTail = result.stdoutTail.replace('fixture-invocation', 'fixture-invocation-new');
    return result;
  } });
  const audit = { proposed: vi.fn(), decided: vi.fn(), completed: vi.fn() };
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), evaluator: { evaluate: async () => 'allow' }, approvals: { requestApproval: async () => false },
    executor: serial, audit, lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: host.defaultMode, revision: host.policyRevision }) });
  const tool = createServiceTool({ hosts: [host], localFiles: new LocalFileAccess([]), ensureTerminal: async () => 'terminal',
    scope: () => ({ taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'restart' }),
    runOperation: async (safety, operation, signal) => {
      const outcome = await safety.execute(operation, signal);
      return { result: outcome.result, content: [{ type: 'text', text: outcome.result?.stdoutTail ?? outcome.decision.reason }], details: undefined, isError: outcome.result?.status !== 'succeeded' };
    } }, gate);
  return { tool, commands, audit, serial, host };
}
it('preflights, reviews the actual restart, then verifies using the stable unit and invocation reference', async () => {
  const f = setup();
  const result = await f.tool.execute('call', { hostId: 'host', unit: 'nginx.service', action: 'restart', sudo: true });
  expect(result.isError).toBe(false);
  expect(f.commands).toEqual([serviceQuery('nginx.service'), 'sudo systemctl restart -- nginx.service', serviceQuery('nginx.service')]);
  expect(f.audit.proposed).toHaveBeenCalledTimes(3);
  expect(result.content[0]?.text).toContain('fixture-invocation');
});
it.each(['LoadState=not-found', loaded.replace('Job=', 'Job=42')])('never restarts a missing unit or one with an outstanding job', async (output) => {
  const f = setup(() => ({ stdoutTail: output }));
  expect((await f.tool.execute('call', { hostId: 'host', unit: 'nginx.service', action: 'restart' })).isError).toBe(true);
  expect(f.commands).toHaveLength(1);
});
it('allows reconnect inspection while refusing replay after a disconnected restart', async () => {
  const f = setup((command) => command.includes('restart') ? { status: 'unknown', stdoutTail: '' } : { stdoutTail: loaded });
  await f.tool.execute('call', { hostId: 'host', unit: 'nginx.service', action: 'restart' });
  expect((await f.tool.execute('inspect', { hostId: 'host', unit: 'nginx.service', action: 'inspect' })).isError).toBe(false);
  expect((await f.tool.execute('retry', { hostId: 'host', unit: 'nginx.service', action: 'restart' })).isError).toBe(true);
  expect(f.commands.filter((command) => command.includes('restart'))).toHaveLength(1);
});
it('rechecks policy at each step and reports an unhealthy service without another restart', async () => {
  const f = setup((command) => { if (command.includes('show')) f.host.policyRevision++; return { stdoutTail: loaded }; });
  expect((await f.tool.execute('call', { hostId: 'host', unit: 'nginx.service', action: 'restart' })).isError).toBe(true);
  expect(f.commands).toHaveLength(1);
  const unhealthy = setup((command) => ({ stdoutTail: command.includes('show') ? loaded.replace('ActiveState=active', 'ActiveState=failed') : '' }));
  expect((await unhealthy.tool.execute('call', { hostId: 'host', unit: 'nginx.service', action: 'restart' })).isError).toBe(true);
  expect(unhealthy.commands.filter((command) => command.includes('restart'))).toHaveLength(1);
});
it('mints read-only capability only for the exact bounded systemd query grammar', async () => {
  const analyzer = new BashAnalyzer();
  for (const query of [serviceQuery('nginx.service'), serviceLogQuery('nginx.service')]) expect(isReadOnlyQuery(await analyzer.analyze(query))).toBe(true);
  for (const query of ['systemctl restart nginx.service', 'journalctl --vacuum-size=1M', serviceQuery('nginx.service') + ' --host=elsewhere', serviceLogQuery('nginx.service') + ' --output-fields=MESSAGE']) expect(isReadOnlyQuery(await analyzer.analyze(query))).toBe(false);
  expect(() => serviceQuery('nginx.service; rm -rf /')).toThrow();
});
