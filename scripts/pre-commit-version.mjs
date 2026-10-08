import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';

import {
  README_FILE, VERSION_FILE, PACKAGE_FILES, buildSyncedFiles, findInconsistencies, parseVersionFile
} from './set-version.mjs';

/**
 * pre-commit 钩子：让「只改 version.json」成为一次完整提交。
 * - version.json 已暂存：以它为准重写各 package.json 与 README，并把这些文件加入暂存区；
 * - version.json 未暂存但磁盘或暂存区不一致：拦截提交，提示手动同步，避免不一致进入仓库。
 * 版本一致性以 version.json 为唯一权威来源（见 AGENTS.md）。
 */

export const SYNC_FILES = [...PACKAGE_FILES, README_FILE];

/** 纯决策：改了版本就自动同步；没改版本时任何不一致都拦截。 */
export function resolveHookDecision({ versionStaged, diskProblems, indexProblems }) {
  if (versionStaged) return { action: 'sync' };
  const problems = [...new Set([...(diskProblems ?? []), ...(indexProblems ?? [])])];
  return problems.length ? { action: 'block', problems } : { action: 'pass' };
}

function gitLines(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\n').map((line) => line.trim()).filter(Boolean);
}

function gitText(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** 默认实现走真实 git；测试可注入同形状的假实现，避免依赖仓库状态。 */
export function createGitIo(root, io = {}) {
  return {
    stagedFiles: io.stagedFiles ?? (() => gitLines(root, ['diff', '--cached', '--name-only'])),
    dirtyFiles: io.dirtyFiles ?? ((files) => gitLines(root, ['diff', '--name-only', '--', ...files])),
    indexText: io.indexText ?? ((file) => gitText(root, ['show', `:${file}`])),
    add: io.add ?? ((files) => { gitText(root, ['add', '--', ...files]); })
  };
}

/** 读取工作区中参与版本同步的全部文本。 */
export async function readSyncTexts(root) {
  const packageTexts = new Map();
  for (const file of PACKAGE_FILES) packageTexts.set(file, await readFile(path.join(root, file), 'utf8'));
  const readmeText = await readFile(path.join(root, README_FILE), 'utf8');
  return { packageTexts, readmeText };
}

function indexProblemsOf(version, indexTexts) {
  return findInconsistencies(
    version,
    new Map(PACKAGE_FILES.map((file) => [file, indexTexts.get(file)])),
    indexTexts.get(README_FILE)
  );
}

/**
 * 执行钩子逻辑，返回 { action, problems, rewritten, staged }。
 * action 为 pass / sync（已自动同步）/ block（拦截，problems 非空）。
 */
export async function runHook(root, io = {}) {
  const git = createGitIo(root, io);
  const { packageTexts, readmeText } = await readSyncTexts(root);
  const version = parseVersionFile(await readFile(path.join(root, VERSION_FILE), 'utf8'));
  const diskProblems = findInconsistencies(version, packageTexts, readmeText);

  const indexTexts = new Map();
  for (const file of SYNC_FILES) indexTexts.set(file, await git.indexText(file));
  const indexProblems = indexProblemsOf(version, indexTexts);

  const decision = resolveHookDecision({
    versionStaged: (await git.stagedFiles()).includes(VERSION_FILE),
    diskProblems,
    indexProblems
  });
  if (decision.action === 'block') return { ...decision, rewritten: [], staged: [] };

  const synced = buildSyncedFiles(version, packageTexts, readmeText);
  const rewritten = [];
  for (const [file, text] of synced) {
    const current = file === README_FILE ? readmeText : packageTexts.get(file);
    if (current === text) continue;
    await writeFile(path.join(root, file), text);
    rewritten.push(file);
  }
  // 工作区与暂存区不一致的同步文件一律并入本次提交，保证提交快照自身一致。
  const staged = await git.dirtyFiles(SYNC_FILES);
  if (staged.length) await git.add(staged);
  return { ...decision, version, problems: [...new Set([...diskProblems, ...indexProblems])], rewritten, staged };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await runHook(root);
  if (result.action === 'block') {
    for (const problem of result.problems) console.error(problem);
    console.error('版本不一致且 version.json 不在暂存区：把 version.json 加入本次提交即可自动同步，或运行 pnpm version:set 后提交同步结果。');
    process.exitCode = 1;
    return;
  }
  if (result.action !== 'sync') return;
  if (result.rewritten.length) console.log(`pre-commit 已同步版本文件：${result.rewritten.join('、')}`);
  if (result.staged.length) console.log(`pre-commit 已加入暂存：${result.staged.join('、')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
