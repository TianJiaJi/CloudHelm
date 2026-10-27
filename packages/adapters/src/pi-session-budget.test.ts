import { afterEach, expect, it, vi } from 'vitest';
import type { SessionOptions } from '@cloudhelm/core';
import { createConversationSession } from './pi-session.js';
import { openAiFixture } from './pi-session-fixture.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(beforeRequest: SessionOptions['beforeRequest'], assertActive = () => {}) {
  const fixture = await openAiFixture(async () => ({ text: 'Local fixture answer.' })); cleanups.push(fixture.close);
  const session = await createConversationSession({
    profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl },
    systemPrompt: 'Local-only request boundary fixture.', tools: [], clarification: { ask: async () => [] },
    assertActive, beforeRequest, event() {}
  });
  cleanups.push(() => session.dispose());
  return { session, fixture };
}
function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const entered = vi.fn(async () => pending);
  return { release, entered };
}
it('waits for the asynchronous pre-dispatch acknowledgment before any provider request', async () => {
  const ack = gate(); const f = await setup(ack.entered);
  const prompt = f.session.prompt('Explain SSH.');
  try {
    await vi.waitFor(() => expect(ack.entered).toHaveBeenCalledOnce());
    expect(f.fixture.requests).toHaveLength(0);
    expect(ack.entered).toHaveBeenCalledWith('conversation', expect.objectContaining({ provider: 'cloudhelm-custom' }),
      expect.objectContaining({ purpose: 'conversation', transport: 'http', attempt: 1 }), expect.any(AbortSignal));
  } finally { ack.release(); }
  await prompt; expect(f.fixture.requests).toHaveLength(1);
});
it('sends nothing when durable confirmation fails', async () => {
  const f = await setup(async () => { throw new Error('budget confirmation failed'); });
  await expect(f.session.prompt('Explain SSH.')).rejects.toThrow('budget confirmation failed');
  expect(f.fixture.requests).toHaveLength(0);
});
it('rechecks cancellation after a delayed acknowledgment rather than dispatching a stopped request', async () => {
  const ack = gate(); const f = await setup(ack.entered);
  const prompt = f.session.prompt('Explain SSH.');
  const rejected = expect(prompt).rejects.toThrow();
  await vi.waitFor(() => expect(ack.entered).toHaveBeenCalledOnce());
  const stopped = f.session.abort(); ack.release();
  await stopped; await rejected;
  expect(f.fixture.requests).toHaveLength(0);
});
it('propagates native cancellation into an indefinitely pending reservation without waiting for its acknowledgment', async () => {
  const entered = vi.fn();
  const f = await setup((_purpose, _profile, _attempt, signal) => new Promise<void>((_resolve, reject) => {
    entered();
    if (!signal) { reject(new Error('missing cancellation signal')); return; }
    signal.addEventListener('abort', () => reject(new DOMException('reservation cancelled', 'AbortError')), { once: true });
  }));
  const prompt = f.session.prompt('Explain SSH.'); const rejected = expect(prompt).rejects.toThrow();
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  await f.session.abort(); await rejected;
  expect(f.fixture.requests).toHaveLength(0);
});
it('rechecks backend activity after confirmation and does not treat acknowledgment as continuing authority', async () => {
  const ack = gate(); let active = true;
  const f = await setup(ack.entered, () => { if (!active) throw new Error('backend activity revoked'); });
  const prompt = f.session.prompt('Explain SSH.');
  const rejected = expect(prompt).rejects.toThrow('backend activity revoked');
  await vi.waitFor(() => expect(ack.entered).toHaveBeenCalledOnce());
  active = false; ack.release(); await rejected;
  expect(f.fixture.requests).toHaveLength(0);
});
