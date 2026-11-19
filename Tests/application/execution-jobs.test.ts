import { describe, expect, it, vi } from 'vitest';
import type { ExecutionJobBinding, ExecutionJobSnapshot } from '@cloudhelm/core';
import { ExecutionJobs } from '../../packages/application/src/execution-jobs.js';
const binding: ExecutionJobBinding = { jobId: 'job', operationId: 'op', taskId: 'task', hostId: 'host', terminalId: 'terminal',
  terminalGeneration: 1, connectionId: 'worker:connection:1', loginAs: 'login', runAs: 'root' };
function fixture(capacity = 256) {
  let at = 100;
  const persist = vi.fn(), jobs = new ExecutionJobs('task', persist, capacity, () => ++at);
  jobs.reserve(binding); return { jobs, persist };
}
describe('backend execution job lifecycle', () => {
  it('separates starting, supervised process, stop intent, and actual exit', () => {
    const { jobs } = fixture();
    expect(jobs.get('job')).toMatchObject({ status: 'starting', exitObserved: false, processSequence: 0 });
    jobs.started(binding, 42);
    const stop = jobs.beginStop(binding, 'stop-1');
    expect(stop).toMatchObject({ send: true, job: { status: 'stop-requested', exitObserved: false, pid: 42 } });
    expect(jobs.beginStop(binding, 'stop-2').send).toBe(false);
    jobs.observedResult(binding, { operationId: 'op', status: 'failed', exitCode: 130, stdoutTail: '' });
    expect(jobs.get('job')).toMatchObject({ status: 'failed', exitObserved: true, exitCode: 130 });
    jobs.started(binding, 43); jobs.unknown(binding, 'disconnected');
    expect(jobs.get('job')).toMatchObject({ status: 'failed', exitObserved: true, pid: 42 });
  });
  it('never accepts not-started evidence after an observed process', () => {
    const { jobs } = fixture(); jobs.started(binding, 42);
    expect(() => jobs.notStarted(binding, 'denied')).toThrow('possible execution');
    expect(jobs.get('job')?.status).toBe('running');
  });
  it('handles sequential supervised processes without resetting the job start or stop intent', () => {
    const { jobs } = fixture(); const first = jobs.started(binding, 42);
    jobs.beginStop(binding, 'stop-1'); const next = jobs.started(binding, 43);
    expect(next).toMatchObject({ processSequence: 2, pid: 43, startedAt: first.startedAt, status: 'stop-requested' });
    jobs.started(binding, 43); expect(jobs.get('job')?.processSequence).toBe(2);
  });
  it('does not turn disconnect or failed stop delivery into exit and never automatically resends', () => {
    const { jobs } = fixture(); jobs.started(binding, 42); jobs.beginStop(binding, 'stop');
    jobs.unknown(binding, 'stop-delivery-unknown'); jobs.started(binding, 43);
    expect(jobs.get('job')).toMatchObject({ status: 'unknown', pid: 42, exitObserved: false });
    expect(jobs.beginStop(binding, 'retry').send).toBe(false);
    jobs.observedResult(binding, { operationId: 'op', status: 'succeeded', exitCode: 0, stdoutTail: '' });
    expect(jobs.get('job')).toMatchObject({ status: 'exited', exitObserved: true });
  });
  it.each(['taskId', 'hostId', 'connectionId', 'loginAs', 'runAs', 'terminalId', 'operationId', 'terminalGeneration'] as const)(
    'rejects stale or foreign %s', (key) => {
      const { jobs } = fixture();
      const changed = { ...binding, [key]: key === 'terminalGeneration' ? 2 : 'foreign' };
      expect(() => jobs.started(changed, 42)).toThrow('binding changed');
      expect(() => jobs.beginStop(changed, 'stop')).toThrow('binding changed');
      expect(jobs.get('job')?.status).toBe('starting');
    });
  it('requires actual terminal exit evidence rather than a successful-looking output string', () => {
    const { jobs } = fixture(); jobs.started(binding, 42);
    jobs.observedResult(binding, { operationId: 'op', status: 'unknown', stdoutTail: 'process exited successfully' });
    expect(jobs.get('job')).toMatchObject({ status: 'unknown', exitObserved: false });
    expect(() => jobs.beginStop(binding, 'stop')).toThrow('unverified');
    expect(() => jobs.observedResult(binding, { operationId: 'foreign', status: 'succeeded', exitCode: 0, stdoutTail: '' })).toThrow('recipient');
  });
  it('persists before publishing a new job and keeps detached snapshots', () => {
    const { jobs, persist } = fixture();
    const view = jobs.get('job')!; view.runAs = 'changed'; expect(jobs.get('job')!.runAs).toBe('root');
    persist.mockImplementationOnce(() => { throw new Error('disk failed'); });
    expect(() => jobs.started(binding, 42)).toThrow('disk failed');
    expect(jobs.get('job')!.status).toBe('starting');
    persist.mockImplementationOnce((value: ExecutionJobSnapshot) => { value.runAs = 'sink mutation'; });
    expect(jobs.started(binding, 42).runAs).toBe('root');
  });
  it('keeps uncertain jobs at capacity, only evicting durably ended runtime records', () => {
    const { jobs } = fixture(1); const other = { ...binding, jobId: 'job-2', operationId: 'op-2' };
    expect(() => jobs.reserve(other)).toThrow('capacity');
    jobs.unknown(binding, 'transport-lost'); expect(() => jobs.reserve(other)).toThrow('capacity');
    jobs.observedResult(binding, { operationId: 'op', status: 'succeeded', exitCode: 0, stdoutTail: '' });
    jobs.reserve(other); expect(jobs.snapshot()).toHaveLength(1); expect(jobs.get('job-2')?.status).toBe('starting');
  });
  it('does not preserve unrelated input fields in public or restored snapshots', () => {
    const jobs = new ExecutionJobs('task', vi.fn());
    jobs.reserve({ ...binding, credential: 'never-persist' } as ExecutionJobBinding);
    expect(JSON.stringify(jobs.snapshot())).not.toContain('never-persist');
    const recovered = new ExecutionJobs('task', vi.fn());
    recovered.restore([{ ...jobs.get('job')!, credential: 'never-persist' } as ExecutionJobSnapshot]);
    expect(JSON.stringify(recovered.snapshot())).not.toContain('never-persist');
  });
  it('restores offline with running and stopping jobs unknown, preserving genuine terminal evidence', () => {
    const { jobs } = fixture();
    jobs.started(binding, 42); jobs.beginStop(binding, 'stop');
    const persist = vi.fn(), restored = new ExecutionJobs('task', persist);
    restored.restore(jobs.snapshot());
    expect(restored.get('job')).toMatchObject({ status: 'unknown', unknownReason: 'recovered', exitObserved: false, pid: 42 });
    expect(persist).not.toHaveBeenCalled(); expect(() => restored.restore([])).toThrow('restore');
    const { jobs: failed } = fixture(); failed.notStarted(binding, 'denied');
    const ended = new ExecutionJobs('task', vi.fn()); ended.restore(failed.snapshot());
    expect(ended.get('job')).toMatchObject({ status: 'failed', notStarted: 'denied', exitObserved: false });
  });
  it('records background start observations only when the log path and process identity are valid', () => {
    const { jobs } = fixture();
    const logPath = '/tmp/.cloudhelm-bg-68bc578f-ad82-4194-8d50-ca55d477ed44.log';
    expect(jobs.started(binding, 42, { logPath, processStartTime: 999 }))
      .toMatchObject({ pid: 42, logPath, processStartTime: 999, status: 'running' });
    expect(() => jobs.started(binding, 43, { logPath: '/tmp/agent-chosen.log' })).toThrow('Invalid background log observation');
    expect(() => jobs.started(binding, 44, { processStartTime: -1 })).toThrow('Invalid background process identity observation');
    expect(() => jobs.started(binding, 44, { processStartTime: Number.MAX_SAFE_INTEGER + 1 })).toThrow('Invalid background process identity observation');
    expect(() => jobs.started(binding, 0)).toThrow('Invalid observed process identity');
    expect(jobs.get('job')).toMatchObject({ pid: 42, processSequence: 1 });
  });
  it('keeps restored background observations only while they stay verifiable', () => {
    const { jobs } = fixture();
    const logPath = '/tmp/.cloudhelm-bg-68bc578f-ad82-4194-8d50-ca55d477ed44.log';
    jobs.started(binding, 42, { logPath, processStartTime: 999 });
    const restored = new ExecutionJobs('task', vi.fn());
    restored.restore(jobs.snapshot());
    expect(restored.get('job')).toMatchObject({ status: 'unknown', unknownReason: 'recovered',
      pid: 42, logPath, processStartTime: 999 });
    const tampered = new ExecutionJobs('task', vi.fn());
    tampered.restore([{ ...jobs.get('job')!, logPath: '/tmp/agent-chosen.log', processStartTime: -5 } as ExecutionJobSnapshot]);
    const job = tampered.get('job')!;
    expect(job.logPath).toBeUndefined();
    expect(job.processStartTime).toBeUndefined();
    expect(job).toMatchObject({ status: 'unknown', unknownReason: 'recovered', pid: 42 });
  });
});
