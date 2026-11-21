import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { README_FILE, VERSION_FILE, PACKAGE_FILES, buildSyncedFiles } from '../../scripts/set-version.mjs';
import { CHANGELOG_FILE, DEFAULT_CHANGELOG_ENTRY } from '../../scripts/changelog.mjs';
import { SYNC_FILES, resolveHookDecision } from '../../scripts/pre-commit-version.mjs';
import { runFixtureHook as runHook, versionHookRepo } from './version-hook-fixture.mjs';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
const selectedEntry = '# 更新日志\n\n## 0.3.0 - 2026-01-01\n\n### 新增\n\n- 手写条目\n';
async function syncWorking(f) {
  const packages = new Map();
  for (const file of PACKAGE_FILES) packages.set(file, await f.get(file));
  for (const [file, text] of buildSyncedFiles('0.3.0', packages, await f.get(README_FILE))) await f.put(file, text);
}

describe('pre-commit version hook decisions', () => {
  it('synchronises automatically when version.json is part of the commit', () => {
    expect(resolveHookDecision({ versionStaged: true, diskProblems: ['a'], indexProblems: ['b'] })).toEqual({ action: 'sync' });
  });
  it('blocks versions drifting without a selected version change', () => {
    expect(resolveHookDecision({ versionStaged: false, diskProblems: ['a'], indexProblems: ['b'] })).toEqual({ action: 'block', problems: ['a', 'b'] });
    expect(resolveHookDecision({ versionStaged: false, diskProblems: [], indexProblems: ['b'] })).toEqual({ action: 'block', problems: ['b'] });
  });
  it('passes when everything is consistent', () => {
    expect(resolveHookDecision({ versionStaged: false, diskProblems: [], indexProblems: [] })).toEqual({ action: 'pass' });
  });
});

describe('pre-commit version hook behaviour with a real index', () => {
  it('stages generated versions when the working versions are already synchronized', async () => {
    const f = await versionHookRepo(roots); await f.bump(); await syncWorking(f);
    await f.put(CHANGELOG_FILE, selectedEntry); f.git('add', '--', CHANGELOG_FILE);
    const result = await runHook(f.root);
    expect(result.action).toBe('sync'); expect(result.rewritten).toEqual([]);
    expect(result.staged).toEqual(SYNC_FILES); expect(result.preserved).toEqual([]);
    expect(JSON.parse(f.index('package.json')).version).toBe('0.3.0');
  });
  it('rewrites clean stale files after editing only version.json', async () => {
    const f = await versionHookRepo(roots); await f.bump();
    const result = await runHook(f.root);
    expect(result.action).toBe('sync'); expect(result.rewritten).toEqual([...SYNC_FILES, CHANGELOG_FILE]);
    expect(result.staged).toEqual([...SYNC_FILES, CHANGELOG_FILE]);
    expect(JSON.parse(await f.get('apps/desktop/package.json')).version).toBe('0.3.0');
    expect(JSON.parse(await f.get('Tests/package.json')).version).toBe('0.3.0');
    expect(await f.get(README_FILE)).toContain('当前版本为 **0.3.0');
  });
  it('blocks an unselected version.json change and leaves files untouched', async () => {
    const f = await versionHookRepo(roots), index = f.git('write-tree');
    await f.put(VERSION_FILE, '{"version":"0.3.0"}\n');
    expect((await runHook(f.root)).action).toBe('block');
    expect(f.git('write-tree')).toBe(index); expect(JSON.parse(await f.get('package.json')).version).toBe('0.2.0');
  });
  it('blocks a stale selected snapshot even when working versions are consistent', async () => {
    const f = await versionHookRepo(roots); await f.bump();
    f.git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', '合成不一致基线');
    await syncWorking(f); const index = f.git('write-tree');
    const result = await runHook(f.root);
    expect(result.action).toBe('block'); expect(result.problems.join('\n')).toContain('0.2.0');
    expect(f.git('write-tree')).toBe(index);
  });
  it('blocks working package drift without changing its content or the index', async () => {
    const f = await versionHookRepo(roots), index = f.git('write-tree');
    const changed = (await f.get('package.json')).replace('0.2.0', '0.1.0'); await f.put('package.json', changed);
    const result = await runHook(f.root);
    expect(result.action).toBe('block'); expect(result.problems.join('\n')).toContain('package.json');
    expect(f.git('write-tree')).toBe(index); expect(await f.get('package.json')).toBe(changed);
  });
  it('passes a consistent commit without staging or rewriting anything', async () => {
    const f = await versionHookRepo(roots), index = f.git('write-tree');
    const result = await runHook(f.root);
    expect(result.action).toBe('pass'); expect(result.rewritten).toEqual([]); expect(result.staged).toEqual([]);
    expect(f.git('write-tree')).toBe(index);
  });
  it('adds a default entry only for the selected version', async () => {
    const f = await versionHookRepo(roots); await f.bump();
    const result = await runHook(f.root);
    expect(result.changelogDefault).toBe(true);
    expect(f.index(CHANGELOG_FILE)).toContain(`- ${DEFAULT_CHANGELOG_ENTRY}`);
    expect(f.index(CHANGELOG_FILE)).toContain('## 0.3.0 - ');
    expect(result.staged).toContain(CHANGELOG_FILE);
  });
  it('keeps an explicitly selected handwritten changelog entry', async () => {
    const f = await versionHookRepo(roots); await f.bump();
    await f.put(CHANGELOG_FILE, selectedEntry); f.git('add', '--', CHANGELOG_FILE);
    const result = await runHook(f.root);
    expect(result.changelogDefault).toBe(false); expect(result.staged).not.toContain(CHANGELOG_FILE);
    expect(f.index(CHANGELOG_FILE)).toBe(selectedEntry); expect(await f.get(CHANGELOG_FILE)).toBe(selectedEntry);
  });
  it('does not fill missing changelog entries when version.json is not selected', async () => {
    const f = await versionHookRepo(roots), text = '# 更新日志\n\n说明\n';
    await f.put(CHANGELOG_FILE, text); f.git('add', '--', CHANGELOG_FILE);
    const index = f.git('write-tree'), result = await runHook(f.root);
    expect(result.action).toBe('pass'); expect(result.changelogDefault).toBe(false);
    expect(f.git('write-tree')).toBe(index); expect(await f.get(CHANGELOG_FILE)).toBe(text);
  });
});
