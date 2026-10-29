import { expect, it } from 'vitest';
import { PrivilegedSessions } from '../../packages/application/src/privileged-sessions.js';
it('keeps sudo prepared distinct from an authenticated root login, binds ownership and revokes', () => {
  const sessions = new PrivilegedSessions(); const context = sessions.begin('task', 'host', 'sudo');
  expect(sessions.get(context.id, 'task', 'host')).toMatchObject({ mode: 'sudo', status: 'prepared' });
  expect(() => sessions.activate(context.id, 'task', 'host')).toThrow('never become');
  expect(() => sessions.get(context.id, 'other', 'host')).toThrow(); expect(() => sessions.get(context.id, 'task', 'other')).toThrow();
  sessions.closeTask('task'); expect(context.controller.signal.aborted).toBe(true);
  expect(() => sessions.get(context.id, 'task', 'host')).toThrow();
});
it.each(['ssh', 'su'] as const)('still requires %s identity verification before activation', (method) => {
  const sessions = new PrivilegedSessions(), context = sessions.begin('task', 'host', method);
  expect(() => sessions.get(context.id, 'task', 'host')).toThrow();
  sessions.activate(context.id, 'task', 'host'); expect(sessions.get(context.id, 'task', 'host').status).toBe('ready'); sessions.close(context.id);
});
