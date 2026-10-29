import { expect, it, vi } from 'vitest';
import { SafetyGate, HostSerialExecutor } from '@cloudhelm/application';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { serviceQuery, serviceLogQuery, isReadOnlyQuery, type OperationResult, type OperationScope, type ProposedOperation } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { createServiceTool } from '../../../apps/desktop/src/worker/service-tool.js';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';

const loaded = 'LoadState=loaded\nCanStart=yes\nNeedDaemonReload=no\nJob=\nActiveState=active\nResult=success\nInvocationID=fixture-invocation\nExecMainStatus=0';
function setup(reply: (command: string) => Partial<OperationResult> = () => ({ status: 'succeeded', stdoutTail: loaded })) {
  const commands: string[] = [];
  const scopes: OperationScope[] = [];
  let rootReady = true;
  const ensureTerminal = vi.fn(async (_hostId: string, sessionId?: string) => {
    if (!sessionId) return 'terminal';
    if (sessionId !== 'confirmed-root' || !rootReady) throw new Error('Confirmed root session expired');
    return 'root-terminal';
  });
  const host: RuntimeHost = { id: 'host', label: 'test', address: 'localhost', port: 22, username: 'user', auth: 'agent', status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
  const serial = new HostSerialExecutor({ execute: async (op) => {
    const command = op.kind === 'command' ? op.command : ''; commands.push(command); scopes.push(structuredClone(op.scope));
    const observed = reply(command);
    const exitCode = !observed.status || observed.status === 'succeeded' ? 0 : observed.status === 'failed' ? 1 : undefined;
    const result = { operationId: op.id, status: 'succeeded' as const, stdoutTail: '', exitCode, ...observed };
    if (commands.some((item) => item.includes('restart'))) result.stdoutTail = result.stdoutTail.replace('fixture-invocation', 'fixture-invocation-new');
    return result;
  } });
  const audit = { proposed: vi.fn(async (_operation: ProposedOperation) => {}), decided: vi.fn(), completed: vi.fn() };
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), evaluator: { evaluate: async () => 'allow' }, approvals: { requestApproval: async () => false },
    executor: serial, audit, lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: host.defaultMode, revision: host.policyRevision }) });
  const tool = createServiceTool({ hosts: [host], localFiles: new LocalFileAccess([]), ensureTerminal,
    scope: (_host, terminalId) => ({ taskId: 'task', hostId: 'host', cwd: '/', runAs: terminalId === 'root-terminal' ? 'root' : 'user',
      loginAs: terminalId === 'root-terminal' ? 'root' : 'user', sessionId: terminalId === 'root-terminal' ? 'confirmed-root' : undefined,
      terminalId, terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'restart' }),
    runOperation: async (safety, operation, signal) => {
      // Match TaskRunner's pre-fingerprint derivation of the sudo execution identity.
      if (operation.kind === 'command' && operation.command.startsWith('sudo ') && !operation.scope.sessionId) operation.scope.runAs = 'root';
      const outcome = await safety.execute(operation, signal);
      return { result: outcome.result, readOnly: outcome.readOnly, content: [{ type: 'text', text: outcome.result?.stdoutTail ?? outcome.decision.reason }], details: undefined, isError: outcome.result?.status !== 'succeeded' };
    } }, gate);
  return { tool, commands, scopes, ensureTerminal, audit, serial, host, expireRoot: () => { rootReady = false; } };
}
it('uses one confirmed root session for preflight, restart and verification without identity fallback', async () => {
  const f = setup();
  const result = await f.tool.execute('root', { hostId: 'host', unit: 'nginx.service', action: 'restart', sessionId: 'confirmed-root' });
  expect(result.isError).toBe(false);
  expect(f.commands).toHaveLength(3);
  expect(f.scopes.every((scope) => scope.sessionId === 'confirmed-root' && scope.terminalId === 'root-terminal' && scope.runAs === 'root')).toBe(true);
  expect(f.ensureTerminal.mock.calls.every(([, sessionId]) => sessionId === 'confirmed-root')).toBe(true);
});
it('stops if the confirmed session expires after preflight, without switching to an ordinary terminal', async () => {
  const f: ReturnType<typeof setup> = setup(() => { f.expireRoot(); return { stdoutTail: loaded }; });
  const result = await f.tool.execute('expired', { hostId: 'host', unit: 'nginx.service', action: 'restart', sessionId: 'confirmed-root' });
  expect(result.isError).toBe(true);
  expect(f.commands).toHaveLength(1);
  expect(f.ensureTerminal.mock.calls.every(([, sessionId]) => sessionId === 'confirmed-root')).toBe(true);
});
it('refuses an unknown session without dispatching and does not add sudo to inspect/log queries', async () => {
  const f = setup();
  expect((await f.tool.execute('unknown', { hostId: 'host', unit: 'nginx.service', action: 'restart', sessionId: 'missing' })).isError).toBe(true);
  expect(f.commands).toEqual([]);
  await f.tool.execute('logs', { hostId: 'host', unit: 'nginx.service', action: 'logs', sessionId: 'confirmed-root', sudo: true });
  expect(f.commands).toEqual([serviceLogQuery('nginx.service')]);
  expect(f.scopes[0]?.sessionId).toBe('confirmed-root');
});
it('never chooses an ordinary terminal for an invalid session or an already-cancelled call', async () => {
  const f = setup();
  const args = { hostId: 'host', unit: 'nginx.service', action: 'restart' as const };
  expect((await f.tool.execute('empty-session', { ...args, sessionId: '' })).isError).toBe(true);
  const controller = new AbortController(); controller.abort();
  expect((await f.tool.execute('cancelled', args, controller.signal)).isError).toBe(true);
  expect(f.ensureTerminal).not.toHaveBeenCalled();
  expect(f.commands).toEqual([]);
});
it('does not restart if preflight claims success without a definite exit', async () => {
  const f = setup(() => ({ status: 'succeeded', exitCode: undefined, stdoutTail: loaded }));
  expect((await f.tool.execute('unknown-exit', { hostId: 'host', unit: 'nginx.service', action: 'restart' })).isError).toBe(true);
  expect(f.commands).toHaveLength(1);
});
it('does not let the actual sudo restart mutate the identity of subsequent ordinary inspection', async () => {
  const f = setup();
  await f.tool.execute('sudo', { hostId: 'host', unit: 'nginx.service', action: 'restart', sudo: true });
  expect(f.scopes.map((scope) => scope.runAs)).toEqual(['user', 'root', 'user']);
});
it('front-loads every operation reference and bounds the combined service result', async () => {
  const f = setup(() => ({ stdoutTail: `${loaded}\n${'x'.repeat(70000)}` }));
  const result = await f.tool.execute('large', { hostId: 'host', unit: 'nginx.service', action: 'restart' });
  const text = result.content[0]!.text;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
  for (const [operation] of f.audit.proposed.mock.calls) expect(text.slice(0, 2000)).toContain(operation.id);
  expect(result.details).toMatchObject({ recovery: { hostId: 'host', unit: 'nginx.service' }, outputTruncated: true });
});
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
