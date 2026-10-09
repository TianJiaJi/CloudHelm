import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import { ReferenceStore } from './reference-store.js';
import type { AppState } from './app-state.js';
const stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = new SqliteStore(':memory:'); stores.push(store);
  const state = { snapshot: () => ({ terminals: [{ id: 'term', hostId: 'host' }] }), getHost: () => ({ label: 'Production' }), getTask: () => ({ hostIds: ['host'] }) } as unknown as AppState;
  const refs = new ReferenceStore(store, state);
  return { refs, store, quote: () => refs.quote({ terminalId: 'term', hostId: 'host' }) };
}
describe('terminal reference snapshots', () => {
  it('requires a selection when boundaries are unknown', () => {
    const f = setup(); expect(f.quote).toThrow('请先');
    const ref = f.refs.quote({ terminalId: 'term', hostId: 'host', selection: 'selected\noutput' });
    expect(f.refs.read(ref.id).original).toBe('selected\noutput');
  });
  it('captures more than 1 MB without old tail limits and keeps immutable running snapshots', () => {
    const f = setup(); f.refs.record({ type: 'terminal-command', terminalId: 'term', generation: 3, phase: 'start', command: 'cat huge.log' });
    const data = 'line\n'.repeat(230000);
    f.refs.record({ type: 'terminal-data', terminalId: 'term', data });
    const first = f.quote(); expect(first.running).toBe(true); expect(first.generation).toBe(3);
    f.refs.record({ type: 'terminal-data', terminalId: 'term', data: 'last\n' });
    f.refs.record({ type: 'terminal-command', terminalId: 'term', generation: 3, phase: 'end', exitCode: 0 });
    const second = f.quote();
    expect(f.refs.read(first.id).original).toBe('$ cat huge.log\n' + data);
    expect(f.refs.read(second.id).original).toBe('$ cat huge.log\n' + data + 'last\n');
    expect(second.running).toBe(false);
  });
  it('preserves complete interactive sessions, excludes later prompts, and redacts split secrets', () => {
    const f = setup(); f.refs.record({ type: 'terminal-command', terminalId: 'term', generation: 1, phase: 'start', command: 'python3' });
    f.refs.record({ type: 'terminal-data', terminalId: 'term', data: '>>> bad\nNameError\n>>> other\nNameError\npassword="sec' });
    f.refs.record({ type: 'terminal-data', terminalId: 'term', data: 'ret"\n' });
    f.refs.record({ type: 'terminal-command', terminalId: 'term', generation: 1, phase: 'end' });
    f.refs.record({ type: 'terminal-data', terminalId: 'term', data: 'prompt$ ' });
    const text = f.refs.read(f.quote().id).original;
    expect(text).toContain('>>> bad\nNameError\n>>> other'); expect(text).not.toContain('secret'); expect(text).not.toContain('prompt$');
  });
  it('keeps long single lines across chunks and supports commands with no output', () => {
    const f = setup();
    f.refs.record({ type: 'terminal-command', terminalId: 'term', generation: 1, phase: 'start', command: 'true' });
    f.refs.record({ type: 'terminal-command', terminalId: 'term', generation: 1, phase: 'end', exitCode: 0 });
    expect(f.refs.read(f.quote().id).original).toBe('$ true\n');
    f.refs.record({ type: 'terminal-command', terminalId: 'term', generation: 1, phase: 'start', command: 'print json' });
    const chunk = 'x'.repeat(600000);
    f.refs.record({ type: 'terminal-data', terminalId: 'term', data: chunk });
    f.refs.record({ type: 'terminal-data', terminalId: 'term', data: chunk });
    expect(f.refs.read(f.quote().id).original).toBe('$ print json\n' + chunk + chunk);
    f.refs.record({ type: 'terminal-command', terminalId: 'term', generation: 1, phase: 'end', exitCode: 0 });
    expect(f.refs.read(f.quote().id).original).toBe('$ print json\n' + chunk + chunk);
  });
});
