import { describe, expect, it, vi } from 'vitest';
import type { AppSnapshot } from '@cloudhelm/contracts';
import { AppShutdown } from '../../../apps/desktop/src/main/app-shutdown.js';

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

  it('asks before destroying a non-macOS window and preserves it when cancelled', async () => {
    const f = fixture(true);
    f.shutdown.beforeWindowClose(f.event, false);
    expect(f.event.preventDefault).toHaveBeenCalledOnce();
    f.answer(false); await Promise.resolve(); await Promise.resolve();
    expect(f.quit).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
    expect(f.snapshot()).toBeDefined();
  });

  it('permits the confirmed quit to re-enter both window-close and before-quit without another prompt', async () => {
    const f = fixture(true);
    f.quit.mockImplementation(() => {
      f.shutdown.beforeQuit(f.event); f.shutdown.beforeWindowClose(f.event, false); f.shutdown.willQuit();
    });
    f.shutdown.beforeWindowClose(f.event, false); f.answer(true); await Promise.resolve();
    expect(f.event.preventDefault).toHaveBeenCalledOnce(); expect(f.confirmExit).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
  });

  it('does not equate macOS window closure with application quit or remote exit', () => {
    const f = fixture(true); f.shutdown.beforeWindowClose(f.event, true);
    expect(f.event.preventDefault).not.toHaveBeenCalled(); expect(f.confirmExit).not.toHaveBeenCalled();
    expect(f.quit).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });

  it('prompts for an answered conversation with an unobserved background exit even without a live terminal', () => {
    const f = fixture();
    f.snapshot.mockReturnValue({ conversations: [{ status: 'answered' }], terminals: [], operations: [{ status: 'unknown',
      executionJob: { status: 'unknown', exitObserved: false } }] } as unknown as AppSnapshot);
    f.shutdown.beforeWindowClose(f.event, false);
    expect(f.event.preventDefault).toHaveBeenCalledOnce(); expect(f.confirmExit).toHaveBeenCalledOnce();
    expect(f.quit).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });

  it.each([{ exitObserved: true }, { exitObserved: false, notStarted: 'denied' }])('does not invent a live job from an ended observation %s', (job) => {
    const f = fixture(); f.snapshot.mockReturnValue({ conversations: [], terminals: [], operations: [{ status: 'succeeded', executionJob: job }] } as unknown as AppSnapshot);
    f.shutdown.beforeWindowClose(f.event, false); expect(f.confirmExit).not.toHaveBeenCalled(); expect(f.event.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores a dialog answer delivered after resources were already closed', async () => {
    const f = fixture(true);
    f.shutdown.beforeQuit(f.event); f.shutdown.willQuit(); f.answer(true);
    await Promise.resolve();
    expect(f.quit).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
  });
});
