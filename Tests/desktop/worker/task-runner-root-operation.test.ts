import { expect, it, vi } from 'vitest';
import { InteractionCoordinator, TerminalManager } from '@cloudhelm/application';
import type { SshTransport } from '@cloudhelm/adapters';
import type { InputRequest, RawTerminal } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { OperationInputBridge } from '../../../apps/desktop/src/worker/operation-input-bridge.js';
import { TaskRunner } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

it.each(['root', 'sudo-password', 'sudo-passwordless'] as const)('runs a root operation through native Pi tools without session setup (%s)', async (mode) => {
  const commands: string[] = [], inputs: InputRequest[] = [], modelBodies: string[] = [];
  let requests = 0, attempts = 0;
  const fixture = await openAiFixture(async (request) => {
    modelBodies.push(JSON.stringify(request.messages)); requests++;
    if (requests === 1) return { calls: [{ id: 'root-operation', name: 'run_remote', arguments: {
      hostId: 'host', command: 'stat /root/example', cwd: '/', privilege: 'root' } }] };
    expect(fixtureMessageText(request.messages.find((message) => message.tool_call_id === 'root-operation')!)).toContain('observed');
    return { text: '已取得指定路径的元数据；未检查文件正文。' };
  });
  let data = (_text: string) => {}, exit = (_code: number | undefined) => {};
  let authenticate = (_challenge: { id: string; prompt?: string }) => {};
  const raw: RawTerminal = {
    onData: (listener) => { data = listener; }, onExit: (listener) => { exit = listener; }, onClose() {}, close() {}, resize() {},
    write() { throw new Error('Credentials must never enter business stdin'); },
    onAuthentication: (listener) => { authenticate = listener; },
    execute: async (command, _cwd, current) => {
      expect(current()).toBe(true); commands.push(command);
      queueMicrotask(() => {
        if (command === 'id -u') { data(mode === 'root' ? '0\n' : '1000\n'); exit(0); }
        else if (mode === 'sudo-password') authenticate({ id: 'first', prompt: 'sudo' });
        else { data('observed\n'); exit(0); }
      });
    },
    answerAuthentication: (id, answer) => {
      expect(id).toBe(attempts === 0 ? 'first' : 'second'); attempts++;
      expect(answer).toBe(attempts === 1 ? 'synthetic-wrong' : 'synthetic-correct');
      queueMicrotask(() => {
        if (attempts === 1) { data('Sorry, try again.\n'); authenticate({ id: 'second', prompt: 'sudo' }); }
        else { data('observed\n'); exit(0); }
      }); return true;
    }
  };
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: mode === 'root' ? 'root' : 'user', auth: 'agent',
    status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const task: TaskView = { id: `operation-${mode}`, goal: '读取授权路径元数据，需要时提权', hostIds: ['host'], localScopes: [], status: 'draft',
    provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1 };
  const terminals = new TerminalManager({ data() {}, state() {} });
  const terminalId = terminals.open('host', raw, task.id, '/');
  const interactions = new InteractionCoordinator(terminals, { opened: (request) => {
    inputs.push(request); queueMicrotask(() => void interactions.answer(request.id, inputs.length === 1 ? 'synthetic-wrong' : 'synthetic-correct'));
  }, closed() {} });
  const bridge = new OperationInputBridge(terminals, { connectionGeneration: () => 1 } as unknown as SshTransport, interactions);
  const requestApproval = vi.fn(async () => true);
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl },
    [], terminals, bridge, async () => terminalId, { event() {}, requestApproval, cancelApproval() {}, clearCredentials: () => bridge.clearTask(task.id) });
  try {
    await runner.start(); expect(fixture.errors).toEqual([]); expect(requests).toBe(2); expect(task.status).toBe('answered');
    expect(commands).toEqual(['id -u', mode === 'root' ? 'stat /root/example' : 'sudo -- stat /root/example']);
    expect(inputs).toHaveLength(mode === 'sudo-password' ? 2 : 0);
    expect(modelBodies.join('')).not.toContain('synthetic-wrong'); expect(modelBodies.join('')).not.toContain('synthetic-correct');
  } finally { runner.dispose(); await fixture.close(); }
});
