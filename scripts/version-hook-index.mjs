import { execFileSync } from 'node:child_process';
import { PACKAGE_FILES, README_FILE, VERSION_FILE } from './set-version.mjs';
import { CHANGELOG_FILE } from './changelog.mjs';

const allowed = new Set([...PACKAGE_FILES, README_FILE, VERSION_FILE, CHANGELOG_FILE]);
function assertPath(file) { if (!allowed.has(file)) throw new Error('版本同步文件不在允许列表中'); }
function git(root, args, input, env) {
  // Never print native diagnostics or patch bodies: they may contain staged text.
  try { return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe', input, maxBuffer: 8 * 1024 * 1024 }); }
  catch { throw new Error('Git版本同步失败；请检查暂存状态、合并冲突或索引锁'); }
}
function patchSide(text, prefix) {
  if (!text) return { count: 0, text: '' };
  const lines = text.split('\n'), terminated = text.endsWith('\n');
  if (terminated) lines.pop();
  return { count: lines.length, text: lines.map((line) => `${prefix}${line}\n`).join('')
    + (terminated ? '' : '\\ No newline at end of file\n') };
}

/** Full preimage hunks reject conflicting index edits instead of overwriting them. */
export function indexPatch(before, after) {
  let patch = '';
  for (const [file, oldText] of before) {
    assertPath(file);
    const newText = after.get(file) ?? oldText;
    if (!oldText && !newText) continue;
    const old = patchSide(oldText, '-'), next = patchSide(newText, '+');
    patch += `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`
      + `@@ -${old.count ? `1,${old.count}` : '0,0'} +${next.count ? `1,${next.count}` : '0,0'} @@\n`
      + old.text + next.text;
  }
  return patch;
}

export function createGitIo(root, overrides = {}) {
  const run = (args, input) => git(root, args, input, overrides.env);
  return {
    stagedFiles: () => run(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean),
    dirtyFiles: (files) => run(['diff', '--name-only', '-z', '--', ...files]).split('\0').filter(Boolean),
    indexText: (file, optional = false) => {
      assertPath(file);
      const entry = run(['ls-files', '--stage', '-z', '--', file]);
      if (optional && !entry) return undefined;
      const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t([^\0]+)\0$/u.exec(entry);
      if (!match || match[3] !== file) throw new Error(`暂存文件不是普通文件或存在合并冲突：${file}`);
      // Read the captured blob, not a potentially changed :path on a second call.
      return run(['cat-file', 'blob', match[2]]);
    },
    applyPatch: (before, after) => {
      const patch = indexPatch(before, after);
      // No --reject: Git checks and applies the whole batch atomically to its index.
      // No git add: a working-tree draft can never become the staging source.
      if (patch) run(['apply', '--cached', '--whitespace=nowarn', '-'], patch);
    },
    ...overrides
  };
}
