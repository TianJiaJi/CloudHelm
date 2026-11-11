import { describe, expect, it, vi } from 'vitest';
import { acquireProfileLock } from '../../../apps/desktop/src/main/profile-instance.js';

describe('exclusive profile startup', () => {
  it('exits a secondary instance without registering activation or granting ownership', () => {
    const app = { requestSingleInstanceLock: vi.fn(() => false), quit: vi.fn(), on: vi.fn() }, activate = vi.fn();
    expect(acquireProfileLock(app, activate)).toBe(false);
    expect(app.quit).toHaveBeenCalledOnce(); expect(app.on).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled();
  });
  it('only activates the primary window and does not consume secondary arguments', () => {
    const app = { requestSingleInstanceLock: vi.fn(() => true), quit: vi.fn(), on: vi.fn() }, activate = vi.fn();
    expect(acquireProfileLock(app, activate)).toBe(true);
    const callback = app.on.mock.calls[0]![1] as (...args: unknown[]) => void;
    callback({}, ['synthetic argument not interpreted'], 'synthetic directory', { synthetic: 'data' });
    expect(activate).toHaveBeenCalledExactlyOnceWith(); expect(app.quit).not.toHaveBeenCalled();
  });
  it('fails closed without echoing native details on a lock error', () => {
    const app = { requestSingleInstanceLock: () => { throw new Error('SYNTHETIC_PRIVATE_PATH'); }, quit: vi.fn(), on: vi.fn() };
    expect(() => acquireProfileLock(app, vi.fn())).toThrow('未打开数据库');
    try { acquireProfileLock(app, vi.fn()); } catch (error) { expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_PATH'); }
    expect(app.on).not.toHaveBeenCalled();
  });
});
