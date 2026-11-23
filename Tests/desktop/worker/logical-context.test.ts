import { describe, expect, it, vi } from 'vitest';
import { mergeLogicalContext, type LogicalHostContext } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { cdProbeCommand, createSetDefaultCwdTool, isValidRemotePath, LogicalContextTracker } from '../../../apps/desktop/src/worker/logical-context.js';

const host: RuntimeHost = { id: 'host', label: 'fixture', address: '127.0.0.1', port: 22, username: 'fixture', auth: 'password',
  status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
const record = (fields: Partial<LogicalHostContext> = {}): LogicalHostContext => ({ version: 1, hostId: 'host', loginAs: 'fixture',
  defaultCwd: '/srv/app', revision: 1, source: 'explicit', updatedAt: 100, ...fields });

describe('logical context persistence contract', () => {
  it('stores the first record per host as a clone and preserves other hosts', () => {
    const next = record();
    const merged = mergeLogicalContext([record({ hostId: 'other', defaultCwd: '/home/other' })], next);
    expect(merged).toHaveLength(2);
    expect(merged.find((context) => context.hostId === 'host')).not.toBe(next);
    expect(merged.find((context) => context.hostId === 'other')?.defaultCwd).toBe('/home/other');
  });
  it('keeps the existing record on redelivery or stale revisions without rewriting', () => {
    const existing = [record({ revision: 5, updatedAt: 200 })];
    expect(mergeLogicalContext(existing, record({ revision: 5, updatedAt: 200 }))).toBe(existing);
    expect(mergeLogicalContext(existing, record({ revision: 5, updatedAt: 100 }))).toBe(existing);
    expect(mergeLogicalContext(existing, record({ revision: 4, updatedAt: 999 }))).toBe(existing);
  });
  it('replaces on a newer revision or a status refresh on the same revision', () => {
    expect(mergeLogicalContext([record({ revision: 1 })], record({ revision: 2, defaultCwd: null, restoreStatus: 'unverified' })))
      .toEqual([record({ revision: 2, defaultCwd: null, restoreStatus: 'unverified' })]);
    expect(mergeLogicalContext([record({ revision: 2 })], record({ revision: 2, restoreStatus: 'restored', updatedAt: 300 })))
      .toEqual([record({ revision: 2, restoreStatus: 'restored', updatedAt: 300 })]);
  });
});

describe('remote path validation and probing', () => {
  it('accepts only bounded absolute paths without control characters', () => {
    expect(isValidRemotePath('/srv/app')).toBe(true);
    expect(isValidRemotePath('/'.padEnd(4096, 'a'))).toBe(true);
    expect(isValidRemotePath('srv/relative')).toBe(false);
    expect(isValidRemotePath('')).toBe(false);
    expect(isValidRemotePath('/srv/ap\np')).toBe(false);
    expect(isValidRemotePath('/srv/ap\u0000p')).toBe(false);
    expect(isValidRemotePath('/'.padEnd(4097, 'a'))).toBe(false);
  });
  it('single-quotes the probe path so metacharacters stay literal', () => {
    expect(cdProbeCommand('/srv/app')).toBe(`cd -- '/srv/app' && pwd -P`);
    expect(cdProbeCommand("/srv/it's")).toBe(`cd -- '/srv/it'\\''s' && pwd -P`);
  });
});

describe('LogicalContextTracker', () => {
  it('seeds the login observation once per session and never treats it as an explicit default', async () => {
    const emitted: LogicalHostContext[] = [];
    const tracker = new LogicalContextTracker(undefined, (value) => emitted.push(structuredClone(value)));
    const invalidate = vi.fn();
    await tracker.syncFromProbe('host', 'fixture', '/home/fixture', { invalidate });
    expect(emitted).toEqual([{ version: 1, hostId: 'host', loginAs: 'fixture', defaultCwd: '/home/fixture',
      revision: 0, source: 'login-observed', updatedAt: expect.any(Number) }]);
    await tracker.syncFromProbe('host', 'fixture', '/home/elsewhere', { invalidate });
    expect(emitted).toHaveLength(1);
    expect(tracker.defaultCwdFor('host')).toBe('/home/fixture');
    expect(tracker.receiptContext('host')).toMatchObject({ defaultCwd: '/home/fixture', revision: 0, rebuilt: false });
    expect(invalidate).not.toHaveBeenCalled();
  });
  it('drops a persisted default recorded for another login instead of reusing it', async () => {
    const emitted: LogicalHostContext[] = [];
    const tracker = new LogicalContextTracker([record({ loginAs: 'other', defaultCwd: '/root', revision: 7 })],
      (value) => emitted.push(structuredClone(value)));
    const invalidate = vi.fn();
    await tracker.syncFromProbe('host', 'fixture', '/home/fixture', { invalidate });
    expect(emitted.at(-1)).toMatchObject({ loginAs: 'fixture', defaultCwd: '/home/fixture', revision: 8, source: 'login-observed' });
    expect(invalidate).toHaveBeenCalledOnce();
  });
  it('refreshes a changed login observation with a revision bump', async () => {
    const emitted: LogicalHostContext[] = [];
    const tracker = new LogicalContextTracker([record({ source: 'login-observed', defaultCwd: '/home/old', revision: 2 })],
      (value) => emitted.push(structuredClone(value)));
    const invalidate = vi.fn();
    await tracker.syncFromProbe('host', 'fixture', '/home/new', { invalidate });
    expect(emitted.at(-1)).toMatchObject({ source: 'login-observed', defaultCwd: '/home/new', revision: 3, restoreStatus: undefined });
    expect(invalidate).toHaveBeenCalledOnce();
  });
  it('re-verifies a persisted explicit default on rebuild and marks it restored without a revision bump', async () => {
    const emitted: LogicalHostContext[] = [];
    const tracker = new LogicalContextTracker([record({ revision: 3, restoreStatus: 'restored' })],
      (value) => emitted.push(structuredClone(value)));
    const invalidate = vi.fn();
    const verify = vi.fn(async (path: string) => path === '/srv/app' ? { canonical: '/srv/app' } : { failed: true as const });
    await tracker.syncFromProbe('host', 'fixture', '/home/fixture', { verify, invalidate });
    expect(verify).toHaveBeenCalledExactlyOnceWith('/srv/app');
    expect(emitted.at(-1)).toMatchObject({ defaultCwd: '/srv/app', revision: 3, restoreStatus: 'restored' });
    expect(invalidate).not.toHaveBeenCalled();
    expect(tracker.receiptContext('host')).toEqual({ defaultCwd: '/srv/app', revision: 3, rebuilt: true, restoreStatus: 'restored' });
  });
  it('follows a relocated explicit default to its verified canonical path', async () => {
    const emitted: LogicalHostContext[] = [];
    const tracker = new LogicalContextTracker([record({ defaultCwd: '/srv/app', revision: 3 })],
      (value) => emitted.push(structuredClone(value)));
    const invalidate = vi.fn();
    await tracker.syncFromProbe('host', 'fixture', '/home/fixture', {
      verify: async () => ({ canonical: '/srv/relocated' }), invalidate });
    expect(emitted.at(-1)).toMatchObject({ defaultCwd: '/srv/relocated', revision: 4, restoreStatus: 'restored' });
    expect(invalidate).toHaveBeenCalledOnce();
  });
  it('nulls the default when rebuild verification fails and reports it unverified', async () => {
    const emitted: LogicalHostContext[] = [];
    const tracker = new LogicalContextTracker([record({ defaultCwd: '/srv/gone', revision: 3, restoreStatus: 'restored' })],
      (value) => emitted.push(structuredClone(value)));
    const invalidate = vi.fn();
    await tracker.syncFromProbe('host', 'fixture', '/home/fixture', { verify: async () => ({ failed: true as const }), invalidate });
    expect(emitted.at(-1)).toMatchObject({ defaultCwd: null, revision: 4, restoreStatus: 'unverified' });
    expect(tracker.defaultCwdFor('host')).toBeNull();
    expect(tracker.receiptContext('host')).toEqual({ defaultCwd: null, revision: 4, rebuilt: true, restoreStatus: 'unverified' });
    expect(invalidate).toHaveBeenCalledOnce();
  });
  it('nulls the default when no verification transport exists for the rebuild', async () => {
    const emitted: LogicalHostContext[] = [];
    const tracker = new LogicalContextTracker([record({ revision: 3 })], (value) => emitted.push(structuredClone(value)));
    const invalidate = vi.fn();
    await tracker.syncFromProbe('host', 'fixture', '/home/fixture', { invalidate });
    expect(emitted.at(-1)).toMatchObject({ defaultCwd: null, revision: 4, restoreStatus: 'unverified' });
    expect(invalidate).toHaveBeenCalledOnce();
  });
  it('leaves an already unconfirmed default untouched on the next session', async () => {
    const emitted: LogicalHostContext[] = [];
    const tracker = new LogicalContextTracker([record({ defaultCwd: null, revision: 4, restoreStatus: 'unverified' })],
      (value) => emitted.push(structuredClone(value)));
    const invalidate = vi.fn();
    await tracker.syncFromProbe('host', 'fixture', '/home/fixture', {
      verify: () => { throw new Error('must not re-verify an unconfirmed default'); }, invalidate });
    expect(emitted).toHaveLength(0);
    expect(tracker.defaultCwdFor('host')).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
  });
  it('applies a verified explicit default and skips rebuild re-verification for it', async () => {
    const emitted: LogicalHostContext[] = [];
    const tracker = new LogicalContextTracker([record({ defaultCwd: null, revision: 4, restoreStatus: 'unverified' })],
      (value) => emitted.push(structuredClone(value)));
    const invalidate = vi.fn();
    const applied = tracker.setExplicit('host', 'fixture', '/srv/back', invalidate);
    expect(applied).toMatchObject({ source: 'explicit', defaultCwd: '/srv/back', revision: 5 });
    expect(applied.restoreStatus).toBeUndefined();
    expect(invalidate).toHaveBeenCalledOnce();
    await tracker.syncFromProbe('host', 'fixture', '/home/fixture', {
      verify: () => { throw new Error('a fresh explicit default needs no rebuild re-verification'); }, invalidate });
    expect(tracker.defaultCwdFor('host')).toBe('/srv/back');
    expect(tracker.receiptContext('host')).toMatchObject({ defaultCwd: '/srv/back', revision: 5, rebuilt: false });
  });
});

describe('set_default_cwd tool', () => {
  const apply = vi.fn((hostId: string, loginAs: string, canonical: string) => record({ hostId, loginAs, defaultCwd: canonical, revision: 2 }));
  it('is unavailable without a verification transport and refuses to act', async () => {
    const tool = createSetDefaultCwdTool({ hosts: [host], apply, assertActive: () => {} });
    expect(tool.available?.()).toBe(false);
    const result = await tool.execute('id', { hostId: 'host', path: '/srv/app' }, undefined);
    expect(result.isError).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });
  it('validates the host and the path before probing and rechecks activity', async () => {
    const verify = vi.fn(async () => ({ canonical: '/srv/app' }));
    const assertActive = vi.fn();
    const tool = createSetDefaultCwdTool({ hosts: [host], verify, apply, assertActive });
    expect(tool.available?.()).toBe(true);
    expect((await tool.execute('id', { hostId: 'other', path: '/srv/app' }, undefined)).details)
      .toMatchObject({ code: 'out-of-scope-host' });
    expect((await tool.execute('id', { hostId: 'host', path: 'srv/relative' }, undefined)).isError).toBe(true);
    expect(verify).not.toHaveBeenCalled();
    expect(assertActive).toHaveBeenCalledOnce();
  });
  it('changes nothing when the directory cannot be verified', async () => {
    const tool = createSetDefaultCwdTool({ hosts: [host], verify: async () => ({ failed: true as const }), apply, assertActive: () => {} });
    const result = await tool.execute('id', { hostId: 'host', path: '/srv/gone' }, undefined);
    expect(result.isError).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });
  it('applies the verified canonical default and reports its revision', async () => {
    const tool = createSetDefaultCwdTool({ hosts: [host],
      verify: async (_hostId, path) => path === '/srv/app' ? { canonical: '/srv/app' } : { failed: true as const },
      apply, assertActive: () => {} });
    const result = await tool.execute('id', { hostId: 'host', path: '/srv/app' }, undefined);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Default cwd: /srv/app');
    expect(result.content[0]?.text).toContain('Revision: 2');
    expect(result.structuredContent).toMatchObject({ hostId: 'host', defaultCwd: '/srv/app', revision: 2, source: 'explicit' });
    expect(apply).toHaveBeenCalledExactlyOnceWith('host', 'fixture', '/srv/app');
  });
});
