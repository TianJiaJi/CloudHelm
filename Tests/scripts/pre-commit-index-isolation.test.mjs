import { rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasVersionEntry } from '../../scripts/changelog.mjs';
import { PACKAGE_FILES } from '../../scripts/set-version.mjs';
import { fixtureGitIo as createGitIo, runFixtureHook as runHook, versionHookRepo } from './version-hook-fixture.mjs';

// 真实 git 仓库夹具在整机满载时显著变慢；放宽本文件的超时上限以避免负载性失败。
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
const privateNote = 'SYNTHETIC_UNSELECTED_NOTE_NOT_A_CREDENTIAL';

describe('H02: commit hook index/worktree isolation', () => {
  it.each(['package.json', 'version.json'])('rejects concurrent staged changes to %s without partially applying the batch', async (file) => {
    const f = await versionHookRepo(roots); await f.bump();
    const native = createGitIo(f.root); let concurrentTree;
    await expect(runHook(f.root, { applyPatch: async (before, after) => {
      const changed = file === 'version.json' ? '{"version":"0.4.0"}\n'
        : JSON.stringify({ ...JSON.parse(f.index(file)), selectedLater: 'synthetic-concurrent-selection' }, null, 2) + '\n';
      await f.put(file, changed); f.git('add', '--', file); concurrentTree = f.git('write-tree');
      native.applyPatch(before, after);
    } })).rejects.toThrow('Git版本同步失败');
    expect(f.git('write-tree')).toBe(concurrentTree);
    expect(JSON.parse(await f.get('apps/desktop/package.json')).version).toBe('0.2.0');
  });

  it('does not overwrite an editor save observed after the initial clean-file capture', async () => {
    const f = await versionHookRepo(roots); await f.bump();
    const native = createGitIo(f.root), draft = await f.get('README.md') + privateNote;
    const result = await runHook(f.root, { applyPatch: async (before, after) => {
      await f.put('README.md', draft); native.applyPatch(before, after);
    } });
    expect(result.preserved).toContain('README.md');
    expect(f.index('README.md')).not.toContain(privateNote); expect(f.index('README.md')).toContain('0.3.0');
    expect(await f.get('README.md')).toBe(draft);
  });

  it('does not remove another index lock or rewrite working files on an index failure', async () => {
    const f = await versionHookRepo(roots); await f.bump(); const before = f.git('write-tree');
    await f.put('.git/index.lock', 'synthetic-owned-lock');
    await expect(runHook(f.root)).rejects.toThrow('Git版本同步失败');
    expect(await f.get('.git/index.lock')).toBe('synthetic-owned-lock');
    expect(JSON.parse(await f.get('package.json')).version).toBe('0.2.0');
    await unlink(path.join(f.root, '.git/index.lock')); expect(f.git('write-tree')).toBe(before);
  });

  it('preserves missing-final-newline index content and selected executable mode', async () => {
    const f = await versionHookRepo(roots); await f.bump();
    await f.put('README.md', (await f.get('README.md')).trimEnd()); f.git('add', '--', 'README.md');
    f.git('update-index', '--chmod=+x', 'package.json');
    expect((await runHook(f.root)).action).toBe('sync');
    expect(f.index('README.md').endsWith('\n')).toBe(false);
    expect(f.git('ls-files', '--stage', '--', 'package.json')).toMatch(/^100755 /u);
  });

  it('honors Git CRLF normalization without changing the clean working-file convention', async () => {
    const f = await versionHookRepo(roots); f.git('config', 'core.autocrlf', 'true');
    for (const file of [...PACKAGE_FILES, 'README.md']) await f.put(file, (await f.get(file)).replace(/\n/gu, '\r\n'));
    await f.bump(); expect((await runHook(f.root)).action).toBe('sync');
    expect(await f.get('package.json')).toContain('\r\n'); expect(f.index('package.json')).not.toContain('\r');
    expect(f.git('diff', '--name-only')).toBe('');
  });

  it('leaves unselected package and README edits out of a normal commit', async () => {
    const f = await versionHookRepo(roots), before = f.git('write-tree');
    const packageText = JSON.stringify({ ...JSON.parse(await f.get('package.json')), localNote: privateNote }, null, 2) + '\n';
    const readme = await f.get('README.md') + `\n${privateNote}\n`;
    await f.put('package.json', packageText); await f.put('README.md', readme);
    expect((await runHook(f.root)).action).toBe('pass');
    expect(f.git('write-tree')).toBe(before);
    expect(await f.get('package.json')).toBe(packageText); expect(await f.get('README.md')).toBe(readme);
  });

  it('bumps only the selected snapshot and preserves mixed unstaged files verbatim', async () => {
    const f = await versionHookRepo(roots);
    const selected = { ...JSON.parse(await f.get('package.json')), scripts: { selected: 'synthetic-selected-command' } };
    await f.put('package.json', JSON.stringify(selected, null, 2) + '\n');
    const selectedReadme = await f.get('README.md') + '\nSelected note\n';
    const selectedChangelog = '# 更新日志\n\n## 0.3.0\n\n- Selected release note\n';
    await f.put('README.md', selectedReadme); await f.put('CHANGELOG.md', selectedChangelog);
    f.git('add', '--', 'package.json', 'README.md', 'CHANGELOG.md');
    const privatePackage = JSON.stringify({ ...selected, localNote: privateNote }, null, 2) + '\n';
    const privateReadme = selectedReadme + privateNote, privateChangelog = selectedChangelog + privateNote;
    await f.put('package.json', privatePackage); await f.put('README.md', privateReadme); await f.put('CHANGELOG.md', privateChangelog);
    await f.bump();
    const result = await runHook(f.root);
    expect(result.action).toBe('sync');
    expect(JSON.parse(f.index('package.json'))).toEqual({ ...selected, version: '0.3.0' });
    expect(f.index('README.md')).toBe(selectedReadme.replace('0.2.0', '0.3.0'));
    expect(f.index('CHANGELOG.md')).toBe(selectedChangelog);
    expect(await f.get('package.json')).toBe(privatePackage);
    expect(await f.get('README.md')).toBe(privateReadme); expect(await f.get('CHANGELOG.md')).toBe(privateChangelog);
  });

  it('generates the default changelog from the index, never from an unselected draft', async () => {
    const f = await versionHookRepo(roots), draft = await f.get('CHANGELOG.md') + privateNote;
    await f.put('CHANGELOG.md', draft); await f.bump();
    expect((await runHook(f.root)).action).toBe('sync');
    expect(hasVersionEntry(f.index('CHANGELOG.md'), '0.3.0')).toBe(true);
    expect(f.index('CHANGELOG.md')).not.toContain(privateNote);
    expect(await f.get('CHANGELOG.md')).toBe(draft);
  });

  it('rejects a staged/working version disagreement before any mutation', async () => {
    const f = await versionHookRepo(roots); await f.bump();
    await f.put('version.json', '{"version":"0.4.0"}\n');
    const index = f.git('write-tree'), packageText = await f.get('package.json');
    expect((await runHook(f.root)).action).toBe('block');
    expect(f.git('write-tree')).toBe(index); expect(await f.get('package.json')).toBe(packageText);
  });

  it('still supports changing only version.json in a clean workspace', async () => {
    const f = await versionHookRepo(roots); await f.bump();
    expect((await runHook(f.root)).action).toBe('sync');
    for (const file of PACKAGE_FILES) {
      expect(JSON.parse(f.index(file)).version).toBe('0.3.0');
      expect(JSON.parse(await f.get(file)).version).toBe('0.3.0');
    }
    expect(f.git('diff', '--name-only')).toBe('');
    expect(hasVersionEntry(f.index('CHANGELOG.md'), '0.3.0')).toBe(true);
  });
});
