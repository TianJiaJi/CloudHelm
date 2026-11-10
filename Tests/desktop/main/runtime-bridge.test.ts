import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeBridge } from '../../../apps/desktop/src/main/runtime-bridge.js';
import { createRequestBudget, reserveRoundRequest } from '@cloudhelm/core';

const fixture = vi.hoisted(() => ({ child: undefined as unknown as import('node:events').EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>
} }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { utilityProcess: { fork: () => {
    fixture.child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
    return fixture.child;
  } } };
});
afterEach(() => vi.useRealTimers());

function setup(budget?: ConstructorParameters<typeof RuntimeBridge>[4], commit?: ConstructorParameters<typeof RuntimeBridge>[5], inputCommit?: ConstructorParameters<typeof RuntimeBridge>[6]) {
  const onEvent = vi.fn(); const readLog = vi.fn(() => ({ text: '', nextCursor: 0, more: false })); const stopped = vi.fn();
  const bridge = new RuntimeBridge(onEvent, readLog, stopped, undefined, budget, commit, inputCommit);
  return { bridge, onEvent, readLog, stopped, child: fixture.child };
}

describe('budget acknowledgments', () => {
  const query = { budgetRequest: { id: 'rpc', command: { kind: 'current', taskId: 'task' } } };
  it('fails closed if no budget authority is assembled or the authority fails', () => {
    const missing = setup(); missing.child.emit('message', query);
    expect(missing.child.postMessage).toHaveBeenLastCalledWith({ budgetResult: { id: 'rpc', error: 'budget-unavailable' } });
    missing.bridge.close();
    const failed = setup(() => { throw new Error('private storage details'); }); failed.child.emit('message', query);
    expect(failed.child.postMessage).toHaveBeenLastCalledWith({ budgetResult: { id: 'rpc', error: 'budget-unavailable' } });
    failed.bridge.close();
  });
  it('does not retry or undo a committed reservation when sending its acknowledgment fails', () => {
    let committed = createRequestBudget('round');
    const authority = vi.fn(() => {
      committed = reserveRoundRequest(committed);
      return { value: { kind: 'reserve' as const, taskId: 'task', budget: committed, duplicate: false } };
    });
    const request = { budgetRequest: { id: 'rpc', command: { kind: 'reserve', taskId: 'task', roundId: 'round',
      attempt: { logicalRequestId: 'logical', attempt: 1, purpose: 'conversation', transport: 'http' } } } };
    const f = setup(authority);
    f.child.postMessage.mockImplementation(() => { throw new Error('channel closed'); });
    expect(() => f.child.emit('message', request)).not.toThrow();
    expect(authority).toHaveBeenCalledOnce(); expect(f.child.postMessage).toHaveBeenCalledOnce();
    expect(committed.roundUsed).toBe(1);
    f.bridge.close(); f.child.emit('message', request);
    expect(authority).toHaveBeenCalledOnce(); expect(committed.roundUsed).toBe(1);
  });
});

describe('operation persistence acknowledgments', () => {
  const value = { id: 'op', taskId: 'task', hostId: 'host', kind: 'command', preview: 'synthetic', status: 'running', createdAt: 1 };
  const query = { commitOperation: { id: 'commit', value } };
  it('does not confuse a UI event with a durable authority', () => {
    const f = setup(); f.child.emit('message', query);
    expect(f.onEvent).not.toHaveBeenCalled();
    expect(f.child.postMessage).toHaveBeenCalledWith({ operationCommitResult: { id: 'commit', taskId: 'task', operationId: 'op', committed: false } });
    f.bridge.close();
  });
  it('acknowledges only after synchronous persistence and never retries a lost reply', () => {
    const authority = vi.fn(), f = setup(undefined, authority);
    f.child.postMessage.mockImplementation((message) => {
      expect(authority).toHaveBeenCalledWith(value);
      expect(message.operationCommitResult.committed).toBe(true);
      throw new Error('channel closed');
    });
    expect(() => f.child.emit('message', query)).not.toThrow();
    expect(authority).toHaveBeenCalledOnce(); expect(f.child.postMessage).toHaveBeenCalledOnce();
    f.bridge.close();
  });
  it('fails closed without returning storage details', () => {
    const f = setup(undefined, () => { throw new Error('private disk path'); });
    f.child.emit('message', query);
    expect(f.child.postMessage).toHaveBeenCalledWith({ operationCommitResult: { id: 'commit', taskId: 'task', operationId: 'op', committed: false } });
    f.bridge.close();
  });
});

describe('queued input commit acknowledgments', () => {
  const value = { version: 1, id: 'input', taskId: 'task', kind: 'followUp', status: 'queued', text: 'prepared',
    intent: 'user input', authorizationKey: 'scope', createdAt: 1, updatedAt: 1, expiresAt: 100 };
  it('requires Main persistence rather than an event handler', () => {
    const f = setup(); f.child.emit('message', { commitInput: { id: 'rpc', value } });
    expect(f.onEvent).not.toHaveBeenCalled();
    expect(f.child.postMessage).toHaveBeenCalledWith({ inputCommitResult: { id: 'rpc', taskId: 'task', inputId: 'input', committed: false } });
    f.bridge.close();
  });
  it('confirms the exact recipient only after persistence', () => {
    const commit = vi.fn(), f = setup(undefined, undefined, commit);
    f.child.postMessage.mockImplementation((message) => {
      expect(commit).toHaveBeenCalledWith(value);
      expect(message).toEqual({ inputCommitResult: { id: 'rpc', taskId: 'task', inputId: 'input', committed: true } });
    });
    f.child.emit('message', { commitInput: { id: 'rpc', value } });
    expect(commit).toHaveBeenCalledOnce(); f.bridge.close();
  });
});

describe('runtime shutdown', () => {
  it('rejects pending calls immediately and discards late events and log reads', async () => {
    vi.useFakeTimers();
    const f = setup();
    const call = f.bridge.call({ method: 'has-task', taskId: 'task' });
    const rejected = expect(call).rejects.toThrow('runtime stopped');
    f.bridge.close(); f.bridge.close();
    await rejected;
    f.child.emit('message', { event: { type: 'task-status', taskId: 'task', status: 'paused' } });
    f.child.emit('message', { readLog: { id: 'late', taskId: 'task', operationId: 'op', cursor: 0 } });
    f.child.emit('exit', 0);
    expect(f.onEvent).not.toHaveBeenCalled(); expect(f.readLog).not.toHaveBeenCalled(); expect(f.stopped).not.toHaveBeenCalled();
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    await expect(f.bridge.call({ method: 'has-task', taskId: 'new' })).rejects.toThrow('已停止');
    expect(f.child.postMessage).toHaveBeenCalledOnce();
  });

  it('still records an unexpected runtime crash once while the app is open', () => {
    const f = setup();
    f.child.emit('exit', 1); f.child.emit('exit', 1);
    expect(f.stopped).toHaveBeenCalledOnce();
    f.bridge.close(); expect(f.child.kill).not.toHaveBeenCalled();
  });

  it('cleans up its timeout if sending a request fails', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.child.postMessage.mockImplementation(() => { throw new Error('IPC channel closed'); });
    await expect(f.bridge.call({ method: 'has-task', taskId: 'task' })).rejects.toThrow('不可用');
    expect(vi.getTimerCount()).toBe(0);
    f.bridge.close();
  });
});
