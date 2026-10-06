import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeBridge } from './runtime-bridge.js';

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

function setup() {
  const onEvent = vi.fn(); const readLog = vi.fn(() => ({ text: '', nextCursor: 0, more: false })); const stopped = vi.fn();
  const bridge = new RuntimeBridge(onEvent, readLog, stopped);
  return { bridge, onEvent, readLog, stopped, child: fixture.child };
}

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
