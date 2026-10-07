import { describe, expect, it, vi } from 'vitest';
import type { AppSnapshot } from '@cloudhelm/contracts';
import { AppShutdown } from './app-shutdown.js';

function fixture(active = false) {
  let closed = false;
  const snapshot = vi.fn(() => {
    if (closed) throw new Error('The database connection is not open');
    return { conversations: active ? [{ status: 'running' }] : [], operations: [], terminals: [] } as unknown as AppSnapshot;
  });
  let answer!: (value: boolean) => void;
  const confirmExit = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
  const quit = vi.fn();
  const close = vi.fn(() => { closed = true; });
  const shutdown = new AppShutdown({ snapshot, confirmExit, quit, close });
  const event = { preventDefault: vi.fn() };
  return { shutdown, snapshot, confirmExit, quit, close, event, answer: (value: boolean) => answer(value) };
}

describe('application shutdown ordering', () => {
  it('keeps the database open throughout before-quit and closes exactly once at will-quit', () => {
    const f = fixture();
    f.shutdown.beforeQuit(f.event); f.shutdown.beforeQuit(f.event);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.snapshot).toHaveBeenCalledTimes(2);
    f.shutdown.willQuit(); f.shutdown.willQuit();
    expect(() => f.shutdown.beforeQuit(f.event)).not.toThrow();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.snapshot).toHaveBeenCalledTimes(2);
  });

  it('leaves all resources usable when another listener cancels an idle quit', () => {
    const f = fixture();
    f.shutdown.beforeQuit(f.event);
    f.event.preventDefault(); // e.g. a window close handler
    expect(f.snapshot()).toBeDefined();
    expect(f.close).not.toHaveBeenCalled();
  });

  it('opens only one prompt and keeps the database open when the user stays', async () => {
    const f = fixture(true);
    f.shutdown.beforeQuit(f.event); f.shutdown.beforeQuit(f.event);
    expect(f.confirmExit).toHaveBeenCalledOnce();
    expect(f.snapshot).toHaveBeenCalledOnce();
    f.answer(false);
    await vi.waitFor(() => expect(f.quit).not.toHaveBeenCalled(), { timeout: 15000 });
    expect(f.snapshot()).toBeDefined(); expect(f.close).not.toHaveBeenCalled();
  });

  it('does not read the database again when confirming exit re-enters before-quit', async () => {
    const f = fixture(true);
    f.quit.mockImplementation(() => { f.shutdown.beforeQuit(f.event); f.shutdown.willQuit(); });
    f.shutdown.beforeQuit(f.event); f.answer(true);
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce(), { timeout: 15000 });
    expect(() => f.shutdown.beforeQuit(f.event)).not.toThrow();
    expect(f.snapshot).toHaveBeenCalledOnce();
  });

  it('ignores a dialog answer delivered after resources were already closed', async () => {
    const f = fixture(true);
    f.shutdown.beforeQuit(f.event); f.shutdown.willQuit(); f.answer(true);
    await Promise.resolve();
    expect(f.quit).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
  });
});
