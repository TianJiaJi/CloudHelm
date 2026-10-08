import { execFileSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';

/**
 * 把 git 的 hooksPath 指向仓库内 .githooks（pre-commit 自动同步版本）。
 * 随 pnpm install 的 prepare 生命周期执行；无 git 或非仓库环境时静默跳过。
 */

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  console.log('git hooksPath 已指向 .githooks（pre-commit 自动同步版本）');
} catch {
  process.exitCode = 0;
}
