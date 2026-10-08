import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { README_FILE, VERSION_FILE, PACKAGE_FILES } from './set-version.mjs';
import { CHANGELOG_FILE, DEFAULT_CHANGELOG_ENTRY } from './changelog.mjs';
import { SYNC_FILES, resolveHookDecision, runHook } from './pre-commit-version.mjs';

const packageText = (version) => `${JSON.stringify({ name: 'pkg', private: true, version }, null, 2)}\n`;
const readmeText = (version) => `# CloudHelm\n\n当前版本为 **${version}，开发中**，采用 AGPL。\n`;

const fixtures = [];

async function makeRepo({ diskVersion, indexVersion = diskVersion, changelog = '# 更新日志\n\n说明\n' }) {
  const root = await mkdtemp(path.join(tmpdir(), 'cloudhelm-hook-'));
  fixtures.push(root);
  for (const file of [...PACKAGE_FILES, README_FILE]) await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  for (const file of PACKAGE_FILES) await writeFile(path.join(root, file), packageText(diskVersion));
  await writeFile(path.join(root, README_FILE), readmeText(diskVersion));
  await writeFile(path.join(root, VERSION_FILE), `${JSON.stringify({ version: diskVersion }, null, 2)}\n`);
  await writeFile(path.join(root, CHANGELOG_FILE), changelog);
  const indexText = (file) => file === README_FILE ? readmeText(indexVersion) : packageText(indexVersion);
  return { root, indexText };
}

function fakeIo({ staged = [], dirty = [], indexText }) {
  const addCalls = [];
  const dirtyCalls = [];
  return {
    addCalls,
    dirtyCalls,
    io: {
      stagedFiles: async () => staged,
      dirtyFiles: async (files) => { dirtyCalls.push(files); return dirty; },
      indexText: async (file) => indexText(file),
      add: async (files) => { addCalls.push(files); }
    }
  };
}

afterEach(async () => {
  fixtures.length = 0;
});

describe('pre-commit version hook decisions', () => {
  it('synchronises automatically when version.json is part of the commit', () => {
    expect(resolveHookDecision({ versionStaged: true, diskProblems: ['a'], indexProblems: ['b'] }))
      .toEqual({ action: 'sync' });
  });

  it('blocks the commit when versions drift without a version.json change', () => {
    expect(resolveHookDecision({ versionStaged: false, diskProblems: ['a'], indexProblems: ['b'] }))
      .toEqual({ action: 'block', problems: ['a', 'b'] });
    expect(resolveHookDecision({ versionStaged: false, diskProblems: [], indexProblems: ['b'] }))
      .toEqual({ action: 'block', problems: ['b'] });
  });

  it('passes when everything is consistent', () => {
    expect(resolveHookDecision({ versionStaged: false, diskProblems: [], indexProblems: [] }))
      .toEqual({ action: 'pass' });
  });
});

describe('pre-commit version hook behaviour', () => {
  it('rewrites drifted files and stages them when version.json is staged', async () => {
    const { root, indexText } = await makeRepo({ diskVersion: '0.2.0', indexVersion: '0.1.0' });
    const { io, addCalls } = fakeIo({ staged: [VERSION_FILE], dirty: [...SYNC_FILES], indexText });
    const result = await runHook(root, io);
    expect(result.action).toBe('sync');
    expect(result.rewritten).toEqual([]);
    expect(addCalls).toEqual([[...SYNC_FILES]]);
    expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version).toBe('0.2.0');
  });

  it('rewrites stale files after editing only version.json and stages the result', async () => {
    const { root, indexText } = await makeRepo({ diskVersion: '0.1.0', indexVersion: '0.1.0' });
    await writeFile(path.join(root, VERSION_FILE), `${JSON.stringify({ version: '0.2.0' }, null, 2)}\n`);
    const { io, addCalls } = fakeIo({ staged: [VERSION_FILE], dirty: [...SYNC_FILES], indexText });
    const result = await runHook(root, io);
    expect(result.action).toBe('sync');
    expect(result.rewritten).toEqual([...PACKAGE_FILES, README_FILE]);
    expect(addCalls).toEqual([[...SYNC_FILES]]);
    expect(JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8')).version).toBe('0.2.0');
    expect(await readFile(path.join(root, README_FILE), 'utf8')).toContain('当前版本为 **0.2.0');
  });

  it('blocks drift when version.json is not part of the commit and leaves files untouched', async () => {
    const { root, indexText } = await makeRepo({ diskVersion: '0.1.0' });
    await writeFile(path.join(root, VERSION_FILE), `${JSON.stringify({ version: '0.2.0' }, null, 2)}\n`);
    const { io, addCalls } = fakeIo({ staged: ['README.md'], dirty: [], indexText });
    const result = await runHook(root, io);
    expect(result.action).toBe('block');
    expect(result.problems.join('\n')).toContain('package.json');
    expect(addCalls).toEqual([]);
    expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version).toBe('0.1.0');
  });

  it('blocks a commit whose staged snapshot is stale even when the working tree is consistent', async () => {
    const { root, indexText } = await makeRepo({ diskVersion: '0.2.0', indexVersion: '0.1.0' });
    const { io, addCalls } = fakeIo({ staged: ['docs/STATUS.md'], dirty: [], indexText });
    const result = await runHook(root, io);
    expect(result.action).toBe('block');
    expect(result.problems.join('\n')).toContain('0.1.0');
    expect(addCalls).toEqual([]);
  });

  it('passes a consistent commit without staging anything', async () => {
    const { root, indexText } = await makeRepo({ diskVersion: '0.2.0' });
    const { io, addCalls } = fakeIo({ staged: ['docs/STATUS.md'], dirty: [], indexText });
    const result = await runHook(root, io);
    expect(result.action).toBe('pass');
    expect(result.rewritten).toEqual([]);
    expect(addCalls).toEqual([]);
  });

  it('升版提交缺更新日志条目时补写默认条目并把 CHANGELOG.md 并入本次提交', async () => {
    const { root, indexText } = await makeRepo({ diskVersion: '0.1.0', indexVersion: '0.1.0' });
    await writeFile(path.join(root, VERSION_FILE), `${JSON.stringify({ version: '0.2.0' }, null, 2)}\n`);
    const { io, addCalls, dirtyCalls } = fakeIo({ staged: [VERSION_FILE], dirty: [...SYNC_FILES, CHANGELOG_FILE], indexText });
    const result = await runHook(root, io);
    expect(result.action).toBe('sync');
    expect(result.changelogDefault).toBe(true);
    const text = await readFile(path.join(root, CHANGELOG_FILE), 'utf8');
    expect(text).toContain('## 0.2.0 - ');
    expect(text).toContain(`- ${DEFAULT_CHANGELOG_ENTRY}`);
    expect(dirtyCalls[0]).toEqual([...SYNC_FILES, CHANGELOG_FILE]);
    expect(addCalls).toEqual([[...SYNC_FILES, CHANGELOG_FILE]]);
  });

  it('已有更新日志条目时不覆盖手写内容，也不补默认条目', async () => {
    const entry = '# 更新日志\n\n## 0.2.0 - 2026-01-01\n\n### 新增\n\n- 手写条目\n';
    const { root, indexText } = await makeRepo({ diskVersion: '0.1.0', indexVersion: '0.1.0', changelog: entry });
    await writeFile(path.join(root, VERSION_FILE), `${JSON.stringify({ version: '0.2.0' }, null, 2)}\n`);
    const { io, dirtyCalls } = fakeIo({ staged: [VERSION_FILE], dirty: [...SYNC_FILES, CHANGELOG_FILE], indexText });
    const result = await runHook(root, io);
    expect(result.action).toBe('sync');
    expect(result.changelogDefault).toBe(false);
    expect(await readFile(path.join(root, CHANGELOG_FILE), 'utf8')).toBe(entry);
    expect(dirtyCalls[0]).toEqual([...SYNC_FILES, CHANGELOG_FILE]);
  });

  it('version.json 未参与提交时不补写更新日志', async () => {
    const changelog = '# 更新日志\n\n说明\n';
    const { root, indexText } = await makeRepo({ diskVersion: '0.2.0', changelog });
    const { io, dirtyCalls } = fakeIo({ staged: ['docs/STATUS.md'], dirty: [], indexText });
    const result = await runHook(root, io);
    expect(result.action).toBe('pass');
    expect(result.changelogDefault).toBe(false);
    expect(await readFile(path.join(root, CHANGELOG_FILE), 'utf8')).toBe(changelog);
    expect(dirtyCalls[0]).toEqual(SYNC_FILES);
  });
});
