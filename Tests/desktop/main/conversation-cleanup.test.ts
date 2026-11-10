import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '@cloudhelm/adapters';
import { finishConversationCleanup, resumeConversationCleanup } from '../../../apps/desktop/src/main/conversation-cleanup.js';

const resources: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of resources.splice(0).reverse()) close(); });
function open(file: string) {
  const store = new SqliteStore(file); let active = true;
  const close = () => { if (active) { store.close(); active = false; } };
  resources.push(close); return { store, close };
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cloudhelm-deletion-test-'));
  resources.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'test.sqlite'), sessions = join(root, 'sessions');
  const directory = join(sessions, 'task'), foreign = join(root, 'foreign');
  mkdirSync(directory, { recursive: true }); mkdirSync(foreign);
  const native = join(directory, 'native.jsonl'), unrelated = join(foreign, 'keep.txt');
  writeFileSync(native, 'synthetic session'); writeFileSync(unrelated, 'synthetic unrelated data');
  const f = open(file); f.store.put('tasks', 'task', { id: 'task' });
  return { ...f, file, sessions, directory, native, foreign, unrelated };
}

describe('E01: filesystem cleanup redo', () => {
  it('leaves the native session untouched when the database transaction fails', async () => {
    const f = setup(), remove = f.store.remove.bind(f.store);
    vi.spyOn(f.store, 'remove').mockImplementation((bucket, id) => { remove(bucket, id); if (bucket === 'tasks') throw new Error('synthetic commit failure'); });
    expect(() => f.store.commitConversationDeletion('task', [], [], 'task')).toThrow('synthetic commit failure');
    expect(f.store.get('conversation-cleanups', 'task')).toBeUndefined();
    expect(f.store.get('tasks', 'task')).toEqual({ id: 'task' });
    expect(await finishConversationCleanup(f.store, f.sessions, 'task')).toBe(true);
    expect(existsSync(f.native)).toBe(true);
  });

  it('retries a failed directory removal after reopening the database without resurrecting records', async () => {
    const f = setup(); f.store.commitConversationDeletion('task', [], [], 'task');
    expect(await finishConversationCleanup(f.store, f.sessions, 'task', async () => { throw new Error('synthetic private path'); })).toBe(false);
    expect(existsSync(f.native)).toBe(true);
    f.close(); const restarted = open(f.file).store;
    expect(restarted.get('tasks', 'task')).toBeUndefined();
    expect(restarted.get('conversation-cleanups', 'task')).toBeDefined();
    expect(await resumeConversationCleanup(restarted, f.sessions)).toBe(0);
    expect(existsSync(f.native)).toBe(false);
    expect(existsSync(f.unrelated)).toBe(true);
    expect(restarted.get('conversation-cleanups', 'task')).toBeUndefined();
  });

  it('repeats cleanup safely when directory removal completed but acknowledgement failed', async () => {
    const f = setup(); f.store.commitConversationDeletion('task', [], [], 'task');
    vi.spyOn(f.store, 'remove').mockImplementation(() => { throw new Error('synthetic acknowledgement failure'); });
    expect(await finishConversationCleanup(f.store, f.sessions, 'task')).toBe(false);
    expect(existsSync(f.native)).toBe(false);
    expect(f.store.get('conversation-cleanups', 'task')).toBeDefined();
    vi.restoreAllMocks(); f.close(); const restarted = open(f.file).store;
    expect(await resumeConversationCleanup(restarted, f.sessions)).toBe(0);
    expect(await finishConversationCleanup(restarted, f.sessions, 'task')).toBe(true);
    expect(existsSync(f.unrelated)).toBe(true);
  });

  it.each(['path', 'owner', 'live'] as const)('refuses a cleanup receipt with invalid %s binding', async (kind) => {
    const f = setup(); f.store.commitConversationDeletion('task', [], [], 'task');
    if (kind === 'live') f.store.put('tasks', 'task', { id: 'task' });
    else f.store.put('conversation-cleanups', 'task', { version: 1, taskId: kind === 'owner' ? 'foreign' : 'task', sessionId: kind === 'path' ? '../foreign' : 'task', createdAt: 1 });
    await expect(finishConversationCleanup(f.store, f.sessions, 'task')).rejects.toThrow('ownership');
    expect(existsSync(f.native)).toBe(true); expect(existsSync(f.unrelated)).toBe(true);
  });

  it('does not traverse a replaced session root junction/symlink', async () => {
    const f = setup(); f.store.commitConversationDeletion('task', [], [], 'task');
    rmSync(f.directory, { recursive: true }); symlinkSync(f.foreign, f.directory, 'junction');
    expect(await finishConversationCleanup(f.store, f.sessions, 'task')).toBe(false);
    expect(existsSync(f.unrelated)).toBe(true);
    expect(f.store.get('conversation-cleanups', 'task')).toBeDefined();
  });

  it('refuses a substituted pi-sessions parent junction/symlink', async () => {
    const f = setup(); f.store.commitConversationDeletion('task', [], [], 'task');
    rmSync(f.sessions, { recursive: true });
    mkdirSync(join(f.foreign, 'task')); writeFileSync(join(f.foreign, 'task', 'keep.txt'), 'keep');
    symlinkSync(f.foreign, f.sessions, 'junction');
    expect(await finishConversationCleanup(f.store, f.sessions, 'task')).toBe(false);
    expect(existsSync(join(f.foreign, 'task', 'keep.txt'))).toBe(true);
    expect(f.store.get('conversation-cleanups', 'task')).toBeDefined();
  });

  it('removes legacy records without guessing a native session path', async () => {
    const f = setup(); f.store.commitConversationDeletion('task', [], []);
    expect(await finishConversationCleanup(f.store, f.sessions, 'task')).toBe(true);
    expect(existsSync(f.native)).toBe(true); expect(existsSync(f.unrelated)).toBe(true);
  });
});
