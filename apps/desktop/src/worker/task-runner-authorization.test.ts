import { describe, expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer } from '@cloudhelm/adapters';
import type { ProposedOperation } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';
import { inputPlan } from './operation-input-plan.js';

describe('remote authorization and working directories', () => {
  it.each([false, true])('routes a /root creation through the gate (protected: %s)', async (protectedRoot) => {
    let requests = 0;
    const fixture = await openAiFixture(async (request) => {
      if (request.review) throw new Error('Permissive mode must not request independent review');
      requests++;
      const instructions = request.messages.filter((message) => ['system', 'developer'].includes(message.role))
        .map(fixtureMessageText).join('\n');
      expect(instructions).toContain('it is not an authorization boundary');
      expect(instructions).toContain('"account":"ubuntu"');
      expect(instructions).toContain('"reviewMode":"permissive"');
      expect(instructions).not.toContain('synthetic-ssh-secret');
      if (requests === 1) return { calls: [{ id: 'mkdir', name: 'run_remote', arguments: {
        hostId: 'fixture', command: 'mkdir -p /root/test'
      } }] };
      if (protectedRoot) {
        expect(requests).toBe(2);
        const result = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'mkdir');
        expect(fixtureMessageText(result!)).toContain('Not executed. SafetyGate deny (protected-resource)');
        return { text: '目标属于用户保护目录，操作未执行。' };
      }
      if (requests === 2) return { calls: [{ id: 'write', name: 'write_remote_file', arguments: {
        hostId: 'fixture', path: '/root/test/test', content: 'Hello world'
      } }] };
      if (requests === 3) return { calls: [{ id: 'verify', name: 'run_remote', arguments: {
        hostId: 'fixture', command: 'cat /root/test/test'
      } }] };
      expect(requests).toBe(4);
      const result = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'verify');
      expect(fixtureMessageText(result!)).toContain('Hello world');
      return { text: '文件内容已读回核验。' };
    });
    const host: RuntimeHost = { id: 'fixture', label: '测试', address: '192.0.2.1', port: 22, username: 'ubuntu',
      auth: 'password', secret: 'synthetic-ssh-secret', status: 'connected', defaultMode: 'permissive',
      protectedPaths: protectedRoot ? ['/root'] : [], policyRevision: 1 };
    const task: TaskView = { id: 'root-creation', goal: '在/root目录创建test文件夹和test文件，内容是Hello world',
      hostIds: [host.id], localScopes: [], provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft',
      requestCount: 0, requestLimit: 5, createdAt: 1, updatedAt: 1 };
    const terminal = new TerminalManager({ data: () => {}, state: () => {} });
    const terminalId = terminal.open(host.id, { write: () => { throw new Error('No real SSH writes'); },
      resize: () => {}, close: () => {}, onData: () => {}, onClose: () => {} }, task.id, '/home/ubuntu');
    const execute = vi.fn(async (operation: ProposedOperation) => ({ operationId: operation.id,
      status: 'succeeded' as const, exitCode: 0,
      stdoutTail: operation.kind === 'command' && operation.command.startsWith('cat ') ? 'Hello world' : '' }));
    const requestApproval = vi.fn(async () => false);
    const events: Parameters<TaskSignals['event']>[0][] = [];
    const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
      [], terminal, { execute }, async () => terminalId,
      { event: (event) => events.push(structuredClone(event)), requestApproval, cancelApproval: () => {} });
    try {
      await runner.start();
      expect(fixture.errors).toEqual([]);
      expect(requests).toBe(protectedRoot ? 1 : 4);
      expect(execute).toHaveBeenCalledTimes(protectedRoot ? 0 : 3);
      expect(requestApproval).not.toHaveBeenCalled();
      if (!protectedRoot) {
        expect(execute.mock.calls.map(([operation]) => operation.kind)).toEqual(['command', 'write-file', 'command']);
        expect(execute.mock.calls[1]?.[0]).toMatchObject({ path: '/root/test/test', content: 'Hello world',
          scope: { cwd: '/home/ubuntu', runAs: 'ubuntu', policyRevision: 1 } });
      }
      expect(events.some((event) => event.type === 'task-status' && event.status === 'failed')).toBe(false);
    } finally { await fixture.close(); }
  });

  it.each(['sudo mkdir -p /root/test', 'sudo install -m 0644 /tmp/staged-file /root/test/test', 'sudo cat /root/test/test'])(
    'supports the documented standalone authentication form: %s', async (command) => {
      const analysis = await new BashAnalyzer().analyze(command);
      expect(inputPlan(analysis)).toMatchObject({ auth: 'sudo', aptInstall: false });
    }
  );
});
