import { expect, it } from 'vitest';
import type { AgentLifecycleObservation, RunObservation, ToolObservation, RequestObservation } from '@cloudhelm/contracts';
import { AgentActivityStore } from '../../../apps/desktop/src/main/agent-activity-store.js';
const run: RunObservation = { kind: 'run', runId: 'run', status: 'running', startedAt: 1, observedAt: 1 };
const tool: ToolObservation = { kind: 'tool', runId: 'run', callId: 'call', nativeId: 'sha256:abc', name: 'query', status: 'running', startedAt: 2, observedAt: 2, updates: 0 };
const request: RequestObservation = { kind: 'request', logicalRequestId: 'request', attempt: 1, purpose: 'compaction', provider: 'fixture', modelId: 'fixture', status: 'running', startedAt: 1, observedAt: 1 };

it('keeps detached bounded observations without granting terminal, operation or budget authority', () => {
  const store = new AgentActivityStore();
  expect(store.accept('task', run)).toBe(true); expect(store.accept('task', tool)).toBe(true);
  const snapshot = store.snapshot(); snapshot.task!.tools[0]!.name = 'tampered';
  expect(store.snapshot().task!.tools[0]!.name).toBe('query');
  expect(store.accept('task', { ...tool, status: 'complete', observedAt: 3 })).toBe(true);
  expect(store.accept('task', tool)).toBe(false);
  expect(store.accept('task', { ...run, status: 'settled', aborted: false, observedAt: 4 })).toBe(true);
  expect(store.snapshot().task).not.toHaveProperty('remote');
  expect(store.snapshot().task).not.toHaveProperty('approved');
  expect(store.snapshot().task!.tools[0]!.status).toBe('complete');
});

it('rejects extra private fields, invalid numbers, unknown parents and changed recipients', () => {
  const store = new AgentActivityStore(); store.accept('task', run); store.accept('task', tool);
  for (const value of [{ ...tool, secret: 'PRIVATE' }, { ...tool, observedAt: NaN }, { ...tool, name: 'different' },
    { ...tool, callId: 'child', parentCallId: 'foreign' }, { ...request, cost: { usd: 0, source: 'unknown' } }]) {
    expect(store.accept('task', value as AgentLifecycleObservation)).toBe(false);
  }
  expect(JSON.stringify(store.snapshot())).not.toContain('PRIVATE');
});

it('marks unfinished runtime work interrupted/unknown and rejects late success without inventing remote exit', () => {
  const store = new AgentActivityStore(); store.accept('task', run); store.accept('task', tool); store.accept('task', request);
  store.runtimeStopped();
  expect(store.snapshot().task).toMatchObject({ runtimeLost: true, tools: [{ status: 'interrupted' }], requests: [{ status: 'unknown', cost: { usd: null, source: 'unknown' } }] });
  expect(store.accept('task', { ...tool, status: 'complete', observedAt: 10 })).toBe(false);
  expect(store.accept('task', { ...request, status: 'complete', observedAt: 10 })).toBe(false);
  store.accept('task', { ...run, runId: 'new', startedAt: 20, observedAt: 20 });
  expect(store.accept('task', { ...run, status: 'settled', observedAt: 30 })).toBe(false);
  expect(store.snapshot().task!.run!.runId).toBe('new');
});

it('caps retained tools and requests, retaining omission counts rather than claiming complete cost totals', () => {
  const store = new AgentActivityStore(); store.accept('task', run);
  for (let i = 0; i < 260; i++) {
    const value = { ...tool, callId: `call-${i}` }; store.accept('task', value); store.accept('task', { ...value, status: 'complete' });
  }
  for (let i = 0; i < 70; i++) {
    const value = { ...request, logicalRequestId: `request-${i}` }; store.accept('task', value); store.accept('task', { ...value, status: 'complete' });
  }
  expect(store.snapshot().task!.tools).toHaveLength(256); expect(store.snapshot().task!.requests).toHaveLength(64);
  expect(store.snapshot().task).toMatchObject({ omittedTools: 4, omittedRequests: 6 });
  store.remove('task'); expect(store.snapshot()).toEqual({});
});
