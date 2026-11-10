import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { SuSession } from '../../packages/adapters/src/su-session.js';
import type { SshTransport } from '../../packages/adapters/src/ssh-transport.js';
class Broker extends EventEmitter {
  stderr = new EventEmitter(); writes: string[] = [];
  write(value: string): void { this.writes.push(value); }
  end(): void {} close(): void { this.emit('close'); }
  event(value: unknown): void { this.emit('data', Buffer.from(`${JSON.stringify(value)}\n`)); }
}
function fixture() {
  const broker = new Broker(), controller = new AbortController(), closed = vi.fn();
  const ssh = { connectionGeneration: () => 1, prepareCommandProgram: async () => '/tmp/fixture/process.py',
    removeCommandProgram: async () => {}, openPipe: async () => broker } as unknown as SshTransport;
  const session = new SuSession(ssh, 'host', controller.signal, closed);
  return { broker, controller, session, closed, listening: () => vi.waitFor(() => expect(broker.listenerCount('data')).toBe(1)) };
}
it.each(['timeout', 'unsupported', 'cancelled', 'authentication-unconfirmed', 'transport-unavailable', 'attempts-exhausted'] as const)(
  'preserves safe su protocol code %s without echoing remote bodies', async (code) => {
    const f = fixture(); const pending = f.session.connect(async () => 'synthetic-only', () => {});
    const check = expect(pending).rejects.toMatchObject({ feedback: { method: 'su', code, businessCommand: 'not-started', source: 'transport' } });
    await f.listening(); f.broker.event({ type: 'error', code, detail: 'private-untrusted-body' }); await check;
    expect(f.closed).toHaveBeenCalledOnce(); expect(f.broker.writes).toEqual([]);
    await expect(f.session.openPipe()).rejects.toThrow('expired');
  });
it('requests no password when the isolated su channel establishes UID 0 without a challenge', async () => {
  const f = fixture(), ask = vi.fn(async () => 'not-needed'); const pending = f.session.connect(ask, () => {});
  await f.listening(); f.broker.event({ type: 'ready', uid: 0 }); await pending;
  expect(ask).not.toHaveBeenCalled(); expect(f.broker.writes).toEqual([]); f.session.close();
});
it('accepts successive bounded authentication challenges but rejects replayed challenge IDs', async () => {
  const f = fixture(), ask = vi.fn(async (id: string) => `synthetic-${id}`); const pending = f.session.connect(ask, () => {});
  const rejected = expect(pending).rejects.toMatchObject({ feedback: { code: 'authentication-unconfirmed' } });
  await f.listening();
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.broker.event({ type: 'auth', id: String(attempt) });
    await vi.waitFor(() => expect(f.broker.writes).toHaveLength(attempt));
  }
  f.broker.event({ type: 'auth', id: '3' }); await rejected;
  expect(ask).toHaveBeenCalledTimes(3); expect(f.broker.writes).toHaveLength(3);
});
it('rejects cancellation promptly and discards a late credential', async () => {
  const f = fixture(); let answer!: (value: string) => void;
  const pending = f.session.connect(() => new Promise((resolve) => { answer = resolve; }), () => {});
  const check = expect(pending).rejects.toMatchObject({ feedback: { code: 'cancelled' } });
  await f.listening(); f.broker.event({ type: 'auth', id: '1' });
  f.controller.abort(); answer('late-synthetic-password'); await check;
  expect(f.broker.writes).toEqual([]); expect(f.closed).toHaveBeenCalledOnce();
});
it('does not label arbitrary stderr or malformed protocol as a wrong password', async () => {
  const f = fixture(); const pending = f.session.connect(async () => null, () => {});
  const check = expect(pending).rejects.toMatchObject({ feedback: { code: 'unsupported' } });
  await f.listening(); f.broker.stderr.emit('data', Buffer.from('private-untrusted-body')); await check;
});
it('validates root UID and never forwards an answer after the root channel is ready', async () => {
  const f = fixture(); let answer!: (value: string) => void;
  const pending = f.session.connect(() => new Promise((resolve) => { answer = resolve; }), () => {});
  await f.listening(); f.broker.event({ type: 'auth', id: '1' }); f.broker.event({ type: 'ready', uid: 0 }); await pending;
  answer('late-synthetic-password'); await Promise.resolve(); expect(f.broker.writes).toEqual([]); f.session.close();
  const bad = fixture(); const rejected = bad.session.connect(async () => null, () => {});
  const check = expect(rejected).rejects.toMatchObject({ feedback: { code: 'authentication-unconfirmed' } });
  await bad.listening(); bad.broker.event({ type: 'ready', uid: 1000 }); await check;
});
