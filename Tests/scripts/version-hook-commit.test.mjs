import { rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { installVersionHook, versionHookRepo } from './version-hook-fixture.mjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const commit = (f, ...args) => f.git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', ...args);

it('runs the installed hook on a normal commit without importing a working package draft', async () => {
  const f = await versionHookRepo(roots); await installVersionHook(f);
  const draft = JSON.stringify({ ...JSON.parse(await f.get('package.json')), localNote: 'SYNTHETIC_PRIVATE_DRAFT' }, null, 2) + '\n';
  await f.put('package.json', draft);
  await f.put('README.md', await f.get('README.md') + '\nSelected public note\n'); f.git('add', '--', 'README.md');
  commit(f, '-m', '合成普通提交');
  expect(f.git('show', 'HEAD:package.json')).not.toContain('SYNTHETIC_PRIVATE_DRAFT');
  expect(await f.get('package.json')).toBe(draft);
  expect(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim()).toBe('README.md');
}, 30_000);

it('blocks malformed selected content without echoing its payload through the actual hook', async () => {
  const f = await versionHookRepo(roots); await installVersionHook(f); await f.bump();
  const marker = 'SYNTHETIC_PRIVATE_INVALID_JSON';
  await f.put('package.json', marker); f.git('add', '--', 'package.json');
  const head = f.git('rev-parse', 'HEAD'), index = f.git('write-tree');
  let failure;
  try { commit(f, '-m', '合成错误提交'); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  expect(String(failure.stderr)).toContain('版本同步未完成');
  expect(String(failure.stderr) + String(failure.stdout) + String(failure.message)).not.toContain(marker);
  expect(f.git('rev-parse', 'HEAD')).toBe(head); expect(f.git('write-tree')).toBe(index);
}, 30_000);

it('honors the alternate index of git commit --only while preserving unrelated staged and unstaged data', async () => {
  const f = await versionHookRepo(roots); await installVersionHook(f);
  const selected = { ...JSON.parse(await f.get('package.json')), selectedForLater: 'SYNTHETIC_FUTURE_SELECTION' };
  await f.put('package.json', JSON.stringify(selected, null, 2) + '\n'); f.git('add', '--', 'package.json');
  const draft = JSON.stringify({ ...selected, localNote: 'SYNTHETIC_PRIVATE_DRAFT' }, null, 2) + '\n';
  await f.put('package.json', draft); await f.bump();
  commit(f, '--only', '-m', '合成仅版本提交', '--', 'version.json');
  const committed = JSON.parse(f.git('show', 'HEAD:package.json'));
  expect(committed.version).toBe('0.3.0');
  expect(committed.selectedForLater).toBeUndefined(); expect(committed.localNote).toBeUndefined();
  expect(JSON.parse(f.index('package.json'))).toEqual(selected);
  expect(await f.get('package.json')).toBe(draft);
}, 30_000);
