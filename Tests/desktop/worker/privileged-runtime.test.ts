import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SafetyGate, TerminalManager } from '@cloudhelm/application';
import { SshTransport } from '@cloudhelm/adapters';
import { operationFingerprint, type PrivilegeMethod, type ProposedOperation } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { PrivilegedRuntime } from '../../../apps/desktop/src/worker/privileged-runtime.js';

const state = vi.hoisted(() => ({ commands: [] as string[], connections: [] as unknown[][], uid: '0', fail: false, gen: 1,
  passwords: [] as string[], challenge: undefined as undefined | { hostId: string; username: string; text: string; echo: boolean }, close: vi.fn() }));
vi.mock('@cloudhelm/adapters', async (importOriginal) => ({
  BashAnalyzer: (await importOriginal<typeof import('@cloudhelm/adapters')>()).BashAnalyzer,
  SshAuthenticationError: (await importOriginal<typeof import('@cloudhelm/adapters')>()).SshAuthenticationError,
  SshTransport: class {
    connectionGeneration() { return state.gen; }
    async connect(...args: unknown[]) {
      state.connections.push(args); if (state.fail) throw new Error('login failed');
      if (state.challenge) {
        const answer = await (args[3] as (prompt: typeof state.challenge) => Promise<string | null>)(state.challenge);
        if (answer === null) throw new Error('login cancelled');
        state.passwords.push(answer);
      }
    }
    close() { state.close(); }
  },
  SshCommandTerminal: class {
    data = (_value: string) => {}; exit = (_code: number) => {};
    onData(callback: typeof this.data) { this.data = callback; }
    onExit(callback: typeof this.exit) { this.exit = callback; }
    onClose() {} onDisplay() {} resize() {} write() {} close() {}
    async execute(command: string, _cwd: string, current: () => boolean) {
      if (!current()) throw new Error('expired');
      state.commands.push(command); this.data(command === 'id -u' ? `${state.uid}\n` : 'done\n'); this.exit(0);
    }
  }
}));
const host: RuntimeHost = { id: 'host', label: 'Linux', address: '192.0.2.1', port: 22, username: 'user',
  auth: 'password', secret: 'ordinary-secret', fingerprint: 'trusted', status: 'connected',
  defaultMode: 'permissive', protectedPaths: ['/etc/shadow'], policyRevision: 1 };
beforeEach(() => { state.commands = []; state.connections = []; state.uid = '0'; state.fail = false; state.gen = 1; state.passwords = []; state.challenge = undefined; state.close.mockClear(); });
function setup(mode: 'ssh' | 'su' | 'sudo' = 'ssh', overrides: Partial<RuntimeHost> = {}) {
  const terminal = new TerminalManager({ data() {}, state() {} });
  const input = vi.fn(async (request: { kind: string }): Promise<string | null> => request.kind === 'confirmation' ? mode === 'sudo' ? '使用 sudo（推荐）' : mode === 'ssh' ? 'SSH 登录 root' : '通过 su 切换 root' : 'root-secret');
  const ordinary = { execute: vi.fn() };
  const runtime = new PrivilegedRuntime({ terminal, ssh: new SshTransport(), ordinary, jump: () => undefined, input });
  const access = runtime.forTask('task');
  const decisions: string[] = [];
  const gate = new SafetyGate({ analyzer: { analyze: async (command) => ({ raw: command, calls: [{ name: command.split(' ')[0]!, args: command.split(' ').slice(1), dynamic: false, redirects: false }],
    redirectTargets: [], hasError: false, hasCompound: false, hasPipeline: false, hasExpansion: false, hasRedirection: false }) },
    evaluator: { evaluate: async () => 'allow' }, approvals: { requestApproval: async () => true },
    executor: runtime, lease: terminal, settings: () => ({ mode: 'permissive', revision: host.policyRevision }),
    audit: { proposed: async () => {}, completed: async () => {}, decided: async (_id, decision) => { decisions.push(decision.verdict); } } });
  const request = (method?: PrivilegeMethod) => access.request({ ...host, ...overrides }, 'mkdir -p /opt/demo', '/tmp', 'sudo unavailable', 'create demo', gate, undefined, undefined, method);
  const operation = (id: string, command: string): ProposedOperation => {
    const terminalId = access.terminal(id, host.id);
    return { id: 'action', kind: 'command', command, scope: { taskId: 'task', hostId: host.id, cwd: '/tmp', runAs: 'root',
      terminalId, terminalGeneration: terminal.currentGeneration(terminalId), policyRevision: 1, protectedPaths: host.protectedPaths,
      allowedWorkingRoots: ['/'], goal: 'demo', ...access.scope(terminalId) } };
  };
  return { runtime, access, gate, request, operation, input, ordinary, terminal, decisions };
}

describe('confirmed isolated root sessions', () => {
  it('offers sudo first and prepares without authentication, identity probe or business execution', async () => {
    const f = setup('sudo'); const context = await f.request();
    if (!('sessionId' in context)) throw new Error('expected a session-backed root context');
    expect(context).toMatchObject({ method: 'sudo', state: 'prepared', loginAs: 'user', targetRunAs: 'root', identityVerified: false });
    expect(f.input.mock.calls[0]?.[0]).toMatchObject({ choices: ['使用 sudo（推荐）', 'SSH 登录 root', '通过 su 切换 root'] });
    expect(f.input).toHaveBeenCalledOnce(); expect(state.commands).toEqual([]); expect(state.connections).toEqual([]);
    expect(f.access.confirmed?.()).toEqual([]);
    expect(f.access.sudoContexts?.()).toEqual([{ sessionId: context.sessionId, hostId: host.id, state: 'prepared', loginAs: 'user', targetRunAs: 'root' }]);
    const plain = f.operation(context.sessionId, 'systemctl restart demo');
    const prepared = await f.access.prepare!(plain);
    expect(prepared).toMatchObject({ command: 'sudo -- systemctl restart demo', scope: { runAs: 'root', loginAs: 'user' } });
    expect(operationFingerprint(prepared)).not.toBe(operationFingerprint(plain));
    await expect(f.runtime.forTask('other').prepare!({ ...prepared, scope: { ...prepared.scope, taskId: 'other' } })).rejects.toThrow();
    await expect(f.access.prepare!({ ...prepared, scope: { ...prepared.scope, hostId: 'other-host' } })).rejects.toThrow();
    await expect(f.gate.execute(plain)).resolves.toMatchObject({ result: { status: 'failed', failureKind: 'unsupported', effects: 'none' } });
    expect(f.ordinary.execute).not.toHaveBeenCalled();
    f.ordinary.execute.mockResolvedValue({ operationId: 'action', status: 'succeeded', exitCode: 0, stdoutTail: 'done' });
    expect((await f.gate.execute(prepared)).result?.status).toBe('succeeded');
    expect(f.ordinary.execute.mock.calls[0]?.[0]).toMatchObject({ command: 'sudo -- systemctl restart demo' });
    state.gen++; expect(f.access.sudoContexts?.()).toEqual([]);
    await expect(f.access.prepare!(prepared)).rejects.toThrow(); f.access.close();
  });
  it('does not elevate SFTP through a sudo context or accept compound/root-changing commands', async () => {
    const f = setup('sudo'); const context = await f.request();
    if (!('sessionId' in context)) throw new Error('expected a session-backed root context');
    for (const command of ['id; whoami', 'sudo -u other id', 'su root', 'sudo -n true'])
      await expect(f.access.prepare!(f.operation(context.sessionId, command))).rejects.toThrow();
    const base = f.operation(context.sessionId, 'id');
    const write: ProposedOperation = { id: 'file', kind: 'write-file', path: '/opt/demo/file', content: 'x', scope: base.scope };
    await expect(f.access.prepare!(write)).rejects.toThrow('do not elevate SFTP');
    const result = await f.gate.execute(write);
    expect(result.result).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'unsupported' });
    expect(f.ordinary.execute).not.toHaveBeenCalled(); f.access.close();
  });
  it('projects only confirmed, owned, current-generation sessions without credentials or cross-task references', async () => {
    const f = setup();
    expect(f.access.confirmed?.()).toEqual([]);
    const session = await f.request();
    if (!('sessionId' in session)) throw new Error('expected a session-backed root context');
    const projection = f.access.confirmed?.();
    expect(projection).toEqual([{ sessionId: session.sessionId, hostId: host.id, method: 'ssh', runAs: 'root' }]);
    expect(JSON.stringify(projection)).not.toContain('secret');
    expect(f.runtime.forTask('other').confirmed?.()).toEqual([]);
    state.gen++;
    expect(f.access.confirmed?.()).toEqual([]);
    state.gen--;
    f.terminal.takeOver(f.access.terminal(session.sessionId, host.id));
    expect(f.access.confirmed?.()).toEqual([]);
    f.access.close();
  });

  it('authenticates ssh, verifies UID, and reviews subsequent operations', async () => {
    const f = setup('ssh'); const session = await f.request();
    if (!('sessionId' in session)) throw new Error('expected a session-backed root context');
    expect(state.commands).toEqual(['id -u']);
    expect(JSON.stringify(session)).not.toContain('secret');
    const operation = f.operation(session.sessionId, 'mkdir -p /opt/demo');
    expect(operation.scope).toMatchObject({ loginAs: 'root', runAs: 'root', sessionId: session.sessionId, connectionGeneration: 1 });
    expect((await f.gate.execute(operation)).result?.status).toBe('succeeded');
    expect((await f.gate.execute(f.operation(session.sessionId, 'cat /etc/shadow'))).decision.verdict).toBe('deny');
    expect(state.commands).toEqual(['id -u', 'mkdir -p /opt/demo']);
    expect(f.ordinary.execute).not.toHaveBeenCalled();
    expect(state.connections[0]?.[0]).toMatchObject({ username: 'root', id: host.id, fingerprint: 'trusted', address: host.address, secret: undefined });
    expect(state.connections[0]?.[1]).toEqual({});
    expect(state.connections[0]?.[5]).toEqual({ onDemandAuthentication: true });
    expect(f.input).toHaveBeenCalledOnce();
    f.access.close();
  });
  it.each(['password', 'private-key', 'agent'] as const)('does not pre-prompt based on root SSH configuration (%s)', async (auth) => {
    const f = setup('ssh', { auth }); await f.request();
    expect(f.input).toHaveBeenCalledOnce(); expect(state.passwords).toEqual([]);
    expect(state.connections[0]?.[1]).toEqual({}); f.access.close();
  });
  it('answers only a transport challenge bound to the selected root recipient', async () => {
    state.challenge = { hostId: host.id, username: 'root', text: 'Password', echo: false };
    const f = setup(); await f.request();
    expect(f.input).toHaveBeenCalledTimes(2); expect(state.passwords).toEqual(['root-secret']); f.access.close();
    state.commands = []; state.passwords = []; state.challenge.username = 'wrong-recipient';
    const refused = setup(); await expect(refused.request()).rejects.toThrow('identity');
    expect(refused.input).toHaveBeenCalledOnce(); expect(state.passwords).toEqual([]); expect(state.commands).toEqual([]);
  });
  it('does not execute payload after failed ssh authentication', async () => {
    const f = setup('ssh'); state.fail = true;
    await expect(f.request()).rejects.toThrow('identity'); expect(state.commands).toEqual([]);
  });
  it('rejects a non-root identity', async () => {
    const f = setup(); state.uid = '1000'; await expect(f.request()).rejects.toThrow('identity');
    expect(state.commands).toEqual(['id -u']); expect(state.close).toHaveBeenCalled();
  });
  it('expires on pause and binds approvals to identity and connection', async () => {
    const f = setup(); const session = await f.request();
    if (!('sessionId' in session)) throw new Error('expected a session-backed root context');
    const op = f.operation(session.sessionId, 'id');
    const hash = operationFingerprint(op);
    expect(operationFingerprint({ ...op, scope: { ...op.scope, sessionId: 'different' } })).not.toBe(hash);
    expect(operationFingerprint({ ...op, scope: { ...op.scope, connectionGeneration: 2 } })).not.toBe(hash);
    expect(() => f.runtime.forTask('other').terminal(session.sessionId, host.id)).toThrow();
    f.access.close();
    expect(f.terminal.hostOf(op.scope.terminalId)).toBeUndefined();
    expect(() => f.access.terminal(session.sessionId, host.id)).toThrow('expired');
    expect((await f.gate.execute(op)).decision.verdict).toBe('error');
  });
  it('rejects source reconnection and never reuses a stale session', async () => {
    const f = setup(); const session = await f.request();
    if (!('sessionId' in session)) throw new Error('expected a session-backed root context');
    const op = f.operation(session.sessionId, 'id');
    state.gen++; expect((await f.gate.execute(op)).result?.status).toBe('unknown');
    expect(state.commands).toEqual(['id -u']); f.access.close();
  });
  it('cancels pending confirmation and rejects duplicate requests', async () => {
    const f = setup(); let answer!: (value: string) => void;
    f.input.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const pending = f.request(); await expect(f.request()).rejects.toThrow('already pending');
    f.access.close(); answer('SSH 登录 root'); await expect(pending).rejects.toThrow();
    expect(state.connections).toEqual([]); expect(state.commands).toEqual([]);
  });
  it('returns a stateless su confirmation without creating a session, terminal or grant', async () => {
    const f = setup('su');
    const context = await f.request('su');
    expect(context).toStrictEqual({ method: 'su', runAs: 'root' });
    expect(f.input).toHaveBeenCalledOnce();
    expect(f.input.mock.calls[0]?.[0]).toMatchObject({ choices: ['通过 su 切换 root'] });
    expect(String((f.input.mock.calls[0]?.[0] as { explanation?: string }).explanation)).toContain('不创建通用 root Shell');
    expect(state.commands).toEqual([]); expect(state.connections).toEqual([]);
    expect(f.access.confirmed?.()).toEqual([]);
    expect(f.access.sudoContexts?.()).toEqual([]);
    // No session id was minted, so nothing can be referenced or closed later.
    expect(() => f.access.terminal('missing', host.id)).toThrow();
  });
  it('rejects a cancelled or divergent su confirmation without any dispatch', async () => {
    const f = setup('su');
    f.input.mockResolvedValueOnce(null);
    await expect(f.request('su')).rejects.toThrow();
    expect(state.commands).toEqual([]); expect(state.connections).toEqual([]);

    const divergent = setup('su');
    divergent.input.mockResolvedValueOnce('SSH 登录 root');
    await expect(divergent.request('su')).rejects.toThrow('Unconfirmed privilege method');
    expect(state.commands).toEqual([]); expect(state.connections).toEqual([]);
  });
  it('keeps a pending confirmation exclusive per task and cancels it with the task', async () => {
    const f = setup('su');
    let answer!: (value: string) => void;
    f.input.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const pending = f.request('su');
    await expect(f.request('su')).rejects.toThrow('already pending');
    f.access.close();
    answer('通过 su 切换 root');
    await expect(pending).rejects.toThrow();
    expect(state.commands).toEqual([]); expect(state.connections).toEqual([]);
  });
});
