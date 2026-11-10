import { expect, it, vi } from 'vitest';
import type { RawTerminal } from '@cloudhelm/core';
import { TerminalManager } from '../../packages/application/src/terminal-manager.js';

function fixture(taskId?: string) {
  let emit = (_directory: string) => {}, closed = () => {};
  const raw: RawTerminal = { write() {}, resize() {}, close: () => closed(), onData() {}, onClose: (listener) => { closed = listener; }, onCwd: (listener) => { emit = listener; } };
  const cwd = vi.fn(), manager = new TerminalManager({ cwd, data() {}, state() {} });
  const id = manager.open('host', raw, taskId, '/login');
  return { manager, id, cwd, emit: (directory: string) => emit(directory) };
}
it('records real manual cwd independently of frontend follow preferences', () => {
  const f = fixture(); f.emit('/srv/project'); expect(f.manager.workingDirectory(f.id)).toBe('/srv/project');
  expect(f.cwd).toHaveBeenCalledExactlyOnceWith(f.id, '/srv/project'); expect(f.manager.isAgentOwner(f.id)).toBe(false);
});
it('does not let terminal output rewrite an Agent working directory or lease', () => {
  const f = fixture('task'), generation = f.manager.currentGeneration(f.id);
  f.emit('/unapproved'); expect(f.manager.workingDirectory(f.id)).toBe('/login');
  expect(f.manager.currentGeneration(f.id)).toBe(generation); expect(f.cwd).not.toHaveBeenCalled();
  f.manager.takeOver(f.id); f.emit('/still-unapproved'); expect(f.manager.workingDirectory(f.id)).toBe('/login'); expect(f.cwd).not.toHaveBeenCalled();
});
it('ignores invalid paths and late updates after terminal closure', () => {
  const f = fixture(); for (const path of ['relative', '/line\nbreak', '/nul\0byte', '/'+ 'a'.repeat(4096)]) f.emit(path);
  expect(f.cwd).not.toHaveBeenCalled(); f.manager.close(f.id); f.emit('/late'); expect(f.cwd).not.toHaveBeenCalled();
});
