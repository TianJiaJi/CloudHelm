import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { PACKAGE_FILES, README_FILE, VERSION_FILE } from '../../scripts/set-version.mjs';
import { CHANGELOG_FILE } from '../../scripts/changelog.mjs';
import { createGitIo, runHook } from '../../scripts/pre-commit-version.mjs';

function fixtureEnvironment(root) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/iu.test(key)) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, '.synthetic-empty-gitconfig') };
}
export const fixtureGitIo = (root) => createGitIo(root, { env: fixtureEnvironment(root) });
export const runFixtureHook = (root, overrides = {}) => runHook(root, { env: fixtureEnvironment(root), ...overrides });

export async function versionHookRepo(cleanups) {
  const root = await mkdtemp(path.join(tmpdir(), 'cloudhelm-version-index-'));
  cleanups.push(root);
  const env = fixtureEnvironment(root);
  await writeFile(env.GIT_CONFIG_GLOBAL, '', { flag: 'wx' });
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  const put = async (file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
  const get = (file) => readFile(path.join(root, file), 'utf8');
  git('init', '--quiet'); git('config', 'core.autocrlf', 'false'); git('config', 'core.hooksPath', '.disabled-hooks');
  git('config', 'commit.gpgsign', 'false');
  for (const file of PACKAGE_FILES) await put(file, JSON.stringify({ name: 'synthetic-package', version: '0.2.0' }, null, 2) + '\n');
  await put(README_FILE, '# Synthetic\n\n当前版本为 **0.2.0，开发中**\n');
  await put(VERSION_FILE, '{"version":"0.2.0"}\n');
  await put(CHANGELOG_FILE, '# 更新日志\n\n## 0.2.0\n\n- Synthetic baseline\n');
  git('add', '--', ...PACKAGE_FILES, README_FILE, VERSION_FILE, CHANGELOG_FILE);
  git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', '合成测试基线');
  return { root, git, put, get, index: (file) => git('show', `:${file}`),
    bump: async () => { await put(VERSION_FILE, '{"version":"0.3.0"}\n'); git('add', '--', VERSION_FILE); } };
}

export async function installVersionHook(f) {
  const source = fileURLToPath(new URL('../../scripts/', import.meta.url));
  const files = ['pre-commit-version.mjs', 'version-hook-index.mjs', 'version-hook-worktree.mjs', 'set-version.mjs', 'changelog.mjs'];
  for (const file of files) await f.put(`scripts/${file}`, await readFile(path.join(source, file), 'utf8'));
  await f.put('.githooks/pre-commit', '#!/bin/sh\nexec node "$(git rev-parse --show-toplevel)/scripts/pre-commit-version.mjs"\n');
  await chmod(path.join(f.root, '.githooks/pre-commit'), 0o755);
  f.git('add', '--', '.githooks/pre-commit', ...files.map((file) => `scripts/${file}`));
  f.git('update-index', '--chmod=+x', '.githooks/pre-commit');
  f.git('config', 'core.hooksPath', '.githooks');
  f.git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', '安装合成版本钩子');
}
