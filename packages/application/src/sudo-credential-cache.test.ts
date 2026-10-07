import { afterEach, describe, expect, it, vi } from 'vitest';
import { SudoCredentialCache } from './sudo-credential-cache.js';
const binding = { taskId: 'task', hostId: 'host', terminalId: 'terminal', terminalGeneration: 1,
  connectionGeneration: 1, policyRevision: 1, loginAs: 'user', runAs: 'root' };
afterEach(() => vi.useRealTimers());
describe('task-scoped verified sudo credential cache', () => {
  it('binds credentials to the task, host, identities, policy and both generations', () => {
    const cache = new SudoCredentialCache(); const buffer = Buffer.from('private-fixture');
    cache.remember(binding, buffer); buffer.fill(0); expect(cache.read(binding)).toBe('private-fixture');
    for (const key of Object.keys(binding) as Array<keyof typeof binding>) {
      const value = binding[key]; expect(cache.read({ ...binding, [key]: typeof value === 'number' ? value + 1 : value + '-other' })).toBeUndefined();
    }
    cache.clearTask('task'); expect(cache.read(binding)).toBeUndefined();
  });
  it('expires after five minutes without sliding the expiry on reads', () => {
    vi.useFakeTimers(); const cache = new SudoCredentialCache(); cache.remember(binding, Buffer.from('fixture'));
    vi.advanceTimersByTime(299_999); expect(cache.read(binding)).toBe('fixture');
    vi.advanceTimersByTime(2); expect(cache.read(binding)).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it('clears a terminal independently and replaces an old verified value', () => {
    const cache = new SudoCredentialCache(); cache.remember(binding, Buffer.from('old'));
    cache.remember(binding, Buffer.from('new')); cache.remember({ ...binding, taskId: 'other', terminalId: 'other' }, Buffer.from('other'));
    expect(cache.read(binding)).toBe('new'); cache.clearTerminal('terminal'); expect(cache.read(binding)).toBeUndefined();
    expect(cache.read({ ...binding, taskId: 'other', terminalId: 'other' })).toBe('other'); cache.clearTask('other');
  });
});
