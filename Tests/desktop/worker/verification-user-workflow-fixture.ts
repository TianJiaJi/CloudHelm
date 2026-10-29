import { BashAnalyzer } from '@cloudhelm/adapters';
import { operationIntentKey, type ProposedOperation, type OperationScope } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import { verificationSource } from '../../../apps/desktop/src/worker/verification-source.js';

export const triangleOutput = '    *\n   ***\n  *****\n *******\n*********\n';
export async function userWorkflow(): Promise<OperationView[]> {
  const analyzer = new BashAnalyzer();
  const scope: OperationScope = { taskId: 'task', hostId: 'host', cwd: '/tmp', loginAs: 'user', runAs: 'root', terminalId: 'terminal',
    terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/root', '/tmp'], protectedPaths: [], goal: '创建并运行三角形脚本' };
  const commands: ProposedOperation[] = [
    { id: 'mkdir', kind: 'command', command: 'sudo -- mkdir -p /root/test', scope },
    { id: 'stage', kind: 'write-file', path: '/tmp/test.py', content: 'for i in range(1, 6):\n    print(" " * (5 - i) + "*" * (2 * i - 1))\n', scope },
    { id: 'install', kind: 'command', command: 'sudo -- install -m 0644 /tmp/test.py /root/test/test.py', scope },
    { id: 'not-started', kind: 'command', command: 'sudo -- python3 /root/test/test.py', scope: { ...scope, cwd: '/root/test' } },
    { id: 'run', kind: 'command', command: 'sudo -- python3 /root/test/test.py', scope },
    { id: 'ls', kind: 'command', command: 'sudo -- ls -l /root/test', scope },
    { id: 'cleanup', kind: 'delete-path', path: '/tmp/test.py', scope }
  ];
  return Promise.all(commands.map(async (operation, i): Promise<OperationView> => {
    const output = operation.id === 'run' ? triangleOutput : operation.id === 'ls' ? '-rw-r--r-- root root test.py\n' : '';
    return { id: operation.id, taskId: 'task', hostId: 'host', kind: operation.kind,
      preview: operation.kind === 'command' ? operation.command : operation.kind === 'write-file' ? '写入文件 /tmp/test.py' : '删除文件 /tmp/test.py',
      intentKey: operationIntentKey(operation), loginAs: 'user', runAs: 'root', createdAt: i * 2, completedAt: i * 2 + 1, exitObserved: true,
      commandSource: { version: 1, cwd: operation.scope.cwd }, verificationSource: await verificationSource(operation, analyzer),
      status: operation.id === 'not-started' ? 'failed' : 'succeeded', exitCode: operation.id === 'not-started' ? 127 : 0,
      readOnly: operation.id === 'ls', effects: ['not-started', 'ls'].includes(operation.id) ? 'none' : 'possible',
      failureKind: operation.id === 'not-started' ? 'unsupported' : undefined,
      outputTail: output, outputCapture: { totalChars: output.length, tailChars: output.length, truncated: false } };
  }));
}
