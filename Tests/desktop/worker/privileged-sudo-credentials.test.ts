import { expect, it, vi } from 'vitest';
import type { InputRequestView } from '@cloudhelm/contracts';
import { SudoSessionCredentials, type SudoSessionCredentialContext } from '../../../apps/desktop/src/worker/privileged-sudo-credentials.js';

type SessionInputRequest = Omit<InputRequestView, 'id' | 'expiresAt'>;
const ask = (answer: () => string | null) => vi.fn(async (_request: SessionInputRequest) => answer());

const context = (overrides: Partial<SudoSessionCredentialContext> = {}): SudoSessionCredentialContext => ({
  taskId: 'task', hostId: 'host', hostLabel: 'Linux (192.0.2.1)', sessionId: 'session',
  command: 'sudo systemctl restart nginx', signal: new AbortController().signal, ...overrides
});

it('asks once with a bound secret request and reuses the answer within the TTL', async () => {
  const input = ask(() => 'session-password');
  const credentials = new SudoSessionCredentials({ input });
  expect(await credentials.obtain(context())).toBe('session-password');
  expect(await credentials.obtain(context({ command: 'sudo id' }))).toBe('session-password');
  expect(input).toHaveBeenCalledOnce();
  const request = input.mock.calls[0]![0];
  expect(request).toMatchObject({ taskId: 'task', hostId: 'host', operationId: 'sudo-session:session',
    kind: 'secret', title: 'sudo 会话需要密码' });
  expect(request.explanation).toContain('Linux (192.0.2.1)');
  expect(request.explanation).toContain('sudo systemctl restart nginx');
  expect(request.explanation).toContain('15 分钟');
  expect(request.explanation).not.toContain('session-password');
});

it('returns undefined and stays unprimed when the user declines or the answer cannot travel the channel', async () => {
  for (const answer of [null, '', 'x'.repeat(4096), 'line\nbreak', 'null\u0000byte']) {
    const input = ask(() => answer);
    const credentials = new SudoSessionCredentials({ input });
    expect(await credentials.obtain(context()), String(answer)).toBeUndefined();
    expect((await credentials.obtain(context())) ?? 'asked-again').not.toBe('line\nbreak');
    expect(input, String(answer)).toHaveBeenCalledTimes(2);
  }
});

it('sanitizes the reviewed command shown in the confirmation text', async () => {
  const input = ask(() => 'session-password');
  const credentials = new SudoSessionCredentials({ input });
  await credentials.obtain(context({ command: 'sudo\tid\x07' }));
  const explanation = input.mock.calls[0]![0].explanation as string;
  expect(explanation).not.toMatch(/[\u0007]/u);
  expect(explanation).toContain('sudo id');
});

it('asks again after the TTL expires so no secret outlives its bounded reuse window', async () => {
  const input = ask(() => 'session-password');
  const credentials = new SudoSessionCredentials({ input }, 15);
  await credentials.obtain(context());
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(await credentials.obtain(context())).toBe('session-password');
  expect(input).toHaveBeenCalledTimes(2);
});

it('drops the cached secret on rejection so a known-bad password is never replayed', async () => {
  const input = ask(() => 'rejected-password');
  const credentials = new SudoSessionCredentials({ input });
  await credentials.obtain(context());
  credentials.reject();
  expect(await credentials.obtain(context())).toBe('rejected-password');
  expect(input).toHaveBeenCalledTimes(2);
});

it('drops the cached secret when the session closes', async () => {
  const input = ask(() => 'session-password');
  const credentials = new SudoSessionCredentials({ input });
  await credentials.obtain(context());
  credentials.close();
  expect(await credentials.obtain(context())).toBe('session-password');
  expect(input).toHaveBeenCalledTimes(2);
});
