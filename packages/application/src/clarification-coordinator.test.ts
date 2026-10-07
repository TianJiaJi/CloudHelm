import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClarificationRequest } from '@cloudhelm/core';
import { ClarificationCoordinator } from './clarification-coordinator.js';
const questions = [{ id: 'scope', prompt: '部署到哪个环境？', options: [{ value: 'test', label: '测试' }, { value: 'prod', label: '生产' }] }];
function setup(timeout = 86400000) {
  const changed: ClarificationRequest[] = [];
  const interrupted = vi.fn();
  const coordinator = new ClarificationCoordinator('task', (request) => changed.push(request), interrupted, timeout);
  return { coordinator, changed, interrupted };
}
afterEach(() => vi.useRealTimers());
describe('clarification lifecycle', () => {
  it('validates answers, keeps the request on errors, and rejects stale/duplicate submissions', async () => {
    const { coordinator, changed } = setup();
    const result = coordinator.ask('tool', questions);
    const id = changed[0]!.id;
    expect(() => coordinator.answer('other', [])).toThrow('失效');
    expect(() => coordinator.answer(id, [{ id: 'scope', value: 'unknown' }])).toThrow('失效');
    expect(() => coordinator.answer(id, [{ id: 'scope', value: 'sk-1234567890abcdefghijklmnop', custom: true }])).toThrow('密钥');
    await expect(coordinator.ask('tool-2', questions)).rejects.toThrow('已有');
    coordinator.answer(id, [{ id: 'scope', value: 'test' }]);
    expect(await result).toEqual([{ id: 'scope', value: 'test', custom: false }]);
    expect(changed.at(-1)?.status).toBe('answered');
    expect(() => coordinator.answer(id, [{ id: 'scope', value: 'prod' }])).toThrow('失效');
  });
  it('cancels on abort before the tool rejection can resume the model', async () => {
    const { coordinator, changed, interrupted } = setup();
    const signal = new AbortController();
    const result = coordinator.ask('tool', questions, signal.signal);
    signal.abort();
    expect(interrupted).toHaveBeenCalledOnce();
    await expect(result).rejects.toThrow('用户取消');
    expect(changed.at(-1)?.status).toBe('cancelled');
  });
  it('expires instead of choosing defaults and rejects old runtime IDs', async () => {
    vi.useFakeTimers();
    const { coordinator, changed, interrupted } = setup(1000);
    const result = coordinator.ask('tool', questions).catch((error: Error) => error.message);
    vi.advanceTimersByTime(1000);
    expect(await result).toContain('过期');
    expect(interrupted).toHaveBeenCalledOnce();
    expect(changed.at(-1)?.status).toBe('expired');
    const next = setup();
    expect(() => next.coordinator.answer(changed[0]!.id, [])).toThrow('失效');
  });
  it('rejects credential prompts and malformed/duplicate question IDs', () => {
    const { coordinator } = setup();
    expect(() => coordinator.ask('tool', [{ id: 'secret', prompt: '请填写密码' }])).toThrow('凭据');
    expect(() => coordinator.ask('tool', [...questions, ...questions])).toThrow('重复');
  });
});
