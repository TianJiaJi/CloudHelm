import { randomUUID } from 'node:crypto';
import { TerminalManager } from '@cloudhelm/application';
import type { LocalScope, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost, RuntimeProfile } from '@cloudhelm/contracts/runtime';
import { TaskRunner } from './task-runner.js';

/** Measure the same native frame/tools as a fresh task, without registering a
 * task, opening SSH, reading a selected file, sending a model request or a prompt.
 * UUID lengths and the empty native projection match production first sessions. */
export async function initialContext(profile: RuntimeProfile, hosts: RuntimeHost[], scopes: LocalScope[], signal: AbortSignal) {
  signal.throwIfAborted();
  const unavailable = (): never => { throw new Error('首帧估算不能执行操作或发送请求'); };
  const task: TaskView = { id: randomUUID(), goal: '', hostIds: hosts.map((host) => host.id), localScopes: structuredClone(scopes),
    provider: profile.provider, modelId: profile.modelId, status: 'draft', requestCount: 0, requestLimit: 100, createdAt: 0, updatedAt: 0 };
  const terminal = new TerminalManager({ data: unavailable, state: unavailable, completed: unavailable });
  const runner = new TaskRunner(task, structuredClone(hosts), structuredClone(profile), [], terminal, { execute: unavailable },
    unavailable, { event: () => {}, budget: unavailable, requestApproval: unavailable, cancelApproval: unavailable }, unavailable,
    { request: unavailable, terminal: unavailable, scope: unavailable, owns: () => false, confirmed: () => [], close: () => {} });
  try {
    const snapshot = await runner.previewContext();
    signal.throwIfAborted();
    return { ...snapshot, modelIdle: true, remoteIdle: true };
  } finally { await runner.close(); }
}
